/**
 * The `@mistriwork/mistri/maintenance` entry: that the package maps and builds it,
 * what it exports, and that its bounded operator steps (inspect, redrive,
 * prune) run against a SQLite file and, when live, a PostgreSQL database.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import * as maintenance from '@mistriwork/mistri/maintenance';
import { openSqliteJobStore } from '../packages/mistri/src/adapters/jobs/jobStore.js';
import { JobRefusal, JobStoreUnavailable, type JobPolicyInput } from '../packages/mistri/src/adapters/jobs/jobStoreTypes.js';
import { migratePostgresJobStore, openPostgresJobStore } from '../packages/mistri/src/adapters/jobs/postgresJobStore.js';
import { provisionSqliteJobStore } from '../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import { EventDeliveryUnavailable } from '../packages/mistri/src/adapters/events/eventDeliveryTypes.js';
import { PgConnectionManager } from '../packages/engine/src/adapters/postgresPool.js';
import { eventDeliveryFixture, eventDeliveryPolicy } from './support/eventDeliveryFixture.js';
import { LIVE_PG, ownedPostgresDatabase, pgControl, resetPostgresJobs } from './support/jobStoreEngines.js';
import { liveSkip } from './live.js';
import { published } from '../scripts/pack-manifest.mjs';

const policy: JobPolicyInput = {
  namespace: 'maintenance',
  maxAttempts: 2,
  leaseMs: 1_000,
  backoffMs: { base: 100, cap: 1_000 },
  maxInputBytes: 1_024,
  maxInFlight: 4,
};
const job = (key: string) => ({
  job: 'remind',
  version: 1,
  idempotencyKey: `maintenance-key-${key}`,
  input: { key },
  provenance: { appId: 'ledger', actorId: 'operator-console' },
});

test('the package maps and builds the maintenance entry, and it exports the operator steps', () => {
  const pkg = published(JSON.parse(readFileSync(new URL('../packages/mistri/package.json', import.meta.url), 'utf8')));
  assert.deepEqual(pkg.exports['./maintenance'], { types: './dist/server/maintenance.d.ts', default: './dist/server/maintenance.js' });
  const commands = JSON.parse(readFileSync(new URL('../config/tsconfig.commands.json', import.meta.url), 'utf8'));
  assert.ok(commands.include.includes('../packages/mistri/src/server/maintenance.ts'));
  assert.deepEqual(Object.keys(maintenance).sort(), [
    'TenantMaintenanceRefusal',
    'applyMigrations',
    'cancelWorkflow',
    'createAppAccounts',
    'effectDeliveryPolicies',
    'grantPlatformMembership',
    'grantTenantMembership',
    'inspectEventDeliveries',
    'inspectEventDeliveryAttempts',
    'inspectFunnel',
    'inspectJobAttempts',
    'inspectJobs',
    'inspectWorkflowActions',
    'inspectWorkflowSteps',
    'inspectWorkflows',
    'migratePostgresAuthStore',
    'migratePostgresCommandJournal',
    'migratePostgresSupportAudit',
    'migratePostgresTenantAdministrationJournal',
    'migratePostgresTenantInvitations',
    'migratePostgresTenantStore',
    'migrateSqliteCommandJournal',
    'provisionStores',
    'pruneAnalyticsEvents',
    'pruneEventDeliveries',
    'pruneJobs',
    'pruneWorkflows',
    'putTenant',
    'redriveEventDeliveries',
    'redriveJobs',
    'retryWorkflow',
    'revokePlatformMembership',
    'revokeTenantMailLinks',
    'revokeTenantMembership',
    'setPlatformStatus',
    'tenantJobPolicies',
    'verifyPostgresSupportAudit',
    'verifySqliteSupportAudit',
  ]);
});

const tablesOf = (path: string): string[] => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
      (row) => row.name,
    );
  } finally {
    db.close();
  }
};

test('provisionStores makes the stores `only` names, once, and refuses a list it cannot keep before making any', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-provision-stores-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.db');
  new DatabaseSync(path).close();

  // A refused list makes nothing, so a typo cannot leave half the stores behind.
  await assert.rejects(maintenance.provisionStores({ sqlite: path }, { only: ['inbox', 'inbx'] }), /provisionStores: .*inbx/);
  await assert.rejects(
    maintenance.provisionStores({ sqlite: path }, { only: ['inbox', 'schema-epoch'] }),
    /provisionStores: .*schema-epoch/,
  );
  assert.deepEqual(tablesOf(path), []);

  const made = await maintenance.provisionStores({ sqlite: path }, { only: ['inbox', 'record-history'] });
  assert.equal(made.stores.inbox?.provisioned, true);
  assert.equal(made.stores['record-history']?.provisioned, true);
  assert.deepEqual(made.destinations, []);
  assert.ok(tablesOf(path).some((name) => name.startsWith('__mistri_inbox_')));
  const again = await maintenance.provisionStores({ sqlite: path }, { only: ['inbox', 'record-history'] });
  assert.equal(again.stores.inbox?.provisioned, false);
  assert.equal(again.stores['record-history']?.provisioned, false);

  await assert.rejects(maintenance.provisionStores({ sqlite: path }), /provisionStores: /);
  await assert.rejects(maintenance.provisionStores({ sqlite: path }, { only: [] }), /provisionStores: /);
});

test('job maintenance inspects, redrives and prunes a SQLite job store', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-maintenance-')),
    path = join(directory, 'jobs.db');
  new DatabaseSync(path).close();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.deepEqual(provisionSqliteJobStore(path, policy), { version: 1, provisioned: true });
  const store = openSqliteJobStore(path, policy);
  const failing = await store.enqueue(job('failing'), 1_000),
    done = await store.enqueue(job('done'), 1_000);
  await store.enqueue(job('waiting'), 1_000);
  const claims = await store.claim(1_000, 2);
  await store.fail(failing.id, claims.find((claim) => claim.id === failing.id)!.fence, 1_000, 'rejected');
  await store.succeed(done.id, claims.find((claim) => claim.id === done.id)!.fence, 1_000);
  await store.close();
  const target: maintenance.MaintenanceTarget = { sqlite: path };
  assert.equal((await maintenance.inspectJobs(target, policy)).rows.length, 3);
  const page: maintenance.MaintenancePage<maintenance.JobInspection> = await maintenance.inspectJobs(target, policy, { limit: 2 });
  assert.equal(page.rows.length, 2);
  assert.equal((await maintenance.inspectJobs(target, policy, { after: page.after })).rows.length, 1);
  const [failed] = (await maintenance.inspectJobs(target, policy, { state: 'failed' })).rows;
  const [redriven] = await maintenance.redriveJobs(target, policy, { ids: [failed.id], operator: 'operator-ada' });
  assert.deepEqual([redriven.state, redriven.redrives], ['retry', 1]);
  assert.equal((await maintenance.inspectJobAttempts(target, policy, failed.id)).at(-1)!.operator, 'operator-ada');
  await assert.rejects(
    maintenance.redriveJobs(target, policy, { ids: [done.id], operator: 'operator-ada' }),
    (error: unknown) => error instanceof JobRefusal && error.code === 'not_redrivable',
  );
  assert.deepEqual(await maintenance.pruneJobs(target, policy, { olderThanMs: 0 }), { pruned: 1, more: false });
  for (const bad of [{ sqlite: '' }, { postgres: 'mongodb://elsewhere' }, { sqlite: path, postgres: 'postgres://x' }, {}]) {
    await assert.rejects(maintenance.inspectJobs(bad as never, policy), JobStoreUnavailable);
  }
  await assert.rejects(maintenance.redriveJobs(target, policy, { ids: [], operator: 'operator-ada' }), JobStoreUnavailable);
});

test('delivery maintenance inspects, redrives and prunes a SQLite destination', async (t) => {
  const f = eventDeliveryFixture(t, eventDeliveryPolicy());
  await f.seed('receipt-a');
  await f.seed('receipt-b');
  const store = f.open();
  await store.discover();
  // receipt-a is refused until it fails; receipt-b is delivered whenever its turn comes.
  for (let time = 1_000; time < 1_800; time += 100) {
    const claim = await store.claim(time);
    if (!claim) continue;
    const outcome = claim.envelope.receiptId === 'receipt-b' ? 'accepted' : 'rejected';
    await store.complete(claim, outcome, outcome, time);
  }
  await store.close();
  const target = { sqlite: f.path };
  const { rows } = await maintenance.inspectEventDeliveries(target, f.policy);
  assert.deepEqual(rows.map((row) => row.state).sort(), ['delivered', 'failed']);
  const failed = rows.find((row) => row.state === 'failed')!;
  const [redriven] = await maintenance.redriveEventDeliveries(target, f.policy, { eventIds: [failed.eventId], operator: 'operator-ada' });
  assert.deepEqual([redriven.state, redriven.redrives], ['retry', 1]);
  assert.equal((await maintenance.inspectEventDeliveryAttempts(target, f.policy, failed.eventId)).at(-1)!.operator, 'operator-ada');
  assert.deepEqual(await maintenance.pruneEventDeliveries(target, f.policy, { olderThanMs: 0 }), {
    receipts: 1,
    deliveries: 1,
    more: false,
  });
  await assert.rejects(maintenance.inspectEventDeliveries({ postgres: 'sqlite://nope' } as never, f.policy), EventDeliveryUnavailable);
});

describe('maintenance on PostgreSQL', { skip: liveSkip('postgres', LIVE_PG) }, () => {
  test('the same steps reach a PostgreSQL job store, on the database clock', async (t) => {
    // This run's own database: the reset below drops whole job namespaces.
    const url = await ownedPostgresDatabase();
    const control = await pgControl(url);
    t.after(() => control.end());
    await resetPostgresJobs(control);
    assert.deepEqual(await migratePostgresJobStore(url, policy), { version: 1, migrated: true });
    const manager = new PgConnectionManager(url);
    t.after(() => manager.close());
    const store = await openPostgresJobStore(manager, policy);
    const failing = await store.enqueue(job('failing'), Date.now());
    const [claim] = await store.claim(Date.now());
    await store.fail(failing.id, claim.fence, Date.now(), 'rejected');
    const target = { postgres: url };
    const [redriven] = await maintenance.redriveJobs(target, policy, { ids: [failing.id], operator: 'operator-ada' });
    assert.deepEqual([redriven.state, redriven.redrives], ['retry', 1]);
    assert.equal((await maintenance.inspectJobs(target, policy, { state: 'retry' })).rows.length, 1);
    assert.deepEqual(await maintenance.pruneJobs(target, policy, { olderThanMs: 0 }), { pruned: 0, more: false });
  });
});
