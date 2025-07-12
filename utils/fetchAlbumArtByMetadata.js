// utils/fetchAlbumArtByMetadata.js
const fetch = require("./fetch");
const fetchAlbumArtFromUrl = require("./fetchAlbumArtFromUrl");

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
 * Queries MusicBrainz releases and returns the first successfully
 * fetched front‐cover image via Cover Art Archive.
 */
async function getCoverArtByMetadata(artist = "", _title = "", album = "", year = "") {
  if (!artist || !album) return null;

  // build MusicBrainz search query
  const parts = [
    `artist:"${sanitize(artist)}"`,
    `release:"${sanitize(album)}"`
  ];
  if (year && YEAR_REGEX.test(year)) parts.push(`date:${year}`);

  const searchUrl = `https://musicbrainz.org/ws/2/release` +
                    `?query=${parts.join(" AND ")}` +
                    `&fmt=json&limit=10`;

  try {
    const res = await fetch(searchUrl, {
      headers: { "User-Agent": USER_AGENT }
    });
    const data = await res.json();
    const releases = data.releases || [];
    if (!releases.length) return null;

    // pick best candidate
    let candidate =
      // 1) official & exact year
      releases.find(r =>
        r.status === "Official" &&
        YEAR_REGEX.test(r.date?.slice(0,4)) &&
        r.date.slice(0,4) === year
      ) ||
      // 2) any official
      releases.find(r => r.status === "Official") ||
      // 3) fallback to first
      releases[0];

    const releaseId      = candidate.id;
    const releaseGroupId = candidate["release-group"]?.id;
    const releaseTitle   = candidate.title || album;
    const releaseYear    = candidate.date?.slice(0,4) || year;

    // attempt Cover Art Archive endpoints in order
    const endpoints = [
      `https://coverartarchive.org/release/${releaseId}/front`,
      releaseGroupId && `https://coverartarchive.org/release-group/${releaseGroupId}/front`
    ].filter(Boolean);

    for (const url of endpoints) {
      const art = await fetchAlbumArtFromUrl(url);
      if (art) {
        return {
          coverUrl: art.url,
          release: releaseTitle,
          year: releaseYear
        };
      }
    }

    // if we got here, no art fetched
    console.warn(`⚠️ No valid cover found in CAA for release ${releaseId}`);
    return null;

  } catch (err) {
    console.warn(
      `[fetchAlbumArtByMetadata] Failed lookup for "${artist}" / "${album}": ${err.message}`
    );
    return null;
  }
}

module.exports = { getCoverArtByMetadata };
