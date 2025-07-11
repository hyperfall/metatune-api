const { generateFingerprint } = require("../utils/fingerprint");
const { writeTags } = require("../utils/tagWriter");
const axios = require("axios");
const path = require("path");

const SUPPORTED_EXTENSIONS = ['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.aac', '.aiff'];

exports.processFile = async (req, res) => {
  const filePath = req.file?.path;

  if (!filePath) {
    return res.status(400).json({ error: "No file provided" });
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return res.status(415).json({ error: `Unsupported file type: ${ext}` });
  }

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

    const match = response.data?.results?.[0]?.recordings?.[0];

    const tags = {
      title: match?.title || "Unknown Title",
      artist: match?.artists?.[0]?.name || "Unknown Artist",
      album: match?.releasegroups?.[0]?.title || "Unknown Album",
      year: match?.releasegroups?.[0]?.first_release_date?.split("-")[0] || undefined,
    };

    await writeTags(tags, filePath);

    res.json({ success: true, tags, file: path.basename(filePath) });
  } catch (err) {
    console.error("Error in processFile:", err);
    res.status(500).json({
      error: "Tagging failed",
      message: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};
