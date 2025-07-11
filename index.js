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
  exposedHeaders: ["Content-Disposition"]
}));

// ─── Multer Config ─────────────────────────────────────────────────────────
const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "audio/mpeg", "audio/wav", "audio/x-wav",
      "audio/mp4", "audio/x-m4a", "audio/x-aac",
      "audio/flac", "audio/x-flac", "audio/ogg",
      "audio/webm", "audio/aac"
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported file type"), false);
    }
  }
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
// every 15 minutes, delete uploads older than 15m
setInterval(() => {
  cleanupUploads(UPLOAD_DIR, 15);
}, 15 * 60 * 1000);

// on exit, purge everything
process.on("exit", () => cleanupUploads(UPLOAD_DIR, 0));

// ─── Launch ─────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`🚀 MetaTune API running on port ${port}`);
});
