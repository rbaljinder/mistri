/*
 * What a warm tenant App costs on SQLite, in prepared statements: a command
 * with one write, and a page's reads through the tenant read source. A field
 * report measured 2 to 4 seconds a command, most of it the catalog read again
 * and again; the read source now scans it only when the schema moved
 * (tenantReadSource.ts), so the second half proves a moved schema is still
 * caught on the next read. TABLEWALK_BUDGET_PRINT=1 prints the measures.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import type { CommandRequest } from '../packages/mistri/src/server/commands/commandPayload.js';
import { createTenantCommands } from '../packages/mistri/src/server/tenant/tenantCommands.js';
import type { TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import { captureTenantOwnership, ownershipCounters } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { openSqliteTenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { openSqliteTenantWriteSource } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import { parseTestApp } from './support/commandCatalog.js';
import { readsCatalog } from './support/statements.js';
import { scopeCatalogCounters } from '../packages/engine/src/shared/scopeCatalog.js';

type Request = { cookie: string };
type Options = Parameters<typeof createTenantCommands<Request>>[0];
const owner = { appId: 'catalog-budget', source: { id: 'business', connection: 'business-db' }, storeId: 'budget-store' };
const north = ['north'];
const resources = { item: 'db_item', reviewer: 'db_reviewer', other: 'db_other' };
const rows: RowScope = { item: true, reviewer: true, other: true };
/* A warm command with one write: the scope, membership and journal statements, the write, and the writer's two
   attestations (when the transaction opens and before COMMIT). Fewer than this, or a regression is back. */
const COMMAND_PREPARES = 60;
const READS = 20;

/** Every statement `DatabaseSync.prototype.prepare` is asked for while counting is on, and how many full
 * ownership passes ran: a cached catalog statement is not prepared again, so a rescan is counted by its pass. */
function countPrepares(t: TestContext) {
  const original = DatabaseSync.prototype.prepare;
  const seen = { on: false, sql: [] as string[] };
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string, ...rest: unknown[]) {
    if (seen.on) seen.sql.push(sql);
    return (original as (this: DatabaseSync, ...args: unknown[]) => ReturnType<typeof original>).call(this, sql, ...rest);
  } as typeof original;
  t.after(() => {
    DatabaseSync.prototype.prepare = original;
  });
  return async <T>(work: () => Promise<T>) => {
    seen.sql = [];
    seen.on = true;
    const started = performance.now(),
      before = ownershipCounters.attested;
    try {
      await work();
    } finally {
      seen.on = false;
    }
    return { sql: seen.sql, ms: performance.now() - started, attested: ownershipCounters.attested - before };
  };
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-tenant-catalog-budget-')),
    path = join(directory, 'business.db');
  const db = new DatabaseSync(path),
    closing: Array<() => Promise<void>> = [];
  t.after(async () => {
    try {
      for (const close of closing.reverse()) await close();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;
    CREATE TABLE db_item (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open');
    CREATE TABLE db_reviewer (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE db_other (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, note TEXT NOT NULL);
    INSERT INTO db_item VALUES ('north-row','north',0,'North','open'),('north-closed','north',0,'Closed','OPEN'),
      ('south-row','south',0,'South','open');
    INSERT INTO db_reviewer VALUES ('north-reviewer','north','North reviewer'),('south-reviewer','south','South reviewer');
    INSERT INTO db_other VALUES ('north-other','north','North other');`);
  provisionSqliteTenantStore(path, owner);
  migrateSqliteCommandJournal(path);
  const operations = new TransactionOperations();
  db.exec('BEGIN IMMEDIATE');
  const admin = createSqliteTenantAdministration(db, operations, owner);
  for (const tenantId of ['north', 'south']) {
    await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putMembership({
      tenantId,
      accountId: 'alice',
      membershipId: `${tenantId}-alice`,
      status: 'active',
      roles: ['manager'],
      validUntil: 10_000,
      expectedVersion: null,
    });
  }
  await operations.finish();
  db.exec('COMMIT');
  db.exec('BEGIN');
  const physicalSchema = readSqliteReadCatalog(db).schema;
  db.exec('COMMIT');
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
  const close = { label: 'Close', command: { id: 'close', version: 1, target: 'item', input: {} } };
  const app = parseTestApp(
    {
      id: owner.appId,
      name: 'Catalog budget',
      sources: { business: { connection: owner.source.connection } },
      resources: Object.fromEntries(
        Object.entries(resources).map(([name, physical]) => [
          name,
          { physical, access: 'write', fields: fields[name], ...(name === 'item' ? { actions: { close } } : {}) },
        ]),
      ),
      auth: { roles: { manager: { read: true, commands: ['close'] } } },
      views: { records: { kind: 'list', from: 'item' } },
      home: 'records',
      nav: ['records'],
    },
    'catalog budget fixture',
  );
  const registry = defineCommands({
    close: defineCommand({
      target: 'item',
      input: {},
      source: 'business',
      read: ['item'],
      write: ['item'],
      output: { parse: (value: unknown) => value as { version: number } },
      async handle(context) {
        const version = Number(context.record.version) + 1;
        await context.tx.update({
          table: 'item',
          key: { id: String(context.record.id) },
          expected: { version: version - 1 },
          values: { version },
        });
        return { version };
      },
    }),
  });
  const time = 1000;
  const reader = openSqliteTenantReadSource(path, ownership, owner, () => time);
  closing.push(() => reader.close());
  const writer = await openSqliteTenantWriteSource(path, ownership, owner, () => time);
  closing.push(() => writer.close());
  const options: Options = {
    app,
    reader,
    writer,
    commands: { registry, resultReferences: { close: () => [] } },
    deployment: 'deployment-1',
    roles: ['manager'],
    maxLifetimeMs: 5000,
    now: () => time,
    verifySession: (input) => (input.cookie === 'alice' ? { id: 'alice', who: 'Alice', role: 'admin' } : null),
    resolveMembershipRows: () => rows,
    resolveRows: () => rows,
  };
  const service = createTenantCommands(options);
  closing.push(() => service.retire());
  let attempt = 0;
  const body = (expectedVersion: number): CommandRequest => ({
    command: 'close',
    commandVersion: 1,
    key: { id: 'north-row' },
    expectedVersion,
    idempotencyKey: `catalog-budget-${String(++attempt).padStart(4, '0')}`,
    input: {},
  });
  const evidence = async (): Promise<TenantMembershipEvidence> => {
    const lookup = { appId: owner.appId, source: owner.source, accountId: 'alice', tenantId: 'north', deployment: 'deployment-1' };
    const record = await reader.readMembership(lookup);
    assert.ok(record);
    return {
      ...lookup,
      membershipId: record.membershipId,
      membershipVersion: record.membershipVersion,
      tenantVersion: record.tenantVersion,
      roles: [...record.roles],
      verifiedAt: 50,
      validUntil: 1000 + 5000,
    };
  };
  return { db, path, reader, service, body, evidence };
}

test('a warm tenant command with one write prepares fewer statements than its budget', async (t) => {
  const f = await fixture(t),
    measure = countPrepares(t),
    request = { cookie: 'alice' };
  // Warm: the first command reads the scope catalog and binds the journal once.
  assert.equal((await f.service.execute(request, north, f.body(0))).status, 'applied');
  let version = 1;
  const runs: Array<{ sql: string[]; ms: number }> = [];
  const captured = scopeCatalogCounters.captured;
  for (let i = 0; i < 5; i++) {
    const expected = version++;
    runs.push(await measure(async () => assert.equal((await f.service.execute(request, north, f.body(expected))).status, 'applied')));
  }
  const counted = Math.max(...runs.map((run) => run.sql.length));
  if (process.env.TABLEWALK_BUDGET_PRINT)
    console.log(
      `warm command: ${counted} prepared, ${(scopeCatalogCounters.captured - captured) / runs.length} catalogs copied, ${runs.map((run) => run.ms.toFixed(1)).join(' / ')} ms` +
        `\n${runs[0].sql.map((sql) => `  ${sql.replace(/\s+/g, ' ').slice(0, 140)}`).join('\n')}`,
    );
  assert.ok(counted < COMMAND_PREPARES, `${counted} statements prepared in a warm command, not under ${COMMAND_PREPARES}`);
});

test('a page of reads through the tenant read source prepares no catalog statement while the schema holds', async (t) => {
  const f = await fixture(t),
    measure = countPrepares(t);
  const reads = await f.reader.scopeReads(await f.evidence(), rows);
  await reads.query({ table: 'item', limit: 50, offset: 0 });
  const page = await measure(async () => {
    for (let i = 0; i < READS; i++) await reads.query({ table: i % 2 ? 'reviewer' : 'item', limit: 50, offset: 0 });
  });
  if (process.env.TABLEWALK_BUDGET_PRINT)
    console.log(
      `page of ${READS} reads: ${page.sql.length} prepared, ${page.sql.filter(readsCatalog).length} catalog, ${page.ms.toFixed(1)} ms\n${[...new Set(page.sql)].map((s) => '  ' + s.replace(/\s+/g, ' ').slice(0, 160)).join('\n')}`,
    );
  assert.deepEqual(
    page.sql.filter((sql) => readsCatalog(sql)),
    [],
    'no catalog statement on a warm read',
  );
  assert.equal(page.attested, 0, 'no full ownership pass on a warm read');
});

for (const [name, change] of [
  ['an index added to an owned table', (db: DatabaseSync) => db.exec('CREATE INDEX db_reviewer_name ON db_reviewer(name)')],
  ['a column added to an owned table', (db: DatabaseSync) => db.exec('ALTER TABLE db_item ADD COLUMN extra TEXT')],
  [
    "a case-folding collation on an owned table's policy column",
    (db: DatabaseSync) => {
      const original = db.prepare("SELECT sql FROM main.sqlite_schema WHERE name = 'db_item'").get()!.sql as string;
      const replacement = original.replace("status TEXT NOT NULL DEFAULT 'open'", "status TEXT NOT NULL DEFAULT 'open' COLLATE NOCASE");
      assert.notEqual(replacement, original);
      db.exec('PRAGMA foreign_keys = OFF; CREATE TEMP TABLE saved AS SELECT * FROM main.db_item; DROP TABLE main.db_item');
      db.exec(replacement);
      db.exec('INSERT INTO main.db_item SELECT * FROM saved; DROP TABLE saved; PRAGMA foreign_keys = ON');
    },
  ],
] as const)
  test(`${name}, made on another connection between two reads, is seen by the next read`, async (t) => {
    const f = await fixture(t),
      measure = countPrepares(t);
    const policy: RowScope = { ...rows, item: { groups: [[{ column: 'status', op: '=', value: 'OPEN' }]] } };
    const reads = await f.reader.scopeReads(await f.evidence(), policy);
    assert.equal(await reads.count('item'), 1);
    const warm = await measure(() => reads.count('item'));
    assert.deepEqual([warm.sql.filter(readsCatalog), warm.attested], [[], 0]);
    change(f.db);
    // The next read scans the catalog whole again, whatever it then decides.
    const next = await measure(() => reads.count('item').catch(() => undefined));
    assert.equal(next.attested, 1, 'the moved schema is attested whole');
    if (name.startsWith('an index')) {
      // Nothing the App reads by moved: the read answers as before, and the one after skips the scan again.
      assert.equal(await reads.count('item'), 1);
      const after = await measure(() => reads.count('item'));
      assert.deepEqual([after.sql.filter(readsCatalog), after.attested], [[], 0]);
    } else {
      await assert.rejects(reads.count('item'));
      // A refused pass is never taken as passed: every later read scans again, and refuses again.
      const again = await measure(() => reads.count('item').catch(() => undefined));
      assert.equal(again.attested, 1);
      await assert.rejects(reads.count('item'));
    }
  });
