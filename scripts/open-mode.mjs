import Database from 'better-sqlite3';
const dbPath = process.argv[2] ?? './data/app.db';
const db = new Database(dbPath);
db.prepare("DELETE FROM meta WHERE key = 'pw_hash'").run();
try {
  db.prepare('DELETE FROM sessions').run();
} catch { /* tabel lama */ }
console.log('open-mode: pw_hash removed from ' + dbPath);
db.close();
