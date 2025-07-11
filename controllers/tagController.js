const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { exec } = require("child_process");
const util = require("util");
const generateFingerprint = require("../utils/fingerprint");
const fetchAlbumArt = require("../utils/fetchAlbumArt");
const { writeTags } = require("../utils/tagWriter");
const { zipTaggedFiles } = require("../utils/zipFiles");

const execPromise = util.promisify(exec);

exports.processBatch = async (req, res) => {
  const files = req.files;
  if (!files || files.length === 0) {
    return res.status(400).json({ error: "No files uploaded" });
  }

  const taggedFiles = [];

  for (const file of files) {
    const inputFilePath = file.path;
    const filename = path.basename(inputFilePath);
    const wavDir = path.join(__dirname, "..", "wavuploads");
    const wavFilePath = path.join(wavDir, `${filename}.wav`);

    try {
      if (!fs.existsSync(wavDir)) fs.mkdirSync(wavDir, { recursive: true });

      await new Promise((resolve, reject) => {
        const cmd = `ffmpeg -y -i "${inputFilePath}" -ar 44100 -ac 2 -f wav "${wavFilePath}"`;
        exec(cmd, (error, stdout, stderr) => {
          if (error) return reject(new Error("FFmpeg conversion failed: " + stderr));
          resolve();
        });
      });

      const { duration, fingerprint } = await generateFingerprint(wavFilePath);

      const response = await axios.get("https://api.acoustid.org/v2/lookup", {
        params: {
          client: process.env.ACOUSTID_API_KEY,
          meta: "recordings+releasegroups+compress",
          fingerprint,
          duration,
        },
      });

      const match = response.data.results[0]?.recordings?.[0];
      const title = match?.title || "Unknown Title";
      const artist = match?.artists?.[0]?.name || "Unknown Artist";
      const album = match?.releasegroups?.[0]?.title || "Unknown Album";
      const year = match?.releasegroups?.[0]?.first_release_date?.split("-")[0] || "";
      const genre = match?.tags?.[0]?.name || "Unknown Genre";

      let image = null;
      const mbid = match?.releasegroups?.[0]?.id;
      if (mbid) {
        try {
          image = await fetchAlbumArt(mbid);
        } catch (err) {
          console.warn(`⚠️ No album art found for MBID ${mbid}`);
        }
      }

      const tags = { title, artist, album, year, genre, image };

      await writeTags(tags, inputFilePath);
      taggedFiles.push(inputFilePath);

      fs.unlink(wavFilePath, () => {});
    } catch (err) {
      console.error("❌ Failed tagging", file.filename, err);
    }
  }

  if (taggedFiles.length === 0) {
    return res.status(500).json({ error: "All files failed tagging" });
  }

  // 🧠 Decide zip or not
  if (taggedFiles.length === 1) {
    // Single file – return directly
    const filePath = taggedFiles[0];
    res.download(filePath, path.basename(filePath), err => {
      if (err) {
        console.error("❌ Error sending file:", err);
        res.status(500).json({ error: "Failed to send file" });
      }
    });
  } else {
    // Multiple files – return ZIP
    const zipPath = await zipTaggedFiles(taggedFiles);
    res.download(zipPath, "metatune-output.zip", err => {
      if (err) {
        console.error("❌ Error sending ZIP:", err);
        res.status(500).json({ error: "Failed to send ZIP file" });
      }

      // Cleanup after download
      fs.unlink(zipPath, () => {});
    });
  }
};
