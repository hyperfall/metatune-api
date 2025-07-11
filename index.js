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

const app = express();
const port = process.env.PORT || 3000;
const ACOUSTID_KEY = process.env.ACOUSTID_API_KEY;

// expose Content-Disposition so the client can grab our filename
app.use(cors({
  origin: "*",
  exposedHeaders: ["Content-Disposition"]
}));

const upload = multer({ dest: "uploads/" });
function cleanup(fp) {
  fs.unlink(fp, err => {
    if (err) console.warn("⚠️ could not delete temp file", fp);
  });
}

app.get("/", (_, res) => res.send("MetaTune API is running 👍"));

app.post("/api/tag/upload", upload.single("audio"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  const filePath = path.resolve(req.file.path);
  console.log("📥 Received file:", filePath);

  fpcalc(filePath, async (fpErr, result = {}) => {
    if (fpErr) {
      cleanup(filePath);
      console.error("❌ fpcalc error:", fpErr);
      return res.status(500).json({
        error: "Fingerprinting failed",
        details: fpErr.message
      });
    }

    const { fingerprint, duration } = result;
    const lookupURL =
      `https://api.acoustid.org/v2/lookup` +
      `?client=${ACOUSTID_KEY}` +
      `&fingerprint=${encodeURIComponent(fingerprint)}` +
      `&duration=${duration}` +
      `&meta=recordings+releasegroups+releases`;

    try {
      const acoust = await axios.get(lookupURL);
      const { results } = acoust.data;
      if (!results?.length) {
        cleanup(filePath);
        return res.status(404).json({ error: "No AcoustID results" });
      }

      console.log(`🎯 Top AcoustID score: ${results[0].score.toFixed(3)}`);
      // If any of the top matches is a multi‐artist recording, prefer that
      const multiArtistMatch = results
        .find(r => r.recordings?.[0]?.artists?.length > 1);
      const chosen = multiArtistMatch || results[0];
      console.log(`ℹ️ Using match score: ${chosen.score.toFixed(3)}`);

      const rec = chosen.recordings?.[0];
      if (!rec) {
        cleanup(filePath);
        return res.status(404).json({ error: "No recordings in match" });
      }

      // Basic metadata
      const artist = rec.artists?.[0]?.name || "Unknown Artist";
      const title  = rec.title                || "Unknown Title";

      // Pick the *exact* release if present, otherwise fall back on release-group
      let pickRelease = rec.releases?.[0] || null;
      const groupId   = rec.releasegroups?.[0]?.id || null;
      if (!pickRelease && groupId) {
        pickRelease = rec.releasegroups[0].releases?.[0] || null;
      }

      const album = pickRelease?.title
                  || rec.releasegroups?.[0]?.title
                  || "Unknown Album";
      const relId = pickRelease?.id || null;

      // Safely extract year from either "YYYY-MM-DD" or { year: XXXX }
      let year = "";
      if (pickRelease?.date) {
        if (typeof pickRelease.date === "string") {
          year = pickRelease.date.split("-")[0];
        } else if (pickRelease.date.year) {
          year = String(pickRelease.date.year);
        }
      }

      console.log("ℹ️ Tag info:", { artist, title, album, year, relId, groupId });

      // Fetch cover art by release ID first...
      let imageBuffer = null, imageMime = "image/jpeg";
      if (relId) {
        try {
          const imgRes = await axios.get(
            `https://coverartarchive.org/release/${relId}/front`,
            { responseType: "arraybuffer" }
          );
          imageBuffer = Buffer.from(imgRes.data);
          imageMime   = imgRes.headers["content-type"];
          console.log("🖼 Release art OK", relId);
        } catch (_) {
          console.warn("⚠️ No release art for", relId);
        }
      }
      // …then fall back to release‐group art if release art failed
      if (!imageBuffer && groupId) {
        try {
          const grpRes = await axios.get(
            `https://coverartarchive.org/release-group/${groupId}/front`,
            { responseType: "arraybuffer" }
          );
          imageBuffer = Buffer.from(grpRes.data);
          imageMime   = grpRes.headers["content-type"];
          console.log("🖼 Group art OK", groupId);
        } catch (_) {
          console.warn("⚠️ No group art for", groupId);
        }
      }

      // Build and write ID3 tags
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
      console.log("📝 Writing tags", tags);
      ID3Writer.write(tags, filePath);

      // Read back the tagged file and stream it
      const output   = fs.readFileSync(filePath);
      const safeName = `${artist} - ${title}`
        .replace(/[\\\/:*?"<>|]/g, "")
        .trim() + ".mp3";

      res.setHeader("Content-Type",        "audio/mpeg");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      res.send(output);

      // cleanup temp file
      cleanup(filePath);

    } catch (err) {
      cleanup(filePath);
      console.error("❌ tagging error:", err.response?.data || err.message);
      res.status(500).json({
        error:   "Tagging failed",
        details: err.response?.data || err.message
      });
    }
  });
});

app.listen(port, () => {
  console.log(`🚀 MetaTune API listening on port ${port}`);
});
