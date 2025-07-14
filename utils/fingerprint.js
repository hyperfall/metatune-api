// utils/fingerprint.js

const { exec } = require("child_process");
const acrcloud = require("acrcloud");
const axios = require("axios");
const normalizeTitle = require("./normalizeTitle");
const logger = require("./logger");
const fs = require("fs");
const path = require("path");
const { stripNoise, similarity } = require("./fuzzy");
const { getOfficialAlbumInfo } = require("./musicbrainzHelper");
const { extractOriginalMetadata } = require("./metadataExtractor");

// ACRCloud client
const ACR = new acrcloud({
  host: process.env.ACR_HOST,
  access_key: process.env.ACR_KEY,
  access_secret: process.env.ACR_SECRET,
});

// how many hits to pull
const ACR_MAX = parseInt(process.env.ACR_MAX_RESULTS, 10) || 5;
const ACOUSTID_MAX = parseInt(process.env.ACOUSTID_MAX_RESULTS, 10) || 5;
// minimum similarity between file-artist & candidate-artist (0–1)
const ARTIST_SIM_THRESHOLD = parseFloat(process.env.ARTIST_SIM_THRESHOLD) || 0.5;

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

/** Heuristic for “compilation” albums */
function isCompilation(albumName) {
  const keywords = ["hits","greatest","now","best","compilation","nrj"];
  return keywords.some(k => albumName?.toLowerCase().includes(k));
}

/** Primary ACRCloud lookup */
async function queryAcrcloudAll(buffer, prefix) {
  try {
    const result = await ACR.identify(buffer);
    fs.writeFileSync(
      path.join("logs", `${prefix}-acr.json`),
      JSON.stringify(result, null, 2)
    );
    return (result.metadata?.music || [])
      .slice(0, ACR_MAX)
      .map(m => ({
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

/** AcoustID → MusicBrainz lookup */
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

/** Returns ordered fingerprint candidates */
async function getFingerprintCandidates(filePath) {
  // 0) fingerprint & buffer
  const fp     = await runFpcalc(filePath);
  const buffer = fs.readFileSync(filePath);
  const prefix = path.basename(filePath, path.extname(filePath));

  // 1) read original tags
  const original = await extractOriginalMetadata(filePath);
  // pick tag‐artist if present, else filename before the dash
  const parts          = prefix.split(" - ");
  const sourceArtist   = original.artist || parts[0] || "";
  const cleanArtist    = stripNoise(sourceArtist).toLowerCase();
  const normFileArtist = normalizeTitle(cleanArtist);

  const out = [];

  // 2) ACRCloud hits (filter by artist match only if we actually have a normFileArtist)
  let acrs = await queryAcrcloudAll(buffer, prefix);
  if (normFileArtist) {
    acrs = acrs.filter(c => {
      const recArtistNorm = normalizeTitle(stripNoise(c.recording.artist));
      const sim = similarity(recArtistNorm, normFileArtist);
      const ok  = sim >= ARTIST_SIM_THRESHOLD;
      if (!ok) {
        logger.warn(
          `[ACRCloud] Skipping "${c.recording.title}" by "${c.recording.artist}" — artist mismatch (sim=${sim.toFixed(2)})`
        );
      }
      return ok;
    });
  }
  acrs.sort((a,b)=> (b.score||0) - (a.score||0));

  for (const c of acrs) {
    c.recording.duration = fp.duration;
    // compilations fallback
    if (isCompilation(c.recording.album)) {
      logger.warn(`[fallback] compilation "${c.recording.album}", trying MB fallback…`);
      const fb = await getOfficialAlbumInfo(c.recording.artist, c.recording.title);
      if (fb) {
        out.push({
          method: "musicbrainz-fallback",
          score: 100,
          recording: { ...fb, duration: fp.duration }
        });
        continue;
      }
    }
    out.push(cleanRecording(c));
  }

  // 3) AcoustID → MusicBrainz
  const mbcands = await queryMusicBrainzByFingerprint(fp, prefix);
  for (const c of mbcands) {
    c.recording.duration = fp.duration;
    out.push(cleanRecording(c));
  }

  // 4) Filename‐only text fallback
  if (out.length === 0 && parts.length >= 2) {
    const [artistPart, titlePart] = parts;
    try {
      const info = await getOfficialAlbumInfo(artistPart.trim(), titlePart.trim());
      if (info) {
        out.push({
          method: "text-only",
          score: 0,
          recording: { ...info, duration: fp.duration }
        });
      }
    } catch (err) {
      logger.error(`[TextFallback] ${err.message}`);
    }
  }

  // 5) Guarantee at least one candidate
  if (out.length === 0) {
    const raw = prefix;
    const [artistRaw, titleRaw] = parts.length >= 2 ? parts : ["", raw];
    out.push({
      method: "filename-only",
      score: 0,
      recording: {
        artist: normalizeTitle(stripNoise(artistRaw)),
        title: normalizeTitle(stripNoise(titleRaw)),
        album: "",
        date: "",
        genre: "",
        duration: fp.duration
      }
    });
  }

  return out;
}

/** Only the top candidate */
async function getBestFingerprintMatch(filePath) {
  const cands = await getFingerprintCandidates(filePath);
  return cands[0] || null;
}

/** Clean & normalize one match */
function cleanRecording(match) {
  match.recording.title = normalizeTitle(match.recording.title);
  match.recording.album = normalizeTitle(match.recording.album);
  return match;
}

module.exports = {
  getFingerprintCandidates,
  getBestFingerprintMatch
};
