/**
 * Row-driven flows (PREVIEW): the binding as an author writes it, the rows
 * as a write judges them, the plan a run follows, which change starts which
 * flow, and the host's tail of the record history. The whole chain through
 * a real host is flows-host.test.ts; Depot's, in a browser, e2e/flows.spec.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FLOW_REASONS,
  flowPlan,
  flowRowBreaks,
  flowsProblem,
  flowTriggered,
  parseFlows,
  stepRowBreaks,
  type FlowRecordShape,
} from '../packages/mistri/src/shared/appFlows.js';
import { createFlowTail, type FlowChange } from '../packages/mistri/src/server/workflows/flowTail.js';
import { parseAppConfig, resolveResources } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { JobStore } from '../packages/mistri/src/adapters/jobs/jobStoreContract.js';

const binding = parseFlows(
  {
    from: 'po_flow',
    steps: 'po_flow_step',
    set: ['notes'],
    events: { 'po.decided': 'order' },
    kinds: {
      approval: { command: 'requestApproval', input: ['approver', 'note?'], waitFor: 'po.decided' },
      send: { command: 'sendPurchaseOrder' },
    },
  },
  'resources "purchase_order"',
);
const record: FlowRecordShape = {
  columns: new Set(['id', 'status', 'draft_value', 'notes', 'expected_on']),
  dates: new Set(['expected_on']),
  condition: (text) => /^(status|draft_value|notes) (=|>|<) \S+$/.test(text),
};
const table = (name: string, columns: string[], key = 'id') => ({
  name,
  columns: columns.map((column) => ({ name: column, primaryKey: column === key })),
});

test('a binding is read for its shape, and refused in the words an author reads', () => {
  assert.deepEqual(binding.kinds?.approval, { command: 'requestApproval', input: ['approver', 'note?'], waitFor: 'po.decided' });
  const refused = (raw: unknown) => assert.throws(() => parseFlows(raw, 'resources "po"'), Error);
  refused('po_flow');
  refused({ from: 'po_flow' });
  refused({ from: 'po_flow', steps: 'po_flow_step', extra: 1 });
  refused({ from: 'po_flow', steps: 'po_flow_step', kinds: { wait: { command: 'x' } } });
  refused({ from: 'po_flow', steps: 'po_flow_step', kinds: { send: { command: 'x', waitFor: 'po.decided' } } });
  refused({ from: 'po_flow', steps: 'po_flow_step', events: { 'po.decided': 'order id' } });
});

test('a binding runs only on a catalog with the fixed columns, a single key and the kinds’ inputs', () => {
  const po = table('purchase_order', ['id', 'status', 'notes']);
  const flows = table('po_flow', ['id', 'name', 'start', 'condition']);
  const steps = table('po_flow_step', ['id', 'flow_id', 'position', 'kind', 'approver', 'note']);
  assert.equal(flowsProblem(binding, po, flows, steps, 'status'), undefined);
  assert.match(flowsProblem(binding, po, table('po_flow', ['id', 'name']), steps)!, /"start"/);
  assert.match(flowsProblem(binding, po, flows, table('po_flow_step', ['id', 'flow_id', 'position', 'kind', 'note']))!, /takes "approver"/);
  assert.match(flowsProblem({ ...binding, set: ['status'] }, po, flows, steps, 'status')!, /state column/);
  assert.match(flowsProblem(binding, po, undefined, steps)!, /not a declared resource/);
});

test('rows are judged as they are written: each break by its column, in fixed words', () => {
  assert.deepEqual(flowRowBreaks({ name: 'Large', start: 'created', condition: 'draft_value > 5000' }, record), []);
  assert.deepEqual(
    flowRowBreaks({ name: '', start: 'sometimes', condition: 'total > 5', changes: 'nope' }, record).map((each) => each.field),
    ['name', 'start', 'condition', 'changes'],
  );
  const breaks = (row: Record<string, unknown>) =>
    stepRowBreaks({ flow_id: 1, position: 2, ...row }, binding, record).map((each) => `${each.field}:${each.reason}`);
  assert.deepEqual(breaks({ kind: 'wait', duration: '2 hours' }), []);
  assert.deepEqual(breaks({ kind: 'wait', duration: 'soon' }), ['duration:duration']);
  assert.deepEqual(breaks({ kind: 'wait', duration: '2 years' }), ['duration:duration'], 'longer than the engine waits');
  assert.deepEqual(breaks({ kind: 'until', field: 'status' }), ['field:dateField']);
  assert.deepEqual(breaks({ kind: 'branch', condition: 'status = draft', goto: 1 }), ['goto:goto'], 'a branch only jumps forward');
  assert.deepEqual(breaks({ kind: 'set', field: 'status', value: 'sent' }), ['field:setField']);
  assert.deepEqual(breaks({ kind: 'waitFor', event: 'po.other' }), ['event:event']);
  assert.deepEqual(breaks({ kind: 'approval' }), ['approver:input'], "an optional input ('note?') may be empty");
  assert.deepEqual(breaks({ kind: 'teleport' }), ['kind:kind']);
  assert.deepEqual(
    stepRowBreaks({ position: -1, kind: 'send' }, binding, record).map((each) => each.field),
    ['flow_id', 'position'],
  );
  assert.equal(FLOW_REASONS.kind, 'Choose one of the step kinds this App offers.');
  // A notify step names an audience a `notify` rule on the record tells (`on: { flow }`), and says its words.
  const told = { ...record, audiences: new Set(['buyer']) };
  const notify = (row: Record<string, unknown>) =>
    stepRowBreaks({ flow_id: 1, position: 2, kind: 'notify', ...row }, binding, told).map((each) => `${each.field}:${each.reason}`);
  assert.deepEqual(notify({ audience: 'buyer', message: 'Approved.' }), []);
  assert.deepEqual(notify({ audience: 'nobody', message: 'x'.repeat(501) }), ['audience:audience', 'message:message']);
  assert.deepEqual(
    breaks({ kind: 'notify', audience: 'buyer', message: 'x' }),
    ['audience:audience'],
    'a record no rule tells about has no audience',
  );
  assert.deepEqual(
    flowPlan({ id: 1, name: 'x' }, [{ flow_id: 1, position: 1, kind: 'notify', audience: 'buyer', message: ' Approved. ' }], binding, told)
      .steps,
    [{ position: 1, kind: 'notify', audience: 'buyer', message: 'Approved.' }],
  );
});

test("a flow's rows become its plan in position order; the first row it cannot run stops it, saying why", () => {
  const flow = { id: 3, name: 'Large order approval' };
  const plan = flowPlan(
    flow,
    [
      { flow_id: 3, position: 3, kind: 'send', title: 'Send it' },
      { flow_id: 3, position: 1, kind: 'approval', approver: 'Manager' },
      { flow_id: 3, position: 2, kind: 'branch', condition: 'status = draft' },
    ],
    binding,
    record,
  );
  assert.equal(plan.problem, undefined);
  assert.deepEqual(plan.steps, [
    {
      position: 1,
      kind: 'command',
      name: 'approval',
      command: 'requestApproval',
      input: { approver: 'Manager' },
      waitFor: { event: 'po.decided', field: 'order' },
    },
    { position: 2, kind: 'branch', condition: 'status = draft' },
    { position: 3, title: 'Send it', kind: 'command', name: 'send', command: 'sendPurchaseOrder', input: {} },
  ]);
  assert.deepEqual(flowPlan(flow, [{ flow_id: 3, position: 1, kind: 'wait', duration: 'soon' }], binding, record).problem, {
    position: 1,
    reason: `duration: ${FLOW_REASONS.duration}`,
  });
  // Two steps at one position start together (flow-runner.test.ts): each knows its place among them.
  assert.deepEqual(
    flowPlan(
      flow,
      [
        { id: 2, flow_id: 3, position: 1, kind: 'send' },
        { id: 1, flow_id: 3, position: 1, kind: 'send', title: 'First' },
      ],
      binding,
      record,
    ).steps.map((step) => [step.position, step.member, step.title]),
    [
      [1, 1, 'First'],
      [1, 2, undefined],
    ],
  );
});

test('a change starts the flows whose start it is, an update only when it changed their column, a manual one by its id', () => {
  const created = { id: 1, start: 'created' };
  const watched = { id: 2, start: 'updated', changes: 'status' };
  const manual = { id: 3, start: 'manual' };
  assert.equal(flowTriggered(created, { trigger: 'created', changed: ['status'] }), true);
  assert.equal(flowTriggered(created, { trigger: 'updated', changed: ['status'] }), false);
  assert.equal(flowTriggered(watched, { trigger: 'updated', changed: ['notes'] }), false);
  assert.equal(flowTriggered(watched, { trigger: 'updated', changed: ['notes', 'status'] }), true);
  assert.equal(flowTriggered(manual, { trigger: 'created', changed: [] }), false);
  assert.equal(flowTriggered(manual, { trigger: 'manual', changed: [], flow: '3' }), true);
  assert.equal(flowTriggered(manual, { trigger: 'manual', changed: [], flow: '4' }), false);
});

test("the host's tail dispatches each change once, skips a flow's own, and passes a row only once it has settled", async () => {
  let now = 1_000_000_000_000;
  const history: FlowChange[] = [];
  const reads: Array<{ after?: number; from?: string }> = [];
  const enqueued: Array<{ idempotencyKey: string; input: unknown }> = [];
  const change = (id: number, at: number, byFlow = false): FlowChange => ({
    id,
    at,
    workflow: 'purchaseFlows',
    runAs: 'automation',
    byFlow,
    dispatch: { record: `{"id":"${id}"}`, target: String(id), trigger: 'created', changed: ['status'] },
  });
  const tail = createFlowTail({
    read: async (query) => {
      reads.push(query);
      return history.filter((row) => row.id > (query.after ?? 0)).slice(0, 200);
    },
    jobs: { enqueue: async (request: { idempotencyKey: string; input: unknown }) => void enqueued.push(request) } as unknown as JobStore,
    appId: 'depot',
    now: () => now,
  });
  history.push(change(1, now - 120_000), change(2, now - 1_000), change(3, now - 500, true));
  assert.equal(await tail.tick(), true);
  assert.ok(reads[0].from && reads[0].after === undefined, 'the first read looks back a day');
  assert.deepEqual(
    enqueued.map((each) => each.idempotencyKey),
    ['flow-change-000000000001', 'flow-change-000000000002'],
    "a flow's own change starts nothing",
  );
  assert.deepEqual((enqueued[0].input as { dispatch: { change: string } }).dispatch.change, 'h1');
  // Row 2 is not settled: the cursor stays at row 1, and row 2, seen, is not dispatched again.
  assert.equal(await tail.tick(), false);
  assert.deepEqual(reads[1], { after: 1 });
  assert.equal(enqueued.length, 2);
  now += 120_000;
  await tail.tick();
  history.push(change(4, now));
  await tail.tick();
  assert.deepEqual(reads.at(-1), { after: 3 });
  assert.deepEqual(enqueued.map((each) => each.idempotencyKey).at(-1), 'flow-change-000000000004');
  assert.equal(enqueued.length, 3);
});

test("a diagram is drawn on a flow's page or a running record's, and both tables are told the steps table (G48)", () => {
  const app = (base: string) =>
    parseAppConfig(
      {
        name: 'Orders',
        resources: {
          purchase_order: {
            flows: {
              from: 'po_flow',
              steps: 'po_flow_step',
              events: { 'po.decided': 'order' },
              kinds: { approval: { command: 'requestApproval', waitFor: 'po.decided' }, send: { command: 'sendPurchaseOrder' } },
            },
          },
          po_flow: {},
          po_flow_step: {},
          po_flow_note: {},
        },
        views: { orders: { kind: 'list', from: 'purchase_order' } },
        home: 'orders',
        pages: { flow: { base, sections: [{ kind: 'fields', show: ['name'] }, { kind: 'diagram' }] } },
      },
      'diagram fixture',
    );
  assert.throws(
    () => app('po_flow_note'),
    /a diagram draws a flow's steps, on the page of a flow or of a record that runs them; po_flow_note is no resource's flows "from" and declares no flows/,
  );
  // On the page of a record that runs flows it draws that record's run.
  assert.doesNotThrow(() => app('purchase_order'));
  const columns = (names: string[]) => names.map((name) => ({ name, type: 'TEXT', nullable: name !== 'id', primaryKey: name === 'id' }));
  const schema: DatabaseSchema = {
    label: 'Orders',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      { id: 'purchase_order', name: 'purchase_order', schema: '', isView: false, columns: columns(['id', 'status']) },
      { id: 'po_flow', name: 'po_flow', schema: '', isView: false, columns: columns(['id', 'name', 'start']) },
      { id: 'po_flow_step', name: 'po_flow_step', schema: '', isView: false, columns: columns(['id', 'flow_id', 'position', 'kind']) },
    ],
  };
  const served = resolveResources(app('po_flow'), schema).resources;
  // An approval waits for a word; a send only runs: the diagram marks each as what it does.
  const kinds = { approval: 'asks', send: 'runs' };
  assert.deepEqual(served.po_flow?.flowDiagram, { steps: 'po_flow_step', kinds });
  assert.deepEqual(served.purchase_order?.flowDiagram, { steps: 'po_flow_step', kinds, run: true });
  // A binding that cannot run on this catalog points no page at its steps.
  const broken = {
    ...schema,
    tables: schema.tables
      .filter((table) => table.id !== 'po_flow_step')
      .concat({ ...schema.tables[2], columns: columns(['id', 'flow_id']) }),
  };
  assert.equal(resolveResources(app('po_flow'), broken).resources.po_flow?.flowDiagram, undefined);
  assert.equal(resolveResources(app('po_flow'), broken).resources.purchase_order?.flowDiagram, undefined);
});
