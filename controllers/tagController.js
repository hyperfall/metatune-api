const fs = require("fs");
const path = require("path");
const axios = require("axios");
const util = require("util");
const { exec } = require("child_process");
const { generateFingerprint } = require("../utils/fingerprint");
const fetchAlbumArt      = require("../utils/fetchAlbumArt");
const { writeTags }      = require("../utils/tagWriter");
const { zipTaggedFiles } = require("../utils/zipFiles");
const tagReader          = require("../utils/tagReader");

const execPromise = util.promisify(exec);
const MB_BASE = "https://musicbrainz.org/ws/2";
const MB_HEADERS = { "User-Agent": "MetaTune/1.0 (you@domain.com)" };

async function handleTagging(files) {
  const results = [];

  for (const file of files) {
    const input = file.path;
    // ─── 1) Determine extension ──────────────────────────────
    let ext = path.extname(input) || path.extname(file.originalname) || ".mp3";

    // ─── 2) Prepare WAV ──────────────────────────────────────
    const base    = path.basename(input, path.extname(input));
    const wavDir  = path.join(__dirname, "..", "wavuploads");
    const wavPath = path.join(wavDir, `${base}.wav`);
    if (!fs.existsSync(wavDir)) fs.mkdirSync(wavDir, { recursive: true });
    await execPromise(`ffmpeg -y -i "${input}" -ar 44100 -ac 2 -f wav "${wavPath}"`);

    // ─── 3) Fingerprint & AcoustID lookup ────────────────────
    let rec = null;
    try {
      const { duration, fingerprint } = await generateFingerprint(wavPath);
      const ac = await axios.get("https://api.acoustid.org/v2/lookup", {
        params: {
          client: process.env.ACOUSTID_API_KEY,
          meta:   "recordings+releasegroups+compress",
          fingerprint,
          duration,
        },
      });
      rec = ac.data.results?.[0]?.recordings?.[0] || null;
    } catch (e) {
      console.warn("⚠️ AcoustID lookup failed:", e.message);
    }

    // ─── 4) Fallback: MusicBrainz search by split filename ───
    if (!rec) {
      const nameOnly = file.originalname.replace(ext, "");
      // split on " - " or the last space to guess title/artist
      let [guessTitle, guessArtist] = nameOnly.split(" - ");
      if (!guessArtist) {
        // if no dash, take first word as title
        const parts = nameOnly.split(" ");
        guessTitle = parts[0];
        guessArtist = parts.slice(1).join(" ");
      }

      try {
        // search recording by both title & artist
        const sr = await axios.get(`${MB_BASE}/recording`, {
          params: {
            query:   `recording:"${guessTitle}" AND artist:"${guessArtist}"`,
            fmt:     "json",
            limit:   1
          },
          headers: MB_HEADERS
        });
        const found = sr.data.recordings?.[0];
        if (found?.id) {
          const lu = await axios.get(`${MB_BASE}/recording/${found.id}`, {
            params: { inc: "artists+release-groups+tags", fmt: "json" },
            headers: MB_HEADERS
          });
          rec = lu.data;
        }
      } catch (e) {
        console.warn("⚠️ MB fallback lookup failed:", e.message);
      }
    }

    // ─── 5) Read embedded tags ─────────────────────────────────
    const embedded = await tagReader(input);

    // ─── 6) Merge metadata ────────────────────────────────────
    const title  = rec?.title
      || embedded.title
      || "Unknown Title";
    const artist = rec?.["artist-credit"]?.map(a => a.name).join(", ")
      || embedded.artist
      || "Unknown Artist";

    const releaseGroup = rec?.["release-groups"]?.[0] || {};
    const album = releaseGroup.title
      || embedded.album
      || "Unknown Album";

    const year = (releaseGroup["first-release-date"]?.split("-")[0])
      || embedded.year
      || "";

    const genre = rec?.tags?.[0]?.name
      || embedded.genre
      || "";

    // ─── 7) Fetch cover-art ───────────────────────────────────
    let image = null;
    if (releaseGroup.id) {
      try {
        image = await fetchAlbumArt(releaseGroup.id);
      } catch (e) {
        console.warn("⚠️ fetchAlbumArt failed:", e.message);
      }
    }
    // if still null, fallback to any embedded image
    if (!image && embedded.image) {
      image = embedded.image;
    }

    // ─── 8) Write tags + art ──────────────────────────────────
    await writeTags({ title, artist, album, year, genre, image }, input);

    // ─── 9) Rename file ───────────────────────────────────────
    const clean = s => s.replace(/[^\w\s-]/g, "").trim() || "Unknown";
    const newName = `${clean(artist)} - ${clean(title)}${ext}`;
    const newPath = path.join(path.dirname(input), newName);
    fs.renameSync(input, newPath);

    // ─── 10) Cleanup WAV ──────────────────────────────────────
    fs.unlinkSync(wavPath);

    results.push(newPath);
  }

  return results;
}

// ─── Single Upload ─────────────────────────────────────────────
exports.processFile = async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const [out] = await handleTagging([req.file]);
  if (!out) return res.status(500).json({ error: "Tagging failed" });
  res.download(out, path.basename(out), err => {
    if (err) res.status(500).json({ error: "Download failed" });
  });
};

// ─── Batch Upload ──────────────────────────────────────────────
exports.processBatch = async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "No files uploaded" });
  const outs = await handleTagging(files);
  if (!outs.length) return res.status(500).json({ error: "All files failed tagging" });
  const zipPath = await zipTaggedFiles(outs);
  res.download(zipPath, "metatune-output.zip", err => {
    if (err) return res.status(500).json({ error: "ZIP download failed" });
    fs.unlinkSync(zipPath);
  });
};
