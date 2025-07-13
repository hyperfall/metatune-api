// utils/fingerprint.js

const { exec } = require("child_process");
const acrcloud = require("acrcloud");
const axios    = require("axios");
const fs       = require("fs");
const path     = require("path");
const normalizeTitle    = require("./normalizeTitle");
const { getOfficialAlbumInfo } = require("./musicbrainzHelper");
const logger   = require("./logger");

const ACR = new acrcloud({
  host:          process.env.ACR_HOST,
  access_key:    process.env.ACR_KEY,
  access_secret: process.env.ACR_SECRET,
});

/**
 * Run fpcalc to extract duration & fingerprint
 */
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
  const kws = ["hits","greatest","now","best","compilation","nrj"];
  return kws.some(k => albumName?.toLowerCase().includes(k));
}

/** AcoustID → MusicBrainz lookup */
async function queryMusicBrainzByFingerprint(fp, prefix) {
  try {
    const resp = await axios.get("https://api.acoustid.org/v2/lookup", {
      params: {
        client:     process.env.ACOUSTID_KEY,
        fingerprint: fp.fingerprint,
        duration:    fp.duration,
        meta:       "recordings+releasegroups+compress"
      }
    });
    const results = resp.data.results || [];
    fs.writeFileSync(path.join("logs", `${prefix}-acoustid.json`), JSON.stringify(results, null,2));

    if (!results.length || !results[0].recordings?.length) return null;
    const top = results[0],
          rec = top.recordings[0],
          grp = rec.releasegroups?.[0];

    return {
      method: "musicbrainz",
      score:  top.score||0,
      recording: {
        mbid:              rec.id,
        title:             rec.title,
        artist:            rec.artists?.map(a=>a.name).join(", "),
        album:             grp?.title    || null,
        date:              grp?.["first-release-date"]?.slice(0,4) || null,
        releaseGroupMbid:  grp?.id       || null,
        genre:             rec.tags?.[0]?.name || null
      }
    };
  } catch (err) {
    logger.error(`[MusicBrainz] ${err.message}`);
    return null;
  }
}

/** ACRCloud lookup (all matches) */
async function queryAcrcloudAll(buffer, prefix) {
  try {
    const result = await ACR.identify(buffer);
    fs.writeFileSync(path.join("logs", `${prefix}-acr.json`), JSON.stringify(result, null,2));
    return (result.metadata?.music||[]).map(m => ({
      method: "acrcloud",
      score:  m.score||0,
      recording: {
        mbid:   m.external_metadata?.musicbrainz?.recording?.id||null,
        title:  m.title,
        artist: m.artists?.map(a=>a.name).join(", "),
        album:  m.album?.name||null,
        date:   m.release_date?.slice(0,4)||null,
        genre:  m.genres?.[0]?.name||null
      }
    }));
  } catch (err) {
    logger.error(`[ACRCloud] ${err.message}`);
    return [];
  }
}

/**
 * Returns ordered fingerprint candidates:
 * 1) ACRCloud (artist‐filtered)
 * 2) AcoustID → MusicBrainz
 * 3) Filename‐based text‐only fallback
 */
async function getFingerprintCandidates(filePath) {
  const fp     = await runFpcalc(filePath);
  const buffer = fs.readFileSync(filePath);
  const prefix = path.basename(filePath, path.extname(filePath));
  const parts  = prefix.split(" - ");
  const normFileArtist = normalizeTitle(parts[0]||"");

  // 1) ACRCloud, filter by filename artist
  const acrRaw = await queryAcrcloudAll(buffer, prefix);
  const acrs   = acrRaw
    .filter(c => {
      if (!normFileArtist) return true;
      const recArtist = normalizeTitle(c.recording.artist);
      const ok = recArtist.includes(normFileArtist);
      if (!ok) logger.warn(`[ACRCloud] Skipping "${c.recording.title}" by "${c.recording.artist}"`);
      return ok;
    })
    .sort((a,b)=>(b.score||0)-(a.score||0));

  const out = acrs.map(c => {
    c.recording.duration = fp.duration;
    // compilation‐style fallback:
    if (isCompilation(c.recording.album)) {
      logger.warn(`[fallback] Compilation detected (“${c.recording.album}”), using metadata fallback…`);
    }
    return clean(c);
  });

  // 2) AcoustID → MusicBrainz
  const acoust = await queryMusicBrainzByFingerprint(fp, prefix);
  if (acoust) {
    acoust.recording.duration = fp.duration;
    out.push(clean(acoust));
  }

  // 3) Filename‐based text‐only fallback
  if (parts.length>=2) {
    const [artistPart,titlePart] = parts;
    try {
      const info = await getOfficialAlbumInfo(artistPart.trim(),titlePart.trim());
      if (info) {
        info.duration = fp.duration;
        out.push({
          method:    "text-only",
          score:     0,
          recording: info
        });
      }
    } catch(e){
      logger.error(`[TextFallback] ${e.message}`);
    }
  }

  return out;
}

/** Only the top candidate */
async function getBestFingerprintMatch(filePath) {
  const cands = await getFingerprintCandidates(filePath);
  return cands[0]||null;
}

/** Normalize title/album strings */
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
