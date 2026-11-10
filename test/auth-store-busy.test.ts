import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openSqliteAuthStore } from '../packages/mistri/src/server/auth/authStore.js';

// A field report: a concurrent reader during the first start's migration made the
// server exit with "database is locked". The store waits for it now.
test('the first-start migration waits for a reader instead of failing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-busy-'));
  const path = join(dir, 'auth.sqlite');
  const seed = new DatabaseSync(path);
  seed.exec('CREATE TABLE user (id TEXT)');
  seed.close();
  // The reader is its own process: a synchronous SQLite call here would never let a timer release it.
  const reader = spawn(
    process.execPath,
    [
      '-e',
      `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('BEGIN');d.prepare('SELECT * FROM user').all();console.log('held');setTimeout(()=>{d.exec('COMMIT');process.exit(0)},700);`,
      path,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], detached: true },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      reader.stdout!.once('data', () => resolve());
      reader.once('error', reject);
      reader.once('exit', () => resolve());
    });
    const store = openSqliteAuthStore(path, () => {});
    try {
      await store.prepare(async () => {});
    } finally {
      store.close();
    }
    const check = new DatabaseSync(path);
    assert.ok(check.prepare("SELECT 1 FROM sqlite_schema WHERE name LIKE '%meta%'").all().length > 0);
    check.close();
  } finally {
    try {
      process.kill(-reader.pid!, 'SIGKILL');
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
