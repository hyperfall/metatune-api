// utils/db.js

const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const dbPath = path.join(__dirname, "..", "cache", "analytics.db");
const db = new sqlite3.Database(dbPath);

// Ensure table exists
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS tagged_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      artist TEXT,
      album TEXT,
      year TEXT,
      source TEXT,
      score INTEGER,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

/**
 * Persist a tagging event
 */
function logToDB({ title, artist, album, year, source, score }) {
  const stmt = db.prepare(`
    INSERT INTO tagged_files (title, artist, album, year, source, score)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(title, artist, album, year, source, score);
  stmt.finalize();
}

module.exports = { logToDB };
