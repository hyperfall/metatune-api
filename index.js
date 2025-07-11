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

// enable CORS & expose the Content-Disposition header so front-end can read it
app.use(cors({
  origin: "*",
  exposedHeaders: [ "Content-Disposition" ]
}));

const upload = multer({ dest: "uploads/" });

function cleanup(filePath) {
  fs.unlink(filePath, (err) => {
    if (err) console.warn("⚠️ Could not delete temp file:", filePath);
  });
}

app.get("/", (req, res) => {
  res.send("MetaTune API is running.");
});

app.post("/api/tag/upload", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  // capture the original filename (without extension) for exact-match fallback
  const originalBase = path.parse(req.file.originalname).name;
  const filePath = path.resolve(req.file.path);
  console.log("📥 Uploaded file path:", filePath);

  // Step 1: fingerprint with fpcalc
  fpcalc(filePath, async (err, result) => {
    if (err) {
      cleanup(filePath);
      console.error("❌ fpcalc error:", err);
      return res.status(500).json({ error: "Fingerprinting failed", details: err.message });
    }

    const { fingerprint, duration } = result;
    const lookupURL =
      `https://api.acoustid.org/v2/lookup?client=${ACOUSTID_KEY}` +
      `&fingerprint=${encodeURIComponent(fingerprint)}` +
      `&duration=${duration}` +
      `&meta=recordings+releasegroups+releases`;

    try {
      // Step 2: query AcoustID
      const acoust = await axios.get(lookupURL);
      const resultItem = acoust.data.results?.[0];
      if (!resultItem) {
        cleanup(filePath);
        return res.status(404).json({ error: "No AcoustID result found." });
      }

      const score = resultItem.score;
      let recs  = resultItem.recordings || [];
      if (recs.length === 0) {
        cleanup(filePath);
        return res.status(404).json({ error: "No recordings in AcoustID response." });
      }

      // Step 3: try to find an exact title match vs. original filename
      let record = recs.find(r =>
        r.title &&
        r.title.toLowerCase() === originalBase.toLowerCase()
      );

      // fallback to top result
      if (!record) {
        record = recs[0];
      }

      // pull out metadata fields
      const artist = record.artists?.[0]?.name       || "Unknown Artist";
      const title  = record.title                    || "Unknown Title";
      const rg     = record.releasegroups?.[0];
      const album  = rg?.title                       || "Unknown Album";
      const year   = record.releases?.[0]?.date
                       ?.split("-")[0] || "";
      const relId  = record.releases?.[0]?.id;

      // Step 4: fetch cover art (prefers the release itself)
      let imageBuffer = null, imageMime = "image/jpeg";
      if (relId) {
        try {
          const artRes = await axios.get(
            `https://coverartarchive.org/release/${relId}/front`,
            { responseType: "arraybuffer" }
          );
          imageBuffer = Buffer.from(artRes.data);
          imageMime   = artRes.headers["content-type"];
          console.log("🖼️ Fetched cover art:", imageBuffer.length, imageMime);
        } catch (_) {
          console.warn("⚠️ No cover art for release:", relId);
        }
      }

      // Step 5: build ID3 tags
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
      ID3Writer.write(tags, filePath);

      // Step 6: stream the tagged file back
      const output      = fs.readFileSync(filePath);
      const safeName    = `${artist} - ${title}`.replace(/[\\/:*?"<>|]/g, "") + ".mp3";

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      res.send(output);

      // final cleanup
      cleanup(filePath);

    } catch (apiErr) {
      cleanup(filePath);
      console.error("❌ AcoustID/CoverArt error:", apiErr.response?.data || apiErr.message);
      return res.status(500).json({
        error:   "Tagging failed",
        details: apiErr.response?.data || apiErr.message
      });
    }
  });
});

app.listen(port, () => {
  console.log(`🚀 MetaTune API running on port ${port}`);
});
