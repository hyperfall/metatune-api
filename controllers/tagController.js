// controllers/tagController.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { generateFingerprint } = require("../utils/fingerprint");
const fetchAlbumArt = require("../utils/fetchAlbumArt");
const { writeTags } = require("../utils/tagWriter");
const { zipTaggedFiles } = require("../utils/zipFiles");
const tagReader = require("../utils/tagReader");

const MB_BASE = "https://musicbrainz.org/ws/2";
const MB_HEADERS = { "User-Agent": "MetaTune/1.0 (contact@metatune.app)" };
const clean = str =>
  (str || "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim() || "Unknown";

async function handleTagging(files) {
  const results = [];

  for (const file of files) {
    const original = file.originalname;
    const inputPath = file.path;
    console.log(`\n[handleTagging] ➤ Processing "${original}"`);

    try {
      const { duration: rawDuration, fingerprint } = await generateFingerprint(inputPath);
      const duration = Math.round(rawDuration);
      console.log(`[handleTagging] fingerprint length: ${fingerprint.length}`);
      console.log(`[handleTagging] duration (rounded): ${duration}`);

      const ACOUSTID_KEY = process.env.ACOUSTID_API_KEY || process.env.ACOUSTID_KEY;
      let rec = null;
      let releaseGroup = null;

      // 🔍 AcoustID lookup
      try {
        const params = new URLSearchParams({
          client: ACOUSTID_KEY,
          format: "json",
          fingerprint,
          duration: duration.toString(),
          meta: "recordings+releasegroups+sources"
        });

        const acoustidRes = await axios.post(
          "https://api.acoustid.org/v2/lookup",
          params.toString(),
          { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
        );

        console.log("[handleTagging] AcoustID raw:", acoustidRes.data);
        const hits = acoustidRes.data.results || [];

        const best = hits
          .flatMap(hit => (hit.recordings || []).map(r => ({ rec: r, score: hit.score, rgs: hit.releasegroups?.length || 0 })))
          .sort((a, b) => b.score - a.score)[0];

        if (best) {
          rec = best.rec;
          console.log("[handleTagging] 🎯 Hit:", {
            id: best.rec.id,
            score: best.score,
            recs: 1,
            rgs: best.rgs
          });
        } else {
          console.log("[handleTagging] 🔍 No strong fingerprint match — fallback engaged.");
        }
      } catch (err) {
        console.warn("[handleTagging] ⚠️ AcoustID lookup failed:", err.message);
      }

      // ⛓️ MusicBrainz fallback if no good recording
      if (!rec) {
        console.log("[handleTagging] 🔍 Filename fallback");
        const ext = path.extname(original);
        const rawName = original.replace(ext, "").trim();
        let [gArtist, gTitle] = rawName.split(" - ");
        if (!gTitle) {
          const tokens = rawName.split(" ");
          gArtist = tokens.shift();
          gTitle = tokens.join(" ");
        }

        try {
          const sr = await axios.get(`${MB_BASE}/recording`, {
            params: { query: `recording:"${gTitle}" AND artist:"${gArtist}"`, fmt: "json", limit: 1 },
            headers: MB_HEADERS,
          });

          const found = sr.data.recordings?.[0];
          if (found?.id) {
            const lu = await axios.get(`${MB_BASE}/recording/${found.id}`, {
              params: { inc: "artists+release-groups+tags", fmt: "json" },
              headers: MB_HEADERS,
            });

            rec = lu.data;
            console.log("[handleTagging] ✅ Filename‐based MB rec:", rec.id);
          }
        } catch (err) {
          console.warn("[handleTagging] ⚠️ MB fallback failed:", err.message);
        }
      }

      // 📖 Read embedded tags
      let embedded = {};
      try {
        embedded = await tagReader(inputPath);
        console.log("[handleTagging] 📋 Embedded tags:", {
          title: embedded.title,
          artist: embedded.artist,
          album: embedded.album
        });
      } catch (err) {
        console.warn("[handleTagging] ⚠️ tagReader failed:", err.message);
      }

      // 🧠 Metadata merge
      const title = rec?.title || embedded.title || "Unknown Title";
      const artist = rec?.["artist-credit"]
        ? rec["artist-credit"].map(a => a.name).join(", ")
        : embedded.artist || "Unknown Artist";

      const releaseGroups = rec?.releasegroups || rec?.["release-groups"] || [];
      const group = releaseGroups[0] || {};
      const album = group.title || embedded.album || "Unknown Album";
      const year = (group["first-release-date"] || group.first_release_date || "").split("-")[0] || embedded.year || "";
      const genre = rec?.tags?.[0]?.name || embedded.genre || "Music";

      console.log("[handleTagging] 📦 Final metadata:", { title, artist, album, year, genre });

      // 🖼️ Cover art
      let image = null;
      if (group.id) {
        try {
          image = await fetchAlbumArt(group.id);
          console.log("[handleTagging] 🖼️ Fetched art for RG", group.id);
        } catch (err) {
          console.warn("[handleTagging] ⚠️ fetchAlbumArt failed:", err.message);
        }
      }

      if (!image && embedded.image) {
        image = embedded.image;
        console.log("[handleTagging] 🎨 Using embedded art");
      }

      // 🏷️ Write tags
      await writeTags({ title, artist, album, year, genre, image }, inputPath);
      console.log("[handleTagging] ✅ writeTags succeeded");

      // 🧾 Rename
      const outExt = path.extname(original) || ".mp3";
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

// Single upload
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

// Batch upload
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
