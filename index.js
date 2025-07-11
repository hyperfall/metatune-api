// index.js
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

dotenv.config();

const { processFile, processBatch } = require("./controllers/tagController");
const cleanupUploads = require("./utils/cleanupUploads");

const app = express();
const port = process.env.PORT || 3000;

// ─── Ensure Upload Directory ───────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ─── CORS ──────────────────────────────────────────────────────────────────
app.use(cors({
  origin: "*",
  exposedHeaders: ["Content-Disposition"],
}));

// ─── Multer Config ─────────────────────────────────────────────────────────
const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB per file
    files:    30,               // max 30 files in batch
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "audio/mpeg",    // mp3
      "audio/flac",    // flac
      "audio/x-flac",
      "audio/mp4",     // m4a
      "audio/x-m4a",
      "audio/wav",     // wav
      "audio/x-wav",
      "audio/ogg",     // ogg
      "audio/webm",    // webm
      "audio/aac",     // aac
      "audio/opus",    // opus
      "audio/oga",     // oga
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported audio format"), false);
    }
  },
});

// ─── Routes ─────────────────────────────────────────────────────────────────
// Health check
app.get("/", (req, res) => {
  res.send("🎧 MetaTune API is running.");
});

// Single-file tagging
app.post("/api/tag/upload", upload.single("audio"), processFile);

// Batch-file tagging
app.post("/api/tag/batch", upload.array("audio"), processBatch);

// ─── Cleanup ────────────────────────────────────────────────────────────────
// Every 15 minutes, delete uploads older than 15 minutes
setInterval(() => {
  cleanupUploads(UPLOAD_DIR, 15);
}, 15 * 60 * 1000);

// On exit, purge everything
process.on("exit", () => {
  cleanupUploads(UPLOAD_DIR, 0);
});

// ─── Launch ─────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(🚀 MetaTune API running on port ${port});
});
