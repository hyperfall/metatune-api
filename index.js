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

// expose Content-Disposition so the frontend can pick up our filename
app.use(cors({
  origin: "*",
  exposedHeaders: ["Content-Disposition"]
}));

const upload = multer({ dest: "uploads/" });
function cleanupTemp(fp) {
  fs.unlink(fp, err => {
    if (err) console.warn("⚠️ Could not delete temp file:", fp);
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
  console.log("📥  Uploaded:", filePath);

  fpcalc(filePath, async (fpErr, result = {}) => {
    if (fpErr) {
      cleanupTemp(filePath);
      console.error("❌ fpcalc failed:", fpErr);
      return res.status(500).json({
        error:   "Fingerprinting failed",
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
      const acoust    = await axios.get(lookupURL);
      const recs      = acoust.data.results?.[0]?.recordings;
      if (!Array.isArray(recs) || recs.length === 0) {
        cleanupTemp(filePath);
        return res.status(404).json({ error: "No metadata found." });
      }

      // pick the first recording
      const r       = recs[0];
      const artist  = r.artists?.[0]?.name               || "Unknown Artist";
      const title   = r.title                            || "Unknown Title";
      const album   = r.releasegroups?.[0]?.title        || "Unknown Album";
      const year    = r.releases?.[0]?.date?.split("-")[0]|| "";
      const relId   = r.releases?.[0]?.id               || null;
      const rgid    = r.releasegroups?.[0]?.id          || null;

      let imageBuffer = null;
      let imageMime   = "image/jpeg";

      // ---- STEP 1: Try the specific release ----
      if (relId) {
        try {
          const relRes = await axios.get(
            `https://coverartarchive.org/release/${relId}/front`,
            { responseType: "arraybuffer" }
          );
          imageBuffer = Buffer.from(relRes.data);
          imageMime   = relRes.headers["content-type"];
          console.log(`🖼️  Release art OK (${relId}):`, imageBuffer.length, imageMime);
        } catch (_) {
          console.warn(`⚠️  No release art for ${relId}`);
        }
      }

      // ---- STEP 2: Fallback to release-group ----
      if (!imageBuffer && rgid) {
        try {
          const grpRes = await axios.get(
            `https://coverartarchive.org/release-group/${rgid}/front`,
            { responseType: "arraybuffer" }
          );
          imageBuffer = Buffer.from(grpRes.data);
          imageMime   = grpRes.headers["content-type"];
          console.log(`🖼️  Group art OK (${rgid}):`, imageBuffer.length, imageMime);
        } catch (_) {
          console.warn(`⚠️  No group art for ${rgid}`);
        }
      }

      // ---- STEP 3: Build ID3 tags ----
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

      // ---- STEP 4: Send back the tagged file ----
      const output   = fs.readFileSync(filePath);
      const safeName = `${artist} - ${title}`
        .replace(/[\\\/:*?"<>|]/g, "")
        .trim() + ".mp3";

      res.setHeader("Content-Type",        "audio/mpeg");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      res.send(output);

      cleanupTemp(filePath);

    } catch (apiErr) {
      cleanupTemp(filePath);
      console.error("❌ AcoustID/CoverArt failed:", apiErr.response?.data || apiErr.message);
      res.status(500).json({
        error:   "Tagging failed",
        details: apiErr.response?.data || apiErr.message
      });
    }
  });
});

app.listen(port, () => {
  console.log(`🚀 MetaTune API listening on port ${port}`);
});
