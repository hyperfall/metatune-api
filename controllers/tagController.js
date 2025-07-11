
// controllers/tagController.js
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const fetch = require("node-fetch");
const mm = require("music-metadata");
const FormData = require("form-data");
const crypto = require("crypto");

const ACOUSTID_API_KEY = process.env.ACOUSTID_API_KEY || "your_api_key";
const MB_API = "https://musicbrainz.org/ws/2";

// Utility: Generate fingerprint
async function generateFingerprint(filepath) {
  return new Promise((resolve, reject) => {
    exec(`fpcalc -raw -length 120 "${filepath}"`, (err, stdout) => {
      if (err) return reject(err);
      const durationMatch = stdout.match(/DURATION=(\d+)/);
      const fingerprintMatch = stdout.match(/FINGERPRINT=(.+)/);

      if (durationMatch && fingerprintMatch) {
        const duration = parseInt(durationMatch[1], 10);
        const fingerprint = fingerprintMatch[1].trim();
        resolve({ duration, fingerprint });
      } else {
        reject(new Error("Fingerprint or duration not found"));
      }
    });
  });
}

// Utility: Query AcoustID
async function queryAcoustID(fp, duration) {
  const url = new URL("https://api.acoustid.org/v2/lookup");
  url.searchParams.set("client", ACOUSTID_API_KEY);
  url.searchParams.set("duration", duration);
  url.searchParams.set("fingerprint", fp);
  url.searchParams.set("meta", "recordings+releasegroups+sources");

  const res = await fetch(url);
  const data = await res.json();
  return data;
}

// Utility: Fetch MusicBrainz metadata
async function fetchMBMetadata(recordingId) {
  const url = `${MB_API}/recording/${recordingId}?inc=artists+releases&fmt=json`;
  const res = await fetch(url);
  return res.json();
}

// Utility: Write tags using ffmpeg
async function writeTags(filepath, metadata, albumArtPath) {
  const output = filepath.replace(/\/uploads\//, "/wavuploads/").replace(/(\.\w+)$/, "_tagged$1");

  return new Promise((resolve, reject) => {
    const args = [
      "-y", "-loglevel", "error",
      "-i", `"${filepath}"`,
      "-i", `"${albumArtPath}"`,
      "-metadata", `title="${metadata.title}"`,
      "-metadata", `artist="${metadata.artist}"`,
      "-metadata", `album="${metadata.album}"`,
      "-metadata", `genre="${metadata.genre}"`,
      "-metadata", `date="${metadata.year}"`,
      "-id3v2_version", "3", "-write_id3v1", "1",
      "-map", "0", "-map", "1",
      "-c", "copy", "-disposition:v:0", "attached_pic",
      `"${output}"`
    ].join(" ");

    exec(`ffmpeg ${args}`, (err) => {
      if (err) return reject(err);
      fs.copyFileSync(output, filepath);  // Overwrite original
      fs.unlinkSync(output);
      resolve(filepath);
    });
  });
}

// Controller: Process single file
exports.processFile = async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  try {
    const { duration, fingerprint } = await generateFingerprint(file.path);
    const acoustRes = await queryAcoustID(fingerprint, duration);
    const result = acoustRes.results?.[0];
    let metadata = {
      title: "Unknown",
      artist: "Unknown",
      album: "Unknown",
      genre: "Unknown",
      year: new Date().getFullYear().toString()
    };

    if (result && result.score > 0.9 && result.recordings?.[0]) {
      const mbData = await fetchMBMetadata(result.recordings[0].id);
      metadata.title = mbData.title || metadata.title;
      metadata.artist = mbData["artist-credit"]?.[0]?.name || metadata.artist;
      metadata.album = mbData.releases?.[0]?.title || metadata.album;
      metadata.year = mbData.releases?.[0]?.date?.split("-")[0] || metadata.year;
    } else {
      console.log("[handleTagging] 🔍 No strong fingerprint match — fallback engaged.");
    }

    const tags = await mm.parseFile(file.path);
    if (tags.common.picture?.[0]) {
      const pic = tags.common.picture[0];
      const albumArtPath = path.join("/tmp", `tmp-${crypto.randomUUID()}.png`);
      fs.writeFileSync(albumArtPath, pic.data);
      await writeTags(file.path, metadata, albumArtPath);
      fs.unlinkSync(albumArtPath);
    }

    const safeName = `${metadata.artist} - ${metadata.title}`.replace(/[\/:*?"<>|]+/g, "");
    const newPath = path.join(path.dirname(file.path), safeName + path.extname(file.originalname));
    fs.renameSync(file.path, newPath);

    res.download(newPath);
  } catch (err) {
    console.error("[processFile] ❌ Error:", err);
    res.status(500).json({ error: err.message });
  }
};

// Controller: Process batch
exports.processBatch = async (req, res) => {
  res.status(501).json({ error: "Batch processing not implemented yet." });
};
