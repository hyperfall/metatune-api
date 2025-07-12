// utils/fetchAlbumArtByMetadata.js
const fetch = require("./fetch");

function sanitizeForQuery(str) {
  return encodeURIComponent(str?.replace(/[^\w\s]/gi, "").trim());
}

async function getCoverArtByMetadata(artist = "", title = "", album = "") {
  if (!artist || !album) return null;

  const query = `artist:${sanitizeForQuery(artist)} AND release:${sanitizeForQuery(album)}`;
  const searchUrl = `https://musicbrainz.org/ws/2/release/?query=${query}&fmt=json&limit=5`;

  try {
    const res = await fetch(searchUrl, {
      headers: { "User-Agent": "MetaTune/1.0 (https://metatune.app)" }
    });

    const data = await res.json();
    const releases = data?.releases || [];

    if (!releases.length) return null;

    // Prefer non-compilations and releases with cover art info
    const bestRelease = releases.find(r => r["release-group"]) || releases[0];
    const releaseId = bestRelease.id;
    const releaseGroupId = bestRelease["release-group"]?.id;

    // Try release cover first, then fallback to release-group
    const coverUrl = `https://coverartarchive.org/release/${releaseId}/front`;

    return {
      coverUrl,
      release: bestRelease.title || album,
      year: bestRelease.date?.slice(0, 4) || "",
    };
  } catch (err) {
    console.warn(`[CoverFetch] Failed for ${artist} - ${album}:`, err.message);
    return null;
  }
}

module.exports = { getCoverArtByMetadata };
