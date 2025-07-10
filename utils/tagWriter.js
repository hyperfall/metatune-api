const NodeID3 = require("node-id3");

exports.writeTags = (tags, filePath) => {
  return new Promise((resolve, reject) => {
    NodeID3.write(tags, filePath, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
};

