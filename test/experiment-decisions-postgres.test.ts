/** Required-live coverage; all roles/databases are UUID-owned by this test. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { liveSkip } from './live.js';
import { FlagManagementDenied, FlagRevisionConflict, type FlagStore } from '../packages/mistri/src/server/flags/store.js';
import { openPostgresFlagStore, provisionPostgresFlagStore } from '../packages/mistri/src/server/flags/storePostgres.js';
import { openPostgresExperimentStore, provisionPostgresExperimentStore } from '../packages/mistri/src/server/experiments/storePostgres.js';
import { createExperimentDecisionManager } from '../packages/mistri/src/server/experiments/decisions.js';
import { type ExperimentEpoch, type ExperimentStore } from '../packages/mistri/src/server/experiments/contracts.js';
import { type FlagAuthorityCatalog } from '../packages/mistri/src/server/flags/authority.js';

interface Client {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
async function connect(url: string): Promise<Client> {
  const module = 'pg';
  const pg = await import(module);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}
const binding = { suiteId: 'suite', deploymentId: 'deployment' };
const scope = { appId: 'app', environment: 'production', tenantId: null };
const allocation = {
  version: 'v1',
  weights: [
    { value: 'a', weight: 50 },
    { value: 'b', weight: 50 },
  ],
};
const catalog: FlagAuthorityCatalog = {
  flags: { copy: { type: 'string', default: 'a', variants: ['a', 'b'], safeValue: 'a', owner: 'product', tenantManaged: true } },
  roles: [],
  audiences: {},
  experiments: { copy: allocation },
};
const controls = { flags: catalog.flags, roles: catalog.roles, audiences: catalog.audiences };
const noop = () => {};

/** A provisioned flag store holding one audited override, as the decision tests start from. */
async function seed(client: Client, options: { url: string; binding: typeof binding }) {
  await provisionPostgresFlagStore(options);
  const before = JSON.stringify({ ...scope, revision: 0, overrides: {} });
  const after = JSON.stringify({ ...scope, revision: 1, overrides: { copy: { experiment: allocation } } });
  await client.query(`INSERT INTO mistri.flag_state VALUES ('suite','deployment','app','production','',1,$1)`, [after]);
  await client.query(
    `INSERT INTO mistri.flag_audit VALUES ('suite','deployment','app','production','',1,'copy','set','actor','Activated',
    '2026-09-30T00:00:00.000Z',NULL,$1,$2,NULL)`,
    [before, after],
  );
}

test(
  'live audited experiment decisions',
  {
    skip: liveSkip('postgres', process.env.TABLEWALK_TEST_PG),
    timeout: 120_000,
  },
  async (t) => {
    const admin = await connect(process.env.TABLEWALK_TEST_PG!);
    const suffix = randomUUID().replaceAll('-', ''),
      role = `tw_decide_${suffix}`,
      password = randomUUID();
    const databases: string[] = [],
      clients: Client[] = [],
      stores: Array<FlagStore | ExperimentStore> = [];
    let roleCreated = false;
    t.after(async () => {
      try {
        await Promise.all(stores.map((store) => store.close()));
        await Promise.all(clients.map((client) => client.end()));
        for (const database of databases) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
        if (roleCreated) await admin.query(`DROP ROLE "${role}"`);
      } finally {
        await admin.end();
      }
    });
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    roleCreated = true;
    const database = async (label: string) => {
      const name = `tw_decide_${label}_${suffix}`;
      await admin.query(`CREATE DATABASE "${name}" OWNER "${role}" TEMPLATE template0`);
      databases.push(name);
      const url = new URL(process.env.TABLEWALK_TEST_PG!);
      url.pathname = `/${name}`;
      url.username = role;
      url.password = password;
      for (const key of ['user', 'password', 'dbname', 'database']) url.searchParams.delete(key);
      const options = { url: url.href, binding },
        client = await connect(options.url);
      clients.push(client);
      return { options, client };
    };
    const legacy = await database('legacy');
    await seed(legacy.client, legacy.options);

    const flags = await openPostgresFlagStore(legacy.options);
    stores.push(flags);
    assert.equal((await flags.read(scope, controls)).revision, 1);
    assert.equal((await flags.history(scope, controls, { flagId: 'copy' })).entries[0].operation, 'set');
    await assert.rejects(legacy.client.query('DELETE FROM mistri.flag_audit'), /append-only/);
    await assert.rejects(legacy.client.query('UPDATE mistri.flag_binding SET version=2'), /append-only/);

    const resultsDb = await database('results');
    const resultOptions = { ...resultsDb.options, binding: { ...binding, deploymentId: 'separate-evidence-deployment' } };
    await provisionPostgresExperimentStore(resultOptions);
    const experiments = await openPostgresExperimentStore(resultOptions);
    stores.push(experiments);
    const now = Date.now();
    const declaration: ExperimentEpoch = {
      scope: { appId: 'app', environment: 'production', controlTenantId: null, evaluationTenantId: null },
      flagId: 'copy',
      owner: 'product',
      version: 'v1',
      unit: 'subject',
      control: 'a',
      arms: [
        { id: 'a', value: 'a', weight: 50 },
        { id: 'b', value: 'b', weight: 50 },
      ],
      eligibility: { rollout: 100, audiences: {} },
      startsAtMs: now - 100_000,
      endsAtMs: now - 10_000,
      conversionWindowMs: 1000,
      deliveryGraceMs: 100,
      primary: { id: 'submitted', event: 'submitted', eventVersion: 1, unitField: 'actorId' },
      guardrails: [],
    };
    const epoch = await experiments.registerEpoch(declaration, noop);
    for (const arm of ['a', 'b'])
      for (let index = 0; index < 12; index++) {
        await experiments.ingestExposure(epoch, { unit: { kind: 'subject', id: `${arm}-${index}` }, arm, usedAtMs: now - 50_000 }, noop);
      }
    const result = await experiments.publishResults(
      epoch,
      {
        expectedDataRevision: await experiments.readDataRevision(epoch),
        delivery: { throughMs: now, pending: 0, failed: 0, incomplete: 0 },
      },
      noop,
    );
    assert.equal(result.statistics.status, 'final-evidence');
    const request = {
      tenantId: null,
      flagId: 'copy',
      epochFingerprint: epoch.fingerprint,
      expectedRevision: 1,
      expectedResultRevision: result.evidenceRevision,
      winnerVariant: 'b',
      reason: 'Apply winner',
    } as const;
    const manager = (store: FlagStore, observe = noop) =>
      createExperimentDecisionManager({
        ...scope,
        catalog,
        epochs: [declaration],
        flags: store,
        experiments,
        authorize: (auth) => {
          assert.equal(auth.operation, 'decide');
          assert.deepEqual(auth.requiredCapabilities, ['flags.manage', 'experiments.manage', 'experiments.decide']);
          return { actorId: 'subject', reobserve: observe };
        },
      });

    await t.test(
      'pending final authority revocation rolls back both decision audit and fixed override; writer locks retain triggers',
      async () => {
        let entered!: () => void,
          release!: () => void,
          revoked = false;
        const ready = new Promise<void>((resolve) => {
            entered = resolve;
          }),
          hold = new Promise<void>((resolve) => {
            release = resolve;
          });
        const wrapped: FlagStore = {
          ...flags,
          mutate: (change, guard) =>
            flags.mutate(change, async () => {
              entered();
              await hold;
              await guard();
            }),
        };
        const pending = manager(wrapped, () => {
          if (revoked) throw new FlagManagementDenied();
        }).decide(request);
        await Promise.race([
          ready,
          pending.then(() => {
            throw Error('Final fence was not reached');
          }),
        ]);
        try {
          await legacy.client.query("SET lock_timeout='50ms'");
          await assert.rejects(
            legacy.client.query('ALTER TABLE mistri.flag_audit DISABLE TRIGGER flag_audit_immutable'),
            (error: unknown) => (error as { code?: string }).code === '55P03',
          );
          revoked = true;
        } finally {
          release();
          await legacy.client.query('RESET lock_timeout');
        }
        await assert.rejects(pending, FlagManagementDenied);
        assert.equal((await flags.read(scope, controls)).revision, 1);
        assert.equal((await flags.history(scope, controls, { flagId: 'copy' })).entries.length, 1);
        assert.equal((await experiments.decisions(epoch, { limit: 10 })).entries.length, 1, 'orphan evidence grants no flag mutation');
      },
    );

    await t.test('trusted enclosing Console fence is observed inside the real decision transaction', async () => {
      let inTransaction = false;
      const wrapped: FlagStore = {
        ...flags,
        mutate: (change, guard) =>
          flags.mutate(change, async () => {
            inTransaction = true;
            await guard();
          }),
      };
      await assert.rejects(
        manager(wrapped).decide(request, () => {
          if (inTransaction) throw new FlagManagementDenied();
        }),
        FlagManagementDenied,
      );
      assert.equal(inTransaction, true);
      assert.equal((await flags.read(scope, controls)).revision, 1);
      assert.deepEqual(
        (await flags.history(scope, controls, { flagId: 'copy' })).entries.map((entry) => entry.operation),
        ['set'],
      );
    });

    await t.test('decision evidence and winner commit together; uncertain acknowledgement never causes a retry', async () => {
      let calls = 0;
      const wrapped: FlagStore = {
        ...flags,
        async mutate(change, guard) {
          calls++;
          await flags.mutate(change, guard);
          // Lose acknowledgement after a real PostgreSQL commit. The service must
          // surface uncertainty without issuing a second mutation.
          throw Error('Unknown commit outcome');
        },
      };
      await assert.rejects(manager(wrapped).decide(request), /Unknown commit outcome/);
      assert.equal(calls, 1);
      const snapshot = await flags.read(scope, controls);
      assert.equal(snapshot.revision, 2);
      assert.deepEqual(snapshot.overrides.copy, { value: 'b' });
      const audit = (await flags.history(scope, controls, { flagId: 'copy' })).entries[0];
      assert.equal(audit.operation, 'decide');
      assert.deepEqual(audit.evidence, {
        epochFingerprint: epoch.fingerprint,
        resultsRevision: result.evidenceRevision,
        winnerVariant: 'b',
      });
      assert.equal(audit.before.overrides.copy.experiment?.version, 'v1');
      await assert.rejects(manager(flags).decide(request), FlagRevisionConflict);
      await assert.rejects(
        legacy.client.query("UPDATE mistri.flag_audit SET decision_evidence=NULL WHERE operation='decide'"),
        /append-only/,
      );
    });

    await t.test('late corrected evidence requires a new decision and leaves old evidence references intact', async () => {
      await experiments.ingestConversion(
        epoch,
        {
          unit: { kind: 'subject', id: 'b-0' },
          source: 'business',
          eventId: 'event-1',
          event: 'submitted',
          eventVersion: 1,
          metric: 'submitted',
          occurredAtMs: now - 49_500,
        },
        noop,
      );
      const corrected = await experiments.publishResults(
        epoch,
        {
          expectedDataRevision: await experiments.readDataRevision(epoch),
          delivery: { throughMs: now, pending: 0, failed: 0, incomplete: 0 },
        },
        noop,
      );
      await manager(flags).decide({
        ...request,
        expectedRevision: 2,
        expectedResultRevision: corrected.evidenceRevision,
        winnerVariant: 'a',
      });
      const history = (await flags.history(scope, controls, { flagId: 'copy' })).entries;
      assert.deepEqual(
        history.map((entry) => entry.operation),
        ['decide', 'decide', 'set'],
      );
      assert.equal(history[0].evidence?.resultsRevision, corrected.evidenceRevision);
      assert.equal(history[1].evidence?.resultsRevision, result.evidenceRevision);
      assert.deepEqual((await flags.read(scope, controls)).overrides.copy, { value: 'a' });
    });
  },
);
