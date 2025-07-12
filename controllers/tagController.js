const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");

const { getBestFingerprintMatch } = require("../utils/fingerprint");
const fetchAlbumArt = require("../utils/fetchAlbumArt");
const logger = require("../utils/logger");

const runCommand = promisify(exec);

function sanitize(input) {
  return input ? input.replace(/[\/:*?"<>|]/g, "_").trim() : "Unknown";
}

async function handleTagging(filePath) {
  const extension = path.extname(filePath) || ".mp3";
  const baseName = path.basename(filePath, extension);
  const dir = path.dirname(filePath);
  const metaPath = path.join("cache", `${baseName}.json`);
  const coverPath = path.join(dir, "cover.jpg");

  logger.log(`🔍 [START] Processing file: ${filePath}`);

  // 🔁 Retry ACRCloud once if it fails
  let match = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    match = await getBestFingerprintMatch(filePath);
    if (match && match.recording) break;
    if (attempt === 1) {
      logger.warn("🔁 Retrying fingerprint match...");
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  if (!match || !match.recording) {
    logger.warn(`❌ [MISS] No match found for: ${filePath}`);
    fs.unlinkSync(filePath); // cleanup original
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

  // 🖼️ Try to embed album art
  if (r.id) {
    try {
      const art = await fetchAlbumArt(r.id);
      if (art && art.imageBuffer) {
        fs.writeFileSync(coverPath, art.imageBuffer);
        args.splice(1, 0, `-i "${coverPath}" -map 0 -map 1 -c copy -disposition:v:1 attached_pic`);
        logger.log(`🖼️ Album art embedded from: ${art.url}`);
      }
    } catch (e) {
      logger.warn(`⚠️ Failed to fetch or embed album art: ${e.message}`);
    }
  }

  try {
    await runCommand(`ffmpeg ${args.join(" ")}`);
    logger.log(`✅ [DONE] Tagged file saved as: ${outputPath}`);

    fs.writeFileSync(metaPath, JSON.stringify({
      title, artist, album, year, source: match.method, score
    }, null, 2));

    return {
      success: true,
      message: "File tagged successfully",
      output: outputPath,
      metadata: { title, artist, album, year, source: match.method, score }
    };
  } catch (err) {
    logger.error(`❌ [ERROR] FFmpeg failed on ${filePath}: ${err}`);
    return { success: false, message: "Tagging failed." };
  } finally {
    try {
      fs.unlinkSync(filePath);
      if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
    } catch (e) {
      logger.warn(`⚠️ Cleanup error: ${e.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

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

  const { zipFiles } = require("../utils/zipFiles");
  const zipPath = await zipFiles(taggedFiles);

  res.download(zipPath, path.basename(zipPath));
}

module.exports = { processFile, processBatch };
