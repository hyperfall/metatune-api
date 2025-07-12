// utils/fetchAlbumArt.js
const axios = require("axios");

const VALID_IMAGE_MIME = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const USER_AGENT = "MetaTune/1.0 (+https://noctark.ai)";

/**
 * Fetch album art from a given URL. Supports:
 *  - Direct image URLs
 *  - Cover Art Archive JSON endpoints (/release/:id or /release-group/:id)
 */
async function fetchAlbumArtFromUrl(url) {
  if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    console.warn(`⚠️ Invalid or missing album art URL: ${url}`);
    return null;
  }

  try {
    // 1) Fetch raw data (may be image or JSON)
    const resp = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 8000,
      headers: { "User-Agent": USER_AGENT }
    });

    const contentType = (resp.headers["content-type"] || "").toLowerCase();

    // 2) If it's a direct image, return it
    if (VALID_IMAGE_MIME.includes(contentType)) {
      return {
        mime: contentType,
        imageBuffer: Buffer.from(resp.data),
        type: { id: 3, name: "front cover" },
        description: "Album Art",
        url
      };
    }

    // 3) If it's JSON (Cover Art Archive), parse and fetch front image
    if (contentType.includes("application/json")) {
      let json;
      try {
        json = JSON.parse(resp.data.toString("utf-8"));
      } catch {
        console.warn(`⚠️ Failed to parse JSON from ${url}`);
        return null;
      }

      const front = json.images?.find(img => img.front && img.image);
      if (!front?.image) {
        console.warn(`⚠️ No front-image entry in JSON from ${url}`);
        return null;
      }

      // 4) Fetch the front image itself
      const imgResp = await axios.get(front.image, {
        responseType: "arraybuffer",
        timeout: 8000,
        headers: { "User-Agent": USER_AGENT }
      });
      const imgMime = (imgResp.headers["content-type"] || "").toLowerCase();
      if (!VALID_IMAGE_MIME.includes(imgMime)) {
        console.warn(`⚠️ Unsupported image MIME from ${front.image}: ${imgMime}`);
        return null;
      }

      return {
        mime: imgMime,
        imageBuffer: Buffer.from(imgResp.data),
        type: { id: 3, name: "front cover" },
        description: front.comment || "Album Art",
        url: front.image
      };
    }

    // 4) Unrecognized content-type
    console.warn(`⚠️ Unexpected content-type for album art (${contentType}) at ${url}`);
    return null;

  } catch (err) {
    let reason;
    if (err.code === "ECONNABORTED") {
      reason = "Timeout (8s)";
    } else if (err.response?.status) {
      reason = `HTTP ${err.response.status}`;
    } else {
      reason = err.message;
    }
    console.warn(`⚠️ Failed to fetch album art from ${url}: ${reason}`);
    return null;
  }
}

module.exports = fetchAlbumArtFromUrl;
