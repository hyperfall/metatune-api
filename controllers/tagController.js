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

// Keeps Unicode letters, numbers, spaces, and hyphens
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
    console.log(`\n[handleTagging] ➤ ${original}`);

    try {
      // 1️⃣ Generate fingerprint & duration
      const { duration, fingerprint } = await generateFingerprint(inputPath);
      console.log("  🎵 Fingerprint & duration obtained");

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
          "  🎯 AcoustID results:",
          resultsArr.map(r => ({ id: r.id, score: r.score, count: (r.recordings||[]).length }))
        );

        // Flatten all recordings with their parent score
        const scored = [];
        for (const r of resultsArr) {
          (r.recordings || []).forEach(recObj => scored.push({ rec: recObj, score: r.score }));
        }

        if (scored.length) {
          // Pick the highest‐score recording
          scored.sort((a, b) => b.score - a.score);
          rec = scored[0].rec;
          console.log("  ✅ Selected recording:", rec.id, "score", scored[0].score);
        } else {
          console.warn("  ⚠️ No recordings returned by AcoustID");
        }
      } catch (err) {
        console.warn("  ⚠️ AcoustID lookup failed:", err.message);
      }

      // 3️⃣ Fallback: MusicBrainz filename search if no rec
      if (!rec) {
        console.log("  🔍 MusicBrainz filename fallback");
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
            headers: MB_HEADERS,
          });
          const found = sr.data.recordings?.[0];
          if (found?.id) {
            const lu = await axios.get(`${MB_BASE}/recording/${found.id}`, {
              params: { inc: "artists+release-groups+tags", fmt: "json" },
              headers: MB_HEADERS,
            });
            rec = lu.data;
            console.log("  ✅ MusicBrainz fallback recording:", rec.id);
          }
        } catch (err) {
          console.warn("  ⚠️ MusicBrainz fallback failed:", err.message);
        }
      }

      // 4️⃣ Read embedded tags
      let embedded = {};
      try {
        embedded = await tagReader(inputPath);
        console.log("  📋 Embedded tags:", {
          title: embedded.title,
          artist: embedded.artist,
          album: embedded.album,
        });
      } catch (err) {
        console.warn("  ⚠️ tagReader failed:", err.message);
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

      console.log("  📦 Final metadata:", { title, artist, album, year, genre });

      // 6️⃣ Fetch album art (or fallback to embedded)
      let image = null;
      if (rg.id) {
        try {
          image = await fetchAlbumArt(rg.id);
          console.log("  🖼️ Fetched art for release-group:", rg.id);
        } catch (err) {
          console.warn("  ⚠️ fetchAlbumArt failed:", err.message);
        }
      }
      if (!image && embedded.image) {
        image = embedded.image;
        console.log("  🎨 Falling back to embedded art");
      }

      // 7️⃣ Write tags + art
      await writeTags({ title, artist, album, year, genre, image }, inputPath);
      console.log("  ✅ Tags & cover art written");

      // 8️⃣ Rename file to “Artist - Title.ext”
      const outExt    = path.extname(original) || ".mp3";
      const finalName = `${clean(artist)} - ${clean(title)}${outExt}`;
      const finalPath = path.join(path.dirname(inputPath), finalName);
      fs.renameSync(inputPath, finalPath);
      console.log("  🏷️ Renamed to:", finalName);

      results.push(finalPath);
    } catch (err) {
      console.error("  ❌ Error processing file:", original, err);
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
