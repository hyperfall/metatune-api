// utils/fingerprint.js

const { exec } = require("child_process");
const acrcloud = require("acrcloud");
const axios = require("axios");
const normalizeTitle = require("./normalizeTitle");
const logger = require("./logger");
const fs = require("fs");
const path = require("path");

// NEW imports for text-search fallback
const { extractOriginalMetadata } = require("./metadataExtractor");
const { searchRecording } = require("./musicbrainzHelper");

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

/** Strip to lowercase alphanumeric only */
function normalizeStr(str = "") {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

/** Extract and normalize bare filename (no extension) */
function extractNormalizedFilename(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return normalizeStr(base);
}

/** Heuristic for “compilation”-style album names */
function isCompilation(albumName) {
  const keywords = ["hits", "greatest", "now", "best", "compilation", "nrj"];
  return keywords.some(k => albumName?.toLowerCase().includes(k));
}

/** Fallback: text search on MusicBrainz if album looks like a compilation */
async function queryMusicBrainzFallback(artist, title, prefix) {
  try {
    const resp = await axios.get("https://musicbrainz.org/ws/2/recording", {
      params: { query: `${title} AND artist:${artist}`, fmt: "json", limit: 5 },
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
        duration: fp.duration,
        meta: "recordings+releasegroups+compress"
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

/** Primary ACRCloud lookup returning *all* hits */
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
 * Returns an ordered list of fingerprint candidates:
 *  1) ACRCloud hits (with compilation → MusicBrainz‐fallback)
 *  2) One final AcoustID→MusicBrainz fallback
 *  3) **NEW** MusicBrainz text‐search fallback using your original tags
 */
async function getFingerprintCandidates(filePath) {
  const fp       = await runFpcalc(filePath);
  const buffer   = fs.readFileSync(filePath);
  const prefix   = path.basename(filePath, path.extname(filePath));
  const baseNorm = extractNormalizedFilename(filePath);

  // grab your embedded/file metadata for text‐search fallback
  const original = await extractOriginalMetadata(filePath);

  // 1) ACRCloud candidates
  const acrs = await queryAcrcloudAll(buffer, prefix);
  acrs.sort((a, b) => (b.score || 0) - (a.score || 0));

  const out = [];
  for (const c of acrs) {
    c.recording.duration = fp.duration;

    const artistNorm = normalizeStr(c.recording.artist);
    const titleNorm  = normalizeStr(c.recording.title);
    const candNorm   = artistNorm + titleNorm;

    if (c.score >= 95 || baseNorm.includes(candNorm)) {
      if (isCompilation(c.recording.album)) {
        logger.warn(
          `[fallback] Compilation detected (“${c.recording.album}”), text-search…`
        );
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

  // 2) AcoustID → MusicBrainz fallback
  const alt = await queryMusicBrainzByFingerprint(fp, prefix);
  if (alt) {
    alt.recording.duration = fp.duration;
    out.push(clean(alt));
  }

  // 3) Text‐search fallback (using original tags/filename)
  if (original.artist && original.title) {
    const recs = await searchRecording(
      original.artist,
      original.title,
      original.year
    );
    if (recs.length) {
      const rec = recs[0];
      const release = rec.releases?.[0] || {};
      out.push(clean({
        method: "text-search",
        score: 80,  // boost so it will compete
        recording: {
          mbid: rec.id,
          title: rec.title,
          artist: rec["artist-credit"]?.map(a => a.name).join(", "),
          album: release.title || "",
          date: release.date?.slice(0,4) || original.year,
          genre: null,
          duration: fp.duration
        }
      }));
    }
  }

  return out;
}

/** Legacy: only return the top candidate */
async function getBestFingerprintMatch(filePath) {
  const cands = await getFingerprintCandidates(filePath);
  return cands[0] || null;
}

/** Normalize recording text fields */
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
