const { exec } = require("child_process");

exports.generateFingerprint = (filePath) => {
  return new Promise((resolve, reject) => {
    exec(`fpcalc -json "${filePath}"`, (err, stdout, stderr) => {
      if (err) return reject(err);
      try {
        const { duration, fingerprint } = JSON.parse(stdout);
        resolve({ duration, fingerprint });
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
};

