import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { defineService, startService } from '@mistriwork/mistri/testing';
import { createJobRunner, type JobAuthorizationRequest } from '../packages/mistri/src/server/jobs/jobRunner.js';
import { defineJobHandlers, type JobGrant } from '../packages/mistri/src/server/jobs/jobs.js';
import type { JobPolicyInput } from '../packages/mistri/src/adapters/jobs/jobStoreTypes.js';
import { openWebhook } from '../packages/mistri/src/server/webhooks.js';
import { openAnalyticsStore, provisionAnalyticsStore } from '../packages/mistri/src/server/analytics/store.js';
import {
  analyticsSinkJob,
  ANALYTICS_SINK_JOB,
  createHttpAnalyticsSink,
  enqueueAnalyticsSinkJobs,
} from '../packages/mistri/src/server/analytics/sinkHttp.js';
import { jobEngines } from './support/jobStoreEngines.js';
import { scratch } from './support/storeLayouts.js';

const policy: JobPolicyInput = {
  namespace: 'analytics',
  maxAttempts: 3,
  leaseMs: 30_000,
  backoffMs: { base: 100, cap: 1_000 },
  maxInputBytes: 1_024,
  maxInFlight: 4,
};
const binding = { appId: 'shop', deploymentId: 'prod-1' };

for (const engine of jobEngines)
  describe(`analytics sink on ${engine.name} jobs`, { skip: engine.skip }, () => {
    test('retry keeps one key, the cursor moves only after a 2xx, a refusal fails the job and a redrive finishes it', async (t) => {
      const where = await scratch('sqlite', 'analytics-sink');
      await provisionAnalyticsStore({ url: where.url, binding });
      const store = await openAnalyticsStore({ url: where.url, binding });
      const f = await engine.fixture(t, policy);
      const jobs = await f.open();
      t.after(async () => {
        await store.close();
        await where.drop();
      });

      let answer = 503;
      const received: { key: unknown; body: { format: string; events: { id: number; unitId: string | null }[] } }[] = [];
      await using receiver = await startService(
        defineService({
          name: 'warehouse',
          state: {},
          routes: [
            {
              id: 'hook',
              match: { method: 'POST', path: '/hook' },
              reply: ({ rawBody, headers }) => {
                received.push({ key: headers['idempotency-key'], body: JSON.parse(rawBody) });
                return { status: answer };
              },
            },
          ],
        }),
      );
      const sink = createHttpAnalyticsSink({
        id: 'warehouse',
        batch: 500,
        webhook: openWebhook({ kind: 'webhook', name: 'warehouse', url: `${receiver.url}/hook` }),
      });

      const clock = { now: 1_000 };
      const authorize = (request: JobAuthorizationRequest): JobGrant => ({
        audience: 'mistri.jobs',
        job: request.job,
        version: 1,
        appId: 'shop',
        expiresAt: clock.now + 60_000,
      });
      const runner = createJobRunner({
        store: jobs,
        registry: defineJobHandlers({ [ANALYTICS_SINK_JOB]: analyticsSinkJob({ store, sinks: [sink], settleMs: 0 }) }),
        authorize,
        now: () => clock.now,
        attemptTimeoutMs: 5_000,
      });
      t.after(() => runner.halt());
      const enqueue = () => enqueueAnalyticsSinkJobs({ store, jobs, sinks: [sink], appId: 'shop', now: () => clock.now, settleMs: 0 });
      const event = (name: string) => ({
        occurredAt: 500,
        environment: 'prod',
        kind: 'view' as const,
        name,
        unitKind: 'visitor' as const,
        unitId: `v-${name}`,
      });

      assert.equal(await enqueue(), 0, 'nothing to send yet');
      await store.append([event('a'), event('b'), event('c')], 500);
      assert.equal(await enqueue(), 1);
      assert.equal(await enqueue(), 0, 'asking again at the same position enqueues once');

      assert.equal((await runner.tick()).outcomes[0].state, 'retry', 'a 503 is unknown, asked again');
      assert.equal(await store.ensureCursor('warehouse'), 0, 'the cursor did not move');
      clock.now += 1_000;
      answer = 200;
      assert.equal((await runner.tick()).outcomes[0].state, 'succeeded');
      assert.equal(await store.ensureCursor('warehouse'), 3);
      assert.equal(received.length, 2);
      assert.equal(received[0].key, 'analytics:warehouse:1-3');
      assert.equal(received[1].key, received[0].key, 'a retry sends the same key');
      assert.equal(received[1].body.format, 'mistri.analytics.v1');
      assert.deepEqual(
        received[1].body.events.map((row) => row.id),
        [1, 2, 3],
      );
      assert.equal(await enqueue(), 0, 'delivered rows are not sent again');

      await store.append([event('d')], 500);
      answer = 400;
      assert.equal(await enqueue(), 1);
      const refused = (await runner.tick()).outcomes[0];
      assert.deepEqual([refused.state, refused.code], ['failed', 'rejected']);
      assert.equal(await store.ensureCursor('warehouse'), 3, 'a refused batch holds the cursor');
      assert.equal(await enqueue(), 0, 'the failed job still owns this position');

      answer = 200;
      const [failed] = await jobs.inspect({ state: 'failed' }, 10);
      await jobs.redrive(failed.id, 'operator-1', clock.now);
      assert.equal((await runner.tick()).outcomes[0].state, 'succeeded');
      assert.equal(await store.ensureCursor('warehouse'), 4);
      assert.deepEqual(
        received.at(-1)!.body.events.map((row) => row.id),
        [4],
      );
      assert.equal(received.at(-1)!.key, 'analytics:warehouse:4-4');
    });
  });
