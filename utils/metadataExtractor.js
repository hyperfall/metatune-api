// utils/metadataExtractor.js

const { exec } = require("child_process");
const path = require("path");

/**
 * Run a shell command and return its stdout.
 */
function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 500 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || stdout);
      resolve(stdout.trim());
    });
  });
}

/**
 * Extracts original metadata and technical info from an audio file.
 * - Tags: title, artist, album, year, genre
 * - Duration (in seconds)
 * - Bitrate (in kbps)
 * - File path (for fusion scoring)
 */
async function extractOriginalMetadata(filePath) {
  const cmd = `ffprobe -v error -print_format json -show_format "${filePath}"`;
  try {
    const raw = await runCommand(cmd);
    const parsed = JSON.parse(raw);
    const fmt = parsed.format || {};
    const tags = fmt.tags || {};

    // parse duration and bitrate
    const duration = fmt.duration ? parseFloat(fmt.duration) : null;
    const bitRate  = fmt.bit_rate ? Math.round(parseInt(fmt.bit_rate, 10) / 1000) : null;

    return {
      title:  tags.title  || "",
      artist: tags.artist || "",
      album:  tags.album  || "",
      year:   tags.date || tags.year || "",
      genre:  tags.genre  || "",
      duration,      // in seconds
      bitRate,       // in kbps
      filePath       // for fusion scoring
    };
  } catch (err) {
    console.warn(`[metadataExtractor] Failed to read metadata from ${filePath}: ${err}`);
    return {
      title:    "",
      artist:   "",
      album:    "",
      year:     "",
      genre:    "",
      duration: null,
      bitRate:  null,
      filePath
    };
  }
}

module.exports = { extractOriginalMetadata };
