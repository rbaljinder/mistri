/**
 * What surrounds a workflow's running: `check` (the probe's findings and the
 * authority.lock lines, with a breaking change named), the store's own
 * attestation, and what an operator may do through `@mistriwork/mistri/maintenance`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';
import * as workflowsEntry from '@mistriwork/mistri/workflows';
import { pathToFileURL } from 'node:url';
import { JOB_TABLES } from '../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import { openSqliteWorkflowStore } from '../packages/mistri/src/adapters/workflows/workflowStore.js';
import type { WorkflowWait } from '../packages/mistri/src/adapters/workflows/workflowStoreContract.js';
import { WORKFLOW_PREFIX, WORKFLOW_STORE_VERSION, WORKFLOW_TABLES } from '../packages/mistri/src/adapters/workflows/workflowStoreSchema.js';
import type { StepKind, StepStatus } from '../packages/mistri/src/adapters/workflows/workflowStoreTypes.js';
import { defineEvent } from '../packages/mistri/src/server/commands/businessEvents.js';
import { int, shape } from '../packages/mistri/src/server/commands/commandShapes.js';
import { jobDeployment } from '../packages/mistri/src/server/jobs/jobLoader.js';
import { capturedJobModule, defineJobs } from '../packages/mistri/src/server/jobs/jobModule.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import {
  cancelWorkflow,
  inspectWorkflowActions,
  inspectWorkflows,
  inspectWorkflowSteps,
  provisionStores,
  pruneWorkflows,
  retryWorkflow,
} from '../packages/mistri/src/server/maintenance.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { defineWorkflow, defineWorkflows, WorkflowDeclarationError, type WorkflowApi } from '../packages/mistri/src/server/workflows.js';
import type { WorkflowHandlerOptions } from '../packages/mistri/src/server/workflows/workflowHost.js';
import { lockedWorkflows, workflowLines } from '../packages/mistri/src/server/workflows/workflowContracts.js';
import { checkWorkflows, probeWorkflow, type WorkflowChecks } from '../packages/mistri/src/server/workflows/workflowProbe.js';
import { published } from '../scripts/pack-manifest.mjs';

const FIXTURE = resolve('test/fixtures/apps/loan-flow');
const load = async (name: string) => (await import(pathToFileURL(join(FIXTURE, name)).href)).default;
const app = parseAppConfig(
  {
    id: 'loans',
    name: 'Loans',
    sources: { data: { connection: 'data', default: true } },
    resources: { loan: { access: 'write' } },
    auth: {
      providers: ['email'],
      roles: {
        intake: { read: true, commands: ['applyLoan'] },
        automation: { read: true, commands: ['approveLoan'] },
        observer: { read: true },
      },
    },
    views: { loans: { kind: 'list', from: 'loan' } },
    home: 'loans',
  },
  'workflow fixture',
);

// The types the store and the host expose, named here so a change to one is a change this file sees.
type Shapes = [WorkflowWait['seenSeq'], StepKind, StepStatus, WorkflowHandlerOptions['attemptTimeoutMs'], WorkflowChecks['app']];
void (undefined as unknown as Shapes);

const { loanApplied: Applied } = await import(pathToFileURL(join(FIXTURE, 'events.mjs')).href);
const Other = defineEvent('loan.other', shape({ id: int() }));
type Start = { id: number };
type Run = (w: WorkflowApi, start: Start) => Promise<unknown>;
const moduleOf = (run: Run, extra: { version?: number; listens?: readonly (typeof Other)[] } = {}) =>
  capturedJobModule(
    defineJobs(
      {},
      {
        principals: { underwriter: { roles: ['automation'] }, watcher: { roles: ['observer'] } },
        workflows: defineWorkflows({
          loan: defineWorkflow<Start>({ runAs: 'underwriter', start: { event: Applied, key: (event) => event.id }, run, ...extra }),
        }),
      },
    ),
  );

describe('check reads a workflow without running it', () => {
  test('its steps are found whichever way it branches, and the fixture workflow is clean', async () => {
    const commands = await load('commands.mjs');
    const shapes = await checkWorkflows(capturedJobModule(await load('workflows.mjs')), { app, commands, hasConnection: () => true });
    assert.deepEqual(shapes[0].problems, []);
    assert.deepEqual(shapes[0].steps, [
      { name: 'cooling-off', kind: 'sleep' },
      { name: 'approve[*]', kind: 'run', target: 'approveLoan' },
    ]);
    const probe = await probeWorkflow(
      moduleOf(
        async (w, start) => {
          const decision = await w.waitFor('decision', Other, { timeout: '2 days' });
          if (decision) await w.run('approve', 'approveLoan', { target: start.id });
          else await w.run('lapse', 'approveLoan', { target: start.id });
          for (const id of [1, 2]) await w.run(['each', id], 'approveLoan', { target: id });
        },
        { listens: [Other] },
      ).workflows.get('loan')!,
    );
    assert.deepEqual(probe.steps.map((step) => step.name).sort(), ['approve', 'decision', 'each[*]', 'lapse']);
    assert.deepEqual(probe.problems, []);
  });

  test('every combination of answers is explored, so a step behind two waits is found, and a cap is reported', async () => {
    const workflow = (run: Run) => moduleOf(run, { listens: [Other] }).workflows.get('loan')!;
    const deep = await probeWorkflow(
      workflow(async (w, start) => {
        const first = await w.waitFor('first', Other, { timeout: '1 day' });
        if (first) return;
        await w.run('remind', 'approveLoan', { target: start.id });
        const second = await w.waitFor('second', Other, { timeout: '1 day' });
        if (!second) await w.run('lapse', 'approveLoan', { target: start.id });
      }),
    );
    assert.deepEqual(deep.steps.map((step) => step.name).sort(), ['first', 'lapse', 'remind', 'second']);
    assert.equal(deep.capped, false);
    // A branch on a call's answer is taken too.
    const call = await probeWorkflow(
      workflow(async (w, start) => {
        const answer = await w.call<{ score: number }>('ask', 'bureau', { path: '/score' });
        if (answer && answer.score < 500) await w.run('low', 'approveLoan', { target: start.id });
        else await w.run('high', 'approveLoan', { target: start.id });
      }),
    );
    assert.deepEqual(call.steps.map((step) => step.name).sort(), ['ask', 'high', 'low']);
    // Five waits is 3^5 combinations: the exploration stops at its cap and says so.
    const wide = await probeWorkflow(
      workflow(async (w) => {
        for (const name of ['a', 'b', 'c', 'd', 'e']) await w.waitFor(name, Other, { timeout: '1 day' });
      }),
    );
    assert.equal(wide.capped, true);
    assert.deepEqual(wide.steps.map((step) => step.name).sort(), ['a', 'b', 'c', 'd', 'e']);
  });

  test('the Keystone credit decision locks every step, the reminder included', async () => {
    const lock = readFileSync(resolve(import.meta.dirname, '../test/fixtures/apps/keystone/lender/authority.lock'), 'utf8');
    const { default: jobs } = await import(
      pathToFileURL(resolve(import.meta.dirname, '../test/fixtures/apps/keystone/lender/server/jobs.ts')).href
    );
    const workflow = capturedJobModule(jobs).workflows.get('creditDecision')!;
    const probe = await probeWorkflow(workflow);
    assert.equal(probe.capped, false);
    assert.deepEqual(probe.steps.map((step) => step.name).sort(), [
      'auto-approve',
      'credit-result',
      'decision',
      'decision-late',
      'no-score',
      'refer',
      'remind',
      'request-check',
    ]);
    for (const step of probe.steps) assert.match(lock, new RegExp(`^workflow creditDecision v1 step .* ${step.name}$`, 'm'));
  });

  test('what it names that does not exist, or is not granted is a problem', async () => {
    const commands = await load('commands.mjs');
    const check = async (run: Run, extra = {}, hasConnection = () => true) =>
      (await checkWorkflows(moduleOf(run, extra), { app, commands, hasConnection }))[0].problems.join('\n');
    assert.match(
      await check(async (w) => {
        await w.run('a', 'noSuchCommand');
      }),
      /runs command "noSuchCommand", which the commands module does not register/,
    );
    assert.match(
      await check(async (w) => {
        await w.run('a', 'applyLoan');
      }),
      /not granted command "applyLoan"/,
    );
    assert.match(
      await check(
        async (w) => {
          await w.call('a', 'bureau', { path: '/score' });
        },
        {},
        () => false,
      ),
      /calls connection "bureau", which the config file does not name/,
    );
    assert.match(
      await check(async (w) => {
        await w.waitFor('a', Other);
      }),
      /waits for "loan.other@1", which the workflow does not list in listens/,
    );
    assert.match(
      await check(async (w) => {
        await w.sleep('a', 'soon');
      }),
      /duration/,
    );
    assert.match(
      await check(async (w) => {
        await w.run('a', 'approveLoan');
        await w.run('a', 'approveLoan');
      }),
      /step "a" is used twice/,
    );
  });
});

describe('authority.lock records a workflow, and a breaking change is named', () => {
  const shapesOf = async (run: Run, extra = {}) =>
    checkWorkflows(moduleOf(run, extra), { app, commands: await load('commands.mjs'), hasConnection: () => true });
  const original = async (w: Parameters<Run>[0], start: { id: number }) => {
    await w.sleep('cooling-off', '1 second');
    await w.run('approve', 'approveLoan', { target: start.id });
  };

  test('the lines are the digest and each step, and an additive change at the same version rewrites them', async () => {
    const first = workflowLines(await shapesOf(original), undefined);
    assert.deepEqual(first.problems, []);
    assert.match(first.lines[0], /^workflow loan v1 [0-9a-f]{12}$/);
    assert.deepEqual(first.lines.slice(1), ['workflow loan v1 step sleep - cooling-off', 'workflow loan v1 step run approveLoan approve']);
    assert.equal(lockedWorkflows(first.lines.join('\n')).get('loan')!.steps.length, 2);
    const added = workflowLines(
      await shapesOf(async (w, start) => {
        await original(w, start);
        await w.sleep('after', '1 second');
      }),
      first.lines.join('\n'),
    );
    assert.deepEqual(added.problems, []);
    assert.equal(added.lines.length, 4);
  });

  test('removing or retargeting a recorded step at the same version is a problem, and a new version is not', async () => {
    const lock = workflowLines(await shapesOf(original), undefined).lines.join('\n');
    const removed = workflowLines(
      await shapesOf(async (w, start) => {
        await w.run('approve', 'approveLoan', { target: start.id });
      }),
      lock,
    );
    assert.match(removed.problems.join('\n'), /workflow "loan".*cooling-off/);
    assert.deepEqual(removed.lines, lock.split('\n'), 'the recorded lines are kept');
    const bumped = workflowLines(
      await shapesOf(
        async (w, start) => {
          await w.run('approve', 'approveLoan', { target: start.id });
        },
        { version: 2 },
      ),
      lock,
    );
    assert.deepEqual(bumped.problems, []);
    assert.match(bumped.lines[0], /^workflow loan v2 /);
    const lowered = workflowLines(await shapesOf(original), lock.replace('loan v1', 'loan v2').replaceAll('loan v1', 'loan v2'));
    assert.match(lowered.problems.join('\n'), /a version only goes up/);
  });
});

describe('the @mistriwork/mistri/workflows entry', () => {
  test('the package maps and builds it, and it exports the declarations', () => {
    const pkg = published(JSON.parse(readFileSync(new URL('../packages/mistri/package.json', import.meta.url), 'utf8')));
    assert.deepEqual(pkg.exports['./workflows'], { types: './dist/server/workflows.d.ts', default: './dist/server/workflows.js' });
    const commands = JSON.parse(readFileSync(new URL('../tsconfig.commands.json', import.meta.url), 'utf8'));
    assert.ok(commands.include.includes('packages/mistri/src/server/workflows.ts'));
    assert.deepEqual(Object.keys(workflowsEntry).sort(), [
      'StepRefused',
      'WorkflowDeclarationError',
      'defineWorkflow',
      'defineWorkflows',
      'flowRunner',
      'workflowsFor',
    ]);
  });
});

describe('declarations are refused when they cannot be kept', () => {
  test('a workflow is named by its key, a jobs module may not use the reserved prefix, and the principal must exist', () => {
    const declared = defineWorkflow<Start>({ runAs: 'underwriter', start: { event: Applied, key: () => 1 }, run: async () => {} });
    assert.throws(() => defineWorkflows({ '1 bad': declared }), /must start with a letter/);
    assert.throws(() => defineWorkflows({}), WorkflowDeclarationError);
    assert.throws(
      () => defineJobs({}, { principals: { nobody: { roles: ['automation'] } }, workflows: defineWorkflows({ loan: declared }) }),
      /underwriter/,
    );
  });
});

describe('maintenance on a provisioned database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-workflow-maintenance-'));
  after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'business.db');

  test('inspect, retry, cancel and prune act on instances, and a retry enqueues its wake-up', async () => {
    new DatabaseSync(database).close();
    const commands = await load('commands.mjs'),
      jobs = await load('workflows.mjs');
    migrateSqliteCommandJournal(database);
    const provisioned = await provisionStores({ sqlite: database }, { app: { id: 'loans', commands }, jobs });
    assert.equal(provisioned.stores.workflows?.provisioned, true);
    assert.equal(
      (await provisionStores({ sqlite: database }, { app: { id: 'loans', commands }, jobs })).stores.workflows?.provisioned,
      false,
      'idempotent',
    );
    const raw = new DatabaseSync(database, { readOnly: true });
    assert.deepEqual(
      (
        raw.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name LIKE ? ORDER BY name').all('table', `${WORKFLOW_PREFIX}%`) as {
          name: string;
        }[]
      ).map((row) => row.name),
      Object.values(WORKFLOW_TABLES).sort(),
    );
    assert.equal(raw.prepare(`SELECT version FROM "${WORKFLOW_TABLES.meta}"`).get()!.version, WORKFLOW_STORE_VERSION);
    raw.close();

    const where = { sqlite: database };
    const policy = jobDeployment(capturedJobModule(jobs), { appId: 'loans', commands }).store;
    const store = openSqliteWorkflowStore(database);
    try {
      const started = await store.start({ workflow: 'loan', version: 1, key: '1', eventId: 'e-1', startJson: '{"id":1}' }, Date.now());
      const begun = (await store.begin(started!.id, Date.now()))!;
      assert.equal(
        await store.finish(
          started!.id,
          begun.instance.epoch,
          { state: 'failed', problem: 'step_refused', problemStep: 'approve' },
          Date.now(),
        ),
        true,
      );
      const failed = await inspectWorkflows(where, policy, { state: 'failed' });
      assert.deepEqual(
        failed.rows.map((row) => [row.workflow, row.key, row.problem]),
        [['loan', '1', 'step_refused']],
      );
      assert.deepEqual(await inspectWorkflowSteps(where, policy, started!.id), []);

      await assert.rejects(
        retryWorkflow(where, jobDeployment(capturedJobModule(jobs), { appId: 'loans', commands }).store, {
          id: started!.id,
          operator: 'not an operator!',
          appId: 'loans',
        }),
        /operator_invalid/,
      );
      const retried = await retryWorkflow(where, jobDeployment(capturedJobModule(jobs), { appId: 'loans', commands }).store, {
        id: started!.id,
        operator: 'ops@example.test',
        appId: 'loans',
      });
      assert.equal(retried.state, 'running');
      const jobRows = new DatabaseSync(database, { readOnly: true });
      assert.equal((jobRows.prepare(`SELECT count(*) AS n FROM "${JOB_TABLES.job}" WHERE job = 'wf-loan'`).get() as { n: number }).n, 1);
      jobRows.close();
      /* A crash between a retry's commit and its enqueue leaves the instance running with no wake-up. Retry wakes a
         live instance where it is, with a new epoch: a second wake-up, and the one that may still be pending, run
         side by side, and the epoch lets only the newer take a step or finish. */
      const woken = await retryWorkflow(where, jobDeployment(capturedJobModule(jobs), { appId: 'loans', commands }).store, {
        id: started!.id,
        operator: 'ops',
        appId: 'loans',
      });
      assert.equal(woken.state, 'running');
      const wakeRows = new DatabaseSync(database, { readOnly: true });
      assert.equal((wakeRows.prepare(`SELECT count(*) AS n FROM "${JOB_TABLES.job}" WHERE job = 'wf-loan'`).get() as { n: number }).n, 2);
      wakeRows.close();
      const older = (await store.begin(started!.id, Date.now()))!,
        newer = (await store.begin(started!.id, Date.now()))!;
      const step = {
        name: 'approve',
        kind: 'run',
        hash: 'h',
        status: 'completed',
        attempts: 1,
        wakeAt: null,
        resultJson: '{}',
        eventId: null,
        errorCode: null,
      } as const;
      assert.equal(await store.step(started!.id, older.instance.epoch, step, Date.now()), undefined, 'the older run is fenced out');
      assert.equal(await store.finish(started!.id, older.instance.epoch, { state: 'completed', resultJson: null }, Date.now()), false);
      assert.equal(typeof (await store.step(started!.id, newer.instance.epoch, step, Date.now())), 'number');
      assert.deepEqual(
        (await inspectWorkflowSteps(where, policy, started!.id)).map((row) => [row.name, row.attempts]),
        [['approve', 1]],
        'one step, taken once',
      );

      assert.deepEqual(await cancelWorkflow(where, policy, { id: started!.id, operator: 'ops' }), {
        outcome: 'cancelled',
        state: 'cancelled',
      });
      assert.equal((await cancelWorkflow(where, policy, { id: started!.id, operator: 'ops' })).outcome, 'unchanged');
      // The operator's Retry and Cancel are in the instance's history; the unchanged cancel is not.
      assert.deepEqual(
        (await inspectWorkflowActions(where, policy, started!.id)).map((row) => [row.action, row.operator]),
        [
          ['retry', 'ops@example.test'],
          ['retry', 'ops'],
          ['cancel', 'ops'],
        ],
      );
      await assert.rejects(cancelWorkflow(where, policy, { id: started!.id, operator: '' }), /operator_invalid/);
      assert.deepEqual(await pruneWorkflows(where, policy, { olderThanMs: 60_000 }), { pruned: 0, more: false }, 'too recent');
      assert.deepEqual(await pruneWorkflows(where, policy, { olderThanMs: 0 }), { pruned: 1, more: false });
      assert.deepEqual((await inspectWorkflows(where, policy)).rows, []);
    } finally {
      await store.close();
    }
  });
});

describe('a waitFor timeout computed from the start payload', () => {
  type Sla = { id: number; priority: string; hours: number; window: string };
  const slaOf = (run: (w: WorkflowApi, start: Sla) => Promise<unknown>) =>
    capturedJobModule(
      defineJobs(
        {},
        {
          principals: { underwriter: { roles: ['automation'] } },
          workflows: defineWorkflows({
            loan: defineWorkflow<Sla>({ runAs: 'underwriter', start: { event: Applied, key: (event) => event.id }, listens: [Other], run }),
          }),
        },
      ),
    ).workflows.get('loan')!;

  test('is recorded as dynamic, not refused, and the lock lines do not see it', async () => {
    const WINDOW: Record<string, string> = { urgent: '1 hour', low: '1 day' };
    const probe = await probeWorkflow(
      slaOf(async (w, start) => {
        await w.waitFor('looked-up', Other, { timeout: WINDOW[start.priority] ?? '8 hours' });
        await w.waitFor('built', Other, { timeout: `${start.hours * 2} hours` });
        await w.waitFor('passed', Other, { timeout: start.window });
        await w.waitFor('fixed', Other, { timeout: '2 days' });
      }),
    );
    assert.deepEqual(probe.problems, []);
    assert.deepEqual(probe.steps, [
      { name: 'looked-up', kind: 'waitFor', target: 'loan.other@1' },
      { name: 'built', kind: 'waitFor', target: 'loan.other@1', timeout: 'dynamic' },
      { name: 'passed', kind: 'waitFor', target: 'loan.other@1', timeout: 'dynamic' },
      { name: 'fixed', kind: 'waitFor', target: 'loan.other@1' },
    ]);
    const shape = { workflow: slaOf(async () => undefined), problems: [], capped: false };
    const withTimeout = workflowLines([{ ...shape, steps: probe.steps }], undefined).lines;
    const without = workflowLines(
      [{ ...shape, steps: probe.steps.map(({ name, kind, target }) => ({ name, kind, target })) }],
      undefined,
    ).lines;
    assert.deepEqual(withTimeout, without);
    assert.ok(withTimeout.includes('workflow loan v1 step waitFor loan.other@1 built'));
  });

  test('a literal that is not a duration is still refused', async () => {
    const probe = await probeWorkflow(
      slaOf(async (w) => {
        await w.waitFor('typo', Other, { timeout: '5 parsecs' });
      }),
    );
    assert.match(probe.problems.join('\n'), /waitFor "typo" timeout must be a duration/);
    assert.equal(probe.steps[0].timeout, undefined);
  });
});
