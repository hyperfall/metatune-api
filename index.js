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

const app         = express();
const port        = process.env.PORT || 3000;
const ACOUSTID_KEY = process.env.ACOUSTID_API_KEY;

// allow browsers to see our Content-Disposition header
app.use(cors({ origin: "*", exposedHeaders: ["Content-Disposition"] }));

const upload = multer({ dest: "uploads/" });

function cleanup(filePath) {
  fs.unlink(filePath, e => e && console.warn("⚠️ failed to delete temp", filePath));
}

app.get("/", (req, res) => {
  res.send("MetaTune API is up 🚀");
});

app.post("/api/tag/upload", upload.single("audio"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const filePath = path.resolve(req.file.path);

  console.log("📥 Received:", filePath);

  fpcalc(filePath, async (err, info) => {
    if (err) {
      cleanup(filePath);
      console.error("❌ fpcalc:", err);
      return res.status(500).json({ error: "Fingerprint failed", details: err.message });
    }

    const { fingerprint, duration } = info;
    const lookupURL =
      `https://api.acoustid.org/v2/lookup?client=${ACOUSTID_KEY}` +
      `&fingerprint=${encodeURIComponent(fingerprint)}` +
      `&duration=${duration}` +
      `&meta=recordings+releasegroups+releases`;

    try {
      const { data } = await axios.get(lookupURL);
      const results = data.results || [];
      if (!results.length) {
        cleanup(filePath);
        return res.status(404).json({ error: "No AcoustID matches" });
      }

      console.log(`🎯 ${results.length} result(s), scores:`, results.map(r => r.score));

      // 1) pick any result that has a multi-artist recording
      let chosen = results.find(r =>
        r.recordings.some(rec => (rec.artists || []).length > 1)
      ) || results[0];

      console.log("ℹ️ Chosen result ID:", chosen.id, "score:", chosen.score);

      // 2) within that, pick the multi-artist rec if it exists
      let rec = (chosen.recordings || []).find(r => (r.artists || []).length > 1)
             || chosen.recordings[0];

      console.log("👂 Available recordings’ artists:",
        chosen.recordings.map(r => (r.artists || []).map(a => a.name))
      );
      console.log("🌟 Picked rec ID:", rec.id, "artists:", (rec.artists||[]).map(a=>a.name));

      // 3) if rec only had one artist but the release-group has many, override
      const rg = rec.releasegroups?.[0];
      if ((rec.artists||[]).length === 1 && (rg?.artists||[]).length > 1) {
        console.log("🔄 Overriding single artist from recording with release-group artists",
          rg.artists.map(a => a.name)
        );
        rec.artists = rg.artists;
      }

      // pull out our final metadata
      const artist = (rec.artists || []).map(a => a.name).join(", ") || "Unknown Artist";
      const title  = rec.title       || "Unknown Title";
      const album  = rg?.title       || "Unknown Album";
      const year   = rec.releases?.[0]?.date?.split("-")[0] || "";

      // 4) try release-specific cover art
      let imageBuffer = null, imageMime = "image/jpeg";
      const relId = rec.releases?.[0]?.id;
      if (relId) {
        try {
          const img = await axios.get(
            `https://coverartarchive.org/release/${relId}/front`,
            { responseType: "arraybuffer" }
          );
          imageBuffer = Buffer.from(img.data);
          imageMime   = img.headers["content-type"] || imageMime;
          console.log("🖼️ Got release art:", imageBuffer.length, imageMime);
        } catch {
          console.warn("⚠️ No release art for", relId);
        }
      }

      // 5) if that failed, fallback to release-group art
      const rgid = rg?.id;
      if (!imageBuffer && rgid) {
        try {
          const img = await axios.get(
            `https://coverartarchive.org/release-group/${rgid}/front`,
            { responseType: "arraybuffer" }
          );
          imageBuffer = Buffer.from(img.data);
          imageMime   = img.headers["content-type"] || imageMime;
          console.log("🖼️ Fallback group art:", imageBuffer.length, imageMime);
        } catch {
          console.warn("⚠️ No group art for", rgid);
        }
      }

      // 6) build and write tags
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

      // 7) stream back
      const out = fs.readFileSync(filePath);
      const safeName = `${artist} - ${title}`.replace(/[\\/:*?"<>|]/g, "") + ".mp3";
      res.setHeader("Content-Type",        "audio/mpeg");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      res.send(out);

      cleanup(filePath);

    } catch (e) {
      cleanup(filePath);
      console.error("❌ Lookup/CoverArt error:", e.response?.data || e.message);
      res.status(500).json({ error: "Tagging failed", details: e.response?.data || e.message });
    }
  });
});

app.listen(port, () => {
  console.log(`🚀 MetaTune API listening on port ${port}`);
});
