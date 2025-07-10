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

// allow the browser to see our Content-Disposition header
app.use(cors({
  origin: "*",
  exposedHeaders: ["Content-Disposition"]
}));

const upload = multer({ dest: "uploads/" });

// helper to safely remove the temp file once we're done
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
  console.log("📥 Uploaded file:", filePath);

  // Step 1: fingerprint the file
  fpcalc(filePath, async (fpErr, { fingerprint, duration } = {}) => {
    if (fpErr) {
      cleanupTemp(filePath);
      console.error("❌ fpcalc error:", fpErr);
      return res.status(500).json({
        error: "Fingerprinting failed",
        details: fpErr.message
      });
    }

    // Step 2: look up on AcoustID
    const lookupURL =
      `https://api.acoustid.org/v2/lookup` +
      `?client=${ACOUSTID_KEY}` +
      `&fingerprint=${encodeURIComponent(fingerprint)}` +
      `&duration=${duration}` +
      `&meta=recordings+releasegroups+releases`;

    try {
      const acoustResp = await axios.get(lookupURL);
      const recs = acoustResp.data.results?.[0]?.recordings;
      if (!recs?.length) {
        cleanupTemp(filePath);
        return res.status(404).json({ error: "No metadata found." });
      }

      // pull the first recording
      const r = recs[0];
      const artist = r.artists?.[0]?.name         || "Unknown Artist";
      const title  = r.title                      || "Unknown Title";
      const album  = r.releasegroups?.[0]?.title  || "Unknown Album";
      const year   = r.releases?.[0]?.date?.split("-")[0] || "";
      // **IMPORTANT**: get the actual release ID from the first release-group's first release
      const relId  = r.releasegroups?.[0]?.releases?.[0]?.id;

      // Step 3: fetch cover art (if any)
      let imageBuffer = null;
      let imageMime   = "image/jpeg";
      if (relId) {
        try {
          const imgRes = await axios.get(
            `https://coverartarchive.org/release/${relId}/front`,
            { responseType: "arraybuffer" }
          );
          imageBuffer = Buffer.from(imgRes.data);
          imageMime   = imgRes.headers["content-type"];
          console.log(`🖼️  Fetched album art (${imageBuffer.length} bytes, ${imageMime})`);
        } catch (_) {
          console.warn("⚠️  No album art available for release", relId);
        }
      }

      // Step 4: write ID3 tags (incl. optional image)
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

      // Step 5: stream the newly-tagged MP3 back to the client
      const output = fs.readFileSync(filePath);
      const safeName = `${artist} - ${title}`
        .replace(/[\\\/:*?"<>|]/g, "")
        .trim() + ".mp3";

      res.setHeader("Content-Type",        "audio/mpeg");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      res.send(output);

      // finally, clean up
      cleanupTemp(filePath);

    } catch (apiErr) {
      cleanupTemp(filePath);
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
