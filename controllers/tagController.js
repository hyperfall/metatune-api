// controllers/tagController.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { generateFingerprint } = require("../utils/fingerprint");
const fetchAlbumArt      = require("../utils/fetchAlbumArt");
const { writeTags }      = require("../utils/tagWriter");
const { zipTaggedFiles } = require("../utils/zipFiles");
const tagReader          = require("../utils/tagReader");

const MB_BASE    = "https://musicbrainz.org/ws/2";
const MB_HEADERS = { "User-Agent": "MetaTune/1.0 (you@domain.com)" };

// Unicode-safe cleaner
const clean = str =>
  (str || "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim() || "Unknown";

async function handleTagging(files) {
  const results = [];

  for (const file of files) {
    const original  = file.originalname;
    const inputPath = file.path;
    console.log(`\n[handleTagging] ➤ Processing "${original}"`);

    try {
      // 1️⃣ fingerprint & duration
      const { duration, fingerprint } = await generateFingerprint(inputPath);
      console.log(`[handleTagging] fingerprint length: ${fingerprint.length}`);
      console.log(`[handleTagging] duration: ${duration}`);

      // 2️⃣ AcoustID lookup with debug logs
      const ACOUSTID_KEY = process.env.ACOUSTID_API_KEY || process.env.ACOUSTID_KEY;
      console.log(`[handleTagging] loaded ACOUSTID_API_KEY: ${!!process.env.ACOUSTID_API_KEY}`);
      console.log(`[handleTagging] loaded ACOUSTID_KEY:     ${!!process.env.ACOUSTID_KEY}`);
      console.log(`[handleTagging] calling AcoustID with client=${ACOUSTID_KEY}`);

      let rec = null;
      try {
        const ac = await axios.get("https://api.acoustid.org/v2/lookup", {
          params: {
            client:      ACOUSTID_KEY,
            format:      "json",
            fingerprint,
            duration,
            meta:        "recordings+releasegroups+compress",
          },
        });

        console.log("[handleTagging] AcoustID raw response:", ac.data);

        const hits = ac.data.results || [];
        console.log(
          "[handleTagging] 🎯 AcoustID hits:",
          hits.map(h => ({
            id:    h.id,
            score: h.score,
            recs:  (h.recordings||[]).length
          }))
        );

        // flatten & pick highest-score recording
        const scored = [];
        for (const h of hits) {
          (h.recordings || []).forEach(r => scored.push({ rec: r, score: h.score }));
        }
        if (scored.length) {
          scored.sort((a,b) => b.score - a.score);
          rec = scored[0].rec;
          console.log("[handleTagging] ✅ Best fingerprint match:", rec.id, "score", scored[0].score);
        }
      } catch (err) {
        console.warn(
          "[handleTagging] ⚠️ AcoustID lookup failed:",
          err.response?.status,
          err.response?.data || err.message
        );
      }

      // 3️⃣ MB filename fallback
      if (!rec) {
        console.log("[handleTagging] 🔍 MusicBrainz filename fallback");
        const ext      = path.extname(original) || "";
        const nameOnly = original.replace(ext, "");
        let [gTitle, gArtist] = nameOnly.split(" - ");
        if (!gArtist) {
          const parts = nameOnly.split(" ");
          gTitle = parts.shift();
          gArtist = parts.join(" ");
        }
        try {
          const sr = await axios.get(`${MB_BASE}/recording`, {
            params: {
              query: `recording:"${gTitle}" AND artist:"${gArtist}"`,
              fmt:   "json",
              limit: 1,
            },
            headers: MB_HEADERS,
          });
          const found = sr.data.recordings?.[0];
          if (found?.id) {
            const lu = await axios.get(`${MB_BASE}/recording/${found.id}`, {
              params: { inc: "artists+release-groups+tags", fmt: "json" },
              headers: MB_HEADERS,
            });
            rec = lu.data;
            console.log("[handleTagging] ✅ MB fallback rec:", rec.id);
          }
        } catch (err) {
          console.warn("[handleTagging] ⚠️ MB fallback error:", err.message);
        }
      }

      // 4️⃣ Read embedded tags
      let embedded = {};
      try {
        embedded = await tagReader(inputPath);
        console.log("[handleTagging] 📋 Embedded tags:", {
          title: embedded.title,
          artist: embedded.artist,
          album: embedded.album,
        });
      } catch (err) {
        console.warn("[handleTagging] ⚠️ tagReader failed:", err.message);
      }

      // 5️⃣ Merge metadata
      const title  = rec?.title || embedded.title || "Unknown Title";
      const artist = rec?.["artist-credit"]
        ? rec["artist-credit"].map(a => a.name).join(", ")
        : embedded.artist || "Unknown Artist";

      const groups = rec?.releasegroups || rec?.["release-groups"] || [];
      const rg     = groups[0] || {};
      const album  = rg.title || embedded.album || "Unknown Album";
      const year   = (rg["first-release-date"] || rg.first_release_date || "")
                       .split("-")[0] || embedded.year || "";
      const genre  = rec?.tags?.[0]?.name || embedded.genre || "";

      console.log("[handleTagging] 📦 Final metadata:", { title, artist, album, year, genre });

      // 6️⃣ Fetch album art or fallback
      let image = null;
      if (rg.id) {
        try {
          image = await fetchAlbumArt(rg.id);
          console.log("[handleTagging] 🖼️ Fetched art for RG", rg.id);
        } catch (err) {
          console.warn("[handleTagging] ⚠️ fetchAlbumArt failed:", err.message);
        }
      }
      if (!image && embedded.image) {
        image = embedded.image;
        console.log("[handleTagging] 🎨 Using embedded art");
      }

      // 7️⃣ Write tags + art
      await writeTags({ title, artist, album, year, genre, image }, inputPath);
      console.log("[handleTagging] ✅ writeTags succeeded");

      // 8️⃣ Rename file
      const outExt    = path.extname(original) || ".mp3";
      const finalName = `${clean(artist)} - ${clean(title)}${outExt}`;
      const finalPath = path.join(path.dirname(inputPath), finalName);
      fs.renameSync(inputPath, finalPath);
      console.log("[handleTagging] 🏷️ Renamed to:", finalName);

      results.push(finalPath);
    } catch (err) {
      console.error("[handleTagging] ❌ Error processing", original, err);
    }
  }

  return results;
}

exports.processFile = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const [out] = await handleTagging([req.file]);
    if (!out) return res.status(500).json({ error: "Tagging failed" });
    res.download(out, path.basename(out), err => {
      if (err) {
        console.error("[processFile] Download error:", err);
        res.status(500).json({ error: "Download failed" });
      }
    });
  } catch (err) {
    console.error("[processFile] Internal error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

exports.processBatch = async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "No files uploaded" });
    const tagged = await handleTagging(files);
    if (!tagged.length) return res.status(500).json({ error: "All files failed tagging" });
    const zipPath = await zipTaggedFiles(tagged);
    res.download(zipPath, "metatune-output.zip", err => {
      if (err) {
        console.error("[processBatch] ZIP download error:", err);
        return res.status(500).json({ error: "ZIP download failed" });
      }
      fs.unlinkSync(zipPath);
    });
  } catch (err) {
    console.error("[processBatch] Internal error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};
