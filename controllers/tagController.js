// controllers/tagController.js
const fs        = require("fs");
const path      = require("path");
const axios     = require("axios");
const { generateFingerprint } = require("../utils/fingerprint");
const fetchAlbumArt          = require("../utils/fetchAlbumArt");
const { writeTags }          = require("../utils/tagWriter");
const { zipTaggedFiles }     = require("../utils/zipFiles");
const tagReader              = require("../utils/tagReader");

const MB_BASE    = "https://musicbrainz.org/ws/2";
const MB_HEADERS = { "User-Agent": "MetaTune/1.0 (you@yourdomain.com)" };

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
      const { duration: rawDuration, fingerprint } = await generateFingerprint(inputPath);
      const duration = Math.round(rawDuration);
      console.log(`[handleTagging] fingerprint length: ${fingerprint.length}`);
      console.log(`[handleTagging] duration (rounded): ${duration}`);

      // 2️⃣ AcoustID lookup (w/ recordings+releasegroups)
      const ACOUSTID_KEY = process.env.ACOUSTID_API_KEY || process.env.ACOUSTID_KEY;
      let rec = null, hit = null;

      try {
        const params = new URLSearchParams({
          client:      ACOUSTID_KEY,
          format:      "json",
          fingerprint,
          duration:    duration.toString(),
          meta:        "recordings+releasegroups"
        });

        const ac = await axios.post(
          "https://api.acoustid.org/v2/lookup",
          params.toString(),
          { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
        );

        console.log("[handleTagging] AcoustID raw:", ac.data);
        const hits = ac.data.results || [];
        if (hits.length) {
          hit = hits[0];
          console.log("[handleTagging] 🎯 Hit:", {
            id:    hit.id,
            score: hit.score,
            recs:  (hit.recordings  || []).length,
            rgs:   (hit.releasegroups || []).length
          });

          // 2a. pick best recording if any
          const recs = (hit.recordings || []);
          if (recs.length) {
            // highest‐score is same for all recs in that hit
            rec = recs[0];
            console.log("[handleTagging] ✅ Using recording:", rec.id);
          }
          // 2b. else pick the first release‐group if present
          else if ((hit.releasegroups || []).length) {
            const rg = hit.releasegroups[0];
            rec = {
              id: rg.id,
              title: rg.title,
              "artist-credit": hit.artists || [],
              "release-groups": [rg],
              tags: hit.tags || []
            };
            console.log("[handleTagging] ⚠️ Using release-group fallback:", rg.id);
          }
        }
      } catch (err) {
        console.warn("[handleTagging] ⚠️ AcoustID error:", err.message);
      }

      // 3️⃣ filename → MusicBrainz recording fallback
      if (!rec) {
        console.log("[handleTagging] 🔍 Filename fallback");
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
            params: { query: `recording:"${gTitle}" AND artist:"${gArtist}"`, fmt: "json", limit: 1 },
            headers: MB_HEADERS
          });
          const found = sr.data.recordings?.[0];
          if (found?.id) {
            const lu = await axios.get(`${MB_BASE}/recording/${found.id}`, {
              params: { inc: "artists+release-groups+tags", fmt: "json" },
              headers: MB_HEADERS
            });
            rec = lu.data;
            console.log("[handleTagging] ✅ Filename‐based MB rec:", rec.id);
          }
        } catch (err) {
          console.warn("[handleTagging] ⚠️ Filename MB error:", err.message);
        }
      }

      // 4️⃣ Embedded tags fallback
      let embedded = {};
      try {
        embedded = await tagReader(inputPath);
        console.log("[handleTagging] 📋 Embedded tags:", {
          title:  embedded.title,
          artist: embedded.artist,
          album:  embedded.album
        });
      } catch (err) {
        console.warn("[handleTagging] ⚠️ tagReader failed:", err.message);
      }

      // 5️⃣ Merge into final metadata
      const title  = rec?.title  || embedded.title  || "Unknown Title";
      const artist = rec?.["artist-credit"]
        ? rec["artist-credit"].map(a => a.name).join(", ")
        : embedded.artist || "Unknown Artist";

      // coerce either rec.releasegroups or rec["release-groups"]
      const groups = rec?.releasegroups || rec?.["release-groups"] || [];
      const rg     = groups[0] || {};
      const album  = rg.title || embedded.album || "Unknown Album";
      const year   = (rg["first-release-date"] || rg.first_release_date || "")
                       .split("-")[0] || embedded.year || "";
      const genre  = rec?.tags?.[0]?.name || embedded.genre || "";

      console.log("[handleTagging] 📦 Final metadata:", { title, artist, album, year, genre });

      // 6️⃣ Album art
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

      // 7️⃣ Write tags & art
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
      console.error("[handleTagging] ❌ Error processing", file.originalname, err);
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
