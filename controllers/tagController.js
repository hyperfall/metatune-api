const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const { getBestFingerprintMatch } = require("../utils/fingerprint");
const fetch = require("../utils/fetch");
const fetchAlbumArt = require("../utils/fetchAlbumArt");
const logger = require("../utils/logger");
const { logMetadata } = require("../utils/db");
const { zipFiles } = require("../utils/zipFiles");
const { cleanupFiles } = require("../utils/cleanupUploads");

function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1000 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || stdout);
      resolve(stdout.trim());
    });
  });
}

function sanitize(str) {
  return str ? str.replace(/[\/:*?"<>|]/g, "_").trim() : "Unknown";
}

async function handleTagging(filePath) {
  const ext = path.extname(filePath) || ".mp3";
  const base = path.basename(filePath, ext);
  const dir = path.dirname(filePath);
  const coverPath = path.join(dir, `${base}_cover.jpg`);
  const metaPath = path.join("cache", `${base}.json`);

  logger.log(`🔍 [START] Processing file: ${filePath}`);

  // Fingerprint (retry fallback built-in)
  const match = await getBestFingerprintMatch(filePath);
  if (!match || !match.recording) {
    logger.warn(`❌ [MISS] No match found for: ${filePath}`);
    cleanupFiles([filePath]);
    return { success: false, message: "Track could not be identified." };
  }

  const r = match.recording;
  const title = sanitize(r.title || base);
  const artist = sanitize(r.artist || "Unknown Artist");
  const album = sanitize(r.album || "Unknown Album");
  const year = r.date || "2023";
  const score = match.score || 0;

  const outputPath = path.join(dir, `${artist} - ${title}${ext}`);

  logger.log(`✅ [MATCH] Source: ${match.method.toUpperCase()}`);
  logger.log(`🎵 Title: ${title}`);
  logger.log(`🎤 Artist: ${artist}`);
  logger.log(`💽 Album: ${album}`);
  logger.log(`📆 Year: ${year}`);
  logger.log(`📊 Confidence Score: ${score}`);

  // FFmpeg args
  const args = [
    `-i "${filePath}"`,
    `-metadata title="${title}"`,
    `-metadata artist="${artist}"`,
    `-metadata album="${album}"`,
    `-metadata date="${year}"`,
    `-c:a libmp3lame`,
    `-b:a 192k`,
  ];

  let usedCover = false;

  try {
    if (r.mbid) {
      const art = await fetchAlbumArt(r.mbid);
      if (art?.imageBuffer) {
        fs.writeFileSync(coverPath, art.imageBuffer);
        args.unshift(`-i "${coverPath}"`);
        args.push(`-map 0 -map 1 -disposition:v:1 attached_pic`);
        usedCover = true;
        logger.log(`🖼️ Cover art embedded from MusicBrainz`);
      }
    }
  } catch (e) {
    logger.warn(`⚠️ Failed to fetch cover art from MusicBrainz`);
  }

  // Fallback: use embedded image from source
  if (!usedCover && r.coverArt) {
    try {
      const res = await fetch(r.coverArt);
      const buf = await res.arrayBuffer();
      fs.writeFileSync(coverPath, Buffer.from(buf));
      args.unshift(`-i "${coverPath}"`);
      args.push(`-map 0 -map 1 -disposition:v:1 attached_pic`);
      logger.log(`🖼️ Fallback cover used from ACRCloud`);
    } catch (e) {
      logger.warn(`⚠️ Could not fetch fallback cover art: ${e.message}`);
    }
  }

  args.push(`-y "${outputPath}"`);

  const ffmpegCmd = `ffmpeg ${args.join(" ")}`;
  try {
    await runCommand(ffmpegCmd);
    logger.log(`✅ [DONE] Tagged file saved as: ${outputPath}`);

    const metadata = { title, artist, album, year, source: match.method, score };
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
    logMetadata(metadata);
    cleanupFiles([filePath, coverPath]);

    return {
      success: true,
      message: "File tagged successfully",
      output: outputPath,
      metadata
    };
  } catch (err) {
    logger.error(`❌ [ERROR] FFmpeg failed on ${filePath}: ${err}`);
    cleanupFiles([filePath, coverPath]);
    return { success: false, message: "Tagging failed." };
  }
}

async function processFile(req, res) {
  if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

  const result = await handleTagging(req.file.path);
  if (!result.success) return res.status(500).json(result);

  res.download(result.output, path.basename(result.output));
}

async function processBatch(req, res) {
  if (!req.files || !req.files.length)
    return res.status(400).json({ success: false, message: "No files uploaded" });

  const results = await Promise.all(req.files.map(f => handleTagging(f.path)));
  const successful = results.filter(r => r.success).map(r => r.output);

  if (!successful.length)
    return res.status(500).json({ success: false, message: "No files could be tagged." });

  const zipPath = await zipFiles(successful);
  res.download(zipPath, path.basename(zipPath));
}

module.exports = { processFile, processBatch };
