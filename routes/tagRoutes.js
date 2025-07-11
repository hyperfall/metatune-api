const express = require("express");
const multer = require("multer");
const path = require("path");
const { processFile } = require("../controllers/tagController");

const tagRoutes = express.Router();

// ⚙️ Multer Storage Config
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^\w.-]/g, "_");
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    cb(null, `${timestamp}-${base}${ext}`);
  }
});

// ✅ Supported Formats
const allowedTypes = [
  "audio/mpeg",    // mp3
  "audio/flac",
  "audio/x-flac",
  "audio/mp4",     // m4a
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/webm",
  "audio/aac",
];

const fileFilter = (req, file, cb) => {
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("❌ Unsupported audio format."), false);
  }
};

const upload = multer({ storage, fileFilter });

// 🎧 Single File Upload Route
tagRoutes.post("/upload", upload.single("audio"), processFile);

module.exports = tagRoutes;
