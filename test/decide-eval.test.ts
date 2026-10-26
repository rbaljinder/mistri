/**
 * Measuring a decision before it applies: the scores (accuracy, Brier,
 * calibration, what the thresholds would have done), `evaluateDecision` in an
 * App's own tests, and `mistri decide eval` on a real database — the estimate
 * it refuses to spend without `--yes` or above `--max-cost`, the one record
 * `--dry` shows, and the pin `--pin` writes only when the applied share was
 * right often enough. Every answer is scripted: no network.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createTestWorkspace } from '../packages/mistri/src/server/testing.js';
import { evaluateDecision } from '../packages/mistri/src/server/testing/index.js';
import { scoreDecision } from '../packages/mistri/src/server/decide/decisionEval.js';
import { defineDecision } from '../packages/mistri/src/server/jobs.js';
import { readDecisionLock } from '../packages/mistri/src/server/decide/decisionLock.js';
import { ROOT, childEnv, runCli } from './appApiCli.js';

const src = (path: string) => JSON.stringify(pathToFileURL(join(ROOT, path)).href);
const meta = { provider: 'jev', model: 'jev-1', modelVersion: 'jev-1-2026-10', units: 0, costMicros: 0 } as const;
const said = (answer: string, probability: number) => ({ answer: { answer, probability } });

test('the scores: right answers, honest probabilities, and what each threshold would have done', () => {
  const evaluation = scoreDecision(
    { name: 'category', apply: 0.9, suggest: 0.5 },
    [
      { truth: 'network', ...said('network', 0.97) },
      { truth: 'printer', ...said('printer', 0.95) },
      { truth: 'hardware', ...said('printer', 0.92) },
      { truth: 'network', ...said('network', 0.6) },
      { truth: 'network', ...said('hardware', 0.3) },
      { truth: 'network' },
    ],
    meta,
  );
  assert.deepEqual([evaluation.n, evaluation.answered, evaluation.invalid], [6, 5, 1]);
  assert.equal(evaluation.accuracy, 0.5, 'an unanswered record counts as wrong');
  assert.deepEqual(evaluation.thresholds.applied, { n: 3, share: 0.5, errorRate: 0.3333 });
  assert.deepEqual(evaluation.thresholds.suggested, { n: 1, share: 0.1667, accuracy: 1 });
  assert.deepEqual(evaluation.thresholds.left, { n: 2, share: 0.3333 });
  assert.equal(evaluation.pinnable, false);
  assert.match(evaluation.why!, /wrong 33\.3% of the time/);
  assert.deepEqual(evaluation.confusion[0], { truth: 'hardware', answer: 'printer', n: 1 });
  // Brier over the answered: (0.03² + 0.05² + 0.92² + 0.4² + 0.3²) / 5.
  assert.equal(evaluation.brier, Math.round(((0.03 ** 2 + 0.05 ** 2 + 0.92 ** 2 + 0.4 ** 2 + 0.3 ** 2) / 5) * 1e4) / 1e4);
  assert.deepEqual(
    evaluation.reliability.map((bucket) => [bucket.from, bucket.n]),
    [
      [0, 1],
      [0.6, 1],
      [0.9, 1],
      [0.95, 2],
    ],
  );
  assert.ok(evaluation.ece > 0 && evaluation.ece < 1);

  const suggestOnly = scoreDecision({ name: 'category', suggest: 0.5 }, [{ truth: 'a', ...said('a', 0.99) }], meta);
  assert.equal(suggestOnly.pinnable, false, 'nothing to pin when nothing applies');
  assert.match(suggestOnly.why!, /no apply threshold/);
  const clean = scoreDecision({ name: 'category', apply: 0.9, suggest: 0.5 }, [{ truth: 'a', ...said('a', 0.99) }], meta);
  assert.deepEqual([clean.pinnable, clean.why], [true, undefined]);
});

test('evaluateDecision measures a decision in an App test, against a scripted model', async () => {
  const decision = defineDecision({
    question: 'Which category is this incident?',
    target: 'incident',
    inputs: ['title'],
    answer: { command: 'categorize', field: 'category' },
    every: '0 0 1 1 *',
    apply: 0.9,
    runAs: 'triage',
    provider: 'jev',
  });
  const evaluation = await evaluateDecision(decision, {
    answer: { kind: 'choice', options: ['network', 'hardware', 'printer'].map((value) => ({ value, label: value })) },
    model: {
      model: 'jev-1',
      modelVersion: 'jev-1-2026-10',
      decisions: {
        category: [
          { when: { title: 'VPN' }, answer: 'network', probability: 0.97 },
          { answer: 'printer', probability: 0.7 },
        ],
      },
    },
    records: [
      { inputs: { title: 'VPN down' }, truth: 'network' },
      { inputs: { title: 'Printer jams' }, truth: 'printer' },
      { inputs: { title: 'Laptop slow' }, truth: 'hardware' },
    ],
  });
  assert.deepEqual([evaluation.decision, evaluation.provider, evaluation.modelVersion], ['category', 'jev', 'jev-1-2026-10']);
  assert.equal(evaluation.accuracy, 0.6667);
  assert.deepEqual(evaluation.thresholds.applied, { n: 1, share: 0.3333, errorRate: 0 });
  assert.equal(evaluation.pinnable, true);
  await assert.rejects(
    evaluateDecision(decision, { model: { decisions: {} }, records: [] }),
    /give the App's commands/,
    'the answer type comes from the commands or is said outright',
  );
});

test('mistri decide eval: an estimate first, one record on --dry, and a pin only when it was earned', { timeout: 240_000 }, async (t) => {
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const database = await workspace.database('desk.db', (db) =>
    db.exec(`
      CREATE TABLE incident (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', category TEXT);
      INSERT INTO incident (id, title, status, category) VALUES
        (1, 'VPN down for everyone', 'closed', 'network'), (2, 'Printer jams on floor 3', 'closed', 'printer'),
        (3, 'Laptop is slow', 'closed', 'hardware'), (4, 'Wifi drops', 'closed', 'network'), (5, 'New one', 'new', NULL);
    `),
  );
  await workspace.write('app/app.json', {
    id: 'desk',
    name: 'Desk',
    sources: { desk: { connection: 'desk' } },
    resources: { incident: { access: 'write', actions: { categorize: { label: 'Categorize', command: 'categorize' } } } },
    auth: {
      providers: ['email'],
      store: workspace.path('auth.db'),
      roles: { automation: { read: true, commands: ['categorize'] } },
    },
    views: { incidents: { kind: 'list', from: 'incident' } },
    home: 'incidents',
  });
  const commandsFile = workspace.path('app/commands.mjs');
  writeFileSync(
    commandsFile,
    `import { defineCommand, defineCommands, field } from ${src('packages/mistri/src/server/commands.ts')};
export default defineCommands({
  categorize: defineCommand({ source: 'desk', target: 'incident',
    input: { category: field.choice(['network', 'hardware', 'printer']) },
    async handle({ db, record }, input) { await db.incident.update(record, { category: input.category }); } }),
});
`,
  );
  const jobsFile = workspace.path('app/jobs.mjs');
  writeFileSync(
    jobsFile,
    `import { defineDecision, defineDecisions, defineJobs } from ${src('packages/mistri/src/server/jobs.ts')};
export default defineJobs({}, {
  principals: { triage: { roles: ['automation'] } },
  decisions: defineDecisions({
    triageCategory: defineDecision({
      question: 'Which category is this incident?', target: 'incident', inputs: ['title'],
      answer: { command: 'categorize', field: 'category' },
      every: '0 0 1 1 *', where: 'status = new', apply: 0.9, runAs: 'triage', provider: 'jev',
    }),
  }),
});
`,
  );
  const config = workspace.path('mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'desk', url: database, writable: true }] }));
  const script = (laptop: string) => {
    const path = workspace.path(`script-${laptop}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        model: 'jev-1',
        modelVersion: 'jev-1-2026-10',
        costMicros: 2_000,
        decisions: {
          triageCategory: [
            { when: { title: 'VPN' }, answer: 'network', probability: 0.97 },
            { when: { title: 'Printer' }, answer: 'printer', probability: 0.95 },
            { when: { title: 'Laptop' }, answer: laptop, probability: 0.92 },
            { answer: 'network', probability: 0.6 },
          ],
        },
      }),
    );
    return path;
  };
  const evalCli = (extra: string[], laptop = 'hardware') =>
    runCli(
      [
        'decide',
        'eval',
        'triageCategory',
        '--app',
        workspace.path('app'),
        '--jobs',
        jobsFile,
        '--commands',
        commandsFile,
        '--config',
        config,
        ...extra,
      ],
      childEnv({ XDG_CONFIG_HOME: workspace.path('config'), MISTRI_DECIDE_SCRIPT: script(laptop) }),
    );
  const lockPath = workspace.path('app/decisions.lock');

  // Without --yes: the count and a price that errs high, and nothing asked.
  const unspent = await evalCli([]);
  assert.equal(unspent.code, 2, unspent.out + unspent.err);
  assert.match(unspent.out, /4 records to ask jev, about \$0\.01 at most/);
  assert.match(unspent.out, /run again with --yes/);
  assert.match(unspent.out, /4 records are asked about as they are now/, 'no history: the leak is said, not hidden');

  const over = await evalCli(['--yes', '--max-cost', '0.001']);
  assert.equal(over.code, 2, over.out + over.err);
  assert.match(over.out, /above --max-cost/);

  const dry = await evalCli(['--dry']);
  assert.equal(dry.code, 0, dry.out + dry.err);
  assert.match(dry.out, /nothing is sent/);
  assert.match(dry.out, /"question": "Which category is this incident\?"/);
  assert.match(dry.out, /"title": "VPN down for everyone"/);

  // The laptop answered wrong and sure of it: a third of what would apply was wrong.
  const wrong = await evalCli(['--yes', '--pin'], 'printer');
  assert.equal(wrong.code, 3, wrong.out + wrong.err);
  assert.match(wrong.out, /Not pinned: the applied share was wrong 33\.3% of the time/);
  assert.equal(existsSync(lockPath), false, 'nothing is written when the pin is not earned');

  const report = workspace.path('report.json');
  const earned = await evalCli(['--yes', '--pin', '--json', report]);
  assert.equal(earned.code, 0, earned.out + earned.err);
  assert.match(earned.out, /Pinned jev jev-1-2026-10 for "triageCategory"/);
  const evaluation = JSON.parse(readFileSync(report, 'utf8'));
  assert.deepEqual([evaluation.n, evaluation.accuracy, evaluation.costMicros], [4, 1, 8_000]);
  const pins = readDecisionLock(readFileSync(lockPath, 'utf8')).get('triageCategory')?.pins ?? [];
  assert.deepEqual(
    pins.map((pin) => [pin.provider, pin.modelVersion, pin.n, pin.error]),
    [['jev', 'jev-1-2026-10', 3, 0]],
  );
  // The eval never applied, and asked nothing about the record with no settled answer.
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    assert.deepEqual(
      db
        .prepare('SELECT category FROM incident ORDER BY id')
        .all()
        .map((row) => row.category),
      ['network', 'printer', 'hardware', 'network', null],
    );
  } finally {
    db.close();
  }
});

test('mistri decide eval on a row-policy App reads as its service, through the policy it names', { timeout: 240_000 }, async (t) => {
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const { seed } = await import('../examples/databases/lintel/seed.mjs');
  const file = seed(workspace.path('lintel.db'), { stores: true });
  const env = { ...childEnv(), LINTEL_MAIL_SECRET: 'decide-eval-mail-secret', PAYMENT_CALLBACK_SECRET: 'decide-eval-callback-secret' };
  const args = ['decide', 'eval', 'routeRepair', '--app', 'examples/apps/lintel', '--jobs', 'examples/apps/lintel/jobs.ts'];
  // Without the policy its reads would be the whole database, which the service never sees.
  const refused = await runCli([...args, '--config', `${file}.json`, '--dry'], env);
  assert.equal(refused.code, 1, refused.out + refused.err);
  assert.match(refused.err, /reads its rows under a policy: name it with --policy/);

  const dry = await runCli([...args, '--policy', 'examples/apps/lintel/policy.ts', '--config', `${file}.json`, '--dry'], env);
  assert.equal(dry.code, 0, dry.out + dry.err);
  const sent = JSON.parse(dry.out.slice(dry.out.indexOf('{'))) as {
    inputs: Record<string, unknown>;
    answer: { kind: string; choices: Array<{ key: number; label: string }> };
  };
  assert.deepEqual(Object.keys(sent.inputs), ['title', 'description', 'category', 'unit_id.property_id.name']);
  assert.equal(sent.answer.kind, 'reference');
  // The choices are the command's query, read as the service: active technicians, no one else on staff.
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const technicians = db.prepare(`SELECT id FROM staff WHERE role = 'technician' AND active = 1 ORDER BY id`).all() as Array<{
      id: number;
    }>;
    assert.deepEqual(
      sent.answer.choices.map((choice) => choice.key).sort((a, b) => a - b),
      technicians.map((row) => row.id),
    );
  } finally {
    db.close();
  }
});
