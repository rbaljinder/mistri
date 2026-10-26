/**
 * A page's diagram section: a flow's steps read by its own id, each position
 * a column in order, the steps sharing one stacked as lanes, a branch's other
 * way drawn to its goto or to the end, each step marked by its kind; on a
 * record's page, the record's run drawn over its flow's steps; the drawing a
 * list in order, which is its text alternative; and a flow with no steps, a
 * record with no run, or a preview, saying so.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { ServedFlowDiagram } from '../../../../mistri/src/shared/app.js';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import type { PageSection } from './pageModel.js';
import type { FlowRun } from './PageFlows.js';
import { FlowDiagram, layoutDiagram, diagramSteps, runStates } from './PageFlowDiagram.js';
import { SectionBox } from './PageSectionBox.js';

const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
let rows: Record<string, unknown>[] = [];
let runs: FlowRun[] = [];

const table = (id: string, names: string[]): TableMeta => ({
  id,
  name: id,
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: names.map((name) => ({ name, type: 'TEXT', nullable: name !== 'id', primaryKey: name === 'id' })) as TableMeta['columns'],
});
const flow = table('po_flow', ['id', 'name', 'start']);
const order = table('purchase_order', ['id', 'status']);
const steps = table('po_flow_step', ['id', 'flow_id', 'position', 'kind', 'title', 'goto', 'condition']);
const kinds: ServedFlowDiagram['kinds'] = { approval: 'asks', send: 'runs' };

const api = async (path: string, body: Record<string, unknown>) => {
  calls.push({ path, body });
  return path === '/api/record-flows' ? { running: true, runs, manual: [] } : { rows };
};

function draw(extra: { preview?: boolean; steps?: TableMeta | undefined; onRecord?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const section: PageSection = { kind: 'diagram' };
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(FlowDiagram, {
        base: extra.onRecord ? order : flow,
        recordKey: { id: extra.onRecord ? 'o7' : 'f1' },
        diagram: { steps: 'po_flow_step', kinds, ...(extra.onRecord ? { run: true as const } : {}) },
        steps: 'steps' in extra ? extra.steps : steps,
        api,
        loading: null,
        ...(extra.preview ? { preview: true } : {}),
        frame: (body, broken) => createElement(SectionBox, { section, body, foldable: false, broken }),
      }),
    ),
  );
}

const run = (state: string, done: Array<[string, string?]>, extra: Partial<FlowRun> = {}): FlowRun => ({
  id: 'r1',
  flow: 'f1',
  name: 'Large order approval',
  state,
  waitingFor: null,
  wakeAt: null,
  problem: null,
  startedAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:05:00.000Z',
  steps: done.map(([name, status = 'completed'], i) => {
    const [, position, member] = /\[(\d+)(?:\.(\d+))?/.exec(name) ?? [];
    return {
      label: name,
      status,
      at: `2026-10-01T09:0${i}:00.000Z`,
      ...(position ? { position: Number(position) } : {}),
      ...(member ? { member: Number(member) } : {}),
    };
  }),
  ...extra,
});

const ORDER_FLOW = [
  { id: '1', position: 1, kind: 'approval', title: 'Ask a manager to approve the order before it goes out' },
  { id: '2', position: 2, kind: 'branch', title: 'Go on only if approved', condition: 'approval = approved' },
  { id: '3', position: 3, kind: 'send', title: 'Send to the supplier' },
];

beforeEach(() => {
  calls.length = 0;
  rows = [];
  runs = [];
});
afterEach(() => cleanup());

test('the steps are read by the flow id, and drawn as columns, lanes and a branch to its goto', async () => {
  rows = [
    { id: 's3', position: 3, kind: 'approval', title: 'Ask finance' },
    { id: 's1', position: 1, kind: 'branch', condition: 'total > 500', goto: 3 },
    { id: 's2b', position: 2, kind: 'notify', title: 'Tell the buyer' },
    { id: 's2a', position: 2, kind: 'set', title: 'Mark as checked' },
  ];
  const { container } = draw();
  const list = await screen.findByRole('list', { name: 'The steps of this flow, in order' });
  expect(calls).toEqual([
    {
      path: '/api/query',
      body: {
        table: 'po_flow_step',
        columns: ['id', 'position', 'kind', 'title', 'goto', 'condition'],
        filter: { groups: [[{ column: 'flow_id', op: '=', value: 'f1' }]] },
        limit: 100,
        offset: 0,
      },
    },
  ]);
  const columns = [...list.children].map((li) => li.getAttribute('data-position'));
  expect(columns).toEqual(['1', '2', '3', 'end']);
  // The two steps at position 2 are its lanes, in the order a run names them, sharing the column.
  const lanes = [...container.querySelectorAll('[data-position="2"] [data-step]')];
  expect(lanes.map((li) => li.getAttribute('data-step'))).toEqual(['s2a', 's2b']);
  expect(screen.getByRole('list', { name: '2 steps start together' })).toBeTruthy();
  // Each column takes its two halves of the grid, so a way can land on its middle.
  expect((container.querySelector('[data-position="2"]') as HTMLElement).style.gridColumn).toBe('4 / span 2');
  // The branch says what it tests, and its other way goes to step 3, middle to middle.
  expect(screen.getByText('If total > 500')).toBeTruthy();
  const way = container.querySelector('[data-branch="1"]') as HTMLElement;
  expect(way.getAttribute('data-to')).toBe('3');
  expect(way.style.gridColumn).toBe('2 / 8');
  expect(way.textContent).toBe('Otherwise');
  expect(way.parentElement!.getAttribute('aria-hidden')).toBe('true');
  // Said in words in the branch's own box too, for a reader who cannot see the way.
  expect(screen.getByText('If not: step 3')).toBeTruthy();
  expect(screen.getByText('Ask finance')).toBeTruthy();
  expect(screen.getByText('Step 3')).toBeTruthy();
  expect(screen.getByText('End')).toBeTruthy();
});

test('each step says its kind and wears its mark: an approval, a command, a notice, a wait and a branch differ', async () => {
  rows = [
    { id: 'a', position: 1, kind: 'approval', title: 'Ask a manager' },
    { id: 'b', position: 2, kind: 'notify', title: 'Tell the buyer' },
    { id: 'c', position: 3, kind: 'wait', title: 'Give them a day' },
    { id: 'd', position: 4, kind: 'branch', condition: 'approval = approved' },
    { id: 'e', position: 5, kind: 'send', title: 'Send it' },
    { id: 'f', position: 6, kind: 'waitFor', title: 'Hear back' },
  ];
  const { container } = draw();
  await screen.findByRole('list', { name: 'The steps of this flow, in order' });
  const words = [...container.querySelectorAll('.flow-diagram-kind-word')].map((span) => span.textContent);
  expect(words).toEqual(['Approval', 'Notify', 'Wait', 'Branch', 'Send', 'Wait for an event']);
  // A mark per kind, an approval's and a command's told apart by whether the kind waits for a word.
  const marks = [...container.querySelectorAll('[data-step]')].map((li) =>
    li.querySelector('.flow-diagram-diamond') ? 'diamond' : li.querySelector('.flow-diagram-kind svg') ? 'icon' : 'none',
  );
  expect(marks).toEqual(['icon', 'icon', 'icon', 'diamond', 'icon', 'icon']);
  // The words are whole: a long title is never cut short in the markup, only clamped by the stylesheet.
  expect(screen.getByText('If approval = approved')).toBeTruthy();
});

test('a long title is kept whole, and the boxes are as tall as the fullest needs, known before drawing', async () => {
  rows = ORDER_FLOW;
  const { container } = draw();
  expect(await screen.findByText('Ask a manager to approve the order before it goes out')).toBeTruthy();
  const drawing = container.querySelector('.flow-diagram') as HTMLElement;
  // A branch with a title says its test on a line of its own; no run, no line for one.
  expect(drawing.style.getPropertyValue('--flow-lines')).toBe('1');
  expect(drawing.style.getPropertyValue('--flow-n')).toBe('3');
});

test('a branch with no goto, or one past the last step, ends the run', () => {
  const layout = layoutDiagram(
    diagramSteps([
      { id: 'a', position: 1, kind: 'branch', condition: 'open' },
      { id: 'b', position: 2, kind: 'branch', condition: 'urgent', goto: 9 },
      { id: 'c', position: 4, kind: 'wait' },
    ]),
  );
  expect(layout.ways.map((way) => [way.from.id, way.to, way.toIndex])).toEqual([
    ['a', 'end', 3],
    ['b', 'end', 3],
  ]);
  // Each way runs a row lower than the one before, so two never draw over each other.
  expect(layout.ways[1].row).toBeGreaterThan(layout.ways[0].row);
  // A goto between positions lands on the first step at or past it.
  const between = layoutDiagram(
    diagramSteps([
      { id: 'a', position: 1, kind: 'branch', condition: 'open', goto: 3 },
      { id: 'b', position: 2, kind: 'wait' },
      { id: 'c', position: 5, kind: 'wait' },
    ]),
  );
  expect(between.ways[0].to).toBe(5);
});

test('a row that is not a step a run could take is left out', () => {
  expect(
    diagramSteps([
      { id: 'x', kind: 'wait' },
      { id: 'y', position: 'two', kind: 'wait' },
      { id: 'z', position: '2', kind: 'wait' },
    ]).map((step) => step.id),
  ).toEqual(['z']);
});

test("on a record's page, its run is drawn over its flow: done with when, the step it waits at, and what is ahead", async () => {
  rows = ORDER_FLOW;
  runs = [
    run('completed', [['load'], ['run[1]'], ['event[1]'], ['check[2]'], ['run[3]']], { id: 'old', flow: 'f9' }),
    run('waiting', [['load'], ['run[1]']], { waitingFor: 'po.decided' }),
  ];
  const { container } = draw({ onRecord: true });
  const list = await screen.findByRole('list', { name: 'The steps of this flow, in order' });
  // The record's runs are asked for, and the live one's flow is the one read and drawn.
  expect(calls[0]).toEqual({ path: '/api/record-flows', body: { table: 'purchase_order', key: { id: 'o7' } } });
  expect(calls[1].body.filter).toEqual({ groups: [[{ column: 'flow_id', op: '=', value: 'f1' }]] });
  const states = [...container.querySelectorAll('[data-step]')].map((li) => li.getAttribute('data-state'));
  expect(states).toEqual(['current', 'ahead', 'ahead']);
  expect(within(list).getByText('Waiting')).toBeTruthy();
  expect(within(list).getAllByText('Not reached')).toHaveLength(2);
  // The run's own line: its flow, its state as a dot and its word, when it began.
  expect(container.querySelector('.flow-diagram-run')!.textContent).toMatch(/^Large order approvalWaitingStarted /);
  // A run's word under each title: the boxes make room for it, with the branch's test, before anything paints.
  expect((container.querySelector('.flow-diagram') as HTMLElement).style.getPropertyValue('--flow-lines')).toBe('2');
});

test('the text alternative lists the steps in order, each with its kind, its words and where the run stands', async () => {
  rows = ORDER_FLOW;
  runs = [run('completed', [['load'], ['run[1]'], ['event[1]'], ['check[2]'], ['run[3]']])];
  draw({ onRecord: true });
  const list = await screen.findByRole('list', { name: 'The steps of this flow, in order' });
  const items = within(list)
    .getAllByRole('listitem')
    .filter((li) => li.hasAttribute('data-step'))
    .map((li) => li.textContent);
  expect(items).toHaveLength(3);
  expect(items[0]).toMatch(/^ApprovalAsk a manager to approve the order before it goes outDone /);
  expect(items[1]).toMatch(/^BranchGo on only if approvedIf approval = approvedDone .*If not: the end$/);
  expect(items[2]).toMatch(/^SendSend to the supplierDone /);
  expect(list.querySelector('[data-position="end"]')!.hasAttribute('data-reached')).toBe(true);
});

test('a run that took a branch its other way jumps the steps between, and its way is drawn taken', () => {
  const flowSteps = diagramSteps([
    { id: '1', position: 1, kind: 'branch', condition: 'urgent', goto: 3 },
    { id: '2', position: 2, kind: 'wait' },
    { id: '3a', position: 3, kind: 'notify' },
    { id: '3b', position: 3, kind: 'set' },
    { id: '4', position: 4, kind: 'send' },
  ]);
  const taken = runStates(flowSteps, run('waiting', [['load'], ['check[1]'], ['tell[3.1]'], ['set[3.2]', 'pending']]));
  expect(Object.fromEntries([...taken].map(([id, each]) => [id, each.state]))).toEqual({
    '1': 'done',
    '2': 'skipped',
    // Lanes that start together: one done while the other is still out.
    '3a': 'done',
    '3b': 'current',
    '4': 'ahead',
  });
  expect(taken.get('1')!.at).toBe('2026-10-01T09:01:00.000Z');
  const stopped = runStates(flowSteps, run('failed', [['load'], ['check[1]'], ['wait[2]'], ['tell[3.1]', 'failed']]));
  expect(stopped.get('3a')!.state).toBe('stopped');
  expect(stopped.get('4')!.state).toBe('ahead');
  // A live run that has touched nothing yet stands at its first step.
  expect(runStates(flowSteps, run('running', [['load']])).get('1')!.state).toBe('current');
});

test('a record with no run says so, and reads no steps', async () => {
  draw({ onRecord: true });
  expect(await screen.findByText('No flow has run on this record yet.')).toBeTruthy();
  expect(calls.map((call) => call.path)).toEqual(['/api/record-flows']);
});

test('a flow with no steps, or one whose steps the reader cannot read, says so', async () => {
  draw();
  expect(await screen.findByText('This flow has no steps yet.')).toBeTruthy();
  cleanup();
  calls.length = 0;
  draw({ steps: undefined });
  expect(await screen.findByText('This flow has no steps yet.')).toBeTruthy();
  expect(calls).toEqual([]);
});

test('an authoring preview shows its shape and reads nothing', async () => {
  draw({ preview: true });
  expect(await screen.findByText("This flow's steps are drawn here.")).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Steps' })).toBeTruthy();
  expect(calls).toEqual([]);
});
