// index.js
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const axios = require("axios");
const NodeID3 = require("node-id3");
require("dotenv").config();

const app = express();
const upload = multer({ dest: "uploads/" });

// CORS middleware (important)
app.use(cors({
  origin: "*", // or restrict to your frontend origin if you prefer
  methods: ["GET", "POST"],
}));

app.use(express.json());

// --- Route Setup ---
app.post("/api/tag/upload", upload.single("audio"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  try {
    // Run fpcalc to generate fingerprint and duration
    const { exec } = require("child_process");
    const util = require("util");
    const execAsync = util.promisify(exec);

    const { stdout } = await execAsync(`fpcalc -json "${file.path}"`);
    const { duration, fingerprint } = JSON.parse(stdout);

    const acoustIdResponse = await axios.get("https://api.acoustid.org/v2/lookup", {
      params: {
        client: process.env.ACOUSTID_API_KEY,
        meta: "recordings+releasegroups",
        fingerprint,
        duration,
      },
    });

    const match = acoustIdResponse.data.results[0]?.recordings?.[0];
    const tags = {
      title: match?.title || "Unknown Title",
      artist: match?.artists?.[0]?.name || "Unknown Artist",
      album: match?.releasegroups?.[0]?.title || "Unknown Album",
    };

    await NodeID3.write(tags, file.path);
    return res.json({ success: true, tags });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Tagging failed", details: err.message });
  }
});

// --- Start server LAST ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MetaTune API running on port ${PORT}`);
});
