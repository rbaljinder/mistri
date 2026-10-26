/**
 * A command's `when` over its target's rollups and computed columns (commandWhen.ts): `when: 'last_part =
 * installed'` where `last_part` is `latest('part', 'status')`. What the binding refuses about one — rows the command
 * does not read, rows narrowed through a reference, a comparison a transaction cannot decide — and that availability, prepare and the
 * run all judge it of the rows as they are in the transaction.
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
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { catalogOf } from './support/commandCatalog.js';

const agent: Identity = { id: 'account-agent', who: 'agent@example.test', role: 'agent' };
const COMMANDS = ['close', 'archive', 'bill', 'chase', 'settle'];

const app = () => ({
  id: 'shop',
  name: 'Shop',
  sources: { shop: { connection: 'shop-db', default: true } },
  resources: {
    job: {
      access: 'write',
      rollups: {
        open_parts: { fn: 'count', from: 'part', query: 'status = pending' },
        last_part: { fn: 'latest', from: 'part', column: 'status', sort: 'added_on' },
        spend: { fn: 'sum', from: 'part', column: 'cost' },
        // Narrowed through a reference: a path no single-table read in a transaction can follow.
        sited: { fn: 'count', from: 'part', query: 'job_id.title = Kitchen' },
        // A sum of a computed column of the parts (R4): what is owed is each part's cost times its quantity.
        owed: { fn: 'sum', from: 'part', column: 'line_total' },
        dearest: { fn: 'max', from: 'part', column: 'line_total' },
      },
      computed: {
        waiting: { type: 'boolean', value: 'open_parts > 0 and status = open' },
        balance: { type: 'number', value: 'owed - paid' },
      },
      // Offered on the record, so the App asks whether each is available.
      actions: Object.fromEntries(COMMANDS.map((id) => [id, { label: id, command: id }])),
    },
    part: { access: 'write', computed: { line_total: { type: 'number', value: 'cost * qty' } } },
  },
  auth: { providers: ['email'], roles: { agent: { read: true, commands: COMMANDS } } },
  views: { jobs: { kind: 'list', from: 'job' } },
  home: 'jobs',
  nav: ['jobs'],
});

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

const registry = () =>
  defineCommands({
    // Nothing still waiting on a supplier.
    close: command('open_parts = 0'),
    // The newest part is fitted.
    archive: command('last_part = installed or last_part is empty'),
    bill: command('spend >= 100'),
    chase: command('waiting = true'),
    // A balance built from a rollup of a computed column: offered while money is owed.
    settle: command('balance > 0 and dearest >= 60'),
  });

async function database(directory: string) {
  const file = join(directory, 'shop.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE site (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE job (id INTEGER PRIMARY KEY, site_id INTEGER REFERENCES site(id), title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      paid NUMERIC NOT NULL DEFAULT 0);
    CREATE TABLE part (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES job(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'installed')), cost NUMERIC NOT NULL DEFAULT 0, qty INTEGER NOT NULL DEFAULT 1, added_on DATE);
    INSERT INTO site (id, name) VALUES (1, 'North');
    INSERT INTO job (id, site_id, title) VALUES (1, 1, 'Kitchen'), (2, 1, 'Bathroom'), (3, 1, 'Porch');
    INSERT INTO part (id, job_id, status, cost, qty, added_on) VALUES
      (1, 1, 'installed', 80, 1, '2026-01-02'), (2, 1, 'pending', 40, 1, '2026-01-01'),
      (3, 2, 'installed', 30, 2, '2026-01-01'), (4, 2, 'installed', 20, 1, NULL);`);
  migrateSqliteCommandJournal(file);
  clearJournal('shop-db');
  const connections = new Registry();
  connections.add({ id: 'shop-db', name: 'Shop', url: file, writable: true, source: 'config' });
  return { db, file, registry: connections };
}

test('the binding refuses a when over a rollup it cannot judge in a transaction, naming why', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-when-rollup-bind-'));
  const { db, registry: connections } = await database(directory);
  try {
    const manifest = parseAppConfig(app(), 'when', {
      commands: catalogOf(Object.fromEntries(COMMANDS.map((id) => [id, { target: 'job' }]))),
    });
    const resources = await loadAppRuntimeResources(connections, manifest, 'shop-db');
    const bound = async (close: ReturnType<typeof command>) =>
      bindBusinessCommands({
        app: manifest,
        registry: defineCommands({ ...registry(), close }),
        resources,
        writableConnection: () => true,
      }).authorize('close', { id: agent.id, appId: 'shop', roles: ['agent'] } as never);
    assert.ok(await bound(command('open_parts = 0')));
    await assert.rejects(bound(command('open_parts = 0', [])), /reads "part", which the command does not read; add it to "read"/);
    await assert.rejects(bound(command('sited > 0')), /narrows its rows through a reference/);
    await assert.rejects(bound(command('last_part contains inst')), /judges a rollup or a computed column with =/);
  } finally {
    db.close();
    await connections.closeAll();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('availability, prepare and the run judge a rollup or a computed column in the when as the rows stand', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-when-rollup-run-'));
  const { db, registry: connections } = await database(directory);
  const manifest = parseAppConfig(app(), 'when', {
    commands: catalogOf(Object.fromEntries(COMMANDS.map((id) => [id, { target: 'job' }]))),
  });
  const pages = parsePagesConfig({ pages: [] }, 'when pages');
  const host: AppHost = {
    app: { app: manifest, path: '/private/shop/app.ts', pages, sources: {} },
    pages,
    auth: { spec: manifest.auth!, store: '/private/shop/auth.db', close() {}, handler: async () => {}, session: async () => agent },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry: connections, bound, apps: [host], pages, commands: { appId: 'shop', registry: registry() } });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  const post = async (path: string, body: object) => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-mistri-account': agent.id },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const available = async (name: string) => {
    const answer = await post('/api/commands/availability', {
      checks: [{ command: name, commandVersion: 1, keys: [{ id: 1 }, { id: 2 }, { id: 3 }] }],
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return answer.body.checks[0].available;
  };
  let requests = 0;
  const run = async (name: string, id: number, between?: () => void) => {
    const prepared = await post('/api/commands/prepare', { command: name, commandVersion: 1, key: { id } });
    if (prepared.status !== 200) return prepared;
    between?.();
    return post('/api/commands/execute', {
      command: name,
      commandVersion: 1,
      key: { id },
      expectedVersion: prepared.body.expectedVersion,
      idempotencyKey: `when-rollup-request-${String(++requests).padStart(4, '0')}`,
      input: {},
    });
  };
  const status = (id: number) => (db.prepare('SELECT status FROM job WHERE id = ?').get(id) as { status: string }).status;
  try {
    // Job 1 waits on part 2; job 2's parts are fitted; job 3 has none (a count of 0, a latest of nothing).
    assert.deepEqual(await available('close'), [false, true, true]);
    // Job 1's newest part (by added_on) is the fitted one; job 2's dated part outranks its undated one.
    assert.deepEqual(await available('archive'), [true, true, true]);
    assert.deepEqual(await available('bill'), [true, false, false]);
    assert.deepEqual(await available('chase'), [true, false, false]);
    // Job 1 owes 120 (its dearest part 80), job 2 owes 80 (its dearest 30 times 2), job 3 owes nothing.
    assert.deepEqual(await available('settle'), [true, true, false]);
    db.exec(`UPDATE job SET paid = 120 WHERE id = 1; UPDATE part SET qty = 1 WHERE id = 3`);
    assert.deepEqual(await available('settle'), [false, false, false]);
    db.exec(`UPDATE job SET paid = 0 WHERE id = 1`);
    db.exec(`INSERT INTO part (id, job_id, status, added_on) VALUES (5, 2, 'pending', '2026-02-01')`);
    assert.deepEqual(await available('archive'), [true, false, true]);

    const refused = await run('close', 1);
    assert.equal(refused.body.code, 'ineligible_state', JSON.stringify(refused.body));
    assert.equal(status(1), 'open');
    const done = await run('close', 3);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(status(3), 'done');
    // The part is fitted between asking and running: the run reads it in its own transaction.
    db.exec(`UPDATE part SET status = 'installed' WHERE id = 2`);
    const closed = await run('close', 1);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(status(1), 'done');
    // The computed column reads the record's own status as well as the rollup.
    assert.deepEqual(await available('chase'), [false, true, false]);
    // Prepared while nothing waits; a part ordered before the run is seen by the run's own transaction.
    db.exec(`UPDATE part SET status = 'installed' WHERE id = 5`);
    const raced = await run('close', 2, () => db.exec(`INSERT INTO part (id, job_id) VALUES (6, 2)`));
    assert.equal(raced.body.code, 'ineligible_state', JSON.stringify(raced.body));
    assert.equal(status(2), 'open');
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    db.close();
    await connections.closeAll();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
  }
});
