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

// You can adjust this floor to include more or fewer ACRCloud results
const MIN_ACR_SCORE = 60;

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

function clean(match) {
  // Normalize text fields
  if (match.recording) {
    match.recording.title = normalizeTitle(match.recording.title);
    match.recording.album = normalizeTitle(match.recording.album);
  }
  return match;
}

function isCompilation(albumName = "") {
  const keywords = ["hits", "greatest", "now", "best", "compilation", "nrj"];
  return keywords.some(k => albumName.toLowerCase().includes(k));
}

async function queryMusicBrainzFallback(artist, title, prefix) {
  try {
    const q = `recording:"${title}" AND artist:"${artist}"`;
    const resp = await axios.get("https://musicbrainz.org/ws/2/recording", {
      params: { query: q, fmt: "json", limit: 5 },
      headers: { "User-Agent": "MetaTune/1.0 (metatune@app)" }
    });
    const recs = resp.data.recordings || [];
    const rec  = recs.find(r => r.releases?.length) || recs[0];
    if (!rec) return null;

    const release = rec.releases[0];
    return {
      method: "musicbrainz-fallback",
      score: 100,
      recording: {
        mbid: rec.id,
        title: normalizeTitle(rec.title),
        artist: rec["artist-credit"]?.map(a => a.name).join(", "),
        album: normalizeTitle(release.title),
        date: release.date?.slice(0,4) || "",
        releaseGroupMbid: release["release-group"]?.id,
        genre: null
      }
    };
  } catch (err) {
    logger.error(`[MB Fallback] ${err.message}`);
    return null;
  }
}

async function queryMusicBrainzByFingerprint(fp, prefix) {
  try {
    const resp = await axios.get("https://api.acoustid.org/v2/lookup", {
      params: {
        client: process.env.ACOUSTID_KEY,
        fingerprint: fp.fingerprint,
        duration:    fp.duration,
        meta:        "recordings+releasegroups+compress"
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
        album: grp?.title || "",
        date: grp?.["first-release-date"]?.slice(0,4) || "",
        releaseGroupMbid: grp?.id,
        genre: rec.tags?.[0]?.name || null
      }
    };
  } catch (err) {
    logger.error(`[MusicBrainz] ${err.message}`);
    return null;
  }
}

async function queryAcrcloudAll(buffer, prefix) {
  try {
    const result = await ACR.identify(buffer);
    fs.writeFileSync(
      path.join("logs", `${prefix}-acr.json`),
      JSON.stringify(result, null, 2)
    );
    return (result.metadata?.music || []).map(m => ({
      method: "acrcloud",
      score: m.score || 0,
      recording: {
        mbid: m.external_metadata?.musicbrainz?.recording?.id || null,
        title: m.title,
        artist: m.artists?.map(a => a.name).join(", "),
        album: m.album?.name || "",
        date: m.release_date?.slice(0,4) || "",
        genre: m.genres?.[0]?.name || null
      }
    }));
  } catch (err) {
    logger.error(`[ACRCloud] ${err.message}`);
    return [];
  }
}

/**
 * Returns a list of fingerprint candidates, in priority order:
 * 1) All ACRCloud hits ≥ MIN_ACR_SCORE
 *    • if any looks like a compilation, we immediately try MusicBrainz text fallback
 * 2) One final AcoustID→MusicBrainz fallback
 */
async function getFingerprintCandidates(filePath) {
  const fp     = await runFpcalc(filePath);
  const buffer = fs.readFileSync(filePath);
  const prefix = path.basename(filePath, path.extname(filePath));

  // 1) ACRCloud
  let acrs = await queryAcrcloudAll(buffer, prefix);
  acrs = acrs
    .filter(c => c.score >= MIN_ACR_SCORE)
    .sort((a,b) => b.score - a.score);

  const out = [];
  for (const c of acrs) {
    c.recording.duration = fp.duration;
    if (isCompilation(c.recording.album)) {
      logger.warn(`[fallback] Compilation detected (“${c.recording.album}”), text‐search…`);
      const fb = await queryMusicBrainzFallback(
        c.recording.artist,
        c.recording.title,
        prefix
      );
      if (fb) {
        fb.recording.duration = fp.duration;
        out.push(clean(fb));
        continue;
      }
    }
    out.push(clean(c));
  }

  // 2) AcoustID→MusicBrainz fallback
  const alt = await queryMusicBrainzByFingerprint(fp, prefix);
  if (alt) {
    alt.recording.duration = fp.duration;
    out.push(clean(alt));
  }

  return out;
}

async function getBestFingerprintMatch(filePath) {
  const cands = await getFingerprintCandidates(filePath);
  return cands[0] || null;
}

module.exports = {
  getFingerprintCandidates,
  getBestFingerprintMatch
};
