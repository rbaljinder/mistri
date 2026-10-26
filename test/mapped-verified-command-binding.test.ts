/** Private native writer selection through both existing logical mapping layers. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { createAppResources, appResourceVerifiedCommandRunner } from '../packages/mistri/src/server/app/appResources.js';
import { appSourceVerifiedCommandRunner } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import {
  bindVerifiedBusinessCommands,
  hasAppScopeCommandEventOwner,
  issueAppScopeCommandEvents,
} from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { int, shape } from '../packages/mistri/src/server/commands/commandShapes.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import {
  CommandTransactionFailure,
  COMMAND_JOURNAL_TABLES,
  migrateSqliteCommandJournal,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { COMMAND_EVENT_TABLES, provisionSqliteCommandEventStore } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { nativeVerifiedCommandRunner } from '../packages/mistri/src/server/commands/verifiedCommandRunner.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

const actor = { id: 'account', appId: 'mapped', roles: ['editor'] };
const eventSource = { appId: 'mapped', sourceId: 'archive', storeId: 'mapped-events' };
const receipt = {
  id: 'mapped-receipt',
  appId: 'mapped',
  actorId: 'account',
  commandId: 'archive-edit',
  commandVersion: 1,
  idempotencyKey: 'mapped-attempt',
  fingerprint: 'fingerprint',
  resultJson: '{"id":1}',
  requestId: 'mapped-request',
  completedAt: '2026-09-14T12:00:00.000Z',
};

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-mapped-verified-'));
  const registry = new Registry();
  const databases: DatabaseSync[] = [];
  t.after(async () => {
    await registry.closeAll();
    for (const db of databases) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (const id of ['primary', 'secondary']) {
    const path = join(directory, `${id}.db`),
      db = new DatabaseSync(path);
    databases.push(db);
    db.exec("CREATE TABLE physical_ticket(id INTEGER PRIMARY KEY,name TEXT NOT NULL); INSERT INTO physical_ticket VALUES(1,'Original')");
    migrateSqliteCommandJournal(path);
    if (id === 'secondary') provisionSqliteCommandEventStore(path, eventSource);
    registry.add({ id, name: id, url: path, writable: true, source: 'config' });
  }
  const app = parseAppConfig(
    {
      id: 'mapped',
      name: 'Mapped',
      sources: { operations: { connection: 'primary', default: true }, archive: { connection: 'secondary' } },
      resources: {
        ticket: { physical: 'physical_ticket', access: 'write' },
        'archive.ticket': { physical: 'physical_ticket', access: 'write' },
      },
      auth: { roles: { editor: { read: true, commands: ['edit', 'archive-edit'] }, viewer: { read: true } } },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    },
    'mapped verified fixture',
  );
  const event = defineEvent('ticket.changed', shape({ id: int() }));
  const command = (source: string, events = false) =>
    defineCommand({
      source,
      target: 'ticket',
      read: ['ticket'],
      write: ['ticket'],
      input: {},
      output: { parse: (value: unknown) => value },
      ...(events ? { events: { changed: defineEventProjection(event, (output: unknown) => output as { id: number }) } } : {}),
      handle: async () => ({ id: 1 }),
    });
  const commands = defineCommands({ edit: command('operations'), 'archive-edit': command('archive', true) });
  const resources = await loadAppRuntimeResources(registry, app, 'primary');
  const bind = (verify: () => unknown, suppliedEvents = issueAppScopeCommandEvents(eventSource)) =>
    bindVerifiedBusinessCommands(
      {
        app,
        registry: commands,
        resources,
        writableConnection: (id) => registry.configOf(id)?.writable === true,
        events: suppliedEvents,
      },
      verify,
    );
  return { registry, resources, databases, bind };
}

test('verified binding preserves renamed resources, anchored sources, event branding and final rollback', async (t) => {
  const f = await fixture(t);
  let checks = 0;
  const bound = f.bind(() => {
    checks++;
  });
  assert.equal(hasAppScopeCommandEventOwner(bound), true);
  const primary = bound.authorize('edit', actor),
    secondary = bound.authorize('archive-edit', actor);
  await commandsOf(primary).commandTransaction!(async (tx) => {
    await tx.update({ table: 'ticket', key: { id: 1 }, values: { name: 'Primary' } });
  });
  await commandsOf(secondary).commandTransaction!(async (tx, journal) => {
    await tx.update({ table: 'ticket', key: { id: 1 }, values: { name: 'Secondary' } });
    await journal.commit(receipt, { target: 'archive.ticket', keyJson: '{"id":1}', changesJson: '[]' }, [
      { name: 'ticket.changed', version: 1, payloadJson: '{"id":1}' },
    ]);
  });
  assert.equal(checks, 4);
  assert.equal(f.databases[0].prepare('SELECT name FROM physical_ticket').get()!.name, 'Primary');
  assert.equal(f.databases[1].prepare('SELECT name FROM physical_ticket').get()!.name, 'Secondary');
  let final = 0;
  await assert.rejects(
    f
      .bind(() => {
        if (++final === 2) throw new Error('owner retired');
      })
      .authorize('archive-edit', actor).commandTransaction!(async (tx, journal) => {
      await tx.update({ table: 'ticket', key: { id: 1 }, values: { name: 'Refused' } });
      await journal.commit(
        { ...receipt, id: 'refused-receipt', idempotencyKey: 'refused-attempt' },
        { target: 'archive.ticket', keyJson: '{"id":1}', changesJson: '[]' },
        [{ name: 'ticket.changed', version: 1, payloadJson: '{"id":1}' }],
      );
    }),
    (error) => error instanceof CommandTransactionFailure && error.outcome === 'not_applied',
  );
  assert.equal(f.databases[1].prepare('SELECT name FROM physical_ticket').get()!.name, 'Secondary');
  for (const table of [COMMAND_JOURNAL_TABLES.receipt, COMMAND_EVENT_TABLES.event]) {
    assert.equal(f.databases[1].prepare(`SELECT count(*) AS n FROM "${table}"`).get()!.n, 1);
  }
  assert.equal(
    f.databases[1].prepare(`SELECT count(*) AS n FROM "${COMMAND_JOURNAL_TABLES.receipt}" WHERE manifest_json IS NOT NULL`).get()!.n,
    1,
  );
});

test('caught source/physical-name refusals poison verified writes, and ordinary grants still refuse', async (t) => {
  const f = await fixture(t);
  let checks = 0;
  const bound = f.bind(() => {
    checks++;
  });
  assert.throws(() => bound.authorize('edit', { ...actor, roles: ['viewer'] }));
  assert.equal(checks, 0);
  for (const table of ['archive.ticket', 'physical_ticket', 'unknown']) {
    await assert.rejects(
      commandsOf(bound.authorize('edit', actor)).commandTransaction!(async (tx) => {
        await tx.update({ table: 'ticket', key: { id: 1 }, values: { name: 'Must roll back' } });
        await tx.update({ table, key: { id: 1 }, values: { name: 'Forbidden' } }).catch(() => {});
      }),
      CommandTransactionFailure,
    );
    assert.equal(f.databases[0].prepare('SELECT name FROM physical_ticket').get()!.name, 'Original');
    assert.equal(f.databases[1].prepare('SELECT name FROM physical_ticket').get()!.name, 'Original');
  }
  const authorized = bound.authorize('edit', actor);
  f.registry.configOf('primary')!.writable = false;
  assert.throws(() => commandsOf(authorized).commandTransaction!(async () => {}));
});

test('mapped runner lookup refuses copies and composites, and native subclasses keep constructor provenance', async (t) => {
  const f = await fixture(t);
  const mapped = f.resources.forConnection('primary');
  assert.ok(appSourceVerifiedCommandRunner(mapped));
  assert.equal(appSourceVerifiedCommandRunner({ ...mapped }), undefined);
  assert.equal(appSourceVerifiedCommandRunner(new Proxy(mapped, {})), undefined);
  assert.equal(appSourceVerifiedCommandRunner(f.resources.adapter), undefined);
  const physical = await f.registry.open('primary');
  const local = createAppResources(physical.adapter, physical.schema, { renamed: 'physical_ticket' });
  assert.ok(appResourceVerifiedCommandRunner(local.adapter));
  assert.equal(appResourceVerifiedCommandRunner({ ...local.adapter }), undefined);
  await appResourceVerifiedCommandRunner(local.adapter)!(
    () => {},
    async (tx) => {
      await tx.update({ table: 'renamed', key: { id: 1 }, values: { name: 'Local mapped' } });
    },
  );
  class Derived extends SqliteAdapter {}
  const derived = new Derived(f.registry.configOf('primary')!.url);
  try {
    await commandsOf(derived).verifiedCommandTransaction(
      () => {},
      async () => {},
    );
    const prototype = Object.getPrototypeOf(derived);
    let traps = 0;
    Object.setPrototypeOf(
      derived,
      new Proxy(prototype, {
        getOwnPropertyDescriptor() {
          traps++;
          throw new Error();
        },
        getPrototypeOf() {
          traps++;
          throw new Error();
        },
      }),
    );
    try {
      assert.equal(nativeVerifiedCommandRunner(derived), undefined);
      assert.equal(traps, 0);
    } finally {
      Object.setPrototypeOf(derived, prototype);
    }
  } finally {
    await derived.close();
  }
});
