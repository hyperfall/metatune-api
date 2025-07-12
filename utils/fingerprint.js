// utils/fingerprint.js
const { exec } = require("child_process");
const acrcloud = require("acrcloud");
const axios = require("axios");
const normalizeTitle = require("./normalizeTitle");
const logger = require("./logger");
const fs = require("fs");
const path = require("path");
const {
  searchRecording,
  findBestRelease,
  fetchCoverArt
} = require("./musicbrainzHelper");

const ACR = new acrcloud({
  host: process.env.ACR_HOST,
  access_key: process.env.ACR_KEY,
  access_secret: process.env.ACR_SECRET,
});

// minimum ACRCloud score to even consider a hit
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

// simple text‐cleanup of match objects
function clean(match) {
  const r = match.recording;
  r.title = normalizeTitle(r.title);
  r.album = normalizeTitle(r.album);
  return match;
}

function isCompilation(albumName = "") {
  const kws = ["hits", "greatest", "now", "best", "compilation", "nrj"];
  return kws.some(k => albumName.toLowerCase().includes(k));
}

/**
 * Replace the old rec.releases[0] logic with a true "best album" pick.
 */
async function queryMusicBrainzFallback(artist, title, prefix) {
  try {
    // use our helper searchRecording
    const recs = await searchRecording(artist, title);
    if (!recs.length) return null;
    const rec = recs[0];

    // pick the best non-compilation studio album
    const release = findBestRelease(rec);
    if (!release) return null;

    // fetch the correct cover art
    const coverUrl = await fetchCoverArt(
      release.id,
      release["release-group"]?.id
    );

    return {
      method: "musicbrainz-fallback",
      score: 100,
      recording: {
        mbid: rec.id,
        title: rec.title,
        artist: rec["artist-credit"]?.map(a => a.name).join(", "),
        album: release.title,
        date: release.date?.slice(0,4) || "",
        releaseGroupMbid: release["release-group"]?.id,
        genre: null,
        duration: null  // will be attached by caller
      },
      coverUrl
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
        client:      process.env.ACOUSTID_KEY,
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
        mbid:   m.external_metadata?.musicbrainz?.recording?.id || null,
        title:  m.title,
        artist: m.artists?.map(a => a.name).join(", "),
        album:  m.album?.name || "",
        date:   m.release_date?.slice(0,4) || "",
        genre:  m.genres?.[0]?.name || null
      }
    }));
  } catch (err) {
    logger.error(`[ACRCloud] ${err.message}`);
    return [];
  }
}

/**
 * Build a list of candidates:
 * 1) All ACRCloud hits ≥ MIN_ACR_SCORE (with compilation→MB fallback)
 * 2) A single AcoustID→MusicBrainz fallback
 * 3) If still empty, a final filename‐based MusicBrainz search
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
      logger.warn(`[fallback] Compilation (“${c.recording.album}”), text-search…`);
      const fb = await queryMusicBrainzFallback(
        c.recording.artist,
        c.recording.title,
        prefix
      );
      if (fb) {
        fb.recording.duration = fp.duration;
        fb.coverUrl && (fb.recording.coverUrl = fb.coverUrl);
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

  // 3) Filename‐fallback if still empty
  if (!out.length) {
    const base = path.basename(filePath, path.extname(filePath));
    const [artistPart, titlePart] = base.split(/\s*[-–—]\s*/);
    if (artistPart && titlePart) {
      const recs = await searchRecording(artistPart.trim(), titlePart.trim());
      if (recs.length) {
        const rec     = recs[0];
        const release = findBestRelease(rec);
        const artUrl  = await fetchCoverArt(
          release.id,
          release["release-group"]?.id
        );
        const fb = {
          method: "filename-fallback",
          score: 80,
          recording: {
            mbid: rec.id,
            title: rec.title,
            artist: rec["artist-credit"]?.map(a => a.name).join(", "),
            album: release.title,
            date: release.date?.slice(0,4) || "",
            releaseGroupMbid: release["release-group"]?.id,
            genre: null,
            duration: fp.duration,
            coverUrl: artUrl
          }
        };
        out.push(clean(fb));
      }
    }
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
