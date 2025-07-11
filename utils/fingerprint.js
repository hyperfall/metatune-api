// utils/fingerprint.js
const util    = require("util");
const crypto  = require("crypto");
const fs      = require("fs");
const path    = require("path");
const exec    = util.promisify(require("child_process").exec);

const CACHE_DIR  = path.join(__dirname, "..", "cache");
const CACHE_PATH = path.join(CACHE_DIR, "fingerprintCache.json");

let fingerprintCache = {};

// 👷‍♀️ Ensure cache folder & load on startup
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
try {
  if (fs.existsSync(CACHE_PATH)) {
    fingerprintCache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8") || "{}");
  }
} catch (err) {
  console.error("⚠️ Could not load fingerprint cache:", err);
  fingerprintCache = {};
}

// 💾 Persist cache
function saveCache() {
  try {
    fs.writeFileSync(CACHE_PATH,
      JSON.stringify(fingerprintCache, null, 2),
      "utf-8"
    );
  } catch (err) {
    console.error("❌ Could not save fingerprint cache:", err);
  }
}

// 🔒 Compute SHA256 of the file
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(filePath);
    s.on("data", chunk => h.update(chunk));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

/**
 * Generate a chromaprint fingerprint & duration for any supported audio file.
 * Uses `fpcalc -json` so no manual ffmpeg conversion is needed.
 */
async function generateFingerprint(inputPath) {
  // 1. Hash for caching
  const fileHash = await hashFile(inputPath);
  if (fingerprintCache[fileHash]) {
    return fingerprintCache[fileHash];
  }

  // 2. Call fpcalc in JSON mode
  let fpData;
  try {
    // -json output; omit -length to let fpcalc pick full duration
    const { stdout } = await exec(`fpcalc -json "${inputPath}"`);
    fpData = JSON.parse(stdout);
  } catch (err) {
    throw new Error("fpcalc failed: " + err.message);
  }

  if (!fpData.fingerprint || typeof fpData.duration !== "number") {
    throw new Error("fpcalc did not return fingerprint + duration");
  }

  // 3. Cache & return
  const result = {
    duration:    fpData.duration,
    fingerprint: fpData.fingerprint,
  };

  fingerprintCache[fileHash] = result;
  saveCache();
  return result;
}

module.exports = { generateFingerprint };
