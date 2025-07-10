const express = require("express");
const multer = require("multer");
const cors = require("cors");
const axios = require("axios");
const mm = require("music-metadata");
const NodeID3 = require("node-id3");
require("dotenv").config();
const { exec } = require("child_process");
const util = require("util");
const fs = require("fs");

const app = express();
const upload = multer({ dest: "uploads/" });
const execAsync = util.promisify(exec);

// Enable CORS
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());

app.post("/api/tag/upload", upload.single("audio"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  try {
    // Step 1: Use fpcalc to get fingerprint and duration
    const { stdout, stderr } = await execAsync(`fpcalc -json "${file.path}"`);
    if (stderr) console.warn("⚠️ fpcalc stderr:", stderr);

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      return res.status(500).json({
        error: "Failed to parse fpcalc output",
        rawOutput: stdout,
        parseError: err.message,
      });
    }

    const { fingerprint, duration } = parsed;
    if (!fingerprint || !duration) {
      return res.status(500).json({ error: "Incomplete fpcalc data" });
    }

    // Step 2: AcoustID lookup
    const acoustIdResponse = await axios.get("https://api.acoustid.org/v2/lookup", {
      params: {
        client: process.env.ACOUSTID_API_KEY,
        fingerprint,
        duration,
        meta: "recordings+releasegroups",
      },
      headers: {
        "User-Agent": "MetaTuneApp/1.0 (contact@example.com)",
      },
    });

    const match = acoustIdResponse.data?.results?.[0]?.recordings?.[0];

    const tags = {
      title: match?.title || "Unknown Title",
      artist: match?.artists?.[0]?.name || "Unknown Artist",
      album: match?.releasegroups?.[0]?.title || "Unknown Album",
    };

    // Step 3: Tag the file
    await NodeID3.write(tags, file.path);

    // Step 4 (Optional): Extract embedded cover art metadata
    const metadata = await mm.parseFile(file.path);
    const cover = metadata.common.picture?.[0];
    let coverBase64 = null;
    if (cover) {
      coverBase64 = `data:${cover.format};base64,${cover.data.toString("base64")}`;
    }

    return res.json({ success: true, tags, cover: coverBase64 });
  } catch (err) {
    console.error("🔥 Error tagging file:", err);
    return res.status(500).json({ error: "Tagging failed", details: err.message });
  } finally {
    // Clean up uploaded file
    if (file?.path) fs.unlink(file.path, () => {});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🎧 MetaTune API running on port ${PORT}`);
});
