// utils/fusionScorer.js

const path = require("path");
const stringSimilarity = require("string-similarity-js");

/**
 * Remove common boilerplate from artist/title strings,
 * e.g. “(Official Video)”, “Live”, “Acoustic”, “Remastered”, etc.
 */
function stripNoise(str = "") {
  return str
    .replace(
      /\((?:official video|audio|lyrics?|remix|live|acoustic|radio edit|album version|extended version|remaster(?:ed)?|hd|hq|explicit|clean|instrumental)[^)]+\)/gi,
      ""
    )
    .replace(
      /\b(?:official|video|audio|lyrics?|remix|live|acoustic|radio edit|album version|extended version|remaster(?:ed)?|hd|hq|explicit|clean|instrumental)\b/gi,
      ""
    )
    .replace(/[-–:]\s*$/g, "")
    .trim();
}

/** Normalize to lowercase alphanumeric, after stripping noise */
function normalize(str = "") {
  const s = stripNoise(str);
  return s.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

/** Split filename into { artist, title, raw } */
function extractNamePartsFromFilename(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const cleanBase = base.replace(/\s+/g, " ").trim();
  const parts = cleanBase.split(/[-–—]/).map(p => normalize(p));
  if (parts.length === 2) {
    return { artist: parts[0], title: parts[1], raw: parts[0] + parts[1] };
  }
  return { artist: "", title: "", raw: normalize(cleanBase) };
}

/** Exact match = 1, else 0 */
function exactScore(a = "", b = "") {
  return a && b && a === b ? 1 : 0;
}

/**
 * Fuzzy score via string-similarity-js,
 * scaled to 0–1
 */
function fuzzyScore(a = "", b = "") {
  if (!a || !b) return 0;
  const sim = stringSimilarity.compareTwoStrings(a, b);
  // boost substring matches slightly
  if (a.includes(b) || b.includes(a)) return Math.max(sim, 0.75);
  return sim;
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
  return diff <= 3
    ? 1
    : diff <= 5
    ? 0.8
    : diff <= 10
    ? 0.5
    : 0;
}

/**
 * Composite “fusion” score — larger filename/tag weight,
 * fingerprint still primary.
 */
function scoreFusionMatch(filePath, metadata = {}, embeddedTags = {}) {
  // Immediate boost if from a highly reliable source
  if (metadata.source === "dejavu") {
    return {
      score: 0.95,
      confidence: "High",
      debug: { dejavuBoost: true }
    };
  }

  const fn = extractNamePartsFromFilename(filePath);
  const m = {
    title: normalize(metadata.title),
    artist: normalize(metadata.artist),
    year: metadata.year || "",
    duration: metadata.duration || 0,
    score: (metadata.score || 0) / 100
  };
  const t = {
    title: normalize(embeddedTags.title),
    artist: normalize(embeddedTags.artist),
    year: embeddedTags.year || "",
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

  // new weights: fingerprint 55%, filename 25%, tags+year+dur 20%
  const finalScore =
        0.55 * fingerprintScore +
        0.10 * filenameRawScore +
        0.10 * filenameArtistScore +
        0.05 * filenameTitleScore +
        0.05 * tagArtistScore +
        0.05 * tagTitleScore +
        0.05 * yearScore +
        0.05 * durationScore;

  const confidence =
    finalScore >= 0.80 ? "High"
  : finalScore >= 0.50 ? "Medium"
  :                      "Low";

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
