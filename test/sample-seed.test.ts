import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { seedExpensiveSampleDatabase } from '../e2e/support/sampleServer.js';

for (const [name, table, clock] of [
  ['depot', 'stock_movement', 'DEPOT_TODAY'],
  ['commons', 'post', 'COMMONS_TODAY'],
  ['forecourt', 'vehicle', null],
] as const) {
  test(`${name} browser fixtures copy a closed seed into separate writable databases`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), `tablewalk-${name}-seed-copy-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    if (clock) {
      const previous = process.env[clock];
      process.env[clock] = '2026-09-04';
      t.after(() => {
        if (previous === undefined) delete process.env[clock];
        else process.env[clock] = previous;
      });
    }
    const seed = resolve(`test/fixtures/databases/${name}/seed.mjs`);
    const first = join(directory, 'first.db'),
      second = join(directory, 'second.db');
    seedExpensiveSampleDatabase(name, seed, first);
    seedExpensiveSampleDatabase(name, seed, second);
    for (const file of [first, second]) {
      assert.ok(existsSync(file));
      const config = JSON.parse(readFileSync(`${file}.json`, 'utf8')) as {
        connections: Array<{ url: string; writable: boolean; migrations?: { dir: string } }>;
      };
      assert.equal(config.connections[0].url, file);
      assert.equal(config.connections[0].writable, true);
      if (name === 'forecourt') assert.match(config.connections[0].migrations?.dir ?? '', /forecourt\/migrations\/?$/);
    }
    const a = new DatabaseSync(first),
      b = new DatabaseSync(second);
    try {
      const initial = a.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
      assert.equal(b.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, initial);
      a.exec('CREATE TABLE only_first(id INTEGER PRIMARY KEY)');
      assert.equal(b.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'only_first'").get()!.n, 0);
    } finally {
      a.close();
      b.close();
    }
    const third = join(directory, 'third.db');
    seedExpensiveSampleDatabase(name, seed, third);
    const c = new DatabaseSync(third);
    try {
      assert.equal(c.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'only_first'").get()!.n, 0);
    } finally {
      c.close();
    }
  });
}
