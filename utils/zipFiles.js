// utils/zipFiles.js
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");

async function zipTaggedFiles(filePaths) {
  return new Promise((resolve, reject) => {
    // 1) Use a dedicated zips/ directory
    const zipDir = path.join(__dirname, "..", "zips");
    if (!fs.existsSync(zipDir)) fs.mkdirSync(zipDir, { recursive: true });

    const zipName = `metatune-${Date.now()}.zip`;
    const zipPath = path.join(zipDir, zipName);
    const output  = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    // 2) Handle stream errors
    output.on("close", () => resolve(zipPath));
    output.on("error", err => reject(err));
    archive.on("error", err => reject(err));

    // 3) Pipe and append files
    archive.pipe(output);
    for (const filePath of filePaths) {
      archive.file(filePath, { name: path.basename(filePath) });
    }
    archive.finalize();
  });
}

module.exports = { zipTaggedFiles };
