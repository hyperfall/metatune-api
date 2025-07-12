const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const fetch = require("../utils/fetch");
const logger = require("../utils/logger");
const { getBestFingerprintMatch } = require("../utils/fingerprint");
const { extractOriginalMetadata } = require("../utils/metadataExtractor");
const { scoreFusionMatch } = require("../utils/fusionScorer");
const { cleanupFiles } = require("../utils/cleanupUploads");
const { logToDB } = require("../utils/db");
const { zipFiles } = require("../utils/zipFiles");
const { getOfficialAlbumInfo, getCoverArtByMetadata } = require("../utils/musicbrainzHelper");
const normalizeTitle = require("../utils/normalizeTitle");

function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 1024 * 2000 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || stdout);
      resolve(stdout.trim());
    });
  });
}

function sanitize(str) {
  return str ? str.replace(/[\\/:*?"<>|]/g, "_").trim() : "Unknown";
}

async function handleTagging(filePath, attempt = 1) {
  if (!fs.existsSync(filePath)) {
    logger.error(`❌ File not found: ${filePath}`);
    return { success: false, message: "Uploaded file missing." };
  }

  const ext = path.extname(filePath) || ".mp3";
  const base = path.basename(filePath, ext);
  const dir = path.dirname(filePath);
  const coverPath = path.join(dir, `${base}-cover.jpg`);
  const debugPath = path.join("cache", `${base}.json`);
  const publicLogPath = path.join("logs", `${base}-match-log.json`);

  logger.log(`🔍 [START] ${filePath}`);

  // Step 1: Fingerprint Matching
  let match;
  try {
    match = await getBestFingerprintMatch(filePath);
  } catch (err) {
    if (attempt === 1) {
      logger.warn("🔁 Retrying fingerprint...");
      return await handleTagging(filePath, 2);
    }
    logger.error(`🧠 Fingerprint failed: ${err.message}`);
    return { success: false, message: "Fingerprinting failed." };
  }

  if (!match?.recording || match.score < 60) {
    logger.warn(`⚠️ Low fingerprint confidence (${match?.score || 0}). Skipping.`);
    return { success: false, message: "No confident match found." };
  }

  const r = match.recording;
  const rawTitle = r.title || base;
  const rawArtist = r.artist || "Unknown Artist";

  const title = sanitize(normalizeTitle(rawTitle));
  const artist = sanitize(normalizeTitle(rawArtist));

  // Step 2: Album Info
  const albumData = await getOfficialAlbumInfo(artist, title);
  const album = sanitize(normalizeTitle(albumData?.album || r.album || "Unknown Album"));
  const year = albumData?.year || r.date || "2023";
  const coverUrl = albumData?.coverUrl;
  const genre = r.genre || "";

  const score = match.score || 0;
  const source = match.method || "unknown";

  const finalMetadata = { title, artist, album, year, genre, score, source };

  // Step 3: Original Metadata & Fusion Score
  const original = await extractOriginalMetadata(filePath);
  const fusion = scoreFusionMatch(filePath, finalMetadata, original);

  logger.log(`📊 Score: ${score} | 🔎 Source: ${source}`);
  logger.log(`🧠 Fusion Score: ${fusion.score} (${fusion.confidence})`);
  logger.log("🔬 Fusion Debug:", fusion.debug);

  if (fusion.score < 0.5) {
    logger.warn(`❌ [FUSION FAIL] Score ${fusion.score} < 0.5. Skipping file.`);
    return { success: false, message: "Metadata mismatch." };
  }

  const taggedName = `${artist} - ${title}${ext}`;
  const output = path.join(dir, taggedName);

  logger.log(`✅ [MATCH] ${title} by ${artist}`);
  logger.log(`💽 Album: ${album} | 📆 Year: ${year} | 🎼 Genre: ${genre || "N/A"}`);

  // Step 4: FFmpeg Tagging
  let args = [
    `-i "${filePath}"`,
    `-metadata title="${title}"`,
    `-metadata artist="${artist}"`,
    `-metadata album="${album}"`,
    `-metadata date="${year}"`,
    genre ? `-metadata genre="${sanitize(genre)}"` : "",
    `-metadata comment="Tagged by MetaTune | Score: ${fusion.score} (${fusion.confidence})"`,
    `-c:a libmp3lame`,
    `-b:a 192k`,
    `-y "${output}"`
  ].filter(Boolean);

  // Step 5: Cover Art Embedding
  let embeddedCover = false;

  if (coverUrl) {
    try {
      const res = await fetch(coverUrl);
      const buf = await res.arrayBuffer();
      fs.writeFileSync(coverPath, Buffer.from(buf));
      args.splice(1, 0, `-i "${coverPath}" -map 0 -map 1 -c copy -disposition:v:1 attached_pic`);
      embeddedCover = true;
      logger.log(`🖼️ Cover art embedded from MusicBrainz`);
    } catch (err) {
      logger.warn(`⚠️ MusicBrainz cover failed: ${err.message}`);
    }
  }

  if (!embeddedCover) {
    try {
      const fallback = await getCoverArtByMetadata(artist, title, album, year);
      if (fallback?.coverUrl) {
        const res = await fetch(fallback.coverUrl);
        const buf = await res.arrayBuffer();
        fs.writeFileSync(coverPath, Buffer.from(buf));
        args.splice(1, 0, `-i "${coverPath}" -map 0 -map 1 -c copy -disposition:v:1 attached_pic`);
        logger.log(`🖼️ Cover art embedded via metadata fallback`);
      } else {
        logger.warn(`⚠️ No fallback cover art available`);
      }
    } catch (err) {
      logger.warn(`⚠️ Metadata fallback cover failed: ${err.message}`);
    }
  }

  // Step 6: Save Final File
  try {
    await runCommand(`ffmpeg ${args.join(" ")}`);
    fs.writeFileSync(debugPath, JSON.stringify({ match, finalMetadata, fusion }, null, 2));
    fs.writeFileSync(publicLogPath, JSON.stringify({ match, finalMetadata, fusion }, null, 2));

    logger.log(`✅ [DONE] ${output}`);
    logger.logMatch(finalMetadata);
    logger.updateStats({ source, success: true });
    await logToDB?.(finalMetadata);

    cleanupFiles([filePath, coverPath]);
    return { success: true, message: "Tagged successfully", output, metadata: finalMetadata };
  } catch (err) {
    logger.error(`❌ [FFmpeg] ${err}`);
    cleanupFiles([filePath, coverPath]);
    return { success: false, message: "Tagging failed." };
  }
}

// ROUTES

async function processFile(req, res) {
  if (!req.file)
    return res.status(400).json({ success: false, message: "No file uploaded" });

  const result = await handleTagging(req.file.path);
  if (!result.success)
    return res.status(500).json(result);

  res.download(result.output, path.basename(result.output));
}

async function processBatch(req, res) {
  if (!req.files?.length)
    return res.status(400).json({ success: false, message: "No files uploaded" });

  const results = await Promise.all(req.files.map(f => handleTagging(f.path)));
  const taggedFiles = results.filter(r => r.success).map(r => r.output);

  if (!taggedFiles.length)
    return res.status(500).json({ success: false, message: "No files tagged." });

  const zipPath = await zipFiles(taggedFiles);
  res.download(zipPath, path.basename(zipPath));
}

module.exports = { processFile, processBatch };
