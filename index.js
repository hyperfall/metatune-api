const express = require("express");
const cors = require("cors");
const multer = require("multer");
const dotenv = require("dotenv");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const fpcalc = require("fpcalc");
const ID3Writer = require("node-id3");

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const ACOUSTID_KEY = process.env.ACOUSTID_KEY;

const upload = multer({ dest: "uploads/" });
app.use(cors());

app.get("/", (req, res) => {
  res.send("MetaTune API is running.");
});

app.post("/api/tag/upload", upload.single("audio"), async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const filePath = path.resolve(file.path);
    console.log("Uploaded file path:", filePath);

    fpcalc(filePath, async (err, result) => {
      if (err) {
        console.error("fpcalc error:", err);
        return res.status(500).json({ error: "Fingerprinting failed", details: err.message });
      }

      console.log("fpcalc result:", result);
      const { fingerprint, duration } = result;

      const url = `https://api.acoustid.org/v2/lookup?client=${ACOUSTID_KEY}&fingerprint=${encodeURIComponent(
        fingerprint
      )}&duration=${duration}&meta=recordings+releasegroups`;

      try {
        const response = await axios.get(url);
        console.log("AcoustID response:", response.data);

        const recordings = response.data.results?.[0]?.recordings;
        if (!recordings || recordings.length === 0) {
          return res.status(404).json({ error: "No matching metadata found." });
        }

        const recording = recordings[0];
        const tags = {
          title: recording.title,
          artist: recording.artists?.[0]?.name || "Unknown Artist",
          album: recording.releasegroups?.[0]?.title || "Unknown Album",
        };

        console.log("Writing tags:", tags);
        ID3Writer.write(tags, filePath);

        const taggedBuffer = fs.readFileSync(filePath);
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Content-Disposition", 'attachment; filename="tagged.mp3"');
        res.send(taggedBuffer);
      } catch (acoustidError) {
        const errData = acoustidError.response?.data || acoustidError.message;
        console.error("AcoustID API error:", errData);
        return res.status(400).json({ error: "Tagging failed", details: errData });
      }
    });
  } catch (error) {
    console.error("Server error:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

app.listen(port, () => {
  console.log(`MetaTune API running on port ${port}`);
});
