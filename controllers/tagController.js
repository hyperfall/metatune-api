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
    const originalName = file.originalname;
    const inputPath    = file.path;

    console.log(`[handleTagging] ➤ Starting: ${originalName}`);

    try {
      // 1️⃣ Determine extension from original upload
      let ext = path.extname(originalName);
      if (!ext) ext = path.extname(inputPath) || ".mp3";

      // 2️⃣ Prepare WAV for fingerprinting
      const base    = path.basename(inputPath, path.extname(inputPath));
      const wavDir  = path.join(__dirname, "..", "wavuploads");
      const wavPath = path.join(wavDir, `${base}.wav`);
      if (!fs.existsSync(wavDir)) fs.mkdirSync(wavDir, { recursive: true });
      console.log(`[handleTagging] Converting to WAV: ${wavPath}`);
      await execPromise(`ffmpeg -y -i "${inputPath}" -ar 44100 -ac 2 -f wav "${wavPath}"`);

      // 3️⃣ Fingerprint + AcoustID
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
        console.log(`[handleTagging] AcoustID record ID: ${rec?.id || "none"}`);
      } catch (err) {
        console.warn(`[handleTagging] AcoustID lookup failed for ${originalName}:`, err.message);
      }

      // 4️⃣ Fallback: MusicBrainz search by filename
      if (!rec) {
        console.log(`[handleTagging] No AcoustID record, trying MB search fallback`);
        const nameOnly = originalName.replace(ext, "");
        let [guessTitle, guessArtist] = nameOnly.split(" - ");
        if (!guessArtist) {
          const parts = nameOnly.split(" ");
          guessTitle = parts.shift();
          guessArtist = parts.join(" ");
        }
        try {
          const sr = await axios.get(`${MB_BASE}/recording`, {
            params: {
              query: `recording:"${guessTitle}" AND artist:"${guessArtist}"`,
              fmt:   "json",
              limit: 1,
            },
            headers: MB_HEADERS
          });
          const found = sr.data.recordings?.[0];
          if (found?.id) {
            const lu = await axios.get(`${MB_BASE}/recording/${found.id}`, {
              params: { inc: "artists+release-groups+tags", fmt: "json" },
              headers: MB_HEADERS
            });
            rec = lu.data;
            console.log(`[handleTagging] MB fallback record ID: ${rec.id}`);
          }
        } catch (err) {
          console.warn(`[handleTagging] MB search fallback failed for ${originalName}:`, err.message);
        }
      }

      // 5️⃣ Read embedded tags as fallback
      let embedded = {};
      try {
        embedded = await tagReader(inputPath);
        console.log(`[handleTagging] Embedded tags for ${originalName}:`, embedded);
      } catch (err) {
        console.warn(`[handleTagging] tagReader failed for ${originalName}:`, err.message);
      }

      // 6️⃣ Merge metadata
      const title  = rec?.title
        || embedded.title
        || "Unknown Title";
      const artist = rec?.["artist-credit"]?.map(a => a.name).join(", ")
        || embedded.artist
        || "Unknown Artist";
      const releaseGroup = rec?.["release-groups"]?.[0] || {};
      const album  = releaseGroup.title
        || embedded.album
        || "Unknown Album";
      const year   = (releaseGroup["first-release-date"]?.split("-")[0])
        || embedded.year
        || "";
      const genre  = rec?.tags?.[0]?.name
        || embedded.genre
        || "";

      console.log(`[handleTagging] Final metadata for ${originalName}:`, { title, artist, album, year, genre });

      // 7️⃣ Fetch album art
      let image = null;
      if (releaseGroup.id) {
        try {
          image = await fetchAlbumArt(releaseGroup.id);
          console.log(`[handleTagging] fetchAlbumArt returned:`, image ? "imageBuffer(" + image.imageBuffer.length + " bytes)" : "null");
        } catch (err) {
          console.warn(`[handleTagging] fetchAlbumArt error for ${originalName}:`, err.message);
        }
      }
      if (!image && embedded.image) {
        image = embedded.image;
        console.log(`[handleTagging] Using embedded image buffer length:`, image.imageBuffer?.length);
      }

      // 8️⃣ Write tags + art
      await writeTags({ title, artist, album, year, genre, image }, inputPath);
      console.log(`[handleTagging] writeTags succeeded for ${originalName}`);

      // 9️⃣ Rename file
      const clean = s => s.replace(/[^\w\s-]/g, "").trim() || "Unknown";
      const newName = `${clean(artist)} - ${clean(title)}${ext}`;
      const newPath = path.join(path.dirname(inputPath), newName);
      fs.renameSync(inputPath, newPath);
      console.log(`[handleTagging] Renamed to: ${newName}`);

      // 🔟 Cleanup WAV
      fs.unlinkSync(wavPath);

      results.push(newPath);
    } catch (err) {
      console.error(`[handleTagging] ERROR processing ${originalName}:`, err);
    }
  }

  return results;
}

// Single upload
exports.processFile = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const [out] = await handleTagging([req.file]);
    if (!out) return res.status(500).json({ error: "Tagging failed" });
    res.download(out, path.basename(out), err => {
      if (err) {
        console.error(`[processFile] Download error for ${out}:`, err);
        res.status(500).json({ error: "Download failed" });
      }
    });
  } catch (err) {
    console.error("[processFile] Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Batch upload
exports.processBatch = async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "No files uploaded" });
    const outs = await handleTagging(files);
    if (!outs.length) return res.status(500).json({ error: "All files failed tagging" });
    const zipPath = await zipTaggedFiles(outs);
    res.download(zipPath, "metatune-output.zip", err => {
      if (err) {
        console.error("[processBatch] ZIP download error:", err);
        return res.status(500).json({ error: "ZIP download failed" });
      }
      fs.unlinkSync(zipPath);
    });
  } catch (err) {
    console.error("[processBatch] Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};
