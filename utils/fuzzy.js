// utils/fuzzy.js

const compareTwoStrings = require("string-similarity-js");

/**
 * Strip to lowercase alphanumeric
 */
function normalize(str = "") {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]/gi, "")
    .trim();
}

/**
 * Remove common boilerplate from artist/title strings,
 * e.g. “(Official Video)”, “Live”, “Acoustic”, “Remastered”, etc.
 */
function stripNoise(str = "") {
  return str
    // anything in parens that starts with these keywords
    .replace(
      /\((?:official video|audio|lyrics?|remix|live|acoustic|radio edit|album version|extended version|remaster(?:ed)?|hd|hq|explicit|clean|instrumental)[^)]+\)/gi,
      ""
    )
    // standalone words
    .replace(
      /\b(?:official|video|audio|lyrics?|remix|live|acoustic|radio edit|album version|extended version|remaster(?:ed)?|hd|hq|explicit|clean|instrumental)\b/gi,
      ""
    )
    // trailing “-” or “:” leftovers
    .replace(/[-–:]\s*$/g, "")
    .trim();
}

/** Exact match = 1, else 0 */
function exactScore(a = "", b = "") {
  return normalize(a) === normalize(b) ? 1 : 0;
}

/** Fuzzy filename‐based score: exact=1, contains=0.7, else 0 */
function fuzzyScore(a = "", b = "") {
  a = normalize(a);
  b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.7;
  return 0;
}

/**
 * True string-similarity value between two normalized strings
 */
function similarity(a = "", b = "") {
  return compareTwoStrings(normalize(a), normalize(b));
}

module.exports = {
  normalize,
  stripNoise,
  exactScore,
  fuzzyScore,
  similarity,
};
