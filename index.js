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

    const
