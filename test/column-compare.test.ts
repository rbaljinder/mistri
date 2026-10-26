/**
 * Two values compared in a query and in a guard (DM3): `qty < reorder_at`, `paid < spend` where `spend` is a rollup,
 * `balance > paid` where `balance` is computed. A list's segment writes the comparison into its statement; a guard —
 * a command's `when`, a fixed action's `when` granted without write — judges it in its transaction, once the row is
 * read, since no single-table read compares two columns (filter.ts). Each must say the same of the same rows.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { catalogOf } from './support/commandCatalog.js';

const agent: Identity = { id: 'account-agent', who: 'agent@example.test', role: 'agent' };
const COMMANDS = ['reorder', 'chase', 'settle'];

const manifest = () =>
  parseAppConfig(
    {
      id: 'shop',
      name: 'Shop',
      sources: { shop: { connection: 'compare-db', default: true } },
      resources: {
        job: {
          access: 'write',
          rollups: { spend: { fn: 'sum', from: 'part', column: 'cost' } },
          computed: { balance: { type: 'number', value: 'spend - paid' } },
          segments: { low: 'qty < reorder_at', owing: 'paid < spend', unsettled: 'balance > paid' },
          actions: {
            restock: { label: 'Restock', set: { status: 'restocking' }, when: 'qty < reorder_at' },
            ...Object.fromEntries(COMMANDS.map((id) => [id, { label: id, command: id }])),
          },
        },
        part: { access: 'write' },
      },
      auth: { providers: ['email'], roles: { agent: { read: true, commands: COMMANDS, actions: { job: ['restock'] } } } },
      views: { jobs: { kind: 'list', from: 'job', tabs: ['low', 'owing', 'unsettled'] } },
      home: 'jobs',
      nav: ['jobs'],
    },
    'compare',
    { commands: catalogOf(Object.fromEntries(COMMANDS.map((id) => [id, { target: 'job' }]))) },
  );

const command = (when: string, read: string[] = ['part']) =>
  defineCommand({
    source: 'shop',
    target: 'job',
    read,
    when,
    async handle({ db, record }) {
      await db.job.update(record, { status: 'done' });
    },
  } as Parameters<typeof defineCommand>[0]);

test('a segment, a command and a fixed action compare two values alike', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-compare-'));
  const file = join(directory, 'shop.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE job (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      qty INTEGER, reorder_at INTEGER, paid NUMERIC NOT NULL DEFAULT 0);
    CREATE TABLE part (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES job(id), cost NUMERIC NOT NULL DEFAULT 0);
    INSERT INTO job (id, title, qty, reorder_at, paid) VALUES
      (1, 'Low and owing', 2, 5, 10), (2, 'Stocked and paid', 9, 5, 40), (3, 'No threshold', 1, NULL, 0);
    INSERT INTO part (job_id, cost) VALUES (1, 30), (1, 20), (2, 40);`);
  migrateSqliteCommandJournal(file);
  clearJournal('compare-db');
  const registry = new Registry();
  registry.add({ id: 'compare-db', name: 'Shop', url: file, writable: true, source: 'config' });
  const app = manifest();
  const pages = parsePagesConfig({ pages: [] }, 'compare pages');
  const host: AppHost = {
    app: { app, path: '/private/shop/app.ts', pages, sources: {} },
    pages,
    auth: { spec: app.auth!, store: join(directory, 'auth.db'), close() {}, handler: async () => {}, session: async () => agent },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({
    registry,
    bound,
    apps: [host],
    pages,
    commands: {
      appId: 'shop',
      registry: defineCommands({
        reorder: command('qty < reorder_at'),
        // A stored column against a rollup, and a computed column against a stored one.
        chase: command('paid < spend'),
        settle: command('balance > paid and status = open'),
      }),
    },
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  const post = async (path: string, body: object) => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-mistri-account': agent.id },
      body: JSON.stringify(path.startsWith('/api/commands') ? body : { app: 'shop', ...body }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const listed = async (path: string, other: string) => {
    const answer = await post('/api/view/run', {
      view: { id: 'v', name: 'v', base: 'job', columns: [{ path: 'id' }], filter: { groups: [[{ path, op: '<', other }]] } },
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return answer.body.rows.map((row: { id: number }) => row.id);
  };
  const available = async (name: string) => {
    const answer = await post('/api/commands/availability', {
      checks: [{ command: name, commandVersion: 1, keys: [{ id: 1 }, { id: 2 }, { id: 3 }] }],
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return answer.body.checks[0].available;
  };
  const status = (id: number) => (db.prepare('SELECT status FROM job WHERE id = ?').get(id) as { status: string }).status;
  try {
    // The list: job 1 is below its threshold and owes 50 against 10 paid; job 3 has no threshold, so never low.
    assert.deepEqual(await listed('qty', 'reorder_at'), [1]);
    assert.deepEqual(await listed('paid', 'spend'), [1]);
    assert.deepEqual(await listed('paid', 'balance'), [1]);
    // The guards say what the list says.
    assert.deepEqual(await available('reorder'), [true, false, false]);
    assert.deepEqual(await available('chase'), [true, false, false]);
    assert.deepEqual(await available('settle'), [true, false, false]);

    // A fixed action granted without write: its when is judged of the stored row.
    const refused = await post('/api/update', { table: 'job', key: { id: 2 }, values: { status: 'restocking' } });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(status(2), 'open');
    const restocked = await post('/api/update', { table: 'job', key: { id: 1 }, values: { status: 'restocking' } });
    assert.equal(restocked.status, 200, JSON.stringify(restocked.body));
    assert.equal(status(1), 'restocking');

    // Stock arrives on job 2's threshold: the run reads it in its own transaction.
    db.exec('UPDATE job SET qty = 1 WHERE id = 2');
    assert.deepEqual(await available('reorder'), [true, true, false]);
    const prepared = await post('/api/commands/prepare', { command: 'reorder', commandVersion: 1, key: { id: 2 } });
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    const ran = await post('/api/commands/execute', {
      command: 'reorder',
      commandVersion: 1,
      key: { id: 2 },
      expectedVersion: prepared.body.expectedVersion,
      idempotencyKey: 'compare-request-0001',
      input: {},
    });
    assert.equal(ran.status, 200, JSON.stringify(ran.body));
    assert.equal(status(2), 'done');
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    db.close();
    await registry.closeAll();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
  }
});
