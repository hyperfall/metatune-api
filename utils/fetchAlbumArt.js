// utils/fetchAlbumArt.js
const axios = require("axios");

const VALID_IMAGE_MIME = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

async function fetchAlbumArtFromUrl(url) {
  if (!url || typeof url !== "string" || !url.startsWith("http")) {
    console.warn(`⚠️ Invalid or missing album art URL: ${url}`);
    return null;
  }

  try {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 8000,
      headers: {
        "User-Agent": "MetaTune/1.0 (+https://noctark.ai)"
      }
    });

    const mime = res.headers["content-type"]?.toLowerCase() || "image/jpeg";

    if (!VALID_IMAGE_MIME.includes(mime)) {
      console.warn(`⚠️ Skipped unsupported image MIME: ${mime}`);
      return null;
    }

    return {
      mime,
      imageBuffer: Buffer.from(res.data),
      type: { id: 3, name: "front cover" },
      description: "Album Art",
      url
    };
  } catch (err) {
    const reason = err.code === "ECONNABORTED"
      ? "Timeout (8s)"
      : err.response?.status
        ? `HTTP ${err.response.status}`
        : err.message;

    console.warn(`⚠️ Failed to fetch album art from ${url}: ${reason}`);
    return null;
  }
}

module.exports = fetchAlbumArtFromUrl;
