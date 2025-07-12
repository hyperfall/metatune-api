// utils/tagWriter.js
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const path = require("path");
const fs = require("fs");
const tmp = require("tmp");

const WAV_DIR = path.join(__dirname, "..", "wavuploads");

exports.writeTags = async (tags, inputPath) => {
  console.log(`[tagWriter] → Tagging: ${inputPath}`);

  if (!fs.existsSync(WAV_DIR)) {
    fs.mkdirSync(WAV_DIR, { recursive: true });
    console.log(`[tagWriter]   created dir ${WAV_DIR}`);
  }

  const ext = path.extname(inputPath) || ".mp3";
  const base = path.basename(inputPath, ext);
  const tempOut = path.join(WAV_DIR, `${base}_tagged${ext}`);
  let artFile = null;

  const args = [
    "-y",
    "-loglevel", "error",
    "-i", `"${inputPath}"`
  ];

  // ✅ Check if cover art exists and embed it
  if (tags.image?.imageBuffer) {
    artFile = tmp.fileSync({
      postfix: tags.image.mime === "image/png" ? ".png" : ".jpg"
    }).name;
    fs.writeFileSync(artFile, tags.image.imageBuffer);
    console.log(`[tagWriter]   wrote art to ${artFile}`);
    args.push("-i", `"${artFile}"`);
  }

  if (tags.title) args.push("-metadata", `title="${tags.title}"`);
  if (tags.artist) args.push("-metadata", `artist="${tags.artist}"`);
  if (tags.album) args.push("-metadata", `album="${tags.album}"`);
  if (tags.genre) args.push("-metadata", `genre="${tags.genre}"`);
  if (tags.year) args.push("-metadata", `date="${tags.year}"`);
  if (tags.comment) args.push("-metadata", `comment="${tags.comment}"`);

  args.push("-id3v2_version", "3", "-write_id3v1", "1");
  args.push("-map", "0");

  if (artFile) {
    args.push("-map", "1");
    args.push("-c", "copy", "-disposition:v:0", "attached_pic");
  } else {
    args.push("-c", "copy");
  }

  args.push(`"${tempOut}"`);

  const cmd = `ffmpeg ${args.join(" ")}`;
  console.log(`[tagWriter]   exec: ${cmd}`);

  try {
    await exec(cmd);
    console.log(`[tagWriter]   ffmpeg succeeded, overwriting original`);
    fs.unlinkSync(inputPath);
    fs.renameSync(tempOut, inputPath);
    console.log(`[tagWriter]   replaced ${inputPath}`);
  } catch (err) {
    console.error(`[tagWriter]   error: ${err.message}`);
    if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut);
    throw err;
  } finally {
    if (artFile && fs.existsSync(artFile)) {
      fs.unlinkSync(artFile);
      console.log(`[tagWriter]   removed art file`);
    }
  }
};
