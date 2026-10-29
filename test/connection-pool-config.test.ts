/**
 * A connection's `"pool"` in mistri.json and the process-wide
 * `--read-pool` and `--pooler`: what is accepted, what is refused and in
 * whose words, and that the size reaches the adapter's pool.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { connect } from '../packages/engine/src/adapters/connect.js';
import type { PgConnectionManager } from '../packages/engine/src/adapters/postgresPool.js';
import { loadConfig, Registry, saveConfig } from '../packages/engine/src/server/connections.js';
import { parseArgs, postgresPoolFlags } from '../packages/engine/src/server/cli/args.js';
import { CONFIG_SECTIONS } from '../packages/mistri/src/server/serviceConnections.js';

function scratch(): { directory: string; done: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-pool-config-'));
  return { directory, done: () => rmSync(directory, { recursive: true, force: true }) };
}

async function withConfig<T>(body: unknown, run: (path: string) => Promise<T>): Promise<T> {
  const { directory, done } = scratch();
  const path = join(directory, 'mistri.json');
  writeFileSync(path, JSON.stringify(body));
  try {
    return await run(path);
  } finally {
    done();
  }
}

const entry = (pool: unknown, extra: Record<string, unknown> = {}) => ({
  connections: [{ name: 'app', url: 'postgres://reader@db/app', pool, ...extra }],
});

test('a PostgreSQL connection takes "pool": { "read": n, "write": m }, each from 1 to 64 and either one alone', async () => {
  for (const read of [1, 16, 64]) {
    const loaded = await withConfig(entry({ read }), (path) => loadConfig(path, CONFIG_SECTIONS));
    assert.deepEqual(loaded?.connections[0].pool, { read });
  }
  for (const pool of [{ write: 8 }, { read: 16, write: 64 }, { read: 4, write: 1 }]) {
    const loaded = await withConfig(entry(pool), (path) => loadConfig(path, CONFIG_SECTIONS));
    assert.deepEqual(loaded?.connections[0].pool, pool);
  }
  const none = await withConfig({ connections: [{ name: 'app', url: 'postgres://reader@db/app' }] }, (path) =>
    loadConfig(path, CONFIG_SECTIONS),
  );
  assert.equal('pool' in none!.connections[0], false);
  // A reference is checked when it opens, once the environment has said what it names.
  const referenced = await withConfig({ connections: [{ name: 'app', url: '${DATABASE_URL}', pool: { read: 8 } }] }, (path) =>
    loadConfig(path, CONFIG_SECTIONS),
  );
  assert.deepEqual(referenced?.connections[0].pool, { read: 8 });
});

test('a pool outside the range, of the wrong shape or on another engine is refused in words', async () => {
  const refused: Array<[unknown, Record<string, unknown>, RegExp]> = [
    [{ read: 0 }, {}, /"read": 0 \}\. It must be a whole number from 1 to 64, without quotes/],
    [{ read: 65 }, {}, /from 1 to 64/],
    [{ read: 1.5 }, {}, /from 1 to 64/],
    [{ read: '16' }, {}, /"read": "16" \}.*without quotes/],
    [{}, {}, /an empty "pool"/],
    [16, {}, /must be an object such as \{ "read": 16, "write": 8 \}/],
    [null, {}, /must be an object/],
    [[4], {}, /must be an object/],
    [{ read: 4, write: 0 }, {}, /"write": 0 \}\. It must be a whole number from 1 to 64, without quotes/],
    [{ write: '8' }, {}, /"write": "8" \}.*without quotes/],
    [{ read: 4, max: 9 }, {}, /"pool\.max"\. A pool takes "read" and "write"/],
    [{ read: 4 }, { url: './app.sqlite' }, /is not a PostgreSQL connection/],
    [{ read: 4 }, { kind: 'http', url: 'https://api.example/v1/', description: 'desk.http.json' }, /HTTP connection; "pool" sizes/],
  ];
  for (const [pool, extra, message] of refused) {
    await withConfig(entry(pool, extra), (path) => assert.rejects(loadConfig(path, CONFIG_SECTIONS), message));
  }
});

test('a saved config keeps the pool it was read with', async () => {
  const { directory, done } = scratch();
  const path = join(directory, 'mistri.json');
  try {
    await saveConfig(path, [{ id: 'app', name: 'app', url: 'postgres://reader@db/app', pool: { read: 12 }, source: 'config' }]);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).connections[0].pool, { read: 12 });
    assert.deepEqual((await loadConfig(path, CONFIG_SECTIONS))?.connections[0].pool, { read: 12 });
  } finally {
    done();
  }
});

test('--write-pool and --lock-timeout, or their variables, set the writers and the lock wait, and a flag wins', () => {
  const saved = { writePool: process.env.MISTRI_WRITE_POOL, lockTimeout: process.env.MISTRI_LOCK_TIMEOUT };
  try {
    delete process.env.MISTRI_WRITE_POOL;
    delete process.env.MISTRI_LOCK_TIMEOUT;
    assert.deepEqual(postgresPoolFlags(parseArgs(['--write-pool', '8', '--lock-timeout', '2.5'])), { writers: 8, lockTimeoutMs: 2_500 });
    assert.equal(parseArgs(['--write-pool', '8', '--lock-timeout', '1']).unknown, undefined);
    process.env.MISTRI_WRITE_POOL = '12';
    process.env.MISTRI_LOCK_TIMEOUT = '0.5';
    assert.deepEqual(postgresPoolFlags(parseArgs([])), { writers: 12, lockTimeoutMs: 500 });
    assert.deepEqual(postgresPoolFlags(parseArgs(['--write-pool', '2', '--lock-timeout', '10'])), { writers: 2, lockTimeoutMs: 10_000 });
    for (const bad of ['0', '65', '1.5', 'eight', '']) {
      assert.match(
        postgresPoolFlags(parseArgs(['--write-pool', bad])) as string,
        /--write-pool takes a whole number from 1 to 64/,
        `"${bad}" should be refused`,
      );
    }
    for (const bad of ['0', '0.05', '31', '-1', 'soon', '']) {
      assert.match(
        postgresPoolFlags(parseArgs(['--lock-timeout', bad])) as string,
        /--lock-timeout takes seconds from 0\.1 to 30/,
        `"${bad}" should be refused`,
      );
    }
  } finally {
    for (const [key, value] of [
      ['MISTRI_WRITE_POOL', saved.writePool],
      ['MISTRI_LOCK_TIMEOUT', saved.lockTimeout],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('--read-pool and --pooler, or their variables, set the process defaults, and a flag wins', () => {
  const saved = { readPool: process.env.MISTRI_READ_POOL, pooler: process.env.MISTRI_POOLER };
  try {
    delete process.env.MISTRI_READ_POOL;
    delete process.env.MISTRI_POOLER;
    assert.deepEqual(postgresPoolFlags(parseArgs([])), {});
    assert.deepEqual(postgresPoolFlags(parseArgs(['--read-pool', '16', '--pooler', 'transaction'])), {
      readers: 16,
      pooler: 'transaction',
    });
    assert.equal(parseArgs(['--read-pool', '8', '--pooler', 'transaction']).unknown, undefined);

    process.env.MISTRI_READ_POOL = '12';
    process.env.MISTRI_POOLER = 'transaction';
    assert.deepEqual(postgresPoolFlags(parseArgs([])), { readers: 12, pooler: 'transaction' });
    assert.deepEqual(postgresPoolFlags(parseArgs(['--read-pool', '6', '--pooler', 'session'])), { readers: 6, pooler: 'session' });

    for (const bad of ['0', '65', '1.5', '1e1', 'sixteen', '']) {
      const said = postgresPoolFlags(parseArgs(['--read-pool', bad]));
      assert.equal(typeof said, 'string', `"${bad}" should be refused`);
      assert.match(said as string, /--read-pool takes a whole number from 1 to 64/);
    }
    assert.match(postgresPoolFlags(parseArgs(['--pooler', 'statement'])) as string, /--pooler takes "session" or "transaction"/);
  } finally {
    for (const [key, value] of [
      ['MISTRI_READ_POOL', saved.readPool],
      ['MISTRI_POOLER', saved.pooler],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a connection's reader count reaches its pool, and another engine ignores it", async () => {
  const adapter = connect('postgres://reader@127.0.0.1:9/app', { postgres: { readers: 9 } });
  /* pg dials only when a client is checked out, so the pool exists — and
     says its size — without a server behind it. */
  await (adapter as unknown as { connections: PgConnectionManager }).connections.read();
  assert.deepEqual(
    adapter.poolStats?.().map((stats) => [stats.role, stats.size, stats.open, stats.inUse, stats.pooler]),
    [['read', 9, 0, 0, 'session']],
  );
  await adapter.close();

  const { directory, done } = scratch();
  try {
    const file = join(directory, 'plain.db');
    new DatabaseSync(file).close();
    const sqlite = connect(file, { postgres: { readers: 9 } });
    assert.equal(sqlite.poolStats, undefined);
    await sqlite.close();
  } finally {
    done();
  }
});

test('a referenced URL that opens as another engine says its pool has no effect', async () => {
  const { directory, done } = scratch();
  const file = join(directory, 'shop.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY)');
  db.close();
  const saved = process.env.TABLEWALK_POOL_TEST_TARGET;
  process.env.TABLEWALK_POOL_TEST_TARGET = file;
  const registry = new Registry();
  const warnings: string[] = [];
  registry.onWarning = (message) => warnings.push(message);
  try {
    const added = registry.add({ name: 'shop', url: '${TABLEWALK_POOL_TEST_TARGET}', pool: { read: 8 }, source: 'config' });
    const { adapter } = await registry.open(added.id);
    assert.equal(adapter.dialect, 'sqlite');
    assert.deepEqual(
      warnings.filter((warning) => warning.includes('"pool"')),
      ['"shop" has "pool", which sizes PostgreSQL connections; it names another engine, so "pool" has no effect.'],
    );
  } finally {
    await registry.closeAll();
    if (saved === undefined) delete process.env.TABLEWALK_POOL_TEST_TARGET;
    else process.env.TABLEWALK_POOL_TEST_TARGET = saved;
    done();
  }
});

test('MySQL and MariaDB URLs are refused before any connection is opened', () => {
  for (const url of ['mysql://u@h/db', 'mariadb://u@h/db']) {
    assert.throws(() => connect(url), /MySQL is not supported; use PostgreSQL or SQLite/);
  }
});

test("an App's pools are sized from the cores, readers never fewer than writers; the database browser keeps four readers", async () => {
  const { balancedPoolSize } = await import('../packages/engine/src/adapters/writeLanes.js');
  assert.deepEqual(
    [1, 2, 4, 8, 32].map((cores) => balancedPoolSize(cores)),
    [4, 4, 8, 16, 16],
  );
});
