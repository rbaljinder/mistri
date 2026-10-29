/**
 * UX-3: words searched in a number column are the caller's to change.
 * PostgreSQL refuses them (22P02, invalid input syntax for type integer) and
 * the server said 500, sending the reader to look for an outage; it is a 400
 * now, and an App says it in a sentence, by the engine's code alone.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appError, wrongTypeValue } from '../packages/mistri/src/server/app/appErrors.js';
import { createApp } from './support/createApp.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { makeDemoDatabase } from './make-demo-db.js';

const pg = (code: string) => Object.assign(new Error('invalid input syntax for type integer: "stone"'), { code });

test('a value its column cannot hold is told by its code, on PostgreSQL', () => {
  for (const code of ['22P02', '22003', '22007', '22008']) assert.equal(wrongTypeValue(pg(code)), true, code);
  assert.equal(wrongTypeValue(pg('23505')), false);
  assert.equal(wrongTypeValue(new Error('invalid input syntax')), false, 'never by its words');
  const said = appError(pg('22P02'));
  assert.equal(said.code, 'validation_failed');
  assert.match(said.message, /^A value given is not one its column holds: a number column takes a number/);
  assert.doesNotMatch(said.message, /stone/, 'the value itself is never said back');
});

test('the server answers a value its column cannot hold 400, not 500', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-wrong-type-'));
  const db = join(dir, 'demo.db');
  makeDemoDatabase(db);
  const registry = new Registry();
  registry.add({ name: 'demo', url: db, source: 'config' });
  registry.setActive('demo');
  const opened = await registry.open('demo');
  const adapter = opened.adapter as unknown as Record<string, unknown>;
  const names = new Set([...Object.keys(adapter), ...Object.getOwnPropertyNames(Object.getPrototypeOf(adapter))]);
  for (const name of names) {
    if (['constructor', 'introspect', 'close', 'dialect', 'poolStats', 'privileges'].includes(name) || typeof adapter[name] !== 'function')
      continue;
    adapter[name] = () => {
      throw pg('22P02');
    };
  }
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  bound.port = (server.address() as { port: number }).port;
  try {
    const read = await fetch(`http://127.0.0.1:${bound.port}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'country' }),
    });
    assert.equal(read.status, 400, await read.clone().text());
  } finally {
    server.close();
    server.closeAllConnections();
    await registry.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
