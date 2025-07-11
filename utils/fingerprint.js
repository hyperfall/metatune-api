const util = require('util');
const exec = util.promisify(require('child_process').exec);
const path = require('path');
const fs = require('fs');

const runFpcalc = async (inputPath) => {
  const ext = path.extname(inputPath).toLowerCase();
  const wavPath = inputPath.replace(ext, '.wav');

  // Convert to WAV if not already WAV
  if (ext !== '.wav') {
    await exec(`ffmpeg -y -i "${inputPath}" -ar 44100 -ac 2 -f wav "${wavPath}"`);
  }

  const target = ext === '.wav' ? inputPath : wavPath;
  const { stdout } = await exec(`fpcalc "${target}"`);

  if (ext !== '.wav') fs.unlinkSync(wavPath);

  return {
    duration: parseFloat(stdout.match(/DURATION=(\d+)/)?.[1] || '0'),
    fingerprint: stdout.match(/FINGERPRINT=(.+)/)?.[1],
  };
};

module.exports = { runFpcalc };
