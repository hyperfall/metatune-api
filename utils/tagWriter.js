const util = require("util");
const exec = util.promisify(require("child_process").exec);
const path = require("path");
const fs = require("fs");
const tmp = require("tmp");

exports.writeTags = async (tags, inputPath) => {
  const ext = path.extname(inputPath);
  const tempOutput = inputPath.replace(ext, `_tagged${ext}`);

  // Basic metadata fields
  const metadataArgs = [
    tags.title ? `-metadata title="${tags.title}"` : "",
    tags.artist ? `-metadata artist="${tags.artist}"` : "",
    tags.album ? `-metadata album="${tags.album}"` : "",
    tags.genre ? `-metadata genre="${tags.genre}"` : "",
    tags.year ? `-metadata date="${tags.year}"` : "",
  ].filter(Boolean); // remove empty entries

  let albumArtPath = null;

  if (tags.image && tags.image.imageBuffer) {
    const tempImage = tmp.fileSync({
      postfix: tags.image.mime === "image/png" ? ".png" : ".jpg",
    });
    fs.writeFileSync(tempImage.name, tags.image.imageBuffer);
    albumArtPath = tempImage.name;
  }

  const command = albumArtPath
    ? `ffmpeg -y -i "${inputPath}" -i "${albumArtPath}" ${metadataArgs.join(" ")} -map 0 -map 1 -c copy -disposition:v:1 attached_pic "${tempOutput}"`
    : `ffmpeg -y -i "${inputPath}" ${metadataArgs.join(" ")} -c copy "${tempOutput}"`;

  try {
    await exec(command);
    fs.unlinkSync(inputPath);
    fs.renameSync(tempOutput, inputPath);
    if (albumArtPath) fs.unlinkSync(albumArtPath);
  } catch (err) {
    if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
    if (albumArtPath && fs.existsSync(albumArtPath)) fs.unlinkSync(albumArtPath);
    throw new Error(`Failed to write tags: ${err.message}`);
  }
};
