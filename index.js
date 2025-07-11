const express = require("express");
const cors = require("cors");
const multer = require("multer");
const dotenv = require("dotenv");
const path = require("path");

const { processFile } = require("./controllers/tagController");
const cleanupUploads = require("./uploads/cleanupUploads");

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS
app.use(cors({
  origin: "*",
  exposedHeaders: ["Content-Disposition"]
}));

// Multer upload config
const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "audio/mpeg", "audio/wav", "audio/x-wav",
      "audio/mp4", "audio/x-m4a", "audio/x-aac",
      "audio/flac", "audio/x-flac", "audio/ogg", "audio/webm", "audio/aac"
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported file type"), false);
    }
  }
});

// Routes
app.get("/", (req, res) => {
  res.send("🎧 MetaTune API is running.");
});

app.post("/api/tag/upload", upload.single("audio"), processFile);

// ⏳ Clean up every 15 minutes
setInterval(() => {
  cleanupUploads("./uploads", 15); // Delete files older than 15 minutes
}, 15 * 60 * 1000);

// 🧼 Clean up on exit
process.on("exit", () => cleanupUploads("./uploads", 0));

// Launch
app.listen(port, () => {
  console.log(`🚀 MetaTune API running on port ${port}`);
});
