/**
 * A machine that moves with another record's command: a part's `pending: { on:
 * { cancelJob: 'void' } }` says cancelling the job voids its pending parts, in
 * the command's own transaction, with no handler code. What the binding
 * refuses about such a machine, and what a run does to each row: moved along
 * the edge (stamping `since`), left where it already is, or — in a state that
 * does not list the command — the whole command refused, nothing written.
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

const partMachine = (states: Record<string, unknown>) => ({ column: 'status', since: 'moved_at', states });
const PART = {
  pending: { on: { install: 'installed', cancelJob: 'void' } },
  // Held parts wait on a supplier: cancelling the job does not decide what happens to them.
  held: { on: { release: 'pending' } },
  installed: { final: true },
  void: { final: true },
};
const app = (part: Record<string, unknown> = PART) => ({
  id: 'shop',
  name: 'Shop',
  sources: { shop: { connection: 'shop-db', default: true } },
  resources: {
    job: {
      access: 'write',
      machine: { column: 'status', states: { open: { on: { cancelJob: 'cancelled' } }, cancelled: { final: true } } },
    },
    part: { access: 'write', machine: partMachine(part) },
  },
  auth: { providers: ['email'], roles: { agent: { read: true, write: ['part'], commands: ['cancelJob'] } } },
  views: { jobs: { kind: 'list', from: 'job' } },
  home: 'jobs',
  nav: ['jobs'],
});

const cancelJob = (extra: Record<string, unknown> = {}) =>
  defineCommand({
    source: 'shop',
    target: 'job',
    write: ['part'],
    async handle({ db, record }) {
      // The handler moves the job alone; its parts move by their machine.
      await db.job.update(record, { status: 'cancelled' });
    },
    ...extra,
  } as Parameters<typeof defineCommand>[0]);

async function database(directory: string) {
  const file = join(directory, 'shop.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE job (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open');
    CREATE TABLE part (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES job(id), status TEXT NOT NULL DEFAULT 'pending', moved_at TIMESTAMP);
    INSERT INTO job (id, title) VALUES (1, 'Kitchen'), (2, 'Bathroom'), (3, 'Porch');
    INSERT INTO part (id, job_id, status) VALUES (1, 1, 'pending'), (2, 1, 'pending'), (3, 1, 'installed'), (4, 2, 'pending'), (5, 2, 'held'), (6, 3, 'pending');`);
  migrateSqliteCommandJournal(file);
  clearJournal('shop-db');
  const registry = new Registry();
  registry.add({ id: 'shop-db', name: 'Shop', url: file, writable: true, source: 'config' });
  return { db, file, registry };
}

test('the binding judges a machine that moves with a command: written, one reference, one state each, unconditionally', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-carried-bind-'));
  const { db, registry } = await database(directory);
  try {
    const bound = async (part: Record<string, unknown>, command: ReturnType<typeof cancelJob>) => {
      const manifest = parseAppConfig(app(part), 'carried', { commands: catalogOf({ cancelJob: { target: 'job' } }) });
      const resources = await loadAppRuntimeResources(registry, manifest, 'shop-db');
      const binding = bindBusinessCommands({
        app: manifest,
        registry: defineCommands({ cancelJob: command }),
        resources,
        writableConnection: () => true,
      });
      return binding.authorize('cancelJob', { id: agent.id, appId: 'shop', roles: ['agent'] } as never);
    };
    assert.ok((await bound(PART, cancelJob())).machine?.carried?.length);
    await assert.rejects(
      bound(PART, cancelJob({ write: [] })),
      /moves with command "cancelJob" \(pending → void\), so the command writes "part"/,
    );
    await assert.rejects(
      bound({ ...PART, pending: { on: { install: 'installed', cancelJob: ['void', 'held'] } } }, cancelJob()),
      /moves to one state, unconditionally/,
    );
    await assert.rejects(
      bound({ ...PART, pending: { on: { install: 'installed', cancelJob: { to: 'void', when: 'moved_at is empty' } } } }, cancelJob()),
      /unconditionally/,
    );
  } finally {
    db.close();
    await registry.closeAll();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a run moves each of the record’s rows along its edge, leaves a finished one, and is refused whole over one that cannot move', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-carried-run-'));
  const { db, file, registry } = await database(directory);
  const manifest = parseAppConfig(app(), 'carried', { commands: catalogOf({ cancelJob: { target: 'job' } }) });
  const pages = parsePagesConfig({ pages: [] }, 'carried pages');
  const host: AppHost = {
    app: { app: manifest, path: '/private/shop/app.ts', pages, sources: {} },
    pages,
    auth: { spec: manifest.auth!, store: '/private/shop/auth.db', close() {}, handler: async () => {}, session: async () => agent },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({
    registry,
    bound,
    apps: [host],
    pages,
    commands: { appId: 'shop', registry: defineCommands({ cancelJob: cancelJob() }) },
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  const check = new DatabaseSync(file, { readOnly: true });
  const post = async (path: string, body: object) => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-mistri-account': agent.id },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  let requests = 0;
  const cancel = async (id: number) => {
    const prepared = await post('/api/commands/prepare', { command: 'cancelJob', commandVersion: 1, key: { id } });
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    return post('/api/commands/execute', {
      command: 'cancelJob',
      commandVersion: 1,
      key: { id },
      expectedVersion: prepared.body.expectedVersion,
      idempotencyKey: `carried-machine-request-${String(++requests).padStart(4, '0')}`,
      input: {},
    });
  };
  const parts = (job: number) =>
    (check.prepare('SELECT id, status, moved_at FROM part WHERE job_id = ? ORDER BY id').all(job) as Array<Record<string, unknown>>).map(
      (row) => [row.id, row.status, row.moved_at !== null],
    );
  const job = (id: number) => (check.prepare('SELECT status FROM job WHERE id = ?').get(id) as { status: string }).status;
  try {
    const done = await cancel(1);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(job(1), 'cancelled');
    // Both pending parts are void, `since` stamped; the installed one is final and stays.
    assert.deepEqual(parts(1), [
      [1, 'void', true],
      [2, 'void', true],
      [3, 'installed', false],
    ]);
    // A held part does not list the cancel: the job, and its pending part, stay as they were.
    const refused = await cancel(2);
    assert.equal(refused.body.code, 'ineligible_state', JSON.stringify(refused.body));
    assert.equal(job(2), 'open');
    assert.deepEqual(parts(2), [
      [4, 'pending', false],
      [5, 'held', false],
    ]);
    // Another job's parts are its own.
    assert.deepEqual(parts(3), [[6, 'pending', false]]);
  } finally {
    check.close();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    db.close();
    await registry.closeAll();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
  }
});
