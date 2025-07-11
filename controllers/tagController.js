// controllers/tagController.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const util = require("util");
const { exec } = require("child_process");
const { generateFingerprint } = require("../utils/fingerprint");
const fetchAlbumArt      = require("../utils/fetchAlbumArt");
const { writeTags }      = require("../utils/tagWriter");
const { zipTaggedFiles } = require("../utils/zipFiles");
const tagReader          = require("../utils/tagReader");

const execPromise = util.promisify(exec);
const MB_BASE = "https://musicbrainz.org/ws/2";
const MB_HEADERS = { "User-Agent": "MetaTune/1.0 (you@domain.com)" };

async function handleTagging(files) {
  const results = [];

  for (const file of files) {
    const inputPath = file.path;

    // 1️⃣ Get extension from ORIGINAL upload, fallback to path
    let ext = path.extname(file.originalname);
    if (!ext) ext = path.extname(inputPath) || ".mp3";

    // 2️⃣ Make WAV for fingerprinting
    const base    = path.basename(inputPath, path.extname(inputPath));
    const wavDir  = path.join(__dirname, "..", "wavuploads");
    const wavPath = path.join(wavDir, `${base}.wav`);
    if (!fs.existsSync(wavDir)) fs.mkdirSync(wavDir, { recursive: true });
    await execPromise(`ffmpeg -y -i "${inputPath}" -ar 44100 -ac 2 -f wav "${wavPath}"`);

    // 3️⃣ AcoustID → MB lookup
    let rec = null;
    try {
      const { duration, fingerprint } = await generateFingerprint(wavPath);
      const ac = await axios.get("https://api.acoustid.org/v2/lookup", {
        params: {
          client: process.env.ACOUSTID_API_KEY,
          meta:   "recordings+releasegroups+compress",
          fingerprint,
          duration,
        },
      });
      rec = ac.data.results?.[0]?.recordings?.[0] || null;
    } catch (e) {
      console.warn("⚠️ AcoustID failed:", e.message);
    }

    // 4️⃣ Fallback MB search by filename if needed
    if (!rec) {
      const nameOnly = file.originalname.replace(ext, "");
      let [guessTitle, guessArtist] = nameOnly.split(" - ");
      if (!guessArtist) {
        const parts = nameOnly.split(" ");
        guessTitle = parts[0];
        guessArtist = parts.slice(1).join(" ");
      }
      try {
        const sr = await axios.get(`${MB_BASE}/recording`, {
          params: {
            query: `recording:"${guessTitle}" AND artist:"${guessArtist}"`,
            fmt: "json",
            limit: 1
          },
          headers: MB_HEADERS
        });
        const found = sr.data.recordings?.[0];
        if (found?.id) {
          rec = (await axios.get(`${MB_BASE}/recording/${found.id}`, {
            params: { inc: "artists+release-groups+tags", fmt: "json" },
            headers: MB_HEADERS
          })).data;
        }
      } catch (e) {
        console.warn("⚠️ MB search fallback failed
