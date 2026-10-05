import fs from 'node:fs';
import path from 'node:path';
fs.mkdirSync('dist/server/db', { recursive: true });
fs.copyFileSync('src/server/db/schema.sql', 'dist/server/db/schema.sql');
console.log('schema.sql copied');
