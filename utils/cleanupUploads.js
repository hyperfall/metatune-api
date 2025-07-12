const fs = require("fs");
const path = require("path");

// Delete files older than X minutes
function cleanupUploads(dirPath, maxAgeMinutes = 15) {
  const cutoff = Date.now() - maxAgeMinutes * 60 * 1000;

  fs.readdirSync(dirPath).forEach(file => {
    const fullPath = path.join(dirPath, file);
    try {
      const stats = fs.statSync(fullPath);
      if (stats.isFile() && stats.mtimeMs < cutoff) {
        fs.unlinkSync(fullPath);
      }
    } catch (err) {
      console.warn(`⚠️ Could not delete ${fullPath}: ${err.message}`);
    }
  });
}

// Delete specific files immediately
function cleanupFiles(paths = []) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {
      console.warn(`⚠️ Failed to delete ${p}: ${e.message}`);
    }
  }
}

module.exports = { cleanupUploads, cleanupFiles };
