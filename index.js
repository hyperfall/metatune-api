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

// enable CORS and expose Content-Disposition so frontend can read filename
app.use(cors({
  origin: "*",
  exposedHeaders: ["Content-Disposition"]
}));

const upload = multer({ dest: "uploads/" });

function cleanup(filePath) {
  fs.unlink(filePath, err => {
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
  const originalBase = path.parse(req.file.originalname).name;
  const filePath     = path.resolve(req.file.path);

  console.log("📥 Uploaded file path:", filePath);

  // Step 1: fingerprint
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
      // Step 2: lookup AcoustID
      const acoust = await axios.get(lookupURL);
      const results = acoust.data.results || [];
      if (!results.length) {
        cleanup(filePath);
        return res.status(404).json({ error: "No AcoustID result found." });
      }

      const top = results[0];
      let  recs = top.recordings || [];
      if (!recs.length) {
        cleanup(filePath);
        return res.status(404).json({ error: "No recordings in AcoustID response." });
      }

      // Step 3: exact-filename fallback
      let record = recs.find(r =>
        r.title && r.title.toLowerCase() === originalBase.toLowerCase()
      ) || recs[0];

      // pull metadata
      const artist  = record.artists?.[0]?.name       || "Unknown Artist";
      const title   = record.title                    || "Unknown Title";
      const rg      = record.releasegroups?.[0]       || {};
      const album   = rg.title                        || "Unknown Album";
      const year    = record.releases?.[0]?.date
                         ?.split("-")[0]             || "";
      const relId   = record.releases?.[0]?.id;
      const rgId    = rg.id;

      // Step 4: try to fetch release art, then group art
      let imageBuffer = null;
      let imageMime   = "image/jpeg";

      // 4a: release-level
      if (relId) {
        try {
          const art = await axios.get(
            `https://coverartarchive.org/release/${relId}/front`,
            { responseType: "arraybuffer" }
          );
          imageBuffer = Buffer.from(art.data);
          imageMime   = art.headers["content-type"];
          console.log("🖼️ Release art fetched:", relId, imageBuffer.length, imageMime);
        } catch (_) {
          console.warn("⚠️ No release art at:", relId);
        }
      }

      // 4b: fallback to release-group
      if (!imageBuffer && rgId) {
        try {
          const art = await axios.get(
            `https://coverartarchive.org/release-group/${rgId}/front`,
            { responseType: "arraybuffer" }
          );
          imageBuffer = Buffer.from(art.data);
          imageMime   = art.headers["content-type"];
          console.log("🖼️ Group art fetched:", rgId, imageBuffer.length, imageMime);
        } catch (_) {
          console.warn("⚠️ No release-group art at:", rgId);
        }
      }

      // Step 5: write ID3 tags
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

      // Step 6: stream back
      const output   = fs.readFileSync(filePath);
      const safeName = `${artist} - ${title}`
                         .replace(/[\\/:*?"<>|]/g, "")
                         .trim() + ".mp3";

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      res.send(output);

      cleanup(filePath);

    } catch (apiErr) {
      cleanup(filePath);
      console.error("❌ AcoustID/CoverArt error:", apiErr.response?.data || apiErr.message);
      res.status(500).json({
        error:   "Tagging failed",
        details: apiErr.response?.data || apiErr.message
      });
    }
  });
});

app.listen(port, () => {
  console.log(`🚀 MetaTune API running on port ${port}`);
});
