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

// CORS so browser can see Content-Disposition
app.use(cors({ origin: "*", exposedHeaders: ["Content-Disposition"] }));

const upload = multer({ dest: "uploads/" });

function cleanup(filePath) {
  fs.unlink(filePath, err => {
    if (err) console.warn("⚠️ could not delete temp file", filePath);
  });
}

app.get("/", (_req, res) => {
  res.send("MetaTune API 🚀");
});

app.post("/api/tag/upload", upload.single("audio"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const filePath = path.resolve(req.file.path);
  console.log("📥 Received:", filePath);

  fpcalc(filePath, async (err, fp) => {
    if (err) {
      cleanup(filePath);
      console.error("❌ fpcalc error:", err);
      return res.status(500).json({ error: "Fingerprint failed", details: err.message });
    }

    const { fingerprint, duration } = fp;
    const lookupURL =
      `https://api.acoustid.org/v2/lookup?` +
      `client=${ACOUSTID_KEY}` +
      `&fingerprint=${encodeURIComponent(fingerprint)}` +
      `&duration=${duration}` +
      `&meta=recordings+releasegroups+releases`;

    try {
      const { data } = await axios.get(lookupURL);
      const results = Array.isArray(data.results) ? data.results : [];
      if (!results.length) {
        cleanup(filePath);
        return res.status(404).json({ error: "No AcoustID matches" });
      }

      // prefer results that actually have recordings
      const withRecs = results.filter(r => Array.isArray(r.recordings) && r.recordings.length > 0);
      const candidates = withRecs.length ? withRecs : results;

      // pick one that has >1 artist on a recording, else first
      const chosen =
        candidates.find(r =>
          Array.isArray(r.recordings) &&
          r.recordings.some(rc => Array.isArray(rc.artists) && rc.artists.length > 1)
        ) ||
        candidates[0];

      console.log("🎯 picked AcoustID result", chosen.id, "score", chosen.score);

      // recordings array (guaranteed array if we came from withRecs, otherwise maybe empty)
      const recsArr = Array.isArray(chosen.recordings) ? chosen.recordings : [];

      // pick multi-artist recording if any, else first
      let rec =
        recsArr.find(rc => Array.isArray(rc.artists) && rc.artists.length > 1) ||
        recsArr[0] ||
        {};

      console.log(
        "ℹ️ available recs’ artists:",
        recsArr.map(rc => (rc.artists || []).map(a => a.name))
      );
      console.log("🌟 chosen rec id", rec.id, "artists", (rec.artists || []).map(a => a.name));

      // if the rec only has one artist but the release-group has more, override
      const rg = rec.releasegroups?.[0];
      if (
        Array.isArray(rec.artists) &&
        rec.artists.length === 1 &&
        Array.isArray(rg?.artists) &&
        rg.artists.length > 1
      ) {
        console.log(
          "🔄 overriding recording artist with release-group artists",
          rg.artists.map(a => a.name)
        );
        rec.artists = rg.artists;
      }

      // final metadata
      const artist = (rec.artists || []).map(a => a.name).join(", ") || "Unknown Artist";
      const title  = rec.title || "Unknown Title";
      const album  = rg?.title || "Unknown Album";
      const year   = rec.releases?.[0]?.date?.split("-")[0] || "";

      // try to fetch release cover art
      let imageBuffer = null;
      let imageMime   = "image/jpeg";
      const relId     = rec.releases?.[0]?.id;
      if (relId) {
        try {
          const img = await axios.get(
            `https://coverartarchive.org/release/${relId}/front`,
            { responseType: "arraybuffer" }
          );
          imageBuffer = Buffer.from(img.data);
          imageMime   = img.headers["content-type"] || imageMime;
          console.log("🖼 release art:", imageBuffer.length, imageMime);
        } catch {
          console.warn("⚠️ no release art for", relId);
        }
      }

      // fallback to release-group cover art
      const rgid = rg?.id;
      if (!imageBuffer && rgid) {
        try {
          const img = await axios.get(
            `https://coverartarchive.org/release-group/${rgid}/front`,
            { responseType: "arraybuffer" }
          );
          imageBuffer = Buffer.from(img.data);
          imageMime   = img.headers["content-type"] || imageMime;
          console.log("🖼 group art:", imageBuffer.length, imageMime);
        } catch {
          console.warn("⚠️ no group art for", rgid);
        }
      }

      // build ID3 tags
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

      // send it back
      const outName = `${artist} - ${title}`
        .replace(/[\\/:*?"<>|]/g, "")
        .trim() + ".mp3";
      const output = fs.readFileSync(filePath);

      res.setHeader("Content-Type",        "audio/mpeg");
      res.setHeader("Content-Disposition", `attachment; filename="${outName}"`);
      res.send(output);

      cleanup(filePath);

    } catch (e) {
      cleanup(filePath);
      console.error("❌ lookup/coverart error:", e.response?.data || e.message);
      res.status(500).json({
        error: "Tagging failed",
        details: e.response?.data || e.message
      });
    }
  });
});

app.listen(port, () => {
  console.log(`🚀 MetaTune API listening on port ${port}`);
});
