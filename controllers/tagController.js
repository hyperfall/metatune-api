// controllers/tagController.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const util = require("util");
const { exec } = require("child_process");
const { generateFingerprint } = require("../utils/fingerprint");
const fetchAlbumArt      = require("../utils/fetchAlbumArt");
const { writeTags }      = require("../utils/tagWriter");
const { zipTaggedFiles } = require("../utils/zipFiles");
const tagReader          = require("../utils/tagReader");

const execPromise = util.promisify(exec);
const MB_BASE     = "https://musicbrainz.org/ws/2";
const MB_HEADERS  = { "User-Agent": "MetaTune/1.0 (you@domain.com)" };

// Unicode-aware cleaner: keeps letters, numbers, spaces, and dashes
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
    console.log(`[handleTagging] Starting: ${original}`);

    try {
      // 1️⃣ Determine extension
      let ext = path.extname(original);
      if (!ext) ext = path.extname(inputPath) || ".mp3";

      // 2️⃣ Convert to WAV for fingerprinting
      const base    = path.basename(inputPath, path.extname(inputPath));
      const wavDir  = path.join(__dirname, "..", "wavuploads");
      const wavPath = path.join(wavDir, `${base}.wav`);
      if (!fs.existsSync(wavDir)) fs.mkdirSync(wavDir, { recursive: true });
      console.log(`[handleTagging] → ffmpeg to WAV: ${wavPath}`);
      await execPromise(`ffmpeg -y -i "${inputPath}" -ar 44100 -ac 2 -f wav "${wavPath}"`);

      // 3️⃣ Fingerprint + AcoustID lookup & best-score selection
      let rec = null;
      try {
        const { duration, fingerprint } = await generateFingerprint(wavPath);
        const ac = await axios.get("https://api.acoustid.org/v2/lookup", {
          params: {
            client:     process.env.ACOUSTID_API_KEY,
            meta:       "recordings+releasegroups+compress",
            fingerprint,
            duration,
          },
        });

        const resultsArr = ac.data.results || [];
        console.log(
          "[handleTagging] → AcoustID scores:",
          resultsArr.map(r => ({ id: r.id, score: r.score }))
        );

        if (resultsArr.length) {
          const best = resultsArr.reduce(
            (prev, curr) => (curr.score > prev.score ? curr : prev),
            resultsArr[0]
          );
          console.log("[handleTagging] → Best result:", { id: best.id, score: best.score });

          if (best.score >= 0.5 && best.recordings?.length) {
            rec = best.recordings[0];
            console.log("[handleTagging] → Chosen recording:", rec);
          } else {
            console.warn(`[handleTagging] → No good match (score ${best.score})`);
          }
        }
      } catch (err) {
        console.warn("[handleTagging] → AcoustID lookup error:", err.message);
      }

      // 4️⃣ Fallback MusicBrainz search by filename if no rec
      if (!rec) {
        console.log("[handleTagging] → No AcoustID match; MB fallback");
        const nameOnly = original.replace(ext, "");
        let [gTitle, gArtist] = nameOnly.split(" - ");
        if (!gArtist) {
          const parts   = nameOnly.split(" ");
          gTitle        = parts.shift();
          gArtist       = parts.join(" ");
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
            console.log("[handleTagging] → MB fallback rec:", rec);
          }
        } catch (err) {
          console.warn("[handleTagging] → MB fallback error:", err.message);
        }
      }

      // 5️⃣ Read embedded tags
      let embedded = {};
      try {
        embedded = await tagReader(inputPath);
        console.log("[handleTagging] → Embedded tags:", {
          title: embedded.title,
          artist: embedded.artist,
          album: embedded.album
        });
      } catch (err) {
        console.warn("[handleTagging] → tagReader error:", err.message);
      }

      // 6️⃣ Merge metadata
      const title  = rec?.title
        ? rec.title
        : embedded.title  || "Unknown Title";
      const artist = rec?.["artist-credit"]
        ? rec["artist-credit"].map(a => a.name).join(", ")
        : embedded.artist || "Unknown Artist";

      const groups = rec?.releasegroups || rec?.["release-groups"] || [];
      const rg     = groups[0] || {};
      const album  = rg.title      || embedded.album  || "Unknown Album";
      const year   = (rg["first-release-date"] || rg.first_release_date || "")
                       .split("-")[0] || embedded.year || "";
      const genre  = rec?.tags?.[0]?.name || embedded.genre || "";

      console.log("[handleTagging] → Final meta:", { title, artist, album, year, genre });

      // 7️⃣ Fetch cover art or fallback embedded
      let image = null;
      if (rg.id) {
        try {
          image = await fetchAlbumArt(rg.id);
          console.log("[handleTagging] → fetched art for RG", rg.id);
        } catch (err) {
          console.warn("[handleTagging] → art fetch failed:", err.message);
        }
      }
      if (!image && embedded.image) {
        image = embedded.image;
        console.log("[handleTagging] → fallback to embedded art");
      }

      // 8️⃣ Write tags + art
      await writeTags({ title, artist, album, year, genre, image }, inputPath);
      console.log("[handleTagging] → writeTags succeeded");

      // 9️⃣ Rename file
      const finalName = `${clean(artist)} - ${clean(title)}${ext}`;
      const finalPath = path.join(path.dirname(inputPath), finalName);
      fs.renameSync(inputPath, finalPath);
      console.log("[handleTagging] → Renamed to:", finalName);

      // 🔟 Cleanup WAV
      fs.unlinkSync(wavPath);
      results.push(finalPath);
    } catch (err) {
      console.error("[handleTagging] ✖ Error on", original, err);
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
        console.error("[processFile] Download err:", err);
        res.status(500).json({ error: "Download failed" });
      }
    });
  } catch (err) {
    console.error("[processFile] ✖", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

exports.processBatch = async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "No files uploaded" });
    const outs = await handleTagging(files);
    if (!outs.length) return res.status(500).json({ error: "All files failed tagging" });
    const zipPath = await zipTaggedFiles(outs);
    res.download(zipPath, "metatune-output.zip", err => {
      if (err) {
        console.error("[processBatch] ZIP err:", err);
        return res.status(500).json({ error: "ZIP download failed" });
      }
      fs.unlinkSync(zipPath);
    });
  } catch (err) {
    console.error("[processBatch] ✖", err);
    res.status(500).json({ error: "Internal server error" });
  }
};
