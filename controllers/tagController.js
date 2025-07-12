// controllers/tagController.js

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const fetch = require("../utils/fetch");
const logger = require("../utils/logger");
const { getBestFingerprintMatch } = require("../utils/fingerprint");
const { extractOriginalMetadata } = require("../utils/metadataExtractor");
const { scoreFusionMatch } = require("../utils/fusionScorer");
const { cleanupFiles } = require("../utils/cleanupUploads");
const { logToDB } = require("../utils/db");
const { zipFiles } = require("../utils/zipFiles");
const {
  getOfficialAlbumInfo,
  getCoverArtByMetadata
} = require("../utils/musicbrainzHelper");
const normalizeTitle = require("../utils/normalizeTitle");

function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 1024 * 2000 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || stdout);
      resolve(stdout.trim());
    });
  });
}

function sanitize(str) {
  return str ? str.replace(/[\\/:*?"<>|]/g, "_").trim() : "Unknown";
}

async function handleTagging(filePath, attempt = 1) {
  if (!fs.existsSync(filePath)) {
    logger.error(`❌ File not found: ${filePath}`);
    return { success: false, message: "Uploaded file missing." };
  }

  // prepare paths
  const ext          = path.extname(filePath) || ".mp3";
  const base         = path.basename(filePath, ext);
  const dir          = path.dirname(filePath);
  const coverPath    = path.join(dir, `${base}-cover.jpg`);
  const debugPath    = path.join("cache", `${base}.json`);
  const publicLogPath= path.join("logs", `${base}-match-log.json`);
  const outputName   = `${sanitize(normalizeTitle(base))}${ext}`;
  const output       = path.join(dir, `${outputName}`);

  logger.log(`🔍 [START] ${filePath}`);

  // 1) Fingerprint → find recording & MBID
  let match;
  try {
    match = await getBestFingerprintMatch(filePath);
  } catch (err) {
    if (attempt === 1) {
      logger.warn("🔁 Retrying fingerprint...");
      return await handleTagging(filePath, 2);
    }
    logger.error(`🧠 Fingerprint failed: ${err.message}`);
    return { success: false, message: "Fingerprinting failed." };
  }

  if (!match?.recording || match.score < 60) {
    logger.warn(`⚠️ Low fingerprint confidence (${match?.score || 0}). Aborting.`);
    return { success: false, message: "No confident match found." };
  }

  const rec            = match.recording;
  const rawTitle       = rec.title  || base;
  const rawArtist      = rec.artist || "Unknown Artist";
  const recordingMbid  = rec.mbid   || "";

  const title  = sanitize(normalizeTitle(rawTitle));
  const artist = sanitize(normalizeTitle(rawArtist));

  // 2) Get original file metadata (tags + duration, etc)
  const original = await extractOriginalMetadata(filePath);
  logger.log("📂 Original metadata:", {
    title: original.title,
    artist: original.artist,
    album: original.album,
    year: original.year,
    duration: original.duration,
    bitRate: original.bitRate
  });

  // 3) Fetch official album info (album, year, cover) via MBID + text
  const lookupYear = original.year || rec.date || "";
  const albumData  = await getOfficialAlbumInfo(artist, title, lookupYear, recordingMbid);
  logger.log(
    `🔎 Album lookup (${recordingMbid ? "MBID" : "text"}) →`,
    albumData ? albumData.album : "<none>"
  );

  const album    = sanitize(normalizeTitle(albumData?.album  || original.album || rec.album  || "Unknown Album"));
  const year     =         albumData?.year   || original.year   || rec.date     || "2023";
  const coverUrl =         albumData?.coverUrl || "";
  const genre    =         rec.genre   || original.genre   || "";

  const score  = match.score || 0;
  const source = match.method || "unknown";

  const finalMetadata = { title, artist, album, year, genre, score, source };

  // 4) Fusion scoring against original tags + filename
  const fusion = scoreFusionMatch(filePath, finalMetadata, original);
  logger.log(`📊 Fingerprint Score: ${score} | Source: ${source}`);
  logger.log(`🧠 Fusion Score: ${fusion.score} (${fusion.confidence})`);
  logger.log("🔬 Fusion details:", fusion.debug);

  if (fusion.score < 0.5) {
    logger.warn(`❌ [FUSION FAIL] ${fusion.score} < 0.5. Aborting.`);
    return { success: false, message: "Metadata mismatch." };
  }

  logger.log(`✅ [MATCH] ${artist} — ${title}`);
  logger.log(`💽 Album: ${album} | 📆 Year: ${year}`);

  // 5) Build ffmpeg arguments, drop any existing embedded art
  const inputs = [`-i "${filePath}"`];
  const maps   = [`-map 0:a`];   // only audio from original

  let embeddedCover = false;

  // a) Try to embed MusicBrainz cover first
  if (coverUrl) {
    try {
      const res = await fetch(coverUrl);
      const buf = await res.arrayBuffer();
      fs.writeFileSync(coverPath, Buffer.from(buf));
      inputs.push(`-i "${coverPath}"`);
      maps.push(`-map 1`);
      embeddedCover = true;
      logger.log(`🖼️ Embedded cover from MusicBrainz`);
    } catch (err) {
      logger.warn(`⚠️ MusicBrainz cover failed: ${err.message}`);
    }
  }

  // b) Fallback to metadata-based cover search
  if (!embeddedCover) {
    try {
      const fb = await getCoverArtByMetadata(artist, title, album, year);
      if (fb?.coverUrl) {
        const res = await fetch(fb.coverUrl);
        const buf = await res.arrayBuffer();
        fs.writeFileSync(coverPath, Buffer.from(buf));
        inputs.push(`-i "${coverPath}"`);
        maps.push(`-map 1`);
        embeddedCover = true;
        logger.log(`🖼️ Embedded cover via metadata fallback`);
      } else {
        logger.warn(`⚠️ No fallback cover art found`);
      }
    } catch (err) {
      logger.warn(`⚠️ Fallback cover failed: ${err.message}`);
    }
  }

  // 6) Assemble metadata and codec args
  const metadataArgs = [
    `-metadata title="${title}"`,
    `-metadata artist="${artist}"`,
    `-metadata album="${album}"`,
    `-metadata date="${year}"`,
    genre ? `-metadata genre="${sanitize(genre)}"` : "",
    `-metadata comment="Tagged by MetaTune | Fusion: ${fusion.score} (${fusion.confidence})"`
  ].filter(Boolean);

  // if cover was embedded, copy streams (audio+image), else re-encode audio
  const codecArgs = embeddedCover
    ? [`-c copy`]
    : [`-c:a libmp3lame`, `-b:a 192k`];

  // 7) Final ffmpeg command
  const args = [
    ...inputs,
    ...maps,
    ...metadataArgs,
    ...codecArgs,
    `-y "${output}"`
  ];
  const command = `ffmpeg ${args.join(" ")}`;

  // 8) Execute & finalize
  try {
    await runCommand(command);

    // write debug log
    fs.writeFileSync(debugPath, JSON.stringify({
      match, original, albumData, finalMetadata, fusion
    }, null, 2));
    fs.writeFileSync(publicLogPath, JSON.stringify({
      match, finalMetadata, fusion
    }, null, 2));

    logger.log(`✅ [DONE] Saved: ${output}`);
    logger.logMatch(finalMetadata);
    logger.updateStats({ source, success: true });
    await logToDB?.(finalMetadata);

    cleanupFiles([filePath, coverPath]);
    return { success: true, message: "Tagged successfully", output, metadata: finalMetadata };
  } catch (err) {
    logger.error(`❌ FFmpeg failed: ${err}`);
    cleanupFiles([filePath, coverPath]);
    return { success: false, message: "Tagging failed." };
  }
}

// Express route handlers

async function processFile(req, res) {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No file uploaded" });
  }
  const result = await handleTagging(req.file.path);
  if (!result.success) {
    return res.status(500).json(result);
  }
  res.download(result.output, path.basename(result.output));
}

async function processBatch(req, res) {
  if (!req.files?.length) {
    return res.status(400).json({ success: false, message: "No files uploaded" });
  }
  const results = await Promise.all(req.files.map(f => handleTagging(f.path)));
  const outputs = results.filter(r => r.success).map(r => r.output);
  if (!outputs.length) {
    return res.status(500).json({ success: false, message: "No files tagged." });
  }
  const zipPath = await zipFiles(outputs);
  res.download(zipPath, path.basename(zipPath));
}

module.exports = { processFile, processBatch };
