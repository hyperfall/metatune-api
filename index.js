// index.js
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const dotenv = require("dotenv");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const fpcalc = require("fpcalc");
const ID3Writer = require("node-id3");

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const ACOUSTID_KEY = process.env.ACOUSTID_API_KEY;

app.use(cors({
  origin: "*",
  // we need browsers to see our Content-Disposition header
  exposedHeaders: ["Content-Disposition"]
}));

const upload = multer({ dest: "uploads/" });

function cleanupTemp(filePath) {
  fs.unlink(filePath, err => {
    if (err) console.warn("⚠️ Could not delete temp file:", filePath);
  });
}

app.get("/", (req, res) => {
  res.send("MetaTune API is running.");
});

app.post("/api/tag/upload", upload.single("audio"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const filePath = path.resolve(req.file.path);
  console.log("📥 Received file:", filePath);

  fpcalc(filePath, async (err, result) => {
    if (err) {
      cleanupTemp(filePath);
      console.error("❌ fpcalc error:", err);
      return res.status(500).json({ error: "Fingerprinting failed", details: err.message });
    }

    const { fingerprint, duration } = result;
    const lookupURL = `https://api.acoustid.org/v2/lookup` +
      `?client=${ACOUSTID_KEY}` +
      `&fingerprint=${encodeURIComponent(fingerprint)}` +
      `&duration=${duration}` +
      `&meta=recordings+releasegroups+releases`;

    try {
      // 1) fetch AcoustID lookup
      const acoust = await axios.get(lookupURL);
      const results = acoust.data.results || [];
      if (!results.length) {
        cleanupTemp(filePath);
        return res.status(404).json({ error: "No metadata found" });
      }

      console.log(`🎯 Got ${results.length} result(s), top score ${results[0].score}`);

      // 2) prefer any result where *any* recording has >1 artist
      const multiArtistResult = results.find(r =>
        r.recordings?.some(rec => (rec.artists?.length || 0) > 1)
      );

      // pick either that or the top‐scoring match
      const chosen = multiArtistResult || results[0];
      console.log(`ℹ️ Using match score ${chosen.score}`);

      // 3) within that result pick the multi‐artist recording if one exists
      const rec = (chosen.recordings || []).find(r =>
        (r.artists?.length || 0) > 1
      ) || chosen.recordings[0];

      // extract tag fields
      const artist = rec.artists?.[0]?.name || "Unknown Artist";
      const title  = rec.title               || "Unknown Title";
      const album  = rec.releasegroups?.[0]?.title || "Unknown Album";
      const year   = rec.releases?.[0]?.date?.split("-")[0] || "";

      // 4) fetch cover art from the *release* (not release‐group)
      let imageBuffer = null;
      let imageMime   = "image/jpeg";
      const relId = rec.releases?.[0]?.id;
      if (relId) {
        try {
          const imgRes = await axios.get(
            `https://coverartarchive.org/release/${relId}/front`,
            { responseType: "arraybuffer" }
          );
          imageBuffer = Buffer.from(imgRes.data);
          imageMime   = imgRes.headers["content-type"] || imageMime;
          console.log(`🖼️ Fetched album art (${imageBuffer.length} bytes, ${imageMime})`);
        } catch (_) {
          console.warn("⚠️ No cover art on Cover Art Archive for release", relId);
        }
      }

      // 5) build ID3 tag object
      const tags = {
        title,
        artist,
        album,
        year,
        ...(imageBuffer && {
          image: {
            mime:        imageMime,
            type:        { id: 3, name: "front cover" },
            description: "Album Art",
            imageBuffer
          }
        })
      };
      console.log("📝 Writing tags:", tags);

      // write ID3 tags in‐place
      ID3Writer.write(tags, filePath);

      // read back the tagged file
      const output = fs.readFileSync(filePath);
      const safeName = `${artist} - ${title}`
        .replace(/[\\/:*?"<>|]/g, "")
        .trim() + ".mp3";

      // respond with proper headers so browser will download with our filename
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      res.send(output);

      cleanupTemp(filePath);

    } catch (apiErr) {
      cleanupTemp(filePath);
      console.error("❌ Lookup/CoverArt error:", apiErr.response?.data || apiErr.message);
      res.status(500).json({ error: "Tagging failed", details: apiErr.response?.data || apiErr.message });
    }
  });
});

app.listen(port, () => {
  console.log(`🚀 MetaTune API listening on port ${port}`);
});
