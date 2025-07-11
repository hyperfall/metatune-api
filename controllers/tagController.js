const { generateFingerprint } = require("../utils/fingerprint");
const { writeTags } = require("../utils/tagWriter");
const { fetchAlbumArt } = require("../utils/fetchArt");
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

    const title = match?.title || "Unknown Title";
    const artist = match?.artists?.[0]?.name || "Unknown Artist";
    const album = match?.releasegroups?.[0]?.title || "Unknown Album";
    const year = match?.releasegroups?.[0]?.first_release_date?.split("-")[0] || "";
    const genre = match?.tags?.[0]?.name || "Unknown Genre";

    let image = null;
    const mbid = match?.releasegroups?.[0]?.id;
    if (mbid) {
      try {
        image = await fetchAlbumArt(mbid);
      } catch (err) {
        console.warn(`No album art found for MBID ${mbid}`);
      }
    }

    const tags = {
      title,
      artist,
      album,
      year,
      genre,
      image,
    };

    await writeTags(tags, filePath);

    res.json({ success: true, tags });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Tagging failed", details: err.message });
  }
};
