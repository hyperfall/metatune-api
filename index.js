// index.js
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const axios = require("axios");
const NodeID3 = require("node-id3");
require("dotenv").config();
const { exec } = require("child_process");
const util = require("util");

const app = express();
const upload = multer({ dest: "uploads/" });
const execAsync = util.promisify(exec);

// CORS middleware
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
}));

app.use(express.json());

// --- Route Setup ---
app.post("/api/tag/upload", upload.single("audio"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  try {
    // --- Step 1: Run fpcalc ---
    const { stdout, stderr } = await execAsync(`fpcalc -json "${file.path}"`);
    console.log("🔍 fpcalc stdout:\n", stdout);
    if (stderr) console.warn("⚠️ fpcalc stderr:\n", stderr);

    let duration, fingerprint;
    try {
      const parsed = JSON.parse(stdout);
      duration = parsed.duration;
      fingerprint = parsed.fingerprint;
    } catch (parseErr) {
      console.error("❌ JSON parse error from fpcalc:", parseErr);
      return res.status(500).json({
        error: "Failed to parse fpcalc output",
        rawOutput: stdout,
        parseError: parseErr.message,
      });
    }

    if (!duration || !fingerprint) {
      return res.status(500).json({
        error: "fpcalc output incomplete",
        parsed: { duration, fingerprint },
      });
    }

    // --- Step 2: AcoustID Lookup ---
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

console.log("AcoustID raw response:", JSON.stringify(acoustIdResponse.data, null, 2));

const match = acoustIdResponse.data.results?.[0]?.recordings?.[0];

    const tags = {
      title: match?.title || "Unknown Title",
      artist: match?.artists?.[0]?.name || "Unknown Artist",
      album: match?.releasegroups?.[0]?.title || "Unknown Album",
    };

    await NodeID3.write(tags, file.path);
    return res.json({ success: true, tags });

  } catch (err) {
    console.error("🔥 Uncaught Error:", err);
    return res.status(500).json({
      error: "Tagging failed",
      details: err.message,
    });
  }
});

// --- Start server LAST ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MetaTune API running on port ${PORT}`);
});
