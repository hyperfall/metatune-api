const express = require("express");
const cors = require("cors");
const multer = require("multer");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

dotenv.config();

console.log(`🪵 Logging is ${process.env.DEBUG_LOGGING === "true" ? "ENABLED" : "DISABLED"}`);

// ─── Key Validations ────────────────────────────────────────────────────────
if (!process.env.ACR_HOST || !process.env.ACR_KEY || !process.env.ACR_SECRET) {
  console.warn("⚠️ ACRCloud credentials are missing! Fallback will fail.");
}

if (!process.env.ACOUSTID_API_KEY) {
  console.warn("⚠️ AcoustID API key is missing! Primary fingerprinting may fail.");
}

// ─── Imports ────────────────────────────────────────────────────────────────
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
    files: 30,
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "audio/mpeg", "audio/flac", "audio/x-flac",
      "audio/mp4", "audio/x-m4a",
      "audio/wav", "audio/x-wav",
      "audio/ogg", "audio/webm",
      "audio/aac", "audio/opus", "audio/oga",
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

// Fingerprint stats (DEV)
app.get("/api/stats", (req, res) => {
  const statsPath = path.join(__dirname, "cache", "fingerprintStats.json");
  if (fs.existsSync(statsPath)) {
    const stats = JSON.parse(fs.readFileSync(statsPath, "utf-8"));
    res.json(stats);
  } else {
    res.status(404).json({ error: "Stats file not found." });
  }
});

// 📂 View logs/debug cache files
app.get("/logs/:file", (req, res) => {
  const allowedDirs = ["cache", "logs"];
  const file = req.params.file;
  let filePath = null;

  for (const dir of allowedDirs) {
    const fullPath = path.join(__dirname, dir, file);
    if (fs.existsSync(fullPath)) {
      filePath = fullPath;
      break;
    }
  }

  if (!filePath) {
    return res.status(404).send("Log file not found.");
  }

  res.sendFile(filePath);
});

// ─── Cleanup ────────────────────────────────────────────────────────────────
setInterval(() => {
  cleanupUploads(UPLOAD_DIR, 15);
}, 15 * 60 * 1000); // every 15 mins

process.on("exit", () => {
  cleanupUploads(UPLOAD_DIR, 0);
});

// ─── Error Handling ─────────────────────────────────────────────────────────
process.on("uncaughtException", err => {
  console.error("💥 Uncaught Exception:", err);
});

process.on("unhandledRejection", err => {
  console.error("💥 Unhandled Rejection:", err);
});

// ─── Launch ─────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`🚀 MetaTune API running on port ${port}`);
});
