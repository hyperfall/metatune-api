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

// Allow Content-Disposition header in browser
app.use(cors({
  origin: "*",
  exposedHeaders: ["Content-Disposition"],
}));

const upload = multer({ dest: "uploads/" });

app.get("/", (req, res) => {
  res.send("MetaTune API is running.");
});

app.post("/api/tag/upload", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const filePath = path.resolve(req.file.path);
  console.log("📁 Uploaded file:", filePath);

  fpcalc(filePath, async (err, result) => {
    if (err) {
      console.error("❌ fpcalc error:", err);
      return res.status(500).json({ error: "Fingerprinting failed", details: err.message });
    }

    const { fingerprint, duration } = result;
    const lookupURL = `https://api.acoustid.org/v2/lookup`
                    + `?client=${ACOUSTID_KEY}`
                    + `&fingerprint=${encodeURIComponent(fingerprint)}`
                    + `&duration=${duration}`
                    + `&meta=recordings+releasegroups+releases`;

    try {
      const acoust = await axios.get(lookupURL);
      const recs   = acoust.data.results?.[0]?.recordings;
      if (!recs?.length) {
        return res.status(404).json({ error: "No matching metadata found." });
      }

      const r       = recs[0];
      const artist  = r.artists?.[0]?.name            || "Unknown Artist";
      const title   = r.title                         || "Unknown Title";
      const album   = r.releasegroups?.[0]?.title     || "Unknown Album";
      const year    = r.releases?.[0]?.date?.year     || "";
      const releases = r.releases || [];

      // Try every release until we find cover-art
      let imageBuffer = null;
      let imageMime   = "image/jpeg";
      for (const rel of releases) {
        const relId = rel.id;
        try {
          const imgRes = await axios.get(
            `https://coverartarchive.org/release/${relId}/front`,
            { responseType: "arraybuffer" }
          );
          imageBuffer = imgRes.data;
          imageMime   = imgRes.headers["content-type"];
          console.log(`✅ Album art found on release ${relId}`);
          break;
        } catch (coverErr) {
          const status = coverErr.response?.status || coverErr.message;
          console.log(`⛔ No art on release ${relId} (status: ${status})`);
        }
      }

      // Build tags
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
            imageBuffer,
          },
        }),
      };
      console.log("📝 Writing tags:", tags);
      ID3Writer.write(tags, filePath);

      // Read back the tagged file
      const outputBuffer = fs.readFileSync(filePath);
      const safeFilename = `${artist} - ${title}`
        .replace(/[\\/:*?"<>|]/g, "")
        .trim() + ".mp3";

      // Send with correct headers
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
      return res.send(outputBuffer);

    } catch (e) {
      console.error("❌ AcoustID or tagging error:", e.response?.data || e.message);
      return res.status(500).json({
        error: "Tagging failed",
        details: e.response?.data || e.message,
      });
    }
  });
});

app.listen(port, () => {
  console.log(`🚀 MetaTune API listening on port ${port}`);
});
