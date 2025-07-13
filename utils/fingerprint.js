// utils/fingerprint.js

const { exec } = require("child_process");
const acrcloud = require("acrcloud");
const axios = require("axios");
const normalizeTitle = require("./normalizeTitle");
const logger = require("./logger");
const fs = require("fs");
const path = require("path");
const { getOfficialAlbumInfo } = require("./musicbrainzHelper");

// stub—wire this up to your audfprint precomputed DB
function getMetadataBySongId(songid) {
  // TODO: return an object { mbid, title, artist, album, year }
  // for example, load from a JSON or database:
  // return audfprintMap[songid];
  return null;
}

const ACR = new acrcloud({
  host: process.env.ACR_HOST,
  access_key: process.env.ACR_KEY,
  access_secret: process.env.ACR_SECRET,
});

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

/** MusicBrainz fallback for compilations */
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
    fs.writeFileSync(path.join("logs", `${prefix}-acoustid.json`),
                     JSON.stringify(results, null, 2));
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
        artist: rec.artists?.map(a=>a.name).join(", "),
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

/** Primary ACRCloud lookup */
async function queryAcrcloudAll(buffer, prefix) {
  try {
    const result = await ACR.identify(buffer);
    fs.writeFileSync(path.join("logs", `${prefix}-acr.json`),
                     JSON.stringify(result, null, 2));
    return (result.metadata?.music || []).map(m => ({
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

/** Audfprint fallback via Python wrapper */
async function queryAudfprint(filePath) {
  return new Promise(resolve => {
    const cmd = `python3 /app/audfprint_cli.py "${filePath}"`;
    exec(cmd, { maxBuffer: 1024 * 2000 }, (err, stdout, stderr) => {
      if (err) {
        logger.warn(`[audfprint] command failed:\n${stderr||err.message}`);
        return resolve(null);
      }
      let r;
      try { r = JSON.parse(stdout); }
      catch (e) {
        logger.warn(`[audfprint] parse error: ${e.message}`);
        return resolve(null);
      }
      if (!r.songid) return resolve(null);
      const meta = getMetadataBySongId(r.songid);
      if (!meta) {
        logger.warn(`[audfprint] no metadata for id=${r.songid}`);
        return resolve(null);
      }
      return resolve({
        method: "audfprint",
        score: r.score,
        recording: {
          mbid: meta.mbid,
          title: meta.title,
          artist: meta.artist,
          album: meta.album,
          date: meta.year
        }
      });
    });
  });
}

/**
 * Returns ordered fingerprint candidates:
 * 1) ACRCloud
 * 2) AcoustID→MusicBrainz
 * 3) Audfprint
 * 4) Filename‐based text‐only
 */
async function getFingerprintCandidates(filePath) {
  const fp     = await runFpcalc(filePath);
  const buffer = fs.readFileSync(filePath);
  const prefix = path.basename(filePath, path.extname(filePath));

  // filename‐artist extraction
  const parts = prefix.split(" - ");
  const fileArtist = (parts[0]||"").trim();
  const normFileArtist = normalizeTitle(fileArtist);

  // 1) ACRCloud (filter mismatches)
  const acrRaw = await queryAcrcloudAll(buffer, prefix);
  const acrs   = acrRaw
    .filter(c => {
      if (!normFileArtist) return true;
      const ok = normalizeTitle(c.recording.artist).includes(normFileArtist);
      if (!ok) logger.warn(`[ACRCloud] Skipping ${c.recording.title} by ${c.recording.artist}`);
      return ok;
    })
    .sort((a,b)=>(b.score||0)-(a.score||0));

  const out = [];
  for (const c of acrs) {
    c.recording.duration = fp.duration;
    if (isCompilation(c.recording.album)) {
      logger.warn(`[fallback] compilation→MB fallback`);
      const fb = await queryMusicBrainzFallback(c.recording.artist,c.recording.title);
      if (fb) { fb.recording.duration = fp.duration; out.push(clean(fb)); continue; }
    }
    out.push(clean(c));
  }

  // 2) AcoustID→MusicBrainz
  const alt = await queryMusicBrainzByFingerprint(fp,prefix);
  if (alt) { alt.recording.duration=fp.duration; out.push(clean(alt)); }

  // 3) Audfprint
  try {
    const af = await queryAudfprint(filePath);
    if (af) { af.recording.duration=fp.duration; out.push(clean(af)); }
  } catch(e){
    logger.warn(`[audfprint] unexpected: ${e.message}`);
  }

  // 4) text‐only from filename
  if (parts.length>=2) {
    const [artistPart,titlePart]=parts;
    try {
      const info = await getOfficialAlbumInfo(artistPart.trim(),titlePart.trim());
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

/** Return the single best match */
async function getBestFingerprintMatch(filePath) {
  const c = await getFingerprintCandidates(filePath);
  return c[0]||null;
}

/** Normalize title/album */
function clean(match) {
  match.recording.title = normalizeTitle(match.recording.title);
  match.recording.album = normalizeTitle(match.recording.album);
  return match;
}

module.exports = {
  getFingerprintCandidates,
  getBestFingerprintMatch
};
