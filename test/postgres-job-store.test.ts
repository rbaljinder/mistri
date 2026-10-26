/**
 * What only the PostgreSQL job store has to show: its catalog attestation,
 * migrations racing each other, claimers on separate connections, and the
 * database clock standing in for the hosts'. The engine-neutral contract is
 * job-store-contract.test.ts. Live and opt-in like every PostgreSQL suite:
 * `TABLEWALK_TEST_PG` names a disposable database this file resets.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { JobStore } from '../packages/mistri/src/adapters/jobs/jobStoreContract.js';
import { JOB_PREFIX, JOB_TABLES as tables } from '../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import {
  JobStoreUnavailable,
  type JobClaim,
  type JobEnqueueInput,
  type JobPolicyInput,
} from '../packages/mistri/src/adapters/jobs/jobStoreTypes.js';
import {
  migratePostgresJobStore,
  openPostgresJobStore,
  type PostgresJobStoreOptions,
} from '../packages/mistri/src/adapters/jobs/postgresJobStore.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { PgConnectionManager, type PgQuery, type PgWriteClientSource } from '../packages/engine/src/adapters/postgresPool.js';
import { layoutTrust, trustStoreLayoutsFor } from '../packages/mistri/src/adapters/commands/postgresRelations.js';
import { runtimeName, runtimeSchema, runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { createAppResources } from '../packages/mistri/src/server/app/appResources.js';
import { LIVE_PG as LIVE, ownedPostgresDatabase, pgControl, resetPostgresJobs, type Control } from './support/jobStoreEngines.js';
import { liveSkip } from './live.js';

const policy = (override: Partial<JobPolicyInput> = {}): JobPolicyInput => ({
  namespace: 'proof',
  maxAttempts: 3,
  leaseMs: 5_000,
  backoffMs: { base: 100, cap: 1_000 },
  maxInputBytes: 1_024,
  maxInFlight: 8,
  ...override,
});
const request = (key: string, extra: Partial<JobEnqueueInput> = {}): JobEnqueueInput => ({
  job: 'remind',
  version: 1,
  idempotencyKey: key,
  input: { key },
  provenance: { appId: 'ledger', actorId: 'clock' },
  ...extra,
});
const q = (name: string) => runtimeTable('postgres', name);
const plain = (name: string) => runtimeName('postgres', name);
/* The drift cases below change a layout under an open store and expect its
   next call to refuse, so the layout trust window is closed here; the test
   that measures an idle tick opens it again. */
trustStoreLayoutsFor(0);
/** A statement that reads the catalog, as an attestation's description does. */
const catalog = (sql: string) => /\bpg_(class|attribute|namespace|constraint|index)\b|information_schema/.test(sql);
/** A pool that records every statement its clients run. */
const recording = (manager: PgConnectionManager, seen: string[]): PgWriteClientSource => ({
  withWriteClient: (run, destroyAfter) =>
    manager.withWriteClient(
      (client) =>
        run({
          query: (text: string | { text: string }, params?: unknown[]) => {
            seen.push(typeof text === 'string' ? text : text.text);
            return (client.query as (text: unknown, params?: unknown[]) => Promise<never>)(text, params);
          },
        } as PgQuery),
      destroyAfter,
    ),
});

test('a layout trust stands for its window, is never granted by a failed attestation, and forget ends it', async () => {
  let now = 1_000,
    runs = 0;
  const trust = layoutTrust(5_000, () => now);
  const attest = async () => {
    runs++;
  };
  await trust.through('a', attest);
  await trust.through('a', attest);
  assert.equal(runs, 1, 'the second pass inside the window reads nothing');
  await trust.through('b', attest);
  assert.equal(runs, 2, 'each prefix is attested on its own');
  now += 5_000;
  await trust.through('a', attest);
  assert.equal(runs, 3, 'the window closes');
  trust.forget();
  await trust.through('a', attest);
  assert.equal(runs, 4, 'forget ends it at once');
  now -= 10_000;
  await trust.through('a', attest);
  assert.equal(runs, 5, 'a clock that went back trusts nothing');
  await assert.rejects(
    trust.through('c', async () => {
      throw new Error('drifted');
    }),
  );
  await trust.through('c', attest);
  assert.equal(runs, 6, 'a refused attestation leaves nothing trusted');
});

describe('the job store on PostgreSQL', { skip: liveSkip('postgres', LIVE) }, () => {
  let control: Control;
  /* This run's own database: every reset here drops whole job namespaces, so
     it must never be the server's shared one. */
  let url: string;
  const managers: PgConnectionManager[] = [];
  before(async () => {
    url = await ownedPostgresDatabase();
    control = await pgControl(url);
  });
  beforeEach(async () => {
    await resetPostgresJobs(control);
  });
  after(async () => {
    for (const manager of managers) await manager.close().catch(() => {});
    await resetPostgresJobs(control).catch(() => {});
    await control.end();
  });
  /** A host: its own pool, so two hosts are two real connections. */
  const host = async (input = policy(), options: PostgresJobStoreOptions = {}): Promise<JobStore> => {
    const manager = new PgConnectionManager(url);
    managers.push(manager);
    return openPostgresJobStore(manager, input, options);
  };

  test('two migrations racing each other serialise: one provisions, the other attests the same layout', async () => {
    const results = await Promise.all([migratePostgresJobStore(url, policy()), migratePostgresJobStore(url, policy())]);
    assert.deepEqual(results.map((result) => result.migrated).sort(), [false, true]);
    assert.deepEqual(await migratePostgresJobStore(url, policy()), { version: 1, migrated: false });
    await host();
    // The same namespace with other bounds is refused, racing or not; nothing is changed.
    await assert.rejects(
      Promise.all([migratePostgresJobStore(url, policy({ maxAttempts: 5 })), migratePostgresJobStore(url, policy({ maxAttempts: 5 }))]),
      JobStoreUnavailable,
    );
    // Another namespace is another App's store beside this one.
    const others = await Promise.all([
      migratePostgresJobStore(url, policy({ namespace: 'other' })),
      migratePostgresJobStore(url, policy({ namespace: 'other' })),
    ]);
    assert.deepEqual(others.map((result) => result.migrated).sort(), [false, true]);
  });

  test('two namespaces on one database: each claims, inspects, settles and prunes only its own jobs', async () => {
    await migratePostgresJobStore(url, policy());
    await migratePostgresJobStore(url, policy({ namespace: 'other', maxInFlight: 1 }));
    const mine = await host(policy(), { clock: 'caller' }),
      theirs = await host(policy({ namespace: 'other', maxInFlight: 1 }), { clock: 'caller' });
    // One idempotency key in both: two jobs, one each.
    const a = await mine.enqueue(request('idempotency-key-same'), 0),
      b = await theirs.enqueue(request('idempotency-key-same'), 0);
    assert.notEqual(a.id, b.id);
    assert.equal(a.replayed || b.replayed, false);
    assert.deepEqual(
      (await mine.inspect()).map((job) => job.id),
      [a.id],
    );
    assert.deepEqual(
      (await theirs.inspect()).map((job) => job.id),
      [b.id],
    );
    // The other namespace's in-flight bound is its own: one in flight there does not block this one.
    const [claimed] = await theirs.claim(1);
    assert.equal(claimed.id, b.id);
    assert.deepEqual(
      (await mine.claim(1)).map((claim) => claim.id),
      [a.id],
    );
    // Another namespace's job is not found here, by any verb.
    await assert.rejects(mine.cancel(b.id, 2), /job_not_found/);
    assert.deepEqual(await mine.attempts(b.id), []);
    await assert.rejects(mine.succeed(b.id, claimed.fence, 2, null), /job_not_found/);
    await theirs.succeed(b.id, claimed.fence, 2, null);
    assert.deepEqual(await mine.prune(0, 100), { pruned: 0, more: false });
    assert.deepEqual(await theirs.prune(0, 100), { pruned: 1, more: false });
  });

  for (const [what, sql] of [
    ['an unrelated relation under the prefix', `CREATE TABLE ${q(`${JOB_PREFIX}unexpected`)} (id text)`],
    ['a look-alike in another case', `CREATE TABLE ${runtimeSchema('postgres')}."JOB_lookalike" (id text)`],
    [
      'a trigger',
      `CREATE FUNCTION public.tablewalk_job_fixture_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER extra BEFORE UPDATE ON ${q(tables.job)} FOR EACH ROW EXECUTE FUNCTION public.tablewalk_job_fixture_noop()`,
    ],
    ['a dropped index', `DROP INDEX ${runtimeSchema('postgres')}."${plain(JOB_PREFIX)}due"`],
    ['an added index', `CREATE INDEX extra_job_index ON ${q(tables.job)} (job)`],
    ['row level security', `ALTER TABLE ${q(tables.job)} ENABLE ROW LEVEL SECURITY`],
    ['a column default', `ALTER TABLE ${q(tables.attempt)} ALTER COLUMN operator SET DEFAULT 'someone'`],
    ['a dropped check', `ALTER TABLE ${q(tables.attempt)} DROP CONSTRAINT "${plain(tables.attempt)}_check"`],
    ['a changed policy', `UPDATE ${q(tables.policy)} SET policy_json = '{"namespace":"proof"}'`],
    [
      'a job moved to a namespace with no policy row',
      `ALTER TABLE ${q(tables.job)} DROP CONSTRAINT "${plain(tables.job)}_namespace_fkey";
      UPDATE ${q(tables.job)} SET namespace = 'elsewhere'`,
    ],
  ] as const)
    test(`attestation refuses ${what}`, async () => {
      await migratePostgresJobStore(url, policy());
      const store = await host();
      await store.enqueue(request('idempotency-key-0001'), 0);
      await control.query(sql);
      await assert.rejects(store.inspect(), JobStoreUnavailable);
      await assert.rejects(store.claim(0), JobStoreUnavailable);
      await assert.rejects(host(), JobStoreUnavailable);
      await assert.rejects(migratePostgresJobStore(url, policy()), JobStoreUnavailable);
    });

  test('a same-named table in another schema is not part of the store, so attestation ignores it', async () => {
    await migratePostgresJobStore(url, policy());
    const store = await host();
    await store.enqueue(request('idempotency-key-0001'), 0);
    await control.query(`CREATE SCHEMA tablewalk_job_shadow; CREATE TABLE tablewalk_job_shadow."${plain(tables.job)}" (id text)`);
    await store.inspect();
    await store.claim(0);
    await host();
    await migratePostgresJobStore(url, policy());
  });

  test('an idle tick after warm-up reads no catalog, and a statement failing on a moved table re-attests at once', async () => {
    const was = trustStoreLayoutsFor(60_000);
    try {
      await migratePostgresJobStore(url, policy());
      const manager = new PgConnectionManager(url);
      managers.push(manager);
      const seen: string[] = [];
      const store = await openPostgresJobStore(recording(manager, seen), policy());
      assert.ok(seen.some(catalog), 'opening attests the layout');
      seen.length = 0;
      for (let tick = 0; tick < 5; tick++) assert.deepEqual(await store.claim(0), []);
      assert.ok(seen.length > 0, 'the ticks ran');
      assert.deepEqual(seen.filter(catalog), [], 'no idle tick describes the store again');
      await control.query(`ALTER TABLE ${q(tables.job)} RENAME TO "${plain(JOB_PREFIX)}moved"`);
      await assert.rejects(store.claim(0), JobStoreUnavailable);
      seen.length = 0;
      await assert.rejects(store.claim(0), JobStoreUnavailable);
      assert.ok(seen.some(catalog), 'the failure ended the trust: the next tick describes the store and refuses');
    } finally {
      trustStoreLayoutsFor(was);
    }
  });

  test('claimers on separate connections never lease the same job, and the in-flight bound holds across them', async () => {
    await migratePostgresJobStore(url, policy({ maxInFlight: 8 }));
    const hosts = [await host(policy({ maxInFlight: 8 })), await host(policy({ maxInFlight: 8 })), await host(policy({ maxInFlight: 8 }))];
    for (let i = 0; i < 40; i++) await hosts[i % 3].enqueue(request(`idempotency-key-${String(i).padStart(4, '0')}`), 0);
    // Unsettled: every host races for the same eight slots, repeatedly.
    const first: JobClaim[] = [];
    for (let round = 0; round < 4; round++) {
      for (const claims of await Promise.all(hosts.map((store) => store.claim(0, 3)))) first.push(...claims);
    }
    assert.equal(first.length, 8);
    assert.equal(new Set(first.map((claim) => claim.id)).size, 8);
    // Settling as they go: all forty run exactly once between the three.
    const all = [...first];
    for (const claim of first) await hosts[0].succeed(claim.id, claim.fence, 0);
    for (let round = 0; round < 40 && all.length < 40; round++) {
      const batches = await Promise.all(
        hosts.map(async (store) => {
          const claims = await store.claim(0, 4);
          for (const claim of claims) await store.succeed(claim.id, claim.fence, 0);
          return claims;
        }),
      );
      for (const claims of batches) all.push(...claims);
    }
    assert.equal(all.length, 40);
    assert.equal(new Set(all.map((claim) => claim.id)).size, 40);
    assert.ok(all.every((claim) => claim.attempt === 1));
    assert.equal(Number((await control.query(`SELECT count(*) AS n FROM ${q(tables.attempt)}`)).rows[0].n), 40);
    assert.equal(Number((await control.query(`SELECT count(DISTINCT fence) AS n FROM ${q(tables.attempt)}`)).rows[0].n), 40);
  });

  test("the database clock, not each host's, drives leases and the floor, so skewed hosts do not halt each other", async () => {
    await migratePostgresJobStore(url, policy());
    const ahead = await host(),
      behind = await host();
    const skew = 60_000;
    const db = async () =>
      Number((await control.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now')).rows[0].now);
    const queued = await ahead.enqueue(request('idempotency-key-ahead'), Date.now() + skew);
    const start = await db();
    // The job's own timer is the database's now, whatever the host passed.
    assert.ok(Math.abs(queued.runAt - start) < 5_000, 'enqueue time is the database clock');
    const [claim] = await ahead.claim(Date.now() + skew);
    assert.ok(claim, 'the host ahead claims');
    assert.ok(Math.abs(claim.deadline - (start + 5_000)) < 5_000, 'the lease is measured on the database clock');
    // A host a minute behind keeps working against the floor the other set.
    const other = await behind.enqueue(request('idempotency-key-behind'), Date.now() - skew);
    assert.equal(other.replayed, false);
    assert.equal((await behind.succeed(claim.id, claim.fence, Date.now() - skew)).state, 'succeeded');
    const [next] = await behind.claim(Date.now() - skew);
    assert.equal(next.id, other.id);
    assert.equal((await ahead.retry(next.id, next.fence, Date.now() + skew, 'handler_error')).state, 'retry');
    // With the caller's clock instead, the host behind trips the floor.
    const callerAhead = await host(policy(), { clock: 'caller' }),
      callerBehind = await host(policy(), { clock: 'caller' });
    await callerAhead.claim(Date.now() + skew);
    await assert.rejects(callerBehind.claim(Date.now() - skew), JobStoreUnavailable);
    // The floor still guards against the database clock itself going back.
    await control.query(`UPDATE ${q(tables.policy)} SET last_clock = $1`, [Date.now() + 10 * skew]);
    await assert.rejects(ahead.claim(Date.now()), JobStoreUnavailable);
    await assert.rejects(behind.enqueue(request('idempotency-key-after'), Date.now()), JobStoreUnavailable);
  });

  test('an enqueue racing the same key on another connection replays the winner', async () => {
    await migratePostgresJobStore(url, policy());
    const hosts = [await host(), await host(), await host()];
    const results = await Promise.all(hosts.map((store) => store.enqueue(request('idempotency-key-raced'), 0)));
    assert.equal(new Set(results.map((result) => result.id)).size, 1);
    assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true, true]);
    await assert.rejects(
      hosts[0].enqueue(request('idempotency-key-raced', { input: { other: true } }), 0),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'idempotency_conflict',
    );
  });

  test('the job tables stay out of the App catalog', async () => {
    await control.query('CREATE TABLE public.job_fixture_accounts (id integer PRIMARY KEY, name text NOT NULL)');
    await migratePostgresJobStore(url, policy());
    const adapter = new PostgresAdapter(url, 'job catalog proof', ['public']);
    try {
      const physical = await adapter.introspect();
      assert.ok(
        !physical.tables.some((table) => table.id.toLowerCase().includes(plain(tables.job))),
        'the adapter never sees the runtime schema',
      );
      const mapped = createAppResources(adapter, physical);
      assert.ok(mapped.schema.tables.some((table) => table.id.endsWith('job_fixture_accounts')));
      assert.ok(
        !mapped.schema.tables.some((table) => table.id.toLowerCase().includes(plain(tables.job))),
        'runtime tables stay out of the App catalog',
      );
    } finally {
      await adapter.close();
    }
  });
});
