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

async function handleTagging(files) {
  const results = [];

  for (const file of files) {
    const inputPath = file.path;
    // 1) Determine extension
    let ext = path.extname(inputPath);
    if (!ext) ext = path.extname(file.originalname) || ".mp3";

    // 2) Convert to WAV for fingerprinting
    const base = path.basename(inputPath, path.extname(inputPath));
    const wavDir = path.join(__dirname, "..", "wavuploads");
    const wavPath = path.join(wavDir, `${base}.wav`);
    if (!fs.existsSync(wavDir)) fs.mkdirSync(wavDir, { recursive: true });
    await execPromise(`ffmpeg -y -i "${inputPath}" -ar 44100 -ac 2 -f wav "${wavPath}"`);

    // 3) Fingerprint + AcoustID lookup (with releasegroups)
    let match = null;
    try {
      const { duration, fingerprint } = await generateFingerprint(wavPath);
      const acoustRes = await axios.get("https://api.acoustid.org/v2/lookup", {
        params: {
          client: process.env.ACOUSTID_API_KEY,
          meta: "recordings+releasegroups+compress",
          fingerprint,
          duration,
        },
      });
      match = acoustRes.data.results?.[0]?.recordings?.[0] || null;
    } catch (err) {
      console.warn("⚠️ AcoustID lookup failed:", err.message);
    }

    // 4) Fetch cover-art via MusicBrainz release-group
    let image = null;
    const rgid = match?.releasegroups?.[0]?.id;
    if (rgid) {
      try {
        image = await fetchAlbumArt(rgid);
      } catch (err) {
        console.warn("⚠️ fetchAlbumArt failed:", err.message);
      }
    }

    // 5) Embedded tag fallback
    const embedded = await tagReader(inputPath);

    // 6) Merge metadata
    const title  = match?.title
      || embedded.title
      || "Unknown Title";
    const artist = match?.artists?.[0]?.name
      || embedded.artist
      || "Unknown Artist";
    const album  = match?.releasegroups?.[0]?.title
      || embedded.album
      || "Unknown Album";
    const year   = match?.releasegroups?.[0]?.first_release_date?.split("-")[0]
      || embedded.year
      || "";
    const genre  = match?.tags?.[0]?.name
      || embedded.genre
      || "";
    const cover  = image
      || embedded.image
      || null;

    const tagsObj = { title, artist, album, year, genre, image: cover };

    // 7) Write tags into file
    await writeTags(tagsObj, inputPath);

    // 8) Rename file to "Artist - Title.ext"
    const safe = str => str.replace(/[^\w\s-]/g, "").trim() || "Unknown";
    const newName = `${safe(artist)} - ${safe(title)}${ext}`;
    const newPath = path.join(path.dirname(inputPath), newName);
    fs.renameSync(inputPath, newPath);

    // 9) Cleanup WAV
    fs.unlinkSync(wavPath);

    results.push(newPath);
  }

  return results;
}

// Single upload
exports.processFile = async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const [out] = await handleTagging([req.file]);
  if (!out) return res.status(500).json({ error: "Tagging failed" });
  res.download(out, path.basename(out), err => {
    if (err) res.status(500).json({ error: "Download failed" });
  });
};

// Batch upload
exports.processBatch = async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "No files uploaded" });
  const outs = await handleTagging(files);
  if (!outs.length) return res.status(500).json({ error: "All files failed tagging" });
  const zipPath = await zipTaggedFiles(outs);
  res.download(zipPath, "metatune-output.zip", err => {
    if (err) return res.status(500).json({ error: "ZIP download failed" });
    fs.unlinkSync(zipPath);
  });
};
