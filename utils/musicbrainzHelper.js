// utils/musicbrainzHelper.js
const fetch = require("./fetch");
const fetchAlbumArtFromUrl = require("./fetchAlbumArtFromUrl");

const USER_AGENT = "MetaTune/1.0 (+https://noctark.ai)";
const YEAR_REGEX = /^\d{4}$/;

/**
 * Strip out parentheses content, brackets, punctuation, and collapse whitespace.
 */
function sanitizeForQuery(str = "") {
  return str
    .replace(/\([^)]*\)/g, "")        // remove parentheses and their content
    .replace(/[\[\]"'®™]/g, "")      // remove brackets and quotes
    .replace(/[:;—–-]/g, " ")           // convert colons, semicolons, dashes to space
    .replace(/\s{2,}/g, " ")           // collapse multiple spaces
    .trim();
}

/**
 * Internal helper: fetch JSON and retry on 400 by stripping query qualifiers.
 */
async function safeFetchJSON(url, opts = {}, retrySimplified = false) {
  try {
    const res = await fetch(url, { ...opts, headers: { "User-Agent": USER_AGENT } });
    if (res.status === 400 && !retrySimplified) {
      // retry without any query string
      const baseUrl = url.split("?")[0];
      return safeFetchJSON(baseUrl, opts, true);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    throw err;
  }
}

/**
 * Fetch a MusicBrainz recording by its MBID (with releases & release-groups+tags).
 */
async function fetchRecordingByMBID(mbid) {
  if (!mbid) return null;
  const url = `https://musicbrainz.org/ws/2/recording/${mbid}?inc=releases+release-groups+tags&fmt=json`;
  try {
    return await safeFetchJSON(url);
  } catch (err) {
    console.warn(`[MBID Lookup] ${err.message}`);
    return null;
  }
}

/**
 * Search MusicBrainz recordings via artist + title + optional year hint.
 * First tries with the year filter, then without if no results.
 */
async function searchRecording(artist, title, year = "") {
  const safeArtist = sanitizeForQuery(artist);
  const safeTitle  = sanitizeForQuery(title);

  const baseQuery = `artist:"${safeArtist}" AND recording:"${safeTitle}"`;
  const yearQuery = year && YEAR_REGEX.test(year)
    ? `${baseQuery} AND date:${year}`
    : baseQuery;

  // 1) Try with year
  let url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(yearQuery)}&fmt=json&limit=20`;
  let data = await safeFetchJSON(url).catch(() => null);
  let recs = data?.recordings || [];

  // 2) Retry without year if nothing found
  if (recs.length === 0 && year) {
    url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(baseQuery)}&fmt=json&limit=20`;
    data = await safeFetchJSON(url).catch(() => null);
    recs = data?.recordings || [];
  }

  return recs;
}

/**
 * From a recording, pick the most appropriate release:
 * 1) Official album (non-Compilation), year-matched if possible
 * 2) Any official album
 * 3) Any album
 * 4) First release
 */
function findBestRelease(recording, year = "") {
  const rels = recording.releases || [];

  const isAlbum = r => r["release-group"]?.["primary-type"] === "Album";

  // Exclude compilation by title or release-group secondary-types
  const notCompilation = r => {
    const titleBad = /(hits|best|collection|playlist|various|compilation|nrj)/i.test(r.title);
    const secTypes = r["release-group"]?.["secondary-types"] || [];
    const groupBad = secTypes.includes("Compilation");
    return !titleBad && !groupBad;
  };

  // 1) official, album-type, non-compilation
  let candidates = rels.filter(r =>
    r.status === "Official" &&
    isAlbum(r) &&
    notCompilation(r)
  );

  // exact year match
  if (year && YEAR_REGEX.test(year)) {
    const exact = candidates.find(r => r.date?.startsWith(year));
    if (exact) return exact;
  }
  if (candidates.length) return candidates[0];

  // 2) any official album
  candidates = rels.filter(r => r.status === "Official" && isAlbum(r));
  if (candidates.length) return candidates[0];

  // 3) any album
  const anyAlbum = rels.find(r => isAlbum(r));
  if (anyAlbum) return anyAlbum;

  // 4) fallback to first release
  return rels[0] || null;
}

/**
 * Try both release and release-group endpoints for cover art.
 */
async function fetchCoverArt(releaseId, releaseGroupId = null) {
  const endpoints = [
    `https://coverartarchive.org/release/${releaseId}/front`,
    releaseGroupId && `https://coverartarchive.org/release-group/${releaseGroupId}/front`
  ].filter(Boolean);

  for (const url of endpoints) {
    try {
      const art = await fetchAlbumArtFromUrl(url);
      if (art?.url) return art.url;
    } catch (err) {
      console.warn(`[CoverArt] ${err.message}`);
    }
  }
  return null;
}

/**
 * High-level: Get clean album info (name, year, coverUrl, MBIDs).
 * Prioritizes MBID lookup, then falls back to text search.
 */
async function getOfficialAlbumInfo(artist, title, year = "", recordingMbid = "") {
  let recording = null;

  // MBID-first
  if (recordingMbid) {
    recording = await fetchRecordingByMBID(recordingMbid);
  }

  // fallback to text search
  if (!recording) {
    const recs = await searchRecording(artist, title, year);
    recording = recs[0] || null;
  }
  if (!recording) return null;

  const release = findBestRelease(recording, year);
  if (!release) return null;

  const album       = release.title;
  const releaseYear = release.date?.slice(0, 4) || "";
  const coverUrl    = await fetchCoverArt(
    release.id,
    release["release-group"]?.id
  );

  return {
    album,
    year: releaseYear,
    coverUrl,
    releaseId: release.id,
    recordingMbid: recording.id,
    releaseGroupMbid: release["release-group"]?.id
  };
}

/**
 * Fallback cover-art search using metadata only.
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
