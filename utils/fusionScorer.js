// utils/fusionScorer.js

const path = require("path");
const { normalize, exactScore, fuzzyScore, similarity } = require("./fuzzy");

/** Split filename into { artist, title, raw } */
function extractNamePartsFromFilename(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const cleanBase = base.replace(/\s+/g, " ").trim();
  const parts = cleanBase.split(/[-–—]/).map(p => normalize(p));
  if (parts.length === 2) {
    return { artist: parts[0], title: parts[1], raw: normalize(cleanBase) };
  }
  return { artist: "", title: "", raw: normalize(cleanBase) };
}

/** Year proximity (±0=1, ±1=0.8, ±2=0.5) */
function computeYearScore(mYear = "", oYear = "") {
  const y1 = parseInt(mYear, 10), y2 = parseInt(oYear, 10);
  if (!y1||!y2) return 0;
  const d = Math.abs(y1-y2);
  return d===0?1:d===1?0.8:d===2?0.5:0;
}

/** Duration similarity (±3s=1, ±5s=0.8, ±10s=0.5) */
function computeDurationScore(mDur=0,oDur=0){
  if(!mDur||!oDur) return 0;
  const diff=Math.abs(mDur-oDur);
  return diff<=3?1:diff<=5?0.8:diff<=10?0.5:0;
}

/**
 * Composite fusion score
 */
function scoreFusionMatch(filePath, metadata={}, embeddedTags={}) {
  // Dejavu boost (if you ever re-enable it)
  if (metadata.source === "dejavu") {
    return { score:0.95, confidence:"High", debug:{dejavuBoost:true} };
  }

  const fn = extractNamePartsFromFilename(filePath);
  const m = {
    title: normalize(metadata.title),
    artist: normalize(metadata.artist),
    year: metadata.year||"",
    duration: metadata.duration||0,
    score: (metadata.score||0)/100
  };
  const t = {
    title: normalize(embeddedTags.title),
    artist: normalize(embeddedTags.artist),
    year: embeddedTags.year||"",
    duration: embeddedTags.duration||0
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

  // weights
  const finalScore =
        0.60*fingerprintScore +
        0.10*filenameRawScore +
        0.05*filenameArtistScore +
        0.05*filenameTitleScore +
        0.05*tagArtistScore +
        0.05*tagTitleScore +
        0.05*yearScore +
        0.10*durationScore;

  const confidence =
    finalScore >= 0.8 ? "High" :
    finalScore >= 0.5 ? "Medium" :
    "Low";

  return {
    score: Number(finalScore.toFixed(3)),
    confidence,
    debug:{
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
