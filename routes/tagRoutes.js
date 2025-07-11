const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { processFile, processBatch } = require("../controllers/tagController");

const tagRoutes = express.Router();

// ✅ Supported Formats
const allowedTypes = [
  "audio/mpeg",    // .mp3
  "audio/flac",    // .flac
  "audio/x-flac",
  "audio/mp4",     // .m4a
  "audio/x-m4a",
  "audio/wav",     // .wav
  "audio/x-wav",
  "audio/ogg",     // .ogg
  "audio/webm",    // .webm
  "audio/aac",     // .aac
  "audio/opus",    // .opus
  "audio/oga",     // .oga
];

// ⚙️ Multer Storage Config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = "uploads/";
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^\w.-]/g, "_");
    cb(null, `${timestamp}-${base}${ext}`);
  }
});

// 🧼 Filter for Supported File Types
const fileFilter = (req, file, cb) => {
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("❌ Unsupported audio format."), false);
  }
};

// 🛠️ Multer Middleware
const upload = multer({ storage, fileFilter });

// 🎧 Single File Upload Route
tagRoutes.post("/upload", upload.single("audio"), processFile);

// 📦 Batch File Upload Route
tagRoutes.post("/batch", upload.array("files", 30), processBatch);

module.exports = tagRoutes;
