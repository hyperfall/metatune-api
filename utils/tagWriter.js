// utils/tagWriter.js
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const path = require("path");
const fs = require("fs");
const tmp = require("tmp");

exports.writeTags = async (tags, inputPath) => {
  const ext = path.extname(inputPath) || ".mp3";
  const baseName = path.basename(inputPath, ext);
  const tmpDir = path.resolve("wavuploads");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const outputPath = path.join(tmpDir, `${baseName}_tagged${ext}`);

  // ffmpeg command pieces
  const parts = [
    'ffmpeg -y -loglevel error',
    `-i "${inputPath}"`
  ];

  // cover art
  let artFile = null;
  if (tags.image?.imageBuffer) {
    const imgExt = tags.image.mime === "image/png" ? ".png" : ".jpg";
    artFile = tmp.fileSync({ postfix: imgExt }).name;
    fs.writeFileSync(artFile, tags.image.imageBuffer);
    parts.push(`-i "${artFile}"`);
  }

  // metadata
  if (tags.title)  parts.push(`-metadata title="${tags.title}"`);
  if (tags.artist) parts.push(`-metadata artist="${tags.artist}"`);
  if (tags.album)  parts.push(`-metadata album="${tags.album}"`);
  if (tags.genre)  parts.push(`-metadata genre="${tags.genre}"`);
  if (tags.year)   parts.push(`-metadata date="${tags.year}"`);

  // ID3 versions
  parts.push('-id3v2_version 3', '-write_id3v1 1');

  // mapping / dispositions
  if (artFile) {
    parts.push('-map 0', '-map 1', '-c copy', '-disposition:v:1 attached_pic');
  } else {
    parts.push('-c copy');
  }

  // output
  parts.push(`"${outputPath}"`);

  const cmd = parts.join(' ');
  try {
    await exec(cmd);
    fs.unlinkSync(inputPath);
    fs.renameSync(outputPath, inputPath);
    if (artFile) fs.unlinkSync(artFile);
  } catch (err) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    if (artFile && fs.existsSync(artFile)) fs.unlinkSync(artFile);
    throw new Error(`Failed to write tags: ${err.message}`);
  }
};
