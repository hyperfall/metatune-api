// controllers/tagController.js

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const fetch = require("../utils/fetch");
const logger = require("../utils/logger");
const {
  getFingerprintCandidates
} = require("../utils/fingerprint");                // updated
const { extractOriginalMetadata } = require("../utils/metadataExtractor");
const { scoreFusionMatch } = require("../utils/fusionScorer");
const { cleanupFiles } = require("../utils/cleanupUploads");
const { logToDB } = require("../utils/db");
const { zipFiles } = require("../utils/zipFiles");
const {
  getOfficialAlbumInfo,
  getCoverArtByMetadata
} = require("../utils/musicbrainzHelper");
const normalizeTitle = require("../utils/normalizeTitle");

// simple wrapper to exec ffmpeg
function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 2000 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || stdout);
      resolve(stdout.trim());
    });
  });
}

function sanitize(str) {
  return str ? str.replace(/[\\/:*?"<>|]/g, "_").trim() : "Unknown";
}

async function handleTagging(filePath) {
  if (!fs.existsSync(filePath)) {
    logger.error(`❌ File not found: ${filePath}`);
    return { success: false, message: "Uploaded file missing." };
  }

  const ext           = path.extname(filePath) || ".mp3";
  const dir           = path.dirname(filePath);
  const base          = path.basename(filePath, ext);
  const debugPath     = path.join("cache", `${base}.json`);
  const publicLogPath = path.join("logs", `${base}-match-log.json`);

  logger.log(`🔍 [START] ${filePath}`);

  // 1) Extract original tags & fingerprint candidates
  const original = await extractOriginalMetadata(filePath);
  logger.log("📂 Original metadata:", original);

  const candidates = await getFingerprintCandidates(filePath);
  if (!candidates.length) {
    logger.warn("⚠️ No fingerprint candidates");
    return { success: false, message: "No match found." };
  }

  let chosen = null, fusion = null;
  // 2) Iterate candidates, run fusion score, pick first strong match
  for (const cand of candidates) {
    const { method, score, recording } = cand;
    const rawTitle  = recording.title  || base;
    const rawArtist = recording.artist || "Unknown Artist";

    const title  = sanitize(normalizeTitle(rawTitle));
    const artist = sanitize(normalizeTitle(rawArtist));

    // lookup album by MBID or text
    const lookupYear = original.year || recording.date || "";
    const albumData  = await getOfficialAlbumInfo(artist, title, lookupYear, recording.mbid);
    const album      = sanitize(normalizeTitle(albumData?.album || recording.album || original.album || "Unknown Album"));
    const year       = albumData?.year || recording.date || original.year || "2023";
    const genre      = recording.genre || original.genre || "";

    const finalMetadata = { title, artist, album, year, genre, score, source: method };

    fusion = scoreFusionMatch(filePath, finalMetadata, original);
    logger.log(`📊 Candidate [${method}] fingerprint:${score} → fusion ${fusion.score} (${fusion.confidence})`);
    logger.log("🔬 Fusion debug:", fusion.debug);

    // require at least medium confidence
    if (fusion.score >= 0.6) {
      chosen = { cand, finalMetadata, fusion, albumData };
      break;
    }
  }

  // 3) if no medium match, accept the best-highest fusion if above 0.5
  if (!chosen) {
    const best = candidates
      .map(c => {
        const rawTitle  = c.recording.title;
        const rawArtist = c.recording.artist;
        const title  = sanitize(normalizeTitle(rawTitle));
        const artist = sanitize(normalizeTitle(rawArtist));
        const lookupYear = original.year || c.recording.date || "";
        return {
          cand: c,
          finalMetadata: {
            title,
            artist,
            album: sanitize(normalizeTitle(original.album || c.recording.album)),
            year: original.year || c.recording.date,
            genre: c.recording.genre || original.genre,
            score: c.score,
            source: c.method
          }
        };
      })
      .map(o => ({
        ...o,
        fusion: scoreFusionMatch(filePath, o.finalMetadata, original)
      }))
      .sort((a,b) => b.fusion.score - a.fusion.score)[0];

    if (best.fusion.score >= 0.5) {
      logger.warn(`⚠️ No medium‐confidence, accepting lower fusion ${best.fusion.score}`);
      chosen = best;
    }
  }

  if (!chosen) {
    logger.error("❌ All candidates below threshold, skipping.");
    return { success: false, message: "Metadata mismatch." };
  }

  // unpack chosen
  const { cand, finalMetadata, fusion, albumData } = chosen;
  const { recording } = cand;
  const coverUrl       = albumData?.coverUrl || "";

  logger.log(`✅ [MATCH] ${finalMetadata.artist} — ${finalMetadata.title}`);
  logger.log(`💽 Album: ${finalMetadata.album} | 📆 Year: ${finalMetadata.year}`);

  // 4) Build ffmpeg arguments
  const inputs = [`-i "${filePath}"`];
  const maps   = [`-map 0:a`];
  const coverPath = path.join(dir, `${base}-cover.jpg`);
  let embeddedCover = false;

  // primary cover
  if (coverUrl) {
    try {
      const res = await fetch(coverUrl);
      const buf = await res.arrayBuffer();
      fs.writeFileSync(coverPath, Buffer.from(buf));
      inputs.push(`-i "${coverPath}"`);
      maps.push(`-map 1`);
      embeddedCover = true;
      logger.log(`🖼️ Cover art embedded from MusicBrainz`);
    } catch (err) {
      logger.warn(`⚠️ Cover embed failed: ${err.message}`);
    }
  }
  // fallback cover
  if (!embeddedCover) {
    try {
      const fb = await getCoverArtByMetadata(
        finalMetadata.artist,
        finalMetadata.title,
        finalMetadata.album,
        finalMetadata.year
      );
      if (fb?.coverUrl) {
        const res = await fetch(fb.coverUrl);
        const buf = await res.arrayBuffer();
        fs.writeFileSync(coverPath, Buffer.from(buf));
        inputs.push(`-i "${coverPath}"`);
        maps.push(`-map 1`);
        embeddedCover = true;
        logger.log(`🖼️ Cover art embedded via metadata fallback`);
      }
    } catch (err) {
      logger.warn(`⚠️ Fallback cover failed: ${err.message}`);
    }
  }

  const metadataArgs = [
    `-metadata title="${finalMetadata.title}"`,
    `-metadata artist="${finalMetadata.artist}"`,
    `-metadata album="${finalMetadata.album}"`,
    `-metadata date="${finalMetadata.year}"`,
    finalMetadata.genre ? `-metadata genre="${sanitize(finalMetadata.genre)}"` : "",
    `-metadata comment="MetaTune | fusion:${fusion.score}(${fusion.confidence})"`
  ].filter(Boolean);

  const codecArgs = embeddedCover
    ? ["-c copy"]
    : ["-c:a libmp3lame", "-b:a 192k"];

  const taggedName = `${finalMetadata.artist} - ${finalMetadata.title}${ext}`;
  const output     = path.join(dir, taggedName);

  const ffArgs = [
    ...inputs,
    ...maps,
    ...metadataArgs,
    ...codecArgs,
    `-y "${output}"`
  ];
  const cmd = `ffmpeg ${ffArgs.join(" ")}`;

  // 5) Run & finalize
  try {
    await runCommand(cmd);

    fs.writeFileSync(debugPath, JSON.stringify({
      chosenCandidate: cand,
      original,
      albumData,
      finalMetadata,
      fusion
    }, null, 2));
    fs.writeFileSync(publicLogPath, JSON.stringify({
      finalMetadata,
      fusion
    }, null, 2));

    logger.log(`✅ [DONE] Saved: ${output}`);
    logger.logMatch(finalMetadata);
    logger.updateStats({ source: finalMetadata.source, success: true });
    await logToDB?.(finalMetadata);

    cleanupFiles([filePath, coverPath]);
    return { success: true, message: "Tagged successfully", output, metadata: finalMetadata };
  } catch (err) {
    logger.error(`❌ FFmpeg failed: ${err}`);
    cleanupFiles([filePath, coverPath]);
    return { success: false, message: "Tagging failed." };
  }
}

// expose as Express handlers

async function processFile(req, res) {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No file uploaded" });
  }
  const result = await handleTagging(req.file.path);
  if (!result.success) return res.status(500).json(result);
  res.download(result.output, path.basename(result.output));
}

async function processBatch(req, res) {
  if (!req.files?.length) {
    return res.status(400).json({ success: false, message: "No files uploaded" });
  }
  const results = await Promise.all(req.files.map(f => handleTagging(f.path)));
  const outputs = results.filter(r => r.success).map(r => r.output);
  if (!outputs.length) {
    return res.status(500).json({ success: false, message: "No files tagged." });
  }
  const zipPath = await zipFiles(outputs);
  res.download(zipPath, path.basename(zipPath));
}

module.exports = { processFile, processBatch };
