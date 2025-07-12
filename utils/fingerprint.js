// utils/fingerprint.js

const { exec } = require("child_process");
const acrcloud = require("acrcloud");
const axios = require("axios");
const normalizeTitle = require("./normalizeTitle");
const logger = require("./logger");
const fs = require("fs");
const path = require("path");
const { findBestRelease, getOfficialAlbumInfo } = require("./musicbrainzHelper");

const ACR = new acrcloud({
  host: process.env.ACR_HOST,
  access_key: process.env.ACR_KEY,
  access_secret: process.env.ACR_SECRET,
});

/**
 * Run fpcalc to extract duration & fingerprint
 */
function runFpcalc(filePath) {
  return new Promise((resolve, reject) => {
    exec(
      `fpcalc -json "${filePath}"`,
      { maxBuffer: 1024 * 2000 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

/**
 * Heuristic for “compilation”-style album names
 */
function isCompilation(albumName) {
  const keywords = ["hits", "greatest", "now", "best", "compilation", "nrj"];
  return keywords.some(k => albumName?.toLowerCase().includes(k));
}

/**
 * Fallback: robust MusicBrainz lookup when a compilation is detected
 */
async function queryMusicBrainzFallback(artist, title) {
  try {
    const info = await getOfficialAlbumInfo(artist, title, "");
    if (!info) return null;
    return {
      method: "musicbrainz-fallback",
      score: 100,
      recording: {
        mbid: info.recordingMbid,
        title: normalizeTitle(title),
        artist: normalizeTitle(artist),
        album: normalizeTitle(info.album),
        date: info.year,
        releaseGroupMbid: info.releaseGroupMbid,
        genre: null
      }
    };
  } catch (err) {
    logger.error(`[MB Fallback] ${err.message}`);
    return null;
  }
}

/**
 * Fingerprint lookup via AcoustID → MusicBrainz
 */
async function queryMusicBrainzByFingerprint(fp, prefix) {
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
    fs.writeFileSync(
      path.join("logs", `${prefix}-acoustid.json`),
      JSON.stringify(results, null, 2)
    );
    if (!results.length || !results[0].recordings?.length) return null;

    const top = results[0];
    const rec = top.recordings[0];
    const grp = rec.releasegroups?.[0];

    return {
      method: "musicbrainz",
      score: top.score || 0,
      recording: {
        mbid: rec.id,
        title: rec.title,
        artist: rec.artists?.map(a => a.name).join(", "),
        album: grp?.title || null,
        date: grp?.["first-release-date"]?.slice(0, 4) || null,
        releaseGroupMbid: grp?.id,
        genre: rec.tags?.[0]?.name || null
      }
    };
  } catch (err) {
    logger.error(`[MusicBrainz] ${err.message}`);
    return null;
  }
}

/**
 * Primary ACRCloud lookup returning *all* hits
 */
async function queryAcrcloudAll(buffer, prefix) {
  try {
    const result = await ACR.identify(buffer);
    fs.writeFileSync(
      path.join("logs", `${prefix}-acr.json`),
      JSON.stringify(result, null, 2)
    );
    const list = result.metadata?.music || [];
    return list.map(m => ({
      method: "acrcloud",
      score: m.score || 0,
      recording: {
        mbid: m.external_metadata?.musicbrainz?.recording?.id || null,
        title: m.title,
        artist: m.artists?.map(a => a.name).join(", "),
        album: m.album?.name || null,
        date: m.release_date?.slice(0, 4) || null,
        genre: m.genres?.[0]?.name || null
      }
    }));
  } catch (err) {
    logger.error(`[ACRCloud] ${err.message}`);
    return [];
  }
}

/**
 * Dejavu spectrogram-based fallback
 */
async function queryDejavu(filePath) {
  return new Promise(resolve => {
    exec(
      `python3 -
