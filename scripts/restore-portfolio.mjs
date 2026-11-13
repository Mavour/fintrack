import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { restorePortfolioSeed } from '../dist/server/db/portfolioSeed.js';

if (process.argv.slice(2).some((arg) => arg !== '--replace')) throw new Error('Usage: node scripts/restore-portfolio.mjs [--replace]');
const replace = process.argv.includes('--replace');
const snapshot = process.env.PORTFOLIO_SNAPSHOT_PATH ?? './data/portfolio-snapshot.json';
if (!fs.existsSync(snapshot)) throw new Error('Private portfolio snapshot not found. Copy it to data/portfolio-snapshot.json first.');
const dbPath = process.env.DATABASE_PATH ?? './data/app.db';
if (!fs.existsSync(dbPath)) throw new Error('Database not initialized. Start the app once, then stop it before restoring.');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
try {
  if (replace) {
    fs.mkdirSync('./backups', { recursive: true });
    const backup = path.join('./backups', `before-portfolio-restore-${Date.now()}.db`);
    await db.backup(backup);
    console.log('Previous database backed up:', backup);
  }
  console.log(restorePortfolioSeed(db, replace) ? 'Bank and investment data restored. Login configuration preserved.' : 'Existing data found; nothing changed. Use --replace only with the app stopped.');
} finally { db.close(); }
