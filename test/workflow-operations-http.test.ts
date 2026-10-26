/**
 * The workflows room's routes (PREVIEW): the grant gates every one, the
 * answers carry the store's inspection shape and nothing else, and Cancel and
 * Retry go through the operator over a real store (the engine's own cases are
 * workflow-engine.test.ts).
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { defineEvent } from '../packages/mistri/src/server/commands/businessEvents.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { defineWorkflow, StepRefused } from '../packages/mistri/src/server/workflows.js';
import { createWorkflowDriver } from '../packages/mistri/src/server/testing/workflows.js';
import { createWorkflowOperator } from '../packages/mistri/src/server/workflows/workflowOperator.js';
import {
  workflowOperationsReply,
  workflowOperationsRoute,
  WORKFLOW_PAGE,
} from '../packages/mistri/src/server/operations/workflowOperationsHttp.js';
import type { JobStore } from '../packages/mistri/src/adapters/jobs/jobStoreContract.js';

const app = parseAppConfig(
  {
    name: 'Ops',
    resources: { loan: {} },
    home: 'loans',
    views: { loans: { kind: 'list', from: 'loan' } },
    auth: { roles: { operator: { operations: ['workflows'] }, reader: { operations: ['readiness'] } } },
  },
  'ops.ts',
);
const Applied = defineEvent('loan.applied', shape({ id: text() }));
const loan = defineWorkflow({
  runAs: 'underwriter',
  start: { event: Applied, key: (event) => event.id },
  async run(w, start) {
    await w.sleep('cool-off', '1 hour');
    return w.run('approve', 'approveLoan', { target: start.id });
  },
});

describe('the workflows operations routes', async () => {
  const enqueued: unknown[] = [];
  let refuse = true;
  const driver = await createWorkflowDriver({
    workflow: { loan },
    commands: {
      approveLoan: () => {
        if (refuse) throw new StepRefused('approve', 'conflict');
        return {};
      },
    },
  });
  after(() => driver.close());
  const operator = createWorkflowOperator({
    workflows: driver.store,
    jobs: {
      enqueue: async (job: unknown) => {
        enqueued.push(job);
      },
    } as unknown as JobStore,
    appId: 'ops',
    now: driver.now,
  });
  const actor = { id: 'user-1', roles: ['operator'] };
  const ask = (
    route: Parameters<typeof workflowOperationsReply>[0]['route'],
    extra: Partial<Parameters<typeof workflowOperationsReply>[0]> = {},
  ) =>
    workflowOperationsReply({
      app,
      route,
      method: route === 'list' || route === 'steps' ? 'GET' : 'POST',
      actor,
      operator,
      query: new URLSearchParams(),
      body: {},
      ...extra,
    });

  test('routes are named, and nothing else is one', () => {
    assert.equal(workflowOperationsRoute('/api/operations/workflows'), 'list');
    assert.equal(workflowOperationsRoute('/api/operations/workflows/retry'), 'retry');
    assert.equal(workflowOperationsRoute('/api/operations/workflows/toString'), undefined);
    assert.equal(workflowOperationsRoute('/api/operations/readiness'), undefined);
  });

  test('a role without the grant is refused on every route, whatever else it holds', async () => {
    for (const route of ['list', 'steps', 'cancel', 'retry'] as const) {
      const reply = await ask(route, { actor: { id: 'user-2', roles: ['reader'] } });
      assert.deepEqual(reply, { status: 403, body: { ok: false, error: 'not_authorized' } });
    }
    assert.equal((await ask('list', { actor: { id: 'user-3', roles: [] } })).status, 403);
  });

  test('a host without workflows answers 404, and a wrong method 405', async () => {
    assert.equal((await ask('list', { operator: undefined })).status, 404);
    assert.equal((await ask('list', { method: 'POST' })).status, 405);
    assert.equal((await ask('cancel', { method: 'GET' })).status, 405);
  });

  test('lists a failed instance with ISO times, and filters by state', async () => {
    await driver.emit(Applied, { id: 'L-1' });
    await driver.advance(3_600_000);
    const all = await ask('list');
    assert.equal(all.status, 200);
    const [row] = all.body.instances as Array<Record<string, unknown>>;
    assert.equal(row.state, 'failed');
    assert.equal(row.key, 'L-1');
    assert.equal(row.problemStep, 'approve');
    assert.match(String(row.createdAt), /^\d{4}-\d\d-\d\dT/);
    assert.equal(Object.hasOwn(row, 'startJson'), false);
    assert.equal((await ask('list', { query: new URLSearchParams({ state: 'completed' }) })).body.instances instanceof Array, true);
    assert.deepEqual((await ask('list', { query: new URLSearchParams({ state: 'completed' }) })).body.instances, []);
    for (const bad of ['state=bogus', 'limit=0', `limit=${WORKFLOW_PAGE + 1}`, 'limit=x', 'workflow=a b', 'after=nope']) {
      assert.deepEqual(
        await ask('list', { query: new URLSearchParams(bad) }),
        { status: 400, body: { ok: false, error: 'invalid_request' } },
        bad,
      );
    }
  });

  test('steps show the history, and refuse an id that is not one', async () => {
    const id = String(((await ask('list')).body.instances as Array<{ id: string }>)[0].id);
    const steps = await ask('steps', { query: new URLSearchParams({ id }) });
    assert.equal(steps.status, 200);
    assert.deepEqual(
      (steps.body.steps as Array<{ name: string }>).map((step) => step.name),
      ['cool-off', 'approve'],
    );
    assert.equal((await ask('steps', { query: new URLSearchParams({ id: 'nope' }) })).status, 400);
    assert.equal((await ask('steps')).status, 400);
  });

  test('Retry re-runs a failed instance and wakes it; Retry of a completed one is refused', async () => {
    const id = String(((await ask('list')).body.instances as Array<{ id: string }>)[0].id);
    refuse = false;
    const retried = await ask('retry', { body: { id } });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(enqueued.length, 1);
    await driver.resume(id);
    assert.equal(((await ask('list')).body.instances as Array<{ state: string }>)[0].state, 'completed');
    assert.deepEqual(await ask('retry', { body: { id } }), { status: 409, body: { ok: false, error: 'not_retryable' } });
    assert.equal(enqueued.length, 1, 'a refused retry enqueues nothing');
  });

  test('Retry of a waiting instance wakes it where it is, its steps kept', async () => {
    refuse = true;
    await driver.emit(Applied, { id: 'L-3' });
    const id = String(((await ask('list')).body.instances as Array<{ id: string; key: string }>).find((row) => row.key === 'L-3')!.id);
    const before = enqueued.length;
    const woken = await ask('retry', { body: { id } });
    assert.equal(woken.status, 200, JSON.stringify(woken.body));
    assert.equal((woken.body.instance as { state: string }).state, 'waiting');
    assert.equal(enqueued.length, before + 1, 'its wake-up is enqueued');
    const steps = await ask('steps', { query: new URLSearchParams({ id }) });
    assert.deepEqual(
      (steps.body.steps as Array<{ name: string }>).map((step) => step.name),
      ['cool-off'],
    );
    // An early wake re-reads the timer and waits again: nothing is taken twice.
    await driver.resume(id);
    assert.equal(
      ((await ask('list')).body.instances as Array<{ key: string; state: string }>).find((row) => row.key === 'L-3')!.state,
      'waiting',
    );
  });

  test('Cancel ends a live instance once, and says so the second time', async () => {
    refuse = true;
    await driver.emit(Applied, { id: 'L-2' });
    const id = String(((await ask('list')).body.instances as Array<{ id: string; key: string }>).find((row) => row.key === 'L-2')!.id);
    const first = await ask('cancel', { body: { id } });
    assert.equal(first.status, 200);
    assert.deepEqual({ outcome: first.body.outcome, state: first.body.state }, { outcome: 'cancelled', state: 'cancelled' });
    assert.equal((await ask('cancel', { body: { id } })).body.outcome, 'unchanged');
    assert.equal((await ask('cancel', { body: { id: '00000000-0000-4000-8000-000000000000' } })).status, 404);
    assert.equal((await ask('cancel', { body: {} })).status, 400);
  });
});
