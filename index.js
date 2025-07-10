const express = require("express");
const cors = require("cors");
const multer = require("multer");
const dotenv = require("dotenv");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const fpcalc = require("fpcalc");
const ID3Writer = require("node-id3");

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const ACOUSTID_KEY = process.env.ACOUSTID_API_KEY;

app.use(cors({
  origin: "*",
  exposedHeaders: ["Content-Disposition"]
}));

const upload = multer({ dest: "uploads/" });

const cleanupTemp = (filePath) => {
  fs.unlink(filePath, err => {
    if (err) console.warn("⚠️ Could not delete temp file:", filePath);
  });
};

app.get("/", (req, res) => {
  res.send("MetaTune API is running.");
});

app.post("/api/tag/upload", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const filePath = path.resolve(req.file.path);
  console.log("📥 Uploaded file path:", filePath);

  fpcalc(filePath, async (err, result) => {
    if (err) {
      cleanupTemp(filePath);
      return res.status(500).json({ error: "Fingerprinting failed", details: err.message });
    }

    const { fingerprint, duration } = result;
    const lookupURL = `https://api.acoustid.org/v2/lookup?client=${ACOUSTID_KEY}&fingerprint=${encodeURIComponent(fingerprint)}&duration=${duration}&meta=recordings+releasegroups+releases`;

    try {
      const acoust = await axios.get(lookupURL);
      const recs = acoust.data.results?.[0]?.recordings;
      if (!recs?.length) {
        cleanupTemp(filePath);
        return res.status(404).json({ error: "No metadata found." });
      }

      const r = recs[0];
      const artist = r.artists?.[0]?.name || "Unknown Artist";
      const title = r.title || "Unknown Title";
      const album = r.releasegroups?.[0]?.title || "Unknown Album";
      const year = r.releases?.[0]?.date?.split("-")[0] || "";
      const relId = r.releases?.[0]?.id;

      let imageBuffer = null, imageMime = "image/jpeg";
      if (relId) {
        try {
          const img = await axios.get(`https://coverartarchive.org/release/${relId}/front`, {
            responseType: "arraybuffer"
          });
          imageBuffer = img.data;
          imageMime = img.headers["content-type"];
          console.log("🖼️ Album Art fetched:", imageBuffer.length, imageMime);
        } catch {
          console.warn("⚠️ No album art available.");
        }
      }

      const tags = {
        title,
        artist,
        album,
        year,
        ...(imageBuffer && {
          image: {
            mime: imageMime,
            type: { id: 3, name: "front cover" },
            description: "Album Art",
            imageBuffer
          }
        })
      };

      console.log("📝 Writing tags:", tags);
      ID3Writer.write(tags, filePath);

      const output = fs.readFileSync(filePath);
      const safeName = `${artist} - ${title}`.replace(/[\\/:*?"<>|]/g, "") + ".mp3";

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      res.send(output);

      cleanupTemp(filePath);

    } catch (apiErr) {
      cleanupTemp(filePath);
      console.error("❌ AcoustID / CoverArt error:", apiErr.response?.data || apiErr.message);
      return res.status(500).json({ error: "Tagging failed", details: apiErr.response?.data || apiErr.message });
    }
  });
});

app.listen(port, () => {
  console.log(`🚀 MetaTune API running on port ${port}`);
});
