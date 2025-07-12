const path = require("path");

function normalize(str) {
  return str
    ?.toLowerCase()
    .replace(/[^a-z0-9]/gi, "")
    .trim() || "";
}

function extractNameFromFilename(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return normalize(base);
}

function computeTextMatchScore(a, b) {
  if (!a || !b) return 0;
  return normalize(a) === normalize(b) ? 1 : 0;
}

/**
 * Generate a confidence score based on:
 * - Match vs filename
 * - Match vs embedded tags (optional)
 * - Match confidence from fingerprint
 */
function fusionScore({
  filePath,
  match,           // { title, artist, album, score }
  embeddedTags = {} // { title, artist }
}) {
  const fileName = extractNameFromFilename(filePath);
  const normMatch = {
    title: normalize(match.title),
    artist: normalize(match.artist)
  };

  const normTags = {
    title: normalize(embeddedTags.title),
    artist: normalize(embeddedTags.artist)
  };

  const combined = `${normMatch.artist}${normMatch.title}`;
  const filenameScore = computeTextMatchScore(fileName, combined);

  const titleTagScore = computeTextMatchScore(normTags.title, normMatch.title);
  const artistTagScore = computeTextMatchScore(normTags.artist, normMatch.artist);

  const fingerprintScore = match.score || 0;

  // Weight factors (customize if needed)
  const score = (
    0.5 * fingerprintScore / 100 +
    0.25 * filenameScore +
    0.15 * titleTagScore +
    0.10 * artistTagScore
  );

  const confidenceLevel = score >= 0.8 ? "High" :
                          score >= 0.6 ? "Medium" : "Low";

  return {
    score: Number(score.toFixed(3)),
    confidence: confidenceLevel
  };
}

module.exports = { fusionScore };
