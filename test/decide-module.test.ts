/**
 * defineDecision as a jobs module declares it: what a declaration may say,
 * how decisions become jobs (`decide-<name>`, event decisions batched by
 * what they share), what `check` says of their commands and inputs, and
 * decisions.lock — a contract recorded, a change refused until bumped, a pin
 * trusted only for its provider, model version and contract.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { int, shape } from '../packages/mistri/src/server/commands/commandShapes.js';
import { checkDecisions, decisionDigests } from '../packages/mistri/src/server/decide/decisionCheck.js';
import {
  answerSpec,
  decisionCommandProblems,
  decisionReads,
  describeDecisions,
} from '../packages/mistri/src/server/decide/decisionChecks.js';
import {
  decisionLockLines,
  decisionLockText,
  decisionTrust,
  readDecisionLock,
  withPin,
} from '../packages/mistri/src/server/decide/decisionLock.js';
import {
  DecisionDeclarationError,
  defineDecision,
  defineDecisions,
  type DecisionRun,
} from '../packages/mistri/src/server/decide/decisionModule.js';
import { capturedJobModule, defineJob, defineJobs, JobDeclarationError } from '../packages/mistri/src/server/jobs/jobModule.js';
import type { AppDef } from '../packages/mistri/src/shared/app.js';

type Incident = { id: number };
const opened = defineEvent('incident.opened', shape({ id: int() }));
const registry = defineCommands({
  openIncident: defineCommand({
    source: 'main',
    target: 'incident',
    input: {},
    output: { parse: (value: unknown) => value as Incident },
    events: { opened: defineEventProjection<Incident, Incident>(opened, (output) => ({ id: output.id })) },
    handle: () => ({ id: 1 }),
  }),
  categorize: defineCommand({
    source: 'main',
    target: 'incident',
    read: ['person', 'company'],
    input: { category: field.choice(['network', 'hardware', 'access']), note: field.text({ optional: true }) },
    output: { parse: (value: unknown) => value as Incident },
    handle: () => ({ id: 1 }),
  }),
  assign: defineCommand({
    source: 'main',
    target: 'incident',
    input: { team_id: field.reference('team', { by: 'id', labelColumn: 'name' }), why: field.text() },
    output: { parse: (value: unknown) => value as Incident },
    handle: () => ({ id: 1 }),
  }),
});

const base = {
  question: 'Which category does this incident belong to?',
  target: 'incident',
  inputs: ['short_description', 'caller_id.company_id.name'],
  answer: { command: 'categorize', field: 'category' },
  runAs: 'triage',
  provider: 'jev' as const,
};
const onOpen = { event: opened, command: 'openIncident', key: (event: { id: number }) => ({ id: event.id }) };
const principals = { triage: { roles: ['automation'] } };
const refused = (pattern: RegExp) => (error: unknown) =>
  (error instanceof DecisionDeclarationError || error instanceof JobDeclarationError) && pattern.test(error.message);

test('a declaration says one trigger, thresholds in order, known providers, and never asks an answer from itself', () => {
  assert.throws(() => defineDecision({ ...base } as never), refused(/needs a trigger/));
  assert.throws(() => defineDecision({ ...base, on: onOpen, every: '@daily' } as never), refused(/not both/));
  assert.throws(() => defineDecision({ ...base, on: onOpen, apply: 0.7, suggest: 0.8 }), refused(/must be below apply/));
  assert.throws(() => defineDecision({ ...base, on: onOpen, suggest: 0.4 }), refused(/from 0\.5 to 1/));
  assert.throws(() => defineDecision({ ...base, on: onOpen, provider: 'openai' as never }), refused(/'jev' or 'anthropic'|provider is/));
  assert.throws(() => defineDecision({ ...base, on: onOpen, inputs: ['category'] }), refused(/never asked from itself/));
  assert.throws(() => defineDecision({ ...base, on: onOpen, deadline: '30 seconds' }), refused(/deadline/));
  assert.throws(() => defineDecision({ ...base, every: '@daily', limit: 9000 }), refused(/limit/));
  assert.throws(() => defineDecision({ ...base, on: onOpen, extra: 1 } as never), refused(/unknown option: extra/));
  assert.throws(() => defineDecisions({ 'bad-name': defineDecision({ ...base, on: onOpen }) }), refused(/a decision's name/));
});

test('decisions become jobs: event decisions sharing a trigger and command are one job, a clock decision is its own', () => {
  const decisions = defineDecisions({
    triageCategory: defineDecision({ ...base, on: onOpen, apply: 0.9 }),
    triageNote: defineDecision({ ...base, on: onOpen, inputs: ['short_description'], answer: { command: 'categorize', field: 'note' } }),
    nightly: defineDecision({ ...base, every: '0 2 * * *', where: "status = 'open'", limit: 50 }),
  });
  const module = capturedJobModule(defineJobs({}, { principals, decisions }));
  assert.deepEqual([...module.jobs.keys()].sort(), ['decide-nightly', 'decide-triageCategory']);
  const event = module.jobs.get('decide-triageCategory')!;
  assert.deepEqual(event.decide, ['triageCategory', 'triageNote']);
  assert.equal(event.command.id, 'categorize');
  assert.equal(event.from?.id, 'openIncident');
  const run = event.schedule!({ id: 7 } as never) as { key: unknown; input: DecisionRun };
  assert.deepEqual(run.key, { id: 7 });
  assert.deepEqual(run.input.records, [
    { decision: 'triageCategory', key: { id: 7 } },
    { decision: 'triageNote', key: { id: 7 } },
  ]);
  const clock = module.jobs.get('decide-nightly')!;
  assert.deepEqual(clock.decide, ['nightly']);
  assert.equal(clock.every?.text, '0 2 * * *');
  assert.equal(module.decisions?.get('triageCategory')?.apply, 0.9);
  assert.equal(module.decisions?.get('triageNote')?.apply, undefined, 'no apply: it only suggests');
  assert.equal(module.decisions?.get('nightly')?.limit, 50);
  assert.match(
    describeDecisions(module.decisions!.values()).join('\n'),
    /triageCategory on incident\.opened@1 \(openIncident\) → categorize\.category as triage/,
  );
});

test('a decision runs as a principal the module declares, and its job names are its own', () => {
  const decisions = defineDecisions({ triageCategory: defineDecision({ ...base, on: onOpen, runAs: 'nobody' }) });
  assert.throws(() => defineJobs({}, { principals, decisions }), refused(/"nobody"/));
  const job = defineJob({
    on: { event: opened, command: 'openIncident' },
    runAs: 'triage',
    command: 'categorize',
    schedule: (e) => ({ key: { id: e.id } }),
  });
  assert.throws(() => defineJobs({ 'decide-mine': job }, { principals }), refused(/decide-/));
});

test('check: the answer command targets the decision record, its field is a supported type, and asks nothing else', () => {
  const app = { id: 'desk', sources: { main: { default: true } } } as unknown as AppDef;
  const decisions = defineDecisions({
    good: defineDecision({ ...base, on: onOpen }),
    wrongCommand: defineDecision({ ...base, on: onOpen, answer: { command: 'missing', field: 'x' } }),
    required: defineDecision({ ...base, on: onOpen, answer: { command: 'assign', field: 'team_id' } }),
  });
  const module = capturedJobModule(defineJobs({}, { principals, decisions }));
  const problems = decisionCommandProblems(module.decisions!.values(), app, registry);
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.match(problems[0], /"missing", which the commands module does not register/);
  assert.match(problems[1], /requires "why"/);
  assert.deepEqual(answerSpec(registry.categorize, 'category'), {
    kind: 'choice',
    options: [
      { value: 'network', label: 'Network' },
      { value: 'hardware', label: 'Hardware' },
      { value: 'access', label: 'Access' },
    ],
  });
  assert.equal((answerSpec(registry.assign, 'team_id') as { kind: string }).kind, 'reference');
});

const column = (name: string, primaryKey = false) => ({ name, type: 'TEXT', nullable: !primaryKey, primaryKey });
const schema = {
  dialect: 'sqlite',
  tables: [
    {
      id: 'incident',
      name: 'incident',
      schema: '',
      columns: [column('id', true), column('short_description'), column('category'), column('caller_id'), column('secret')],
    },
    { id: 'person', name: 'person', schema: '', columns: [column('id', true), column('company_id')] },
    { id: 'company', name: 'company', schema: '', columns: [column('id', true), column('name')] },
  ],
  foreignKeys: [
    { from: { table: 'incident', columns: ['caller_id'] }, to: { table: 'person', columns: ['id'] } },
    { from: { table: 'person', columns: ['company_id'] }, to: { table: 'company', columns: ['id'] } },
  ],
} as unknown as DatabaseSchema;

test('check: inputs are columns, derived names or label paths the App serves, never hidden or redacted ones', () => {
  const app = { id: 'desk', sources: { main: { default: true } }, resources: { incident: { hidden: ['secret'] } } } as unknown as AppDef;
  const module = capturedJobModule(
    defineJobs(
      {},
      {
        principals,
        decisions: defineDecisions({
          good: defineDecision({ ...base, on: onOpen }),
          bad: defineDecision({ ...base, on: onOpen, inputs: ['secret', 'nope', 'caller_id.name', 'short_description.x'] }),
        }),
      },
    ),
  );
  const good = decisionReads(module.decisions!.get('good')!, app, schema);
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.reads!.inputs[1], {
    input: 'caller_id.company_id.name',
    kind: 'path',
    hops: [
      { column: 'caller_id', table: 'person', by: 'id' },
      { column: 'company_id', table: 'company', by: 'id' },
    ],
    column: 'name',
  });
  assert.deepEqual([...good.reads!.reaches].sort(), ['company', 'person']);
  const bad = decisionReads(module.decisions!.get('bad')!, app, schema);
  assert.equal(bad.reads, undefined);
  assert.equal(bad.problems.length, 4, bad.problems.join('\n'));
  assert.match(bad.problems.join('\n'), /"secret" is hidden or redacted/);
  assert.match(bad.problems.join('\n'), /"nope" is not a column, rollup or computed column/);
  assert.match(bad.problems.join('\n'), /"name" is not a column of "person"/);
  assert.match(bad.problems.join('\n'), /"short_description" is not a reference of "incident"/);
});

test('decisions.lock: a contract is recorded, a change is a problem until bumped, and a pin trusts one model of one contract', () => {
  const lock = readDecisionLock(undefined);
  const first = decisionLockLines(new Map([['triageCategory', 'aaaaaaaaaaaa']]), lock, new Set());
  assert.deepEqual(first.unwritten, ['triageCategory']);
  const pinned = withPin(first.entries, 'triageCategory', 'aaaaaaaaaaaa', {
    provider: 'jev',
    modelVersion: 'jev-1-2026-10',
    error: 0.012,
    n: 500,
    at: '2026-10-23',
  });
  const text = decisionLockText(pinned);
  assert.match(text, /^decision triageCategory v1 aaaaaaaaaaaa$/m);
  assert.match(text, /^pin triageCategory v1 jev jev-1-2026-10 error 0\.012 n 500 at 2026-10-23$/m);
  const read = readDecisionLock(text);
  assert.equal(decisionLockText(read), text, 'the text reads back as it was written');
  const trust = decisionTrust(read, 'triageCategory', 'aaaaaaaaaaaa');
  assert.equal(trust.pinned('jev', 'jev-1-2026-10'), true);
  assert.equal(trust.pinned('jev', 'jev-2-2026-11'), false, 'another model version is not the one evaluated');
  assert.equal(trust.pinned('anthropic', 'jev-1-2026-10'), false);
  assert.equal(decisionTrust(read, 'triageCategory', 'bbbbbbbbbbbb').pinned('jev', 'jev-1-2026-10'), false, 'nor another contract');
  const changed = decisionLockLines(new Map([['triageCategory', 'bbbbbbbbbbbb']]), read, new Set());
  assert.match(changed.problems[0], /changed its contract .* under v1 .* check --bump triageCategory/);
  const bumped = decisionLockLines(new Map([['triageCategory', 'bbbbbbbbbbbb']]), read, new Set(['triageCategory']));
  assert.deepEqual(bumped.problems, []);
  assert.deepEqual(bumped.entries.get('triageCategory'), { version: 2, digest: 'bbbbbbbbbbbb', pins: [] });
});

test('check writes decisions.lock with --write-authority, and a changed contract waits for --bump', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tw-decide-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = { id: 'desk', sources: { main: { default: true } } } as unknown as AppDef;
  const module = (question: string) =>
    capturedJobModule(
      defineJobs({}, { principals, decisions: defineDecisions({ triageCategory: defineDecision({ ...base, question, on: onOpen }) }) }),
    );
  const options = (decisions: ReturnType<typeof module>['decisions'], extra: { write?: boolean; bump?: string[] } = {}) => ({
    decisions: decisions!,
    app,
    schema,
    commands: registry,
    directory,
    bump: new Set(extra.bump ?? []),
    write: extra.write ?? false,
  });
  const v1 = module('Which category?').decisions;
  const unwritten = await checkDecisions(options(v1));
  assert.deepEqual(unwritten.problems, []);
  assert.match(unwritten.warnings.join('\n'), /decisions\.lock does not hold "triageCategory"/);
  const wrote = await checkDecisions(options(v1, { write: true }));
  assert.equal(wrote.wrote, join(directory, 'decisions.lock'));
  const digest = decisionDigests(v1!.values(), registry).get('triageCategory')!;
  assert.match(readFileSync(wrote.wrote!, 'utf8'), new RegExp(`^decision triageCategory v1 ${digest}$`, 'm'));
  assert.deepEqual(await checkDecisions(options(v1)), { problems: [], warnings: [] });
  const v2 = module('Which category, really?').decisions;
  const changed = await checkDecisions(options(v2, { write: true }));
  assert.equal(changed.problems.length, 1);
  assert.equal(changed.wrote, undefined, 'writing the lock does not accept a changed contract');
  const bumped = await checkDecisions(options(v2, { bump: ['triageCategory'] }));
  assert.deepEqual(bumped.problems, []);
  assert.match(readFileSync(join(directory, 'decisions.lock'), 'utf8'), /^decision triageCategory v2 /m);
  writeFileSync(join(directory, 'decisions.lock'), '# kept\n');
  assert.equal((await checkDecisions(options(v2))).problems.length, 0, 'a lock without the decision only warns');
});
