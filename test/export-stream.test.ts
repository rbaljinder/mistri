/**
 * The streamed export (`POST /api/export`, packages/engine/src/server/http/exportRoute.ts) past the old ceiling of
 * 100,000 rows: every matching row in the list's order, read in batches by key, the server holding one batch however
 * slowly the client reads, and nothing more read once the client has gone.
 *
 * SQLite always; PostgreSQL where `TABLEWALK_TEST_PG` names a server (a schema of its own, dropped afterwards). The
 * narrowed resource's half runs on SQLite: its conditions are ANDed into every read by the App's reader, under the
 * batches' continuation, so a file of one resource never holds another's row however many batches it spans.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { describe, test, type TestContext } from 'node:test';
import type { Adapter, QueryRequest } from '../packages/engine/src/adapters/adapter.js';
import { Registry, type ConnectionConfig } from '../packages/engine/src/server/connections.js';
import { EXPORT_BATCH } from '../packages/engine/src/server/http/exportRoute.js';
import { MAX_LIMIT } from '../packages/engine/src/shared/reads.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { createApp } from './support/createApp.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

/** A plain `pg` client, for the fixture the adapter cannot build (a schema of its own). */
interface Client {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
async function pgClient(url: string): Promise<Client> {
  const module = 'pg';
  const pg = (await import(module)) as { Client: new (options: unknown) => Client };
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}
/* Every 41st row is group b, spread through the key range so the filter cuts into every batch; the rest, group a,
   are past the old ceiling. */
const TOTAL = MAX_LIMIT + 7_000;
const groupOf = (id: number) => (id % 41 === 0 ? 'b' : 'a');
const B_ROWS = Math.floor(TOTAL / 41);
const A_ROWS = TOTAL - B_ROWS;
/* Each row carries this much text, so the file is tens of megabytes: more than any socket buffer holds while paused. */
const PAD = 'x'.repeat(300);
/* Ten scores, so the sort has long runs of ties and only the key decides inside them. */
const scoreOf = (id: number) => (id * 7) % 10;

/** Every statement the export reads through, by the size of its answer and whether it skipped rows (an offset). */
interface Reads {
  rows: number;
  statements: number;
  biggest: number;
  offsets: number;
}

/** The adapter's reads counted where they leave for the database. */
function counted(adapter: Adapter): Reads {
  const reads: Reads = { rows: 0, statements: 0, biggest: 0, offsets: 0 };
  const query = adapter.query!.bind(adapter);
  adapter.query = async (request: QueryRequest) => {
    const result = await query(request);
    reads.statements++;
    reads.rows += result.rows.length;
    reads.biggest = Math.max(reads.biggest, result.rows.length);
    if (request.offset) reads.offsets++;
    return result;
  };
  return reads;
}

interface Served {
  base: string;
  reads: Reads;
  close(): Promise<void>;
}

async function serve(connection: ConnectionConfig, apps: AppHost[] = []): Promise<Served> {
  const registry = new Registry();
  registry.add(connection);
  const { adapter } = await registry.open(connection.id);
  const reads = counted(adapter);
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps, pages: apps[0]?.pages ?? [] });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  return {
    base: `http://${bound.host}:${bound.port}`,
    reads,
    close: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await registry.closeAll();
    },
  };
}

/** The export's answer, as a stream the test reads at its own pace. */
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

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `reads.rows` has stopped moving: what the server reads while nobody takes the file. */
async function plateau(reads: Reads): Promise<number> {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    await settle(150);
    if (reads.rows === last && last > 0) return last;
    last = reads.rows;
  }
  return reads.rows;
}

/** The ids of a CSV export of `id,score`, in file order, each checked against its score. */
function csvIds(file: string): number[] {
  const lines = file.replace(/^﻿/, '').trimEnd().split('\r\n');
  assert.equal(lines[0], 'id,score');
  return lines.slice(1).map((line) => {
    const [id, score] = line.split(',').map(Number);
    assert.equal(score, scoreOf(id), `row ${id} carries its own score`);
    return id;
  });
}

/** Group a's ids in the list's order — score descending, the key ascending inside a score. */
function expectedOrder(): number[] {
  const ids: number[] = [];
  for (let id = 1; id <= TOTAL; id++) if (groupOf(id) === 'a') ids.push(id);
  return ids.sort((x, y) => scoreOf(y) - scoreOf(x) || x - y);
}

/** The proofs both engines answer to, over a connection holding `item`. */
async function exportProofs(t: TestContext, connection: ConnectionConfig, table: string) {
  const expected = expectedOrder();
  assert.ok(expected.length > MAX_LIMIT, 'the fixture holds more of group a than the old ceiling');

  await t.test('every matching row past the old ceiling, in the list order, each once, by key', async () => {
    const served = await serve(connection);
    try {
      const answer = await exportStream(served.base, { q: `${table} grp = a sort score desc show id, score`, format: 'csv' });
      assert.equal(answer.statusCode, 200);
      assert.match(String(answer.headers['content-disposition']), /attachment/);
      const ids = csvIds(await text(answer));
      assert.equal(ids.length, A_ROWS, 'no ceiling: every row of group a');
      assert.equal(new Set(ids).size, ids.length, 'no row twice');
      assert.deepEqual(ids, expected, "the list's order, the key deciding ties");
      assert.equal(served.reads.offsets, 0, 'every batch after the first starts after the last row, never by skipping');
      assert.ok(served.reads.biggest <= EXPORT_BATCH, `one statement reads at most a batch (${served.reads.biggest})`);
      assert.equal(served.reads.statements, Math.ceil(A_ROWS / EXPORT_BATCH) + (A_ROWS % EXPORT_BATCH ? 0 : 1));
    } finally {
      await served.close();
    }
  });

  await t.test("a question's own limit ends the file, and JSON and NDJSON stream alike", async () => {
    const served = await serve(connection);
    try {
      /* Not a batch multiple, so the last batch is cut short. */
      const limit = EXPORT_BATCH * 12 + 345;
      const json = await exportStream(served.base, { q: `${table} grp = a sort score desc limit ${limit} show id`, format: 'json' });
      const rows = JSON.parse(await text(json)) as Array<{ id: number }>;
      assert.equal(rows.length, limit);
      assert.deepEqual(
        rows.map((row) => row.id),
        expected.slice(0, limit),
      );
      const ndjson = await exportStream(served.base, { q: `${table} grp = b show id`, format: 'ndjson' });
      const lines = (await text(ndjson)).trimEnd().split('\n');
      assert.equal(lines.length, B_ROWS);
      /* No sort named: the table's default order, newest key first, as the list reads it. */
      assert.deepEqual(
        lines.map((line) => (JSON.parse(line) as { id: number }).id),
        Array.from({ length: B_ROWS }, (_, i) => (B_ROWS - i) * 41),
      );
    } finally {
      await served.close();
    }
  });

  await t.test('a client that does not read holds the server to what the connection buffers, not the file', async () => {
    const served = await serve(connection);
    try {
      const answer = await exportStream(served.base, { q: `${table} grp = a show id, score, pad`, format: 'csv' });
      answer.pause();
      const held = await plateau(served.reads);
      /* About 300 bytes a row: 40,000 rows is twelve megabytes, more than loopback buffers hold, and well under
         the file's hundred thousand. The server stopped reading because nobody took what it wrote. */
      assert.ok(held < 40_000, `paused, the server read ${held} of ${A_ROWS} rows`);
      answer.resume();
      const lines = (await text(answer)).trimEnd().split('\r\n');
      assert.equal(lines.length - 1, A_ROWS, 'resumed, the whole file arrives');
      assert.equal(served.reads.rows, A_ROWS);
    } finally {
      await served.close();
    }
  });

  await t.test('a client that goes away stops the export: nothing more is read', async () => {
    const served = await serve(connection);
    try {
      const answer = await exportStream(served.base, { q: `${table} grp = a show id, score, pad`, format: 'csv' });
      await new Promise<void>((resolve) => answer.once('data', () => resolve()));
      answer.destroy();
      answer.socket?.destroy();
      const stopped = await plateau(served.reads);
      await settle(300);
      assert.equal(served.reads.rows, stopped, 'no batch is read after the client left');
      assert.ok(stopped < A_ROWS / 2, `the export stopped early (${stopped} of ${A_ROWS} rows read)`);
      /* The server is free for the next question. */
      const next = await exportStream(served.base, { q: `${table} grp = b show id`, format: 'ndjson' });
      assert.equal((await text(next)).trimEnd().split('\n').length, B_ROWS);
    } finally {
      await served.close();
    }
  });
}

const row = (id: number) => [id, groupOf(id), scoreOf(id), PAD] as const;

describe('the streamed export on SQLite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-export-stream-'));
  const file = join(directory, 'export.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, grp TEXT NOT NULL, score INTEGER NOT NULL, pad TEXT)');
  db.exec('BEGIN');
  const insert = db.prepare('INSERT INTO item VALUES (?, ?, ?, ?)');
  for (let id = 1; id <= TOTAL; id++) insert.run(...row(id));
  db.exec('COMMIT');
  db.close();

  test('the proofs', async (t) => {
    try {
      await exportProofs(t, { id: 'export-sqlite', name: 'Export', url: file, source: 'config' }, 'item');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('the streamed export on PostgreSQL', { skip: liveSkip('postgres', LIVE) }, () => {
  const schema = `rc_export_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  test('the proofs', async (t) => {
    const admin = await pgClient(LIVE!);
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`CREATE TABLE ${schema}.item (id integer PRIMARY KEY, grp text NOT NULL, score integer NOT NULL, pad text)`);
      await admin.query(
        `INSERT INTO ${schema}.item SELECT id, CASE WHEN id % 41 = 0 THEN 'b' ELSE 'a' END, (id * 7) % 10, $1
         FROM generate_series(1, $2::integer) AS id`,
        [PAD, TOTAL],
      );
      await admin.query(`ANALYZE ${schema}.item`);
      await exportProofs(t, { id: 'export-pg', name: 'Export', url: LIVE!, source: 'config', schemas: [schema] }, `${schema}.item`);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await admin.end();
    }
  });
});

/* ---------- a narrowed resource, across batches ---------- */

const NARROWED_ROWS = EXPORT_BATCH * 3 + 17;

test("a narrowed resource's file holds only its rows, under the question's filter, however many batches it spans", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-export-narrowed-'));
  const file = join(directory, 'narrowed.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE audit_event (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, weight INTEGER NOT NULL, note TEXT NOT NULL)');
  db.exec('BEGIN');
  const insert = db.prepare('INSERT INTO audit_event VALUES (?, ?, ?, ?)');
  /* Kinds interleave through the key range, so every batch of one resource steps over the other's rows. */
  for (let id = 1; id <= NARROWED_ROWS * 2; id++) insert.run(id, id % 2 ? 'order' : 'conversation', id % 5, `note ${id}`);
  db.exec('COMMIT');
  db.close();
  const app = parseAppConfig(
    {
      id: 'narrowed-export',
      name: 'Narrowed export',
      connection: 'narrowed-export',
      resources: {
        audit_event: {},
        orderEvents: { physical: 'audit_event', query: 'kind = order' },
        chatEvents: { physical: 'audit_event', query: 'kind = conversation' },
      },
      views: { 'order-events': { kind: 'list', from: 'orderEvents', label: 'Order events' } },
      home: 'order-events',
      nav: ['order-events'],
    },
    'narrowed export fixture',
  );
  const pages = parsePagesConfig({ pages: [] }, 'pages');
  const served = await serve({ id: 'narrowed-export', name: 'Narrowed', url: file, source: 'config' }, [
    { app: { path: 'narrowed.ts', app, pages, sources: {} }, pages },
  ]);
  try {
    const answer = await exportStream(served.base, {
      app: app.id,
      q: 'orderEvents weight > 0 sort weight desc show id, weight',
      format: 'json',
    });
    assert.equal(answer.statusCode, 200);
    const rows = JSON.parse(await text(answer)) as Array<{ id: number; weight: number }>;
    const wanted = Array.from({ length: NARROWED_ROWS * 2 }, (_, i) => i + 1)
      .filter((id) => id % 2 === 1 && id % 5 > 0)
      .sort((x, y) => (y % 5) - (x % 5) || x - y);
    assert.ok(wanted.length > EXPORT_BATCH * 2, 'the file spans several batches');
    assert.deepEqual(
      rows.map((row) => row.id),
      wanted,
      'every order event of weight above zero, in the list order, and no conversation',
    );
    assert.equal(served.reads.offsets, 0, 'by key, the narrowed conditions under every continuation');
  } finally {
    await served.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
