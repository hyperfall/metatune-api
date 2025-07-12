const fs = require("fs");
const path = require("path");
const { getBestFingerprintMatch } = require("../utils/fingerprint");
const { exec } = require("child_process");

function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 1024 * 1000 }, (err, stdout, stderr) => {
      if (err) return reject(stderr);
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

  const match = await getBestFingerprintMatch(filePath);

  if (!match || !match.recording) {
    return { success: false, message: "Track could not be identified." };
  }

  const r = match.recording;
  const title = sanitize(r.title || baseName);
  const artist = sanitize(r.artist || "Unknown Artist");
  const album = sanitize(r.album || "Unknown Album");
  const year = r.date || "2023";

  const taggedName = `${artist} - ${title}${extension}`;
  const outputPath = path.join(dir, taggedName);

  // Build FFmpeg tag args
  const args = [
    `-i "${filePath}"`,
    `-metadata title="${title}"`,
    `-metadata artist="${artist}"`,
    `-metadata album="${album}"`,
    `-metadata date="${year}"`,
    `-y "${outputPath}"`
  ];

  // Optionally add cover art
  if (r.coverArt) {
    const coverPath = path.join(dir, "cover.jpg");
    try {
      const img = await fetch(r.coverArt);
      const buf = await img.arrayBuffer();
      fs.writeFileSync(coverPath, Buffer.from(buf));
      args.splice(1, 0, `-i "${coverPath}" -map 0 -map 1 -c copy -disposition:v:1 attached_pic`);
    } catch (e) {
      console.warn("Cover art fetch failed:", e.message);
    }
  }

  const ffmpegCmd = `ffmpeg ${args.join(" ")}`;
  await runCommand(ffmpegCmd);

  return {
    success: true,
    message: "File tagged successfully",
    output: outputPath,
    metadata: { title, artist, album, year, source: match.method }
  };
}

module.exports = { processFile };
