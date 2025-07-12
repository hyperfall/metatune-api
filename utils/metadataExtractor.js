const { exec } = require("child_process");
const path = require("path");

function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 500 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || stdout);
      resolve(stdout.trim());
    });
  });
}

async function extractOriginalMetadata(filePath) {
  const cmd = `ffprobe -v quiet -print_format json -show_format "${filePath}"`;
  try {
    const rawOutput = await runCommand(cmd);
    const parsed = JSON.parse(rawOutput);

    const tags = parsed.format?.tags || {};
    return {
      title: tags.title || "",
      artist: tags.artist || "",
      album: tags.album || "",
      year: tags.date || tags.year || "",
      genre: tags.genre || ""
    };
  } catch (err) {
    console.warn(`[metadataExtractor] Failed to read metadata from ${filePath}: ${err}`);
    return {
      title: "",
      artist: "",
      album: "",
      year: "",
      genre: ""
    };
  }
}

module.exports = { extractOriginalMetadata };
