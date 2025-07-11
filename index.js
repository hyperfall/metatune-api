// index.js
const express   = require("express");
const cors      = require("cors");
const multer    = require("multer");
const dotenv    = require("dotenv");
const axios     = require("axios");
const fs        = require("fs");
const path      = require("path");
const fpcalc    = require("fpcalc");
const ID3Writer = require("node-id3");

dotenv.config();

const app          = express();
const port         = process.env.PORT || 3000;
const ACOUSTID_KEY = process.env.ACOUSTID_API_KEY;

// Allow browser to see Content-Disposition
app.use(cors({ origin: "*", exposedHeaders: ["Content-Disposition"] }));

const upload = multer({ dest: "uploads/" });

// helper to delete the temp file
function cleanupTemp(filePath) {
  fs.unlink(filePath, err => {
    if (err) console.warn("⚠️ could not delete", filePath, err.message);
  });
}

// normalize a string to lowercase alphanumeric for comparison
function normalizeForCompare(s) {
  return s
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

app.get("/", (_req, res) => {
  res.send("MetaTune API 🚀");
});

app.post("/api/tag/upload", upload.single("audio"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const filePath       = path.resolve(req.file.path);
  const originalName   = req.file.originalname || "";
  const baseName       = originalName.replace(/\.[^/.]+$/, "");
  const nameNormalized = normalizeForCompare(baseName);

  console.log("📥 Uploaded:", filePath, "filename:", originalName);

  fpcalc(filePath, async (fpErr, fpData) => {
    if (fpErr) {
      cleanupTemp(filePath);
      console.error("❌ fpcalc error:", fpErr);
      return res.status(500).json({ error: "Fingerprint failed", details: fpErr.message });
    }

    const { fingerprint, duration } = fpData;
    const lookupURL =
      `https://api.acoustid.org/v2/lookup?` +
      `client=${ACOUSTID_KEY}` +
      `&fingerprint=${encodeURIComponent(fingerprint)}` +
      `&duration=${duration}` +
      `&meta=recordings+releasegroups+releases`;

    try {
      const lookupRes = await axios.get(lookupURL);
      const results   = Array.isArray(lookupRes.data.results) ? lookupRes.data.results : [];
      if (!results.length) {
        cleanupTemp(filePath);
        return res.status(404).json({ error: "No AcoustID match" });
      }

      // only keep those with recordings[] present
      const haveRecs = results.filter(r => Array.isArray(r.recordings) && r.recordings.length);
      const pool     = haveRecs.length ? haveRecs : results;

      // pick either a multi-artist rec or the top score
      let pickResult =
        pool.find(r =>
          Array.isArray(r.recordings) &&
          r.recordings.some(rc => Array.isArray(rc.artists) && rc.artists.length > 1)
        ) ||
        pool[0];

      console.log("🎯 AcoustID result:", pickResult.id, "score", pickResult.score);

      // array of Recordings
      const recsArr = Array.isArray(pickResult.recordings) ? pickResult.recordings : [];

      // pick a rec with >1 artist or first
      let rec =
        recsArr.find(rc => Array.isArray(rc.artists) && rc.artists.length > 1) ||
        recsArr[0] ||
        {};

      // **NEW**: try override by matching the filename → rec.title
      if (recsArr.length) {
        const byName = recsArr.find(rc => {
          if (!rc.title) return false;
          return normalizeForCompare(rc.title) === nameNormalized;
        });
        if (byName) {
          console.log("🔍 Overriding match by filename:", byName.title);
          rec = byName;
        }
      }

      // release-group for fallback art and multi-artist override
      const rg = rec.releasegroups?.[0] || {};

      // if rec has single artist but RG lists multiple, prefer RG
      if (
        Array.isArray(rec.artists) &&
        rec.artists.length === 1 &&
        Array.isArray(rg.artists) &&
        rg.artists.length > 1
      ) {
        rec.artists = rg.artists;
        console.log("🔄 Using release-group artists:", rec.artists.map(a => a.name));
      }

      // build final tags
      const artist = (rec.artists || []).map(a => a.name).join(", ") || "Unknown Artist";
      const title  = rec.title || "Unknown Title";
      const album  = rg.title || rec.releases?.[0]?.title || "Unknown Album";
      const year   = rec.releases?.[0]?.date?.split("-")[0] || "";

      // fetch cover art: prefer release → release-group
      let imageBuffer = null;
      let imageMime   = "image/jpeg";
      const relId     = rec.releases?.[0]?.id;
      if (relId) {
        try {
          const rimg = await axios.get(
            `https://coverartarchive.org/release/${relId}/front`,
            { responseType: "arraybuffer" }
          );
          imageBuffer = Buffer.from(rimg.data);
          imageMime   = rimg.headers["content-type"] || imageMime;
          console.log("🖼 release art:", imageBuffer.length, imageMime);
        } catch (_) {
          console.warn("⚠️ no release art for", relId);
        }
      }
      if (!imageBuffer && rg.id) {
        try {
          const gimg = await axios.get(
            `https://coverartarchive.org/release-group/${rg.id}/front`,
            { responseType: "arraybuffer" }
          );
          imageBuffer = Buffer.from(gimg.data);
          imageMime   = gimg.headers["content-type"] || imageMime;
          console.log("🖼 group art:", imageBuffer.length, imageMime);
        } catch (_) {
          console.warn("⚠️ no group art for", rg.id);
        }
      }

      // prepare ID3
      const tags = { title, artist, album, year };
      if (imageBuffer) {
        tags.image = {
          mime:        imageMime,
          type:        { id: 3, name: "front cover" },
          description: "Album Art",
          imageBuffer
        };
      }

      console.log("📝 Writing tags:", tags);
      ID3Writer.write(tags, filePath);

      // send file back as download
      const safeName = `${artist} - ${title}`.replace(/[\\/:*?"<>|]/g, "").trim() + ".mp3";
      const output   = fs.readFileSync(filePath);

      res.setHeader("Content-Type",        "audio/mpeg");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      res.send(output);

      // clean up
      cleanupTemp(filePath);
    }
    catch (lookupErr) {
      cleanupTemp(filePath);
      console.error("❌ AcoustID/coverArt error:", lookupErr.response?.data || lookupErr.message);
      res.status(500).json({
        error:   "Tagging failed",
        details: lookupErr.response?.data || lookupErr.message
      });
    }
  });
});

app.listen(port, () => {
  console.log(`🚀 MetaTune API listening on port ${port}`);
});
