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

const app           = express();
const port          = process.env.PORT || 3000;
const ACOUSTID_KEY  = process.env.ACOUSTID_API_KEY;

app.use(cors({
  origin: "*",
  exposedHeaders: ["Content-Disposition"]
}));

const upload = multer({ dest: "uploads/" });

app.post("/api/tag/upload", upload.single("audio"), async (req, res) => {
  if (!req.file) 
    return res.status(400).json({ error: "No file uploaded" });

  const filePath = path.resolve(req.file.path);
  console.log("🔍  Received upload, running fpcalc…");

  fpcalc(filePath, async (err, result) => {
    if (err) {
      console.error("❌ fpcalc error:", err);
      return res.status(500).json({ error: "Fingerprinting failed", details: err.message });
    }

    const { fingerprint, duration } = result;
    const lookupURL = `https://api.acoustid.org/v2/lookup` +
                      `?client=${ACOUSTID_KEY}` +
                      `&fingerprint=${encodeURIComponent(fingerprint)}` +
                      `&duration=${duration}` +
                      `&meta=recordings+releasegroups`;

    try {
      console.log("🛰  Querying AcoustID:", lookupURL);
      const acoust = await axios.get(lookupURL);
      const recs   = acoust.data.results?.[0]?.recordings;
      if (!recs?.length) 
        return res.status(404).json({ error: "No matching metadata found." });

      const r      = recs[0];
      const artist = r.artists?.[0]?.name           || "Unknown Artist";
      const title  = r.title                        || "Unknown Title";
      const album  = r.releasegroups?.[0]?.title    || "Unknown Album";
      const rgid   = r.releasegroups?.[0]?.id;

      // ——— fetch album art by *release-group* —————————————————————
      let imageBuffer = null;
      let imageMime   = "image/jpeg";

      if (rgid) {
        try {
          const coverURL = `https://coverartarchive.org/release-group/${rgid}/front`;
          console.log("🖼️  Fetching cover art from:", coverURL);
          const img = await axios.get(coverURL, { responseType: "arraybuffer" });
          imageBuffer = img.data;
          imageMime   = img.headers["content-type"];
          console.log(
            `✅ Album art fetched (${imageBuffer.length} bytes, ${imageMime})`
          );
        } catch (coverErr) {
          console.warn("⚠️ No cover art available for RGID", rgid);
        }
      } else {
        console.warn("⚠️ No release-group ID in AcoustID response");
      }

      // ——— assemble ID3 tags —————————————————————————————
      const tags = {
        title,
        artist,
        album,
        ...(imageBuffer && {
          image: {
            mime:        imageMime,
            type:        { id: 3, name: "front cover" },
            description: "Album Art",
            imageBuffer,
          }
        }),
      };

      console.log("✏️  Writing ID3 tags:", tags);
      ID3Writer.write(tags, filePath);

      // ——— stream it back with a friendly filename —————————————————
      const output      = fs.readFileSync(filePath);
      const safeName    = `${artist} - ${title}`.replace(/[\\\/:*?"<>|]/g, "").trim() + ".mp3";

      res.setHeader("Content-Type",        "audio/mpeg");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      res.send(output);

    } catch (apiErr) {
      console.error("❌ AcoustID / CoverArt error:", apiErr.response?.data || apiErr.message);
      return res.status(500).json({ error: "Tagging failed", details: apiErr.response?.data || apiErr.message });
    }
  });
});

// healthcheck
app.get("/", (_req, res) => res.send("MetaTune API OK"));

app.listen(port, () => {
  console.log(`🚀 MetaTune API listening on port ${port}`);
});
