const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { processFile, processBatch } = require("../controllers/tagController");

const tagRoutes = express.Router();

const allowedTypes = [
  "audio/mpeg", "audio/flac", "audio/x-flac",
  "audio/mp4", "audio/x-m4a", "audio/wav", "audio/x-wav",
  "audio/ogg", "audio/webm", "audio/aac", "audio/opus", "audio/oga",
];

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = "uploads/";
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const stamp = Date.now();
    const ext   = path.extname(file.originalname);
    const base  = path.basename(file.originalname, ext).replace(/[^\w.-]/g, "_");
    cb(null, `${stamp}-${base}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Unsupported audio format."), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    files: 30,
    fileSize: 50 * 1024 * 1024, // 50 MB per file
  }
});

tagRoutes.post("/upload", upload.single("audio"), processFile);
tagRoutes.post("/batch",  upload.array("audio", 30), processBatch);

module.exports = tagRoutes;
