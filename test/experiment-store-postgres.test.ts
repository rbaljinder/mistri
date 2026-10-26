/** Main integration owner schedules this required-live block on its disposable
 * PG fixture. Only UUID-owned databases/roles are created; preview is refused. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  EXPERIMENT_LIMITS,
  ExperimentCapacityExceeded,
  ExperimentConflict,
  ExperimentStoreUnavailable,
  type ConversionFact,
  type ExperimentEpoch,
  type ExperimentStore,
  type RegisteredEpoch,
} from '../packages/mistri/src/server/experiments/contracts.js';
import {
  openPostgresExperimentStore,
  provisionPostgresExperimentStore,
  type PostgresExperimentStoreOptions,
} from '../packages/mistri/src/server/experiments/storePostgres.js';
import { experimentResultStatistics } from '../packages/mistri/src/server/experiments/results.js';
import { liveSkip } from './live.js';

interface Client {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
async function connect(url: string): Promise<Client> {
  const module = 'pg';
  const pg = (await import(module)) as { Client: new (options: unknown) => Client };
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
}
const guard = () => {};
const binding = { suiteId: 'suite', deploymentId: 'experiments-deployment' };

test(
  'AN2 PostgreSQL dedicated ownership, durable ingestion, immutable evidence and lifecycle',
  {
    skip: liveSkip('postgres', process.env.TABLEWALK_TEST_PG),
    timeout: 180_000,
  },
  async (t) => {
    assert.notEqual(new URL(process.env.TABLEWALK_TEST_PG!).port, '57693', 'Never use the preview PostgreSQL service.');
    const admin = await connect(process.env.TABLEWALK_TEST_PG!);
    const suffix = randomUUID().replaceAll('-', ''),
      role = `tw_exp_role_${suffix}`,
      password = randomUUID();
    const databases: string[] = [],
      controls: Client[] = [],
      stores: ExperimentStore[] = [];
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
      const name = `tw_exp_${label}_${suffix}`;
      await admin.query(`CREATE DATABASE "${name}" OWNER "${role}" TEMPLATE template0`);
      databases.push(name);
      const url = new URL(process.env.TABLEWALK_TEST_PG!);
      url.pathname = `/${name}`;
      url.username = role;
      url.password = password;
      for (const parameter of ['user', 'password', 'dbname', 'database']) url.searchParams.delete(parameter);
      return { url: url.href, binding };
    };
    const options = await database('control'),
      control = await connect(options.url);
    controls.push(control);
    let store!: ExperimentStore, registered!: RegisteredEpoch;
    const base = Date.now() - 200_000;
    const declaration: ExperimentEpoch = {
      scope: { appId: 'app', environment: 'production', controlTenantId: null, evaluationTenantId: 'tenant' },
      flagId: 'copy',
      version: 'v1',
      owner: 'product',
      unit: 'subject',
      control: 'a',
      arms: [
        { id: 'a', value: 'control', weight: 50 },
        { id: 'b', value: 'treatment', weight: 50 },
      ],
      eligibility: { rollout: 100, audiences: { member: { roles: ['member'], tenants: ['tenant'] } } },
      startsAtMs: base,
      endsAtMs: base + 100_000,
      conversionWindowMs: 10_000,
      deliveryGraceMs: 10_000,
      primary: { id: 'submitted', event: 'applicationSubmitted', eventVersion: 1, unitField: 'actorSubjectId' },
      guardrails: [],
    };
    const unit = (id: string) => ({ kind: 'subject' as const, id });
    const conversion = (id: string, eventId: string, occurredAtMs = base + 5000): ConversionFact => ({
      unit: unit(id),
      source: 'app-business-db',
      eventId,
      metric: 'submitted',
      event: 'applicationSubmitted',
      eventVersion: 1,
      occurredAtMs,
    });
    const publish = async (reference = registered) =>
      store.publishResults(
        reference,
        {
          expectedDataRevision: await store.readDataRevision(reference),
          delivery: { throughMs: base + 120_000, pending: 0, failed: 0, incomplete: 0 },
        },
        guard,
      );

    await t.test('serving never provisions; dedicated flags/business/foreign layouts are refused', async () => {
      await assert.rejects(openPostgresExperimentStore(options));
      assert.equal((await control.query("SELECT to_regnamespace('mistri') AS namespace")).rows[0].namespace, null);
      const busy = await database('busy'),
        connection = await connect(busy.url);
      controls.push(connection);
      // Another store's table beside it in the runtime schema is foreign too.
      await connection.query('CREATE SCHEMA mistri; CREATE TABLE mistri.flag_binding (id integer)');
      await assert.rejects(provisionPostgresExperimentStore(busy), ExperimentStoreUnavailable);
      await connection.query('DROP SCHEMA mistri CASCADE; CREATE TABLE public.business (id integer)');
      await assert.rejects(provisionPostgresExperimentStore(busy), ExperimentStoreUnavailable);
      await connection.query('DROP TABLE public.business; CREATE SCHEMA pgforeign');
      await assert.rejects(provisionPostgresExperimentStore(busy), ExperimentStoreUnavailable);
      await provisionPostgresExperimentStore(options);
      await assert.rejects(provisionPostgresExperimentStore(options), ExperimentStoreUnavailable);
      await assert.rejects(
        openPostgresExperimentStore({ ...options, binding: { ...binding, suiteId: 'foreign' } }),
        ExperimentStoreUnavailable,
      );
      await assert.rejects(
        openPostgresExperimentStore({ ...options, binding: { ...binding, deploymentId: 'foreign' } }),
        ExperimentStoreUnavailable,
      );
      const notOwner = new URL(process.env.TABLEWALK_TEST_PG!);
      notOwner.pathname = new URL(options.url).pathname;
      await assert.rejects(openPostgresExperimentStore({ ...options, url: notOwner.href }), ExperimentStoreUnavailable);
      store = await openPostgresExperimentStore(options);
      stores.push(store);
    });

    await t.test('durable assignment obligations survive restart, dedupe, fence and reconcile actual use', async () => {
      const now = Date.now(),
        epoch = await store.registerEpoch({ ...declaration, version: 'coverage', startsAtMs: now - 1000, endsAtMs: now + 60_000 }, guard);
      const assignment = { unit: unit('coverage-subject'), arm: 'a' };
      await store.enrollExposure(epoch, assignment, guard);
      const revision = await store.readDataRevision(epoch);
      await store.enrollExposure(epoch, assignment, guard);
      assert.equal(await store.readDataRevision(epoch), revision);
      await assert.rejects(store.enrollExposure(epoch, { ...assignment, arm: 'b' }, guard), ExperimentConflict);
      await assert.rejects(
        store.enrollExposure(epoch, { unit: unit('revoked'), arm: 'a' }, () => {
          throw new Error('revoked');
        }),
        /revoked/,
      );
      const reopened = await openPostgresExperimentStore(options);
      stores.push(reopened);
      const publishCoverage = () =>
        reopened.publishResults(
          epoch,
          { expectedDataRevision: revision, delivery: { throughMs: Date.now(), pending: 0, failed: 0, incomplete: 0 } },
          guard,
        );
      await assert.rejects(reopened.ingestExposure(epoch, { ...assignment, arm: 'b', usedAtMs: now }, guard), ExperimentConflict);
      const pending = await publishCoverage();
      assert.equal(pending.delivery.pending, 1);
      assert.equal(pending.input.arms[0].exposed, 0);
      await reopened.ingestExposure(epoch, { ...assignment, usedAtMs: now }, guard);
      await assert.rejects(publishCoverage(), ExperimentConflict, 'coverage changes invalidate captured evidence revision');
      const complete = await reopened.publishResults(
        epoch,
        {
          expectedDataRevision: await reopened.readDataRevision(epoch),
          delivery: { throughMs: Date.now(), pending: 0, failed: 0, incomplete: 0 },
        },
        guard,
      );
      assert.equal(complete.delivery.pending, 0);
      assert.equal(complete.delivery.incomplete, 0);
      assert.equal(complete.input.arms[0].exposed, 1);
    });

    await t.test('URL-only lifecycle cannot take over a caller transaction', async () => {
      await control.query('BEGIN');
      await control.query('CREATE TEMP TABLE caller_owned (id integer) ON COMMIT DROP');
      await control.query('INSERT INTO caller_owned VALUES (17)');
      await assert.rejects(openPostgresExperimentStore({ ...options, client: control } as PostgresExperimentStoreOptions));
      await assert.rejects(provisionPostgresExperimentStore(control as unknown as PostgresExperimentStoreOptions));
      assert.equal((await control.query('SELECT id FROM caller_owned')).rows[0].id, 17);
      await control.query('ROLLBACK');
    });

    await t.test('registration is immutable/idempotent and unused registration has no exposure authority', async () => {
      registered = await store.registerEpoch(declaration, guard);
      const again = await store.registerEpoch({ ...declaration, arms: [...declaration.arms].reverse() }, guard);
      assert.equal(again.fingerprint, registered.fingerprint);
      assert.equal(await store.readDataRevision(registered), 0);
      await assert.rejects(store.registerEpoch({ ...declaration, conversionWindowMs: 9999 }, guard), ExperimentConflict);
      await assert.rejects(store.readEpoch({ key: registered.key, fingerprint: '0'.repeat(64) }), ExperimentConflict);
      const empty = await publish();
      assert.equal(experimentResultStatistics(empty).status, 'final-blocked');
      assert.deepEqual(
        empty.input.arms.map((arm) => arm.exposed),
        [0, 0],
      );
      const foreign = await store.registerEpoch({ ...declaration, scope: { ...declaration.scope, evaluationTenantId: 'other' } }, guard);
      assert.notEqual(foreign.key, registered.key);
      assert.equal(await store.readDataRevision(foreign), 0);
    });

    await t.test('out-of-order delivery persists pending facts, deduplicates source IDs and reconciles by event time', async () => {
      const event = conversion('b0', 'event-before-exposure');
      const first = await store.ingestConversion(registered, event, guard);
      assert.equal(first.status, 'inserted');
      assert.equal(first.late, true);
      assert.equal((await store.ingestConversion(registered, event, guard)).dataRevision, first.dataRevision);
      await assert.rejects(store.ingestConversion(registered, { ...event, unit: unit('someone-else') }, guard), ExperimentConflict);
      await assert.rejects(store.ingestConversion(registered, { ...event, occurredAtMs: base + 5001 }, guard), ExperimentConflict);
      const pending = await publish();
      assert.equal(pending.diagnostics.pendingConversions, 1);
      assert.equal(experimentResultStatistics(pending).status, 'descriptive');
      await store.ingestExposure(registered, { unit: unit('b0'), arm: 'b', usedAtMs: base + 2000 }, guard);
      const reconciled = await publish();
      assert.equal(reconciled.diagnostics.pendingConversions, 0);
      assert.equal(reconciled.input.arms.find((arm) => arm.id === 'b')!.primary, 1);
      assert.equal(reconciled.diagnostics.lateConversions, 1);
    });

    await t.test('unit exposure dedup, sticky assignment and earliest actual-use time survive reorder', async () => {
      await store.ingestExposure(registered, { unit: unit('a0'), arm: 'a', usedAtMs: base + 6000 }, guard);
      await store.ingestConversion(registered, conversion('a0', 'before-first-use'), guard);
      const before = await publish();
      assert.equal(before.input.arms[0].primary, 0);
      assert.equal(before.diagnostics.unattributedConversions, 1);
      const correction = await store.ingestExposure(registered, { unit: unit('a0'), arm: 'a', usedAtMs: base + 2000 }, guard);
      assert.equal(correction.status, 'earlier-exposure');
      const duplicate = await store.ingestExposure(registered, { unit: unit('a0'), arm: 'a', usedAtMs: base + 3000 }, guard);
      assert.equal(duplicate.status, 'duplicate');
      assert.equal(duplicate.dataRevision, correction.dataRevision);
      await assert.rejects(
        store.ingestExposure(registered, { unit: unit('a0'), arm: 'b', usedAtMs: base + 1000 }, guard),
        ExperimentConflict,
      );
      const corrected = await publish();
      assert.equal(corrected.input.arms[0].primary, 1);
      assert.equal(corrected.input.arms[0].exposed, 1);
      await assert.rejects(store.ingestExposure(registered, { unit: unit('a0'), arm: 'a', usedAtMs: declaration.endsAtMs }, guard));
      await assert.rejects(
        store.ingestExposure(registered, { unit: { kind: 'visitor', id: 'a0' }, arm: 'a', usedAtMs: base + 2000 }, guard),
      );
    });

    await t.test('concurrent retries give one denominator and repeated conversions give one binary outcome', async () => {
      const receipts = await Promise.all(
        Array.from({ length: 3 }, () => store.ingestExposure(registered, { unit: unit('a1'), arm: 'a', usedAtMs: base + 2000 }, guard)),
      );
      assert.equal(receipts.filter((receipt) => receipt.status === 'inserted').length, 1);
      for (const arm of ['a', 'b'])
        for (let i = arm === 'a' ? 2 : 1; i < 10; i++) {
          await store.ingestExposure(registered, { unit: unit(`${arm}${i}`), arm, usedAtMs: base + 2000 }, guard);
        }
      for (let i = 0; i < 4; i++) await store.ingestConversion(registered, conversion('b0', `repeat-${i}`), guard);
      const result = await publish(),
        stats = experimentResultStatistics(result);
      assert.deepEqual(stats.srm.observed, [10, 10]);
      assert.equal(stats.srm.status, 'clear');
      assert.equal(result.input.arms[1].primary, 1);
      assert.equal(stats.status, 'final-evidence');
      assert.equal(JSON.stringify(result).includes('unitKey'), false);
      const raw = (await control.query('SELECT unit_key FROM mistri.experiment_exposures LIMIT 1')).rows[0];
      assert.match(String(raw.unit_key), /^[a-f0-9]{64}$/);
    });

    await t.test('strict attribution boundaries count mature units once and ignore received time', async () => {
      for (const [id, offset] of [
        ['a2', 2000],
        ['a3', 12_000],
        ['a4', 12_001],
      ] as const) {
        await store.ingestConversion(registered, conversion(id, `boundary-${id}`, base + offset), guard);
      }
      const result = await publish();
      assert.equal(result.input.arms[0].primary, 2, 'a0 and inclusive upper-bound a3 only');
      assert.equal(result.diagnostics.unattributedConversions, 2, 'equal exposure timestamp and outside-window event');
      assert.equal(result.input.arms[0].mature, 10);
      assert.equal(result.input.arms[0].immature, 0);
    });

    await t.test('last-observation refusal rolls back facts, counters and result publications', async () => {
      const before = await store.readDataRevision(registered);
      const denied = () => {
        throw new Error('Owner revoked');
      };
      await assert.rejects(
        store.ingestExposure(registered, { unit: unit('rollback-unit'), arm: 'a', usedAtMs: base + 2000 }, denied),
        /Owner revoked/,
      );
      assert.equal(await store.readDataRevision(registered), before);
      await assert.rejects(store.ingestConversion(registered, conversion('b2', 'rollback-event'), denied), /Owner revoked/);
      assert.equal(await store.readDataRevision(registered), before);
      assert.equal((await store.ingestConversion(registered, conversion('b2', 'rollback-event'), guard)).status, 'inserted');
      const snapshot = await publish();
      await assert.rejects(
        store.publishResults(registered, { expectedDataRevision: snapshot.dataRevision, delivery: snapshot.delivery }, denied),
        /Owner revoked/,
      );
      assert.equal((await publish()).evidenceRevision, snapshot.evidenceRevision + 1);
      await assert.rejects(
        store.publishResults(registered, { expectedDataRevision: before, delivery: snapshot.delivery }, guard),
        ExperimentConflict,
      );
      await control.query(`REVOKE INSERT ON mistri.experiment_conversions FROM "${role}"`);
      const revision = await store.readDataRevision(registered);
      try {
        await assert.rejects(store.ingestConversion(registered, conversion('b2', 'insert-denied'), guard), /permission denied/);
      } finally {
        await control.query(`GRANT INSERT ON mistri.experiment_conversions TO "${role}"`);
      }
      assert.equal(await store.readDataRevision(registered), revision);
    });

    await t.test('immutable decisions retain their evidence revision across late data and restarts', async () => {
      const first = await publish();
      const input = {
        decisionId: 'decision-a',
        evidenceRevision: first.evidenceRevision,
        expectedDataRevision: first.dataRevision,
        arm: 'b',
        actorId: 'operator-subject',
        reason: 'Explicit operator evidence reference',
        controlRevision: 7,
      };
      await assert.rejects(
        store.appendDecisionEvidence(registered, input, () => {
          throw new Error('Decision owner revoked');
        }),
      );
      assert.equal((await store.decisions(registered, { limit: 10 })).entries.length, 0);
      const evidence = await store.appendDecisionEvidence(registered, input, guard);
      assert.equal('actorId' in evidence, false);
      assert.match(evidence.actorKey, /^[a-f0-9]{64}$/);
      await store.ingestConversion(registered, conversion('b3', 'late-after-decision'), guard);
      assert.deepEqual(
        await store.appendDecisionEvidence(registered, input, guard),
        evidence,
        'an ambiguous ACK can replay the same immutable decision reference',
      );
      await assert.rejects(store.appendDecisionEvidence(registered, { ...input, decisionId: 'stale-evidence' }, guard), ExperimentConflict);
      const second = await publish();
      assert.equal(second.input.arms[1].primary, first.input.arms[1].primary! + 1);
      assert.deepEqual(await store.readResults(registered, first.evidenceRevision), first);
      await store.appendDecisionEvidence(
        registered,
        {
          ...input,
          decisionId: 'decision-b',
          evidenceRevision: second.evidenceRevision,
          expectedDataRevision: second.dataRevision,
          controlRevision: 8,
        },
        guard,
      );
      await store.close();
      store = await openPostgresExperimentStore(options);
      stores.push(store);
      const page = await store.decisions(registered, { limit: 1 });
      assert.equal(page.entries[0].evidenceRevision, first.evidenceRevision);
      assert.equal(page.nextAfter, 'decision-a');
      const next = await store.decisions(registered, { limit: 1, after: page.nextAfter! });
      assert.equal(next.entries[0].decisionId, 'decision-b');
      assert.equal(next.nextAfter, null);
      assert.deepEqual(await store.readResults(registered, first.evidenceRevision), first);
    });

    await t.test('pending/failed delivery cannot supply decision evidence after grace', async () => {
      const pending = await store.publishResults(
        registered,
        {
          expectedDataRevision: await store.readDataRevision(registered),
          delivery: { throughMs: base + 120_000, pending: 1, failed: 1, incomplete: 0 },
        },
        guard,
      );
      assert.equal(experimentResultStatistics(pending).status, 'descriptive');
      await assert.rejects(
        store.appendDecisionEvidence(
          registered,
          {
            decisionId: 'incomplete-decision',
            evidenceRevision: pending.evidenceRevision,
            expectedDataRevision: pending.dataRevision,
            arm: 'b',
            actorId: 'operator-subject',
            reason: 'Must not pass',
            controlRevision: 9,
          },
          guard,
        ),
      );
    });

    await t.test('recent exposed units remain outside mature outcome denominators in SQL', async () => {
      const now = Date.now();
      const recent = await store.registerEpoch(
        {
          ...declaration,
          version: 'immature',
          startsAtMs: now - 1000,
          endsAtMs: now + 100_000,
          conversionWindowMs: 10_000,
          deliveryGraceMs: 5000,
        },
        guard,
      );
      await store.ingestExposure(recent, { unit: unit('recent'), arm: 'a', usedAtMs: now - 900 }, guard);
      await store.ingestConversion(recent, conversion('recent', 'recent-event', now - 800), guard);
      const result = await store.publishResults(
        recent,
        {
          expectedDataRevision: await store.readDataRevision(recent),
          delivery: { throughMs: now - 1000, pending: 0, failed: 0, incomplete: 0 },
        },
        guard,
      );
      assert.equal(result.input.arms[0].exposed, 1);
      assert.equal(result.input.arms[0].mature, 0);
      assert.equal(result.input.arms[0].immature, 1);
      assert.equal(result.input.arms[0].primary, 0);
      assert.equal(experimentResultStatistics(result).status, 'descriptive');
      assert.deepEqual(await store.readResults(recent), result);
    });

    await t.test('bounded ingestion refuses capacity without acknowledgment or revision advancement', async () => {
      const bounded = await store.registerEpoch({ ...declaration, version: 'capacity' }, guard);
      await control.query(`UPDATE mistri.experiment_progress SET conversions=$2 WHERE epoch_key=$1`, [
        bounded.key,
        EXPERIMENT_LIMITS.conversions,
      ]);
      await assert.rejects(store.ingestConversion(bounded, conversion('overflow', 'capacity-event'), guard), ExperimentCapacityExceeded);
      assert.equal(await store.readDataRevision(bounded), 0);
      await control.query(`UPDATE mistri.experiment_progress SET conversions=$2 WHERE epoch_key=$1`, [
        bounded.key,
        EXPERIMENT_LIMITS.pendingConversions,
      ]);
      await control.query(
        `INSERT INTO mistri.experiment_conversions SELECT $1,md5(i::text), 'submitted',md5('pending-unit'),$2,$3
      FROM generate_series(1,$4::integer) AS i`,
        [bounded.key, base + 5000, Date.now(), EXPERIMENT_LIMITS.pendingConversions],
      );
      await assert.rejects(
        store.ingestConversion(bounded, conversion('overflow', 'pending-capacity-event'), guard),
        ExperimentCapacityExceeded,
      );
      assert.equal(await store.readDataRevision(bounded), 0);
    });

    await t.test('append-only metadata/facts/evidence reject updates, deletion and truncation', async () => {
      for (const relation of ['binding', 'epochs', 'conversions', 'results', 'decisions']) {
        await assert.rejects(control.query(`DELETE FROM mistri.experiment_${relation}`), /append-only/);
        await assert.rejects(control.query(`TRUNCATE mistri.experiment_${relation}`), /append-only/);
      }
      await assert.rejects(control.query('UPDATE mistri.experiment_binding SET version=2'), /append-only/);
    });

    await t.test('layout changes are refused on existing handles and never repaired', async () => {
      await control.query('ALTER TABLE mistri.experiment_exposures ADD COLUMN foreign_data text');
      try {
        await assert.rejects(store.readEpoch(registered), ExperimentStoreUnavailable);
        await assert.rejects(openPostgresExperimentStore(options), ExperimentStoreUnavailable);
      } finally {
        await control.query('ALTER TABLE mistri.experiment_exposures DROP COLUMN foreign_data');
      }
      await control.query('ALTER TABLE mistri.experiment_results DISABLE TRIGGER experiment_results_immutable');
      try {
        await assert.rejects(store.readEpoch(registered), ExperimentStoreUnavailable);
      } finally {
        await control.query('ALTER TABLE mistri.experiment_results ENABLE TRIGGER experiment_results_immutable');
      }
      await control.query('CREATE DOMAIN mistri.foreign_type AS text');
      try {
        await assert.rejects(store.readEpoch(registered), ExperimentStoreUnavailable);
      } finally {
        await control.query('DROP DOMAIN mistri.foreign_type');
      }
    });

    await t.test('close drains accepted transactions and rejects new work; connections do not survive operations', async () => {
      let release!: () => void, observed!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const ingestion = store.ingestConversion(registered, conversion('b4', 'drain-event'), async () => {
        observed();
        await hold;
      });
      await Promise.race([
        ready,
        ingestion.then(() => {
          throw new Error('No commit fence');
        }),
      ]);
      let drained = false;
      const closing = store.close().then(() => {
        drained = true;
      });
      try {
        await assert.rejects(store.readEpoch(registered), ExperimentStoreUnavailable);
        assert.equal(drained, false);
      } finally {
        release();
        await ingestion;
        await closing;
      }
      const count = (
        await admin.query(
          "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE usename=$1 AND application_name='mistri-experiments'",
          [role],
        )
      ).rows[0].count;
      assert.equal(count, 0);
    });
  },
);
