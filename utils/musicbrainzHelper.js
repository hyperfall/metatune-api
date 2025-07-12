const fetch = require("node-fetch");

/**
 * Search MusicBrainz for a recording by artist + title.
 */
async function searchRecording(artist, title) {
  const query = `artist:"${artist}" AND recording:"${title}"`;
  const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&fmt=json&limit=10`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "MetaTune/1.0 (metatune@noctark.ai)"
    }
  });

  const data = await response.json();
  return data.recordings || [];
}

/**
 * Get the best matching release from a recording.
 * Filters out compilations and prioritizes official album releases.
 */
function findBestRelease(recording) {
  if (!recording.releases || recording.releases.length === 0) return null;

  return recording.releases.find(rel =>
    rel.status === "Official" &&
    rel["release-group"] &&
    rel["release-group"]["primary-type"] === "Album" &&
    !/hits|best|collection|playlist|various/i.test(rel.title)
  ) || recording.releases[0];
}

/**
 * Fetch cover art from Cover Art Archive using release ID.
 */
async function fetchCoverArt(releaseId) {
  const url = `https://coverartarchive.org/release/${releaseId}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    const frontImage = data.images.find(img => img.front);
    return frontImage?.image || null;
  } catch (err) {
    return null; // No image found or invalid release
  }
}

/**
 * High-level function to get official album name and cover art
 * from MusicBrainz based on artist + title.
 */
async function getOfficialAlbumInfo(artist, title) {
  const recordings = await searchRecording(artist, title);
  if (!recordings.length) return null;

  const bestRecording = recordings[0];
  const release = findBestRelease(bestRecording);
  if (!release) return null;

  const albumName = release.title;
  const year = release.date?.slice(0, 4);
  const coverUrl = await fetchCoverArt(release.id);

  return {
    album: albumName,
    year: year,
    coverUrl,
    releaseId: release.id
  };
}

module.exports = {
  getOfficialAlbumInfo
};
