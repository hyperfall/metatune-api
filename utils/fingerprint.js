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

/** Run fpcalc to extract duration & fingerprint */
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

/** Lowercase alphanumeric only */
function normalizeStr(str = "") {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

/** Extract artist/title parts from filename */
function extractFileParts(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const clean = base.replace(/\s+/g, " ").trim();
  const parts = clean.split(/[-–—]/).map(p => normalizeStr(p));
  if (parts.length === 2) {
    return { artist: parts[0], title: parts[1], raw: normalizeStr(base) };
  }
  return { artist: "", title: "", raw: normalizeStr(base) };
}

/** Fuzzy-match: exact=1, contains=0.7, else 0 */
function fuzzyScore(a = "", b = "") {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.7;
  return 0;
}

/** Heuristic for “compilation”‐style album names */
function isCompilation(albumName) {
  const keywords = ["hits", "greatest", "now", "best", "compilation", "nrj"];
  return keywords.some(k => albumName?.toLowerCase().includes(k));
}

/** Properly‐quoted text search on MusicBrainz if album looks like a compilation */
async function queryMusicBrainzFallback(artist, title, prefix) {
  try {
    // quote both fields
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

/** Fingerprint lookup via AcoustID → MusicBrainz */
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
    if (!results.length) return null;

    const top = results[0];
    if (!top.recordings?.length) return null;

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
        date: grp?.["first-release-date"]?.slice(0,4) || null,
        releaseGroupMbid: grp?.id,
        genre: rec.tags?.[0]?.name || null
      }
    };
  } catch (err) {
    logger.error(`[MusicBrainz] ${err.message}`);
    return null;
  }
}

/** Pull **all** ACRCloud hits (unsorted) */
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
        date: m.release_date?.slice(0,4) || null,
        genre: m.genres?.[0]?.name || null
      }
    }));
  } catch (err) {
    logger.error(`[ACRCloud] ${err.message}`);
    return [];
  }
}

/**
 * Returns a prioritized list of fingerprint candidates:
 * 1) ACRCloud hits **only** if they both
 *      • are super-high confidence (≥95) **and**  
 *      • their artist/title fuzzily match your filename,  
 *    or if your filename literally contains artist+title.
 *    (with a compilation fallback to MusicBrainz text‐search)
 * 2) One final AcoustID→MusicBrainz fallback
 */
async function getFingerprintCandidates(filePath) {
  const fp     = await runFpcalc(filePath);
  const buffer = fs.readFileSync(filePath);
  const prefix = path.basename(filePath, path.extname(filePath));
  const parts  = extractFileParts(filePath);
  const baseRaw= parts.raw;

  // 1) ACRCloud candidates
  const acrs = await queryAcrcloudAll(buffer, prefix);
  acrs.sort((a,b) => (b.score||0) - (a.score||0));

  const out = [];
  for (const c of acrs) {
    c.recording.duration = fp.duration;

    const artistNorm = normalizeStr(c.recording.artist);
    const titleNorm  = normalizeStr(c.recording.title);
    const candRaw    = artistNorm + titleNorm;

    // fuzzy-match against filename parts
    const titleMatch  = fuzzyScore(parts.title, titleNorm);
    const artistMatch = fuzzyScore(parts.artist, artistNorm);

    const acceptAcr = c.score >= 95 && (titleMatch > 0 || artistMatch > 0);
    const acceptRaw = baseRaw.includes(candRaw);

    if (acceptAcr || acceptRaw) {
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
    } else {
      logger.warn(
        `[filename mismatch] skipping ACRCloud candidate “${c.recording.artist} – ${c.recording.title}”`
      );
    }
  }

  // 2) always append one AcoustID→MusicBrainz fallback
  const alt = await queryMusicBrainzByFingerprint(fp, prefix);
  if (alt) {
    alt.recording.duration = fp.duration;
    out.push(clean(alt));
  }

  return out;
}

/** Legacy: only return the top candidate */
async function getBestFingerprintMatch(filePath) {
  const cands = await getFingerprintCandidates(filePath);
  return cands[0] || null;
}

/** Normalize text fields consistently */
function clean(match) {
  const r = match.recording;
  r.title = normalizeTitle(r.title);
  r.album = normalizeTitle(r.album);
  return match;
}

module.exports = {
  getFingerprintCandidates,
  getBestFingerprintMatch
};
