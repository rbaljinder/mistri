/**
 * A command's reads in the read audit (route `command`): what its lookup and its handler read of an audited
 * resource is written under the command's id, with the rows read, as any other door's read is; its target, when
 * that is audited, is one named-record line whether or not a lookup read it first; a read of a resource that
 * audits nothing writes nothing; and a read the audit cannot record fails that command, not the next one.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { refusalReasons } from '../packages/engine/src/shared/refusal.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { readSqliteReadAudit } from '../packages/mistri/src/adapters/readAudit/sqliteReadAudit.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { forgetReadAuditCoalescing } from '../packages/mistri/src/server/readAudit.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const staff = { id: 'account-a', appId: 'desk', roles: ['staff'] };

const app = () =>
  parseAppConfig(
    {
      id: 'desk',
      name: 'Desk',
      sources: { desk: { connection: 'desk-db', default: true } },
      resources: { incident: { access: 'write', audit: { reads: true } }, service: { access: 'write' } },
      auth: { roles: { staff: { read: true, commands: ['triage', 'unaudited', 'survey', 'close', 'rename'] } } },
      views: { incidents: { kind: 'list', from: 'incident' } },
      home: 'incidents',
    },
    'command read audit fixture',
  );

const triage = defineCommand({
  source: 'desk',
  target: 'incident',
  read: ['service'],
  input: {},
  sources: { desk: ['incident', 'service'] },
  output: { parse: (value: unknown) => value as { siblings: number; open: number } },
  async lookup({ sources, record }) {
    const service = await sources.desk.service.get(String(record!.service_id));
    const siblings = await sources.desk.incident.where({ service_id: record!.service_id }).limit(10);
    return { service: service.name, siblings: siblings.length };
  },
  async handle({ db, record, lookup }) {
    const open = await db.incident.where({ status: 'open' }).limit(10);
    await db.service.where({ name: 'Billing' }).limit(1);
    await db.incident.update(record!, { status: 'triaged' });
    return { siblings: (lookup as { siblings: number }).siblings, open: open.length };
  },
});

/* Its target audits nothing; its handler reads one that does, inside the command's transaction. */
const survey = defineCommand({
  source: 'desk',
  target: 'service',
  read: ['incident'],
  input: {},
  output: { parse: (value: unknown) => value as { open: number } },
  async handle({ db, record }) {
    const open = await db.incident.where({ service_id: record!.id, status: 'open' }).limit(10);
    await db.service.update(record!, { name: `${String(record!.name)} (${open.length} open)` });
    return { open: open.length };
  },
});

/* Reads only what audits nothing: no row. */
const unaudited = defineCommand({
  source: 'desk',
  target: 'service',
  input: {},
  sources: { desk: ['service'] },
  output: { parse: (value: unknown) => value as { name: string } },
  async lookup({ sources }) {
    return { name: (await sources.desk.service.get('2')).name };
  },
  async handle({ db, record }) {
    await db.service.where({ name: 'Identity' }).limit(1);
    await db.service.update(record!, { name: 'Identity' });
    return { name: 'Identity' };
  },
});

/* No lookup, and its handler reads nothing: the executor's read of the audited target is the only read. */
const close = defineCommand({
  source: 'desk',
  target: 'incident',
  input: {},
  output: { parse: (value: unknown) => value as { status: string } },
  async handle({ db, record }) {
    await db.incident.update(record!, { status: 'closed' });
    return { status: 'closed' };
  },
});

/* No lookup, and a target that audits nothing. */
const rename = defineCommand({
  source: 'desk',
  target: 'service',
  input: {},
  output: { parse: (value: unknown) => value as { name: string } },
  async handle({ db, record }) {
    await db.service.update(record!, { name: 'Payments' });
    return { name: 'Payments' };
  },
});

async function fixture(
  run: (f: { db: DatabaseSync; execute: (command: string, key: number) => Promise<unknown> }) => Promise<void>,
  provision = true,
) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-read-audit-commands-'));
  const path = join(directory, 'desk.db');
  const db = new DatabaseSync(path);
  const registry = new Registry();
  forgetReadAuditCoalescing();
  try {
    db.exec(`CREATE TABLE service (id INTEGER PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE incident (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, service_id INTEGER REFERENCES service(id), version INTEGER NOT NULL DEFAULT 0);
      INSERT INTO service VALUES (1, 'Identity', 0), (2, 'Billing', 0);
      INSERT INTO incident VALUES (1, 'Sign-in is slow', 'open', 1, 0), (2, 'Invoices doubled', 'open', 2, 0), (3, 'Password reset fails', 'closed', 1, 0);`);
    migrateSqliteCommandJournal(path);
    if (provision) await provisionStores({ sqlite: path }, { only: ['read-audit'] });
    registry.add({ id: 'desk-db', name: 'Desk', url: path, writable: true, source: 'config' });
    const loaded = app();
    const resources = await loadAppRuntimeResources(registry, loaded, 'desk-db');
    const binding = bindBusinessCommands({
      app: loaded,
      registry: defineCommands({ triage, unaudited, survey, close, rename }),
      resources,
      writableConnection: (id) => id === 'desk-db',
    });
    let n = 0;
    const execute = async (command: string, key: number) =>
      (
        await executeBusinessCommand(binding, staff, {
          command,
          commandVersion: 1,
          key: { id: key },
          expectedVersion: 0,
          idempotencyKey: `audit-request-${String(++n).padStart(4, '0')}`,
          input: {},
        })
      ).result;
    await run({ db, execute });
  } finally {
    await registry.closeAll();
    db.close();
    forgetReadAuditCoalescing();
    rmSync(directory, { recursive: true, force: true });
  }
}

const logged = (db: DatabaseSync) =>
  readSqliteReadAudit(db, { app: 'desk', limit: 100 })
    .map((row) => [row.route, row.command, row.resource, row.actor, row.record ?? null, row.ids ?? null, row.count ?? null])
    .reverse();

test("a command's lookup and handler reads of an audited resource are written under the command, with the rows read", async () => {
  await fixture(async ({ db, execute }) => {
    assert.deepEqual(await execute('triage', 1), { siblings: 2, open: 2 });
    assert.deepEqual(logged(db), [
      // The target as it stood, by its key: a named record, once — the transaction's read of it is not a second line.
      ['command', 'triage', 'incident', 'account-a', '1', null, null],
      // The lookup's list read of the same resource: the rows it returned.
      ['command', 'triage', 'incident', 'account-a', null, '["1","3"]', 2],
      // The handler's read through `db`.
      ['command', 'triage', 'incident', 'account-a', null, '["1","2"]', 2],
    ]);
    assert.equal(db.prepare('SELECT status FROM incident WHERE id = 1').get()!.status, 'triaged');
    // Each line names the roles the reader held when it read, not only who it was.
    assert.deepEqual(
      readSqliteReadAudit(db, { app: 'desk', limit: 100 }).map((row) => [row.roles, row.membership]),
      Array.from({ length: 3 }, () => [['staff'], undefined]),
    );
    // `mistri audit reads --record 3` asks this: the one read that returned it, the lookup's, says which command.
    assert.deepEqual(
      readSqliteReadAudit(db, { app: 'desk', record: '3', limit: 100 }).map((row) => [row.route, row.command, row.ids]),
      [['command', 'triage', '["1","3"]']],
    );
  });
});

test('a command without a lookup writes one named-record line for an audited target, and none for one that audits nothing', async () => {
  await fixture(async ({ db, execute }) => {
    assert.deepEqual(await execute('close', 2), { status: 'closed' });
    assert.deepEqual(logged(db), [['command', 'close', 'incident', 'account-a', '2', null, null]]);
    assert.deepEqual(
      readSqliteReadAudit(db, { app: 'desk', record: '2', limit: 100 }).map((row) => [row.route, row.command]),
      [['command', 'close']],
    );
  });
  await fixture(async ({ db, execute }) => {
    assert.deepEqual(await execute('rename', 1), { name: 'Payments' });
    assert.deepEqual(logged(db), []);
  });
});

test('a command that reads only resources that audit nothing writes no row', async () => {
  await fixture(async ({ db, execute }) => {
    assert.deepEqual(await execute('unaudited', 2), { name: 'Identity' });
    assert.deepEqual(logged(db), []);
  });
});

test('a read the audit cannot record fails the command, and nothing it would have written is kept', async () => {
  await fixture(async ({ db, execute }) => {
    await assert.rejects(execute('triage', 1), (error) => refusalReasons(error).some((reason) => /read audit/.test(reason)));
    assert.equal(db.prepare('SELECT status FROM incident WHERE id = 1').get()!.status, 'open');
    // The next command is its own: one that reads nothing audited still runs.
    assert.deepEqual(await execute('unaudited', 2), { name: 'Identity' });
  }, false);
});

test("a handler's read is written in the command's own transaction, and its refusal undoes the command's writes", async () => {
  await fixture(async ({ db, execute }) => {
    assert.deepEqual(await execute('survey', 1), { open: 1 });
    assert.deepEqual(logged(db), [['command', 'survey', 'incident', 'account-a', null, '["1"]', 1]]);
  });
  await fixture(async ({ db, execute }) => {
    await assert.rejects(execute('survey', 1), (error) => refusalReasons(error).some((reason) => /read audit/.test(reason)));
    assert.equal(db.prepare('SELECT name FROM service WHERE id = 1').get()!.name, 'Identity');
  }, false);
});
