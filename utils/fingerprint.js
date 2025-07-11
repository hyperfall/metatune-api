const util = require("util");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const exec = util.promisify(require("child_process").exec);

const CACHE_PATH = path.join(__dirname, "..", "cache", "fingerprintCache.json");

let fingerprintCache = {};

// 🔁 Load cache from disk
const loadCache = () => {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      const raw = fs.readFileSync(CACHE_PATH, "utf-8");
      fingerprintCache = JSON.parse(raw || "{}");
    }
  } catch (err) {
    console.error("⚠️ Failed to load fingerprint cache:", err);
    fingerprintCache = {};
  }
};

// 💾 Save cache to disk
const saveCache = () => {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(fingerprintCache, null, 2));
  } catch (err) {
    console.error("❌ Failed to save fingerprint cache:", err);
  }
};

// 🔒 Generate SHA256 hash of file contents
const hashFile = (filePath) => {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
};

// 🔍 Main fingerprint function
const generateFingerprint = async (inputPath) => {
  if (!Object.keys(fingerprintCache).length) loadCache();

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

    fingerprintCache[fileHash] = result;
    saveCache(); // persist

    return result;
  } finally {
    if (ext !== ".wav" && fs.existsSync(wavPath)) {
      fs.unlinkSync(wavPath);
    }
  }
};

module.exports = { generateFingerprint };
