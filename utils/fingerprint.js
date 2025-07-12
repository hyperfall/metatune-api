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
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function isCompilation(albumName) {
  const keywords = ["hits","greatest","now","best","compilation","nrj"];
  return keywords.some(k => albumName?.toLowerCase().includes(k));
}

/**
 * Fallback text‐search on MusicBrainz if album looks like a compilation
 */
async function queryMusicBrainzFallback(artist, title, logPrefix) {
  try {
    const response = await axios.get("https://musicbrainz.org/ws/2/recording", {
      params: {
        query: `${title} AND artist:${artist}`,
        fmt: "json",
        limit: 5
      },
      headers: { "User-Agent": "MetaTune/1.0 (metatune@app)" }
    });
    const recs = response.data.recordings || [];
    const rec = recs.find(r => r.releases?.length) || recs[0];
    if (!rec) return null;
    // Pull the recording MBID and top‐release
    const release = rec.releases[0];
    return {
      method: "musicbrainz-fallback",
      score: 100,
      recording: {
        mbid: rec.id,                              // recording MBID
        title: normalizeTitle(rec.title),
        artist: rec["artist-credit"]?.map(a => a.name).join(", "),
        album: normalizeTitle(release.title),
        date: release.date?.slice(0,4) || null,
        releaseGroupMbid: release["release-group"]?.id,
        genre: null
      }
    };
  } catch (err) {
    logger.error(`[MB Fallback] ${err.message}`);
    return null;
  }
}

/**
 * Use AcoustID → MusicBrainz to get a recording match
 */
async function queryMusicBrainzByFingerprint(fp, logPrefix) {
  try {
    const resp = await axios.get("https://api.acoustid.org/v2/lookup", {
      params: {
        client: process.env.ACOUSTID_KEY,
        fingerprint: fp.fingerprint,
        duration: fp.duration,
        meta: "recordings+releasegroups+compress"
      }
    });
    const results = resp.data.results || [];
    fs.writeFileSync(path.join("logs", `${logPrefix}-acoustid.json`), JSON.stringify(results, null, 2));
    if (!results.length) return null;

    const top = results[0];
    if (!top.recordings?.length) return null;

    const rec = top.recordings[0];
    const bestRelGroup = rec.releasegroups?.[0];
    return {
      method: "musicbrainz",
      score: top.score || 0,
      recording: {
        mbid: rec.id,                             // recording MBID
        title: rec.title,
        artist: rec.artists?.map(a => a.name).join(", "),
        album: bestRelGroup?.title || null,
        date: bestRelGroup?.["first-release-date"]?.slice(0,4) || null,
        releaseGroupMbid: bestRelGroup?.id,
        genre: rec.tags?.[0]?.name || null
      }
    };
  } catch (err) {
    logger.error(`[MusicBrainz] ${err.message}`);
    return null;
  }
}

/**
 * Query ACRCloud for a fingerprint match, preserve any MBID
 */
async function queryAcrcloud(buffer, logPrefix) {
  try {
    const result = await ACR.identify(buffer);
    fs.writeFileSync(path.join("logs", `${logPrefix}-acr.json`), JSON.stringify(result, null, 2));
    const m = result.metadata?.music?.[0];
    if (!m) return null;

    // ACRCloud may embed MusicBrainz recording ID under external_metadata
    const ext = m.external_metadata?.musicbrainz?.recording?.id;
    return {
      method: "acrcloud",
      score: m.score || 0,
      recording: {
        mbid: ext || null,
        title: m.title,
        artist: m.artists?.map(a => a.name).join(", "),
        album: m.album?.name || null,
        date: m.release_date?.slice(0,4) || null,
        genre: m.genres?.[0]?.name || null
      }
    };
  } catch (err) {
    logger.error(`[ACRCloud] ${err.message}`);
    return null;
  }
}

/**
 * Main orchestrator: ACRCloud → fallback compilation check → AcoustID → none
 */
async function getBestFingerprintMatch(filePath) {
  try {
    const fp = await runFpcalc(filePath);
    const buffer = fs.readFileSync(filePath);
    const prefix = path.basename(filePath, path.extname(filePath));

    // 1) Try ACRCloud
    let match = await queryAcrcloud(buffer, prefix);
    if (!match) {
      logger.warn("🔁 Retrying ACRCloud");
      match = await queryAcrcloud(buffer, prefix);
    }
    if (match) {
      // if album looks like a compilation, force MusicBrainz fallback
      if (isCompilation(match.recording.album)) {
        logger.warn(`[fallback] Compilation detected (“${match.recording.album}”), falling back...`);
        const mb = await queryMusicBrainzFallback(match.recording.artist, match.recording.title, prefix);
        if (mb) return clean(mb);
      }
      return clean(match);
    }

    // 2) AcoustID→MusicBrainz
    const alt = await queryMusicBrainzByFingerprint(fp, prefix);
    if (alt) return clean(alt);

    return null;
  } catch (err) {
    logger.error(`[Fingerprinting] ${err.message}`);
    return null;
  }
}

/**
 * Normalize text fields
 */
function clean(match) {
  const r = match.recording;
  r.title = normalizeTitle(r.title);
  r.album = normalizeTitle(r.album);
  return match;
}

module.exports = { getBestFingerprintMatch };
