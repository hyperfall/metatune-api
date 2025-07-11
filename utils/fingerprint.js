const util = require("util");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const exec = util.promisify(require("child_process").exec);

// 🧠 In-memory cache: { hash: { duration, fingerprint } }
const fingerprintCache = {};

// 🔒 Generate SHA256 hash of file
const hashFile = (filePath) => {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);

    stream.on("data", data => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
};

// 🔍 Generate fingerprint using fpcalc (with cache)
const generateFingerprint = async (inputPath) => {
  const fileHash = await hashFile(inputPath);
  if (fingerprintCache[fileHash]) {
    return fingerprintCache[fileHash];
  }

  const ext = path.extname(inputPath).toLowerCase();
  const wavPath = inputPath.replace(ext, ".wav");

  try {
    if (ext !== ".wav") {
      await exec(`ffmpeg -y -i "${inputPath}" -ar 44100 -ac 2 -f wav "${wavPath}"`);
    }

    const target = ext === ".wav" ? inputPath : wavPath;
    const { stdout } = await exec(`fpcalc "${target}"`);

    const durationMatch = stdout.match(/DURATION=(\d+)/);
    const fingerprintMatch = stdout.match(/FINGERPRINT=(.+)/);

    if (!durationMatch || !fingerprintMatch) {
      throw new Error("Could not extract fingerprint or duration from fpcalc output.");
    }

    const result = {
      duration: parseFloat(durationMatch[1]),
      fingerprint: fingerprintMatch[1],
    };

    fingerprintCache[fileHash] = result; // ⚡ Cache the result

    return result;
  } finally {
    if (ext !== ".wav" && fs.existsSync(wavPath)) {
      fs.unlinkSync(wavPath); // Clean temp WAV
    }
  }
};

module.exports = { generateFingerprint };
