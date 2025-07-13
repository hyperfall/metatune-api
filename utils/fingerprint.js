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
/**
 * Dejavu spectrogram-based fallback
 */
async function queryDejavu(filePath) {
  return new Promise(resolve => {
    exec(
      `python3 -m dejavu recognize "${filePath}" --format json`,
      { maxBuffer: 1024 * 2000 },
      (err, stdout, stderr) => {
        if (err) {
          logger.warn(
            `[Dejavu] Command failed: python3 -m dejavu recognize "${filePath}" --format json\n${stderr || err.message}`
          );
          return resolve(null);
        }
        try {
          const r = JSON.parse(stdout);
          if (!r?.song) return resolve(null);
          const song = r.song;
          return resolve({
            method: "dejavu",
            score: 90,
            recording: {
              mbid: song.mbid || null,
              title: song.title,
              artist: song.artist,
              album: song.album,
              date: song.year,
              releaseGroupMbid: null,
              genre: null
            }
          });
        } catch (e) {
          logger.warn(`[Dejavu] Parse error: ${e.message}`);
          return resolve(null);
        }
      }
    );
  });
}


/**
 * Returns ordered fingerprint candidates:
 * 1) ACRCloud hits (with compilation→fallback)
 * 2) AcoustID→MusicBrainz lookup
 * 3) Dejavu
 * 4) Pure text-only MusicBrainz lookup based on filename (Artist - Title)
 */
async function getFingerprintCandidates(filePath) {
  const fp = await runFpcalc(filePath);
  const buffer = fs.readFileSync(filePath);
  const prefix = path.basename(filePath, path.extname(filePath));

  // 1) ACRCloud
  const acrs = await queryAcrcloudAll(buffer, prefix);
  acrs.sort((a, b) => (b.score || 0) - (a.score || 0));
  const out = [];
  for (const c of acrs) {
    c.recording.duration = fp.duration;
    if (isCompilation(c.recording.album)) {
      logger.warn(
        `[fallback] Compilation detected (“${c.recording.album}”), using MB fallback…`
      );
      const fb = await queryMusicBrainzFallback(
        c.recording.artist,
        c.recording.title
      );
      if (fb) {
        fb.recording.duration = fp.duration;
        out.push(clean(fb));
        continue;
      }
    }
    out.push(clean(c));
  }

  // 2) AcoustID→MusicBrainz
  const alt = await queryMusicBrainzByFingerprint(fp, prefix);
  if (alt) {
    alt.recording.duration = fp.duration;
    out.push(clean(alt));
  }

  // 3) Dejavu
  try {
    const dj = await queryDejavu(filePath);
    if (dj) {
      dj.recording.duration = fp.duration;
      out.push(clean(dj));
    }
  } catch (e) {
    logger.warn(`[Dejavu] Unexpected error: ${e.message}`);
  }

  // 4) Filename-based text-only fallback
  const parts = prefix.split(" - ");
  if (parts.length >= 2) {
    const [fileArtist, fileTitle] = parts;
    try {
      const info = await getOfficialAlbumInfo(
        fileArtist.trim(),
        fileTitle.trim()
      );
      if (info) {
        const fb = { method: "text-only", score: 0, recording: info };
        fb.recording.duration = fp.duration;
        out.push(clean(fb));
      }
    } catch (err) {
      logger.error(`[TextFallback] ${err.message}`);
    }
  }

  return out;
}

/** Legacy: return only the top-scoring candidate */
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
