// utils/tagWriter.js
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const path = require("path");
const fs = require("fs");
const tmp = require("tmp");

exports.writeTags = async (tags, inputPath) => {
  // 1) Prepare
  const ext      = path.extname(inputPath) || ".mp3";
  const baseName = path.basename(inputPath, ext);
  const tmpDir   = path.resolve("wavuploads");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const outputPath = path.join(tmpDir, `${baseName}_tagged${ext}`);

  // 2) Build metadata args
  const metaArgs = [];
  if (tags.title)  metaArgs.push(`-metadata title="${tags.title}"`);
  if (tags.artist) metaArgs.push(`-metadata artist="${tags.artist}"`);
  if (tags.album)  metaArgs.push(`-metadata album="${tags.album}"`);
  if (tags.genre)  metaArgs.push(`-metadata genre="${tags.genre}"`);
  if (tags.year)   metaArgs.push(`-metadata date="${tags.year}"`);

  // 3) Prepare cover art if present
  let artPath = null;
  if (tags.image?.imageBuffer) {
    const imgExt   = tags.image.mime === "image/png" ? ".png" : ".jpg";
    const tmpImage = tmp.fileSync({ postfix: imgExt });
    fs.writeFileSync(tmpImage.name, tags.image.imageBuffer);
    artPath = tmpImage.name;
  }

  // 4) ffmpeg command
  //    -id3v2_version 3 + write_id3v1 ensures broad MP3 compatibility
  //    -map 0 copies all streams from input; -map 1 attaches the pic
  let cmd = `ffmpeg -y -loglevel error -i "${inputPath}" `;
  if (artPath) {
    cmd += `-i "${artPath}" -map 0 -map 1 `;
    cmd += `-metadata:s:v title="Album cover" -metadata:s:v comment="Cover (front)" `;
  }
  cmd += metaArgs.join(" ") + " ";
  cmd += `-id3v2_version 3 -write_id3v1 1 -c copy "${outputPath}"`;

  try {
    // 5) Run & replace
    await exec(cmd);

    fs.unlinkSync(inputPath);            // remove old file
    fs.renameSync(outputPath, inputPath); // move new over it

    if (artPath) fs.unlinkSync(artPath);
  } catch (err) {
    // Cleanup on error
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    if (artPath && fs.existsSync(artPath)) fs.unlinkSync(artPath);
    throw new Error(`Failed to write tags: ${err.message}`);
  }
};
