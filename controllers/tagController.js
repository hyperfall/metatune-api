// controllers/tagController.js

const axios = require("axios");
const { generateFingerprint } = require("../utils/fingerprint");
const { writeTags } = require("../utils/tagWriter");

const ACOUSTID_KEY = process.env.ACOUSTID_API_KEY;
const MB_BASE = "https://musicbrainz.org/ws/2";

exports.processFile = async (req, res) => {
  const filePath = req.file.path;
  let finalTags = {};

  try {
    console.log(`\n[handleTagging] ➤ Processing "${req.file.originalname}"`);

    const { duration, fingerprint } = await generateFingerprint(filePath);
    console.log("[handleTagging] fingerprint length:", fingerprint.length);
    console.log("[handleTagging] duration (rounded):", duration);

    const acoustIdRes = await axios.get("https://api.acoustid.org/v2/lookup", {
      params: {
        client: ACOUSTID_KEY,
        duration: Math.round(duration),
        fingerprint,
        meta: "recordings+releasegroups+compress",
        format: "json",
      },
    });

    const results = acoustIdRes.data.results || [];
    const hits = results.filter(r => r.score > 0.8);
    let rec = hits[0]?.recordings?.[0];

    console.log("[handleTagging] AcoustID raw:", JSON.stringify(acoustIdRes.data, null, 2));

    if (!rec && hits[0]?.id) {
      console.log("[handleTagging] 🔍 No strong fingerprint match — fallback engaged.");
      const acoustidTrackId = hits[0].id;

      const trackDetails = await axios.get("https://api.acoustid.org/v2/lookup", {
        params: {
          client: ACOUSTID_KEY,
          trackid: acoustidTrackId,
          meta: "recordings+releasegroups+compress",
          format: "json",
        }
      });

      if (trackDetails.data.results?.[0]?.recordings?.length) {
        rec = trackDetails.data.results[0].recordings[0];
        console.log("[handleTagging] ✅ Resolved MB recording via trackid:", rec.id);
      } else {
        console.log("[handleTagging] ❌ Still no MB recording found via trackid.");
      }
    }

    let tags = {
      title: rec?.title || "Unknown Title",
      artist: rec?.artists?.[0]?.name || "Unknown Artist",
      album: rec?.releasegroups?.[0]?.title || "Unknown Album",
    };

    finalTags = await writeTags(tags, filePath);

    res.json({ success: true, tags: finalTags });
  } catch (err) {
    console.error("[handleTagging] ❌ Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};
