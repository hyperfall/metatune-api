// utils/fusionScorer.js
const path = require("path");

/** Strip to lowercase alphanumeric */
function normalize(str = "") {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]/gi, "")
    .trim();
}

/** Split filename into { artist, title, raw } */
function extractNamePartsFromFilename(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const clean = base.replace(/\s+/g, " ").trim();
  const parts = clean.split(/[-–—]/).map(p => normalize(p));
  if (parts.length === 2) {
    return { artist: parts[0], title: parts[1], raw: normalize(base) };
  }
  return { artist: "", title: "", raw: normalize(base) };
}

/** Exact match = 1, else 0 */
function exactScore(a = "", b = "") {
  return normalize(a) === normalize(b) ? 1 : 0;
}

/** Fuzzy: exact=1, contains=0.7, else 0 */
function fuzzyScore(a = "", b = "") {
  a = normalize(a);
  b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.7;
  return 0;
}

/** Year proximity (±0=1, ±1=0.8, ±2=0.5) */
function computeYearScore(mYear = "", oYear = "") {
  const y1 = parseInt(mYear, 10);
  const y2 = parseInt(oYear, 10);
  if (!y1 || !y2) return 0;
  const d = Math.abs(y1 - y2);
  return d === 0 ? 1 : d === 1 ? 0.8 : d === 2 ? 0.5 : 0;
}

/** Duration similarity (±3s=1, ±5=0.8, ±10=0.5) */
function computeDurationScore(mDur = 0, oDur = 0) {
  if (!mDur || !oDur) return 0;
  const diff = Math.abs(mDur - oDur);
  return diff <= 3 ? 1
       : diff <= 5 ? 0.8
       : diff <= 10 ? 0.5
       : 0;
}

/**
 * Composite “fusion” score:
 *  - fingerprint confidence
 *  - filename heuristics
 *  - embedded‐tag match
 *  - year proximity
 *  - duration similarity
 *  - dejavu boost
 */
function scoreFusionMatch(filePath, metadata = {}, embeddedTags = {}) {
  // If Dejavu recognized it, boost to high certainty immediately
  if (metadata.source === 'dejavu') {
    return {
      score: 0.95,
      confidence: 'High',
      debug: { dejavuBoost: true }
    };
  }

  const fn = extractNamePartsFromFilename(filePath);

  const m = {
    title:    normalize(metadata.title),
    artist:   normalize(metadata.artist),
    year:     metadata.year || "",
    duration: metadata.duration || 0,
    score:    (metadata.score || 0) / 100    // scale to 0–1
  };
  const t = {
    title:    normalize(embeddedTags.title),
    artist:   normalize(embeddedTags.artist),
    year:     embeddedTags.year || "",
    duration: embeddedTags.duration || 0
  };

  // component scores
  const fingerprintScore    = m.score;
  const filenameArtistScore = fuzzyScore(fn.artist, m.artist);
  const filenameTitleScore  = fuzzyScore(fn.title,  m.title);
  const filenameRawScore    = fuzzyScore(fn.raw,    m.artist + m.title);
  const tagArtistScore      = exactScore(t.artist, m.artist);
  const tagTitleScore       = exactScore(t.title,  m.title);
  const yearScore           = computeYearScore(m.year, t.year);
  const durationScore       = computeDurationScore(m.duration, t.duration);

  // weights: fingerprint=60%, raw filename=10%, duration=10%, others share 20%
  const finalScore =
      0.60 * fingerprintScore +
      0.10 * filenameRawScore +
      0.05 * filenameArtistScore +
      0.05 * filenameTitleScore +
      0.05 * tagArtistScore +
      0.05 * tagTitleScore +
      0.05 * yearScore +
      0.10 * durationScore;

  // band thresholds
  const confidence =
    finalScore >= 0.8 ? 'High' :
    finalScore >= 0.5 ? 'Medium' :
    'Low';

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
