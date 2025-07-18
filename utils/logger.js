const fs = require("fs");
const path = require("path");

const DEBUG = process.env.DEBUG_LOGGING === "true";
const LOG_DIR = path.join(__dirname, "..", "logs");
const STATS_FILE = path.join(__dirname, "..", "cache", "fingerprintStats.json");
const MATCH_LOG_FILE = path.join(LOG_DIR, "match-log.json");
const FALLBACK_LOG_FILE = path.join(LOG_DIR, "fallback-log.json");

function timestamp() {
  return new Date().toISOString().replace("T", " ").split(".")[0];
}

function log(...args) {
  if (DEBUG) console.log(`[${timestamp()}]`, ...args);
}

function warn(...args) {
  console.warn(`⚠️ [${timestamp()}]`, ...args);
}

function error(...args) {
  console.error(`❌ [${timestamp()}]`, ...args);
}

function logMatch(metadata) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  try {
    fs.writeFileSync(MATCH_LOG_FILE, JSON.stringify(metadata, null, 2));
  } catch (e) {
    warn("Failed to write match log:", e.message);
  }
}

/**
 * Log when ACRCloud album is overridden by MusicBrainz fallback.
 */
function logFallbackInfo(original, fallback) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

  const data = {
    timestamp: timestamp(),
    originalAlbum: original.album || "N/A",
    fallbackAlbum: fallback.album,
    fallbackYear: fallback.year,
    releaseId: fallback.releaseId || "unknown",
    usedCoverUrl: fallback.coverUrl || "none"
  };

  try {
    fs.appendFileSync(FALLBACK_LOG_FILE, JSON.stringify(data) + "\n");
    if (DEBUG) console.log(`[fallback] Album corrected: "${data.originalAlbum}" → "${data.fallbackAlbum}"`);
  } catch (e) {
    warn("Failed to write fallback log:", e.message);
  }
}

function updateStats({ source = "unknown", success = false }) {
  try {
    if (!fs.existsSync(STATS_FILE)) {
      fs.writeFileSync(STATS_FILE, JSON.stringify({}));
    }
    const stats = JSON.parse(fs.readFileSync(STATS_FILE, "utf-8"));
    if (!stats[source]) {
      stats[source] = { total: 0, success: 0 };
    }
    stats[source].total++;
    if (success) stats[source].success++;
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (err) {
    warn("Failed to update fingerprint stats:", err.message);
  }
}

module.exports = {
  log,
  warn,
  error,
  logMatch,
  logFallbackInfo,
  updateStats,
};
