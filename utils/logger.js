// utils/logger.js

const fs = require("fs");
const path = require("path");

const logDir = path.join(__dirname, "..", "cache");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "fingerprintLog.json");
const errorFile = path.join(logDir, "errors.log");
const statsFile = path.join(logDir, "fingerprintStats.json");

// Log a match result to fingerprintLog.json
function logMatch(data) {
  const entry = {
    timestamp: new Date().toISOString(),
    ...data,
  };

  let logs = [];
  try {
    if (fs.existsSync(logFile)) {
      logs = JSON.parse(fs.readFileSync(logFile, "utf-8")) || [];
    }
  } catch (e) {
    logs = [];
  }

  logs.push(entry);
  fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
}

// Append error to errors.log
function logError(error) {
  const entry = `[${new Date().toISOString()}] ${error}\n`;
  fs.appendFileSync(errorFile, entry);
}

// Update fingerprintStats.json for global metrics
function updateStats({ source, success }) {
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
  } catch (e) {}

  stats.total += 1;
  if (success) {
    stats.matched += 1;
    stats.bySource[source] = (stats.bySource[source] || 0) + 1;
  } else {
    stats.failed += 1;
  }

  fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));
}

module.exports = {
  logMatch,
  logError,
  updateStats
};
