/* Hapus aset demo (seed-dummy/shot) dari DB real berdasarkan fingerprint persis
 * symbol+qty+avg_buy. DEFAULT DRY-RUN (hanya tampil). Terapkan: --apply.
 * Tidak pernah menghapus aset yang tidak cocok persis dengan data demo.
 * Run: node scripts/clean-demo.mjs [--apply] [DB_PATH] */
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DB_PATH = args.find((a) => !a.startsWith('--')) ?? './data/app.db';

// Fingerprint persis data demo scripts/seed-dummy.mjs + scripts/shot.mjs.
const DEMO_FPS = [
  { symbol: 'HYPE', qty: '25.5', avg: 400000 },
  { symbol: 'SOL', qty: '12.5', avg: 1500000 },
  { symbol: 'MET', qty: '100', avg: 15000 },
  { symbol: 'BBCA.JK', qty: '100', avg: 9800 },
  { symbol: 'TLKM.JK', qty: '500', avg: 3200 },
  { symbol: 'RDNPU', qty: '5000', avg: 1200 },
];

const db = new Database(DB_PATH);
const assets = db.prepare('SELECT type, symbol, name, qty, avg_buy_price_idr FROM assets ORDER BY type, symbol').all();
console.log(`DB: ${DB_PATH} — ${assets.length} aset manual:`);
const victims = [];
for (const a of assets) {
  const hit = DEMO_FPS.find((d) => d.symbol === a.symbol && d.qty === a.qty && d.avg === a.avg_buy_price_idr);
  console.log(`  ${hit ? '[SEED] ' : '[USER] '}${a.type} ${a.symbol} qty=${a.qty} avg=${a.avg_buy_price_idr}${hit ? '  <- data demo, akan dihapus' : ''}`);
  if (hit) victims.push(a.symbol);
}
try {
  const marker = db.prepare("SELECT value FROM meta WHERE key = 'demo_seed'").get();
  if (marker) console.log(`  marker demo_seed: ${marker.value}`);
} catch { /* meta absen */ }

if (victims.length === 0) {
  console.log('Tidak ada aset demo. Selesai.');
} else if (!APPLY) {
  console.log(`\nDRY-RUN: ${victims.length} aset demo akan dihapus (${victims.join(', ')}). Ulangi dengan --apply.`);
} else {
  const tx = db.transaction(() => {
    for (const s of victims) {
      db.prepare('DELETE FROM assets WHERE symbol = ?').run(s);
      db.prepare('DELETE FROM price_cache WHERE symbol = ?').run(s);
      db.prepare('DELETE FROM price_history WHERE symbol = ?').run(s);
    }
  });
  tx();
  console.log(`\nDihapus: ${victims.join(', ')}. Aset user tidak disentuh.`);
}
db.close();
