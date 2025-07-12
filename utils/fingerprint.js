// utils/fingerprint.js

const { exec } = require("child_process");
const acrcloud = require("acrcloud");
const axios = require("axios");
const normalizeTitle = require("./normalizeTitle");
const logger = require("./logger");
const fs = require("fs");
const path = require("path");

const ACR = new acrcloud({
  host: process.env.ACR_HOST,
  access_key: process.env.ACR_KEY,
  access_secret: process.env.ACR_SECRET,
});

function runFpcalc(filePath) {
  return new Promise((resolve, reject) => {
    exec(`fpcalc -json "${filePath}"`, (err, stdout) => {
      if (err) return reject(err);
      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function queryMusicBrainzByFingerprint(fp, logPrefix) {
  try {
    const response = await axios.get("https://api.acoustid.org/v2/lookup", {
      params: {
        client: process.env.ACOUSTID_KEY,
        fingerprint: fp.fingerprint,
        duration: fp.duration,
        meta: "recordings+releasegroups+compress",
      },
    });

    const results = response.data.results || [];
    const logPath = path.join("logs", `${logPrefix}-acoustid-raw.json`);
    fs.writeFileSync(logPath, JSON.stringify(results, null, 2));

    if (!results.length) return null;

    const top = results[0];
    if (!top.recordings || !top.recordings.length) return null;

    const rec = top.recordings[0];
    const bestRelease = rec.releasegroups?.[0];

    return {
      method: "musicbrainz",
      score: top.score || 0,
      recording: {
        title: rec.title,
        artist: rec.artists?.map(a => a.name).join(", "),
        album: bestRelease?.title || null,
        date: bestRelease?.["first-release-date"]?.slice(0, 4) || null,
        mbid: bestRelease?.id,
        genre: rec.tags?.[0]?.name || null,
      },
    };
  } catch (err) {
    logger.error(`[MusicBrainz] Error: ${err.message}`);
    return null;
  }
}

async function queryAcrcloud(buffer, logPrefix) {
  try {
    const result = await ACR.identify(buffer);
    const logPath = path.join("logs", `${logPrefix}-acr-raw.json`);
    fs.writeFileSync(logPath, JSON.stringify(result, null, 2));

    const metadata = result?.metadata?.music?.[0];
    if (!metadata) return null;

    return {
      method: "acrcloud",
      score: metadata.score || 0,
      recording: {
        title: metadata.title,
        artist: metadata.artists?.map(a => a.name).join(", "),
        album: metadata.album?.name,
        date: metadata.release_date?.slice(0, 4),
        genre: metadata.genres?.[0]?.name || null,
      },
    };
  } catch (err) {
    logger.error(`[ACRCloud] Error: ${err.message}`);
    return null;
  }
}

async function getBestFingerprintMatch(filePath) {
  try {
    const fp = await runFpcalc(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const baseName = path.basename(filePath, path.extname(filePath));

    // Try ACRCloud first
    let match = await queryAcrcloud(fileBuffer, baseName);
    if (!match) {
      logger.warn("🔁 Retrying ACRCloud...");
      match = await queryAcrcloud(fileBuffer, baseName);
    }

    if (match) return clean(match);

    // Fallback to MusicBrainz
    const alt = await queryMusicBrainzByFingerprint(fp, baseName);
    if (alt) return clean(alt);

    return null;
  } catch (e) {
    logger.error(`[Fingerprinting] Failure: ${e.message}`);
    return null;
  }
}

function clean(match) {
  const r = match.recording;
  r.title = normalizeTitle(r.title);
  r.album = normalizeTitle(r.album);
  return match;
}

module.exports = {
  getBestFingerprintMatch,
};
