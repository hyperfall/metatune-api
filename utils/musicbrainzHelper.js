// utils/musicbrainzHelper.js
const fetch = require("./fetch");

/**
 * Fetch a MusicBrainz recording by its MBID, including releases and release-groups.
 */
async function fetchRecordingByMBID(mbid) {
  if (!mbid) return null;
  const url = `https://musicbrainz.org/ws/2/recording/${mbid}` +
              `?inc=releases+release-groups+tags&fmt=json`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "MetaTune/1.0 (metatune@noctark.ai)" }
    });
    return await res.json();
  } catch (err) {
    console.warn(`[MBID Lookup] Failed to fetch recording ${mbid}: ${err.message}`);
    return null;
  }
}

/**
 * Query MusicBrainz recordings using artist, title, and optional year.
 */
async function searchRecording(artist, title, year = "") {
  let query = `artist:"${artist}" AND recording:"${title}"`;
  if (year && /^\d{4}$/.test(year)) {
    query += ` AND date:${year}`;
  }
  const url = `https://musicbrainz.org/ws/2/recording/` +
              `?query=${encodeURIComponent(query)}&fmt=json&limit=10`;
  const res = await fetch(url, {
    headers: { "User-Agent": "MetaTune/1.0 (metatune@noctark.ai)" }
  });
  const data = await res.json();
  return data.recordings || [];
}

/**
 * Filters out compilations and returns the most relevant release.
 */
function findBestRelease(recording, year = "") {
  if (!recording.releases || !recording.releases.length) return null;

  // 1) Official album releases, non-compilation
  const official = recording.releases.filter(r =>
    r.status === "Official" &&
    r["release-group"]?.["primary-type"] === "Album" &&
    !/hits|best|collection|playlist|various|compilation|nrj/i.test(r.title)
  );

  // 2) If year provided, try exact match
  if (year && official.length) {
    const exact = official.find(r => r.date?.startsWith(year));
    if (exact) return exact;
  }

  // 3) Pick first official, else any album, else first release
  return official[0] ||
         recording.releases.find(r => r["release-group"]?.["primary-type"] === "Album") ||
         recording.releases[0];
}

/**
 * Fetch the front cover art URL for a given release ID.
 */
async function fetchCoverArt(releaseId) {
  if (!releaseId) return null;
  const url = `https://coverartarchive.org/release/${releaseId}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const front = data.images?.find(img => img.front);
    return front?.image || null;
  } catch {
    return null;
  }
}

/**
 * Get album info (name, year, cover URL, MBID) for a recording.
 * If recordingMbid is provided, fetch the exact recording; otherwise use text search.
 */
async function getOfficialAlbumInfo(artist, title, year = "", recordingMbid = "") {
  let recording = null;

  // 1) If we have a recording MBID, fetch that exact recording
  if (recordingMbid) {
    recording = await fetchRecordingByMBID(recordingMbid);
  }

  // 2) Otherwise, search by text
  if (!recording) {
    const recs = await searchRecording(artist, title, year);
    recording = recs[0] || null;
  }

  if (!recording) return null;

  const release = findBestRelease(recording, year);
  if (!release) return null;

  const albumName   = release.title;
  const releaseYear = release.date?.slice(0, 4) || "";
  const coverUrl    = await fetchCoverArt(release.id);

  return {
    album: albumName,
    year: releaseYear,
    coverUrl,
    releaseId: release.id,
    recordingMbid: recording.id,
    releaseGroupMbid: release["release-group"]?.id
  };
}

/**
 * Fallback cover-art search using final metadata.
 * Tries text-search for recordings, then matches album/title.
 */
async function getCoverArtByMetadata(artist, title, album, year = "") {
  const recs = await searchRecording(artist, title, year);
  for (const rec of recs) {
    const release = findBestRelease(rec, year);
    if (!release) continue;
    const matchAlbum = release.title.toLowerCase() === album.toLowerCase()
                    || release.title.toLowerCase().includes(album.toLowerCase());
    if (matchAlbum) {
      const coverUrl = await fetchCoverArt(release.id);
      if (coverUrl) {
        return {
          album: release.title,
          year: release.date?.slice(0, 4) || year,
          coverUrl,
          releaseId: release.id,
          recordingMbid: rec.id
        };
      }
    }
  }
  return null;
}

module.exports = {
  fetchRecordingByMBID,
  searchRecording,
  findBestRelease,
  fetchCoverArt,
  getOfficialAlbumInfo,
  getCoverArtByMetadata
};
