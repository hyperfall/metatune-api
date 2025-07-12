const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const { getBestFingerprintMatch } = require("../utils/fingerprint");
const fetch = require("../utils/fetch");
const { logMatch, logError, updateStats } = require("../utils/logger");

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

async function processFile(filePath) {
  const extension = path.extname(filePath);
  const baseName = path.basename(filePath, extension);
  const dir = path.dirname(filePath);

  console.log(`🔍 [START] Processing file: ${filePath}`);

  const match = await getBestFingerprintMatch(filePath);

  if (!match || !match.recording) {
    const error = `❌ [MISS] No match found for: ${filePath}`;
    console.warn(error);
    logError(error);
    updateStats({ source: match?.method || "unknown", success: false });
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

  console.log(`✅ [MATCH] Source: ${match.method.toUpperCase()}`);
  console.log(`🎵 Title: ${title}`);
  console.log(`🎤 Artist: ${artist}`);
  console.log(`💽 Album: ${album}`);
  console.log(`📆 Year: ${year}`);
  console.log(`📊 Confidence Score: ${score}`);

  // Build FFmpeg tag args
  const args = [
    `-i "${filePath}"`,
    `-metadata title="${title}"`,
    `-metadata artist="${artist}"`,
    `-metadata album="${album}"`,
    `-metadata date="${year}"`,
    `-y "${outputPath}"`
  ];

  // Optional cover art
  if (r.coverArt) {
    const coverPath = path.join(dir, "cover.jpg");
    try {
      const img = await fetch(r.coverArt);
      const buf = await img.arrayBuffer();
      fs.writeFileSync(coverPath, Buffer.from(buf));
      args.splice(1, 0, `-i "${coverPath}" -map 0 -map 1 -c copy -disposition:v:1 attached_pic`);
      console.log(`🖼️ Cover art embedded: ${r.coverArt}`);
    } catch (e) {
      const error = `⚠️ Failed to fetch cover art for ${filePath}: ${e.message}`;
      console.warn(error);
      logError(error);
    }
  }

  const ffmpegCmd = `ffmpeg ${args.join(" ")}`;
  try {
    await runCommand(ffmpegCmd);
    console.log(`✅ [DONE] Tagged file saved as: ${outputPath}`);
  } catch (err) {
    const error = `❌ [ERROR] FFmpeg failed on ${filePath}: ${err}`;
    console.error(error);
    logError(error);
    updateStats({ source: match.method, success: false });
    return { success: false, message: "Tagging failed." };
  }

  logMatch({
    input_file: filePath,
    output_file: outputPath,
    title,
    artist,
    album,
    year,
    score,
    source: match.method,
    cover_art: r.coverArt || null,
    status: "success"
  });

  updateStats({ source: match.method, success: true });

  return {
    success: true,
    message: "File tagged successfully",
    output: outputPath,
    metadata: { title, artist, album, year, source: match.method, score }
  };
}

module.exports = { processFile };
