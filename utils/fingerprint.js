// utils/fingerprint.js

const { exec } = require("child_process");
const acrcloud = require("acrcloud");
const axios = require("axios");
const normalizeTitle = require("./normalizeTitle");
const logger = require("./logger");
const fs = require("fs");
const path = require("path");
const { getOfficialAlbumInfo } = require("./musicbrainzHelper");

const ACR = new acrcloud({
  host: process.env.ACR_HOST,
  access_key: process.env.ACR_KEY,
  access_secret: process.env.ACR_SECRET,
});

// how many hits to pull
const ACR_MAX = parseInt(process.env.ACR_MAX_RESULTS, 10) || 5;
const ACOUSTID_MAX = parseInt(process.env.ACOUSTID_MAX_RESULTS, 10) || 5;


/** Run fpcalc to extract duration & fingerprint */
function runFpcalc(filePath) {
  return new Promise((resolve, reject) => {
    exec(`fpcalc -json "${filePath}"`, { maxBuffer: 1024 * 2000 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(e); }
    });
  });
}

/** Heuristic for “compilation”-style album names */
function isCompilation(albumName) {
  const keywords = ["hits","greatest","now","best","compilation","nrj"];
  return keywords.some(k => albumName?.toLowerCase().includes(k));
}

/**
 * Primary ACRCloud lookup returning up to ACR_MAX_RESULTS hits
 */
async function queryAcrcloudAll(buffer, prefix) {
  try {
    const result = await ACR.identify(buffer);
    fs.writeFileSync(path.join("logs", `${prefix}-acr.json`),
                     JSON.stringify(result, null, 2));

    const list = (result.metadata?.music || [])
      .slice(0, ACR_MAX);

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
 * Fingerprint lookup via AcoustID → MusicBrainz
 * Returns up to ACOUSTID_MAX_RESULTS candidates
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

    const out = [];
    for (const top of results.slice(0, ACOUSTID_MAX)) {
      const score = top.score || 0;
      for (const rec of top.recordings || []) {
        const grp = (rec.releasegroups || [])[0] || {};
        out.push({
          method: "musicbrainz",
          score,
          recording: {
            mbid: rec.id,
            title: rec.title,
            artist: rec.artists?.map(a => a.name).join(", "),
            album: grp.title || null,
            date: grp["first-release-date"]?.slice(0,4) || null,
            releaseGroupMbid: grp.id,
            genre: rec.tags?.[0]?.name || null
          }
        });
      }
    }
    return out;
  } catch (err) {
    logger.error(`[MusicBrainz] ${err.message}`);
    return [];
  }
}

/**
 * Dejavu spectrogram‐based fallback via your Python wrapper
 */
async function queryDejavu(filePath) {
  return new Promise(resolve => {
    const cmd = `python3 /app/dejavu_cli.py recognize "${filePath}" --format json`;
    exec(cmd, { maxBuffer: 1024 * 2000 }, (err, stdout, stderr) => {
      if (err) {
        logger.warn(
          `[Dejavu] Command failed:\n  ${cmd}\n  ${stderr||err.message}`
        );
        return resolve(null);
      }
      try {
        const r = JSON.parse(stdout);
        if (r.error) {
          logger.warn(`[Dejavu] wrapper error: ${r.error}`);
          return resolve(null);
        }
        if (!r.song) return resolve(null);
        const s = r.song;
        return resolve({
          method: "dejavu",
          score: 90,
          recording: {
            mbid: s.id||null,
            title: s.title,
            artist: s.artist,
            album: s.album,
            date: s.year,
            releaseGroupMbid: null,
            genre: null
          }
        });
      } catch (e) {
        logger.warn(`[Dejavu] JSON parse error: ${e.message}`);
        return resolve(null);
      }
    });
  });
}

/**
 * Returns ordered fingerprint candidates:
 * 1) ACRCloud hits
 * 2) AcoustID→MusicBrainz hits
 * 3) Dejavu
 * 4) Text-only filename fallback
 */
async function getFingerprintCandidates(filePath) {
  const fp    = await runFpcalc(filePath);
  const buf   = fs.readFileSync(filePath);
  const prefix= path.basename(filePath, path.extname(filePath));
  const parts = prefix.split(" - ");
  const fileArtist = (parts[0]||"").trim();
  const normFileArtist = normalizeTitle(fileArtist);

  // 1) ACR
  let acrs = await queryAcrcloudAll(buf, prefix);
  acrs = acrs
    .filter(c => {
      if (!normFileArtist) return true;
      const ok = normalizeTitle(c.recording.artist).includes(normFileArtist);
      if (!ok) logger.warn(
        `[ACRCloud] Skipping "${c.recording.title}" by "${c.recording.artist}" — artist mismatch`
      );
      return ok;
    })
    .sort((a,b)=> (b.score||0)-(a.score||0));

  const out = [];
  for(const c of acrs) {
    c.recording.duration = fp.duration;
    if (isCompilation(c.recording.album)) {
      logger.warn(`[fallback] Compilation detected (“${c.recording.album}”), using MB fallback…`);
      const fb = await queryMusicBrainzFallback(
        c.recording.artist, c.recording.title
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
  const mbcands = await queryMusicBrainzByFingerprint(fp, prefix);
  for (const c of mbcands) {
    c.recording.duration = fp.duration;
    out.push(clean(c));
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
  if (parts.length>=2) {
    const [a,t] = parts;
    try {
      const info = await getOfficialAlbumInfo(a.trim(), t.trim());
      if (info) {
        const fb = { method:"text-only", score:0, recording:info };
        fb.recording.duration = fp.duration;
        out.push(clean(fb));
      }
    } catch(err){
      logger.error(`[TextFallback] ${err.message}`);
    }
  }

  return out;
}

/** Return only the top-scoring candidate */
async function getBestFingerprintMatch(filePath) {
  const c = await getFingerprintCandidates(filePath);
  return c[0]||null;
}

/** Normalize recording fields */
function clean(m) {
  m.recording.title = normalizeTitle(m.recording.title);
  m.recording.album = normalizeTitle(m.recording.album);
  return m;
}

module.exports = {
  getFingerprintCandidates,
  getBestFingerprintMatch
};
