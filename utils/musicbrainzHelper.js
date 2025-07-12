const fetch = require("./fetch");

/**
 * Query MusicBrainz recordings using artist and title.
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
 * Filters out compilations and returns the most relevant release.
 */
function findBestRelease(recording) {
  if (!recording.releases || !recording.releases.length) return null;

  // Priority: Official + Album + No compilation in title
  const officialAlbums = recording.releases.filter(r =>
    r.status === "Official" &&
    r["release-group"]?.["primary-type"] === "Album" &&
    !/hits|best|collection|playlist|various|compilation|nrj/i.test(r.title)
  );

  if (officialAlbums.length > 0) return officialAlbums[0];

  // Fallback: Any album-type release
  const fallbackAlbum = recording.releases.find(r =>
    r["release-group"]?.["primary-type"] === "Album"
  );

  return fallbackAlbum || recording.releases[0];
}

/**
 * Fetch cover art URL from Cover Art Archive.
 */
async function fetchCoverArt(releaseId) {
  const url = `https://coverartarchive.org/release/${releaseId}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    const frontImage = data.images?.find(img => img.front);
    return frontImage?.image || null;
  } catch (err) {
    return null; // No image found or invalid release
  }
}

/**
 * High-level wrapper to get clean album info from MusicBrainz.
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
    year,
    coverUrl,
    releaseId: release.id
  };
}

module.exports = {
  getOfficialAlbumInfo
};
