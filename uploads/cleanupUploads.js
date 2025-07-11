const fs = require('fs');
const path = require('path');

function cleanupUploads(directory = './uploads', maxAgeMinutes = 10) {
  const now = Date.now();
  const maxAge = maxAgeMinutes * 60 * 1000;

  fs.readdir(directory, (err, files) => {
    if (err) return console.error('Error reading upload directory:', err);

    files.forEach(file => {
      const filePath = path.join(directory, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return console.error('Error reading file stats:', err);

        if (now - stats.mtimeMs > maxAge) {
          fs.unlink(filePath, err => {
            if (err) return console.error('Failed to delete file:', filePath);
            console.log('🧹 Deleted old file:', filePath);
          });
        }
      });
    });
  });
}

module.exports = cleanupUploads;
