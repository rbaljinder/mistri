/**
 * The HTTP API against a real PostgreSQL, apart from test/http.test.ts.
 *
 * These are the only cases in that suite that read the databases
 * `TABLEWALK_TEST_PG` names, and while they lived
 * there they put its two hundred other cases — every one on a SQLite file of
 * its own — in the serial lane with them (scripts/test-node.mjs).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './support/createApp.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { liveSkip } from './live.js';

interface Answer {
  status: number;
  json: any;
}

async function send(where: { port: number }, path: string, init: RequestInit = {}): Promise<Answer> {
  const res = await fetch(`http://127.0.0.1:${where.port}${path}`, init);
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}
const getFrom = (where: { port: number }, path: string) => send(where, path);
const postTo = (where: { port: number }, path: string, body: unknown, headers: Record<string, string> = {}) =>
  send(where, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/**
 * The same API, against a server that is not SQLite.
 *
 * Opt-in, because requiring a Postgres to test an HTTP layer would
 * be a bad trade — the whole suite above runs on a file. What these add is the
 * one thing a file cannot show: that the permission gate and the two error
 * vocabularies are properties of the server rather than of the adapter
 * underneath it. Postgres refuses a write with a read-only transaction, and
 * that has to arrive at the client in the same words as the SQLite refusal.
 *
 * Every statement here is a read or a no-op. A suite that is opt-in is a suite
 * someone will point at a database that matters.
 */
const LIVE = [['postgres', process.env.TABLEWALK_TEST_PG] as const];

for (const [engine, liveUrl] of LIVE) {
  describe(`the API against a real ${engine}`, { skip: liveSkip(engine, liveUrl) }, () => {
    const where = { host: '127.0.0.1', port: 0, allowedHosts: [] as string[] };
    let liveServer: Server;
    let liveRegistry: Registry;
    /* Taken from the catalog rather than hardcoded. A statement against a
         table that does not exist is refused for the wrong reason, and a test
         that passes for the wrong reason is worse than no test. */
    let table: string;

    before(async () => {
      liveRegistry = new Registry();
      // No `writable`, which is the default and the point: this connection
      // must refuse every write the same way the SQLite one above does.
      liveRegistry.add({ name: 'live', url: liveUrl!, source: 'config' });
      liveRegistry.setActive('live');
      const { schema } = await liveRegistry.open('live');
      const found = schema.tables.find((t) => !t.isView);
      // An empty database says so, rather than failing on `undefined.id`.
      if (!found) {
        throw new Error(`${engine} has no tables to read. Run \`npm run seed:live\` against it first.`);
      }
      table = found.id;

      liveServer = createApp({ registry: liveRegistry, bound: where });
      await new Promise<void>((resolve) => liveServer.listen(0, '127.0.0.1', resolve));
      const address = liveServer.address();
      assert.ok(address && typeof address === 'object');
      where.port = address.port;
    });

    after(async () => {
      liveServer?.close();
      liveServer?.closeAllConnections();
      await liveRegistry?.closeAll();
    });

    test('the catalog comes back naming its own dialect', async () => {
      const res = await getFrom(where, '/api/schema');
      assert.equal(res.status, 200);
      assert.equal(res.json.dialect, engine);
      assert.ok(res.json.tables.length > 0);
    });

    test('a read is positional here too', async () => {
      const res = await postTo(where, '/api/sql', { text: `select 1 as one`, limit: 5 });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.json.rows[0]));
      assert.equal(Number(res.json.rows[0][0]), 1);
    });

    test('a write is refused with the same message a SQLite connection gives', async () => {
      const res = await postTo(where, '/api/sql', {
        text: `delete from ${table} where 1 = 0`,
        write: true,
      });
      assert.equal(res.status, 403);
      assert.match(res.json.error, /is read-only\. Add "writable": true/);
    });

    test('a write without the flag is the engine refusing, as 200 with errors', async () => {
      /* Matches nothing even if it ran, because an opt-in suite is one
           somebody will eventually point at a database that matters. What is
           asserted is that the engine's own words arrive in the language
           vocabulary rather than as a failed request. */
      const res = await postTo(where, '/api/sql', { text: `delete from ${table} where 1 = 0` });
      assert.equal(res.status, 200);
      assert.match(res.json.errors[0].message, /read.only|cannot execute|denied/i);
      assert.equal(res.json.error, undefined);
    });

    test('/api/update is refused before the adapter is asked', async () => {
      const res = await postTo(where, '/api/update', {
        table,
        key: {},
        values: {},
      });
      assert.equal(res.status, 403);
      assert.match(res.json.error, /is read-only/);
    });

    test('the cross-origin guard runs whatever is underneath it', async () => {
      const res = await postTo(where, '/api/count', { table }, { origin: 'http://evil.example' });
      assert.equal(res.status, 403);
      assert.match(res.json.error, /a page at http:\/\/evil\.example/);
    });
  });
}
