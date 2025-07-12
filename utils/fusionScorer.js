// utils/fusionScorer.js
const path = require("path");

function normalize(str) {
  return str
    ?.toLowerCase()
    .replace(/[^a-z0-9]/gi, "")
    .trim() || "";
}

function extractNamePartsFromFilename(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const clean = base.replace(/\s+/g, " ").trim();
  const parts = clean.split(/[-–]/).map(p => normalize(p));
  if (parts.length === 2) {
    return { artist: parts[0], title: parts[1], raw: normalize(base) };
  }
  return { artist: "", title: "", raw: normalize(base) };
}

function computeTextMatchScore(a, b) {
  if (!a || !b) return 0;
  return normalize(a) === normalize(b) ? 1 : 0;
}

function fuzzyScore(a, b) {
  if (!a || !b) return 0;
  a = normalize(a);
  b = normalize(b);
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.7;
  return 0;
}

function computeYearScore(matchYear, originalYear) {
  const y1 = parseInt(matchYear, 10);
  const y2 = parseInt(originalYear, 10);
  if (!y1 || !y2) return 0;
  const diff = Math.abs(y1 - y2);
  if (diff === 0) return 1;
  if (diff === 1) return 0.8;
  if (diff === 2) return 0.5;
  return 0;
}

/**
 * Generate a confidence score based on:
 * - fingerprint confidence
 * - filename heuristics
 * - embedded tag match
 * - year proximity
 */
function scoreFusionMatch(filePath, match = {}, embeddedTags = {}) {
  const filenameParts = extractNamePartsFromFilename(filePath);
  const normMatch = {
    title: normalize(match.title),
    artist: normalize(match.artist),
    year: match.year || ""
  };
  const normTags = {
    title: normalize(embeddedTags.title),
    artist: normalize(embeddedTags.artist),
    year: embeddedTags.year || ""
  };

  const fingerprintScore = match.score || 0;
  const filenameArtistScore = fuzzyScore(filenameParts.artist, normMatch.artist);
  const filenameTitleScore  = fuzzyScore(filenameParts.title,  normMatch.title);
  const filenameRawScore    = fuzzyScore(filenameParts.raw,    normMatch.artist + normMatch.title);
  const tagArtistScore      = computeTextMatchScore(normTags.artist, normMatch.artist);
  const tagTitleScore       = computeTextMatchScore(normTags.title,  normMatch.title);
  const yearScore           = computeYearScore(normMatch.year, normTags.year);

  // Weights now include yearScore (15%)
  const score =
    0.40 * (fingerprintScore / 100) +
    0.15 * filenameRawScore +
    0.10 * filenameArtistScore +
    0.10 * filenameTitleScore +
    0.05 * tagArtistScore +
    0.05 * tagTitleScore +
    0.15 * yearScore;

  const confidence =
    score >= 0.8 ? "High" :
    score >= 0.6 ? "Medium" :
    "Low";

  return {
    score: Number(score.toFixed(3)),
    confidence,
    debug: {
      fingerprintScore,
      filenameArtistScore,
      filenameTitleScore,
      filenameRawScore,
      tagArtistScore,
      tagTitleScore,
      yearScore
    }
  };
}

module.exports = { scoreFusionMatch };
