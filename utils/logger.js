// utils/logger.js

const fs = require("fs");
const path = require("path");

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB
const DEBUG = process.env.DEBUG_LOGGING === "true";

const logDir = path.join(__dirname, "..", "cache");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "fingerprintLog.json");
const errorFile = path.join(logDir, "errors.log");
const statsFile = path.join(logDir, "fingerprintStats.json");

function rotateIfTooLarge(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_LOG_SIZE) {
        const backupName = `${filePath}.${Date.now()}.bak`;
        fs.renameSync(filePath, backupName);
        fs.writeFileSync(filePath, filePath.endsWith(".json") ? "[]" : ""); // reset
      }
    }
  } catch (e) {
    console.warn(`⚠️ Log rotation failed: ${e.message}`);
  }
}

function logMatch(data) {
  if (!DEBUG) return;

  rotateIfTooLarge(logFile);
  const entry = {
    timestamp: new Date().toISOString(),
    ...data,
  };

  let logs = [];
  try {
    if (fs.existsSync(logFile)) {
      logs = JSON.parse(fs.readFileSync(logFile, "utf-8")) || [];
    }
  } catch (_) {}

  logs.push(entry);
  fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
}

function logError(error) {
  if (!DEBUG) return;

  rotateIfTooLarge(errorFile);
  const entry = `[${new Date().toISOString()}] ${error}\n`;
  fs.appendFileSync(errorFile, entry);
}

function updateStats({ source, success }) {
  if (!DEBUG) return;

  rotateIfTooLarge(statsFile);

  let stats = {
    total: 0,
    matched: 0,
    failed: 0,
    bySource: {}
  };

  try {
    if (fs.existsSync(statsFile)) {
      stats = JSON.parse(fs.readFileSync(statsFile, "utf-8")) || stats;
    }
  } catch (_) {}

  stats.total += 1;
  if (success) {
    stats.matched += 1;
    stats.bySource[source] = (stats.bySource[source] || 0) + 1;
  } else {
    stats.failed += 1;
  }

  fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));
}

// 🔧 General purpose log/warn/error
function log(msg) {
  if (DEBUG) console.log(msg);
}

function warn(msg) {
  if (DEBUG) console.warn(msg);
}

function error(msg) {
  if (DEBUG) console.error(msg);
}

module.exports = {
  logMatch,
  logError,
  updateStats,
  log,
  warn,
  error,
};
