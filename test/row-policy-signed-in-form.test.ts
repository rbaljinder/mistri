/**
 * A signed-in form on a row-policy App: its command names no record
 * (`targets: 'none'`), so the envelope's key is empty, and the row it creates
 * must land inside the member's rows. The scoped transaction reads the row
 * back through the policy after the insert, and refuses, whole, one the
 * policy does not admit.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, type Filter } from '../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { parseTestApp } from './support/commandCatalog.js';
import type { RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { createAppSourceAdapter } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, type BusinessCommandActor } from '../packages/mistri/src/server/commands/businessCommands.js';
import { bindScopedBusinessCommands } from '../packages/mistri/src/server/commands/scopedBusinessCommandAccess.js';

const actor: BusinessCommandActor = { id: 'desk-one-member', appId: 'desk', roles: ['member'] };
const deskOne: Filter = { groups: [[{ column: 'desk', op: '=', value: 1 }]] };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-row-policy-form-')),
    path = join(directory, 'operations.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE raw_ticket (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL, name TEXT NOT NULL);
    INSERT INTO raw_ticket VALUES (1, 1, 'Mine'), (2, 2, 'Theirs');`);
  migrateSqliteCommandJournal(path);
  const adapter = new SqliteAdapter(path, 'operations');
  t.after(async () => {
    await adapter.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const runtime = createAppSourceAdapter(
    { operations: { adapter, schema: await adapter.introspect(), writable: true, resources: { tickets: 'raw_ticket' } } },
    'operations',
  );
  const anchor = runtime.forSource('operations');
  const resources: RuntimeResources = {
    adapter: runtime.adapter,
    schema: runtime.schema,
    connections: ['operations-db'],
    connectionFor: () => 'operations-db',
    toPhysical: (resource) => runtime.resolve(resource).physicalTable,
    toLogical: (physical) => runtime.catalogs.get('operations')!.toLogical(physical),
    toLogicalAt: (physical) => runtime.catalogs.get('operations')!.toLogical(physical),
    forConnection: (connection) => {
      if (connection !== 'operations-db') throw new Refusal('Unknown connection');
      return anchor;
    },
  };
  const app = parseTestApp(
    {
      id: 'desk',
      name: 'Desk',
      sources: { operations: { connection: 'operations-db', default: true } },
      resources: { tickets: { access: 'write' } },
      auth: { rows: 'policy', roles: { member: { read: true, commands: ['open'] } } },
      views: {
        tickets: { kind: 'list', from: 'tickets' },
        'new-ticket': {
          kind: 'form',
          label: 'New ticket',
          command: { id: 'open', version: 1, input: { id: { type: 'number' }, desk: { type: 'number' }, name: { type: 'text' } } },
        },
      },
      nav: ['tickets', 'new-ticket'],
      home: 'tickets',
    },
    'row-policy form fixture',
  );
  const registry = {
    open: defineCommand({
      source: 'operations',
      target: 'tickets',
      targets: 'none',
      write: ['tickets'],
      input: { id: { type: 'number' }, desk: { type: 'number' }, name: { type: 'text' } },
      output: { parse: (value: unknown) => value as { id: number } },
      async handle({ db }, input) {
        await db.tickets.insert({ id: Number(input.id), desk: Number(input.desk), name: String(input.name) });
        return { id: Number(input.id) };
      },
    }),
  };
  const binding = bindScopedBusinessCommands({
    app,
    resources,
    registry,
    writableConnection: () => true,
    resultReferences: { open: (value: unknown) => [{ table: 'tickets', key: { id: (value as { id: number }).id } }] },
  }).withScope({ tickets: deskOne }, () => {});
  const submit = (input: Record<string, unknown>) =>
    executeBusinessCommand(
      binding,
      actor,
      {
        command: 'open',
        commandVersion: 1,
        key: {},
        expectedVersion: 0,
        idempotencyKey: `open-ticket-${String(input.id)}-request`,
        input,
      },
      { signal: new AbortController().signal, door: 'ui' },
    );
  const tickets = () =>
    db
      .prepare('SELECT id, desk, name FROM raw_ticket ORDER BY id')
      .all()
      .map((row) => ({ ...row }));
  return { submit, tickets, binding };
}

test("a row-policy App's signed-in form creates a row inside the member's rows, and never one outside them", async (t) => {
  const f = await fixture(t);
  assert.equal(f.binding.creates?.('open'), true, "the form's command names no record");
  const applied = await f.submit({ id: 3, desk: 1, name: 'New on my desk' });
  assert.equal(applied.status, 'applied');
  // Outside the policy: refused whole, and the row is not there.
  await assert.rejects(f.submit({ id: 4, desk: 2, name: 'Planted on theirs' }));
  // A key is still refused: the form's command names none.
  await assert.rejects(
    executeBusinessCommand(
      f.binding,
      actor,
      {
        command: 'open',
        commandVersion: 1,
        key: { id: 2 },
        expectedVersion: 0,
        idempotencyKey: 'open-ticket-keyed-request',
        input: { id: 5, desk: 1, name: 'Keyed' },
      },
      { signal: new AbortController().signal },
    ),
  );
  assert.deepEqual(f.tickets(), [
    { id: 1, desk: 1, name: 'Mine' },
    { id: 2, desk: 2, name: 'Theirs' },
    { id: 3, desk: 1, name: 'New on my desk' },
  ]);
});
