const express = require("express");
const cors = require("cors");
const multer = require("multer");
const dotenv = require("dotenv");
const path = require("path");

const { processFile, processBatch } = require("./controllers/tagController");
const cleanupUploads = require("./utils/cleanupUploads");

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// 🛡️ CORS
app.use(cors({
  origin: "*",
  exposedHeaders: ["Content-Disposition"]
}));

// 📁 Multer config
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

// 🔹 Health check
app.get("/", (req, res) => {
  res.send("🎧 MetaTune API is running.");
});

// 🔹 Single file tagging
app.post("/api/tag/upload", upload.single("audio"), processFile);

// 🔹 Batch file tagging
app.post("/api/tag/batch", upload.array("audio"), processBatch);

// ⏳ Clean up every 15 minutes
setInterval(() => {
  cleanupUploads("./uploads", 15);
}, 15 * 60 * 1000);

// 🧼 Clean up on exit
process.on("exit", () => cleanupUploads("./uploads", 0));

// 🚀 Launch server
app.listen(port, () => {
  console.log(`🚀 MetaTune API running on port ${port}`);
});
