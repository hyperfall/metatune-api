const express = require("express");
const cors = require("cors");
const multer = require("multer");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

dotenv.config();

console.log(`🪵 Logging is ${process.env.DEBUG_LOGGING === "true" ? "ENABLED" : "DISABLED"}`);

const app = express();
const port = process.env.PORT || 3000;

// ─── Credentials Check ─────────────────────────────────────────────────────
if (!process.env.ACR_HOST || !process.env.ACR_KEY || !process.env.ACR_SECRET)
  console.warn("⚠️ ACRCloud credentials are missing!");

if (!process.env.ACOUSTID_API_KEY)
  console.warn("⚠️ AcoustID API key is missing!");

// ─── Imports ───────────────────────────────────────────────────────────────
const { processFile, processBatch } = require("./controllers/tagController");
const cleanupUploads = require("./utils/cleanupUploads");

// ─── Directories ───────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── CORS ──────────────────────────────────────────────────────────────────
app.use(cors({
  origin: "*",
  exposedHeaders: ["Content-Disposition"],
}));

// ─── Multer Config ─────────────────────────────────────────────────────────
const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 30,
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "audio/mpeg", "audio/flac", "audio/x-flac", "audio/mp4", "audio/x-m4a",
      "audio/wav", "audio/x-wav", "audio/ogg", "audio/webm",
      "audio/aac", "audio/opus", "audio/oga",
    ];
    cb(null, allowed.includes(file.mimetype));
  },
});

// ─── API Routes ─────────────────────────────────────────────────────────────
// Health
app.get("/", (req, res) => {
  res.send("🎧 MetaTune API is running.");
});

// Tagging
app.post("/api/tag/upload", upload.single("audio"), processFile);
app.post("/api/tag/batch", upload.array("audio"), processBatch);

// Fingerprint Stats
app.get("/api/stats", (req, res) => {
  const statsPath = path.join(__dirname, "cache", "fingerprintStats.json");
  if (fs.existsSync(statsPath)) {
    const stats = JSON.parse(fs.readFileSync(statsPath, "utf-8"));
    res.json(stats);
  } else {
    res.status(404).json({ error: "Stats file not found." });
  }
});

// ─── Logs HTML UI ───────────────────────────────────────────────────────────
// Auth middleware (optional)
function authMiddleware(req, res, next) {
  const auth = { login: process.env.LOG_USER, password: process.env.LOG_PASS };
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [user, pass] = Buffer.from(b64auth, 'base64').toString().split(':');

  if (auth.login && auth.password && user === auth.login && pass === auth.password) return next();

  res.set('WWW-Authenticate', 'Basic realm="MetaTune Logs"');
  res.status(401).send('Authentication required.');
}

app.get("/logs-ui", authMiddleware, (req, res) => {
  const dirs = ["cache", "logs"];
  let html = `<style>
    body { background:#0a0f2c; color:#eee; font-family:sans-serif; padding:1rem; }
    a { color:#4A90E2; text-decoration:none; }
    ul { list-style:none; padding-left:1em; }
  </style><h2>📂 MetaTune Logs</h2><ul>`;

  for (const dir of dirs) {
    const folder = path.join(__dirname, dir);
    if (fs.existsSync(folder)) {
      html += `<li><strong>${dir}/</strong><ul>`;
      const files = fs.readdirSync(folder);
      for (const f of files) {
        html += `<li><a href="/logs/${dir}/${encodeURIComponent(f)}" target="_blank">${f}</a></li>`;
      }
      html += `</ul></li>`;
    }
  }

  html += `</ul><p style="font-size:12px;color:gray;">Secured view of internal logs</p>`;
  res.send(html);
});

// ─── Serve Logs ─────────────────────────────────────────────────────────────
app.get("/logs/:dir/:file", authMiddleware, (req, res) => {
  const { dir, file } = req.params;
  const safeDirs = ["cache", "logs"];
  if (!safeDirs.includes(dir)) return res.status(403).send("Forbidden");

  const filePath = path.join(__dirname, dir, file);
  if (!fs.existsSync(filePath)) return res.status(404).send("File not found.");

  res.sendFile(filePath);
});

// ─── Cleanup ────────────────────────────────────────────────────────────────
setInterval(() => {
  cleanupUploads(UPLOAD_DIR, 15);
}, 15 * 60 * 1000);

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
