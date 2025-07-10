// index.js
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const axios = require("axios");
const NodeID3 = require("node-id3");
const { exec } = require("child_process");
const util = require("util");
require("dotenv").config();

const app = express();
const upload = multer({ dest: "uploads/" });
const execAsync = util.promisify(exec);

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());

app.post("/api/tag/upload", upload.single("audio"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  try {
    // Step 1: Extract fingerprint using fpcalc
    const { stdout } = await execAsync(`fpcalc -json "${file.path}"`);
    const { duration, fingerprint } = JSON.parse(stdout);

    if (!duration || !fingerprint) {
      return res.status(500).json({ error: "Invalid fpcalc output" });
    }

    // Step 2: Lookup AcoustID
    const acoustIdRes = await axios.get("https://api.acoustid.org/v2/lookup", {
      params: {
        client: process.env.ACOUSTID_API_KEY,
        fingerprint,
        duration: Math.round(duration),
        meta: "recordings+releasegroups",
      },
      headers: {
        "User-Agent": "MetaTuneApp/1.0 (contact@example.com)",
      },
    });

    const results = acoustIdRes.data.results;
    const match = results?.[0]?.recordings?.[0];

    if (!match) {
      return res.status(200).json({
        success: false,
        reason: "No strong metadata match found",
        acoustidId: results?.[0]?.id,
        rawResults: results,
      });
    }

    const tags = {
      title: match?.title || "Unknown Title",
      artist: match?.["artist-credit"]?.[0]?.name || "Unknown Artist",
      album: match?.["releasegroups"]?.[0]?.title || "Unknown Album",
    };

    await NodeID3.write(tags, file.path);

    res.json({
      success: true,
      tags,
      acoustidId: results?.[0]?.id,
    });

  } catch (err) {
    console.error("🔥 Uncaught Error:", err);
    res.statu
