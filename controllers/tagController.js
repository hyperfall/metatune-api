const { generateFingerprint } = require("../utils/fingerprint");
const { writeTags } = require("../utils/tagWriter");
const { fetchAlbumArt } = require("../utils/fetchArt");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");

exports.processFile = async (req, res) => {
  const inputFilePath = req.file.path; // e.g., uploads/xyz.mp3
  const filename = path.basename(inputFilePath); // xyz.mp3
  const wavDir = path.join(__dirname, "..", "wavuploads");
  const wavFilePath = path.join(wavDir, `${filename}.wav`);

  try {
    // Make sure wavuploads exists
    if (!fs.existsSync(wavDir)) {
      fs.mkdirSync(wavDir, { recursive: true });
    }

    // Convert to WAV using ffmpeg
    await new Promise((resolve, reject) => {
      const cmd = `ffmpeg -y -i "${inputFilePath}" -ar 44100 -ac 2 -f wav "${wavFilePath}"`;
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          return reject(new Error("FFmpeg conversion failed: " + stderr));
        }
        resolve();
      });
    });

    // Generate fingerprint from WAV
    const { duration, fingerprint } = await generateFingerprint(wavFilePath);

    // Query AcoustID
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

    // Try fetching album art
    let image = null;
    const mbid = match?.releasegroups?.[0]?.id;
    if (mbid) {
      try {
        image = await fetchAlbumArt(mbid);
      } catch (err) {
        console.warn(`⚠️ No album art found for MBID ${mbid}`);
      }
    }

    // Construct tags
    const tags = { title, artist, album, year, genre, image };

    // Write tags back to original file
    await writeTags(tags, inputFilePath);

    // Clean up WAV
    fs.unlink(wavFilePath, (err) => {
      if (err) console.warn("⚠️ Failed to delete WAV:", wavFilePath);
    });

    res.json({ success: true, tags });
  } catch (err) {
    console.error("❌ Error in processFile:", err);
    res.status(500).json({ error: "Tagging failed", details: err.message });
  }
};
