// utils/fetchAlbumArtByMetadata.js
const fetch = require("node-fetch");

async function fetchAlbumArtByMetadata(artist, title, album) {
  const query = `${artist} ${album}`.replace(/\s+/g, "+").toLowerCase();
  const searchUrl = `https://musicbrainz.org/ws/2/release/?query=artist:${artist} AND release:${album}&fmt=json&limit=5`;

  try {
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': 'MetaTune/1.0 (metatune.app)' }
    });
    const data = await res.json();
    const bestRelease = data.releases?.find(r => r['release-group']) || data.releases?.[0];

    if (!bestRelease) return null;

    const releaseId = bestRelease.id;
    const coverUrl = `https://coverartarchive.org/release/${releaseId}/front`; // fallback: /release-group/:id/front

    return {
      coverUrl,
      release: bestRelease.title,
      year: bestRelease.date?.slice(0, 4) || "",
    };
  } catch (err) {
    console.warn("Cover fetch failed:", err);
    return null;
  }
}

module.exports = { fetchAlbumArtByMetadata };
