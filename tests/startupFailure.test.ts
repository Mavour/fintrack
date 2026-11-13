import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('production startup failure', () => {
  it.runIf(fs.existsSync('dist/server/index.js'))('exits cleanly when database initialization fails', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fintrack-startup-'));
    const blocker = path.join(directory, 'not-a-directory');
    fs.writeFileSync(blocker, 'fixture');
    try {
      const result = spawnSync(process.execPath, ['dist/server/index.js'], {
        env: { ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'error',
          DATABASE_PATH: path.join(blocker, 'app.db'),
          SESSION_SECRET: 'startup-failure-test-secret-32-characters', APP_PASSWORD: 'test-password' },
        encoding: 'utf8', timeout: 15000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('uncaughtException');
      expect(output).toMatch(/EEXIST|ENOTDIR/);
      expect(output).not.toContain('ReferenceError');
      expect(output).not.toContain('before initialization');
    } finally {
      fs.unlinkSync(blocker);
      fs.rmdirSync(directory);
    }
  });
});
