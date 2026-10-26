/**
 * The support audit store (slice 8a), on SQLite and, live, on PostgreSQL.
 *
 * Provisioning is explicit, idempotent and bound to one App, source, store and
 * audit key; a store without its tenant store, a changed layout, an extra
 * trigger, a foreign grant or another key is refused and left unchanged. The
 * MAC chain finds what the App's own role could do to the rows — an edited
 * entry, an edited session, a deleted tail, reordered entries, a forged tip, a
 * tail deleted with the tip rewound — and an altered chain is never extended.
 * Nothing here writes business rows: wiring the audit into writes, reads and
 * routes is a later slice.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import type { PgQuery, PgResult } from '../packages/engine/src/adapters/postgresPool.js';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import type { TenantStoreBinding } from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  assertSqliteSupportAudit,
  createSqliteSupportAudit,
  createSqliteSupportAuditOwner,
  provisionSqliteSupportAudit,
  verifySqliteSupportAudit,
} from '../packages/mistri/src/server/tenant/tenantSupportAudit.js';
import {
  SUPPORT_END_REASONS,
  SUPPORT_AUDIT_KEY_VARIABLE,
  SUPPORT_AUDIT_PREFIX,
  SUPPORT_AUDIT_TABLES as tables,
  SupportAuditKeyMissing,
  supportAuditKey,
  validateEntry,
  type SupportAudit,
  type SupportAuditHeader,
  type SupportAuditOwner,
  type SupportAuditKey,
  type SupportEntry,
  type SupportSession,
} from '../packages/mistri/src/server/tenant/tenantSupportAuditContract.js';
import {
  assertPostgresSupportAudit,
  createPostgresSupportAudit,
  createPostgresSupportAuditOwner,
  migratePostgresSupportAudit,
  SupportAuditUnavailable,
  verifyPostgresSupportAudit,
} from '../packages/mistri/src/server/tenant/tenantSupportAuditPostgres.js';
import { isRuntimeTable, runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { startupReport } from '../packages/engine/src/shared/refusal.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantEngine } from './support/tenantDialects.js';

const binding = (): TenantStoreBinding => ({ appId: 'app', source: { id: 'business', connection: 'business-db' }, storeId: 'store' });
const SECRET = 'PRIVATE_AUDIT_SECRET-0123456789abcdef0123456789';
const key = () => supportAuditKey(SECRET);
const otherKey = () => supportAuditKey(`${SECRET}-rotated`);
/* This suite's own PostgreSQL database, beside the server's: a run of it next
   to another must not have its fixture tables reset under it. */
const DATABASE = `support_audit_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

const SETUP = {
  sqlite: 'CREATE TABLE db_item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL)',
  postgres: 'CREATE TABLE public.db_item(id text PRIMARY KEY, tenant_id text NOT NULL)',
  tables: ['db_item'],
  database: DATABASE,
};
const denied = (error: unknown) => {
  assert.ok(error instanceof TenantContextError, String(error));
  assert.doesNotMatch(`${(error as Error).message} ${JSON.stringify(error)}`, /PRIVATE_AUDIT_SECRET/);
  return true;
};

const session = (id = 'support-1'): SupportSession => ({
  id,
  tenantId: 'north',
  accountId: 'lender-ana',
  operatorName: 'Ana Reyes',
  dealerRole: 'dealer_admin',
  parentMembershipId: 'platform-ana',
  parentMembershipVersion: '3',
  platformVersion: '1',
  reason: 'Checking a stuck application',
  openedAt: '2026-09-12T12:00:00.000Z',
  validUntil: 1_789_000_000_000,
  nativeSessionId: 'native-1',
  deployment: 'deployment-1',
  policyId: 'lender',
  policyVersion: 'v1',
  openReceiptId: 'receipt-open-1',
});
const entry = (kind: SupportEntry['kind'], over: Partial<SupportEntry> = {}): SupportEntry => ({
  kind,
  at: '2026-09-12T12:01:00.000Z',
  requestId: `request-${kind}`,
  actorId: 'lender-ana',
  tenantVersion: '1',
  supportMembershipVersion: '1',
  parentMembershipVersion: '3',
  platformVersion: '1',
  resource: null,
  operation: null,
  keyJson: null,
  detailJson: '{}',
  commandReceiptId: null,
  ...over,
});
const write = () =>
  entry('write', {
    resource: 'lead',
    operation: 'update',
    keyJson: '{"id":"lead-7"}',
    detailJson: '{"fields":[{"name":"status","before":{"v":"new"},"after":{"v":"qualified"}}],"exact":true}',
  });
const read = () =>
  entry('read', { detailJson: '{"route":"records","resources":[{"resource":"lead","rows":2,"keys":[{"id":"lead-7"},{"id":"lead-8"}]}]}' });
const exit = (endReason = 'exit') => entry('exit', { at: '2026-09-12T12:05:00.000Z', detailJson: JSON.stringify({ endReason }) });

/* ---------- per-engine plumbing ---------- */

const provision = (engine: TenantEngine, k: SupportAuditKey = key(), owner = binding()) =>
  engine.dialect === 'sqlite'
    ? Promise.resolve().then(() => provisionSqliteSupportAudit(engine.path, owner, k))
    : migratePostgresSupportAudit(engine.url, owner, k);
const verifyAll = (engine: TenantEngine, k: SupportAuditKey = key()) =>
  engine.dialect === 'sqlite'
    ? Promise.resolve().then(() => verifySqliteSupportAudit(engine.path, binding(), k))
    : verifyPostgresSupportAudit(engine.url, binding(), k);
/** One owner transaction with the audit composed on it, committed when `work` resolves. */
async function withAudit<T>(engine: TenantEngine, work: (audit: SupportAudit) => Promise<T>, k: SupportAuditKey = key()): Promise<T> {
  const operations = new TransactionOperations();
  if (engine.dialect === 'sqlite') {
    const db = engine.sqlite();
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = await work(createSqliteSupportAudit(db, operations, binding(), k));
      await operations.finish();
      db.exec('COMMIT');
      return out;
    } catch (error) {
      await operations.finish().catch(() => {});
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  const client = await engine.session();
  await client.query('BEGIN');
  try {
    const out = await work(createPostgresSupportAudit(client, operations, binding(), k));
    await operations.finish();
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await operations.finish().catch(() => {});
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
/** The attestation alone, in a transaction that changes nothing. */
async function attested(engine: TenantEngine, k: SupportAuditKey): Promise<void> {
  if (engine.dialect === 'sqlite') {
    const db = engine.sqlite();
    db.exec('BEGIN');
    try {
      assertSqliteSupportAudit(db, binding(), k);
    } finally {
      db.exec('ROLLBACK');
    }
    return;
  }
  const client = await engine.session();
  await client.query('BEGIN');
  try {
    await assertPostgresSupportAudit(client, binding(), k);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }
}
/** A tenant store, the audit, and one session with an opening entry, a change and a read. */
async function seeded(dialect: TenantEngine['dialect']): Promise<TenantEngine> {
  const engine = await openTenantEngine(dialect, SETUP);
  await engine.provisionStore(binding());
  await provision(engine);
  await withAudit(engine, async (audit) => {
    await audit.open(session(), entry('open'));
    assert.deepEqual(await audit.append('support-1', write()), { seq: 1 });
    assert.deepEqual(await audit.append('support-1', read()), { seq: 2 });
  });
  return engine;
}
const intact = (engine: TenantEngine) => withAudit(engine, (audit) => audit.verify('support-1'));

test('[sqlite] stored NUL suffix cannot disappear before support MAC verification', async () => {
  const engine = await seeded('sqlite');
  try {
    const original = session().reason;
    await engine.exec(`UPDATE "${tables.session}" SET reason = ? WHERE id = ?`, [original + '\u0000tail', 'support-1']);
    const row = await engine.get(`SELECT reason, instr(reason,char(0)) AS nul FROM "${tables.session}" WHERE id = ?`, ['support-1']);
    assert.equal(row!.nul, original.length + 1);
    assert.equal(await intact(engine), false);
    assert.deepEqual((await verifyAll(engine)).failed, ['support-1']);
    await assert.rejects(
      withAudit(engine, (audit) => audit.append('support-1', read())),
      denied,
    );
  } finally {
    await engine.close();
  }
});

test('[sqlite] MAC headers, digests and JSON preserve every stored byte', async () => {
  for (const [table, field, where] of [
    [tables.session, 'native_session_id', "id='support-1'"],
    [tables.session, 'head_mac', "id='support-1'"],
    [tables.entry, 'request_id', 'seq=1'],
    [tables.entry, 'prev_mac', 'seq=1'],
    [tables.entry, 'mac', 'seq=1'],
    [tables.entry, 'detail_json', 'seq=1'],
    [tables.entry, 'key_json', 'seq=1'],
  ]) {
    const engine = await seeded('sqlite');
    try {
      await engine.exec(`UPDATE "${table}" SET ${field}=${field} || char(0) || 'a' WHERE ${where}`);
      assert.equal(await intact(engine), false, field);
      assert.deepEqual((await verifyAll(engine)).failed, ['support-1']);
      await assert.rejects(
        withAudit(engine, (audit) => audit.append('support-1', read())),
        denied,
      );
    } finally {
      await engine.close();
    }
  }
});

test('[sqlite] malformed UTF-8 cannot alias a valid replacement character in a MAC', async () => {
  const engine = await seeded('sqlite');
  try {
    await withAudit(engine, (audit) => audit.open({ ...session('utf8'), reason: '\ufffd' }, entry('open')));
    assert.equal(await withAudit(engine, (audit) => audit.verify('utf8')), true);
    await engine.exec(`UPDATE "${tables.session}" SET reason=CAST(x'ff' AS TEXT) WHERE id='utf8'`);
    assert.equal((await engine.get(`SELECT reason FROM "${tables.session}" WHERE id='utf8'`))!.reason, '\ufffd');
    assert.equal(await withAudit(engine, (audit) => audit.verify('utf8')), false);
    assert.deepEqual((await verifyAll(engine)).failed, ['utf8']);
    await assert.rejects(
      withAudit(engine, (audit) => audit.append('utf8', read())),
      denied,
    );
    // BLOB JSON may satisfy SQLite json_valid, but it is not stored TEXT.
    await engine.exec(`UPDATE "${tables.entry}" SET key_json=CAST(key_json AS BLOB) WHERE session_id='support-1' AND seq=1`);
    assert.equal(await intact(engine), false);
  } finally {
    await engine.close();
  }
});

test('[sqlite] malformed metadata and session identifiers refuse instead of reporting truncated identities', async () => {
  for (const field of ['app_id', 'source_id', 'store_id']) {
    const engine = await seeded('sqlite');
    try {
      await engine.exec(`UPDATE "${tables.meta}" SET ${field}=${field} || char(0) || 'tail'`);
      await assert.rejects(intact(engine), denied);
      await assert.rejects(verifyAll(engine), denied);
    } finally {
      await engine.close();
    }
  }
  const engine = await seeded('sqlite');
  try {
    const db = engine.sqlite();
    db.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON');
    db.prepare(`UPDATE "${tables.session}" SET id=id || char(0) || 'tail' WHERE id='support-1'`).run();
    db.prepare(`UPDATE "${tables.entry}" SET session_id=session_id || char(0) || 'tail' WHERE session_id='support-1'`).run();
    db.exec('COMMIT');
    await assert.rejects(verifyAll(engine), denied);
    // A missing opening entry sends that malformed ID through broken() too.
    db.prepare(`DELETE FROM "${tables.entry}" WHERE seq=0`).run();
    await assert.rejects(verifyAll(engine), denied);
  } finally {
    await engine.close();
  }
});

test('[sqlite] audit catalog bytes are checked without trusting the cached executable schema', async (t) => {
  const engine = await seeded('sqlite'),
    db = engine.sqlite();
  const defensive = (db as typeof db & { enableDefensive?: (enabled: boolean) => void }).enableDefensive;
  try {
    defensive?.call(db, false);
    db.exec('PRAGMA writable_schema=ON');
    if (db.prepare('PRAGMA writable_schema').get()?.writable_schema !== 1) {
      t.skip('SQLite defensive mode does not allow the fixture mutation');
      return;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE sqlite_schema SET sql=sql || char(0) || ? WHERE name=?').run('tail', tables.meta);
      assert.throws(() => assertSqliteSupportAudit(db, binding(), key()), denied);
    } finally {
      db.exec('ROLLBACK');
    }
  } finally {
    try {
      db.exec('PRAGMA writable_schema=OFF');
      defensive?.call(db, true);
    } finally {
      await engine.close();
    }
  }
});

async function refusedAfter(engine: TenantEngine, alter: string, values?: unknown[]): Promise<void> {
  await engine.exec(alter, values);
  assert.equal(await intact(engine), false);
  await assert.rejects(
    withAudit(engine, (audit) => audit.append('support-1', read())),
    denied,
  );
  assert.deepEqual((await verifyAll(engine)).failed, ['support-1']);
}

/* ---------- engine-neutral ---------- */

test('the audit key comes from MISTRI_AUDIT_KEY, needs 32 bytes, and is never exposed', () => {
  const saved = process.env[SUPPORT_AUDIT_KEY_VARIABLE];
  try {
    delete process.env[SUPPORT_AUDIT_KEY_VARIABLE];
    assert.throws(() => supportAuditKey(), SupportAuditKeyMissing);
    assert.throws(
      () => supportAuditKey('too-short'),
      (error: Error) => {
        assert.ok(error instanceof SupportAuditKeyMissing);
        assert.match(error.message, /MISTRI_AUDIT_KEY/);
        assert.doesNotMatch(error.message, /too-short/);
        return true;
      },
    );
    process.env[SUPPORT_AUDIT_KEY_VARIABLE] = SECRET;
    assert.equal(supportAuditKey().id, key().id);
  } finally {
    if (saved === undefined) delete process.env[SUPPORT_AUDIT_KEY_VARIABLE];
    else process.env[SUPPORT_AUDIT_KEY_VARIABLE] = saved;
  }
  assert.match(key().id, /^[0-9a-f]{16}$/);
  assert.notEqual(key().id, otherKey().id);
  // The handle names the key; the derived secret is not a property of it.
  assert.equal(JSON.stringify(key()), JSON.stringify({ id: key().id }));
  assert.doesNotMatch(JSON.stringify(key()), /PRIVATE_AUDIT_SECRET/);
});

test('each entry kind carries exactly the columns that describe it', () => {
  for (const bad of [
    entry('write', { resource: 'lead', operation: 'update' }),
    entry('write', { resource: 'lead', operation: 'upsert', keyJson: '{}' }),
    entry('read', { resource: 'lead' }),
    entry('open', { commandReceiptId: 'receipt' }),
    entry('command', { resource: 'lead', operation: 'update', keyJson: '{}' }),
    entry('exit', { detailJson: '{}' }),
    entry('exit', { detailJson: '{"endReason":"bored"}' }),
    entry('read', { detailJson: 'not json' }),
    entry('write', { resource: 'lead', operation: 'update', keyJson: '{}', detailJson: JSON.stringify({ x: 'y'.repeat(70_000) }) }),
  ])
    assert.throws(() => validateEntry(bad), TenantContextError);
  for (const good of [
    write(),
    read(),
    exit(),
    entry('open'),
    entry('command', { commandReceiptId: 'receipt-1' }),
    entry('read', { detailJson: JSON.stringify({ keys: 'k'.repeat(200_000) }) }),
  ])
    validateEntry(good);
});

test('the reserved names are runtime state, never an App resource', () => {
  for (const name of Object.values(tables)) assert.ok(isRuntimeTable(name), name);
  assert.ok(SUPPORT_AUDIT_PREFIX.startsWith('__mistri_'));
});

/* ---------- the matrix ---------- */

for (const { dialect, skip } of TENANT_DIALECTS) {
  test(`[${dialect}] provisioning is explicit, idempotent, and needs the tenant store`, { skip }, async () => {
    const bare = await openTenantEngine(dialect, SETUP);
    try {
      await assert.rejects(provision(bare), dialect === 'sqlite' ? denied : SupportAuditUnavailable);
      assert.deepEqual(await bare.layout(SUPPORT_AUDIT_PREFIX), []);
    } finally {
      await bare.close();
    }
    const engine = await openTenantEngine(dialect, SETUP);
    try {
      await engine.provisionStore(binding());
      const first = await provision(engine),
        again = await provision(engine);
      assert.deepEqual(
        [Object.values(first), Object.values(again)],
        [
          [1, true],
          [1, false],
        ],
      );
      assert.deepEqual(await verifyAll(engine), { version: 1, sessions: 0, entries: 0, failed: [] });
      const meta = await engine.get(`SELECT app_id, source_id, store_id, key_id FROM "${tables.meta}"`);
      assert.deepEqual({ ...meta }, { app_id: 'app', source_id: 'business', store_id: 'store', key_id: key().id });
    } finally {
      await engine.close();
    }
  });

  /* A start with another MISTRI_AUDIT_KEY was told only "The tenant context could not be verified." (field report
     G165): the start now says the key is not the store's and what to do, and never the key or its id. */
  test(`[${dialect}] a start under another audit key says the key is not the store's, never the key`, { skip }, async () => {
    const engine = await seeded(dialect);
    try {
      const error = await attested(engine, otherKey()).then(
        () => assert.fail('another key attested'),
        (caught: unknown) => caught,
      );
      denied(error);
      const said = startupReport(error);
      assert.match(said, /MISTRI_AUDIT_KEY is not the key this support audit store was set up with/, said);
      assert.match(said, /Start with the key it was set up with/, said);
      assert.doesNotMatch(said, new RegExp(`${SECRET}|${otherKey().id}|${key().id}`));
      const migrated = await provision(engine, otherKey()).then(
        () => assert.fail('another key provisioned'),
        (caught: unknown) => caught,
      );
      assert.match(startupReport(migrated), /MISTRI_AUDIT_KEY is not the key this support audit store was set up with/);
    } finally {
      await engine.close();
    }
  });

  test(`[${dialect}] another store, App or key is refused and nothing changes`, { skip }, async () => {
    const engine = await seeded(dialect);
    try {
      const before = await engine.layout(SUPPORT_AUDIT_PREFIX);
      const refusal = dialect === 'sqlite' ? denied : SupportAuditUnavailable;
      await assert.rejects(provision(engine, key(), { ...binding(), storeId: 'other-store' }), refusal);
      await assert.rejects(provision(engine, key(), { ...binding(), appId: 'other-app' }), refusal);
      await assert.rejects(provision(engine, otherKey()), refusal);
      await assert.rejects(verifyAll(engine, otherKey()), denied);
      await assert.rejects(
        withAudit(engine, (audit) => audit.verify('support-1'), otherKey()),
        denied,
      );
      // The attestation a later slice runs inside the business transaction.
      await attested(engine, key());
      await assert.rejects(attested(engine, otherKey()), denied);
      assert.deepEqual(await engine.layout(SUPPORT_AUDIT_PREFIX), before);
      assert.equal(await intact(engine), true);
    } finally {
      await engine.close();
    }
  });

  test(`[${dialect}] a changed layout or an extra trigger is refused, not altered`, { skip }, async () => {
    for (const change of ['column', 'trigger'] as const) {
      const engine = await seeded(dialect);
      try {
        if (change === 'column') await engine.exec(`ALTER TABLE "${tables.entry}" ADD COLUMN note text`);
        else if (dialect === 'sqlite')
          await engine.exec(`CREATE TRIGGER "${SUPPORT_AUDIT_PREFIX}quiet" AFTER INSERT ON "${tables.entry}" BEGIN SELECT 1; END`);
        else
          await engine.exec(
            `CREATE TRIGGER quiet AFTER INSERT ON public."${tables.entry}" FOR EACH ROW EXECUTE FUNCTION public.tablewalk_fixture_noop()`,
          );
        const before = await engine.layout(SUPPORT_AUDIT_PREFIX);
        await assert.rejects(provision(engine), dialect === 'sqlite' ? denied : SupportAuditUnavailable);
        await assert.rejects(
          withAudit(engine, (audit) => audit.append('support-1', read())),
          denied,
        );
        await assert.rejects(verifyAll(engine), denied);
        assert.deepEqual(await engine.layout(SUPPORT_AUDIT_PREFIX), before, change);
      } finally {
        await engine.close();
      }
    }
  });

  test(`[${dialect}] a session opens, grows and closes on one chain, and a closed one takes nothing more`, { skip }, async () => {
    const engine = await seeded(dialect);
    try {
      assert.equal(await intact(engine), true);
      assert.deepEqual(await withAudit(engine, (audit) => audit.append('support-1', exit('parent_revoked'))), { seq: 3 });
      const closed = await engine.get(`SELECT ended_at, end_reason, head_seq FROM "${tables.session}" WHERE id = ?`, ['support-1']);
      assert.deepEqual(
        { ...closed, head_seq: Number(closed!.head_seq) },
        { ended_at: '2026-09-12T12:05:00.000Z', end_reason: 'parent_revoked', head_seq: 3 },
      );
      assert.equal(await intact(engine), true);
      await assert.rejects(
        withAudit(engine, (audit) => audit.append('support-1', read())),
        denied,
      );
      await assert.rejects(
        withAudit(engine, (audit) => audit.open(session(), entry('open'))),
        denied,
      );
      await assert.rejects(
        withAudit(engine, (audit) => audit.append('no-such-session', read())),
        denied,
      );
      assert.equal(await withAudit(engine, (audit) => audit.verify('no-such-session')), null);
      // A second session is its own chain.
      await withAudit(engine, async (audit) => {
        await audit.open(session('support-2'), entry('open'));
        await audit.append('support-2', write());
      });
      assert.deepEqual(await verifyAll(engine), { version: 1, sessions: 2, entries: 6, failed: [] });
    } finally {
      await engine.close();
    }
  });

  test(`[${dialect}] a refused append leaves the chain as it was`, { skip }, async () => {
    const engine = await seeded(dialect);
    try {
      await assert.rejects(
        withAudit(engine, (audit) => audit.append('support-1', entry('write', { resource: 'lead' }))),
        denied,
      );
      await assert.rejects(
        withAudit(engine, (audit) => audit.append('support-1', entry('open'))),
        denied,
      );
      const count = await engine.get(`SELECT count(*) AS n FROM "${tables.entry}"`);
      assert.equal(Number(count!.n), 3);
      assert.equal(await intact(engine), true);
    } finally {
      await engine.close();
    }
  });

  test(`[${dialect}] the chain finds an edited entry, an edited session and a moved tenant`, { skip }, async () => {
    for (const [what, alter] of [
      [
        'entry value',
        `UPDATE "${tables.entry}" SET detail_json = '{"fields":[{"name":"status","before":{"v":"new"},"after":{"v":"disqualified"}}],"exact":true}' WHERE seq = 1`,
      ],
      ['session reason', `UPDATE "${tables.session}" SET reason = 'Routine check' WHERE id = 'support-1'`],
      ['entry tenant', `UPDATE "${tables.entry}" SET tenant_id = 'harbor' WHERE seq = 2`],
      ['entry actor', `UPDATE "${tables.entry}" SET actor_id = 'someone-else' WHERE seq = 1`],
    ] as const) {
      const engine = await seeded(dialect);
      try {
        await refusedAfter(engine, alter);
      } catch (error) {
        throw new Error(`${what}: ${String(error)}`);
      } finally {
        await engine.close();
      }
    }
  });

  test(`[${dialect}] the chain finds a deleted tail, reordered entries and a forged or rewound tip`, { skip }, async () => {
    const cases: Array<[string, (engine: TenantEngine) => Promise<void>]> = [
      ['deleted tail', (engine) => engine.exec(`DELETE FROM "${tables.entry}" WHERE seq = 2`)],
      [
        'reordered',
        async (engine) => {
          await engine.exec(`UPDATE "${tables.entry}" SET seq = 100 WHERE seq = 1`);
          await engine.exec(`UPDATE "${tables.entry}" SET seq = 1 WHERE seq = 2`);
          await engine.exec(`UPDATE "${tables.entry}" SET seq = 2 WHERE seq = 100`);
        },
      ],
      ['forged tip', (engine) => engine.exec(`UPDATE "${tables.session}" SET head_mac = ?`, ['a'.repeat(64)])],
      // The tail deleted and the tip moved back to the surviving last entry's
      // MAC, the one value an attacker can read: still refused.
      [
        'rewound tip',
        async (engine) => {
          const survivor = await engine.get(`SELECT mac FROM "${tables.entry}" WHERE seq = 1`);
          await engine.exec(`DELETE FROM "${tables.entry}" WHERE seq = 2`);
          await engine.exec(`UPDATE "${tables.session}" SET head_seq = 1, head_mac = ?`, [survivor!.mac]);
        },
      ],
      [
        'end erased',
        async (engine) => {
          await withAudit(engine, (audit) => audit.append('support-1', exit()));
          await engine.exec(`DELETE FROM "${tables.entry}" WHERE seq = 3`);
          await engine.exec(`UPDATE "${tables.session}" SET ended_at = NULL, end_reason = NULL, head_seq = 2`);
        },
      ],
    ];
    for (const [what, alter] of cases) {
      const engine = await seeded(dialect);
      try {
        await alter(engine);
        assert.equal(await intact(engine), false, what);
        await assert.rejects(
          withAudit(engine, (audit) => audit.append('support-1', read())),
          denied,
          what,
        );
        assert.deepEqual((await verifyAll(engine)).failed, ['support-1'], what);
      } finally {
        await engine.close();
      }
    }
  });

  test(`[${dialect}] a deleted session is reported, not hidden`, { skip }, async () => {
    const engine = await seeded(dialect);
    try {
      if (dialect === 'sqlite') {
        engine.sqlite().exec('PRAGMA foreign_keys = OFF');
        await engine.exec(`DELETE FROM "${tables.session}" WHERE id = 'support-1'`);
        engine.sqlite().exec('PRAGMA foreign_keys = ON');
      } else {
        // The App's own role cannot do it: the foreign key refuses, and the
        // chain is untouched.
        await assert.rejects(
          engine.exec(`DELETE FROM public."${tables.session}" WHERE id = 'support-1'`),
          (error: { code?: string }) => error.code === '23503',
        );
        assert.equal(await intact(engine), true);
        // A superuser can, by skipping the key's triggers; then the report says so.
        if (!(await engine.get('SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER'))?.rolsuper) return;
        const session = await engine.session();
        await session.query("SET session_replication_role = 'replica'");
        await session.query(`DELETE FROM public."${tables.session}" WHERE id = 'support-1'`);
      }
      assert.deepEqual(await verifyAll(engine), { version: 1, sessions: 0, entries: 3, failed: ['support-1'] });
      await assert.rejects(provision(engine), dialect === 'sqlite' ? denied : SupportAuditUnavailable);
    } finally {
      await engine.close();
    }
  });
}

test(
  '[postgres] a foreign grant is refused, and appends on two connections queue on the session row',
  { skip: TENANT_DIALECTS.find((entry) => entry.dialect === 'postgres')!.skip },
  async () => {
    const engine = await seeded('postgres');
    try {
      const [a, b] = [await engine.session(), await engine.session()];
      const operations = [new TransactionOperations(), new TransactionOperations()];
      await a.query('BEGIN');
      await b.query('BEGIN');
      const first = createPostgresSupportAudit(a, operations[0], binding(), key());
      const second = createPostgresSupportAudit(b, operations[1], binding(), key());
      assert.deepEqual(await first.append('support-1', read()), { seq: 3 });
      // The second waits on the first's row lock, then reads the moved tip.
      const waiting = second.append('support-1', write());
      await new Promise((resolve) => setTimeout(resolve, 200));
      await operations[0].finish();
      await a.query('COMMIT');
      assert.deepEqual(await waiting, { seq: 4 });
      await operations[1].finish();
      await b.query('COMMIT');
      assert.equal(await intact(engine), true);

      await engine.exec(`GRANT SELECT ON public."${tables.entry}" TO PUBLIC`);
      await assert.rejects(migratePostgresSupportAudit(engine.url, binding(), key()), (error: Error) => {
        assert.ok(error instanceof SupportAuditUnavailable);
        assert.match(error.message, /another role holds privileges/);
        return true;
      });
      await assert.rejects(
        withAudit(engine, (audit) => audit.verify('support-1')),
        denied,
      );
    } finally {
      await engine.close();
    }
  },
);

/** The future owner borrows this same transaction, rather than nesting a queue
 * operation around calls that already enqueue. No authentication is faked. */
async function withHeaderOwner<T>(
  engine: TenantEngine,
  work: (owner: SupportAuditOwner, operations: TransactionOperations) => Promise<T>,
  k: SupportAuditKey = key(),
  storeBinding = binding(),
): Promise<T> {
  const operations = new TransactionOperations();
  if (engine.dialect === 'sqlite') {
    const db = engine.sqlite();
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = await work(createSqliteSupportAuditOwner(db, operations, storeBinding, k), operations);
      await operations.finish();
      db.exec('COMMIT');
      return out;
    } catch (error) {
      await operations.finish().catch(() => {});
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
  const client = await engine.session();
  await client.query('BEGIN');
  try {
    const out = await work(createPostgresSupportAuditOwner(client, operations, storeBinding, k), operations);
    await operations.finish();
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await operations.finish().catch(() => {});
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

for (const { dialect, skip } of TENANT_DIALECTS) {
  test(`[${dialect}] private support header is verified history and shares the existing queue`, { skip, timeout: 10_000 }, async () => {
    const engine = await seeded(dialect);
    try {
      await withAudit(engine, async (audit) => {
        assert.deepEqual(Object.keys(audit).sort(), ['append', 'open', 'verify']);
      });
      let retained: SupportAuditOwner | undefined;
      await withHeaderOwner(engine, async (owner) => {
        retained = owner;
        assert.deepEqual(Object.keys(owner).sort(), ['audit', 'readHeader']);
        const before: SupportAuditHeader | null = await owner.readHeader('support-1');
        assert.deepEqual(JSON.parse(JSON.stringify(before)), {
          stage: 'support-audit-header',
          authorization: 'pending',
          binding: binding(),
          session: { ...session(), endedAt: null, endReason: null },
        });
        assert.ok(Object.isFrozen(before) && Object.isFrozen(before!.binding.source) && Object.isFrozen(before!.session));
        assert.doesNotMatch(JSON.stringify(before), /headSeq|headMac|prevMac|PRIVATE_AUDIT_SECRET/);
        assert.equal(await owner.readHeader('missing'), null);
        // Both siblings enqueue once; no readHeader -> verify nested queue.
        const [same, appended] = await Promise.all([owner.readHeader('support-1'), owner.audit.append('support-1', read())]);
        assert.deepEqual(same, before);
        assert.deepEqual(appended, { seq: 3 });
        assert.deepEqual(await owner.readHeader('support-1'), before);
        await owner.audit.append('support-1', exit());
        assert.deepEqual(JSON.parse(JSON.stringify((await owner.readHeader('support-1'))!.session)), {
          ...session(),
          endedAt: exit().at,
          endReason: 'exit',
        });
      });
      await assert.rejects(retained!.readHeader('support-1'), denied);
    } finally {
      await engine.close();
    }
  });

  test(`[${dialect}] private support header accepts every stored historical end reason`, { skip }, async () => {
    const engine = await seeded(dialect);
    try {
      await withHeaderOwner(engine, async (owner) => {
        for (const reason of SUPPORT_END_REASONS) {
          const id = `closed-${reason}`;
          await owner.audit.open(session(id), entry('open'));
          await owner.audit.append(id, exit(reason));
          assert.equal((await owner.readHeader(id))!.session.endReason, reason);
        }
      });
    } finally {
      await engine.close();
    }
  });

  test(`[${dialect}] header refuses edited session, entry, tip and foreign binding/key`, { skip }, async () => {
    for (const sql of [
      `UPDATE "${tables.session}" SET reason='changed' WHERE id='support-1'`,
      `UPDATE "${tables.entry}" SET request_id='changed' WHERE session_id='support-1' AND seq=1`,
      `DELETE FROM "${tables.entry}" WHERE session_id='support-1' AND seq=2`,
    ]) {
      const engine = await seeded(dialect);
      try {
        await engine.exec(sql);
        assert.equal(await intact(engine), false);
        await assert.rejects(
          withHeaderOwner(engine, (owner) => owner.readHeader('support-1')),
          denied,
        );
      } finally {
        await engine.close();
      }
    }
    const engine = await seeded(dialect);
    try {
      await assert.rejects(
        withHeaderOwner(engine, (owner) => owner.readHeader('support-1'), otherKey()),
        denied,
      );
      await assert.rejects(
        withHeaderOwner(engine, (owner) => owner.readHeader('support-1'), key(), { ...binding(), storeId: 'foreign' }),
        denied,
      );
    } finally {
      await engine.close();
    }
  });

  test(`[${dialect}] malformed header calls execute no getters and poison caught or abandoned work`, { skip }, async () => {
    const engine = await seeded(dialect);
    try {
      let calls = 0;
      for (const bad of [
        '',
        'bad id',
        '\ud800',
        1,
        {
          get id() {
            calls++;
            return 'support-1';
          },
        },
        new Proxy(
          {},
          {
            ownKeys() {
              calls++;
              return [];
            },
          },
        ),
      ]) {
        await assert.rejects(
          withHeaderOwner(engine, async (owner) => {
            await owner.audit.open(session('rolled-back'), entry('open'));
            await owner.readHeader(bad as string).catch(() => {});
          }),
          denied,
        );
        assert.equal(await withAudit(engine, (audit) => audit.verify('rolled-back')), null);
      }
      assert.equal(calls, 0);
      await assert.rejects(
        withHeaderOwner(engine, async (owner) => {
          await owner.audit.open(session('abandoned'), entry('open'));
          void owner.readHeader('bad id');
        }),
        denied,
      );
      assert.equal(await withAudit(engine, (audit) => audit.verify('abandoned')), null);
    } finally {
      await engine.close();
    }
  });
}

test('[sqlite] private header retains exact-byte refusal before projection', async () => {
  for (const sql of [
    `UPDATE "${tables.session}" SET reason=reason || char(0) || 'tail' WHERE id='support-1'`,
    `UPDATE "${tables.session}" SET reason=CAST(x'ff' AS TEXT) WHERE id='support-1'`,
    `UPDATE "${tables.entry}" SET key_json=CAST(key_json AS BLOB) WHERE seq=1`,
  ]) {
    const engine = await seeded('sqlite');
    try {
      await engine.exec(sql);
      await assert.rejects(
        withHeaderOwner(engine, (owner) => owner.readHeader('support-1')),
        denied,
      );
    } finally {
      await engine.close();
    }
  }
});

test(
  '[postgres] private header locks its session until transaction release',
  {
    skip: TENANT_DIALECTS.find((value) => value.dialect === 'postgres')!.skip,
    timeout: 10_000,
  },
  async () => {
    const engine = await seeded('postgres');
    const operations = new TransactionOperations(),
      competing = new TransactionOperations();
    const a = await engine.session(),
      b = await engine.session();
    try {
      await a.query('BEGIN');
      const owner = createPostgresSupportAuditOwner(a, operations, binding(), key());
      await owner.readHeader('support-1');
      await b.query('BEGIN');
      await b.query("SET LOCAL lock_timeout = '50ms'");
      // Attestation's ROW EXCLUSIVE table locks are compatible; the competing
      // append's session FOR UPDATE must wait on the header's tuple lock.
      const audit = createPostgresSupportAudit(b, competing, binding(), key());
      await assert.rejects(audit.append('support-1', exit()), denied);
      await competing.finish().catch(() => {});
      await b.query('ROLLBACK');
      await operations.finish();
      await a.query('COMMIT');
      await withHeaderOwner(engine, async (next) => {
        await next.audit.append('support-1', exit());
        assert.equal((await next.readHeader('support-1'))!.session.endReason, 'exit');
      });
    } finally {
      await operations.finish().catch(() => {});
      await competing.finish().catch(() => {});
      await a.query('ROLLBACK').catch(() => {});
      await b.query('ROLLBACK').catch(() => {});
      await engine.close();
    }
  },
);

test(
  '[postgres] private header refuses non-writer use and checkpoints each query result',
  {
    skip: TENANT_DIALECTS.find((value) => value.dialect === 'postgres')!.skip,
    timeout: 10_000,
  },
  async () => {
    const engine = await seeded('postgres');
    try {
      for (const begin of [null, 'BEGIN READ ONLY']) {
        const client = await engine.session(),
          operations = new TransactionOperations();
        if (begin) await client.query(begin);
        try {
          const owner = createPostgresSupportAuditOwner(client, operations, binding(), key());
          await assert.rejects(owner.readHeader('support-1'), denied);
        } finally {
          await operations.finish().catch(() => {});
          await client.query('ROLLBACK').catch(() => {});
        }
      }
      for (const table of [tables.session, tables.entry]) {
        const native = await engine.session(),
          operations = new TransactionOperations();
        await native.query('BEGIN');
        let active = true,
          tripped = false,
          afterLoss = 0;
        function query(text: string, params?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
        function query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
        async function query(text: string | { text: string; values?: unknown[]; rowMode?: string }, params?: unknown[]) {
          if (!active) afterLoss++;
          const result = typeof text === 'string' ? await native.query(text, params) : await native.query(text);
          const sql = typeof text === 'string' ? text : text.text;
          if (sql.startsWith('SELECT ') && sql.includes(`FROM ${runtimeTable('postgres', table)} WHERE`)) {
            active = false;
            tripped = true;
          }
          return result;
        }
        const client: PgQuery = { query };
        try {
          const owner = createPostgresSupportAuditOwner(client, operations, binding(), key(), () => {
            if (!active) throw new Error('Retired fixture writer');
          });
          await assert.rejects(owner.readHeader('support-1'), denied);
          assert.equal(tripped, true, table);
          assert.equal(afterLoss, 0, 'No next SQL query after the lifetime fence fails');
        } finally {
          await operations.finish().catch(() => {});
          await native.query('ROLLBACK').catch(() => {});
        }
      }
    } finally {
      await engine.close();
    }
  },
);
