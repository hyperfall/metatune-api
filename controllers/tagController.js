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

// Unicode‐safe cleaner
const clean = s =>
  (s || "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim() || "Unknown";

async function handleTagging(files) {
  const results = [];

  for (const file of files) {
    const original  = file.originalname;
    const inputPath = file.path;
    console.log(`\n[handleTagging] ➤ Starting ${original}`);

    try {
      // 1️⃣ Fingerprint & duration
      const { duration, fingerprint } = await generateFingerprint(inputPath);
      console.log("  🎵 fingerprint ready");

      // 2️⃣ AcoustID lookup
      let rec = null;
      try {
        const ac = await axios.get("https://api.acoustid.org/v2/lookup", {
          params: {
            client:   process.env.ACOUSTID_API_KEY,
            meta:     "recordings+releasegroups+compress",
            fingerprint,
            duration,
          },
        });

        const resultsArr = ac.data.results || [];
        console.log(
          "  🎯 AcoustID scores:",
          resultsArr.map(r => ({ id: r.id, score: r.score, recs: (r.recordings||[]).length }))
        );

        // flatten and choose highest‐score recording
        const scored = [];
        for (const r of resultsArr) {
          (r.recordings || []).forEach(rObj => scored.push({ rec: rObj, score: r.score }));
        }
        if (scored.length) {
          scored.sort((a, b) => b.score - a.score);
          rec = scored[0].rec;
          console.log("  ✅ chosen recording:", rec.id, "score", scored[0].score);
        } else {
          console.warn("  ⚠️ no recordings found in fingerprint results");
        }
      } catch (err) {
        console.warn("  ⚠️ AcoustID error:", err.message);
      }

      // 3️⃣ MB filename fallback if no rec
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
            console.log("  ✅ MB fallback rec:", rec.id);
          }
        } catch (err) {
          console.warn("  ⚠️ MB fallback error:", err.message);
        }
      }

      // 4️⃣ Read embedded tags
      let embedded = {};
      try {
        embedded = await tagReader(inputPath);
        console.log("  📋 embedded tags:", {
          title: embedded.title,
          artist: embedded.artist,
          album: embedded.album,
        });
      } catch (err) {
        console.warn("  ⚠️ tagReader error:", err.message);
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

      console.log("  📦 final meta:", { title, artist, album, year, genre });

      // 6️⃣ Fetch art or fallback
      let image = null;
      if (rg.id) {
        try {
          image = await fetchAlbumArt(rg.id);
          console.log("  🖼️ fetched art for RG", rg.id);
        } catch (err) {
          console.warn("  ⚠️ fetchAlbumArt error:", err.message);
        }
      }
      if (!image && embedded.image) {
        image = embedded.image;
        console.log("  🎨 using embedded art");
      }

      // 7️⃣ Write tags
      await writeTags({ title, artist, album, year, genre, image }, inputPath);
      console.log("  ✅ writeTags succeeded");

      // 8️⃣ Rename file
      const extOut    = path.extname(original) || ".mp3";
      const finalName = `${clean(artist)} - ${clean(title)}${extOut}`;
      const finalPath = path.join(path.dirname(inputPath), finalName);
      fs.renameSync(inputPath, finalPath);
      console.log("  🏷️ renamed to:", finalName);

      results.push(finalPath);
    } catch (err) {
      console.error("  ❌ error processing", original, err);
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
  } catch (err) {
    console.error("processFile error:", err);
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
  } catch (err) {
    console.error("processBatch error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};
