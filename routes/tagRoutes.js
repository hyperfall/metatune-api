const express = require("express");
const multer = require("multer");
const router = express.Router();
const { processFile } = require("../controllers/tagController");
const path = require("path");

// Multer config – accepts any file with audio extensions
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${file.originalname}`;
    cb(null, name);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    "audio/mpeg",      // .mp3
    "audio/flac",      // .flac
    "audio/x-flac",
    "audio/mp4",       // .m4a
    "audio/x-m4a",
    "audio/wav",       // .wav
    "audio/x-wav",
    "audio/ogg",       // .ogg
    "audio/webm",      // .webm
    "audio/aac",       // .aac
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Unsupported audio format."), false);
  }
};

const upload = multer({ storage, fileFilter });

// Route
router.post("/upload", upload.single("audio"), processFile);

module.exports = router;
