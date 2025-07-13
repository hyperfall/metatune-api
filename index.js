/* ========================= index.js ========================= */
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const compression = require("compression");
const multer = require("multer");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

dotenv.config();

console.log(`🪵 Logging is ${process.env.DEBUG_LOGGING === "true" ? "ENABLED" : "DISABLED"}`);

const app = express();
// preserve original client IP for rate-limiting
app.set("trust proxy", 1);

const port = process.env.PORT || 3000;

// ─── Security Middlewares ────────────────────────────────────────────────────
app.use(helmet());
// rate limiter (restrict to 60 requests/min per IP)
app.use(rateLimit({
  windowMs: 60 * 1000,    // 1 minute
  max: 60,                // max requests per IP
  standardHeaders: true,  // return rate limit info in RateLimit-* headers
  legacyHeaders: false,   // disable X-RateLimit-* headers
  trustProxy: false       // ignore trust proxy when calculating IP
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN?.split(",") || "*",
  exposedHeaders: ["Content-Disposition"],
}));
app.use(compression());
app.use(express.json());

// ─── Credentials Check ───────────────────────────────────────────────────────
if (!process.env.ACR_HOST || !process.env.ACR_KEY || !process.env.ACR_SECRET)
  console.warn("⚠️ ACRCloud credentials are missing!");
if (!process.env.ACOUSTID_API_KEY)
  console.warn("⚠️ AcoustID API key is missing!");

// ─── Controllers & Utils ────────────────────────────────────────────────────
const { processFile, processBatch } = require("./controllers/tagController");
const { cleanupUploads } = require("./utils/cleanupUploads");

// ─── Upload Directory ───────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── Multer Config (15 MiB max per file) ────────────────────────────────────
const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 15 * 1024 * 1024,  // 15 MiB
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

// ─── Routes ──────────────────────────────────────────────────────────────────
// Healthcheck
app.get("/", (req, res) => {
  res.send("🎧 MetaTune API is running.");
});

// Single‐file tagging
app.post("/api/tag/upload", upload.single("audio"), processFile);

// Batch tagging
app.post("/api/tag/batch", upload.array("audio"), processBatch);

// Fingerprint stats
app.get("/api/stats", (req, res) => {
  const statsPath = path.join(__dirname, "cache", "fingerprintStats.json");
  if (fs.existsSync(statsPath)) {
    res.json(JSON.parse(fs.readFileSync(statsPath, "utf-8")));
  } else {
    res.status(404).json({ error: "Stats file not found." });
  }
});

// ─── Logs UI & Serving ──────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const auth = { login: process.env.LOG_USER, password: process.env.LOG_PASS };
  const b64 = (req.headers.authorization || "").split(" ")[1] || "";
  const [user, pass] = Buffer.from(b64, "base64").toString().split(":");
  if (auth.login && auth.password && user === auth.login && pass === auth.password) return next();
  res.set("WWW-Authenticate", 'Basic realm="MetaTune Logs"');
  res.status(401).send("Authentication required.");
}

app.get("/logs-ui", authMiddleware, (req, res) => {
  const dirs = ["cache", "logs"];
  let html = `<style>
    body{background:#0a0f2c;color:#eee;font-family:sans-serif;padding:1rem}
    a{color:#4A90E2;text-decoration:none}
    ul{list-style:none;padding-left:1em}
  </style><h2>📂 MetaTune Logs</h2><ul>`;
  dirs.forEach(dir => {
    const folder = path.join(__dirname, dir);
    if (fs.existsSync(folder)) {
      html += `<li><strong>${dir}/</strong><ul>`;
      fs.readdirSync(folder).forEach(f => {
        html += `<li><a href="/logs/${dir}/${encodeURIComponent(f)}" target="_blank">${f}</a></li>`;
      });
      html += `</ul></li>`;
    }
  });
  html += `</ul><p style="font-size:12px;color:gray;">Secured view of internal logs</p>`;
  res.send(html);
});

app.get("/logs/:dir/:file", authMiddleware, (req, res) => {
  const safe = ["cache", "logs"];
  if (!safe.includes(req.params.dir)) return res.status(403).send("Forbidden");
  const p = path.join(__dirname, req.params.dir, req.params.file);
  if (!fs.existsSync(p)) return res.status(404).send("File not found.");
  res.sendFile(p);
});

// ─── Cleanup & Shutdown ────────────────────────────────────────────────────
setInterval(() => cleanupUploads(UPLOAD_DIR, 15), 15 * 60 * 1000);
process.on("exit", () => cleanupUploads(UPLOAD_DIR, 0));

process.on("uncaughtException", err => console.error("💥 Uncaught Exception:", err));
process.on("unhandledRejection", err => console.error("💥 Unhandled Rejection:", err));

// ─── Global Error Handler ───────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Global Error]', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

// ─── Start Server ──────────────────────────────────────────────────────────
const server = app.listen(port, () => {
  console.log(`🚀 MetaTune API running on port ${port}`);
});

// Graceful shutdown on SIGTERM
process.on("SIGTERM", () => {
  console.log("⚙️ SIGTERM received, shutting down…");
  server.close(() => process.exit(0));
});
