/**
 * The support log's store read is bounded: a dealer that has been visited
 * for years is read its newest SUPPORT_LOG_VISITS visits, with `more` saying
 * older ones exist, and only those visits' entries — never another dealer's.
 * Both engines, the store read itself (the route above it is covered in
 * tenant-support-log.test.ts); PostgreSQL live-gated by TABLEWALK_TEST_PG.
 *
 * The rows are written straight into the audit tables: the read verifies no
 * chain, so a well-formed row is all it needs, and a hundred real support
 * sessions would be minutes of fixture for one bound.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { SUPPORT_LOG_VISITS } from '../packages/mistri/src/shared/tenantSupportLog.js';
import { provisionSqliteSupportAudit, readSqliteSupportLog } from '../packages/mistri/src/server/tenant/tenantSupportAudit.js';
import { migratePostgresSupportAudit, readPostgresSupportLog } from '../packages/mistri/src/server/tenant/tenantSupportAuditPostgres.js';
import {
  ENTRY_COLUMNS,
  SESSION_COLUMNS,
  SUPPORT_AUDIT_TABLES as tables,
  supportAuditKey,
} from '../packages/mistri/src/server/tenant/tenantSupportAuditContract.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS } from './support/tenantDialects.js';

const binding = { appId: 'app', source: { id: 'business', connection: 'owned-source' }, storeId: 'store-1' };
const key = supportAuditKey('tenant-support-log-bound-secret-32-characters');
const DATABASE = `support_bound_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

const mac = 'a'.repeat(64);
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
function session(id: string, tenantId: string, minute: number): Record<string, unknown> {
  return {
    id,
    tenant_id: tenantId,
    account_id: 'operator',
    operator_name: 'Olivia',
    dealer_role: 'dealer_staff',
    parent_membership_id: 'platform:olivia',
    parent_membership_version: '1',
    platform_version: '1',
    reason: 'Checking',
    opened_at: at(minute),
    valid_until: 1,
    native_session_id: 'native',
    deployment: 'd',
    policy_id: 'p',
    policy_version: '1',
    open_receipt_id: `receipt-${id}`,
    ended_at: null,
    end_reason: null,
    head_seq: 0,
    head_mac: mac,
  };
}
function entry(sessionId: string, tenantId: string, minute: number): Record<string, unknown> {
  return {
    session_id: sessionId,
    seq: 0,
    kind: 'open',
    at: at(minute),
    request_id: `request-${sessionId}`,
    actor_id: 'operator',
    tenant_id: tenantId,
    tenant_version: '1',
    realm: 'tenant',
    support_membership_version: '1',
    parent_membership_version: '1',
    platform_version: '1',
    resource: null,
    operation: null,
    key_json: null,
    detail_json: '{}',
    command_receipt_id: null,
    prev_mac: mac,
    mac,
  };
}

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`the support log's bound on ${dialect}`, { skip }, () => {
    test('a dealer is read its newest visits and their entries only, and told that older ones exist', async (t) => {
      const engine = await openTenantEngine(dialect, { sqlite: '', postgres: 'SELECT 1', tables: [], database: DATABASE });
      t.after(() => engine.close());
      await engine.provisionStore(binding);
      if (dialect === 'sqlite') provisionSqliteSupportAudit(engine.path, binding, key);
      else await migratePostgresSupportAudit(engine.url, binding, key);
      const insert = async (table: string, columns: readonly string[], row: Record<string, unknown>) =>
        engine.exec(
          `INSERT INTO "${table}" (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
          columns.map((column) => row[column]),
        );
      const visits = SUPPORT_LOG_VISITS + 2;
      for (let minute = 0; minute < visits; minute++) {
        const id = `north-${String(minute).padStart(4, '0')}`;
        await insert(tables.session, SESSION_COLUMNS, session(id, 'north', minute));
        await insert(tables.entry, ENTRY_COLUMNS, entry(id, 'north', minute));
      }
      await insert(tables.session, SESSION_COLUMNS, session('south-late', 'south', visits + 10));
      await insert(tables.entry, ENTRY_COLUMNS, entry('south-late', 'south', visits + 10));

      const read = (tenantId: string | null) =>
        dialect === 'sqlite'
          ? Promise.resolve(readSqliteSupportLog(engine.sqlite(), tenantId))
          : engine.session().then((client) => readPostgresSupportLog(client, tenantId));
      const north = await read('north');
      assert.equal(north.sessions.length, SUPPORT_LOG_VISITS);
      assert.equal(north.more, true);
      assert.equal(north.sessions[0].id, `north-${String(visits - 1).padStart(4, '0')}`, 'newest first');
      assert.equal(
        north.sessions.some((row) => row.id === 'north-0000' || row.id === 'north-0001'),
        false,
        'the oldest two are left out',
      );
      assert.deepEqual(
        new Set(north.entries.map((row) => row.sessionId)),
        new Set(north.sessions.map((row) => row.id)),
        'entries belong to the visits read, and every visit read has its own',
      );
      assert.equal(
        north.sessions.every((row) => row.tenantId === 'north'),
        true,
      );

      const south = await read('south');
      assert.deepEqual(
        south.sessions.map((row) => row.id),
        ['south-late'],
      );
      assert.equal(south.more, false);
      // The lender's view crosses dealers, under the same bound.
      const every = await read(null);
      assert.equal(every.sessions.length, SUPPORT_LOG_VISITS);
      assert.equal(every.sessions[0].id, 'south-late');
      assert.equal(every.more, true);
    });
  });
