const fs = require('fs');
const { exec } = require('child_process');
const axios = require('axios');
const AcrCloud = require('acrcloud');

const ACOUSTID_API_KEY = process.env.ACOUSTID_API_KEY;
const acr = new AcrCloud({
  host: process.env.ACR_HOST,
  access_key: process.env.ACR_KEY,
  access_secret: process.env.ACR_SECRET,
  timeout: 10000,
});

function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 1024 * 1000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

async function chromaprintFingerprint(filePath) {
  try {
    const output = await runCommand(`fpcalc -json "${filePath}"`);
    const data = JSON.parse(output);
    if (!data.fingerprint || !data.duration) return null;
    return {
      fingerprint: data.fingerprint,
      duration: data.duration
    };
  } catch (err) {
    return null;
  }
}

async function queryAcoustID(fp, duration) {
  try {
    const url = `https://api.acoustid.org/v2/lookup?client=${ACOUSTID_API_KEY}&meta=recordings+releasegroups+compress&fingerprint=${encodeURIComponent(fp)}&duration=${duration}`;
    const res = await axios.get(url);
    const results = res.data.results;
    if (results?.length && results[0].score > 0.8 && results[0].recordings?.length) {
      return {
        method: 'chromaprint',
        score: results[0].score,
        recording: results[0].recordings[0]
      };
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function queryACRCloud(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const res = await acr.identify(buffer);
    if (res?.status?.code === 0 && res.metadata?.music?.length) {
      const track = res.metadata.music[0];
      return {
        method: 'acrcloud',
        score: track.score || 1.0,
        recording: {
          title: track.title,
          artist: track.artists?.map(a => a.name).join(', '),
          album: track.album?.name,
          date: track.release_date?.split('-')[0],
          coverArt: track.album?.images?.[0]?.url || null
        }
      };
    }
    return null;
  } catch (err) {
    console.error("ACRCloud Error:", err.message);
    return null;
  }
}

async function getBestFingerprintMatch(filePath) {
  const chroma = await chromaprintFingerprint(filePath);
  if (chroma) {
    const acoustMatch = await queryAcoustID(chroma.fingerprint, chroma.duration);
    if (acoustMatch) return acoustMatch;
  }

  const acrMatch = await queryACRCloud(filePath);
  if (acrMatch) return acrMatch;

  return null;
}

module.exports = { getBestFingerprintMatch };
