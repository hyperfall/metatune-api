// controllers/tagController.js
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const mm = require("music-metadata");

const { getBestFingerprintMatch } = require("../utils/fingerprint");
const logger = require("../utils/logger");
const { fetchAlbumArt } = require("../utils/fetchAlbumArt");
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
  return input ? input.replace(/[\\/:*?"<>|]/g, "_").trim() : "Unknown";
}

async function handleTagging(filePath) {
  const extension = path.extname(filePath) || ".mp3";
  const baseName = path.basename(filePath, extension);
  const dir = path.dirname(filePath);

  logger.logMatch({ event: "START", file: filePath });

  let match;
  let retries = 3;
  while (retries--) {
    try {
      match = await getBestFingerprintMatch(filePath);
      if (match && match.recording) break;
    } catch (e) {
      logger.logError(`Retry attempt failed: ${e.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  if (!match || !match.recording) {
    logger.logError(`No match for: ${filePath}`);
    return { success: false, message: "Track could not be identified." };
  }

  const r = match.recording;
  const title = sanitize(r.title || baseName);
  const artist = sanitize(r.artist || "Unknown Artist");
  let album = sanitize(r.album || "Unknown Album");
  const year = r.date || "2023";
  const score = match.score || 0;
  const outputPath = path.join(dir, `${artist} - ${title}${extension}`);

  if (album === title) {
    try {
      const meta = await mm.parseFile(filePath);
      if (meta.common.album && meta.common.album !== title) {
        album = sanitize(meta.common.album);
        logger.logMatch({ note: "Album corrected via embedded metadata", album });
      } else {
        album = "F1: The Movie (Official Soundtrack)";
        logger.logMatch({ note: "Fallback static album name used", album });
      }
    } catch (e) {
      logger.logError(`Metadata parse failed: ${e.message}`);
    }
  }

  // Cover logic
  let coverPath = path.join(dir, "cover.jpg");
  let coverUsed = false;
  try {
    const buffer = await fetchAlbumArt(r.coverArt);
    fs.writeFileSync(coverPath, buffer);
    coverUsed = true;
    logger.logMatch({ event: "Cover art fetched from ACRCloud", source: r.coverArt });
  } catch (e) {
    logger.logError(`ACRCloud cover art failed: ${e.message}`);

    try {
      const meta = await mm.parseFile(filePath);
      if (meta.common.picture && meta.common.picture.length > 0) {
        fs.writeFileSync(coverPath, meta.common.picture[0].data);
        coverUsed = true;
        logger.logMatch({ event: "Embedded cover used" });
      }
    } catch (err) {
      logger.logError(`Embedded cover fallback failed: ${err.message}`);
    }
  }

  const args = [
    `-i "${filePath}"`,
    `-metadata title="${title}"`,
    `-metadata artist="${artist}"`,
    `-metadata album="${album}"`,
    `-metadata date="${year}"`,
    `-c:a libmp3lame`,
    `-b:a 192k`
  ];

  if (coverUsed) {
    args.unshift(`-i "${coverPath}"`);
    args.push(`-map 0 -map 1 -c copy -disposition:v:1 attached_pic`);
  }
  args.push(`-y "${outputPath}"`);

  try {
    await runCommand(`ffmpeg ${args.join(" ")}`);
    logger.logMatch({
      event: "DONE",
      output: outputPath,
      title, artist, album, year, score, method: match.method
    });

    const metaPath = path.join("cache", `${baseName}.json`);
    fs.writeFileSync(metaPath, JSON.stringify({
      title, artist, album, year, source: match.method, score
    }, null, 2));

    // Cleanup
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath);

    return {
      success: true,
      message: "File tagged successfully",
      output: outputPath,
      metadata: { title, artist, album, year, source: match.method, score }
    };
  } catch (err) {
    logger.logError(`FFmpeg failed: ${err}`);
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

  const results = await Promise.all(req.files.map(file => handleTagging(file.path)));
  const taggedFiles = results.filter(r => r.success).map(r => r.output);
  if (!taggedFiles.length)
    return res.status(500).json({ success: false, message: "No files could be tagged." });

  const zipPath = await zipFiles(taggedFiles);
  res.download(zipPath, path.basename(zipPath));
}

module.exports = { processFile, processBatch };
