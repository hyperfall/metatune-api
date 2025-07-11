// utils/tagReader.js
const NodeID3 = require('node-id3');

async function tagReader(filePath) {
  return new Promise((resolve, reject) => {
    NodeID3.read(filePath, (err, tags) => {
      if (err) return reject(err);
      const { title, artist, album, year, genre } = tags;
      let imageData = null;
      if (tags.image) {
        imageData = {
          mime: tags.image.mime,
          type: { id: tags.image.type || 3, name: 'front cover' },
          description: tags.image.description || '',
          imageBuffer: tags.image.imageBuffer
        };
      }
      resolve({ title, artist, album, year, genre, image: imageData });
    });
  });
}

module.exports = tagReader;
