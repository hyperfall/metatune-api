// utils/fetchAlbumArt.js
const axios = require("axios");

async function fetchAlbumArtFromUrl(url) {
  try {
    const res = await axios.get(url, { responseType: "arraybuffer", timeout: 8000 });

    return {
      mime: res.headers["content-type"] || "image/jpeg",
      imageBuffer: Buffer.from(res.data),
      type: { id: 3, name: "front cover" },
      description: "Album Art",
      url
    };
  } catch (err) {
    const reason = err.response?.status
      ? `HTTP ${err.response.status}`
      : err.message;
    console.warn(`⚠️ Failed to fetch album art from ${url}: ${reason}`);
    return null;
  }
}

module.exports = fetchAlbumArtFromUrl;
