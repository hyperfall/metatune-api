// utils/fetchAlbumArt.js
const axios = require("axios");

async function fetchAlbumArt(mbid) {
  const endpoints = [
    `https://coverartarchive.org/release-group/${mbid}`,
    `https://coverartarchive.org/release/${mbid}`
  ];

  for (const url of endpoints) {
    try {
      const resp = await axios.get(url);
      // release-group format
      if (resp.data.images) {
        const front = resp.data.images.find(img => img.front);
        if (!front) throw new Error("No front cover at " + url);
        const imgBuf = await axios.get(front.image, { responseType: "arraybuffer" });
        return {
          mime: "image/jpeg",
          type: { id: 3, name: "front cover" },
          description: "Album Art",
          imageBuffer: Buffer.from(imgBuf.data),
        };
      }
      // release format (rare): image URL at resp.data.image?
      // some release endpoints redirect directly to the image
      if (resp.headers["content-type"]?.startsWith("image/")) {
        return {
          mime: resp.headers["content-type"],
          type: { id: 3, name: "front cover" },
          description: "Album Art",
          imageBuffer: Buffer.from(resp.data),
        };
      }
    } catch (err) {
      // try next endpoint
      console.warn(`CoverArt fetch failed at ${url}:`, err.message);
    }
  }

  return null;
}

module.exports = fetchAlbumArt;
