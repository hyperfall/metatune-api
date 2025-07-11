const util = require("util");
const exec = util.promisify(require("child_process").exec);
const path = require("path");
const fs = require("fs");

// 🔍 Generate AcoustID fingerprint from any supported audio file
const generateFingerprint = async (inputPath) => {
  const ext = path.extname(inputPath).toLowerCase();
  const wavPath = inputPath.replace(ext, ".wav");

  try {
    // Convert to WAV if necessary
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

    return {
      duration: parseFloat(durationMatch[1]),
      fingerprint: fingerprintMatch[1],
    };
  } finally {
    if (ext !== ".wav" && fs.existsSync(wavPath)) {
      fs.unlinkSync(wavPath); // Cleanup temporary WAV
    }
  }
};

module.exports = { generateFingerprint };
