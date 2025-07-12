// utils/fetchAlbumArt.js
const axios = require("axios");

async function fetchAlbumArt(mbid) {
  const endpoints = [
    `https://coverartarchive.org/release-group/${mbid}`,
    `https://coverartarchive.org/release/${mbid}`
  ];

  for (const url of endpoints) {
    try {
      const resp = await axios.get(url, { timeout: 8000 });

      // 1. release-group format
      if (resp.data.images) {
        const front = resp.data.images.find(img => img.front && img.image);
        if (!front) throw new Error("No usable front cover found");

        const imgBuf = await axios.get(front.image, { responseType: "arraybuffer" });
        return {
          mime: "image/jpeg",
          type: { id: 3, name: "front cover" },
          description: "Album Art",
          imageBuffer: Buffer.from(imgBuf.data),
          url: front.image
        };
      }

      // 2. fallback: direct image
      if (resp.headers["content-type"]?.startsWith("image/")) {
        return {
          mime: resp.headers["content-type"],
          type: { id: 3, name: "front cover" },
          description: "Album Art",
          imageBuffer: Buffer.from(resp.data),
          url: url
        };
      }

    } catch (err) {
      const reason = err.response?.status
        ? `HTTP ${err.response.status}`
        : err.message;
      console.warn(`⚠️ CoverArt fetch failed at ${url}: ${reason}`);
    }
  }

  return null;
}

module.exports = fetchAlbumArt;
