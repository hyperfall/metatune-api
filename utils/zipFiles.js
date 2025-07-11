const fs = require("fs");
const path = require("path");
const archiver = require("archiver");

async function zipTaggedFiles(sourceDir = "wavuploads", zipName = "metatune-output.zip") {
  return new Promise((resolve, reject) => {
    const zipPath = path.join("zips", zipName);

    // Ensure zips/ exists
    if (!fs.existsSync("zips")) {
      fs.mkdirSync("zips", { recursive: true });
    }

    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve(zipPath));
    archive.on("error", err => reject(err));

    archive.pipe(output);
    archive.directory(sourceDir, false); // Add all files inside wavuploads/
    archive.finalize();
  });
}

module.exports = { zipTaggedFiles };
