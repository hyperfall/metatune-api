const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { exec } = require("child_process");
const util = require("util");
const { generateFingerprint } = require("../utils/fingerprint");
const fetchAlbumArt = require("../utils/fetchAlbumArt");
const { writeTags } = require("../utils/tagWriter");
const { zipTaggedFiles } = require("../utils/zipFiles");

const execPromise = util.promisify(exec);

// 🔁 Shared tagging logic (single & batch)
async function handleTagging(files) {
  const taggedFiles = [];

  for (const file of files) {
    const inputFilePath = file.path;

    // 1️⃣ Determine extension: from multer path or original filename
    let ext = path.extname(inputFilePath);
    if (!ext) {
      ext = path.extname(file.originalname) || ".mp3";
    }

    const filename = path.basename(inputFilePath);
    const wavDir = path.join(__dirname, "..", "wavuploads");
    const wavFilePath = path.join(wavDir, `${filename}.wav`);

    try {
      if (!fs.existsSync(wavDir)) fs.mkdirSync(wavDir, { recursive: true });

      // ➡️ Convert to WAV for fingerprinting
      await new Promise((resolve, reject) => {
        exec(
          `ffmpeg -y -i "${inputFilePath}" -ar 44100 -ac 2 -f wav "${wavFilePath}"`,
          (err, stdout, stderr) => err ? reject(new Error(stderr)) : resolve()
        );
      });

      // ➡️ Fingerprint & lookup
      const { duration, fingerprint } = await generateFingerprint(wavFilePath);
      const response = await axios.get("https://api.acoustid.org/v2/lookup", {
        params: {
          client: process.env.ACOUSTID_API_KEY,
          meta: "recordings+releasegroups+compress",
          fingerprint,
          duration,
        },
      });

      const match = response.data.results[0]?.recordings?.[0] || {};
      const title  = match.title || "Unknown Title";
      const artist = match.artists?.[0]?.name || "Unknown Artist";
      const album  = match.releasegroups?.[0]?.title || "Unknown Album";
      const year   = match.releasegroups?.[0]?.first_release_date?.split("-")[0] || "";
      const genre  = match.tags?.[0]?.name || "Unknown Genre";

      // ➡️ Fetch album art if available
      let image = null;
      const mbid = match.releasegroups?.[0]?.id;
      if (mbid) {
        try {
          image = await fetchAlbumArt(mbid);
        } catch {
          console.warn(`⚠️ No album art for MBID ${mbid}`);
        }
      }

      // ➡️ Write tags into original file
      await writeTags({ title, artist, album, year, genre, image }, inputFilePath);

      // ➡️ Rename to "Artist - Title.ext"
      const safeArtist = artist.replace(/[^\w\s-]/g, "").trim() || "Unknown Artist";
      const safeTitle  = title.replace(/[^\w\s-]/g, "").trim()   || "Unknown Title";
      const newFilename = `${safeArtist} - ${safeTitle}${ext}`;
      const newFilePath = path.join(path.dirname(inputFilePath), newFilename);

      fs.renameSync(inputFilePath, newFilePath);
      taggedFiles.push(newFilePath);

      // ➡️ Cleanup temp WAV
      fs.unlink(wavFilePath, () => {});
    } catch (err) {
      console.error("❌ Failed tagging", file.originalname, err);
    }
  }

  return taggedFiles;
}

// 🔹 Single File Upload
exports.processFile = async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  const results = await handleTagging([file]);
  if (results.length === 0) {
    return res.status(500).json({ error: "Tagging failed" });
  }

  const finalPath = results[0];
  res.download(finalPath, path.basename(finalPath), err => {
    if (err) {
      console.error("❌ Error sending file:", err);
      res.status(500).json({ error: "Download failed" });
    }
  });
};

// 🔹 Batch File Upload
exports.processBatch = async (req, res) => {
  const files = req.files;
  if (!files || files.length === 0) {
    return res.status(400).json({ error: "No files uploaded" });
  }

  const results = await handleTagging(files);
  if (results.length === 0) {
    return res.status(500).json({ error: "All files failed tagging" });
  }

  const zipPath = await zipTaggedFiles(results);
  res.download(zipPath, "metatune-output.zip", err => {
    if (err) {
      console.error("❌ Error sending ZIP:", err);
      res.status(500).json({ error: "ZIP download failed" });
    }
    fs.unlink(zipPath, () => {});
  });
};
