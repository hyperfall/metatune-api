// utils/fuzzy.js

// pull in the function by name
const { stringSimilarity } = require("string-similarity-js");

/** Lowercase + alphanumeric only */
function normalize(str = "") {
  return str.toLowerCase().replace(/[^a-z0-9]/gi, "").trim();
}

/** “Real” similarity via string-similarity-js (0–1) */
function similarity(a = "", b = "") {
  return stringSimilarity(normalize(a), normalize(b));
}


// Strip out common boilerplate…
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


// Exact = 1, else 0
function exactScore(a = "", b = "") {
  return normalize(a) === normalize(b) ? 1 : 0;
}

// Simple fuzzy: exact=1, substr=0.7, else 0
function fuzzyScore(a = "", b = "") {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.7;
  return 0;
}

module.exports = {
  stripNoise,
  normalize,
  exactScore,
  fuzzyScore,
  similarity,
};
