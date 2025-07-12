// utils/normalizeTitle.js

function normalizeTitle(title = "") {
  if (!title) return "";

  const unwantedPatterns = [
    /\[[^\]]*\]/gi,           // [Official Video], [HD], etc.
    /\([^\)]*\)/gi,           // (Official Video), (Lyrics), etc.
    /official\s+video/gi,
    /official\s+audio/gi,
    /music\s+video/gi,
    /video/gi,
    /lyrics?/gi,
    /\blive\b/gi,
    /\bremastered\b/gi,
    /\bfull\s+album\b/gi,
    /\bhd\b/gi,
    /\b4k\b/gi,
    /\bmv\b/gi
  ];

  let clean = title;

  // Remove patterns like [Official Video] or (Lyrics)
  for (const pattern of unwantedPatterns) {
    clean = clean.replace(pattern, "");
  }

  // Remove extra characters and normalize spacing
  clean = clean
    .replace(/[_\-]+/g, " ")       // underscores/dashes → space
    .replace(/\s{2,}/g, " ")       // collapse multiple spaces
    .replace(/^\s+|\s+$/g, "");    // trim

  // Capitalize first letter of each word unless it's all caps already (e.g., "AC/DC")
  clean = clean
    .split(" ")
    .map(word =>
      word === word.toUpperCase() ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
    .join(" ");

  return clean;
}

module.exports = normalizeTitle;
