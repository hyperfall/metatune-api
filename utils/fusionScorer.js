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

  // Try common separators like 'Artist - Title' or 'Title – Artist'
  const parts = clean.split(/[-–]/).map(p => normalize(p));
  if (parts.length === 2) {
    return {
      artist: parts[0],
      title: parts[1],
      raw: normalize(base)
    };
  }

  return {
    artist: "",
    title: "",
    raw: normalize(base)
  };
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

function scoreFusionMatch(filePath, match = {}, embeddedTags = {}) {
  const filenameParts = extractNamePartsFromFilename(filePath);

  const normMatch = {
    title: normalize(match.title),
    artist: normalize(match.artist)
  };

  const normTags = {
    title: normalize(embeddedTags.title),
    artist: normalize(embeddedTags.artist)
  };

  const fingerprintScore = match.score || 0;

  // Scores from various heuristics
  const filenameArtistScore = fuzzyScore(filenameParts.artist, normMatch.artist);
  const filenameTitleScore = fuzzyScore(filenameParts.title, normMatch.title);
  const filenameRawScore = fuzzyScore(filenameParts.raw, normMatch.artist + normMatch.title);

  const tagArtistScore = computeTextMatchScore(normTags.artist, normMatch.artist);
  const tagTitleScore = computeTextMatchScore(normTags.title, normMatch.title);

  // Final weighted score
  const score = (
    0.45 * (fingerprintScore / 100) +
    0.15 * filenameRawScore +
    0.15 * filenameArtistScore +
    0.10 * filenameTitleScore +
    0.10 * tagArtistScore +
    0.05 * tagTitleScore
  );

  const confidence = score >= 0.8 ? "High" :
                     score >= 0.6 ? "Medium" : "Low";

  return {
    score: Number(score.toFixed(3)),
    confidence,
    debug: {
      fingerprintScore,
      filenameArtistScore,
      filenameTitleScore,
      filenameRawScore,
      tagArtistScore,
      tagTitleScore
    }
  };
}

module.exports = { scoreFusionMatch };
