// controllers/tagController.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const util = require("util");
const { exec } = require("child_process");
const { generateFingerprint } = require("../utils/fingerprint");
const fetchAlbumArt = require("../utils/fetchAlbumArt");
const { writeTags } = require("../utils/tagWriter");
const { zipTaggedFiles } = require("../utils/zipFiles");

const execPromise = util.promisify(exec);

// ————————————————
// Shared tagging logic
// ————————————————
async function handleTagging(files) {
  const taggedFiles = [];

  for (const file of files) {
    const inputPath = file.path;

    // 1) Determine extension
    let ext = path.extname(inputPath);
    if (!ext) {
      ext = path.extname(file.originalname) || ".mp3";
    }

    // Prepare temp WAV for fingerprint
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const wavDir   = path.join(__dirname, "..", "wavuploads");
    const wavPath  = path.join(wavDir, `${baseName}.wav`);
    if (!fs.existsSync(wavDir)) fs.mkdirSync(wavDir, { recursive: true });

    // 2) Convert to WAV
    await execPromise(`ffmpeg -y -i "${inputPath}" -ar 44100 -ac 2 -f wav "${wavPath}"`);

    // 3) Fingerprint & AcoustID
    const { duration, fingerprint } = await generateFingerprint(wavPath);
    const acoust = await axios.get("https://api.acoustid.org/v2/lookup", {
      params: {
        client: process.env.ACOUSTID_API_KEY,
        meta:   "recordings",
        fingerprint,
        duration,
      },
    });

    const recordings = acoust.data.results[0]?.recordings || [];

    // 4) MusicBrainz lookup (if AcoustID found a recording)
    let meta = { title: null, artist: null, album: null, year: null, genre: null, image: null };
    if (recordings.length) {
      const rec = recordings[0];
      const mbid = rec.id; 
      // Fetch MB record
      const mb = await axios.get(
        `https://musicbrainz.org/ws/2/recording/${mbid}`,
        {
          params: { inc: "artists+releases+tags", fmt: "json" },
          headers: { "User-Agent": "MetaTune/1.0 (you@domain.com)" }
        }
      ).then(r => r.data);

      // Parse MB metadata
      meta.title  = mb.title;
      meta.artist = mb["artist-credit"]?.map(a => a.name).join(", ");
      const release = mb.releases?.[0];
      meta.album = release?.title;
      meta.year  = release?.date?.split("-")[0];
      meta.genre = mb.tags?.[0]?.name;
      // Fetch cover via release-group or release MBID
      const rgid = release?.["release-group"];
      if (rgid) {
        try {
          meta.image = await fetchAlbumArt(rgid);
        } catch {}
      }
    }

    // 5) If lookup failed, fallback to embedded tags
    if (!meta.title) {
      // read embedded tags (via your tagReader util)
      const embedded = await require("../utils/tagReader")(inputPath);
      meta = {
        title:  embedded.title  || "Unknown Title",
        artist: embedded.artist || "Unknown Artist",
        album:  embedded.album  || "Unknown Album",
        year:   embedded.year   || "",
        genre:  embedded.genre  || "",
        image:  embedded.image  || null
      };
    }

    // 6) Write updated tags + art
    await writeTags(meta, inputPath);

    // 7) Rename file to "Artist - Title.ext"
    const safe = str => str.replace(/[^\w\s-]/g,"").trim() || "Unknown";
    const newName = `${safe(meta.artist)} - ${safe(meta.title)}${ext}`;
    const newPath = path.join(path.dirname(inputPath), newName);
    fs.renameSync(inputPath, newPath);

    // 8) Cleanup temp WAV
    fs.unlinkSync(wavPath);

    taggedFiles.push(newPath);
  }

  return taggedFiles;
}

// ————————————————
// Single File
// ————————————————
exports.processFile = async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const [result] = await handleTagging([req.file]);
  if (!result) return res.status(500).json({ error: "Tagging failed" });
  res.download(result, path.basename(result), err => {
    if (err) res.status(500).json({ error: "Download failed" });
  });
};

// ————————————————
// Batch Files
// ————————————————
exports.processBatch = async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "No files uploaded" });

  const results = await handleTagging(files);
  if (!results.length) return res.status(500).json({ error: "All files failed tagging" });

  const zipPath = await zipTaggedFiles(results);
  res.download(zipPath, "metatune-output.zip", err => {
    if (err) return res.status(500).json({ error: "ZIP download failed" });
    fs.unlinkSync(zipPath);
  });
};
