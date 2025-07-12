// utils/fetchAlbumArtByMetadata.js
const fetch = require("./fetch");

function sanitize(str) {
  return encodeURIComponent(str?.replace(/[^\w\s]/gi, "").trim());
}

async function getCoverArtByMetadata(artist = "", title = "", album = "", year = "") {
  if (!artist || !album) return null;

  const queryParts = [
    `artist:${sanitize(artist)}`,
    `release:${sanitize(album)}`,
  ];

  if (year && /^\d{4}$/.test(year)) {
    queryParts.push(`date:${year}`);
  }

  const query = queryParts.join(" AND ");
  const searchUrl = `https://musicbrainz.org/ws/2/release/?query=${query}&fmt=json&limit=5`;

  try {
    const res = await fetch(searchUrl, {
      headers: { "User-Agent": "MetaTune/1.0 (https://metatune.app)" }
    });

    const data = await res.json();
    const releases = data?.releases || [];

    if (!releases.length) return null;

    const bestRelease = releases.find(r => r["release-group"]) || releases[0];
    const releaseId = bestRelease.id;

    const coverUrl = `https://coverartarchive.org/release/${releaseId}/front`;

    return {
      coverUrl,
      release: bestRelease.title || album,
      year: bestRelease.date?.slice(0, 4) || year || "",
    };
  } catch (err) {
    console.warn(`[CoverFetch] Failed for ${artist} - ${album}:`, err.message);
    return null;
  }
}

module.exports = { getCoverArtByMetadata };
