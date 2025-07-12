const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const logger = require("../utils/logger");
const fetch = require("../utils/fetch");
const { getBestFingerprintMatch } = require("../utils/fingerprint");
const { zipFiles } = require("../utils/zipFiles");

function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 1024 * 1000 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || stdout);
      resolve(stdout.trim());
    });
  });
}

function sanitize(input) {
  return input ? input.replace(/[\/:*?"<>|]/g, "_").trim() : "Unknown";
}

async function tryFingerprintRetry(filePath, attempts = 2, delayMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    const match = await getBestFingerprintMatch(filePath);
    if (match && match.recording) return match;
    if (i < attempts - 1) await new Promise(res => setTimeout(res, delayMs));
  }
  return null;
}

async function handleTagging(filePath) {
  const extension = path.extname(filePath) || ".mp3";
  const baseName = path.basename(filePath, extension);
  const dir = path.dirname(filePath);

  logger.log(`🔍 [START] Processing file: ${filePath}`);

  const match = await tryFingerprintRetry(filePath);
  if (!match || !match.recording) {
    logger.warn(`❌ [MISS] No match found for: ${filePath}`);
    logger.updateStats({ source: "none", success: false });
    logger.logError(`Fingerprint failed for ${filePath}`);
    cleanupFile(filePath);
    return { success: false, message: "Track could not be identified." };
  }

  const r = match.recording;
  const title = sanitize(r.title || baseName);
  const artist = sanitize(r.artist || "Unknown Artist");
  const album = sanitize(r.album || "Unknown Album");
  const year = r.date || "2023";
  const score = match.score || 0;

  const taggedName = `${artist} - ${title}${extension}`;
  const outputPath = path.join(dir, taggedName);

  logger.log(`✅ [MATCH] Source: ${match.method.toUpperCase()}`);
  logger.log(`🎵 Title: ${title}`);
  logger.log(`🎤 Artist: ${artist}`);
  logger.log(`💽 Album: ${album}`);
  logger.log(`📆 Year: ${year}`);
  logger.log(`📊 Confidence Score: ${score}`);

  let coverPath;
  const args = [
    `-i "${filePath}"`,
    `-metadata title="${title}"`,
    `-metadata artist="${artist}"`,
    `-metadata album="${album}"`,
    `-metadata date="${year}"`,
    `-c:a libmp3lame`,
    `-b:a 192k`,
    `-y "${outputPath}"`
  ];

  if (r.coverArt) {
    try {
      coverPath = path.join(dir, "cover.jpg");
      const res = await fetch(r.coverArt);
      const buf = await res.arrayBuffer();
      fs.writeFileSync(coverPath, Buffer.from(buf));
      args.splice(1, 0, `-i "${coverPath}" -map 0 -map 1 -c copy -disposition:v:1 attached_pic`);
      logger.log(`🖼️ Cover art embedded: ${r.coverArt}`);
    } catch (e) {
      logger.warn(`⚠️ Failed to fetch cover art: ${e.message}`);
    }
  }

  const ffmpegCmd = `ffmpeg ${args.join(" ")}`;
  try {
    await runCommand(ffmpegCmd);
    logger.log(`✅ [DONE] Tagged file saved as: ${outputPath}`);

    const metaPath = path.join("cache", `${baseName}.json`);
    fs.writeFileSync(metaPath, JSON.stringify({
      title, artist, album, year, source: match.method, score
    }, null, 2));

    logger.logMatch({ title, artist, album, year, source: match.method, score });
    logger.updateStats({ source: match.method, success: true });

    cleanupFile(filePath);
    if (coverPath) cleanupFile(coverPath);

    return {
      success: true,
      message: "File tagged successfully",
      output: outputPath,
      metadata: { title, artist, album, year, source: match.method, score }
    };
  } catch (err) {
    logger.error(`❌ [ERROR] FFmpeg failed on ${filePath}: ${err}`);
    logger.updateStats({ source: match.method, success: false });
    cleanupFile(filePath);
    if (coverPath) cleanupFile(coverPath);
    return { success: false, message: "Tagging failed." };
  }
}

function cleanupFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    logger.warn(`⚠️ Could not delete ${filePath}: ${e.message}`);
  }
}

async function processFile(req, res) {
  if (!req.file)
    return res.status(400).json({ success: false, message: "No file uploaded" });

  const result = await handleTagging(req.file.path);
  if (!result.success) return res.status(500).json(result);

  res.download(result.output, path.basename(result.output));
}

async function processBatch(req, res) {
  if (!req.files || !req.files.length)
    return res.status(400).json({ success: false, message: "No files uploaded" });

  const results = await Promise.all(req.files.map(file => handleTagging(file.path)));

  const taggedFiles = results.filter(r => r.success).map(r => r.output);
  if (!taggedFiles.length)
    return res.status(500).json({ success: false, message: "No files could be tagged." });

  const zipPath = await zipFiles(taggedFiles);
  res.download(zipPath, path.basename(zipPath));
}

module.exports = { processFile, processBatch };
