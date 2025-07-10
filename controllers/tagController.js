const { generateFingerprint } = require("../utils/fingerprint");
const { writeTags } = require("../utils/tagWriter");
const axios = require("axios");

exports.processFile = async (req, res) => {
  const filePath = req.file.path;

  try {
    const { duration, fingerprint } = await generateFingerprint(filePath);

    const response = await axios.get("https://api.acoustid.org/v2/lookup", {
      params: {
        client: process.env.ACOUSTID_API_KEY,
        meta: "recordings+releasegroups+compress",
        fingerprint,
        duration,
      },
    });

    const match = response.data.results[0]?.recordings?.[0];
    const tags = {
      title: match?.title || "Unknown Title",
      artist: match?.artists?.[0]?.name || "Unknown Artist",
      album: match?.releasegroups?.[0]?.title || "Unknown Album",
    };

    await writeTags(tags, filePath);

    res.json({ success: true, tags });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Tagging failed", details: err.message });
  }
};

