// utils/logger.js
const fs = require("fs");
const path = require("path");

const logDir = path.join(__dirname, "..", "cache");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "fingerprintLog.json");
const errorFile = path.join(logDir, "errors.log");
const statsFile = path.join(logDir, "fingerprintStats.json");

// Write to fingerprintLog.json
function logMatch(data) {
  const entry = {
    timestamp: new Date().toISOString(),
    ...data
  };

  let logs = [];
  if (fs.existsSync(logFile)) {
    try {
      logs = JSON.parse(fs.readFileSync(logFile));
    } catch (e) {
      logs = [];
    }
  }

  logs.push(entry);
  fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
}

// Append to errors.log
function logError(error) {
  const entry = `[${new Date().toISOString()}] ${error}\n`;
  fs.appendFileSync(errorFile, entry);
}

// Track basic fingerprint stats
function updateStats({ source, success }) {
  let stats = {
    total: 0,
    matched: 0,
    failed: 0,
    bySource: {}
  };

  if (fs.existsSync(statsFile)) {
    try {
      stats = JSON.parse(fs.readFileSync(statsFile));
    } catch (e) {}
  }

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
