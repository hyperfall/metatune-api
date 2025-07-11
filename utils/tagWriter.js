const util = require("util");
const exec = util.promisify(require("child_process").exec);
const path = require("path");
const fs = require("fs");

exports.writeTags = async (tags, inputPath) => {
  const ext = path.extname(inputPath);
  const tempOutput = inputPath.replace(ext, `_tagged${ext}`);

  const metadataArgs = [
    `-metadata title="${tags.title}"`,
    `-metadata artist="${tags.artist}"`,
    `-metadata album="${tags.album}"`
  ].join(" ");

  const command = `ffmpeg -y -i "${inputPath}" ${metadataArgs} -c copy "${tempOutput}"`;

  try {
    await exec(command);
    fs.unlinkSync(inputPath);
    fs.renameSync(tempOutput, inputPath);
  } catch (err) {
    if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
    throw new Error(`Failed to write tags: ${err.message}`);
  }
};
