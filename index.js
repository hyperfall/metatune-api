const express = require("express");
const cors = require("cors");
const multer = require("multer");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

const { processFile } = require("./controllers/tagController");

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
    const allowed = ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/x-m4a", "audio/x-aac", "audio/flac", "audio/x-flac"];
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

// Clean up temporary files on shutdown (optional)
process.on("exit", () => {
  const dir = "./uploads";
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach(f => fs.unlinkSync(path.join(dir, f)));
  }
});

// Launch
app.listen(port, () => {
  console.log(`🚀 MetaTune API running on port ${port}`);
});
