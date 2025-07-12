const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const fetch = require("../utils/fetch");
const logger = require("../utils/logger");
const { getBestFingerprintMatch } = require("../utils/fingerprint");
const fetchAlbumArt = require("../utils/fetchAlbumArt");
const { cleanupFiles } = require("../utils/cleanupUploads");
const { logToDB } = require("../utils/db");
const { zipFiles } = require("../utils/zipFiles");

function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 1024 * 2000 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || stdout);
      resolve(stdout.trim());
    });
  });
}

function sanitize(input) {
  return input ? input.replace(/[\/:*?"<>|]/g, "_").trim() : "Unknown";
}

async function handleTagging(filePath, attempt = 1) {
  const extension = path.extname(filePath) || ".mp3";
  const baseName = path.basename(filePath, extension);
  const dir = path.dirname(filePath);
  const coverPath = path.join(dir, `${baseName}-cover.jpg`);
  const debugJSON = path.join("cache", `${baseName}.json`);

  logger.log(`🔍 [START] Processing file: ${filePath}`);

  let match;
  try {
    match = await getBestFingerprintMatch(filePath);
  } catch (e) {
    logger.error(`❌ Fingerprint failed: ${e.message}`);
    if (attempt === 1) {
      logger.warn("🔁 Retrying once due to fingerprint error...");
      return await handleTagging(filePath, 2);
    }
    return { success: false, message: "Fingerprinting failed." };
  }

  if (!match?.recording) {
    logger.warn(`❌ [MISS] No match found for: ${filePath}`);
    return { success: false, message: "Track could not be identified." };
  }

  const r = match.recording;

  const title = sanitize(r.title || baseName);
  const artist = sanitize(r.artist || "Unknown Artist");
  const album = sanitize(r.album || r.release || "Unknown Album");
  const year = r.date || "2023";
  const score = match.score || 0;
  const source = match.method || "unknown";

  const taggedName = `${artist} - ${title}${extension}`;
  const outputPath = path.join(dir, taggedName);

  logger.log(`✅ [MATCH] Source: ${source.toUpperCase()}`);
  logger.log(`🎵 Title: ${title}`);
  logger.log(`🎤 Artist: ${artist}`);
  logger.log(`💽 Album: ${album}`);
  logger.log(`📆 Year: ${year}`);
  logger.log(`📊 Confidence Score: ${score}`);

  let args = [
    `-i "${filePath}"`,
    `-metadata title="${title}"`,
    `-metadata artist="${artist}"`,
    `-metadata album="${album}"`,
    `-metadata date="${year}"`,
    `-c:a libmp3lame`,
    `-b:a 192k`,
    `-y "${outputPath}"`
  ];

  // Try to embed cover art from MusicBrainz if possible
  if (r.mbid) {
    try {
      const art = await fetchAlbumArt(r.mbid);
      if (art) {
        fs.writeFileSync(coverPath, art.imageBuffer);
        args.splice(1, 0, `-i "${coverPath}" -map 0 -map 1 -c copy -disposition:v:1 attached_pic`);
        logger.log(`🖼️ Cover art embedded from MusicBrainz`);
      }
    } catch (e) {
      logger.warn(`⚠️ Failed to fetch external album art: ${e.message}`);
    }
  }

  const ffmpegCmd = `ffmpeg ${args.join(" ")}`;
  try {
    await runCommand(ffmpegCmd);
    logger.log(`✅ [DONE] Tagged file saved as: ${outputPath}`);

    const metadata = { title, artist, album, year, source, score };
    fs.writeFileSync(debugJSON, JSON.stringify(metadata, null, 2));
    logger.logMatch(metadata);
    logger.updateStats({ source, success: true });
    await logToDB?.(metadata); // optional database hook

    cleanupFiles([filePath, coverPath]);
    return {
      success: true,
      message: "File tagged successfully",
      output: outputPath,
      metadata
    };
  } catch (err) {
    logger.error(`❌ [ERROR] FFmpeg failed on ${filePath}: ${err}`);
    logger.updateStats({ source, success: false });
    cleanupFiles([filePath, coverPath]);
    return { success: false, message: "Tagging failed." };
  }
}

async function processFile(req, res) {
  if (!req.file)
    return res.status(400).json({ success: false, message: "No file uploaded" });

  const result = await handleTagging(req.file.path);
  if (!result.success)
    return res.status(500).json(result);

  res.download(result.output, path.basename(result.output));
}

async function processBatch(req, res) {
  if (!req.files || !req.files.length)
    return res.status(400).json({ success: false, message: "No files uploaded" });

  const results = await Promise.all(req.files.map(file => handleTagging(file.path)));

  const taggedFiles = results
    .filter(r => r.success)
    .map(r => r.output);

  if (!taggedFiles.length)
    return res.status(500).json({ success: false, message: "No files could be tagged." });

  const zipPath = await zipFiles(taggedFiles);
  res.download(zipPath, path.basename(zipPath));
}

module.exports = { processFile, processBatch };
