/**
 * The streamed export's two limits (packages/engine/src/server/http/exportRoute.ts): a file read by position (a
 * table with no key, a union, an order the key cannot continue) stops at `EXPORT_OFFSET_ROWS` and is refused past it
 * before a byte is written, since each of its batches reads every row before it again; and one person streams at
 * most `EXPORTS_IN_FLIGHT` files at once, so a few clients that read slowly cannot hold every connection.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { Registry, type ConnectionConfig } from '../packages/engine/src/server/connections.js';
import { EXPORT_OFFSET_ROWS, EXPORTS_IN_FLIGHT } from '../packages/engine/src/server/http/exportRoute.js';
import { createApp } from './support/createApp.js';

const directory = mkdtempSync(join(tmpdir(), 'mistri-export-limits-'));
const file = join(directory, 'limits.db');
/* One row past the ceiling in a table with no key (read by position), and a keyed table whose file is tens of
   megabytes: more than any socket buffer holds while its client does not read. */
const LOOSE_ROWS = EXPORT_OFFSET_ROWS + 1;
const KEYED_ROWS = 60_000;
{
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE loose (n INTEGER NOT NULL, label TEXT NOT NULL)');
  db.exec('CREATE TABLE keyed (id INTEGER PRIMARY KEY, pad TEXT NOT NULL)');
  db.exec('BEGIN');
  const loose = db.prepare('INSERT INTO loose VALUES (?, ?)');
  for (let n = 1; n <= LOOSE_ROWS; n++) loose.run(n, `row ${n}`);
  const keyed = db.prepare('INSERT INTO keyed VALUES (?, ?)');
  const pad = 'x'.repeat(400);
  for (let id = 1; id <= KEYED_ROWS; id++) keyed.run(id, pad);
  db.exec('COMMIT');
  db.close();
}
after(() => rmSync(directory, { recursive: true, force: true }));

const connection: ConnectionConfig = { id: 'limits', name: 'Limits', url: file, source: 'config' };

async function serve(): Promise<{ base: string; close(): Promise<void> }> {
  const registry = new Registry();
  registry.add(connection);
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [], pages: [] });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  return {
    base: `http://${bound.host}:${bound.port}`,
    close: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await registry.closeAll();
    },
  };
}

function exportStream(base: string, body: Record<string, unknown>): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/api/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-encoding': 'identity' },
    });
    req.once('response', resolve);
    req.once('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function text(answer: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of answer) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

test('a file read by position is refused past the ceiling, before a byte of it, and served within it', async () => {
  const served = await serve();
  try {
    const refused = await exportStream(served.base, { q: 'loose', format: 'csv' });
    assert.equal(refused.statusCode, 422);
    assert.match(String(refused.headers['content-type']), /json/, 'a refusal, not the start of a file');
    const body = JSON.parse(await text(refused)) as { code: string; error: string };
    assert.equal(body.code, 'export_too_large');
    assert.match(body.error, /100,000 rows/);

    /* Its own limit keeps it within the ceiling; so does a filter that leaves fewer rows. */
    const limited = await exportStream(served.base, { q: `loose limit ${EXPORT_OFFSET_ROWS} show n`, format: 'csv' });
    assert.equal(limited.statusCode, 200);
    assert.equal((await text(limited)).trimEnd().split('\n').length, EXPORT_OFFSET_ROWS + 1, 'a header and every row');
    const narrowed = await exportStream(served.base, { q: 'loose n > 99000 show n', format: 'ndjson' });
    assert.equal(narrowed.statusCode, 200);
    assert.equal((await text(narrowed)).trimEnd().split('\n').length, LOOSE_ROWS - 99_000);
  } finally {
    await served.close();
  }
});

test(`one person streams at most ${EXPORTS_IN_FLIGHT} files at once; the next is refused until one ends`, async () => {
  const served = await serve();
  try {
    /* Neither client reads: each file stays open, holding its place. */
    const open: IncomingMessage[] = [];
    for (let i = 0; i < EXPORTS_IN_FLIGHT; i++) {
      const answer = await exportStream(served.base, { q: 'keyed', format: 'csv' });
      assert.equal(answer.statusCode, 200);
      answer.pause();
      open.push(answer);
    }
    const refused = await exportStream(served.base, { q: 'keyed limit 5', format: 'csv' });
    assert.equal(refused.statusCode, 429);
    assert.equal((JSON.parse(await text(refused)) as { code: string }).code, 'too_many_exports');

    /* A client that leaves gives its place back. */
    const gone = open.shift()!;
    gone.destroy();
    await once(gone.socket, 'close');
    let next: IncomingMessage | undefined;
    for (let tries = 0; tries < 50; tries++) {
      next = await exportStream(served.base, { q: 'keyed limit 5 show id', format: 'csv' });
      if (next.statusCode !== 429) break;
      await text(next);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(next!.statusCode, 200);
    assert.equal((await text(next!)).trimEnd().split('\n').length, 6);
    for (const answer of open) answer.destroy();
  } finally {
    await served.close();
  }
});
