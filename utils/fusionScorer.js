// utils/fusionScorer.js

const path = require("path");

/** Strip down to alphanumeric lowercase */
function normalize(str = "") {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]/gi, "")
    .trim();
}

/** Break filename into artist/title/raw parts */
function extractNamePartsFromFilename(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const clean = base.replace(/\s+/g, " ").trim();
  const parts = clean.split(/[-–—]/).map(p => normalize(p));
  if (parts.length === 2) {
    return {
      artist: parts[0],
      title:  parts[1],
      raw:    normalize(base)
    };
  }
  return { artist: "", title: "", raw: normalize(base) };
}

/** Exact-match = 1, else 0 */
function exactScore(a = "", b = "") {
  return normalize(a) === normalize(b) ? 1 : 0;
}

/** 
 * Simple fuzzy: exact=1, contains=0.7, else 0 
 * (you can swap in a Levenshtein/Jaro library here)
 */
function fuzzyScore(a = "", b = "") {
  a = normalize(a);
  b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.7;
  return 0;
}

/** Year proximity: same=1, ±1yr=0.8, ±2=0.5 */
function computeYearScore(mYear = "", oYear = "") {
  const y1 = parseInt(mYear, 10);
  const y2 = parseInt(oYear, 10);
  if (!y1 || !y2) return 0;
  const d = Math.abs(y1 - y2);
  if (d === 0) return 1;
  if (d === 1) return 0.8;
  if (d === 2) return 0.5;
  return 0;
}

/** Duration similarity: within 3s=1, within 5s=0.8, within 10s=0.5 */
function computeDurationScore(mDur = 0, oDur = 0) {
  if (!mDur || !oDur) return 0;
  const diff = Math.abs(mDur - oDur);
  if (diff <= 3)  return 1;
  if (diff <= 5)  return 0.8;
  if (diff <= 10) return 0.5;
  return 0;
}

/**
 * Build a composite “fusion” score from:
 * - fingerprint confidence (0–1)
 * - filename heuristic
 * - embedded tag match
 * - year proximity
 * - duration similarity
 */
function scoreFusionMatch(filePath, match = {}, embeddedTags = {}) {
  // Filename parts
  const fn = extractNamePartsFromFilename(filePath);

  // Normalize match vs. original tags
  const m = {
    title:    normalize(match.title),
    artist:   normalize(match.artist),
    year:     match.year || "",
    duration: match.duration || 0,    // ensure your fingerprint step populates recording.duration
    score:    (match.score || 0) / 100 // to 0–1
  };
  const t = {
    title:    normalize(embeddedTags.title),
    artist:   normalize(embeddedTags.artist),
    year:     embeddedTags.year || "",
    duration: embeddedTags.duration || 0
  };

  // Heuristic scores
  const fingerprintScore   = m.score;
  const filenameArtistScore = fuzzyScore(fn.artist, m.artist);
  const filenameTitleScore  = fuzzyScore(fn.title,  m.title);
  const filenameRawScore    = fuzzyScore(fn.raw,    m.artist + m.title);
  const tagArtistScore      = exactScore(t.artist, m.artist);
  const tagTitleScore       = exactScore(t.title,  m.title);
  const yearScore           = computeYearScore(m.year, t.year);
  const durationScore       = computeDurationScore(m.duration, t.duration);

  // Weighted sum (must sum to 1)
  const finalScore =
      0.35 * fingerprintScore +
      0.15 * filenameRawScore +
      0.10 * filenameArtistScore +
      0.10 * filenameTitleScore +
      0.05 * tagArtistScore +
      0.05 * tagTitleScore +
      0.10 * yearScore +
      0.10 * durationScore;

  const confidence =
    finalScore >= 0.8 ? "High" :
    finalScore >= 0.6 ? "Medium" :
    "Low";

  return {
    score: Number(finalScore.toFixed(3)),
    confidence,
    debug: {
      fingerprintScore,
      filenameArtistScore,
      filenameTitleScore,
      filenameRawScore,
      tagArtistScore,
      tagTitleScore,
      yearScore,
      durationScore
    }
  };
}

module.exports = { scoreFusionMatch };
