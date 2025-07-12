// utils/normalizeTitle.js

/**
 * Clean up common boilerplate from video/audio titles:
 * - Removes things like “[Official Video]”, “(Lyrics)”, “(From … Movie)”
 * - Strips “feat. …”, “– Remix”, and other noise
 * - Collapses whitespace and normalizes capitalization
 */
function normalizeTitle(title = "") {
  if (!title) return "";

  const unwantedPatterns = [
    // bracketed tags
    /\[[^\]]*\]/gi,              // [Official Video], [HD], etc.
    /\([^\)]*\)/gi,              // remove ALL parentheses first, we'll handle specific ones below
    // explicit phrases
    /official\s+video/gi,
    /official\s+audio/gi,
    /music\s+video/gi,
    /\bvideo\b/gi,
    /\blyrics?\b/gi,
    /\blive\b/gi,
    /\bremastered\b/gi,
    /\bfull\s+album\b/gi,
    /\bhd\b/gi,
    /\b4k\b/gi,
    /\bmv\b/gi,
    // “From … Movie” parentheses cleanup
    /\(from\s+[^)]+\)/gi,
    // featured artists
    /\bfeat\.?[^-–—)]+/gi,
    /\(feat\.?[^)]+\)/gi,
    // remix tags
    /[-–—]\s*remix/gi
  ];

  let clean = title;

  // Remove unwanted patterns
  for (const pattern of unwantedPatterns) {
    clean = clean.replace(pattern, "");
  }

  // Normalize punctuation often left behind
  clean = clean
    // underscores/dashes between words → spaces
    .replace(/[_]+/g, " ")
    // collapse multiple spaces
    .replace(/\s{2,}/g, " ")
    // trim
    .replace(/^\s+|\s+$/g, "");

  // Capitalize each word (unless it's all caps already)
  clean = clean
    .split(" ")
    .map(word =>
      word === word.toUpperCase()
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
    .join(" ");

  return clean;
}

module.exports = normalizeTitle;
