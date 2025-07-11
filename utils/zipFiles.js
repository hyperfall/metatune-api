// utils/zipFiles.js
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");

async function zipTaggedFiles(filePaths) {
  return new Promise((resolve, reject) => {
    const tmpDir = path.join(__dirname, "..", "tmp");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const zipName = `metatune-${Date.now()}.zip`;
    const zipPath = path.join(tmpDir, zipName);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve(zipPath));
    archive.on("error", err => reject(err));

    archive.pipe(output);
    for (const filePath of filePaths) {
      archive.file(filePath, { name: path.basename(filePath) });
    }
    archive.finalize();
  });
}

module.exports = { zipTaggedFiles };
