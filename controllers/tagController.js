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

// Keep Unicode letters, numbers, spaces, and hyphens
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
    console.log(`\n[handleTagging] ➤ Processing "${original}"`);

    try {
      // 1) Fingerprint + duration
      const { duration, fingerprint } = await generateFingerprint(inputPath);
      console.log("  🎵 fingerprint & duration ready");

      // 2) AcoustID lookup
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

        // Flatten & select best recording
        const scored = [];
        for (const r of resultsArr) {
          (r.recordings || []).forEach(recObj => scored.push({ rec: recObj, score: r.score }));
        }
        if (scored.length) {
          scored.sort((a, b) => b.score - a.score);
          rec = scored[0].rec;
          console.log("  ✅ chosen recording:", rec.id, "score", scored[0].score);
        } else {
          console.warn("  ⚠️ no recordings returned");
        }
      } catch (err) {
        console.warn("  ⚠️ AcoustID lookup error:", err.message);
      }

      // 3) MB filename fallback
      if (!rec) {
        console.log("  🔍 MB fallback search");
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
          const found = sr.data.recordings?.[0];
          if (found?.id) {
            const lu = await axios.get(`${MB_BASE}/recording/${found.id}`, {
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

      // 4) Embedded tags fallback
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

      // 5) Merge metadata
      const title  = rec?.title || embedded.title  || "Unknown Title";
      const artist = rec?.["artist-credit"]
        ? rec["artist-credit"].map(a => a.name).join(", ")
        : (embedded.artist || "Unknown Artist");

      const groups = rec?.releasegroups || rec?.["release-groups"] || [];
      const rg     = groups[0] || {};
      const album  = rg.title || embedded.album || "Unknown Album";
      const year   = (rg["first-release-date"] || rg.first_release_date || "")
                       .split("-")[0] || embedded.year || "";
      const genre  = rec?.tags?.[0]?.name || embedded.genre || "";

      console.log("  📦 final meta:", { title, artist, album, year, genre });

      // 6) Cover art
      let image = null;
      if (rg.id) {
        try {
          image = await fetchAlbumArt(rg.id);
          console.log("  🖼️ fetched art for RG", rg.id);
        } catch (err) {
          console.warn("  ⚠️ art fetch error:", err.message);
        }
      }
      if (!image && embedded.image) {
        image = embedded.image;
        console.log("  🎨 using embedded art");
      }

      // 7) Write tags
      await writeTags({ title, artist, album, year, genre, image }, inputPath);
      console.log("  ✅ writeTags OK");

      // 8) Rename file
      const extOut    = path.extname(original) || ".mp3";
      const finalName = `${clean(artist)} - ${clean(title)}${extOut}`;
      const finalPath = path.join(path.dirname(inputPath), finalName);
      fs.renameSync(inputPath, finalPath);
      console.log("  🏷️ renamed to:", finalName);

      results.push(finalPath);
    } catch (err) {
      console.error("  ❌ processing error:", original, err);
    }
  }

  return results;
}

exports.processFile = async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });
  const [out] = await handleTagging([file]);
  if (!out) return res.status(500).json({ error: "Tagging failed" });
  res.download(out, path.basename(out), err => {
    if (err) {
      console.error("Download error:", err);
      res.status(500).json({ error: "Download failed" });
    }
  });
};

exports.processBatch = async (req, res) => {
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
};
