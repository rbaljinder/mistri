/** Every database and role this file touches is UUID-owned. A required live
 * run fails if TABLEWALK_TEST_PG is absent; it never silently passes a skip. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { normalizeFlagCatalog, type FlagScope } from '../packages/mistri/src/shared/appFlags.js';
import { captureFlagRequest } from '../packages/mistri/src/server/flags/provider.js';
import { captureComposedFlagRequest } from '../packages/mistri/src/server/flags/request.js';
import { createFlagManagement } from '../packages/mistri/src/server/flags/management.js';
import {
  createFlagStoreProvider,
  FlagManagementDenied,
  FlagRevisionConflict,
  FlagStoreUnavailable,
  type FlagStore,
} from '../packages/mistri/src/server/flags/store.js';
import {
  openPostgresFlagStore,
  provisionPostgresFlagStore,
  type PostgresFlagStoreOptions,
} from '../packages/mistri/src/server/flags/storePostgres.js';
import { liveSkip } from './live.js';

interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
async function connect(url: string): Promise<PgClient> {
  const module = 'pg';
  const pg = (await import(module)) as { Client: new (options: unknown) => PgClient };
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
}
const catalog = normalizeFlagCatalog({
  flags: {
    feature: { type: 'boolean', default: false, owner: 'product', tenantManaged: true },
    other: { type: 'boolean', default: false, owner: 'security', tenantManaged: true },
  },
  roles: ['staff'],
  audiences: { staff: { roles: ['staff'] } },
});
const binding = { suiteId: 'suite', deploymentId: 'deployment' };
const base: FlagScope = { appId: 'leads', environment: 'production', tenantId: null };
const authorize = () => ({ actorId: 'subject-1', reobserve() {} });

test(
  'PostgreSQL flag control ownership, audited CAS and authority fences',
  {
    skip: liveSkip('postgres', process.env.TABLEWALK_TEST_PG),
    timeout: 120_000,
  },
  async (t) => {
    const admin = await connect(process.env.TABLEWALK_TEST_PG!);
    const suffix = randomUUID().replaceAll('-', ''),
      role = `tw_flag_role_${suffix}`;
    const password = randomUUID();
    const databases: string[] = [],
      controls: PgClient[] = [],
      stores: FlagStore[] = [];
    let roleCreated = false;
    t.after(async () => {
      try {
        await Promise.all(stores.map((store) => store.close()));
        await Promise.all(controls.map((client) => client.end()));
        for (const name of databases) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        if (roleCreated) await admin.query(`DROP ROLE "${role}"`);
      } finally {
        await admin.end();
      }
    });
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    roleCreated = true;
    const database = async (label: string) => {
      const name = `tw_flag_${label}_${suffix}`;
      await admin.query(`CREATE DATABASE "${name}" OWNER "${role}" TEMPLATE template0`);
      databases.push(name);
      const url = new URL(process.env.TABLEWALK_TEST_PG!);
      url.pathname = `/${name}`;
      url.username = role;
      url.password = password;
      url.searchParams.delete('user');
      url.searchParams.delete('password');
      url.searchParams.delete('dbname');
      url.searchParams.delete('database');
      return { url: url.href, binding };
    };
    const options = await database('control');
    const control = await connect(options.url);
    controls.push(control);
    let store: FlagStore;

    await t.test('explicit provisioning refuses business/native layouts and mismatched ownership', async () => {
      await assert.rejects(openPostgresFlagStore(options));
      const busy = await database('busy'),
        client = await connect(busy.url);
      controls.push(client);
      await client.query('CREATE TABLE public.business (id integer)');
      await assert.rejects(provisionPostgresFlagStore(busy), FlagStoreUnavailable);
      assert.equal((await client.query("SELECT to_regnamespace('mistri') AS namespace")).rows[0].namespace, null);
      await client.query('DROP TABLE public.business; CREATE SCHEMA pgforeign');
      await assert.rejects(provisionPostgresFlagStore(busy), FlagStoreUnavailable, 'pg-like business namespaces are not system namespaces');
      await client.query('DROP SCHEMA pgforeign; CREATE TABLE public.native_auth (id integer)');
      await assert.rejects(provisionPostgresFlagStore(busy), FlagStoreUnavailable);
      await provisionPostgresFlagStore(options);
      await assert.rejects(provisionPostgresFlagStore(options), FlagStoreUnavailable);
      await assert.rejects(openPostgresFlagStore({ ...options, binding: { ...binding, suiteId: 'other' } }), FlagStoreUnavailable);
      await assert.rejects(openPostgresFlagStore({ ...options, binding: { ...binding, deploymentId: 'other' } }), FlagStoreUnavailable);
      store = await openPostgresFlagStore(options);
      stores.push(store);
      assert.equal((await store.read(base, catalog)).revision, 0);
    });

    await t.test('URL-only APIs reject caller transactions without committing, rolling back or closing them', async () => {
      await control.query('BEGIN');
      await control.query('CREATE TEMP TABLE caller_owned (id integer) ON COMMIT DROP');
      await control.query('INSERT INTO caller_owned VALUES (17)');
      await assert.rejects(provisionPostgresFlagStore(control as unknown as PostgresFlagStoreOptions));
      await assert.rejects(openPostgresFlagStore({ ...options, client: control } as PostgresFlagStoreOptions));
      assert.equal((await control.query('SELECT id FROM caller_owned')).rows[0].id, 17);
      await control.query('ROLLBACK');
      assert.equal((await control.query("SELECT to_regclass('pg_temp.caller_owned') AS relation")).rows[0].relation, null);
    });

    await t.test('concurrent whole-scope expected revisions have exactly one winner', async () => {
      const manager = createFlagManagement({ ...base, catalog, store, authorize });
      const common = { tenantId: null, operation: 'set' as const, expectedRevision: 0, override: { value: true }, reason: 'Release' };
      const results = await Promise.allSettled([
        manager.change({ ...common, flagId: 'feature' }),
        manager.change({ ...common, flagId: 'other' }),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      const loser = results.find((result) => result.status === 'rejected');
      assert.ok(loser?.status === 'rejected' && loser.reason instanceof FlagRevisionConflict);
      const snapshot = await store.read(base, catalog);
      assert.equal(snapshot.revision, 1);
      assert.equal(Object.keys(snapshot.overrides).length, 1);
      const feature = await store.history(base, catalog, { flagId: 'feature' });
      const other = await store.history(base, catalog, { flagId: 'other' });
      assert.equal(feature.entries.length + other.entries.length, 1);
    });

    await t.test('equal flag ids never cross App, environment or tenant boundaries', async () => {
      const scopes: FlagScope[] = [
        { ...base, appId: 'dealer' },
        { ...base, environment: 'development' },
        { ...base, tenantId: 'one' },
        { ...base, tenantId: 'two' },
      ];
      for (const scope of scopes) {
        const manager = createFlagManagement({ ...scope, catalog, store, authorize });
        await manager.change({
          tenantId: scope.tenantId,
          flagId: 'feature',
          operation: 'set',
          expectedRevision: 0,
          override: { value: true },
          reason: 'Scoped release',
        });
        const page = await store.history(scope, catalog, { flagId: 'feature' });
        assert.equal(page.entries.length, 1);
        assert.deepEqual(page.entries[0].scope, scope);
        assert.deepEqual(page.entries[0].after.overrides, { feature: { value: true } });
      }
      assert.equal((await store.read({ ...base, tenantId: 'absent' }, catalog)).revision, 0);
      assert.equal((await store.history({ ...base, appId: 'absent' }, catalog, { flagId: 'feature' })).entries.length, 0);
    });

    await t.test('audit INSERT failure rolls back the preceding state UPDATE and creates no history', async () => {
      const scope = { ...base, tenantId: 'one' },
        before = await store.read(scope, catalog);
      await control.query(`REVOKE INSERT ON mistri.flag_audit FROM "${role}"`);
      try {
        const manager = createFlagManagement({ ...scope, catalog, store, authorize });
        await assert.rejects(
          manager.change({
            tenantId: 'one',
            flagId: 'feature',
            operation: 'set',
            expectedRevision: 1,
            override: { value: false },
            reason: 'Must roll back',
          }),
          /permission denied/,
        );
      } finally {
        await control.query(`GRANT INSERT ON mistri.flag_audit TO "${role}"`);
      }
      assert.deepEqual(await store.read(scope, catalog), before);
      assert.equal((await store.history(scope, catalog, { flagId: 'feature' })).entries.length, 1);
    });

    await t.test('revocation at the last observation rolls back state and already-inserted audit', async () => {
      const scope = { ...base, tenantId: 'two' },
        before = await store.read(scope, catalog);
      let observed = 0;
      const manager = createFlagManagement({
        ...scope,
        catalog,
        store,
        authorize: () => ({
          actorId: 'subject-1',
          reobserve() {
            if (++observed === 2) throw new FlagManagementDenied();
          },
        }),
      });
      await assert.rejects(
        manager.change({ tenantId: 'two', flagId: 'feature', operation: 'kill', expectedRevision: 1, reason: 'Revoked' }),
        FlagManagementDenied,
      );
      assert.equal(observed, 2);
      assert.deepEqual(await store.read(scope, catalog), before);
      assert.equal((await store.history(scope, catalog, { flagId: 'feature' })).entries.length, 1);
    });

    await t.test('writer layout locks prevent changing audit triggers after attestation', async () => {
      const scope = { ...base, appId: 'layout-lock' };
      let observed!: () => void,
        release!: () => void,
        observations = 0;
      const ready = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const manager = createFlagManagement({
        ...scope,
        catalog,
        store,
        authorize: () => ({
          actorId: 'subject-1',
          async reobserve() {
            if (++observations === 2) {
              observed();
              await hold;
            }
          },
        }),
      });
      const pending = manager.change({
        tenantId: null,
        flagId: 'feature',
        operation: 'set',
        expectedRevision: 0,
        override: { value: true },
        reason: 'Hold lock',
      });
      await Promise.race([
        ready,
        pending.then(() => {
          throw new Error('Mutation did not reach authority observation.');
        }),
      ]);
      try {
        await control.query("SET lock_timeout='50ms'");
        await assert.rejects(
          control.query('ALTER TABLE mistri.flag_audit DISABLE TRIGGER flag_audit_immutable'),
          (error: unknown) => (error as { code?: string }).code === '55P03',
        );
      } finally {
        release();
        await control.query('RESET lock_timeout');
        await pending;
      }
      assert.equal((await store.read(scope, catalog)).revision, 1);
    });

    await t.test('kill is disable-only; revert writes a new revision; live provider changes only on next request', async () => {
      const scope = { ...base, appId: 'lifecycle' },
        manager = createFlagManagement({ ...scope, catalog, store, authorize });
      const provider = createFlagStoreProvider(store, { ...scope, catalog });
      const read = () => captureFlagRequest({ catalog, scope, context: { identity: { kind: 'subject', id: 'subject-1' } }, provider });
      await manager.change({
        tenantId: null,
        flagId: 'feature',
        operation: 'set',
        expectedRevision: 0,
        override: { value: true, rules: [{ audiences: ['staff'], value: true }] },
        reason: 'Enable',
      });
      const previous = await read();
      assert.equal(previous.evaluate('feature').value, true);
      const kills = createFlagManagement({
        ...scope,
        catalog,
        store,
        authorize: (request) => (request.operation === 'kill' ? authorize() : null),
      });
      await kills.change({ tenantId: null, flagId: 'feature', operation: 'kill', expectedRevision: 1, reason: 'Incident' });
      assert.equal(previous.evaluate('feature').value, true);
      assert.equal((await read()).evaluate('feature').value, false);
      await assert.rejects(
        kills.change({
          tenantId: null,
          flagId: 'feature',
          operation: 'set',
          expectedRevision: 2,
          override: { disabled: false },
          reason: 'Enable',
        }),
        FlagManagementDenied,
      );
      await assert.rejects(
        kills.change({ tenantId: null, flagId: 'feature', operation: 'revert', expectedRevision: 2, revertRevision: 1, reason: 'Enable' }),
        FlagManagementDenied,
      );
      const reverted = await manager.change({
        tenantId: null,
        flagId: 'feature',
        operation: 'revert',
        expectedRevision: 2,
        revertRevision: 1,
        reason: 'Recovered',
      });
      assert.equal(reverted.revision, 3);
      assert.equal(reverted.operation, 'revert');
      assert.equal(
        Object.hasOwn(reverted, 'revertRevision'),
        false,
        'mutation acknowledgements do not reveal history without view authority',
      );
      assert.equal((await store.history(scope, catalog, { flagId: 'feature' })).entries[0].revertRevision, 1);
      assert.equal((await read()).evaluate('feature').value, true);
      assert.deepEqual(
        (await store.history(scope, catalog, { flagId: 'feature' })).entries.map((row) => row.revision),
        [3, 2, 1],
      );
      const defaulted = await manager.change({
        tenantId: null,
        flagId: 'feature',
        operation: 'revert',
        expectedRevision: 3,
        revertRevision: 0,
        reason: 'Use code default',
      });
      assert.equal(defaulted.revision, 4);
      assert.equal(Object.hasOwn(defaulted, 'after'), false);
      assert.equal((await store.read(scope, catalog)).overrides.feature, undefined);
      assert.equal((await read()).evaluate('feature').reason, 'default');
    });

    await t.test('request scopes share one snapshot during a concurrent two-scope transaction', async () => {
      const scope = { ...base, appId: 'paired-read', tenantId: 'north' };
      const selected = [null, 'north'];
      for (const tenantId of selected) {
        const snapshot = { ...scope, tenantId, revision: 0, overrides: { feature: { value: false } } };
        await control.query('INSERT INTO mistri.flag_state VALUES ($1,$2,$3,$4,$5,0,$6)', [
          binding.suiteId,
          binding.deploymentId,
          scope.appId,
          scope.environment,
          tenantId ?? '',
          JSON.stringify(snapshot),
        ]);
      }
      const writer = async () => {
        for (let revision = 1; revision <= 4; revision++) {
          await control.query('BEGIN');
          try {
            for (const tenantId of selected) {
              const snapshot = { ...scope, tenantId, revision, overrides: { feature: { value: revision % 2 === 1 } } };
              await control.query('UPDATE mistri.flag_state SET revision=$1,snapshot=$2 WHERE app_id=$3 AND tenant_key=$4', [
                revision,
                JSON.stringify(snapshot),
                scope.appId,
                tenantId ?? '',
              ]);
            }
            await control.query('COMMIT');
          } catch (error) {
            await control.query('ROLLBACK');
            throw error;
          }
        }
      };
      await Promise.all([
        writer(),
        ...Array.from({ length: 8 }, async () => {
          const pair = await store.readRequestScopes!(scope, catalog);
          assert.equal(pair.global.revision, pair.tenant!.revision, 'a request cannot mix precommit and postcommit owners');
          assert.equal(pair.global.overrides.feature.value, pair.tenant!.overrides.feature.value);
        }),
      ]);
      const frozen = await captureComposedFlagRequest({ catalog, scope, context: {}, store });
      assert.deepEqual(frozen.version, { global: 4, tenant: 4 });
      const manager = createFlagManagement({ ...scope, catalog, store, authorize });
      await manager.change({ tenantId: null, flagId: 'feature', operation: 'kill', expectedRevision: 4, reason: 'Global incident' });
      assert.equal(frozen.evaluate('feature').reason, 'override');
      assert.equal((await captureComposedFlagRequest({ catalog, scope, context: {}, store })).evaluate('feature').reason, 'disabled');
    });

    await t.test('history paging is bounded, exclusive, deterministic and immutable', async () => {
      const scope = { ...base, appId: 'lifecycle' };
      const first = await store.history(scope, catalog, { flagId: 'feature', limit: 2 });
      assert.deepEqual(
        first.entries.map((row) => row.revision),
        [4, 3],
      );
      assert.equal(first.nextBeforeRevision, 3);
      const next = await store.history(scope, catalog, { flagId: 'feature', limit: 2, beforeRevision: first.nextBeforeRevision! });
      assert.deepEqual(
        next.entries.map((row) => row.revision),
        [2, 1],
      );
      assert.equal(next.nextBeforeRevision, null);
      assert.throws(() => (first.entries as unknown[]).push('mutated'), TypeError);
      assert.throws(() => {
        (first.entries[0].before.overrides as Record<string, unknown>).feature = {};
      }, TypeError);
      assert.throws(() => store.history(scope, catalog, { flagId: 'feature', limit: 101 }));
      await assert.rejects(control.query('DELETE FROM mistri.flag_audit'), /append-only/);
      await assert.rejects(control.query("UPDATE mistri.flag_audit SET actor_id='root'"), /append-only/);
      await assert.rejects(control.query('TRUNCATE mistri.flag_audit'), /append-only/);
      await assert.rejects(control.query("UPDATE mistri.flag_binding SET suite_id='other'"), /append-only/);
    });

    await t.test('altered layouts are refused on existing handles and not repaired', async () => {
      await control.query('ALTER TABLE mistri.flag_state ADD COLUMN foreign_data text');
      try {
        await assert.rejects(store.read(base, catalog), FlagStoreUnavailable);
        await assert.rejects(openPostgresFlagStore(options), FlagStoreUnavailable);
      } finally {
        await control.query('ALTER TABLE mistri.flag_state DROP COLUMN foreign_data');
      }
      await control.query('ALTER TABLE mistri.flag_audit DISABLE TRIGGER flag_audit_immutable');
      try {
        await assert.rejects(store.read(base, catalog), FlagStoreUnavailable);
      } finally {
        await control.query('ALTER TABLE mistri.flag_audit ENABLE TRIGGER flag_audit_immutable');
      }
      await control.query('CREATE DOMAIN mistri.foreign_type AS text');
      try {
        await assert.rejects(store.read(base, catalog), FlagStoreUnavailable);
      } finally {
        await control.query('DROP DOMAIN mistri.foreign_type');
      }
      assert.equal((await store.read(base, catalog)).revision, 1);
    });

    await t.test('the maximum safe revision remains visible in unbounded-first-page history', async () => {
      const scope = { ...base, appId: 'revision-boundary' };
      const revision = Number.MAX_SAFE_INTEGER - 1;
      await control.query(`INSERT INTO mistri.flag_state VALUES ($1,$2,$3,$4,'',$5,$6)`, [
        binding.suiteId,
        binding.deploymentId,
        scope.appId,
        scope.environment,
        revision,
        JSON.stringify({ ...scope, revision, overrides: {} }),
      ]);
      const manager = createFlagManagement({ ...scope, catalog, store, authorize });
      const result = await manager.change({
        operation: 'set',
        tenantId: null,
        flagId: 'feature',
        expectedRevision: revision,
        override: { value: true },
        reason: 'Boundary',
      });
      assert.equal(result.revision, Number.MAX_SAFE_INTEGER);
      assert.equal((await store.history(scope, catalog, { flagId: 'feature' })).entries[0].revision, Number.MAX_SAFE_INTEGER);
      assert.equal((await store.history(scope, catalog, { flagId: 'feature', beforeRevision: Number.MAX_SAFE_INTEGER })).entries.length, 0);
      await assert.rejects(
        manager.change({
          operation: 'kill',
          tenantId: null,
          flagId: 'feature',
          expectedRevision: Number.MAX_SAFE_INTEGER,
          reason: 'Overflow',
        }),
      );
    });

    await t.test('owned operation connections are closed and a closed store refuses new work', async () => {
      const active = (
        await admin.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE usename=$1 AND application_name='mistri-flags'", [
          role,
        ])
      ).rows[0].count;
      assert.equal(active, 0);
      await store.close();
      await assert.rejects(store.read(base, catalog), FlagStoreUnavailable);
    });
  },
);
