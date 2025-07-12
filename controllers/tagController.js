// controllers/tagController.js

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const fetch = require("../utils/fetch");
const logger = require("../utils/logger");
const { getFingerprintCandidates } = require("../utils/fingerprint");
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

// Run a shell command (ffmpeg)
function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 2000 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || stdout);
      resolve(stdout.trim());
    });
  });
}

// Sanitize any user-visible string into a safe filename
function sanitize(str) {
  return str ? str.replace(/[\\/:*?"<>|]/g, "_").trim() : "Unknown";
}

async function handleTagging(filePath) {
  if (!fs.existsSync(filePath)) {
    logger.error(`❌ File not found: ${filePath}`);
    return { success: false, message: "Uploaded file missing." };
  }

  const ext = path.extname(filePath) || ".mp3";
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, ext);
  const debugPath = path.join("cache", `${base}.json`);
  const publicLogPath = path.join("logs", `${base}-match-log.json`);
  const coverPath = path.join(dir, `${base}-cover.jpg`);

  logger.log(`🔍 [START] ${filePath}`);

  // 1) Extract original tags & get fingerprint candidates
  const original = await extractOriginalMetadata(filePath);
  logger.log("📂 Original metadata:", original);

  const candidates = await getFingerprintCandidates(filePath);
  if (!candidates.length) {
    logger.warn("⚠️ No fingerprint candidates, falling back to text-only lookup");
    // text-only fallback
    try {
      const fbInfo = await getOfficialAlbumInfo(
        original.artist,
        original.title,
        original.year
      );
      if (fbInfo) {
        candidates.push({
          method: 'text-only',
          score: 0,
          recording: {
            mbid: fbInfo.recordingMbid,
            title: original.title,
            artist: original.artist,
            album: fbInfo.album,
            date: fbInfo.year,
            releaseGroupMbid: fbInfo.releaseGroupMbid,
            genre: original.genre
          }
        });
      }
    } catch (err) {
      logger.error(`❌ Text-only fallback failed: ${err.message}`);
    }
    if (!candidates.length) {
      return { success: false, message: "No match found." };
    }
  }

  let chosen = null;
  let fusionResult = null;

  // **EARLY EXIT**: if Dejavu matched first, accept immediately
  if (candidates[0].method === 'dejavu') {
    const dj = candidates[0];
    const rec = dj.recording;
    const title = sanitize(normalizeTitle(rec.title));
    const artist = sanitize(normalizeTitle(rec.artist));
    // Use rec.album if provided, else lookup via MusicBrainz for consistency
    let albumData = null;
    if (!rec.album) {
      albumData = await getOfficialAlbumInfo(artist, title, rec.date || '');
      rec.album = albumData?.album || '';
      rec.date = albumData?.year || rec.date;
    }
    const album = sanitize(normalizeTitle(rec.album || 'Unknown Album'));
    const year = rec.date || original.year || new Date().getFullYear().toString();

    const finalMetadata = { title, artist, album, year, genre: rec.genre || original.genre || '', score: dj.score, source: 'dejavu' };
    fusionResult = scoreFusionMatch(filePath, finalMetadata, original);
    chosen = { cand: dj, finalMetadata, fusionResult, albumData };
  } else {
    // 2) First pass: fusion ≥0.6
    for (const cand of candidates) {
      const { method, score, recording: rec } = cand;
      const title = sanitize(normalizeTitle(rec.title));
      const artist = sanitize(normalizeTitle(rec.artist));
      const lookupYear = original.year || rec.date || "";

      const albumData = await getOfficialAlbumInfo(
        artist,
        title,
        lookupYear,
        rec.mbid
      );
      const album = sanitize(normalizeTitle(
        albumData?.album || rec.album || original.album || "Unknown Album"
      ));
      const year = albumData?.year || rec.date || original.year || new Date().getFullYear().toString();
      const genre = rec.genre || original.genre || "";

      const finalMetadata = { title, artist, album, year, genre, score, source: method };

      fusionResult = scoreFusionMatch(filePath, finalMetadata, original);
      logger.log(
        `📊 Candidate [${method}] fingerprint:${score} → fusion ${fusionResult.score} (${fusionResult.confidence})`
      );
      logger.log("🔬 Fusion debug:", fusionResult.debug);

      if (fusionResult.score >= 0.6) {
        chosen = { cand, finalMetadata, fusionResult, albumData };
        break;
      }
    }

    // 3) Fallback: best ≥0.5
    if (!chosen) {
      const scored = await Promise.all(candidates.map(async c => {
        const { method, score: sc, recording: rec } = c;
        const title = sanitize(normalizeTitle(rec.title));
        const artist = sanitize(normalizeTitle(rec.artist));
        const lookupYear = original.year || rec.date || "";

        const albumData = await getOfficialAlbumInfo(
          artist,
          title,
          lookupYear,
          rec.mbid
        );
        const album = sanitize(normalizeTitle(
          albumData?.album || rec.album || original.album || "Unknown Album"
        ));
        const year = albumData?.year || rec.date || original.year || new Date().getFullYear().toString();
        const genre = rec.genre || original.genre || "";

        const finalMetadata = { title, artist, album, year, genre, score: sc, source: method };
        const fusion = scoreFusionMatch(filePath, finalMetadata, original);
        return { cand: c, finalMetadata, fusion, albumData };
      }));

      scored.sort((a, b) => b.fusion.score - a.fusion.score);
      if (scored[0].fusion.score >= 0.5) {
        logger.warn(`⚠️ No high-confidence candidates, accepting fusion ${scored[0].fusion.score}`);
        chosen = scored[0];
        fusionResult = chosen.fusion;
      }
    }

    // 4) Final text-only fallback
    if (!chosen) {
      logger.warn("⚠️ All candidates below threshold, final text-only fallback");
      try {
        const fbInfo = await getOfficialAlbumInfo(
          original.artist,
          original.title,
          original.year
        );
        if (fbInfo) {
          const finalMetadata = {
            title: sanitize(normalizeTitle(original.title)),
            artist: sanitize(normalizeTitle(original.artist)),
            album: sanitize(normalizeTitle(fbInfo.album)),
            year: fbInfo.year,
            genre: original.genre || "",
            score: 0,
            source: 'text-only'
          };
          chosen = { cand: { method: 'text-only' }, finalMetadata, fusionResult: { score: 0, confidence: 'fallback' }, albumData: fbInfo };
        }
      } catch (err) {
        logger.error(`❌ Final fallback failed: ${err.message}`);
      }
    }
  }

  if (!chosen) {
    logger.error("❌ All candidates failed, skipping.");
    return { success: false, message: "Metadata mismatch." };
  }

  const { cand, finalMetadata, albumData } = chosen;
  logger.log(`✅ [MATCH] ${finalMetadata.artist} — ${finalMetadata.title}`);
  logger.log(`💽 Album: ${finalMetadata.album} | 📆 Year: ${finalMetadata.year}`);

  // 5) Fetch & embed cover art
  let embeddedCover = false;
  if (albumData?.coverUrl) {
    try {
      const res = await fetch(albumData.coverUrl);
      const buf = await res.arrayBuffer();
      fs.writeFileSync(coverPath, Buffer.from(buf));
      embeddedCover = true;
      logger.log(`🖼️ Cover art embedded from MusicBrainz`);
    } catch (err) {
      logger.warn(`⚠️ Cover embed failed: ${err.message}`);
    }
  }
  if (!embeddedCover) {
    try {
      const fb = await getCoverArtByMetadata(
        finalMetadata.artist,
        finalMetadata.title,
        finalMetadata.album,
        finalMetadata.year
      );
      if (fb?.coverUrl) {
        const res = await fetch(fb.coverUrl);
        const buf = await res.arrayBuffer();
        fs.writeFileSync(coverPath, Buffer.from(buf));
        embeddedCover = true;
        logger.log(`🖼️ Cover art embedded via metadata fallback`);
      }
    } catch (err) {
      logger.warn(`⚠️ Fallback cover failed: ${err.message}`);
    }
  }

  // 6) Assemble ffmpeg args
  const inputs = [`-i "${filePath}"`];
  const maps = [`-map 0:a`];
  if (embeddedCover) {
    inputs.push(`-i "${coverPath}"`);
    maps.push(`-map 1`);
  }

  const metadataArgs = [
    `-metadata title="${finalMetadata.title}"`,
    `-metadata artist="${finalMetadata.artist}"`,
    `-metadata album="${finalMetadata.album}"`,
    `-metadata date="${finalMetadata.year}"`,
    finalMetadata.genre ? `-metadata genre="${sanitize(finalMetadata.genre)}"` : "",
    `-metadata comment="MetaTune | fusion:${fusionResult.score}(${fusionResult.confidence})"`
  ];
  const codecArgs = embeddedCover
    ? ["-c copy"]
    : ["-c:a libmp3lame", "-b:a 192k"];

  const taggedName = `${finalMetadata.artist} - ${finalMetadata.title}${ext}`;
  const output = path.join(dir, taggedName);
  const ffArgs = [
    ...inputs,
    ...maps,
    ...metadataArgs,
    ...codecArgs,
    `-y "${output}"`
  ];

  // 7) Run ffmpeg and finalize
  try {
    await runCommand(`ffmpeg ${ffArgs.join(" ")}`);
    fs.writeFileSync(debugPath, JSON.stringify({
      chosenCandidate: cand,
      original,
      albumData,
      finalMetadata,
      fusion: fusionResult
    }, null, 2));
    fs.writeFileSync(publicLogPath, JSON.stringify({ finalMetadata, fusion: fusionResult }, null, 2));

    logger.log(`✅ [DONE] Saved: ${output}`);
    logger.logMatch(finalMetadata);
    logger.updateStats({ source: finalMetadata.source, success: true });
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
  if (!result.success) return res.status(500).json(result);
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
