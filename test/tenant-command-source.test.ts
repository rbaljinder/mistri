/**
 * The tenant command source — business rows, receipt and audit in one fenced
 * transaction — as a dialect matrix: SQLite always, PostgreSQL live-gated by
 * TABLEWALK_TEST_PG (support/tenantDialects.ts), on each engine's own command
 * journal. Where a concurrent revocation meets the writer, SQLite refuses it as
 * locked and PostgreSQL makes it wait for the commit; the test says which.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TransactionOutcomeUnknown, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import {
  COMMAND_JOURNAL_TABLES as tables,
  type CommandJournal,
  type CommandReceiptScope,
  type StoredCommandReceipt,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { auditRows } from './support/commandTargets.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { TENANT_TABLES, type TenantStoreAdministration } from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  captureTenantWriteSource,
  TenantWriteFailure,
  type TenantWriteSource,
} from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';

const owner = { appId: 'command-app', source: { id: 'business', connection: 'business-db' }, storeId: 'command-fixture' };
const rows: RowScope = { item: true, country: true };
const scope = (key = 'same-attempt'): CommandReceiptScope => ({
  appId: owner.appId,
  actorId: 'alice',
  commandId: 'increment',
  commandVersion: 1,
  idempotencyKey: key,
});
const receipt = (tenant = 'north', key = 'same-attempt'): StoredCommandReceipt => ({
  ...scope(key),
  id: `${tenant}-${key}`,
  fingerprint: 'captured-fingerprint',
  resultJson: JSON.stringify({ applied: true, tenant }),
  requestId: `${tenant}-request`,
  completedAt: '2026-09-08T12:00:00.000Z',
});
const audit = { target: 'item', keyJson: '{"id":"north-row"}', changesJson: '[{"column":"quantity","before":0,"after":1}]' };
const change = (tenant = 'north', quantity = 1) => ({ table: 'item', key: { id: `${tenant}-row` }, values: { quantity } });
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function settles(promise: Promise<unknown>, ms = 300): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    delay(ms).then(() => false),
  ]);
}
function safe(outcome: 'not_applied' | 'unknown') {
  return (error: unknown): boolean => {
    assert.ok(error instanceof TenantWriteFailure);
    assert.equal(error.outcome, outcome);
    assert.equal(error.code, 'tenant_write_unavailable');
    assert.equal(error.message, 'The tenant write could not be completed.');
    assert.equal('cause' in error, false);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_SENTINEL|db_item|command-fixture/);
    return true;
  };
}

// Exact prior schemas, intentionally not upgraded by a request or by migration.
const v1 = {
  sqlite: `CREATE TABLE "${tables.meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 1)
);
CREATE TABLE "${tables.receipt}" (
  id TEXT PRIMARY KEY NOT NULL,
  app_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  command_version INTEGER NOT NULL CHECK (command_version > 0),
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 16384),
  request_id TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  UNIQUE (app_id, actor_id, command_id, command_version, idempotency_key)
);
CREATE TABLE "__mistri_command_audit" (
  receipt_id TEXT PRIMARY KEY NOT NULL REFERENCES "${tables.receipt}" (id) ON DELETE RESTRICT,
  target TEXT NOT NULL,
  key_json TEXT NOT NULL CHECK (json_valid(key_json) AND length(CAST(key_json AS BLOB)) <= 8192),
  changes_json TEXT NOT NULL CHECK (json_valid(changes_json) AND length(CAST(changes_json AS BLOB)) <= 65536)
);
INSERT INTO "${tables.meta}" VALUES (1,1);`,
  postgres: `CREATE SCHEMA IF NOT EXISTS mistri;
CREATE TABLE ${runtimeTable('postgres', tables.meta)} (singleton integer PRIMARY KEY CHECK (singleton = 1), version integer NOT NULL CHECK (version = 1));
INSERT INTO ${runtimeTable('postgres', tables.meta)} VALUES (1, 1);`,
};

const SCHEMA = {
  tables: ['db_item', 'db_country'],
  sqlite: `PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;
    CREATE TABLE db_item (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT COLLATE NOCASE NOT NULL, business_id TEXT NOT NULL,
      name TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 0, UNIQUE(tenant_id COLLATE BINARY,business_id));
    CREATE TABLE db_country (code TEXT NOT NULL PRIMARY KEY, name TEXT);`,
  postgres: `
    CREATE TABLE public.db_item (id text PRIMARY KEY, tenant_id text NOT NULL, business_id text NOT NULL,
      name text NOT NULL, quantity integer NOT NULL DEFAULT 0, UNIQUE (tenant_id, business_id));
    CREATE TABLE public.db_country (code text PRIMARY KEY, name text);`,
};
const ROWS = `
    INSERT INTO db_item VALUES ('north-row','north','same-business','North',0),('south-row','south','same-business','South',0),
      ('alias-row','North','same-business','Alias',0);
    INSERT INTO db_country VALUES ('us','Global');`;

/* This suite's own PostgreSQL database, beside the server's: a run of it next
   to another must not have its fixture tables reset under it. */
const DATABASE = `command_source_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

async function fixture(t: TestContext, dialect: TenantDialect, journal: 'v2' | 'missing' | 'v1' = 'v2') {
  const engine = await openTenantEngine(dialect, {
    ...SCHEMA,
    sqlite: SCHEMA.sqlite + ROWS,
    postgres: SCHEMA.postgres + ROWS,
    database: DATABASE,
  });
  const sources: TenantWriteSource[] = [];
  t.after(async () => {
    try {
      await Promise.all(sources.map((source) => source.close()));
    } finally {
      await engine.close();
    }
  });
  await engine.provisionStore(owner);
  if (journal === 'v2') assert.deepEqual(await engine.migrateCommandJournal(), { version: 1, migrated: true });
  if (journal === 'v1') await engine.exec(v1[dialect]);
  const maintenance = (run: (admin: TenantStoreAdministration) => Promise<void>) => engine.maintenance(owner, run);
  const grant = {
    tenantId: 'north',
    accountId: 'alice',
    membershipId: 'north-alice',
    status: 'active' as const,
    roles: ['editor'],
    validUntil: 10000,
    expectedVersion: null,
  };
  await maintenance(async (admin) => {
    for (const tenantId of ['north', 'south']) {
      await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      for (const accountId of ['alice', 'bob'])
        await admin.putMembership({ ...grant, tenantId, accountId, membershipId: `${tenantId}-${accountId}` });
    }
  });
  const physicalSchema = await engine.physicalSchema();
  const resources = { item: engine.id('db_item'), country: engine.id('db_country') },
    catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    schema: catalog.schema,
    physicalSchema,
    resources,
    ownership: { item: { kind: 'tenant', column: 'tenant_id' }, country: { kind: 'global', access: 'read-only' } },
  });
  let time = 1000;
  const evidence = async (tenantId = 'north', accountId = 'alice', deployment = 'deployment-1'): Promise<TenantMembershipEvidence> => {
    // Read actual membership; this is host evidence, not an authentication wrapper.
    const lookup = { appId: owner.appId, source: owner.source, accountId, tenantId, deployment };
    const record = await engine.readMembership(owner, lookup);
    assert.ok(record);
    return {
      ...lookup,
      membershipId: record.membershipId,
      membershipVersion: record.membershipVersion,
      tenantVersion: record.tenantVersion,
      roles: [...record.roles],
      verifiedAt: time,
      validUntil: Math.min(time + 5000, record.validUntil),
    };
  };
  const open = async () => {
    const source = await engine.openWrite(ownership, owner, () => time);
    sources.push(source);
    return source;
  };
  const quantity = async (tenant = 'north') => (await engine.get('SELECT quantity FROM db_item WHERE id=?', [`${tenant}-row`]))!.quantity;
  // A table by name, or a subquery (the receipt's targets, support/commandTargets.ts).
  const count = async (table: string) =>
    Number((await engine.get(`SELECT CAST(count(*) AS INTEGER) AS n FROM ${table.startsWith('(') ? `${table} a` : `"${table}"`}`))!.n);
  const counts = async () => [await count(tables.receipt), await count(auditRows(dialect))];
  return {
    engine,
    dialect,
    open,
    evidence,
    maintenance,
    grant,
    quantity,
    counts,
    setTime: (value: number) => {
      time = value;
    },
    revoke: () => maintenance((admin) => admin.putMembership({ ...grant, status: 'revoked', expectedVersion: '1' })),
  };
}

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`tenant command source on ${dialect}`, { skip }, () => {
    const postgres = dialect === 'postgres';
    const revokeRaw = `UPDATE "${TENANT_TABLES.membership}" SET status='revoked',version='2' WHERE id='north-alice'`;

    test('genuine command source commits business row, receipt and audit atomically and reopens the durable receipt', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      assert.equal(captureTenantWriteSource(source), source);
      assert.ok(Object.isFrozen(source));
      let retainedRecords!: WriteTransaction, retainedJournal!: CommandJournal, observed: unknown;
      const result = await source.commandTransaction(await f.evidence(), rows, async (records, journal) => {
        retainedRecords = records;
        retainedJournal = journal;
        observed = {
          records: Object.keys(records).sort(),
          journal: Object.keys(journal).sort(),
          frozen: Object.isFrozen(records) && Object.isFrozen(journal),
        };
        await records.update(change());
        await journal.commit(receipt(), audit);
        return { found: await journal.find(scope()), outside: { quantity: await f.quantity(), counts: await f.counts() } };
      });
      assert.deepEqual(observed, {
        records: ['count', 'insert', 'query', 'remove', 'update'],
        journal: ['commit', 'find', 'nextNumber'],
        frozen: true,
      });
      assert.deepEqual(plain(result), { found: receipt(), outside: { quantity: 0, counts: [0, 0] } });
      assert.equal(await f.quantity(), 1);
      assert.deepEqual(await f.counts(), [1, 1]);
      const provenance = await f.engine.get(`SELECT app_id,store_id,source_id,tenant_id,actor_id,membership_id,membership_version,
      realm_version,roles_json,deployment FROM ${auditRows(dialect)} a`);
      assert.deepEqual(plain(provenance), {
        app_id: owner.appId,
        store_id: owner.storeId,
        source_id: owner.source.id,
        tenant_id: 'north',
        actor_id: 'alice',
        membership_id: 'north-alice',
        membership_version: '1',
        realm_version: '1',
        roles_json: '["editor"]',
        deployment: 'deployment-1',
      });
      assert.ok(Object.isFrozen(result.found));
      await assert.rejects(retainedRecords.count('item'));
      await assert.rejects(retainedJournal.find(scope()));
      await assert.rejects(retainedJournal.commit(receipt('north', 'late'), audit));
      await source.close();
      const reopened = await f.open();
      const replay = await reopened.commandTransaction(await f.evidence(), rows, (_records, journal) => journal.find(scope()));
      assert.deepEqual(plain(replay), receipt());
      assert.equal(await f.quantity(), 1);
      assert.deepEqual(await f.counts(), [1, 1]);
    });

    for (const stage of ['business', 'receipt', 'receipt insert'] as const) {
      test(`failure after ${stage} rolls back both business changes and the receipt`, async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(),
          evidence = await f.evidence();
        const fault =
          stage === 'receipt insert'
            ? f.engine.intercept(t, {
                match: (statement) => statement.sql.includes('INSERT INTO') && statement.sql.includes(`"${tables.receipt}"`),
                fault: 'before',
              })
            : undefined;
        try {
          await assert.rejects(
            source.commandTransaction(evidence, rows, async (records, journal) => {
              await records.update(change());
              if (stage === 'business') throw new Error('PRIVATE_SENTINEL');
              await journal.commit(receipt(), audit);
              throw new Error('PRIVATE_SENTINEL');
            }),
            safe('not_applied'),
          );
        } finally {
          fault?.restore();
        }
        assert.equal(await f.quantity(), 0);
        assert.deepEqual(await f.counts(), [0, 0]);
        await source.commandTransaction(await f.evidence(), rows, async (records, journal) => {
          await records.update(change());
          await journal.commit(receipt(), audit);
        });
        assert.equal(await f.quantity(), 1);
        assert.deepEqual(await f.counts(), [1, 1], 'confirmed rollback leaves a reusable source');
      });
    }

    test('same actor and idempotency key in two tenants have independent effects, receipts and audits', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      for (const tenant of ['north', 'south']) {
        const found = await source.commandTransaction(await f.evidence(tenant), rows, async (records, journal) => {
          const previous = await journal.find(scope());
          await records.update(change(tenant));
          await journal.commit(receipt(tenant), { ...audit, keyJson: JSON.stringify({ id: `${tenant}-row` }) });
          return previous;
        });
        assert.equal(found, undefined);
      }
      for (const tenant of ['north', 'south']) {
        assert.deepEqual(
          plain(await source.commandTransaction(await f.evidence(tenant), rows, (_records, journal) => journal.find(scope()))),
          receipt(tenant),
        );
        assert.equal(await f.quantity(tenant), 1);
      }
      assert.deepEqual(await f.counts(), [2, 2]);
      assert.equal((await f.engine.get("SELECT quantity FROM db_item WHERE id='alias-row'"))!.quantity, 0);
    });

    test('queued duplicate command performs one effect when its actual writer first checks journal.find', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        evidence = await f.evidence(),
        entered = gate(),
        release = gate();
      let effects = 0,
        secondEntered = false;
      const execute = async (records: WriteTransaction, journal: CommandJournal, first: boolean) => {
        const previous = await journal.find(scope());
        if (previous) return previous;
        if (first) {
          entered.release();
          await release.promise;
        }
        effects++;
        await records.update(change());
        await journal.commit(receipt(), audit);
        return receipt();
      };
      const first = source.commandTransaction(evidence, rows, (records, journal) => execute(records, journal, true));
      await entered.promise;
      const second = source.commandTransaction(evidence, rows, (records, journal) => {
        secondEntered = true;
        return execute(records, journal, false);
      });
      assert.equal(secondEntered, false);
      release.release();
      assert.deepEqual((await Promise.all([first, second])).map(plain), [receipt(), receipt()]);
      assert.equal(effects, 1);
      assert.equal(await f.quantity(), 1);
      assert.deepEqual(await f.counts(), [1, 1]);
    });

    for (const transition of ['membership revision', 'membership ID', 'roles', 'tenant revision', 'deployment'] as const) {
      test(`fresh ${transition} replays stable receipt identity rather than authorizing another effect`, async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open();
        await source.commandTransaction(await f.evidence(), rows, async (records, journal) => {
          await records.update(change());
          await journal.commit(receipt(), audit);
        });
        if (transition === 'membership ID') {
          await f.revoke();
          await f.maintenance((admin) => admin.putMembership({ ...f.grant, membershipId: 'replacement-grant' }));
        }
        if (transition === 'membership revision' || transition === 'roles')
          await f.maintenance((admin) =>
            admin.putMembership({ ...f.grant, roles: transition === 'roles' ? ['reviewer'] : ['editor'], expectedVersion: '1' }),
          );
        if (transition === 'tenant revision')
          await f.maintenance((admin) => admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: '1' }));
        const evidence = await f.evidence('north', 'alice', transition === 'deployment' ? 'deployment-2' : 'deployment-1');
        assert.deepEqual(plain(await source.commandTransaction(evidence, rows, (_records, journal) => journal.find(scope()))), receipt());
        assert.equal(await f.quantity(), 1);
        assert.deepEqual(await f.counts(), [1, 1]);
        const provenance = await f.engine.get(
          `SELECT membership_id,membership_version,realm_version,roles_json,deployment FROM ${auditRows(dialect)} a`,
        );
        assert.deepEqual(
          plain(provenance),
          {
            membership_id: 'north-alice',
            membership_version: '1',
            realm_version: '1',
            roles_json: '["editor"]',
            deployment: 'deployment-1',
          },
          'replay retains execution-time provenance, not current admission',
        );
      });
    }

    test('current revoked membership refuses before callback or receipt lookup', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        evidence = await f.evidence();
      await source.commandTransaction(evidence, rows, (_records, journal) => journal.commit(receipt(), audit));
      await f.revoke();
      let entered = false;
      await assert.rejects(
        source.commandTransaction(evidence, rows, (_records, journal) => {
          entered = true;
          return journal.find(scope());
        }),
        safe('not_applied'),
      );
      assert.equal(entered, false);
      assert.deepEqual(await f.counts(), [1, 1]);
    });

    for (const state of ['missing', 'v1'] as const) {
      test(`${state} journal refuses command callback with no implicit schema upgrade`, async (t) => {
        const f = await fixture(t, dialect, state),
          source = await f.open();
        let entered = false;
        assert.equal(
          await source.transaction(await f.evidence(), rows, (records) => records.count('item')),
          1,
          'ordinary transactions do not require a journal',
        );
        const before = await f.engine.layout('__mistri_command_');
        await assert.rejects(
          source.commandTransaction(await f.evidence(), rows, () => {
            entered = true;
          }),
          safe('not_applied'),
        );
        assert.equal(entered, false);
        assert.equal(await f.quantity(), 0);
        assert.deepEqual(await f.engine.layout('__mistri_command_'), before);
        if (state === 'v1') await assert.rejects(f.engine.migrateCommandJournal());
        await assert.rejects(
          source.transaction(await f.evidence(), rows, (records) => records.count('item')),
          safe('not_applied'),
          'pre-entry command refusal conservatively retires the pinned source',
        );
      });
    }

    for (const [name, extra] of [
      ['other App', { appId: 'foreign-app' }],
      ['other actor', { actorId: 'bob' }],
      ['supplied tenant', { tenantId: 'south' }],
      ['supplied store', { storeId: 'other-store' }],
      ['supplied source', { sourceId: 'other-source' }],
      ['supplied membership', { membershipId: 'forged' }],
      ['supplied provenance', { tenant: { tenantId: 'south' } }],
    ] as const) {
      test(`${name} cannot redirect find/commit provenance and caught refusal rolls back prior work`, async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open();
        for (const method of ['find', 'commit'] as const) {
          let rejected = false;
          await assert.rejects(
            source.commandTransaction(await f.evidence(), rows, async (records, journal) => {
              await records.update(change());
              try {
                if (method === 'find') await journal.find({ ...scope(), ...extra });
                else await journal.commit({ ...receipt(), ...extra }, audit);
              } catch {
                rejected = true;
              }
            }),
            safe('not_applied'),
          );
          assert.equal(rejected, true);
          assert.equal(await f.quantity(), 0);
          assert.deepEqual(await f.counts(), [0, 0]);
        }
      });
    }

    for (const table of [tables.receipt, TENANT_TABLES.membership, ...(postgres ? [`public.${tables.receipt}`] : [])]) {
      test(`business records cannot read reserved ${table}, even with an already accepted receipt`, async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open();
        let denied = false;
        await assert.rejects(
          source.commandTransaction(await f.evidence(), rows, async (records, journal) => {
            await records.update(change());
            await journal.commit(receipt(), audit);
            try {
              await records.count(table);
            } catch {
              denied = true;
            }
          }),
          safe('not_applied'),
        );
        assert.equal(denied, true);
        assert.equal(await f.quantity(), 0);
        assert.deepEqual(await f.counts(), [0, 0]);
      });
    }

    test('callback native transaction uncertainty survives confirmed outer rollback and retires the source', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      await assert.rejects(
        source.commandTransaction(await f.evidence(), rows, async (records, journal) => {
          await records.update(change());
          await journal.commit(receipt(), audit);
          throw new TransactionOutcomeUnknown(new Error('PRIVATE_SENTINEL'));
        }),
        safe('unknown'),
      );
      assert.equal(await f.quantity(), 0);
      assert.deepEqual(await f.counts(), [0, 0]);
      await assert.rejects(
        source.commandTransaction(await f.evidence(), rows, () => 'must not reopen'),
        safe('not_applied'),
      );
    });

    for (const shape of ['invalid JSON', 'extra audit provenance', 'getter', 'proxy'] as const) {
      test(`caught ${shape} journal failure poisons later records and rolls back all earlier effects`, async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open();
        let caught = false,
          later = false,
          traps = 0;
        const bad = receipt('north', 'bad');
        if (shape === 'invalid JSON') bad.resultJson = '{';
        if (shape === 'getter')
          Object.defineProperty(bad, 'fingerprint', {
            enumerable: true,
            get() {
              traps++;
              return 'forged';
            },
          });
        const input =
          shape === 'proxy'
            ? new Proxy(bad, {
                ownKeys(target) {
                  traps++;
                  return Reflect.ownKeys(target);
                },
              })
            : bad;
        await assert.rejects(
          source.commandTransaction(await f.evidence(), rows, async (records, journal) => {
            await records.update(change());
            await journal.commit(receipt(), audit);
            try {
              await journal.commit(input, shape === 'extra audit provenance' ? ({ ...audit, tenantId: 'south' } as typeof audit) : audit);
            } catch {
              caught = true;
            }
            try {
              await records.update(change('north', 2));
            } catch {
              later = true;
            }
          }),
          safe('not_applied'),
        );
        assert.equal(caught, true);
        assert.equal(later, true);
        assert.equal(traps, 0);
        assert.equal(await f.quantity(), 0);
        assert.deepEqual(await f.counts(), [0, 0]);
      });
    }

    test('accepted unawaited record and journal work drains and captures receipt/audit arguments before returning', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        input = receipt(),
        details = { ...audit };
      let pending: Promise<void> | undefined;
      await source.commandTransaction(await f.evidence(), rows, (records, journal) => {
        void records.update(change());
        pending = journal.commit(input, details);
        input.resultJson = '{"forged":true}';
        input.actorId = 'bob';
        details.changesJson = '[]';
        return { accepted: true };
      });
      await pending;
      assert.equal(await f.quantity(), 1);
      assert.deepEqual(await f.counts(), [1, 1]);
      assert.deepEqual(
        plain(await source.commandTransaction(await f.evidence(), rows, (_records, journal) => journal.find(scope()))),
        receipt(),
      );
      assert.equal((await f.engine.get(`SELECT changes_json FROM ${auditRows(dialect)} a`))!.changes_json, audit.changesJson);
    });

    test('accepted unawaited malformed journal operation is drained even when its rejection is consumed', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      let observed = false;
      await assert.rejects(
        source.commandTransaction(await f.evidence(), rows, async (records, journal) => {
          await records.update(change());
          void journal.commit({ ...receipt(), resultJson: '{' }, audit).catch(() => {
            observed = true;
          });
          return 'must not deliver';
        }),
        safe('not_applied'),
      );
      assert.equal(observed, true);
      assert.equal(await f.quantity(), 0);
      assert.deepEqual(await f.counts(), [0, 0]);
    });

    test('retained journal and record methods cannot join a later ordinary transaction', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      let retained!: CommandJournal, oldRecords!: WriteTransaction;
      await source.commandTransaction(await f.evidence(), rows, (records, journal) => {
        retained = journal;
        oldRecords = records;
      });
      let denied = 0;
      await source.transaction(await f.evidence(), rows, async (records) => {
        try {
          await retained.find(scope());
        } catch {
          denied++;
        }
        try {
          await retained.commit(receipt(), audit);
        } catch {
          denied++;
        }
        try {
          await oldRecords.update(change('north', 2));
        } catch {
          denied++;
        }
        await records.update(change());
      });
      assert.equal(denied, 3);
      assert.equal(await f.quantity(), 1);
      assert.deepEqual(await f.counts(), [0, 0]);
    });

    for (const guard of ['expiry', 'assertActive'] as const) {
      test(`${guard} between business work and journal lookup refuses before receipt SELECT and rolls back`, async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(),
          evidence = await f.evidence();
        let active = true;
        const lookups = f.engine.intercept(t, {
          match: (statement) => statement.sql.includes('SELECT r.id') && statement.sql.includes(tables.receipt),
        });
        try {
          await assert.rejects(
            source.commandTransaction(
              evidence,
              rows,
              async (records, journal) => {
                await records.update(change());
                if (guard === 'expiry') f.setTime(6000);
                else active = false;
                await journal.find(scope());
              },
              () => {
                if (!active) throw new Error('PRIVATE_SENTINEL');
              },
            ),
            safe('not_applied'),
          );
        } finally {
          lookups.restore();
        }
        assert.equal(lookups.calls, 0);
        assert.equal(await f.quantity(), 0);
        assert.deepEqual(await f.counts(), [0, 0]);
      });
    }

    test(
      postgres
        ? 'the command writer fence holds an independent revocation until business and journal commit together'
        : 'the actual command writer fence blocks independent revocation until business and journal commit together',
      async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(),
          evidence = await f.evidence();
        if (postgres) {
          const session = await f.engine.session();
          let revoking: Promise<unknown> | undefined;
          await source.commandTransaction(evidence, rows, async (records, journal) => {
            await records.update(change());
            revoking = session.query(revokeRaw);
            assert.equal(await settles(revoking), false, 'the revocation waits for the business commit');
            await journal.commit(receipt(), audit);
          });
          await revoking;
        } else {
          let blocked: unknown;
          await source.commandTransaction(evidence, rows, async (records, journal) => {
            await records.update(change());
            try {
              f.engine.sqlite().prepare(revokeRaw).run();
            } catch (error) {
              blocked = error;
            }
            await journal.commit(receipt(), audit);
          });
          assert.ok(blocked instanceof Error);
          assert.match(blocked.message, /locked/);
        }
        assert.equal(await f.quantity(), 1);
        assert.deepEqual(await f.counts(), [1, 1]);
        if (!postgres) await f.revoke();
        let entered = false;
        await assert.rejects(
          source.commandTransaction(evidence, rows, () => {
            entered = true;
          }),
          safe('not_applied'),
        );
        assert.equal(entered, false);
        assert.equal(await f.quantity(), 1);
        assert.deepEqual(await f.counts(), [1, 1]);
      },
    );

    test('revocation winning before queued command writer acquisition refuses callback and receipt lookup', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        evidence = await f.evidence();
      let entered = false;
      if (postgres) {
        const session = await f.engine.session();
        await session.query('BEGIN');
        await session.query(`SELECT 1 FROM "${TENANT_TABLES.tenant}" WHERE id = 'north' FOR UPDATE`);
        await session.query(revokeRaw);
        const rejected = assert.rejects(
          source.commandTransaction(evidence, rows, (_records, journal) => {
            entered = true;
            return journal.find(scope());
          }),
          safe('not_applied'),
        );
        await delay(100);
        await session.query('COMMIT');
        await rejected;
      } else {
        const pending = source.commandTransaction(evidence, rows, (_records, journal) => {
          entered = true;
          return journal.find(scope());
        });
        const rejected = assert.rejects(pending, safe('not_applied'));
        f.engine.sqlite().prepare(revokeRaw).run();
        await rejected;
      }
      assert.equal(entered, false);
      assert.equal(await f.quantity(), 0);
      assert.deepEqual(await f.counts(), [0, 0]);
    });

    for (const boundary of ['COMMIT', 'ROLLBACK'] as const) {
      for (const executed of [false, true]) {
        test(`native ${boundary} ${executed ? 'lost acknowledgment' : 'before execution'} preserves unknown and cannot reopen the failed source`, async (t) => {
          const f = await fixture(t, dialect),
            source = await f.open(),
            evidence = await f.evidence();
          const fault = f.engine.intercept(t, {
            match: (statement) => statement.writer && statement.sql === boundary,
            fault: executed ? 'after' : 'before',
          });
          try {
            await assert.rejects(
              source.commandTransaction(evidence, rows, async (records, journal) => {
                await records.update(change());
                await journal.commit(receipt(), audit);
                if (boundary === 'ROLLBACK') throw new Error('PRIVATE_SENTINEL');
              }),
              safe('unknown'),
            );
          } finally {
            fault.restore();
          }
          assert.equal(fault.calls, 1);
          const landed = boundary === 'COMMIT' && executed;
          assert.equal(await f.quantity(), landed ? 1 : 0);
          assert.deepEqual(await f.counts(), landed ? [1, 1] : [0, 0]);
          await assert.rejects(
            source.commandTransaction(evidence, rows, () => 'must not reopen'),
            safe('not_applied'),
          );
          await assert.rejects(
            source.transaction(evidence, rows, (records) => records.count('item')),
            safe('not_applied'),
          );
        });
      }
    }

    test('postcommit assertActive failure retains unknown while business, receipt and audit are durably present', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        evidence = await f.evidence();
      let committed = false;
      const commits = f.engine.intercept(t, {
        match: (statement) => statement.writer && statement.sql === 'COMMIT',
        after: () => {
          committed = true;
        },
      });
      try {
        await assert.rejects(
          source.commandTransaction(
            evidence,
            rows,
            async (records, journal) => {
              await records.update(change());
              await journal.commit(receipt(), audit);
            },
            () => {
              if (committed) throw new Error('PRIVATE_SENTINEL');
            },
          ),
          safe('unknown'),
        );
      } finally {
        commits.restore();
      }
      assert.equal(await f.quantity(), 1);
      assert.deepEqual(await f.counts(), [1, 1]);
    });

    test('close stops admission and drains an accepted command callback before releasing its pinned writer', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        evidence = await f.evidence(),
        entered = gate(),
        release = gate();
      let closed = false;
      const running = assert.rejects(
        source.commandTransaction(evidence, rows, async (records, journal) => {
          await records.update(change());
          await journal.commit(receipt(), audit);
          entered.release();
          await release.promise;
        }),
        safe('not_applied'),
      );
      await entered.promise;
      const closing = source.close();
      void closing.then(() => {
        closed = true;
      });
      try {
        assert.equal(source.close(), closing);
        await assert.rejects(
          source.commandTransaction(evidence, rows, () => 'must not enter'),
          safe('not_applied'),
        );
        assert.equal(closed, false);
      } finally {
        release.release();
      }
      await running;
      await closing;
      assert.equal(closed, true);
      assert.equal(await f.quantity(), 0);
      assert.deepEqual(await f.counts(), [0, 0]);
    });
  });
