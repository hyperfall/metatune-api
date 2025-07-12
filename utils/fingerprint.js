// utils/fingerprint.js
const fs = require("fs");
const path = require("path");
const fpcalc = require("fpcalc");
const fetch = require("./fetch");
const logger = require("./logger");

const DEBUG_DUMP_PATH = path.join(__dirname, "..", "cache", "debugMatch.json");

function fingerprintFile(filePath) {
  return new Promise((resolve, reject) => {
    fpcalc(filePath, { raw: true }, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

async function getBestFingerprintMatch(filePath) {
  const { fingerprint, duration } = await fingerprintFile(filePath);

  const res = await fetch.post("https://api.acrcloud.com/v1/identify", {
    fingerprint,
    duration,
  });

  if (!res || !res.status || !res.metadata?.music?.length) {
    logger.warn("No fingerprint match from ACRCloud.");
    return null;
  }

  const music = res.metadata.music[0];
  const score = music.score || 0;
  const matchDuration = music.duration_ms ? music.duration_ms / 1000 : duration;

  // Filter: low score or big duration mismatch
  if (score < 85 || Math.abs(matchDuration - duration) > 5) {
    logger.warn(`Filtered out match: score=${score}, duration delta=${Math.abs(matchDuration - duration)}`);
    return null;
  }

  // Album fallback logic
  let album = music.album?.name || "Unknown Album";
  if (music.release_date && music.external_metadata?.musicbrainz?.release?.length) {
    const release = music.external_metadata.musicbrainz.release.find(r => r.status === "Official");
    if (release?.title) album = release.title;
  }

  const match = {
    method: "acrcloud",
    score,
    title: music.title,
    artist: music.artists?.[0]?.name,
    album,
    date: music.release_date?.split("-")[0] || "2023",
    coverArt: music.album?.images?.[0]?.url || null
  };

  logger.log("📥 Matched Raw:", music);

  // Optional debug dump
  try {
    fs.writeFileSync(DEBUG_DUMP_PATH, JSON.stringify(music, null, 2));
  } catch (e) {
    logger.warn("Could not write debug match dump.");
  }

  return { recording: match, score: match.score, method: match.method, duration };
}

module.exports = {
  getBestFingerprintMatch
};
