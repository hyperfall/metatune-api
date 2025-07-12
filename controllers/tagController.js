const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const { getBestFingerprintMatch } = require("../utils/fingerprint");
const fetch = require("../utils/fetch");
const { log, warn, logError, logMatch, updateStats } = require("../utils/logger");

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

async function handleTagging(filePath) {
  const extension = path.extname(filePath) || ".mp3";
  const baseName = path.basename(filePath, extension);
  const dir = path.dirname(filePath);

  log(`🔍 [START] Processing file: ${filePath}`);

  let match;
  try {
    match = await getBestFingerprintMatch(filePath);
  } catch (err) {
    logError(`❌ [FINGERPRINT ERROR] ${err}`);
    return { success: false, message: "Fingerprinting failed." };
  }

  if (!match || !match.recording) {
    warn(`❌ [MISS] No match found for: ${filePath}`);
    updateStats({ success: false });
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

  log(`✅ [MATCH] Source: ${match.method.toUpperCase()}`);
  log(`🎵 Title: ${title}`);
  log(`🎤 Artist: ${artist}`);
  log(`💽 Album: ${album}`);
  log(`📆 Year: ${year}`);
  log(`📊 Confidence Score: ${score}`);

  // FFmpeg args
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

  // Cover art
  let coverPath = null;
  if (r.coverArt) {
    coverPath = path.join(dir, "cover.jpg");
    try {
      const img = await fetch(r.coverArt);
      const buf = await img.arrayBuffer();
      fs.writeFileSync(coverPath, Buffer.from(buf));
      args.splice(1, 0, `-i "${coverPath}" -map 0 -map 1 -c copy -disposition:v:1 attached_pic`);
      log(`🖼️ Cover art embedded: ${r.coverArt}`);
    } catch (e) {
      warn(`⚠️ Failed to fetch cover art: ${e.message}`);
    }
  }

  try {
    const ffmpegCmd = `ffmpeg ${args.join(" ")}`;
    await runCommand(ffmpegCmd);
    log(`✅ [DONE] Tagged file saved as: ${outputPath}`);

    const metaPath = path.join("cache", `${baseName}.json`);
    fs.writeFileSync(metaPath, JSON.stringify({
      title, artist, album, year, source: match.method, score
    }, null, 2));

    logMatch({
      input: path.basename(filePath),
      output: taggedName,
      title, artist, album, year, score,
      source: match.method
    });

    updateStats({ success: true, source: match.method });
    cleanupFile(filePath);
    if (coverPath) cleanupFile(coverPath);

    return {
      success: true,
      message: "File tagged successfully",
      output: outputPath,
      metadata: { title, artist, album, year, source: match.method, score }
    };
  } catch (err) {
    logError(`❌ [ERROR] FFmpeg failed on ${filePath}: ${err}`);
    updateStats({ success: false });
    cleanupFile(filePath);
    if (coverPath) cleanupFile(coverPath);
    return { success: false, message: "Tagging failed." };
  }
}

function cleanupFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    warn(`⚠️ Failed to delete file: ${filePath}`);
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

  const results = await Promise.all(req.files.map(file => handleTagging(file.path)));
  const taggedFiles = results.filter(r => r.success).map(r => r.output);

  if (!taggedFiles.length)
    return res.status(500).json({ success: false, message: "No files could be tagged." });

  const { zipFiles } = require("../utils/zipFiles");
  const zipPath = await zipFiles(taggedFiles);

  res.download(zipPath, path.basename(zipPath));
}

module.exports = { processFile, processBatch };
