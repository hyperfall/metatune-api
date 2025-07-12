// utils/normalizeTitle.js

function normalizeTitle(title = "") {
  if (!title) return "";

  const unwantedPatterns = [
    /\[[^\]]*\]/g,           // [Official Video], [HD], etc.
    /\([^\)]*\)/g,           // (Official Video), (Lyrics), etc.
    /official\s+video/gi,
    /official\s+audio/gi,
    /lyrics?/gi,
    /hd/gi,
    /4k/gi,
    /mv/gi,
    /music\s+video/gi,
    /video/gi,
    /remastered/gi,
    /full\s+album/gi
  ];

  let clean = title;

  for (const pattern of unwantedPatterns) {
    clean = clean.replace(pattern, "");
  }

  // Normalize whitespace and casing
  clean = clean
    .replace(/[_\-]+/g, " ")        // Replace underscores/dashes with space
    .replace(/\s{2,}/g, " ")        // Collapse multiple spaces
    .trim();

  // Capitalize each word
  clean = clean
    .toLowerCase()
    .replace(/\b\w/g, char => char.toUpperCase());

  return clean;
}

module.exports = normalizeTitle;
