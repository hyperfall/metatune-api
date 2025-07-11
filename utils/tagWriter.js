// utils/tagWriter.js
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const path = require("path");
const fs = require("fs");
const tmp = require("tmp");

exports.writeTags = async (tags, inputPath) => {
  const ext      = path.extname(inputPath) || ".mp3";
  const baseName = path.basename(inputPath, ext);
  const tmpDir   = path.resolve("wavuploads");

  console.log(`[tagWriter] Preparing to tag ${inputPath}`);
  // Ensure tmpDir exists
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
    console.log(`[tagWriter] Created temp dir: ${tmpDir}`);
  }

  const outputPath = path.join(tmpDir, `${baseName}_tagged${ext}`);
  let artFile      = null;

  // Build ffmpeg command incrementally
  const parts = ['ffmpeg -y -loglevel error'];

  // Input file
  parts.push(`-i "${inputPath}"`);

  // Prepare cover-art if present
  if (tags.image?.imageBuffer) {
    const imgExt = tags.image.mime === "image/png" ? ".png" : ".jpg";
    artFile = tmp.fileSync({ postfix: imgExt }).name;
    fs.writeFileSync(artFile, tags.image.imageBuffer);
    parts.push(`-i "${artFile}"`);
    console.log(`[tagWriter] Wrote cover art temp file: ${artFile}`);
  }

  // Metadata fields
  if (tags.title)  parts.push(`-metadata title="${tags.title}"`);
  if (tags.artist) parts.push(`-metadata artist="${tags.artist}"`);
  if (tags.album)  parts.push(`-metadata album="${tags.album}"`);
  if (tags.genre)  parts.push(`-metadata genre="${tags.genre}"`);
  if (tags.year)   parts.push(`-metadata date="${tags.year}"`);

  // ID3 settings for MP3 compatibility
  parts.push(`-id3v2_version 3`, `-write_id3v1 1`);

  // Map streams: input(0) + cover-art(1) if provided
  if (artFile) {
    parts.push(`-map 0`, `-map 1`, `-c copy`, `-disposition:v:1 attached_pic`);
  } else {
    parts.push(`-c copy`);
  }

  // Output file
  parts.push(`"${outputPath}"`);

  const cmd = parts.join(" ");
  console.log(`[tagWriter] Running command:\n${cmd}`);

  try {
    await exec(cmd);
    console.log(`[tagWriter] ffmpeg tagging succeeded, moving output to original path`);

    // Replace original
    fs.unlinkSync(inputPath);
    fs.renameSync(outputPath, inputPath);
    console.log(`[tagWriter] Overwrote original: ${inputPath}`);

    // Cleanup art temp
    if (artFile && fs.existsSync(artFile)) {
      fs.unlinkSync(artFile);
      console.log(`[tagWriter] Removed cover-art temp: ${artFile}`);
    }
  } catch (err) {
    console.error(`[tagWriter] Error tagging ${inputPath}:`, err.message);
    // Cleanup any partial output
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
      console.log(`[tagWriter] Removed incomplete output: ${outputPath}`);
    }
    if (artFile && fs.existsSync(artFile)) {
      fs.unlinkSync(artFile);
      console.log(`[tagWriter] Removed cover-art temp after error: ${artFile}`);
    }
    throw new Error(`tagWriter failed for ${inputPath}: ${err.message}`);
  }
};
