/**
 * A connection's `"listen"` (poolConfig.ts listenOf): a direct PostgreSQL URL
 * a jobs host holds its LISTEN on when the main URL goes through a
 * transaction-mode pooler; checked where the config is read, and chosen over
 * the pooler's own URL by wakeListenUrl.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { wakeListenUrl } from '../packages/mistri/src/adapters/events/postgresCommandEventWake.js';
import { loadConfig } from '../packages/engine/src/server/connections.js';
import { listenOf } from '../packages/engine/src/server/poolConfig.js';
import { CONFIG_SECTIONS } from '../packages/mistri/src/server/serviceConnections.js';

const check = (entry: Record<string, unknown>, http = false) => listenOf({ name: 'main', ...entry }, http, 'mistri.json');

test('"listen" is a PostgreSQL URL on a PostgreSQL connection, and anything else is refused', () => {
  assert.equal(check({ url: 'postgres://app@pooler:6432/app' }), undefined);
  assert.equal(check({ url: 'postgres://app@pooler:6432/app', listen: ' postgres://app@db:5432/app ' }), 'postgres://app@db:5432/app');
  assert.equal(check({ url: '${DATABASE_URL}', listen: '${DIRECT_URL}' }), '${DIRECT_URL}');
  assert.throws(() => check({ url: 'postgres://p/app', listen: '' }), /must be a PostgreSQL URL/);
  assert.throws(() => check({ url: 'postgres://p/app', listen: 5 }), /must be a PostgreSQL URL/);
  assert.throws(() => check({ url: 'postgres://p/app', listen: 'mysql://d/app' }), /not a PostgreSQL URL/);
  assert.throws(() => check({ url: 'mysql://p/app', listen: 'postgres://d/app' }), /nothing to listen on/);
  assert.throws(() => check({ url: './shop.db', listen: 'postgres://d/app' }), /nothing to listen on/);
  assert.throws(() => check({ url: 'https://api.example.com', listen: 'postgres://d/app' }, true), /HTTP connection/);
});

test('loadConfig carries "listen" on the connection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-listen-'));
  try {
    const file = join(directory, 'mistri.json');
    writeFileSync(
      file,
      JSON.stringify({ connections: [{ name: 'main', url: 'postgres://app@pooler:6432/app', listen: 'postgres://app@db:5432/app' }] }),
    );
    const loaded = await loadConfig(file, CONFIG_SECTIONS);
    assert.equal(loaded?.connections[0].listen, 'postgres://app@db:5432/app');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the host listens on "listen" when it is named, on the URL on a session pooler, and nowhere behind a transaction pooler', () => {
  assert.equal(wakeListenUrl('postgres://pooler/app', 'transaction', 'postgres://direct/app'), 'postgres://direct/app');
  assert.equal(wakeListenUrl('postgres://pooler/app', 'transaction'), undefined);
  assert.equal(wakeListenUrl('postgres://db/app', 'session'), 'postgres://db/app');
  assert.equal(wakeListenUrl('postgres://db/app', 'session', 'postgres://direct/app'), 'postgres://direct/app');
});
