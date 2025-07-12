// controllers/tagController.js

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const fetch = require("../utils/fetch");
const logger = require("../utils/logger");
const { getFingerprintCandidates } = require("../utils/fingerprint");
const { extractOriginalMetadata }    = require("../utils/metadataExtractor");
const { scoreFusionMatch }           = require("../utils/fusionScorer");
const { cleanupFiles }               = require("../utils/cleanupUploads");
const { logToDB }                    = require("../utils/db");
const { zipFiles }                   = require("../utils/zipFiles");
const {
  getOfficialAlbumInfo,
  getCoverArtByMetadata
} = require("../utils/musicbrainzHelper");
const normalizeTitle = require("../utils/normalizeTitle");

// Run a shell command (ffmpeg)
function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 2000 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || stdout);
      resolve(stdout.trim());
    });
  });
}

// Sanitize any user‐visible string into a safe filename
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
  const coverPath     = path.join(dir, `${base}-cover.jpg`);

  logger.log(`🔍 [START] ${filePath}`);

  // 1) Extract original tags & get fingerprint candidates
  const original   = await extractOriginalMetadata(filePath);
  logger.log("📂 Original metadata:", original);

  const candidates = await getFingerprintCandidates(filePath);
  if (!candidates.length) {
    logger.warn("⚠️ No fingerprint candidates");
    return { success: false, message: "No match found." };
  }

  let chosen = null;
  let fusionResult = null;

  // 2) First pass: pick any candidate with fusion ≥ 0.6
  for (const cand of candidates) {
    const { method, score, recording: rec } = cand;
    const title  = sanitize(normalizeTitle(rec.title));
    const artist = sanitize(normalizeTitle(rec.artist));

    // Lookup album (MBID if available, else text+year)
    const lookupYear = original.year || rec.date || "";
    const albumData  = await getOfficialAlbumInfo(artist, title, lookupYear, rec.mbid);
    const album      = sanitize(normalizeTitle(
      albumData?.album || rec.album || original.album || "Unknown Album"
    ));
    const year       = albumData?.year  || rec.date || original.year  || "2023";
    const genre      = rec.genre       || original.genre || "";

    const finalMetadata = {
      title,
      artist,
      album,
      year,
      genre,
      score,
      source: method
    };

    fusionResult = scoreFusionMatch(filePath, finalMetadata, original);
    logger.log(
      `📊 Candidate [${method}] fingerprint:${score} → fusion ${fusionResult.score} (${fusionResult.confidence})`
    );
    logger.log("🔬 Fusion debug:", fusionResult.debug);

    if (fusionResult.score >= 0.6) {
      chosen = { cand, finalMetadata, fusionResult, albumData };
      break;
    }
  }

  // 3) Fallback: if none ≥0.6, pick highest‐scoring ≥0.5
  if (!chosen) {
    const scored = await Promise.all(candidates.map(async c => {
      const { method, score: sc, recording: rec } = c;
      const title  = sanitize(normalizeTitle(rec.title));
      const artist = sanitize(normalizeTitle(rec.artist));

      const lookupYear = original.year || rec.date || "";
      const albumData  = await getOfficialAlbumInfo(artist, title, lookupYear, rec.mbid);
      const album      = sanitize(normalizeTitle(
        albumData?.album || rec.album || original.album || "Unknown Album"
      ));
      const year       = albumData?.year  || rec.date || original.year  || "2023";
      const genre      = rec.genre       || original.genre || "";

      const finalMetadata = {
        title,
        artist,
        album,
        year,
        genre,
        score: sc,
        source: method
      };

      const fusion = scoreFusionMatch(filePath, finalMetadata, original);
      return { cand: c, finalMetadata, fusion, albumData };
    }));

    scored.sort((a,b) => b.fusion.score - a.fusion.score);
    const best = scored[0];
    if (best.fusion.score >= 0.5) {
      logger.warn(`⚠️ No high‐confidence candidates, accepting fusion ${best.fusion.score}`);
      chosen = best;
      fusionResult = best.fusion;
    }
  }

  if (!chosen) {
    logger.error("❌ All candidates below threshold, skipping.");
    return { success: false, message: "Metadata mismatch." };
  }

  // Unpack the chosen result
  const { cand, finalMetadata, albumData } = chosen;
  fusionResult = fusionResult || chosen.fusion;
  logger.log(`✅ [MATCH] ${finalMetadata.artist} — ${finalMetadata.title}`);
  logger.log(`💽 Album: ${finalMetadata.album} | 📆 Year: ${finalMetadata.year}`);

  // 4) Fetch & embed cover art
  let embeddedCover = false;
  if (albumData?.coverUrl) {
    try {
      const res = await fetch(albumData.coverUrl);
      const buf = await res.arrayBuffer();
      fs.writeFileSync(coverPath, Buffer.from(buf));
      embeddedCover = true;
      logger.log(`🖼️ Cover art embedded from MusicBrainz`);
    } catch (err) {
      logger.warn(`⚠️ Cover embed failed: ${err.message}`);
    }
  }
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
        embeddedCover = true;
        logger.log(`🖼️ Cover art embedded via metadata fallback`);
      }
    } catch (err) {
      logger.warn(`⚠️ Fallback cover failed: ${err.message}`);
    }
  }

  // 5) Assemble ffmpeg args
  const inputs = [`-i "${filePath}"`];
  const maps   = [`-map 0:a`];
  if (embeddedCover) {
    inputs.push(`-i "${coverPath}"`);
    maps.push(`-map 1`);
  }

  const metadataArgs = [
    `-metadata title="${finalMetadata.title}"`,
    `-metadata artist="${finalMetadata.artist}"`,
    `-metadata album="${finalMetadata.album}"`,
    `-metadata date="${finalMetadata.year}"`,
    finalMetadata.genre ? `-metadata genre="${sanitize(finalMetadata.genre)}"` : "",
    `-metadata comment="MetaTune | fusion:${fusionResult.score}(${fusionResult.confidence})"`
  ];
  const codecArgs = embeddedCover
    ? ["-c copy"]
    : ["-c:a libmp3lame", "-b:a 192k"];

  const taggedName = `${finalMetadata.artist} - ${finalMetadata.title}${ext}`;
  const output     = path.join(dir, taggedName);
  const ffArgs     = [
    ...inputs,
    ...maps,
    ...metadataArgs,
    ...codecArgs,
    `-y "${output}"`
  ];

  // 6) Run ffmpeg and finalize
  try {
    await runCommand(`ffmpeg ${ffArgs.join(" ")}`);

    // write debug outputs
    fs.writeFileSync(debugPath, JSON.stringify({
      chosenCandidate: cand,
      original,
      albumData,
      finalMetadata,
      fusion: fusionResult
    }, null, 2));
    fs.writeFileSync(publicLogPath, JSON.stringify({
      finalMetadata,
      fusion: fusionResult
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

// Express route handlers

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
