/**
 * The flows runner on the real engine (createWorkflowDriver), its own
 * command answered here from a plan: steps that share a position start
 * together and join, and a step that waits for `all` of those
 * its command asked, ends early on its condition, reminds while it waits and
 * gives up after its duration (G94). The rows' rules are flows.test.ts; the
 * whole chain through a real host is flows-host.test.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkflowDriver } from '../packages/mistri/src/server/testing/workflows.js';
import { flowRunner } from '../packages/mistri/src/server/workflows/flowRunner.js';
import { defineEvent } from '../packages/mistri/src/server/commands/businessEvents.js';
import { int, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { flowPlan, parseFlows, type FlowPlan, type FlowRecordShape } from '../packages/mistri/src/shared/appFlows.js';

const binding = parseFlows(
  {
    from: 'ticket_flow',
    steps: 'ticket_flow_step',
    events: { 'task.done': 'ticket', 'approval.decided': 'ticket' },
    kinds: {
      task: { command: 'openTask', input: ['team'], waitFor: 'task.done' },
      approval: { command: 'askApproval', input: ['approver'], waitFor: 'approval.decided', remind: 'remindApprover' },
      close: { command: 'closeTicket' },
    },
  },
  'resources "ticket"',
);
const record: FlowRecordShape = {
  columns: new Set(['id', 'state']),
  dates: new Set(),
  condition: (said) => /^state (=|!=) \S+$/.test(said),
  audiences: new Set(['requester']),
};
const START = defineEvent('mistri.flow', shape({ record: text({ max: 440 }), target: text({ max: 512 }), flow: text({ max: 128 }) }));
const taskDone = defineEvent('task.done', shape({ ticket: int() }));
const decided = defineEvent('approval.decided', shape({ ticket: int(), outcome: text({ max: 20 }) }));
const HOUR = 3_600_000;

/** A driver over one plan: the runner's own command answers from it, and `state` is what a condition reads. */
async function drive(plan: FlowPlan, answers: Readonly<Record<string, unknown>> = {}) {
  const ran: string[] = [];
  const world = { state: 'open' };
  const driver = await createWorkflowDriver({
    workflow: { ticketFlows: flowRunner('ticket', { runAs: 'automation', listens: [taskDone, decided] }) },
    commands: {
      'flows-ticket': ({ input }) => {
        const op = (input as { op: string; condition?: string }).op;
        if (op === 'load') return { json: JSON.stringify(plan) };
        if (op === 'check')
          return { json: JSON.stringify({ holds: (input as { condition: string }).condition === `state = ${world.state}` }) };
        if (op === 'tell') {
          const { audience, message } = input as { audience: string; message: string };
          ran.push(`tell ${audience}: ${message}`);
          return { json: '{}' };
        }
        throw new Error(`unexpected ${op}`);
      },
      ...Object.fromEntries(
        ['openTask', 'askApproval', 'remindApprover', 'closeTicket'].map((command) => [
          command,
          ({ input }: { input: unknown }) => {
            ran.push(`${command}${input && Object.keys(input).length ? ` ${JSON.stringify(input)}` : ''}`);
            return answers[command] ?? {};
          },
        ]),
      ),
    },
  });
  await driver.emit(START, { record: '{"id":"7"}', target: '7', flow: '1' });
  const instance = async () => (await driver.instances())[0];
  const steps = async () => (await driver.steps((await instance()).id)).map((step) => `${step.name}:${step.status}`);
  return { driver, ran, world, instance, steps };
}

const planOf = (rows: Record<string, unknown>[]) => {
  const plan = flowPlan({ id: 1, name: 'Replace a laptop' }, rows, binding, record);
  assert.equal(plan.problem, undefined, JSON.stringify(plan.problem));
  return plan;
};

test('steps that share a position start together, and the run goes on once each is done, in whatever order', async () => {
  const plan = planOf([
    { id: 10, flow_id: 1, position: 1, kind: 'task', team: 'desk', title: 'Set it up' },
    { id: 11, flow_id: 1, position: 1, kind: 'task', team: 'field', title: 'Collect the old device' },
    { id: 12, flow_id: 1, position: 2, kind: 'close' },
  ]);
  assert.deepEqual(
    plan.steps.map((step) => [step.position, step.member]),
    [
      [1, 1],
      [1, 2],
      [2, undefined],
    ],
  );
  const { driver, ran, instance, steps } = await drive(plan);
  try {
    assert.deepEqual(ran, ['openTask {"team":"desk"}', 'openTask {"team":"field"}'], 'both begin before either is waited on');
    assert.equal((await instance()).state, 'waiting');
    // The second finishes first: the join takes it, and waits on for the other.
    await driver.emit(taskDone, { ticket: 7 });
    assert.equal((await instance()).state, 'waiting');
    assert.equal(ran.length, 2);
    await driver.emit(taskDone, { ticket: 8 }, 'another-ticket');
    assert.equal((await instance()).state, 'waiting', "another ticket's task is not this one's");
    await driver.emit(taskDone, { ticket: 7 });
    assert.equal((await instance()).state, 'completed');
    assert.deepEqual(ran.at(-1), 'closeTicket');
    assert.deepEqual(await steps(), [
      'load:completed',
      'run[1.1]:completed',
      'run[1.2]:completed',
      'event[1.1]:completed',
      'event[1.2]:completed',
      'run[2]:completed',
    ]);
  } finally {
    await driver.close();
  }
});

test('an approval waits for all it asked, ends early when its condition holds, and reminds while it waits', async () => {
  const plan = planOf([
    { id: 1, flow_id: 1, position: 1, kind: 'approval', approver: 'team', mode: 'all', remind: '1 day', condition: 'state = rejected' },
    { id: 2, flow_id: 1, position: 2, kind: 'close' },
  ]);
  assert.deepEqual(plan.steps[0], {
    position: 1,
    kind: 'command',
    name: 'approval',
    command: 'askApproval',
    input: { approver: 'team' },
    waitFor: { event: 'approval.decided', field: 'ticket' },
    mode: 'all',
    condition: 'state = rejected',
    remind: { command: 'remindApprover', every: '1 day' },
  });
  const all = await drive(plan, { askApproval: { asked: 3 } });
  try {
    await all.driver.emit(decided, { ticket: 7, outcome: 'approved' });
    assert.equal((await all.instance()).state, 'waiting', 'one of three');
    await all.driver.advance(24 * HOUR);
    assert.deepEqual(all.ran.slice(1), ['remindApprover {"approver":"team"}'], 'a day without a decision sends a reminder');
    await all.driver.emit(decided, { ticket: 7, outcome: 'approved' });
    await all.driver.emit(decided, { ticket: 7, outcome: 'approved' });
    assert.equal((await all.instance()).state, 'completed', 'three of three');
    assert.equal(all.driver.executed('remindApprover'), 1);
  } finally {
    await all.driver.close();
  }

  const early = await drive(plan, { askApproval: { asked: 3 } });
  try {
    early.world.state = 'rejected';
    await early.driver.emit(decided, { ticket: 7, outcome: 'rejected' });
    assert.equal((await early.instance()).state, 'completed', 'one rejection ends an all-approval');
    assert.ok((await early.steps()).includes('check[1]:completed'));
  } finally {
    await early.driver.close();
  }

  const unsaid = await drive(plan, { askApproval: {} });
  try {
    const stopped = await unsaid.instance();
    assert.equal(stopped.state, 'failed');
    assert.match(stopped.problem ?? '', /must answer how many it asked/);
  } finally {
    await unsaid.driver.close();
  }
});

test('a wait with a duration gives up and goes on; its reminders are counted inside it', async () => {
  const plan = planOf([
    { id: 1, flow_id: 1, position: 1, kind: 'approval', approver: 'ana', remind: '2 days', duration: '5 days' },
    { id: 2, flow_id: 1, position: 2, kind: 'close' },
  ]);
  const { driver, ran, instance, steps } = await drive(plan);
  try {
    await driver.advance(2 * 24 * HOUR);
    await driver.advance(2 * 24 * HOUR);
    assert.equal(driver.executed('remindApprover'), 2);
    assert.equal((await instance()).state, 'waiting');
    await driver.advance(24 * HOUR);
    assert.equal((await instance()).state, 'completed', 'five days: the run goes on undecided');
    assert.equal(driver.executed('remindApprover'), 2, 'no reminder at the deadline');
    assert.equal(ran.at(-1), 'closeTicket');
    assert.deepEqual(
      (await steps()).filter((step) => /^(event|remind)/.test(step)),
      ['event[1]:completed', 'remind[1-1]:completed', 'event[1-1]:completed', 'remind[1-2]:completed', 'event[1-2]:completed'],
    );
  } finally {
    await driver.close();
  }

  // The duration counts the time the decisions took: one of two on the fourth day leaves one day, not five.
  const timed = await drive(
    planOf([
      { id: 1, flow_id: 1, position: 1, kind: 'approval', approver: 'team', mode: 'all', duration: '5 days' },
      { id: 2, flow_id: 1, position: 2, kind: 'close' },
    ]),
    { askApproval: { asked: 2 } },
  );
  try {
    await timed.driver.advance(4 * 24 * HOUR);
    await timed.driver.emit(decided, { ticket: 7, outcome: 'approved' });
    assert.equal((await timed.instance()).state, 'waiting');
    await timed.driver.advance(24 * HOUR);
    assert.equal((await timed.instance()).state, 'completed');
  } finally {
    await timed.driver.close();
  }
});

test('a notify step tells its audience in a step of its own, beside the steps that start with it (G95)', async () => {
  const plan = planOf([
    { id: 1, flow_id: 1, position: 1, kind: 'notify', audience: 'requester', message: 'We are on it.' },
    { id: 2, flow_id: 1, position: 1, kind: 'close' },
  ]);
  const { driver, ran, instance, steps } = await drive(plan);
  try {
    assert.equal((await instance()).state, 'completed');
    assert.deepEqual(ran, ['tell requester: We are on it.', 'closeTicket']);
    assert.deepEqual(await steps(), ['load:completed', 'tell[1.1]:completed', 'run[1.2]:completed']);
  } finally {
    await driver.close();
  }
});

test("a step's wait columns are judged as it is written, and a group refuses a branch and a reminder", () => {
  const plan = (rows: Record<string, unknown>[]) => flowPlan({ id: 1, name: 'x' }, rows, binding, record);
  const reason = (row: Record<string, unknown>) => plan([{ id: 1, flow_id: 1, position: 1, ...row }]).problem?.reason;
  assert.equal(reason({ kind: 'approval', approver: 'a', mode: 'most' }), 'mode: Choose any or all: all waits for each one the step asks.');
  assert.match(reason({ kind: 'close', mode: 'all' }) ?? '', /^mode:/, 'a kind that waits for nothing has no mode');
  assert.match(reason({ kind: 'task', team: 'desk', remind: '1 day' }) ?? '', /^remind:/, 'a kind with no reminder');
  assert.match(reason({ kind: 'approval', approver: 'a', remind: 'often' }) ?? '', /^remind:/);
  assert.match(reason({ kind: 'approval', approver: 'a', condition: 'total > 5' }) ?? '', /^condition:/);
  assert.match(reason({ kind: 'close', duration: '1 day' }) ?? '', /^duration:/);
  assert.equal(
    plan([
      { id: 1, flow_id: 1, position: 1, kind: 'branch', condition: 'state = open' },
      { id: 2, flow_id: 1, position: 1, kind: 'close' },
    ]).problem?.reason,
    'A branch decides alone: give it a position no other step has.',
  );
  assert.equal(
    plan([
      { id: 1, flow_id: 1, position: 1, kind: 'approval', approver: 'a', remind: '1 day' },
      { id: 2, flow_id: 1, position: 1, kind: 'close' },
    ]).problem?.reason,
    'A step that starts together with others sends no reminders.',
  );
  assert.throws(
    () => parseFlows({ from: 'f', steps: 's', kinds: { send: { command: 'x', remind: 'y' } } }, 'resources "t"'),
    /"remind" names one of the App's commands/,
    'a reminder belongs to a kind that waits',
  );
});
