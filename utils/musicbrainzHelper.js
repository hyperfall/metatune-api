// utils/musicbrainzHelper.js
const fetch = require("./fetch");
const fetchAlbumArtFromUrl = require("./fetchAlbumArtFromUrl");

const USER_AGENT = "MetaTune/1.0 (+https://noctark.ai)";
const YEAR_REGEX = /^\d{4}$/;

/**
 * Strip out parentheses, brackets, ®™, etc. to avoid 400s
 * and collapse extra whitespace.
 */
function sanitizeForQuery(str = "") {
  return str
    .replace(/[\[\]\(\)®™]/g, "")   // remove brackets, parens, special symbols
    .replace(/\s{2,}/g, " ")        // collapse multiple spaces
    .trim();
}

/**
 * Fetch a MusicBrainz recording by its MBID (with releases & release-groups).
 */
async function fetchRecordingByMBID(mbid) {
  if (!mbid) return null;
  const url = `https://musicbrainz.org/ws/2/recording/${mbid}` +
              `?inc=releases+release-groups+tags&fmt=json`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    return await res.json();
  } catch (err) {
    console.warn(`[MBID Lookup] Failed to fetch recording ${mbid}: ${err.message}`);
    return null;
  }
}

/**
 * Search MusicBrainz recordings via artist + title + optional year hint.
 */
async function searchRecording(artist, title, year = "") {
  // sanitize inputs
  const safeArtist = sanitizeForQuery(artist);
  const safeTitle  = sanitizeForQuery(title);

  // build query parts
  const parts = [
    `artist:"${safeArtist}"`,
    `recording:"${safeTitle}"`
  ];
  if (year && YEAR_REGEX.test(year)) {
    parts.push(`date:${year}`);
  }

  const query = parts.join(" AND ");
  const url = `https://musicbrainz.org/ws/2/recording/` +
              `?query=${encodeURIComponent(query)}` +
              `&fmt=json&limit=20`;

  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    const data = await res.json();
    return data.recordings || [];
  } catch (err) {
    console.warn(`[Search] Failed for ${artist} / ${title}: ${err.message}`);
    return [];
  }
}

/**
 * From a recording, pick the most appropriate release:
 * 1) Official album (non-compilation), year-matched if possible  
 * 2) Any official album  
 * 3) Any album  
 * 4) First release  
 */
function findBestRelease(recording, year = "") {
  const rels = recording.releases || [];
  const isAlbum = r => r["release-group"]?.["primary-type"] === "Album";
  const notComp = r => !/hits|best|collection|playlist|various|compilation|nrj/i.test(r.title);

  // 1) official, album-type, non-compilation
  const officialAlbums = rels.filter(r =>
    r.status === "Official" &&
    isAlbum(r) &&
    notComp(r)
  );

  // 2) exact year match if possible
  if (year && YEAR_REGEX.test(year)) {
    const exact = officialAlbums.find(r => r.date?.startsWith(year));
    if (exact) return exact;
  }
  if (officialAlbums.length) {
    return officialAlbums[0];
  }

  // 3) any album-type
  const anyAlbum = rels.find(r => isAlbum(r));
  if (anyAlbum) return anyAlbum;

  // 4) fallback to first release
  return rels[0] || null;
}

/**
 * Try both release and release-group Cover Art Archive endpoints.
 * Returns the front-cover URL or null.
 */
async function fetchCoverArt(releaseId, releaseGroupId = null) {
  const endpoints = [
    `https://coverartarchive.org/release/${releaseId}/front`,
    releaseGroupId && `https://coverartarchive.org/release-group/${releaseGroupId}/front`
  ].filter(Boolean);

  for (const url of endpoints) {
    const art = await fetchAlbumArtFromUrl(url);
    if (art?.url) return art.url;
  }
  return null;
}

/**
 * High-level: Get clean album info (name, year, coverUrl, MBIDs).
 * If recordingMbid is given, fetch that exact recording first.
 * Otherwise fall back to text search.
 */
async function getOfficialAlbumInfo(artist, title, year = "", recordingMbid = "") {
  let recording = null;

  // 1) MBID lookup if available
  if (recordingMbid) {
    recording = await fetchRecordingByMBID(recordingMbid);
  }

  // 2) fallback to text search
  if (!recording) {
    const recs = await searchRecording(artist, title, year);
    recording = recs[0] || null;
  }
  if (!recording) return null;

  // 3) pick best release
  const release = findBestRelease(recording, year);
  if (!release) return null;

  const albumName       = release.title;
  const releaseYear     = release.date?.slice(0, 4) || "";
  const coverUrl        = await fetchCoverArt(
    release.id,
    release["release-group"]?.id
  );

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
 * Searches recordings textually, then matches album/title and fetches art.
 */
async function getCoverArtByMetadata(artist, title, album, year = "") {
  const recs = await searchRecording(artist, title, year);
  for (const rec of recs) {
    const release = findBestRelease(rec, year);
    if (!release) continue;

    const relTitle = release.title.toLowerCase();
    const want     = album.toLowerCase();
    if (relTitle === want || relTitle.includes(want)) {
      const coverUrl = await fetchCoverArt(
        release.id,
        release["release-group"]?.id
      );
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
