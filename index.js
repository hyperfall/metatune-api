const fs = require('fs');
const path = require('path');
const mm = require('music-metadata');
const fpcalc = require('fpcalc');
const axios = require('axios');
const NodeID3 = require('node-id3');

const ACOUSTID_API_KEY = 'WrNApk27oA';
const FILE_PATH = '12.mp3';

async function getMetadata(filePath) {
  const metadata = await mm.parseFile(filePath);
  const duration = Math.round(metadata.format.duration);
  return duration;
}

async function getFingerprint(filePath) {
  return new Promise((resolve, reject) => {
    fpcalc(filePath, (err, result) => {
      if (err) return reject(err);
      resolve({
        fingerprint: result.fingerprint,
        duration: Math.round(result.duration),
      });
    });
  });
}

async function queryAcoustID(fingerprint, duration) {
  const response = await axios.get('https://api.acoustid.org/v2/lookup', {
    params: {
      client: ACOUSTID_API_KEY,
      fingerprint,
      duration,
      meta: 'recordings+releasegroups',
    },
  });

  if (response.data.status !== 'ok' || response.data.results.length === 0) {
    throw new Error('No match found in AcoustID');
  }

  const id = response.data.results[0].id;
  return id;
}

async function queryMusicBrainz(recordingId) {
  const url = `https://musicbrainz.org/ws/2/recording?query=aid:${recordingId}&fmt=json`;
  const response = await axios.get(url);

  const recording = response.data.recordings?.[0];
  if (!recording) throw new Error('No recording found in MusicBrainz');

  return {
    title: recording.title,
    artist: recording['artist-credit']?.[0]?.name || 'Unknown',
    album: recording['release-list']?.[0]?.title || 'Unknown',
  };
}

async function writeTags(filePath, tags) {
  return new Promise((resolve, reject) => {
    NodeID3.write(tags, filePath, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

async function main() {
  try {
    const { fingerprint, duration } = await getFingerprint(FILE_PATH);
    const acoustId = await queryAcoustID(fingerprint, duration);
    const musicMetadata = await queryMusicBrainz(acoustId);

    console.log('🎵 Metadata Retrieved:', musicMetadata);

    await writeTags(FILE_PATH, {
      title: musicMetadata.title,
      artist: musicMetadata.artist,
      album: musicMetadata.album,
    });

    console.log('✅ Tags written to file.');
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

main();
