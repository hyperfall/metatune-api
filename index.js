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

// expose Content-Disposition so the browser can pick up our filename
app.use(cors({
  origin: "*",
  exposedHeaders: ["Content-Disposition"]
}));

const upload = multer({ dest: "uploads/" });
function cleanup(fp) {
  fs.unlink(fp, (err) => {
    if (err) console.warn("⚠️ could not delete temp file", fp);
  });
}

app.get("/", (_, res) => {
  res.send("MetaTune API is up 👍");
});

app.post("/api/tag/upload", upload.single("audio"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  const filePath = path.resolve(req.file.path);
  console.log("📥 Received:", filePath);

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
        return res.status(404).json({ error: "No AcoustID result" });
      }

      const best = results[0];
      console.log(`🎯 AcoustID score: ${best.score}`);
      if (best.score < 0.85) {
        cleanup(filePath);
        return res.status(400).json({
          error: "Low match score",
          details: `score ${best.score}`
        });
      }

      const recs = best.recordings;
      if (!recs?.length) {
        cleanup(filePath);
        return res.status(404).json({ error: "No recordings in result" });
      }

      // pull the first recording
      const r = recs[0];
      const artist = r.artists?.[0]?.name        || "Unknown Artist";
      const title  = r.title                     || "Unknown Title";

      //
      // ─── PICK THE “CORRECT” RELEASE ────────────────────────────────────────
      //
      // First try the recording‐level releases[] array:
      let pickRelease = r.releases?.[0] || null;
      // if none, fall back to the first release in the first release‐group
      let groupId    = r.releasegroups?.[0]?.id || null;
      if (!pickRelease && groupId) {
        pickRelease = r.releasegroups[0].releases?.[0] || null;
      }

      const album  = pickRelease?.title
                   || r.releasegroups?.[0]?.title
                   || "Unknown Album";
      const relId  = pickRelease?.id || null;

      // ─── SAFELY PULL YEAR ───────────────────────────────────────────────────
      let year = "";
      if (pickRelease?.date) {
        if (typeof pickRelease.date === "string") {
          year = pickRelease.date.split("-")[0];
        } else if (pickRelease.date.year) {
          year = String(pickRelease.date.year);
        }
      }

      console.log("ℹ️ Tag info:", { artist, title, album, year, relId, groupId });

      // ─── FETCH COVER ART ────────────────────────────────────────────────────
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

      // ─── WRITE ID3 TAGS ────────────────────────────────────────────────────
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
      console.log("📝 Writing tags...", tags);
      ID3Writer.write(tags, filePath);

      // ─── STREAM BACK TO CLIENT ─────────────────────────────────────────────
      const out = fs.readFileSync(filePath);
      const safeName = `${artist} - ${title}`
        .replace(/[\\\/:*?"<>|]/g, "")
        .trim() + ".mp3";

      res.setHeader("Content-Type",        "audio/mpeg");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      res.send(out);

      // ─── CLEANUP ───────────────────────────────────────────────────────────
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
