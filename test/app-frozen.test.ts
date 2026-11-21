/**
 * A resource's `frozen` condition (appTransitions.ts, commandFrozen.ts): a row
 * it matches, judged on the row as stored, is refused every update, delete and
 * command with 409 `frozen`. New is not a write to a stored row, and a command
 * with no target is not a write to one either.
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
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { catalogOf } from './support/commandCatalog.js';
import { appTransitionRules } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const agent: Identity = { id: 'account-agent', who: 'agent@example.test', role: 'agent' };
const deskApp = (editsAll: boolean) => ({
  id: 'desk',
  name: 'Desk',
  sources: { desk: { connection: 'desk-db', default: true } },
  resources: {
    lead: {
      access: 'write',
      delete: true,
      frozen: 'status in (closed, void) and locked_at is not empty',
      actions: {
        touch: { label: 'Touch', command: 'touch', header: false },
        peek: { label: 'Peek', command: 'peek', header: false },
      },
    },
  },
  auth: {
    providers: ['email'],
    roles: {
      agent: {
        read: true,
        write: ['lead'],
        ...(editsAll
          ? {}
          : { fields: { lead: { read: ['id', 'name', 'status', 'note', 'locked_at'], write: ['name', 'status', 'locked_at'] } } }),
        commands: editsAll ? ['peek'] : ['touch', 'peek', 'sweep'],
      },
    },
  },
  views: { leads: { kind: 'list', from: 'lead' } },
  home: 'leads',
  nav: ['leads'],
});

/** `editsAll`: the agent writes every field of a lead, which a delete needs, and so holds no command that writes one. */
async function fixture(
  editsAll: boolean,
  run: (f: {
    runAs: (command: string, key: number | null) => Promise<unknown>;
    post: (path: string, body: object) => Promise<{ status: number; body: any }>;
    row: (id: number) => { name: string; status: string; note: string | null } | undefined;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-frozen-'));
  const file = join(directory, 'desk.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE lead (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', note TEXT, locked_at TIMESTAMP);
    INSERT INTO lead (id, name, status, locked_at) VALUES (1, 'Open one', 'open', NULL), (2, 'Sealed', 'closed', '2026-01-01 00:00:00'), (3, 'Closed, not locked', 'closed', NULL), (4, 'Void and sealed', 'void', '2026-01-02 00:00:00');`);
  migrateSqliteCommandJournal(file);
  clearJournal('desk-db');
  const registry = new Registry();
  registry.add({ id: 'desk-db', name: 'Desk', url: file, writable: true, source: 'config' });
  const commands = defineCommands({
    touch: defineCommand({
      source: 'desk',
      target: 'lead',
      async handle({ db: tables, record }) {
        await tables.lead.update(record, { note: 'touched' });
      },
    }),
    // Reads only: a frozen row is still refused, because the row is not to be acted on at all.
    peek: defineCommand({ source: 'desk', target: 'lead', async handle() {} }),
    // No target: not a write to a stored row, so the condition never applies.
    sweep: defineCommand({
      source: 'desk',
      target: 'lead',
      targets: 'none',
      async handle({ db: tables }) {
        await tables.lead.insert({ name: 'Swept in' });
      },
    }),
  });
  const app = parseAppConfig(deskApp(editsAll), 'frozen doors', {
    commands: catalogOf({ touch: { target: 'lead' }, peek: { target: 'lead' }, sweep: {} }),
  });
  const pages = parsePagesConfig({ pages: [] }, 'frozen pages');
  const host: AppHost = {
    app: { app, path: '/private/desk/app.ts', pages, sources: {} },
    pages,
    auth: {
      spec: app.auth!,
      store: '/private/desk/auth.db',
      close() {},
      handler: async () => {},
      session: async () => agent,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages, commands: { appId: 'desk', registry: commands } });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const base = `http://${bound.host}:${bound.port}`;
  const check = new DatabaseSync(file, { readOnly: true });
  try {
    await run({
      runAs: async (command, key) => {
        const resources = await loadAppRuntimeResources(registry, app, 'desk-db');
        const binding = bindBusinessCommands({ app, registry: commands, resources, writableConnection: () => true });
        return executeBusinessCommand(
          binding,
          { id: 'account-agent', appId: 'desk', roles: ['agent'] },
          {
            command,
            commandVersion: 1,
            ...(key === null ? {} : { key: { id: key } }),
            expectedVersion: 0,
            idempotencyKey: `frozen-run-${command}-${key}-0001`,
            input: {},
          },
          { door: 'job' },
        );
      },
      post: async (path, body) => {
        const response = await fetch(`${base}${path}`, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { 'content-type': 'application/json', 'x-mistri-account': agent.id },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      },
      row: (id) => check.prepare('SELECT name, status, note FROM lead WHERE id = ?').get(id) as never,
    });
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
}

test('Save and Delete refuse a frozen row with 409 frozen and leave it as it was', async () => {
  await fixture(true, async ({ post, row }) => {
    const update = (id: number, values: Record<string, unknown>) =>
      post('/api/update', { app: 'desk', table: 'lead', key: { id }, values });
    const refused = await update(2, { name: 'Late edit' });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.errors[0].code, 'frozen');
    assert.equal(
      refused.body.errors[0].message,
      'This lead is frozen (status in (closed, void) and locked_at is not empty); it cannot be changed.',
    );
    assert.equal((await update(4, { name: 'Renamed' })).body.errors[0].code, 'frozen');
    assert.equal(row(2)!.name, 'Sealed');
    const removed = await post('/api/delete', { app: 'desk', table: 'lead', key: { id: 2 }, confirm: true });
    assert.equal(removed.status, 409, JSON.stringify(removed.body));
    assert.equal(removed.body.errors[0].code, 'frozen');
    assert.ok(row(2));
    // Closed alone is not frozen: the condition is the whole of it.
    assert.equal((await update(3, { name: 'Fine' })).status, 200);
    assert.equal((await update(1, { name: 'Fine' })).status, 200);
    assert.equal((await post('/api/delete', { app: 'desk', table: 'lead', key: { id: 3 }, confirm: true })).status, 200);
    assert.equal(row(3), undefined);
  });
});

test('the condition is judged on the stored row: a write that makes a row match is taken, the next is refused', async () => {
  await fixture(false, async ({ post, row }) => {
    const update = (values: Record<string, unknown>) => post('/api/update', { app: 'desk', table: 'lead', key: { id: 1 }, values });
    const sealing = await update({ status: 'closed', locked_at: '2026-02-01 00:00:00' });
    assert.equal(sealing.status, 200, JSON.stringify(sealing.body));
    assert.equal(row(1)!.status, 'closed');
    const after = await update({ name: 'Too late' });
    assert.equal(after.status, 409, JSON.stringify(after.body));
    assert.equal(after.body.errors[0].code, 'frozen');
    assert.equal(row(1)!.name, 'Open one');
  });
});

test('New is unaffected: a row that would match is created, then frozen', async () => {
  await fixture(false, async ({ post }) => {
    const created = await post('/api/insert', {
      app: 'desk',
      table: 'lead',
      values: { name: 'Born sealed', status: 'closed', locked_at: '2026-03-01 00:00:00' },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const key = created.body.key ?? created.body.row ?? created.body;
    const id = Number(key.id ?? 5);
    const update = await post('/api/update', { app: 'desk', table: 'lead', key: { id }, values: { name: 'x' } });
    assert.equal(update.body.errors[0].code, 'frozen', JSON.stringify(update.body));
  });
});

test('a command targeting a frozen row is refused on the executor, even one that writes nothing', async () => {
  await fixture(false, async ({ runAs, row }) => {
    for (const command of ['touch', 'peek']) {
      await assert.rejects(runAs(command, 2), (error: any) => error.code === 'frozen' && /is frozen/.test(error.message), command);
    }
    assert.equal(row(2)!.note, null);
    // `targets: 'none'` has no stored row to judge.
    await runAs('sweep', null);
  });
});

test('a command over HTTP answers 409 frozen for a frozen row and is offered nowhere for it', async () => {
  await fixture(false, async ({ post, row }) => {
    const request = { command: 'touch', commandVersion: 1, key: { id: 2 } };
    const prepared = await post('/api/commands/prepare', request);
    if (prepared.status === 200) {
      const run = await post('/api/commands/execute', {
        ...request,
        expectedVersion: prepared.body.expectedVersion,
        idempotencyKey: 'frozen-http-request-0001',
        input: {},
      });
      assert.equal(run.status, 409, JSON.stringify(run.body));
      assert.equal(run.body.code, 'frozen');
    } else {
      assert.equal(prepared.status, 409, JSON.stringify(prepared.body));
      assert.equal(prepared.body.code, 'frozen');
    }
    assert.equal(row(2)!.note, null);
    const open = { ...request, key: { id: 1 } };
    const ready = await post('/api/commands/prepare', open);
    assert.equal(ready.status, 200, JSON.stringify(ready.body));
    const ran = await post('/api/commands/execute', {
      ...open,
      expectedVersion: ready.body.expectedVersion,
      idempotencyKey: 'frozen-http-request-0002',
      input: {},
    });
    assert.equal(ran.status, 200, JSON.stringify(ran.body));
    assert.equal(row(1)!.note, 'touched');
    const offered = await post('/api/commands/availability', {
      checks: [{ command: 'touch', commandVersion: 1, keys: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] }],
    });
    assert.equal(offered.status, 200, JSON.stringify(offered.body));
    assert.deepEqual(offered.body.checks[0].available, [true, false, true, false]);
  });
});

const schema: DatabaseSchema = {
  dialect: 'sqlite',
  label: 'Desk',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'lead',
      name: 'lead',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
        { name: 'status', type: 'TEXT', primaryKey: false, nullable: false },
      ],
    },
  ],
};
const declared = (frozen: string) =>
  parseAppConfig(
    {
      id: 'desk',
      name: 'Desk',
      sources: { desk: { connection: 'x', default: true } },
      resources: { lead: { access: 'write', frozen } },
      views: { leads: { kind: 'list', from: 'lead' } },
      home: 'leads',
      nav: ['leads'],
    },
    'frozen check',
  );

test('check: a frozen condition over an unknown column or with bad syntax is a definition error naming the resource', () => {
  assert.deepEqual(appTransitionRules(declared('status = closed'), schema).problems, []);
  assert.ok(appTransitionRules(declared('status = closed'), schema).rules.get('lead')?.frozenWhen);
  const unknown = appTransitionRules(declared('colour = red'), schema).problems.join('\n');
  assert.match(unknown, /resources "lead": frozen "colour = red": /);
  const syntax = appTransitionRules(declared('status ='), schema).problems.join('\n');
  assert.match(syntax, /resources "lead": frozen "status =": /);
  assert.throws(() => declared('  '), /frozen/);
});
