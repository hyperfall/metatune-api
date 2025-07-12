// utils/fingerprint.js

const { exec } = require("child_process");
const acrcloud = require("acrcloud");
const axios = require("axios");
const normalizeTitle = require("./normalizeTitle");
const fetchAlbumArt = require("./fetchAlbumArt");
const logger = require("./logger");

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

async function queryMusicBrainzByFingerprint(fp) {
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
    if (!results.length) return null;

    const top = results[0];
    if (!top.recordings || !top.recordings.length) return null;

    const rec = top.recordings[0];
    return {
      method: "musicbrainz",
      score: top.score || 0,
      recording: {
        title: rec.title,
        artist: rec.artists?.map(a => a.name).join(", "),
        album: rec.releasegroups?.[0]?.title,
        date: rec.releasegroups?.[0]?.first-release-date?.slice(0, 4),
        mbid: rec.releasegroups?.[0]?.id,
        genre: rec.tags?.[0]?.name || null,
      },
    };
  } catch (err) {
    logger.error(`[MusicBrainz] Error: ${err.message}`);
    return null;
  }
}

async function queryAcrcloud(buffer) {
  try {
    const result = await ACR.identify(buffer);
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
    const fileBuffer = require("fs").readFileSync(filePath);

    // Try ACRCloud first
    let match = await queryAcrcloud(fileBuffer);
    if (!match) {
      logger.warn("🔁 Retrying ACRCloud...");
      match = await queryAcrcloud(fileBuffer); // retry once
    }

    if (match) {
      const art = await fetchAlbumArt(match.recording.mbid);
      match.recording.coverArt = art?.imageBuffer ? `data:${art.mime};base64,${art.imageBuffer.toString("base64")}` : null;
      return clean(match);
    }

    // Fallback to MusicBrainz
    const alt = await queryMusicBrainzByFingerprint(fp);
    if (alt) {
      const art = await fetchAlbumArt(alt.recording.mbid);
      alt.recording.coverArt = art?.imageBuffer ? `data:${art.mime};base64,${art.imageBuffer.toString("base64")}` : null;
      return clean(alt);
    }

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
