/**
 * A command that only adds child rows — a note, a comment, an attachment —
 * is not refused for a stale record (businessCommandExecution.ts): it has
 * nothing of the target's to overwrite. A command that writes a row of its
 * target still is.
 *
 * Under live churn the difference is the whole story. The client prepares a
 * record and sends the revision it read (commands.tsx `runCommand`, three
 * tries); a record another person edits every 120 ms has moved by the time the
 * send arrives, on every try. Here the churn is a real timer against a real
 * tenant store, and each try waits out one tick between its prepare and its send.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { createTenantCommands } from '../packages/mistri/src/server/tenant/tenantCommands.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { openSqliteTenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { openSqliteTenantWriteSource } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { parseTestApp } from './support/commandCatalog.js';

type Request = { cookie: string };
const request = { cookie: 'alice' };
const north = ['north'];
const output = { parse: (value: unknown) => value as Record<string, unknown> };
const TICK_MS = 120;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Name = 'addNote' | 'rename' | 'plainNote';

async function fixture(t: TestContext) {
  const owner = { appId: 'tenant-notes', source: { id: 'business', connection: 'business-db' }, storeId: 'notes-store' };
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-notes-'));
  const path = join(directory, 'business.db');
  const db = new DatabaseSync(path);
  const closers: Array<{ close(): Promise<void> } | { retire(): Promise<void> }> = [];
  t.after(async () => {
    for (const closer of closers) await ('retire' in closer ? closer.retire() : closer.close());
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE db_item (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT COLLATE NOCASE NOT NULL, name TEXT NOT NULL, ticks INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE db_note (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT COLLATE NOCASE NOT NULL, item_id TEXT NOT NULL REFERENCES db_item(id), body TEXT NOT NULL);
    INSERT INTO db_item VALUES ('north-row','north','North',0);`);
  provisionSqliteTenantStore(path, owner);
  migrateSqliteCommandJournal(path);
  const operations = new TransactionOperations();
  db.exec('BEGIN IMMEDIATE');
  const admin = createSqliteTenantAdministration(db, operations, owner);
  await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
  await admin.putMembership({
    tenantId: 'north',
    accountId: 'alice',
    membershipId: 'north-alice',
    status: 'active',
    roles: ['manager'],
    validUntil: 10000,
    expectedVersion: null,
  });
  await operations.finish();
  db.exec('COMMIT');
  db.exec('BEGIN');
  const physicalSchema = readSqliteReadCatalog(db).schema;
  db.exec('COMMIT');
  const resources = { item: 'db_item', note: 'db_note' };
  const catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    physicalSchema,
    schema: catalog.schema,
    resources,
    ownership: Object.fromEntries(Object.keys(resources).map((table) => [table, { kind: 'tenant', column: 'tenant_id' }])),
  });
  const fields = Object.fromEntries(
    catalog.schema.tables.map((table) => {
      const ordinary = table.columns.filter((column) => column.name !== 'tenant_id').map((column) => column.name);
      return [table.id, { read: ordinary, write: ordinary }];
    }),
  );
  const input = { text: { label: 'Text', type: 'text' } } as const;
  const action = (id: string) => ({ label: id, command: { id, version: 1, target: 'item', input } });
  const app = parseTestApp(
    {
      id: owner.appId,
      name: 'Tenant notes',
      sources: { business: { connection: owner.source.connection } },
      resources: {
        item: {
          physical: 'db_item',
          access: 'write',
          fields: fields.item,
          actions: {
            addNote: action('addNote'),
            rename: action('rename'),
            plainNote: action('plainNote'),
          },
        },
        note: { physical: 'db_note', access: 'write', fields: fields.note },
      },
      auth: { roles: { manager: { read: true, commands: ['addNote', 'rename', 'plainNote'] } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      nav: ['items'],
    },
    'tenant notes fixture',
  );
  const seen = { handlers: [] as string[] };
  const registry = defineCommands({
    // Only adds a child row: the target is read, never written.
    addNote: defineCommand({
      target: 'item',
      source: 'business',
      appendOnly: true,
      input,
      read: ['item'],
      write: ['item', 'note'],
      output,
      async handle(context, given) {
        seen.handlers.push('addNote');
        await context.tx.insert({
          table: 'note',
          values: { id: randomUUID(), item_id: String(context.record.id), body: String(given.text) },
        });
        return { noted: true };
      },
    }),
    // The same handler without the declaration: every command that does not declare `appendOnly` keeps the check up front.
    plainNote: defineCommand({
      target: 'item',
      source: 'business',
      input,
      read: ['item'],
      write: ['item', 'note'],
      output,
      async handle(context, given) {
        seen.handlers.push('plainNote');
        await context.tx.insert({
          table: 'note',
          values: { id: randomUUID(), item_id: String(context.record.id), body: String(given.text) },
        });
        return { noted: true };
      },
    }),
    // Writes a field of the target, and a child row beside it.
    rename: defineCommand({
      target: 'item',
      source: 'business',
      appendOnly: true,
      input,
      read: ['item'],
      write: ['item', 'note'],
      output,
      async handle(context, given) {
        seen.handlers.push('rename');
        await context.tx.update({
          table: 'item',
          key: { id: String(context.record.id) },
          expected: { name: String(context.record.name) },
          values: { name: String(given.text) },
        });
        await context.tx.insert({
          table: 'note',
          values: { id: randomUUID(), item_id: String(context.record.id), body: `renamed to ${String(given.text)}` },
        });
        return { renamed: true };
      },
    }),
  });
  const rows: RowScope = { item: true, note: true };
  const reader = openSqliteTenantReadSource(path, ownership, owner, () => 1000);
  closers.push(reader);
  const writer = await openSqliteTenantWriteSource(path, ownership, owner, () => 1000);
  closers.push(writer);
  const identity: Identity = { id: 'alice', who: 'Alice', role: 'manager' };
  const service = createTenantCommands<Request>({
    app,
    reader,
    writer,
    commands: { registry, resultReferences: { addNote: () => [], rename: () => [], plainNote: () => [] } },
    deployment: 'deployment-1',
    roles: ['manager'],
    maxLifetimeMs: 5000,
    now: () => 1000,
    verifySession: (given) => (given.cookie === 'alice' ? identity : null),
    resolveMembershipRows: () => rows,
    resolveRows: () => rows,
  });
  closers.push(service);
  /* Another person editing the record every 120 ms, as live sync keeps a busy record changing. A write that meets the
     writer mid-transaction waits for the next tick. */
  const churn = (() => {
    let timer: NodeJS.Timeout | undefined;
    let ticks = 0;
    return {
      start() {
        timer = setInterval(() => {
          try {
            db.exec(`UPDATE db_item SET ticks = ticks + 1 WHERE id = 'north-row'`);
            ticks++;
          } catch {
            /* busy: the next tick */
          }
        }, TICK_MS);
      },
      stop: () => clearInterval(timer),
      get ticks() {
        return ticks;
      },
    };
  })();
  t.after(() => churn.stop());
  /* The client's loop (commands.tsx runCommand): prepare, send what was prepared, and on a definite stale refusal prepare
     again, up to three tries. `lag` is the time between the prepare and the send — one tick of churn. */
  let attempt = 0;
  const run = async (command: Name, text: string, tries = 3, lag = TICK_MS + 40) => {
    const refusals: string[] = [];
    for (let n = 1; n <= tries; n++) {
      const prepared = await service.prepare(request, north, { command, commandVersion: 1, key: { id: 'north-row' } });
      await pause(lag);
      try {
        const sent = await service.execute(request, north, {
          command,
          commandVersion: 1,
          key: { id: 'north-row' },
          expectedVersion: prepared.expectedVersion,
          idempotencyKey: `churn-${command}-${++attempt}-0001`,
          input: { text },
        });
        return { sent, refusals, tries: n };
      } catch (error) {
        const code = (error as { code?: string }).code ?? String(error);
        refusals.push(code);
        if (code !== 'stale_record') throw error;
      }
    }
    return { sent: undefined, refusals, tries };
  };
  const notes = () =>
    db
      .prepare('SELECT body FROM db_note ORDER BY rowid')
      .all()
      .map((row) => String(row.body));
  const name = () => String(db.prepare("SELECT name FROM db_item WHERE id = 'north-row'").get()!.name);
  /* One send at a revision read before another person's edit, with the edit made in between. */
  const stale = async (command: Name, text: string) => {
    const prepared = await service.prepare(request, north, { command, commandVersion: 1, key: { id: 'north-row' } });
    db.exec("UPDATE db_item SET ticks = ticks + 1 WHERE id = 'north-row'");
    return service
      .execute(request, north, {
        command,
        commandVersion: 1,
        key: { id: 'north-row' },
        expectedVersion: prepared.expectedVersion,
        idempotencyKey: `stale-${command}-${++attempt}-0001`,
        input: { text },
      })
      .then(
        (sent) => sent.status,
        (error: { code?: string }) => error.code,
      );
  };
  return { run, churn, notes, name, seen, db, stale };
}

test('a note added while the record churns every 120 ms is applied on the first try', async (t) => {
  const f = await fixture(t);
  f.churn.start();
  const first = await f.run('addNote', 'first');
  const second = await f.run('addNote', 'second');
  f.churn.stop();
  assert.deepEqual([first.refusals, second.refusals], [[], []], 'no stale refusal');
  assert.deepEqual([first.tries, second.tries], [1, 1]);
  assert.equal(first.sent?.status, 'applied');
  assert.deepEqual(f.notes(), ['first', 'second']);
  assert.ok(f.churn.ticks >= 3, `the record changed under the sends (${f.churn.ticks} ticks)`);
  assert.equal(f.name(), 'North', 'and the record was not written');
});

test('a command that writes a field of its target is still refused when the record moved: all three tries', async (t) => {
  const f = await fixture(t);
  f.churn.start();
  const outcome = await f.run('rename', 'Renamed');
  f.churn.stop();
  assert.equal(outcome.sent, undefined);
  assert.deepEqual(outcome.refusals, ['stale_record', 'stale_record', 'stale_record']);
  assert.equal(f.name(), 'North', 'nothing was written');
  assert.deepEqual(f.notes(), [], 'nor the note beside it: the refusal undid the transaction');
  assert.equal(f.seen.handlers.filter((entry) => entry === 'rename').length, 3, 'it met the guard at its write');
});

test('the same commands apply once the record holds still; an old revision is refused only by the one that writes', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run('rename', 'Renamed', 3, 5)).sent?.status, 'applied');
  assert.equal(f.name(), 'Renamed');
  assert.equal((await f.run('addNote', 'quiet', 1, 5)).sent?.status, 'applied');
  // The record moves between the prepare and the send, once: the note goes in, the rename does not.
  f.db.exec("UPDATE db_item SET ticks = ticks + 1 WHERE id = 'north-row'");
  assert.equal(await f.stale('addNote', 'after the edit'), 'applied');
  const stale = await f.stale('rename', 'Again');
  assert.equal(stale, 'stale_record');
  assert.equal(f.name(), 'Renamed');
  assert.deepEqual(f.notes().slice(-2), ['quiet', 'after the edit']);
});

test('a command that does not declare appendOnly is refused for a stale record before its handler, as every command was', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.stale('plainNote', 'late'), 'stale_record');
  assert.deepEqual(f.notes(), []);
  assert.deepEqual(f.seen.handlers, [], 'it never reached the handler');
  // The declared twin is applied on the same stale revision.
  assert.equal(await f.stale('addNote', 'late'), 'applied');
});
