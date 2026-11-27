/* Parent-record filtering on /api/reads and the read audit adapters (SQLite + PostgreSQL):
   resolving 1-hop audited FK child records under the caller's scoped reader without polluting
   the read audit log, combining parent + child opened/listed reads in one paged query, and
   refusing malformed or conflicting filters. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  appendSqliteReadAudit,
  provisionSqliteReadAudit,
  readSqliteReadAudit,
} from '../packages/mistri/src/adapters/readAudit/sqliteReadAudit.js';
import { readPostgresReadAudit } from '../packages/mistri/src/adapters/readAudit/postgresReadAudit.js';
import type { ReadAuditQuery, ReadAuditRow } from '../packages/mistri/src/adapters/readAudit/readAudit.js';
import { resolveTenantParentAuditTargets, tenantReadsRoute } from '../packages/mistri/src/server/tenant/tenantReadsRoute.js';
import { currentReadRoute, withReadRoute } from '../packages/mistri/src/server/readAudit.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';

function openAuditDb(t: test.TestContext): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-reads-parent-'));
  const file = join(dir, 'audit.db');
  const seed = new DatabaseSync(file);
  seed.close();
  provisionSqliteReadAudit(file);
  const db = new DatabaseSync(file);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function row(partial: Partial<ReadAuditRow> & Pick<ReadAuditRow, 'resource' | 'route'>): ReadAuditRow {
  return {
    at: '2026-11-01T00:00:00.000Z',
    app: 'clinic',
    tenant: 'north',
    actor: 'alice',
    ...partial,
  };
}

test('SQLite read audit adapter filters across multiple (resource, records) targets for opened and listed rows', (t) => {
  const db = openAuditDb(t);
  // 1: opened patient 1
  appendSqliteReadAudit(db, row({ resource: 'patient', route: 'page', record: '1' }));
  // 2: opened unrelated patient 2
  appendSqliteReadAudit(db, row({ resource: 'patient', route: 'page', record: '2' }));
  // 3: listed notes containing note 10 (belongs to patient 1)
  appendSqliteReadAudit(db, row({ resource: 'note', route: 'related', query: '{}', count: 2, ids: JSON.stringify(['10', '99']) }));
  // 4: opened note 11 (belongs to patient 1)
  appendSqliteReadAudit(db, row({ resource: 'note', route: 'page', record: '11' }));
  // 5: opened note 20 (belongs to patient 2)
  appendSqliteReadAudit(db, row({ resource: 'note', route: 'page', record: '20' }));
  // 6: listed labs containing lab 50 (belongs to patient 1)
  appendSqliteReadAudit(db, row({ resource: 'lab', route: 'custom-page', query: '{}', count: 1, ids: JSON.stringify(['50']) }));
  // 7: another tenant's note 10 must never match
  appendSqliteReadAudit(db, row({ tenant: 'south', resource: 'note', route: 'page', record: '10' }));

  const targets = [
    { resource: 'patient', records: ['1'] },
    { resource: 'note', records: ['10', '11'] },
    { resource: 'lab', records: ['50'] },
  ];
  const matched = readSqliteReadAudit(db, { tenant: 'north', targets, limit: 50 });
  assert.deepEqual(
    matched.map((entry) => [entry.id, entry.resource, entry.record ?? entry.ids]),
    [
      [6, 'lab', '["50"]'],
      [4, 'note', '11'],
      [3, 'note', '["10","99"]'],
      [1, 'patient', '1'],
    ],
  );

  // Keyset pagination works seamlessly with targets.
  const older = readSqliteReadAudit(db, { tenant: 'north', targets, before: 4, limit: 50 });
  assert.deepEqual(
    older.map((entry) => entry.id),
    [3, 1],
  );

  // Empty targets return [] without scanning.
  assert.deepEqual(readSqliteReadAudit(db, { tenant: 'north', targets: [], limit: 50 }), []);
  assert.deepEqual(readSqliteReadAudit(db, { tenant: 'north', targets: [{ resource: 'note', records: [] }], limit: 50 }), []);

  // Combining record and targets is refused.
  assert.throws(() => readSqliteReadAudit(db, { record: '1', targets, limit: 10 }), /cannot combine record and targets/i);
});

test('PostgreSQL read audit adapter builds parameterized ANY(text[]) and jsonb ?| text[] clauses for targets', async () => {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      seen.push({ sql, params });
      return { rows: [], fields: [], rowCount: 0 };
    },
  };
  await readPostgresReadAudit(
    client as never,
    {
      tenant: 'north',
      targets: [
        { resource: 'patient', records: ['1'] },
        { resource: 'note', records: ['10', '11'] },
      ],
      limit: 51,
    },
    true,
  );
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.sql, /tenant = \$1/);
  assert.match(
    seen[0]!.sql,
    /\(resource = \$2 AND \(record_key = ANY\(\$3::text\[\]\) OR \(ids_json IS NOT NULL AND ids_json::jsonb \?\| \$3::text\[\]\)\)\)/,
  );
  assert.match(
    seen[0]!.sql,
    /\(resource = \$4 AND \(record_key = ANY\(\$5::text\[\]\) OR \(ids_json IS NOT NULL AND ids_json::jsonb \?\| \$5::text\[\]\)\)\)/,
  );
  assert.match(seen[0]!.sql, /LIMIT \$6/);
  assert.deepEqual(seen[0]!.params, ['north', 'patient', ['1'], 'note', ['10', '11'], 51]);

  // Empty targets short-circuit before hitting Postgres.
  assert.deepEqual(await readPostgresReadAudit(client as never, { tenant: 'north', targets: [], limit: 10 }, true), []);
  assert.equal(seen.length, 1);
});

test('resolveTenantParentAuditTargets + /api/reads resolves 1-hop audited children without auditing the lookup', async (t) => {
  const db = openAuditDb(t);
  appendSqliteReadAudit(db, row({ resource: 'patient', route: 'page', record: '1' }));
  appendSqliteReadAudit(db, row({ resource: 'patient', route: 'page', record: '2' }));
  appendSqliteReadAudit(db, row({ resource: 'note', route: 'related', query: '{}', count: 2, ids: JSON.stringify(['10', '99']) }));
  appendSqliteReadAudit(db, row({ resource: 'note', route: 'page', record: '11' }));
  appendSqliteReadAudit(db, row({ resource: 'note', route: 'page', record: '20' }));
  appendSqliteReadAudit(db, row({ resource: 'transfer', route: 'page', record: '30' }));

  const schema: DatabaseSchema = {
    label: 'clinic',
    dialect: 'sqlite',
    readAt: '2026-11-01T00:00:00.000Z',
    tables: [
      {
        id: 'patient',
        name: 'patient',
        schema: '',
        isView: false,
        insertable: true,
        deletable: false,
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true, writable: false },
          { name: 'name', type: 'text', nullable: false, primaryKey: false, writable: true },
        ],
      },
      {
        id: 'note',
        name: 'note',
        schema: '',
        isView: false,
        insertable: true,
        deletable: false,
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true, writable: false },
          { name: 'patient_id', type: 'integer', nullable: false, primaryKey: false, writable: true },
        ],
      },
      {
        id: 'transfer',
        name: 'transfer',
        schema: '',
        isView: false,
        insertable: true,
        deletable: false,
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true, writable: false },
          { name: 'from_patient_id', type: 'integer', nullable: false, primaryKey: false, writable: true },
          { name: 'to_patient_id', type: 'integer', nullable: false, primaryKey: false, writable: true },
        ],
      },
      {
        id: 'billing_code',
        name: 'billing_code',
        schema: '',
        isView: false,
        insertable: true,
        deletable: false,
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true, writable: false },
          { name: 'patient_id', type: 'integer', nullable: false, primaryKey: false, writable: true },
        ],
      },
    ],
    foreignKeys: [
      { name: 'note.patient_id', from: { table: 'note', columns: ['patient_id'] }, to: { table: 'patient', columns: ['id'] } },
      {
        name: 'transfer.from_patient_id',
        from: { table: 'transfer', columns: ['from_patient_id'] },
        to: { table: 'patient', columns: ['id'] },
      },
      {
        name: 'transfer.to_patient_id',
        from: { table: 'transfer', columns: ['to_patient_id'] },
        to: { table: 'patient', columns: ['id'] },
      },
      // Non-audited child table must not be queried at all.
      {
        name: 'billing_code.patient_id',
        from: { table: 'billing_code', columns: ['patient_id'] },
        to: { table: 'patient', columns: ['id'] },
      },
    ],
  };

  const queriedTables: Array<{ table: string; groups: unknown; readDoor: unknown }> = [];
  const adapter: Pick<Adapter, 'query'> = {
    query: async (request) => {
      queriedTables.push({ table: request.table, groups: request.filter?.groups, readDoor: currentReadRoute() });
      if (request.table === 'note') {
        const value = request.filter?.groups?.[0]?.[0]?.value;
        const rows = value === 1 ? [{ id: 10 }, { id: 11 }] : value === 2 ? [{ id: 20 }] : [];
        return { columns: ['id'], rows, ms: 0, sql: { text: '', params: [] } };
      }
      if (request.table === 'transfer') {
        // Multi-FK child table is queried once with OR groups.
        const matches = request.filter?.groups?.some((group) => group[0]?.value === 1);
        return { columns: ['id'], rows: matches ? [{ id: 30 }] : [], ms: 0, sql: { text: '', params: [] } };
      }
      throw new Error(`Unexpected query to non-audited table "${request.table}".`);
    },
  };

  const route = tenantReadsRoute({
    editors: ['admin'],
    resources: ['patient', 'note', 'transfer'],
    read: async (tenantId, query: Omit<ReadAuditQuery, 'tenant' | 'app'>) => readSqliteReadAudit(db, { ...query, tenant: tenantId }),
    people: async () => new Map([['alice', { name: 'Alice North', email: 'alice@north.test' }]]),
  });

  const principal = { roles: ['admin'], tenantId: 'north' };
  const where = { platform: false, onSupport: false };
  const resolver = (parent: { resource: string; record: string }, options: { resources: readonly string[]; onlyResource?: string }) =>
    resolveTenantParentAuditTargets(adapter, schema, parent, options);

  // Run inside a 'page' read door to prove the child lookup clears it via withoutReadAudit().
  const answer = await withReadRoute('page', () =>
    route.answer({ parent: { resource: 'patient', record: '1' } }, principal, where, resolver),
  );
  assert.equal(answer.status, 200);
  const body = answer.body as { reads: Array<{ id: number; resource: string }> };
  assert.deepEqual(
    body.reads.map((entry) => [entry.id, entry.resource]),
    [
      [6, 'transfer'],
      [4, 'note'],
      [3, 'note'],
      [1, 'patient'],
    ],
  );
  // Child queries ran with integer coercion, merged multi-FK OR groups, skipped non-audited billing_code, and ran outside read audit.
  assert.equal(queriedTables.length, 2);
  assert.deepEqual(queriedTables.map((q) => q.table).sort(), ['note', 'transfer']);
  for (const q of queriedTables) assert.equal(q.readDoor, undefined, 'child lookup must run under withoutReadAudit()');
  const transferQuery = queriedTables.find((q) => q.table === 'transfer')!;
  assert.deepEqual(transferQuery.groups, [
    [{ column: 'from_patient_id', op: '=', value: 1 }],
    [{ column: 'to_patient_id', op: '=', value: 1 }],
  ]);

  // Narrowing parent with resource only returns that child resource and skips unrelated child queries.
  queriedTables.length = 0;
  const notesOnly = await route.answer({ parent: { resource: 'patient', record: '1' }, resource: 'note' }, principal, where, resolver);
  assert.equal(notesOnly.status, 200);
  assert.deepEqual(
    (notesOnly.body as { reads: Array<{ id: number }> }).reads.map((entry) => entry.id),
    [4, 3],
  );
  assert.deepEqual(
    queriedTables.map((q) => q.table),
    ['note'],
  );

  // Non-numeric record key on an integer FK safely skips child queries without throwing and still matches exact parent audit rows.
  queriedTables.length = 0;
  const nonNumeric = await route.answer({ parent: { resource: 'patient', record: 'not-a-number' } }, principal, where, resolver);
  assert.equal(nonNumeric.status, 200);
  assert.deepEqual((nonNumeric.body as { reads: unknown[] }).reads, []);
  assert.equal(queriedTables.length, 0);

  // Invalid / conflicting parent inputs are refused with 422 reads_refused.
  for (const bad of [
    { parent: 'patient:1' },
    { parent: { resource: '', record: '1' } },
    { parent: { resource: 'patient', record: '' } },
    { parent: { resource: 'patient', record: '1', extra: true } },
    { parent: { resource: 'patient', record: '1' }, record: '1' },
    { parent: { resource: 'missing_table', record: '1' } },
  ]) {
    const refused = await route.answer(bad as Record<string, unknown>, principal, where, resolver);
    assert.equal(refused.status, 422, JSON.stringify(bad));
    assert.equal((refused.body as { code: string }).code, 'reads_refused');
  }
});

test('isSingleWaveBootRead treats /api/view/run with include as multi-wave (#585)', async () => {
  const { isSingleWaveBootRead } = await import('../packages/mistri/src/server/tenant/tenantCompose.js');
  assert.equal(isSingleWaveBootRead('/api/view/run', { view: { base: 'item' } }), true);
  assert.equal(
    isSingleWaveBootRead('/api/view/run', {
      view: { base: 'item' },
      include: { notes: { from: 'note', by: 'item_id', show: ['name'] } },
    }),
    false,
  );
  assert.equal(isSingleWaveBootRead('/api/run', {}), true);
  assert.equal(isSingleWaveBootRead('/api/counts', { items: [] }), true);
  assert.equal(isSingleWaveBootRead('/api/counts', { views: [] }), false);
});
