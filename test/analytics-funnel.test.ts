import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveSkip } from './live.js';
import { normalizeAnalytics } from '../packages/mistri/src/shared/appAnalytics.js';
import { openAnalyticsStore, provisionAnalyticsStore, type AnalyticsEventInput } from '../packages/mistri/src/server/analytics/store.js';
import { runFunnel } from '../packages/mistri/src/server/analytics/funnel.js';
import { inspectFunnel } from '../packages/mistri/src/server/maintenance.js';
import { ENGINES, LIVE, scratch, type Engine } from './support/storeLayouts.js';

const binding = { appId: 'shop', deploymentId: 'prod-1' };
const HOUR = 3_600_000,
  FROM = 1000,
  TO = 10_000_000;
const declared = normalizeAnalytics(
  {
    collect: ['views', 'commands'],
    events: { done: { fields: [] } },
    funnels: {
      short: { unit: 'visitor', conversionWindow: '1 hour', steps: [{ view: 'vehicles' }, { command: 'close' }, { event: 'done' }] },
      long: { unit: 'visitor', conversionWindow: '8760 hours', steps: [{ view: 'vehicles' }, { command: 'close' }] },
      account: { unit: 'subject', conversionWindow: '1 hour', steps: [{ view: 'vehicles' }, { form: 'apply', step: 'contact' }] },
    },
  },
  'test',
).funnels!;

const at = (
  unit: string | null,
  kind: AnalyticsEventInput['kind'],
  name: string,
  occurredAt: number,
  extra: Partial<AnalyticsEventInput> = {},
): AnalyticsEventInput => ({ occurredAt, environment: 'prod', kind, name, unitKind: unit ? 'visitor' : null, unitId: unit, ...extra });
const view = (u: string | null, t: number, x?: Partial<AnalyticsEventInput>) => at(u, 'view', 'vehicles', t, x);
const close = (u: string | null, t: number, step = 'ran', x?: Partial<AnalyticsEventInput>) => at(u, 'action', 'close', t, { step, ...x });
const done = (u: string, t: number) => at(u, 'event', 'done', t);

const EVENTS: AnalyticsEventInput[] = [
  // u1 completes in order.
  view('u1', 1000),
  close('u1', 2000),
  done('u1', 3000),
  // u2 closed before it looked: out of order, so it never reaches step 2.
  close('u2', 500),
  view('u2', 1000),
  done('u2', 2000),
  // u3 closes exactly at the window's edge (kept) and finishes just past it (not kept).
  view('u3', 1000),
  close('u3', 1000 + HOUR),
  done('u3', 1010 + HOUR),
  // u4 closes one millisecond past the window.
  view('u4', 1000),
  close('u4', 1001 + HOUR),
  // No unit: counted nowhere in a funnel.
  view(null, 1000),
  close(null, 2000),
  // Before the window opens.
  view('u6', 999),
  close('u6', 2000),
  // A refusal is not a run.
  view('u7', 1000),
  close('u7', 2000, 'refused'),
  // Two tenants.
  view('u8', 1000, { tenantId: 't1' }),
  close('u8', 2000, 'ran', { tenantId: 't1' }),
  view('u9', 1000, { tenantId: 't2' }),
  // The same millisecond: the id orders them.
  view('u10', 5000),
  close('u10', 5000),
  // A step at `to` is outside [from, to); one just before it is inside, given a long window.
  view('u11', 1000),
  close('u11', TO),
  view('u12', 1000),
  close('u12', TO - 1),
];

for (const engine of ENGINES as readonly Engine[]) {
  const skip = engine === 'postgres' ? liveSkip('postgres', LIVE) : false;
  test(`${engine}: funnels count units, in order, inside the window`, { skip }, async (t) => {
    const where = await scratch(engine, 'analytics-funnel');
    try {
      await provisionAnalyticsStore({ url: where.url, binding });
      const store = await openAnalyticsStore({ url: where.url, binding });
      try {
        for (const event of EVENTS) await store.append([event]);
        // Subject-unit rows for the third funnel.
        await store.append([
          { occurredAt: 1000, environment: 'prod', kind: 'view', name: 'vehicles', unitKind: 'subject', unitId: 's1' },
          { occurredAt: 2000, environment: 'prod', kind: 'form', name: 'apply', step: 'contact', unitKind: 'subject', unitId: 's1' },
          { occurredAt: 1500, environment: 'prod', kind: 'view', name: 'vehicles', unitKind: 'subject', unitId: 's2' },
        ]);
        const units = (result: Awaited<ReturnType<typeof runFunnel>>) => result.steps.map((step) => step.units);

        await t.test('window edges, order, refusals and unit-less rows', async () => {
          const result = await runFunnel(store, declared.short, { fromMs: FROM, toMs: TO });
          assert.deepEqual(units(result), [10, 4, 1]);
          assert.equal(result.steps[1].fromPrevious, 0.4);
          assert.equal(result.steps[2].fromStart, 0.1);
          assert.equal(result.steps[0].label, 'view vehicles');
        });
        await t.test('the interval is half open: a step at `to` is outside, one before it is inside', async () => {
          const result = await runFunnel(store, declared.long, { fromMs: FROM, toMs: TO });
          // u1, u3, u4, u8, u10 and u12 close in order; u11 closes at `to`.
          assert.deepEqual(units(result), [10, 6]);
        });
        await t.test('a tenant is counted on its own', async () => {
          assert.deepEqual(units(await runFunnel(store, declared.short, { fromMs: FROM, toMs: TO, tenantId: 't1' })), [1, 1, 0]);
          assert.deepEqual(units(await runFunnel(store, declared.short, { fromMs: FROM, toMs: TO, tenantId: 't2' })), [1, 0, 0]);
          assert.deepEqual(units(await runFunnel(store, declared.short, { fromMs: FROM, toMs: TO, tenantId: 'nobody' })), [0, 0, 0]);
        });
        await t.test('a funnel reads only its own unit kind, and form steps match by step id', async () => {
          assert.deepEqual(units(await runFunnel(store, declared.account, { fromMs: FROM, toMs: TO })), [2, 1]);
        });
        await t.test('the maintenance entry opens the store and counts the same', async () => {
          const result = await inspectFunnel({ url: where.url, binding }, declared.short, { from: new Date(FROM), to: new Date(TO) });
          assert.deepEqual(units(result), [10, 4, 1]);
        });
        await t.test('an empty or inverted window is refused', async () => {
          await assert.rejects(runFunnel(store, declared.short, { fromMs: TO, toMs: FROM }), /from before to/);
        });
      } finally {
        await store.close();
      }
    } finally {
      await where.drop();
    }
  });
}
