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

// Unicode‐safe cleaner: letters, numbers, spaces, hyphens
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
    console.log(`\n[handleTagging] ➤ ${original}`);

    try {
      // 1️⃣ fingerprint & duration (no ffmpeg here)
      const { duration, fingerprint } = await generateFingerprint(inputPath);
      console.log("  🎵 fingerprint & duration ready");

      // 2️⃣ AcoustID lookup
      let rec = null;
      try {
        const ac = await axios.get("https://api.acoustid.org/v2/lookup", {
          params: {
            client:    process.env.ACOUSTID_API_KEY,
            meta:      "recordings+releasegroups+compress",
            fingerprint,
            duration,
          },
        });

        const hits = ac.data.results || [];
        console.log(
          "  🎯 AcoustID hits:",
          hits.map(h => ({ id: h.id, score: h.score, recs: (h.recordings||[]).length }))
        );

        // flatten & pick best
        const scored = [];
        for (const h of hits) {
          (h.recordings || []).forEach(r => scored.push({ rec: r, score: h.score }));
        }
        if (scored.length) {
          scored.sort((a,b)=>b.score - a.score);
          rec = scored[0].rec;
          console.log("  ✅ selected recording:", rec.id, "score", scored[0].score);
        }
      } catch (e) {
        console.warn("  ⚠️ AcoustID lookup failed:", e.message);
      }

      // 3️⃣ fallback to MusicBrainz filename search
      if (!rec) {
        console.log("  🔍 MB filename fallback");
        const ext      = path.extname(original) || "";
        const nameOnly = original.replace(ext, "");
        let [gT, gA]   = nameOnly.split(" - ");
        if (!gA) {
          const parts = nameOnly.split(" ");
          gT = parts.shift();
          gA = parts.join(" ");
        }
        try {
          const sr = await axios.get(`${MB_BASE}/recording`, {
            params: { query: `recording:"${gT}" AND artist:"${gA}"`, fmt: "json", limit: 1 },
            headers: MB_HEADERS,
          });
          const f = sr.data.recordings?.[0];
          if (f?.id) {
            const lu = await axios.get(`${MB_BASE}/recording/${f.id}`, {
              params: { inc: "artists+release-groups+tags", fmt: "json" },
              headers: MB_HEADERS,
            });
            rec = lu.data;
            console.log("  ✅ MB rec:", rec.id);
          }
        } catch (e) {
          console.warn("  ⚠️ MB fallback error:", e.message);
        }
      }

      // 4️⃣ embedded tags
      let embedded = {};
      try {
        embedded = await tagReader(inputPath);
        console.log("  📋 embedded tags:", {
          title: embedded.title,
          artist: embedded.artist,
          album: embedded.album,
        });
      } catch (e) {
        console.warn("  ⚠️ tagReader failed:", e.message);
      }

      // 5️⃣ merge metadata
      const title  = rec?.title || embedded.title || "Unknown Title";
      const artist = rec?.["artist-credit"]
        ? rec["artist-credit"].map(a=>a.name).join(", ")
        : (embedded.artist || "Unknown Artist");

      const groups = rec?.releasegroups || rec?.["release-groups"] || [];
      const rg     = groups[0] || {};
      const album  = rg.title || embedded.album || "Unknown Album";
      const year   = (rg["first-release-date"]||rg.first_release_date||"").split("-")[0]
                       || embedded.year || "";
      const genre  = rec?.tags?.[0]?.name || embedded.genre || "";

      console.log("  📦 final meta:", { title, artist, album, year, genre });

      // 6️⃣ cover art
      let image = null;
      if (rg.id) {
        try {
          image = await fetchAlbumArt(rg.id);
          console.log("  🖼️ fetched art for RG", rg.id);
        } catch (e) {
          console.warn("  ⚠️ fetchAlbumArt failed:", e.message);
        }
      }
      if (!image && embedded.image) {
        image = embedded.image;
        console.log("  🎨 fallback embedded art");
      }

      // 7️⃣ write tags + art
      await writeTags({ title, artist, album, year, genre, image }, inputPath);
      console.log("  ✅ writeTags succeeded");

      // 8️⃣ rename file
      const outExt    = path.extname(original) || ".mp3";
      const finalName = `${clean(artist)} - ${clean(title)}${outExt}`;
      const finalPath = path.join(path.dirname(inputPath), finalName);
      fs.renameSync(inputPath, finalPath);
      console.log("  🏷️ renamed to:", finalName);

      results.push(finalPath);
    } catch (e) {
      console.error("  ❌ error processing:", original, e);
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
        console.error("Download error:", err);
        res.status(500).json({ error: "Download failed" });
      }
    });
  } catch (e) {
    console.error("processFile error:", e);
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
        console.error("ZIP download error:", err);
        return res.status(500).json({ error: "ZIP download failed" });
      }
      fs.unlinkSync(zipPath);
    });
  } catch (e) {
    console.error("processBatch error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
};
