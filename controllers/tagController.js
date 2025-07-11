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
const MB_HEADERS = { "User-Agent": "MetaTune/1.0 (your@email)" };

async function handleTagging(files) {
  const results = [];

  for (const file of files) {
    const input = file.path;
    let ext = path.extname(input) || path.extname(file.originalname) || ".mp3";
    const base = path.basename(input, path.extname(input));
    const wavDir = path.join(__dirname, "..", "wavuploads");
    const wav = path.join(wavDir, `${base}.wav`);
    if (!fs.existsSync(wavDir)) fs.mkdirSync(wavDir, { recursive: true });
    await execPromise(`ffmpeg -y -i "${input}" -ar 44100 -ac 2 -f wav "${wav}"`);

    // 1) AcoustID → MusicBrainz lookup
    let rec = null;
    try {
      const { duration, fingerprint } = await generateFingerprint(wav);
      const ac = await axios.get("https://api.acoustid.org/v2/lookup", {
        params: {
          client: process.env.ACOUSTID_API_KEY,
          meta: "recordings+releasegroups",
          fingerprint,
          duration,
        }
      });
      rec = ac.data.results?.[0]?.recordings?.[0] || null;
    } catch (e) {
      console.warn("⚠️ AcoustID lookup failed:", e.message);
    }

    // 2) Fallback: MusicBrainz search by filename
    if (!rec) {
      const titleGuess = file.originalname.replace(path.extname(file.originalname), "");
      try {
        const sr = await axios.get(`${MB_BASE}/recording`, {
          params: { query: `recording:"${titleGuess}"`, fmt: "json", limit: 1 },
          headers: MB_HEADERS
        });
        const found = sr.data.recordings?.[0];
        if (found?.id) {
          const lu = await axios.get(`${MB_BASE}/recording/${found.id}`, {
            params: { inc: "artists+release-groups+tags", fmt: "json" },
            headers: MB_HEADERS
          });
          rec = lu.data;
        }
      } catch (e) {
        console.warn("⚠️ MB search fallback failed:", e.message);
      }
    }

    // 3) Embedded-tag fallback
    const embedded = await tagReader(input);

    // 4) Pick metadata
    const title  = rec?.title  
      || embedded.title  
      || "Unknown Title";
    const artist = rec?.["artist-credit"]?.map(a => a.name).join(", ")  
      || embedded.artist  
      || "Unknown Artist";
    const album  = rec?.["release-groups"]?.[0]?.title  
      || embedded.album  
      || "Unknown Album";
    const year   = rec?.["release-groups"]?.[0]?.first-release-date?.split("-")[0]  
      || embedded.year  
      || "";
    const genre  = rec?.tags?.[0]?.name  
      || embedded.genre  
      || "";
    
    // 5) Album art via improved fetchAlbumArt
    const rgid = rec?.["release-groups"]?.[0]?.id  
      || embedded.image?.mbid  
      || null;
    let image = null;
    if (rgid) {
      image = await fetchAlbumArt(rgid);
    }

    // 6) Write tags + art
    await writeTags({ title, artist, album, year, genre, image }, input);

    // 7) Rename to "Artist - Title.ext"
    const clean = s => s.replace(/[^\w\s-]/g, "").trim() || "Unknown";
    const newName = `${clean(artist)} - ${clean(title)}${ext}`;
    const newPath = path.join(path.dirname(input), newName);
    fs.renameSync(input, newPath);

    // 8) Cleanup WAV
    fs.unlinkSync(wav);

    results.push(newPath);
  }

  return results;
}

exports.processFile = async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const [out] = await handleTagging([req.file]);
  if (!out) return res.status(500).json({ error: "Tagging failed" });
  res.download(out, path.basename(out), err => {
    if (err) res.status(500).json({ error: "Download failed" });
  });
};

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
