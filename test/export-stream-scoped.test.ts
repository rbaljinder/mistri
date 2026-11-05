/**
 * The streamed export (`POST /api/export`) where a reader sees only some of a table's rows: a row-policy App, whose
 * scope is the policy's, and a tenant App, whose scope is the lease's tenant. Each holds more than the old ceiling
 * of 100,000 rows the reader may see, interleaved through the key range with rows they may not: the file holds every
 * one of the reader's rows in the list's order and none of the others, the server reads a batch at a time behind a
 * client that does not read, and stops reading when the client leaves.
 *
 * SQLite always; PostgreSQL where `TABLEWALK_TEST_PG` names a server (a database of its own, dropped afterwards). The
 * reads are counted where they leave for the database: node:sqlite's statements and pg's client, whatever reader the
 * App put in front of them.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { EXPORT_BATCH } from '../packages/engine/src/server/http/exportRoute.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { MAX_LIMIT } from '../packages/engine/src/shared/reads.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity, VerifiedSessionInstance } from '../packages/mistri/src/server/auth/auth.js';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { createApp } from './support/createApp.js';
import { parseTestApp } from './support/commandCatalog.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

/* Two of every three rows are the reader's (desk 1, tenant north); every third is someone else's, so the scope cuts
   into every batch. The reader's rows alone are past the old ceiling. */
const TOTAL = Math.ceil(((MAX_LIMIT + 8_000) * 3) / 2);
const mine = (id: number) => id % 3 !== 0;
const MINE = Array.from({ length: TOTAL }, (_, i) => i + 1).filter(mine).length;
/* Ten scores, so the sort has long runs of ties and only the key decides inside them. */
const scoreOf = (id: number) => (id * 7) % 10;
/* Each row carries this much text, so the file is tens of megabytes: more than any socket buffer holds while paused. */
const PAD = 'x'.repeat(300);

/** The reader's ids in the list's order: score descending, the key ascending inside a score. */
function expectedOrder(): number[] {
  const ids: number[] = [];
  for (let id = 1; id <= TOTAL; id++) if (mine(id)) ids.push(id);
  return ids.sort((x, y) => scoreOf(y) - scoreOf(x) || x - y);
}

/* ---------- the reads, counted where they leave for the database ---------- */

interface Reads {
  rows: number;
  biggest: number;
}
const reads: Reads = { rows: 0, biggest: 0 };
const counted = (sql: unknown, rows: number) => {
  if (typeof sql !== 'string' || !/\bitem\b/.test(sql) || !/^\s*(select|with)\b/i.test(sql)) return;
  reads.rows += rows;
  reads.biggest = Math.max(reads.biggest, rows);
};
const all = StatementSync.prototype.all;
StatementSync.prototype.all = function (this: StatementSync, ...values: unknown[]) {
  const rows = (all as (...args: unknown[]) => unknown[]).apply(this, values);
  counted(this.sourceSQL, rows.length);
  return rows;
} as typeof all;
async function countPostgres(): Promise<void> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: { prototype: Record<string, unknown> } } };
  const prototype = (pg.default ?? (pg as unknown as { Client: { prototype: Record<string, unknown> } })).Client.prototype;
  if ((prototype.query as { counted?: true }).counted) return;
  const query = prototype.query as (...args: unknown[]) => unknown;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const answer = query.apply(this, args);
    const config = args[0];
    const sql = typeof config === 'string' ? config : (config as { text?: unknown } | undefined)?.text;
    if (answer && typeof (answer as Promise<unknown>).then === 'function')
      void (answer as Promise<{ rows?: unknown[] }>).then(
        (result) => counted(sql, result?.rows?.length ?? 0),
        () => {},
      );
    return answer;
  };
  prototype.query = Object.assign(wrapped, { counted: true as const });
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the rows read have stopped moving: what the server reads while nobody takes the file. */
async function plateau(): Promise<number> {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    await settle(150);
    if (reads.rows === last && last > 0) return last;
    last = reads.rows;
  }
  return reads.rows;
}

/** An export's answer, as a stream the test reads at its own pace. */
type Exporting = (body: Record<string, unknown>) => Promise<IncomingMessage>;
function streamFrom(url: string, headers: Record<string, string>): Exporting {
  return (body) =>
    new Promise((resolve, reject) => {
      const req = request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept-encoding': 'identity', ...headers },
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

/** The proofs both Apps answer to on both engines, over an export of `table`. */
async function exportProofs(t: TestContext, exporting: Exporting, table: string, extra: Record<string, unknown> = {}) {
  const expected = expectedOrder();
  assert.ok(expected.length > MAX_LIMIT, "the reader's rows alone are past the old ceiling");

  await t.test("every one of the reader's rows past the old ceiling, in the list order, and nobody else's", async () => {
    reads.rows = 0;
    reads.biggest = 0;
    const answer = await exporting({ ...extra, q: `${table} sort score desc show id, score`, format: 'csv' });
    assert.equal(answer.statusCode, 200);
    assert.match(String(answer.headers['content-disposition']), /attachment/);
    const ids = csvIds(await text(answer));
    assert.equal(ids.length, MINE, "no ceiling: every row of the reader's");
    assert.ok(
      ids.every((id) => mine(id)),
      'no row outside the reader scope',
    );
    assert.deepEqual(ids, expected, "the list's order, the key deciding ties");
    assert.ok(reads.biggest <= EXPORT_BATCH + 1, `one statement reads at most a batch (${reads.biggest})`);
    assert.ok(reads.rows >= MINE && reads.rows < MINE * 1.1, `the scope is read in each batch, not filtered after it (${reads.rows})`);
  });

  await t.test('a client that does not read holds the server to what the connection buffers, not the file', async () => {
    reads.rows = 0;
    const answer = await exporting({ ...extra, q: `${table} show id, score, pad`, format: 'csv' });
    assert.equal(answer.statusCode, 200);
    answer.pause();
    const held = await plateau();
    /* About 300 bytes a row: 40,000 rows is twelve megabytes, more than loopback buffers hold, and well under the
       file's hundred thousand. The server stopped reading because nobody took what it wrote. */
    assert.ok(held < 40_000, `paused, the server read ${held} of ${MINE} rows`);
    answer.resume();
    const lines = (await text(answer)).trimEnd().split('\r\n');
    assert.equal(lines.length - 1, MINE, 'resumed, the whole file arrives');
  });

  await t.test('a client that goes away stops the export: nothing more is read', async () => {
    reads.rows = 0;
    const answer = await exporting({ ...extra, q: `${table} show id, score, pad`, format: 'csv' });
    assert.equal(answer.statusCode, 200);
    await new Promise<void>((resolve) => answer.once('data', () => resolve()));
    answer.destroy();
    answer.socket?.destroy();
    const stopped = await plateau();
    await settle(300);
    assert.equal(reads.rows, stopped, 'no batch is read after the client left');
    assert.ok(stopped < MINE / 2, `the export stopped early (${stopped} of ${MINE} rows read)`);
    /* The server is free for the next question. */
    const next = await exporting({ ...extra, q: `${table} score = 3 show id, score`, format: 'csv' });
    const ids = csvIds(await text(next));
    assert.deepEqual(
      ids.sort((x, y) => x - y),
      expected.filter((id) => scoreOf(id) === 3).sort((x, y) => x - y),
    );
  });
}

/* node:test runs a test's after hooks in the order they were added, so the
 database a fixture made first would be dropped under the server still
 reading it. These unwind newest first, as nested setup must. */
const undoing = new WeakMap<TestContext, (() => unknown)[]>();
function undo(t: TestContext, step: () => unknown): void {
  let steps = undoing.get(t);
  if (!steps) {
    const stack: (() => unknown)[] = [];
    undoing.set(t, (steps = stack));
    t.after(async () => {
      for (const next of stack.reverse()) await next();
    });
  }
  steps.push(step);
}

/* ---------- the fixture's table, on each engine ---------- */

/** A SQLite file holding `item`, its owner column named `column`, and `setup` run before the rows. The
 * key leads with the owner, as a tenant-owned table's must; inside one reader's rows it is the id. */
function sqliteItems(t: TestContext, column: string, owner: (id: number) => string | number, setup = ''): string {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-export-scoped-'));
  undo(t, () => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'items.db');
  const db = new DatabaseSync(file);
  const kind = typeof owner(1) === 'number' ? 'INTEGER' : 'TEXT';
  db.exec(`PRAGMA journal_mode=WAL; ${setup}
    CREATE TABLE item (id INTEGER NOT NULL, ${column} ${kind} NOT NULL, score INTEGER NOT NULL, pad TEXT, PRIMARY KEY (${column}, id))`);
  db.exec('BEGIN');
  const insert = db.prepare('INSERT INTO item VALUES (?, ?, ?, ?)');
  for (let id = 1; id <= TOTAL; id++) insert.run(id, owner(id), scoreOf(id), PAD);
  db.exec('COMMIT');
  db.close();
  return file;
}

/** A PostgreSQL database of its own holding `item`, as sqliteItems. */
async function postgresItems(t: TestContext, prefix: string, column: string, owner: [string, string]): Promise<string> {
  const { url, drop } = await uuidPostgresDatabase(prefix);
  const control = await pgClient(url);
  undo(t, async () => {
    await control.end().catch(() => {});
    await drop();
  });
  const integer = /^\d+$/.test(owner[0]);
  await control.query(
    `CREATE TABLE item (id integer NOT NULL, ${column} ${integer ? 'integer' : 'text'} NOT NULL, score integer NOT NULL, pad text, PRIMARY KEY (${column}, id))`,
  );
  await control.query(
    `INSERT INTO item SELECT id, (CASE WHEN id % 3 <> 0 THEN $1 ELSE $2 END)${integer ? '::integer' : ''}, (id * 7) % 10, $3
     FROM generate_series(1, $4::integer) AS id`,
    [owner[0], owner[1], PAD, TOTAL],
  );
  await control.query('ANALYZE item');
  return url;
}

const engines = [
  { dialect: 'sqlite' as const, skip: false as const },
  { dialect: 'postgres' as const, skip: liveSkip('postgres', LIVE) },
];

/* ---------- a row-policy App ---------- */

for (const { dialect, skip } of engines)
  describe(`the streamed export in a row-policy App on ${dialect}`, { skip }, () => {
    test('the proofs', { timeout: 300_000 }, async (t) => {
      if (dialect === 'postgres') await countPostgres();
      const appId = 'desks';
      const connection = 'desk-db';
      const url =
        dialect === 'sqlite'
          ? sqliteItems(t, 'desk', (id) => (mine(id) ? 1 : 2))
          : await postgresItems(t, 'tw_export_policy', 'desk', ['1', '2']);
      const directory = mkdtempSync(join(tmpdir(), 'mistri-export-policy-'));
      const registry = new Registry();
      registry.add({ id: connection, name: connection, url, source: 'config' });
      const app = parseAppConfig(
        {
          id: appId,
          name: 'Desks',
          sources: { main: { connection, default: true } },
          resources: { item: {} },
          auth: { rows: 'policy', roles: { reader: { read: true, export: ['item'] } } },
          views: { items: { kind: 'list', from: 'item' } },
          home: 'items',
          nav: ['items'],
        },
        'policy export fixture',
      );
      const identity: Identity = { id: 'desk-one', who: 'one@example.test', role: 'reader' };
      const host: AppHost = {
        app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
        pages: [],
        auth: { spec: app.auth!, store: join(directory, 'auth.db'), close() {}, handler: async () => {}, session: async () => identity },
      };
      const policyFile = join(directory, 'policy.mjs');
      writeFileSync(
        policyFile,
        `export default { appId: ${JSON.stringify(appId)},
        resolveRows(principal) { return { item: { groups: [[{ column: 'desk', op: '=', value: principal.id === 'desk-one' ? 1 : 2 }]] } }; } };`,
      );
      const policy = await loadHttpAppPolicy({ app, registry, file: policyFile, verifySession: async () => identity });
      const bound = { host: '127.0.0.1', port: 0 };
      const server = createApp({ registry, bound, apps: [host], policy });
      server.listen(0, bound.host);
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      undo(t, async () => {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await closed;
        await policy.retire();
        await registry.closeAll();
        clearJournal();
        rmSync(directory, { recursive: true, force: true });
      });
      const exporting = streamFrom(`http://${bound.host}:${address.port}/api/export?app=${appId}`, { 'x-mistri-account': identity.id });
      await exportProofs(t, exporting, 'item', { app: appId });
    });
  });

/* ---------- a tenant App ---------- */

for (const { dialect, skip } of engines)
  describe(`the streamed export in a tenant App on ${dialect}`, { skip }, () => {
    test('the proofs', { timeout: 300_000 }, async (t) => {
      if (dialect === 'postgres') await countPostgres();
      const appId = 'stock';
      const binding = { appId, source: { id: 'business', connection: 'business-db' }, storeId: 'stock-export-store' };
      const app = parseTestApp(
        {
          id: appId,
          name: 'Stock',
          auth: { rows: 'tenant', roles: { member: { read: true, export: ['item'] } } },
          sources: { business: { connection: binding.source.connection } },
          resources: { item: { owner: 'tenant' } },
          views: { items: { kind: 'list', from: 'item' } },
          nav: ['items'],
          home: 'items',
        },
        'tenant export fixture',
      );
      const rows: RowScope = { item: true };
      const policy = defineAppTenantPolicy({
        kind: 'tenant',
        appId,
        storeId: binding.storeId,
        ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
        resolveMembershipRows: () => rows,
        resolveRows: () => rows,
      });
      const owner = (id: number) => (mine(id) ? 'north' : 'south');
      let source: { id: string; connection: string; existingPath: string } | { id: string; connection: string; url: string };
      let admin: (run: (admin: ReturnType<typeof createSqliteTenantAdministration>) => Promise<void>) => Promise<void>;
      if (dialect === 'sqlite') {
        const path = sqliteItems(t, 'tenant_id', owner);
        provisionSqliteTenantStore(path, binding);
        migrateSqliteCommandJournal(path);
        const db = new DatabaseSync(path);
        undo(t, () => db.close());
        source = { ...binding.source, existingPath: path };
        admin = async (run) => {
          const operations = new TransactionOperations();
          db.exec('BEGIN IMMEDIATE');
          await run(createSqliteTenantAdministration(db, operations, binding));
          await operations.finish();
          db.exec('COMMIT');
        };
      } else {
        const url = await postgresItems(t, 'tw_export_tenant', 'tenant_id', ['north', 'south']);
        await migratePostgresTenantStore(url, binding);
        await migratePostgresCommandJournal(url);
        const control = await pgClient(url);
        undo(t, () => control.end().catch(() => {}));
        source = { ...binding.source, url };
        admin = async (run) => {
          await control.query('BEGIN');
          const operations = new TransactionOperations();
          await run(createPostgresTenantAdministration(control, operations, binding));
          await operations.finish();
          await control.query('COMMIT');
        };
      }
      await admin(async (store) => {
        for (const tenantId of ['north', 'south']) {
          await store.putTenant({ tenantId, status: 'active', expectedVersion: null });
          await store.putMembership({
            tenantId,
            accountId: 'eve',
            membershipId: `${tenantId}-eve`,
            status: 'active',
            roles: ['member'],
            validUntil: Date.now() + 3_600_000,
            expectedVersion: null,
          });
        }
      });
      const enrollment = await createTenantEnrollment<IncomingMessage>({
        app,
        pages: [],
        policy,
        source,
        deployment: 'stock-export-deployment',
        roles: ['member'],
        maxLifetimeMs: 300_000,
        verifySession: async () => ({ id: 'eve', who: 'eve@example.invalid' }),
      });
      const session: VerifiedSessionInstance = {
        identity: { id: 'eve', who: 'eve@example.invalid' },
        sessionId: 'session-eve',
        expiresAt: Date.now() + 3_600_000,
      };
      const bound = { host: '127.0.0.1', port: 0 };
      const served = createTenantHttpServer({ app, enrollment, bound, verifySessionInstance: () => session });
      undo(t, async () => {
        const stopped = new Promise<void>((resolve) => served.server.close(() => resolve()));
        served.server.closeAllConnections();
        await stopped;
        await served.retire();
        await enrollment.retire();
      });
      served.server.listen(0, bound.host);
      await once(served.server, 'listening');
      const address = served.server.address();
      assert.ok(address && typeof address === 'object');
      bound.port = address.port;
      const base = `http://${bound.host}:${bound.port}`;
      const opened = await fetch(`${base}/api/tenant/context/open?app=${appId}&tenant=north`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(opened.status, 200, await opened.clone().text());
      const lease = (await opened.json()) as { tabId: string; context: string; accountId: string; revision: number };
      const exporting = streamFrom(`${base}/api/export?app=${appId}&tenant=north`, {
        'x-mistri-tab': lease.tabId,
        'x-mistri-context': lease.context,
        'x-mistri-lease-revision': String(lease.revision),
        'x-mistri-account': lease.accountId,
      });
      /* The file names the lease it was read on, as a read's reply does; the client keeps nothing else. */
      const named = await exporting({ q: 'item limit 1 show id', format: 'ndjson' });
      assert.equal(named.statusCode, 200);
      assert.equal(named.headers['x-mistri-context'], lease.context);
      assert.equal(named.headers['x-mistri-tenant'], 'north');
      await text(named);
      await exportProofs(t, exporting, 'item');
    });
  });
