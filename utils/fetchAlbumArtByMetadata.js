// utils/fetchAlbumArtByMetadata.js
const fetch = require("./fetch");

const USER_AGENT = "MetaTune/1.0 (+https://metatune.app)";
const YEAR_REGEX = /^\d{4}$/;

function sanitize(str) {
  return encodeURIComponent(
    str
      ?.replace(/[^\w\s-]/g, "")   // strip punctuation except hyphens
      .trim()
      .replace(/\s+/g, " ")        // collapse spaces
  );
}

/**
 * Fallback cover-art search using artist, album, and optional year.
 * Queries MusicBrainz releases and returns the front‐cover URL.
 */
async function getCoverArtByMetadata(artist = "", title = "", album = "", year = "") {
  if (!artist || !album) return null;

  const queryParts = [
    `artist:"${sanitize(artist)}"`,
    `release:"${sanitize(album)}"`
  ];
  if (year && YEAR_REGEX.test(year)) {
    queryParts.push(`date:${year}`);
  }

  const searchUrl = `https://musicbrainz.org/ws/2/release/` +
                    `?query=${queryParts.join(" AND ")}` +
                    `&fmt=json&limit=5`;

  try {
    const res = await fetch(searchUrl, {
      headers: { "User-Agent": USER_AGENT }
    });
    const data = await res.json();
    const releases = data.releases || [];
    if (!releases.length) return null;

    // 1) Prefer Official releases matching the year
    let best = releases.find(r =>
      r.status === "Official" &&
      YEAR_REGEX.test(r.date?.slice(0,4)) &&
      r.date.slice(0,4) === year
    );
    // 2) Else pick any Official release
    if (!best) {
      best = releases.find(r => r.status === "Official");
    }
    // 3) Else first release in list
    if (!best) {
      best = releases[0];
    }

    const releaseId = best.id;
    const coverUrl = `https://coverartarchive.org/release/${releaseId}/front`;

    return {
      coverUrl,
      release: best.title || album,
      year: best.date?.slice(0,4) || year
    };
  } catch (err) {
    console.warn(
      `[fetchAlbumArtByMetadata] Failed to fetch for "${artist}" / "${album}": ${err.message}`
    );
    return null;
  }
}

module.exports = { getCoverArtByMetadata };
