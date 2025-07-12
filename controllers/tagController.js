const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const fetch = require("../utils/fetch");
const logger = require("../utils/logger");
const { getBestFingerprintMatch } = require("../utils/fingerprint");
const normalizeTitle = require("../utils/normalizeTitle");
const { cleanupFiles } = require("../utils/cleanupUploads");
const { logToDB } = require("../utils/db");
const { zipTaggedFiles } = require("../utils/zipFiles"); // ✅ Corrected import
const { getOfficialAlbumInfo } = require("../utils/musicbrainzHelper");

function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 1024 * 2000 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || stdout);
      resolve(stdout.trim());
    });
  });
}

function sanitize(input) {
  if (!input) return "Unknown";
  return input.replace(/[\/:*?"<>|]/g, "_").trim();
}

function getConfidenceLevel(score) {
  if (score >= 90) return "High";
  if (score >= 60) return "Medium";
  return "Low";
}

async function handleTagging(filePath, attempt = 1) {
  if (!fs.existsSync(filePath)) {
    logger.error(`❌ File does not exist: ${filePath}`);
    return { success: false, message: "Uploaded file missing on disk." };
  }

  const extension = path.extname(filePath) || ".mp3";
  const baseName = path.basename(filePath, extension);
  const dir = path.dirname(filePath);
  const coverPath = path.join(dir, `${baseName}-cover.jpg`);
  const debugJSON = path.join("cache", `${baseName}.json`);
  const publicLogPath = path.join("logs", "match-log.json");

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

  if (!match?.recording || match.score < 60) {
    logger.warn(`❌ [MISS] Match rejected (low score or empty): ${filePath}`);
    return { success: false, message: "Low-confidence or no match found." };
  }

  const r = match.recording;
  const title = sanitize(normalizeTitle(r.title || baseName));
  const artist = sanitize(normalizeTitle(r.artist || "Unknown Artist"));

  // 🔍 Fallback to MusicBrainz for album correction
  const fallback = await getOfficialAlbumInfo(artist, title);

  const suspicious =
    !r.album ||
    r.album === r.title ||
    /boino|nrj|compilation|various/i.test(r.album || "") ||
    /boino/i.test(artist || "");

  if (fallback && (suspicious || fallback.album !== r.album)) {
    logger.logFallbackInfo({ album: r.album }, fallback);
    r.album = fallback.album;
    r.date = fallback.year;
  }

  const album = sanitize(normalizeTitle(r.album || "Unknown Album"));
  const year = r.date || "2023";
  const genre = r.genre || "";
  const score = match.score || 0;
  const source = match.method || "unknown";
  const confidence = getConfidenceLevel(score);

  const taggedName = `${artist} - ${title}${extension}`;
  const outputPath = path.join(dir, taggedName);

  logger.log(`✅ [MATCH] ${title} by ${artist}`);
  logger.log(`💽 Album: ${album} | 📆 Year: ${year} | 🎼 Genre: ${genre || "N/A"}`);
  logger.log(`📊 Score: ${score} | 🔎 Source: ${source} | 🔐 Confidence: ${confidence}`);

  let args = [
    `-i "${filePath}"`,
    `-metadata title="${title}"`,
    `-metadata artist="${artist}"`,
    `-metadata album="${album}"`,
    `-metadata date="${year}"`,
    genre ? `-metadata genre="${sanitize(genre)}"` : "",
    `-metadata comment="Tagged by MetaTune | Confidence: ${confidence}"`,
    `-c:a libmp3lame`,
    `-b:a 192k`,
    `-y "${outputPath}"`
  ].filter(Boolean);

  if (fallback?.coverUrl) {
    try {
      const res = await fetch(fallback.coverUrl);
      const buf = await res.arrayBuffer();
      fs.writeFileSync(coverPath, Buffer.from(buf));
      args.splice(1, 0, `-i "${coverPath}" -map 0 -map 1 -c copy -disposition:v:1 attached_pic`);
      logger.log(`🖼️ Cover art embedded from MusicBrainz`);
    } catch (e) {
      logger.warn(`⚠️ Failed to fetch or embed cover art: ${e.message}`);
    }
  } else {
    logger.warn(`⚠️ No fallback cover art available.`);
  }

  try {
    await runCommand(`ffmpeg ${args.join(" ")}`);
    logger.log(`✅ [DONE] File saved as: ${outputPath}`);

    const metadata = { title, artist, album, year, genre, score, source, confidence };
    fs.writeFileSync(debugJSON, JSON.stringify(metadata, null, 2));
    fs.writeFileSync(publicLogPath, JSON.stringify(metadata, null, 2));

    logger.logMatch(metadata);
    logger.updateStats({ source, success: true });
    await logToDB?.(metadata);

    cleanupFiles([filePath, coverPath]);
    return { success: true, message: "Tagged successfully", output: outputPath, metadata };
  } catch (err) {
    logger.error(`❌ [FFmpeg ERROR] ${err}`);
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
  if (!req.files?.length)
    return res.status(400).json({ success: false, message: "No files uploaded" });

  const results = await Promise.all(req.files.map(f => handleTagging(f.path)));
  const taggedFiles = results.filter(r => r.success).map(r => r.output);

  if (!taggedFiles.length)
    return res.status(500).json({ success: false, message: "No files could be tagged." });

  const zipPath = await zipTaggedFiles(taggedFiles); // ✅ fixed usage
  res.download(zipPath, path.basename(zipPath));
}

module.exports = { processFile, processBatch };
