const axios = require("axios");

exports.fetchAlbumArt = async (mbid) => {
  try {
    const response = await axios.get(`https://coverartarchive.org/release-group/${mbid}`);
    const front = response.data.images?.find(img => img.front);
    if (!front) throw new Error("No front cover found");

    const imageRes = await axios.get(front.image, { responseType: "arraybuffer" });

    return {
      mime: "image/jpeg",
      type: { id: 3, name: "front cover" },
      description: "Album Art",
      imageBuffer: Buffer.from(imageRes.data),
    };
  } catch (err) {
    console.warn("Album art fetch failed:", err.message);
    return null;
  }
};
