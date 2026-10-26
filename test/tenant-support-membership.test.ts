/** Pending native support facts, not support admission or fabricated auth proof. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { PgQuery, PgResult } from '../packages/engine/src/adapters/postgresPool.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { readSqliteTenantMembershipsSnapshot, TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { readPostgresTenantMemberships } from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import {
  assertSupportObservationCurrent,
  captureSupportLookup,
  supportMembershipObservation,
  type SupportMembershipLookup,
} from '../packages/mistri/src/server/tenant/tenantSupportMembership.js';
import { observeSqliteSupportMembership } from '../packages/mistri/src/server/tenant/tenantSupportMembershipSqlite.js';
import { observePostgresSupportMembership } from '../packages/mistri/src/server/tenant/tenantSupportMembershipPostgres.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantEngine } from './support/tenantDialects.js';

const owner = { appId: 'support-facts', storeId: 'owned-store', source: { id: 'business', connection: 'owned-business' } };
const lookup = { supportId: 'support', accountId: 'operator', tenantId: 'north', at: 100 };
const tenant = (id: string, kind: string) => ({ id, kind, status: 'active', version: '1' });
const parent = () => ({
  id: 'parent',
  tenant_id: '@platform',
  account_id: 'operator',
  status: 'active',
  kind: 'member',
  version: '3',
  roles_json: '["platform_ops"]',
  valid_until: 1000,
  parent_id: null,
  parent_version: null,
  platform_version: null,
});
const support = () => ({
  ...parent(),
  id: 'support',
  tenant_id: 'north',
  kind: 'support',
  version: '2',
  roles_json: '["dealer_reader"]',
  valid_until: 900,
  parent_id: 'parent',
  parent_version: '3',
  platform_version: '1',
});

test('pure: support observation captures immutable facts and compares exact non-authority state', () => {
  const row = support();
  const observed = supportMembershipObservation(
    owner,
    lookup,
    row,
    parent(),
    tenant('@platform', 'platform'),
    tenant('north', 'tenant'),
    'parent',
  );
  assert.equal(observed.stage, 'support-membership-observation');
  assert.equal(observed.authorization, 'pending');
  assert.deepEqual(observed.roles, ['dealer_reader']);
  assert.equal(observed.validUntil, 900);
  assert.ok(Object.isFrozen(observed));
  assert.ok(Object.isFrozen(observed.roles));
  assert.ok(Object.isFrozen(observed.binding.source));
  row.roles_json = '["changed"]';
  assert.deepEqual(observed.roles, ['dealer_reader']);
  assertSupportObservationCurrent(observed, { ...observed, observedAt: 101 }, 102);
  for (const changed of [
    { ...observed, parentVersion: '4' },
    { ...observed, roles: ['platform_ops'] },
    { ...observed, observedAt: 99 },
    { ...observed, validUntil: 901 },
  ]) {
    assert.throws(() => assertSupportObservationCurrent(observed, changed, 102), TenantContextError);
  }
  assert.throws(() => assertSupportObservationCurrent(observed, observed, 900), TenantContextError);
  assert.throws(() => assertSupportObservationCurrent(observed, observed, 99), TenantContextError);
});

test('pure: support capture refuses getters, proxies, malformed clocks and scalar aliases without executing hooks', async () => {
  let called = 0;
  const get = () => {
    called++;
    throw new Error('must not execute');
  };
  for (const input of [
    new Proxy(lookup, { get }),
    Object.defineProperty({}, 'supportId', { enumerable: true, get }),
    { ...lookup, at: NaN },
    { ...lookup, tenantId: '@platform' },
    { ...lookup, supportId: '\ud800' },
  ]) {
    assert.throws(() => captureSupportLookup(input as SupportMembershipLookup), TenantContextError);
  }
  await assert.rejects(
    observePostgresSupportMembership(Object.defineProperty({}, 'query', { get }) as PgQuery, owner, lookup),
    TenantContextError,
  );
  await assert.rejects(observePostgresSupportMembership(new Proxy({} as PgQuery, { get }), owner, lookup), TenantContextError);
  assert.equal(called, 0);
});

test('pure: native time decoding refuses rounded or noncanonical integer text', () => {
  const observe = (valid_until: unknown) =>
    supportMembershipObservation(
      owner,
      lookup,
      { ...support(), valid_until },
      parent(),
      tenant('@platform', 'platform'),
      tenant('north', 'tenant'),
      'parent',
    );
  assert.equal(observe('9007199254740991').supportValidUntil, Number.MAX_SAFE_INTEGER);
  for (const value of ['9007199254740992', '9e2', '0900', '900.0', Infinity, NaN, -1, 100]) {
    assert.throws(() => observe(value), TenantContextError);
  }
});

const setup = {
  sqlite: 'CREATE TABLE db_item(id TEXT PRIMARY KEY)',
  postgres: 'CREATE TABLE public.db_item(id text PRIMARY KEY)',
  tables: ['db_item'],
};
for (const { dialect, skip } of TENANT_DIALECTS)
  test(`${dialect}: native support linked observation and lifetime`, { skip }, async (t) => {
    // Its own PostgreSQL database: the matrix's shared one is reset by every
    // suite that opens it, which a concurrent run must not do under this one.
    const database = `support_membership_${randomUUID().replaceAll('-', '')}`;
    let engine: TenantEngine | undefined;
    t.after(async () => {
      try {
        await engine?.close();
      } finally {
        if (dialect === 'postgres') await dropDedicatedPostgresDatabase(database);
      }
    });
    engine = await openTenantEngine(dialect, { ...setup, database });
    const control = engine;
    await control.provisionStore(owner);
    const tenants = `"${TENANT_TABLES.tenant}"`,
      members = `"${TENANT_TABLES.membership}"`;
    await control.exec(`INSERT INTO ${tenants}(id,status,version,kind) VALUES('@platform','active','1','platform'),('north','active','1','tenant'),
    ('south','active','1','tenant'),('east','active','1','tenant')`);
    // `east-member` is the operator's one ordinary membership: discovery must
    // list it and nothing the support row names.
    await control.exec(`INSERT INTO ${members}(id,tenant_id,account_id,status,version,roles_json,valid_until,kind,parent_id,parent_version,platform_version)
    VALUES('parent','@platform','operator','active','3','["platform_ops"]',1000,'member',NULL,NULL,NULL),
    ('support','north','operator','active','2','["dealer_reader"]',900,'support','parent','3','1'),
    ('east-member','east','operator','active','1','["east_reader"]',1000,'member',NULL,NULL,NULL)`);
    const client = dialect === 'postgres' ? await control.session() : undefined;
    const sql = async (text: string) => {
      if (client) await client.query(text);
      else control.sqlite().exec(text);
    };
    const observe = (requested = lookup) =>
      client
        ? observePostgresSupportMembership(client, owner, requested)
        : Promise.resolve(observeSqliteSupportMembership(control.sqlite(), owner, requested));
    const transaction = async (work: () => Promise<void>) => {
      await sql(dialect === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
      try {
        await work();
      } finally {
        await sql('ROLLBACK');
      }
    };
    await t.test('native autocommit refuses; actual transaction returns only exact pending data', async () => {
      await assert.rejects(async () => await observe(), TenantContextError);
      await transaction(async () => {
        const observed = await observe();
        assert.deepEqual(observed.roles, ['dealer_reader']);
        assert.equal(observed.parentVersion, '3');
        assert.equal(observed.supportVersion, '2');
        assert.equal(observed.validUntil, 900);
        assert.equal(observed.authorization, 'pending');
        assertSupportObservationCurrent(observed, await observe({ ...lookup, at: 101 }), 101);
        const mutable = { ...lookup },
          pending = observe(mutable);
        mutable.accountId = 'replaced-after-call';
        assert.equal((await pending).accountId, 'operator');
        for (const wrong of [
          { ...owner, storeId: 'another-store' },
          { ...owner, appId: 'another-app' },
          { ...owner, source: { ...owner.source, id: 'another_source' } },
        ]) {
          await assert.rejects(async () => {
            if (client) await observePostgresSupportMembership(client, wrong, lookup);
            else observeSqliteSupportMembership(control.sqlite(), wrong, lookup);
          }, TenantContextError);
        }
      });
      await assert.rejects(async () => await observe(), TenantContextError);
    });
    await t.test('ordinary admission and discovery never return the support row', async () => {
      assert.equal(
        await control.readMembership(owner, {
          appId: owner.appId,
          accountId: lookup.accountId,
          tenantId: 'north',
          source: owner.source,
          deployment: 'ordinary-discovery',
        }),
        null,
        'ordinary admission must not see support rows',
      );
      const account = { appId: owner.appId, accountId: lookup.accountId, source: owner.source, deployment: 'ordinary-discovery' };
      await transaction(async () => {
        const listed = client
          ? await readPostgresTenantMemberships(client, owner, account, () => 100)
          : readSqliteTenantMembershipsSnapshot(control.sqlite(), owner, account, () => 100);
        assert.deepEqual(
          listed.map((record) => [record.tenantId, record.membershipId]),
          [['east', 'east-member']],
        );
      });
    });
    await t.test('native kinds, linkage, identity, revisions, expiry and roles refuse', async () => {
      const changes = [
        `UPDATE ${members} SET account_id='other' WHERE id='support'`,
        `UPDATE ${members} SET tenant_id='south' WHERE id='support'`,
        `UPDATE ${members} SET status='revoked' WHERE id='support'`,
        `UPDATE ${members} SET kind='member',parent_id=NULL,parent_version=NULL,platform_version=NULL WHERE id='support'`,
        `UPDATE ${members} SET parent_id='east-member',parent_version='1' WHERE id='support'`,
        `UPDATE ${members} SET parent_version='4' WHERE id='support'`,
        `UPDATE ${members} SET platform_version='2' WHERE id='support'`,
        `UPDATE ${members} SET account_id='other' WHERE id='parent'`,
        `UPDATE ${members} SET tenant_id='south' WHERE id='parent'`,
        `UPDATE ${members} SET status='revoked' WHERE id='parent'`,
        `UPDATE ${members} SET status='invited' WHERE id='parent'`,
        `UPDATE ${members} SET version='4' WHERE id='parent'`,
        `UPDATE ${tenants} SET status='suspended' WHERE id='@platform'`,
        `UPDATE ${tenants} SET version='2' WHERE id='@platform'`,
        `UPDATE ${tenants} SET status='suspended' WHERE id='north'`,
        `UPDATE ${tenants} SET status='closed' WHERE id='north'`,
        `UPDATE ${members} SET valid_until=100 WHERE id='support'`,
        `UPDATE ${members} SET valid_until=100 WHERE id='parent'`,
        `UPDATE ${members} SET roles_json='[1]' WHERE id='support'`,
        `UPDATE ${members} SET roles_json='[]' WHERE id='support'`,
        `UPDATE ${members} SET roles_json='["reader","reader"]' WHERE id='support'`,
        `UPDATE ${members} SET roles_json='[1]' WHERE id='parent'`,
        // SQLite's INTEGER affinity keeps a fractional value, which its CHECK
        // allows; PostgreSQL's bigint column cannot hold one at all.
        ...(dialect === 'sqlite'
          ? [`UPDATE ${members} SET valid_until=900.5 WHERE id='support'`, `UPDATE ${members} SET valid_until=1000.5 WHERE id='parent'`]
          : []),
      ];
      for (const change of changes)
        await transaction(async () => {
          await sql(change);
          await assert.rejects(async () => await observe(), TenantContextError, change);
        });
      await transaction(async () => {
        for (const requested of [
          { ...lookup, accountId: 'other' },
          { ...lookup, tenantId: 'south' },
          { ...lookup, supportId: 'missing' },
          { ...lookup, supportId: 'parent' },
          { ...lookup, supportId: 'east-member', tenantId: 'east' },
          { ...lookup, at: 900 },
        ]) {
          await assert.rejects(async () => await observe(requested), TenantContextError);
        }
      });
    });
    await t.test('captured dealer, support, role and expiry drift fails the pure comparison', async () => {
      const drifts = [
        `UPDATE ${tenants} SET version='2' WHERE id='north'`,
        `UPDATE ${members} SET version='3' WHERE id='support'`,
        `UPDATE ${members} SET roles_json='["dealer_writer"]' WHERE id='support'`,
        `UPDATE ${members} SET roles_json='["dealer_reader","dealer_writer"]' WHERE id='support'`,
        `UPDATE ${members} SET valid_until=800 WHERE id='support'`,
        `UPDATE ${members} SET valid_until=850 WHERE id='parent'`,
        `UPDATE ${members} SET roles_json='["platform_ops","other_ops"]' WHERE id='parent'`,
      ];
      for (const drift of drifts)
        await transaction(async () => {
          const before = await observe();
          await sql(drift);
          const after = await observe({ ...lookup, at: 101 });
          // Parent grants are validated, never carried into the support roles: the
          // parent's version is their fence, since maintenance bumps it on any change.
          if (drift.includes('platform_ops')) assertSupportObservationCurrent(before, after, 101);
          else assert.throws(() => assertSupportObservationCurrent(before, after, 101), TenantContextError, drift);
        });
    });
    if (!client) {
      await t.test('only the genuine native handle may state its transaction', async () => {
        const db = control.sqlite();
        await transaction(async () => {
          const forged = [
            Object.create(db) as DatabaseSync,
            { isTransaction: true, prepare: db.prepare.bind(db) } as unknown as DatabaseSync,
            Object.defineProperty(Object.create(DatabaseSync.prototype), 'isTransaction', { get: () => true }) as DatabaseSync,
            new Proxy(db, {}),
          ];
          for (const handle of forged) assert.throws(() => observeSqliteSupportMembership(handle, owner, lookup), TenantContextError);
          const prepare = db.prepare.bind(db);
          Object.defineProperty(db, 'prepare', { value: prepare, configurable: true });
          try {
            assert.throws(() => observeSqliteSupportMembership(db, owner, lookup), TenantContextError);
          } finally {
            delete (db as unknown as { prepare?: unknown }).prepare;
          }
          assert.equal(observeSqliteSupportMembership(db, owner, lookup).supportId, 'support');
        });
      });
    }
    if (client) {
      await t.test('native row lock order is platform, parent, dealer, support; read-only row locking refuses', async () => {
        const locked: string[] = [];
        function query(text: string, args?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
        function query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
        function query(input: string | { text: string; values?: unknown[]; rowMode?: string }, args?: unknown[]) {
          if (typeof input === 'string' && input.includes('FOR SHARE')) locked.push(String(args![0]));
          return typeof input === 'string' ? client!.query(input, args) : client!.query(input);
        }
        // A transparent real-client forwarder, not node:test's proxy function,
        // which the production leaf deliberately refuses as a query capability.
        await transaction(async () => {
          await observePostgresSupportMembership({ query }, owner, lookup);
        });
        assert.deepEqual(locked, ['@platform', 'parent', 'north', 'support']);
        await sql('BEGIN READ ONLY');
        try {
          await assert.rejects(observe(), TenantContextError);
        } finally {
          await sql('ROLLBACK');
        }
      });
      const competitor = await control.session();
      const pid = async (session: PgQuery) => (await session.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const [observerPid, competitorPid] = [await pid(client), await pid(competitor)];
      const waitsOnLock = async (backend: unknown) => {
        for (let i = 0; i < 200; i++) {
          if (Number((await control.get('SELECT cardinality(pg_blocking_pids(?)) AS n', [backend]))?.n) > 0) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.fail('the statement never waited on a row lock');
      };
      // Every fenced row, as the maintenance that would revoke it writes it.
      const revocations = [
        {
          row: '@platform',
          apply: `UPDATE ${tenants} SET status='suspended',version='2' WHERE id='@platform'`,
          undo: `UPDATE ${tenants} SET status='active',version='1' WHERE id='@platform'`,
        },
        {
          row: 'parent',
          apply: `UPDATE ${members} SET status='revoked',version='4' WHERE id='parent'`,
          undo: `UPDATE ${members} SET status='active',version='3' WHERE id='parent'`,
        },
        {
          row: 'north',
          apply: `UPDATE ${tenants} SET status='suspended',version='2' WHERE id='north'`,
          undo: `UPDATE ${tenants} SET status='active',version='1' WHERE id='north'`,
        },
        {
          row: 'support',
          apply: `UPDATE ${members} SET status='revoked',version='3' WHERE id='support'`,
          undo: `UPDATE ${members} SET status='active',version='2' WHERE id='support'`,
        },
      ];
      await t.test('a held observation fences every linked row: each revocation waits for it', async () => {
        for (const { row, apply } of revocations) {
          await sql('BEGIN');
          let pending: Promise<unknown> | undefined;
          try {
            await observe();
            await competitor.query('BEGIN');
            pending = competitor.query(apply);
            void pending.catch(() => {});
            await waitsOnLock(competitorPid);
          } finally {
            await sql('ROLLBACK');
            await pending;
            await competitor.query('ROLLBACK');
          }
          assert.ok(pending, row);
        }
        await transaction(async () => {
          await observe();
        });
      });
      await t.test('an in-flight revocation first: the observation waits, reads it, and refuses without retrying', async () => {
        for (const { row, apply, undo } of revocations) {
          await competitor.query('BEGIN');
          let committed = false;
          try {
            await competitor.query(apply);
            await transaction(async () => {
              const pending = observe();
              void pending.catch(() => {});
              await waitsOnLock(observerPid);
              await competitor.query('COMMIT');
              committed = true;
              await assert.rejects(pending, TenantContextError, row);
            });
          } finally {
            if (!committed) await competitor.query('ROLLBACK');
            else await control.exec(undo);
          }
        }
        await transaction(async () => {
          await observe();
        });
      });
    }
  });
