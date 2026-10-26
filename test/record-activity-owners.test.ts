/**
 * A tenant's activity feed, in the store: `owners` reads one tenant's rows of
 * the tenant-owned resources it names, by the owner each stored key carries,
 * before the read's limit, and leaves a resource it does not name (the
 * platform's) as it is. SQLite always; PostgreSQL when TABLEWALK_TEST_PG is set.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  RECORD_HISTORY_TABLES,
  type RecordActivityQuery,
  type StoredRecordChange,
} from '../packages/mistri/src/adapters/history/recordHistory.js';
import { provisionSqliteRecordHistory, readSqliteRecordActivity } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import {
  provisionPostgresRecordHistory,
  readPostgresRecordActivity,
} from '../packages/mistri/src/adapters/history/postgresRecordHistory.js';
import { LIVE_PG, ownedPostgresDatabase } from './support/jobStoreEngines.js';
import { liveSkip } from './live.js';
import { pgClient } from './support/tenantDialects.js';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';

/* Oldest first: north's one change, then a busy south, then the platform's
   row, then a row stored under north's key but owned by south ('planted'). */
const ROWS: ReadonlyArray<readonly [string, string, string]> = [
  ['n-1', 'db_item', '{"id":"same","tenant_id":"north"}'],
  ...Array.from({ length: 5 }, (_, i) => [`s-${i}`, 'db_item', '{"id":"same","tenant_id":"south"}'] as const),
  ['p-1', 'db_dealer', '{"id":"d1"}'],
  ['planted', 'db_item', '{"id":"same","tenant_id":"northern"}'],
];
const AT = '2026-10-01T12:00:00.000Z';
const query = (limit: number, tenant?: string): RecordActivityQuery => ({
  resources: ['db_item', 'db_dealer'],
  limit,
  from: '2026-10-01T00:00:00.000Z',
  ...(tenant ? { owners: { tenant, columns: { db_item: 'tenant_id' } } } : {}),
});
const ids = (rows: readonly StoredRecordChange[]) => rows.map((row) => row.writeId);

function expectations(read: (query: RecordActivityQuery) => Promise<StoredRecordChange[]>) {
  return async () => {
    // North's feed: its own change and the platform's, never south's or a near-miss owner, though south's are newer.
    assert.deepEqual(ids(await read(query(2, 'north'))), ['p-1', 'n-1']);
    assert.deepEqual(ids(await read(query(50, 'south'))), ['p-1', 's-4', 's-3', 's-2', 's-1', 's-0']);
    // The platform realm's feed names no owner and spans every tenant.
    assert.deepEqual(ids(await read(query(2))), ['planted', 'p-1']);
    // An owner column the read does not name, or a tenant that is not one, is refused before the store is asked.
    await assert.rejects(
      read({ ...query(2), owners: { tenant: 'north', columns: { db_other: 'tenant_id' } } }),
      /Invalid record activity read/,
    );
    await assert.rejects(
      read({ ...query(2), owners: { tenant: 'north', columns: { db_item: 'tenant_id"); --' } } }),
      /Invalid record activity read/,
    );
    await assert.rejects(
      read({ ...query(2), owners: { tenant: 'North!', columns: { db_item: 'tenant_id' } } }),
      /Invalid record activity read/,
    );
  };
}

test("SQLite: a tenant's feed is read from its own rows, before the limit", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-activity-owners-')),
    path = join(directory, 'business.db');
  const db = new DatabaseSync(path);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  provisionSqliteRecordHistory(path);
  const insert =
    db.prepare(`INSERT INTO "${RECORD_HISTORY_TABLES.change}" (write_id, at, resource, key_json, kind, changes_json, actor, actor_name, via, action)
    VALUES (?, ?, ?, ?, 'update', '[]', 'a', 'A', 'app', '')`);
  for (const [writeId, resource, key] of ROWS) insert.run(writeId, AT, resource, key);
  await expectations(async (value) => readSqliteRecordActivity(db, value))();
});

test("PostgreSQL: a tenant's feed is read from its own rows, before the limit", { skip: liveSkip('postgres', LIVE_PG) }, async () => {
  const url = await ownedPostgresDatabase();
  const client = await pgClient(url);
  try {
    await client.query(
      `DROP TABLE IF EXISTS ${runtimeTable('postgres', RECORD_HISTORY_TABLES.change)}, ${runtimeTable('postgres', RECORD_HISTORY_TABLES.meta)}`,
    );
    await provisionPostgresRecordHistory(url);
    for (const [writeId, resource, key] of ROWS)
      await client.query(
        `INSERT INTO ${runtimeTable('postgres', RECORD_HISTORY_TABLES.change)}
      (write_id, at, resource, key_json, kind, changes_json, actor, actor_name, via, action) VALUES ($1, $2, $3, $4, 'update', '[]', 'a', 'A', 'app', '')`,
        [writeId, AT, resource, key],
      );
    await expectations((value) => readPostgresRecordActivity(client, value))();
  } finally {
    await client.end();
  }
});
