const fetch = require("./fetch");

/**
 * Query MusicBrainz recordings using artist, title, and optional year.
 */
async function searchRecording(artist, title, year = "") {
  let query = `artist:"${artist}" AND recording:"${title}"`;
  if (year && /^\d{4}$/.test(year)) {
    query += ` AND date:${year}`;
  }

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
function findBestRelease(recording, year = "") {
  if (!recording.releases || !recording.releases.length) return null;

  // Filter to albums that are official, not compilations
  const filtered = recording.releases.filter(r =>
    r.status === "Official" &&
    r["release-group"]?.["primary-type"] === "Album" &&
    !/hits|best|collection|playlist|various|compilation|nrj/i.test(r.title)
  );

  // Prioritize exact year match if available
  if (year && /^\d{4}$/.test(year)) {
    const exactYear = filtered.find(r => r.date?.startsWith(year));
    if (exactYear) return exactYear;
  }

  return filtered[0] ||
         recording.releases.find(r => r["release-group"]?.["primary-type"] === "Album") ||
         recording.releases[0];
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
    return null;
  }
}

/**
 * Get clean album info including cover from MusicBrainz with year matching.
 */
async function getOfficialAlbumInfo(artist, title, year = "") {
  const recordings = await searchRecording(artist, title, year);
  if (!recordings.length) return null;

  const bestRecording = recordings[0];
  const release = findBestRelease(bestRecording, year);
  if (!release) return null;

  const albumName = release.title;
  const releaseYear = release.date?.slice(0, 4);
  const coverUrl = await fetchCoverArt(release.id);

  return {
    album: albumName,
    year: releaseYear,
    coverUrl,
    releaseId: release.id
  };
}

/**
 * Cover art fallback using artist, title, album and optional year
 */
async function getCoverArtByMetadata(artist, title, album, year = "") {
  const recordings = await searchRecording(artist, title, year);
  for (const rec of recordings) {
    const release = findBestRelease(rec, year);
    if (!release) continue;

    const match = release.title.toLowerCase() === album.toLowerCase() ||
                  release.title.toLowerCase().includes(album.toLowerCase());

    if (match) {
      const coverUrl = await fetchCoverArt(release.id);
      if (coverUrl) {
        return {
          album: release.title,
          year: release.date?.slice(0, 4),
          coverUrl,
          releaseId: release.id
        };
      }
    }
  }

  return null;
}

module.exports = {
  getOfficialAlbumInfo,
  searchRecording,
  findBestRelease,
  fetchCoverArt,
  getCoverArtByMetadata
};
