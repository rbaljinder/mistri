/**
 * `mistri check --json`: one document of every step's findings, each with
 * a stable code, its file, line and column, the definition path where it can
 * be told, and the fix — held to packages/mistri/schema/check.schema.json, with the codes
 * check-codes.md documents; and the same document from the `check` tool of
 * `mistri observe --mcp`, which needs no running dev server.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { VALIDATION_CODES, componentCode, pathOfMessage, validationCode } from '../packages/mistri/src/server/build/checkProblems.js';

const ROOT = resolve('.');
/* An App's starts are mistri's (test/support/bins.ts). */
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');
const work = mkdtempSync(join(tmpdir(), 'tablewalk-check-json-'));
after(() => rmSync(work, { recursive: true, force: true }));
mkdirSync(join(work, 'node_modules'));
mkdirSync(join(work, 'node_modules', '@mistriwork'), { recursive: true });
symlinkSync(join(ROOT, 'packages', 'mistri'), join(work, 'node_modules', '@mistriwork', 'mistri'), 'dir');
// The project installs TypeScript, as the quickstart does: the typecheck reads only the project's.
symlinkSync(join(ROOT, 'node_modules', 'typescript'), join(work, 'node_modules', 'typescript'), 'dir');
const db = join(work, 'tick.db');
spawnSync(process.execPath, [join(ROOT, 'examples/databases/tick/seed.mjs'), db], { encoding: 'utf8' });
const config = `${db}.json`;
const env = { ...process.env, XDG_CONFIG_HOME: join(work, 'xdg') };

interface Ran {
  code: number;
  out: string;
  err: string;
}
function run(args: string[]): Promise<Ran> {
  return new Promise((done, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', ENTRY, ...args],
      { cwd: ROOT, env, timeout: 180_000, killSignal: 'SIGKILL' },
      (error, out, err) => {
        if (error && (error as { killed?: boolean }).killed) {
          reject(new Error(`tablewalk ${args.join(' ')} did not exit`));
          return;
        }
        done({ code: (error as { code?: number } | null)?.code ?? 0, out, err });
      },
    );
  });
}
function app(name: string, files: Record<string, string>): string {
  const dir = join(work, name);
  for (const [file, text] of Object.entries({ 'package.json': '{ "type": "module" }\n', ...files })) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

/** The App served on a port of its own, and what its /api/app answers. */
async function served(dir: string): Promise<Response> {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port;
  await new Promise((done) => probe.close(done));
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', ENTRY, '--app', dir, '--config', config, '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: ROOT,
      env,
      stdio: 'ignore',
    },
  );
  try {
    for (let attempt = 0; attempt < 600; attempt++) {
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`).catch(() => undefined);
      if (ready?.ok) return await fetch(`http://127.0.0.1:${port}/api/app`);
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`the App in ${dir} was not served`);
  } finally {
    child.kill('SIGKILL');
  }
}

const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
  JSON.parse(readFileSync(join(ROOT, 'packages/mistri/schema/check.schema.json'), 'utf8')),
);
const conforms = (report: unknown) => assert.ok(validate(report), JSON.stringify(validate.errors));

type Problem = {
  code: string;
  severity: string;
  step: string;
  file?: string;
  line?: number;
  column?: number;
  path?: string;
  message: string;
  fix?: string;
  docs: string;
};
/** A problem as the snapshot holds it: what an agent keys on, never the sentence. */
const said = (problem: Problem) =>
  [problem.step, problem.severity, problem.code, problem.path ?? '', problem.severity === 'info' ? '' : (problem.line ?? 0)].join(' ');

/* An App wrong at every step a check can say: a typo tsc sees, a query and a
   computed column only the catalog sees, a header naming an action it does
   not have, a component that writes markup, a look it does not name. */
const BROKEN = {
  'app.ts': [
    "import { action, custom, defineApp, fields, header, listView, page } from '@mistriwork/mistri/app';",
    "import type { App } from './mistri-schema.d.ts';",
    "import { loud } from './components.ts';",
    '',
    'export default defineApp({',
    "  id: 'tiny', name: 'Tiny', connection: 'tick',",
    "  resources: { task: { access: 'write',",
    "    actions: { done: action('Done', { set: { completed: true }, when: 'complted = false' }) },",
    "    computed: { late: { type: 'boolean', value: 'due_on < today and not finished' } } } },",
    "  views: { tasks: listView('Tasks', 'task', { filters: ['complted'] }) },",
    "  pages: { task: page('task', [header({ status: 'completed', destructive: ['drop'] }), fields(['name']), custom('Loud', loud)]) },",
    "  home: 'tasks', auth: { roles: { reader: { label: 'Reader', read: true, write: true } } }, api: { version: 1, roles: ['reader'], resources: { task: { fields: ['id'] } } },",
    '} satisfies App);',
    '',
  ].join('\n'),
  'components.ts':
    "import { component } from '@mistriwork/mistri/app';\nexport const loud = component('loud', { module: './widgets/Loud.jsx' });\n",
  'widgets/Loud.jsx':
    'export default function Loud({ rows }) {\n  return <div className="c-loud" dangerouslySetInnerHTML={{ __html: String(rows) }} />;\n}\n',
};

describe('mistri check --json', () => {
  test('design warnings are advisory by default and fail explicitly in automation', async () => {
    const dir = app('design-warning', {
      'app.ts':
        "export default { id: 'tiny', name: 'Tiny', connection: 'tick', resources: { task: {} }, views: { tasks: { kind: 'list', from: 'task' } }, home: 'tasks' };\n",
    });
    for (const strict of [false, true]) {
      const ran = await run(['check', '--app', dir, '--config', config, strict ? '--fail-on-design-warning' : '--design', '--json']);
      assert.equal(ran.code, strict ? 4 : 0, ran.out + ran.err);
      const report = JSON.parse(ran.out);
      conforms(report);
      assert.equal(report.ok, !strict);
      assert.equal(report.steps.find((step: { step: string }) => step.step === 'design').status, strict ? 'failed' : 'passed');
      assert.ok(report.problems.some((finding: Problem) => finding.step === 'design' && finding.severity === 'warning'));
    }
    const clean = await run(['check', '--app', 'examples/apps/tick', '--config', config, '--fail-on-design-warning', '--json']);
    assert.equal(clean.code, 0, clean.out + clean.err);
    conforms(JSON.parse(clean.out));
  });

  test("a broken App: every step's findings, coded and placed, in one document the schema holds", async () => {
    const dir = app('broken', BROKEN);
    const ran = await run(['check', '--app', dir, '--config', config, '--routes', '--design', '--json']);
    assert.equal(ran.code, 3, ran.err);
    const report = JSON.parse(ran.out);
    conforms(report);
    assert.equal(report.ok, false);
    assert.equal(report.exit, 3);
    assert.deepEqual(report.app, { id: 'tiny', name: 'Tiny' });
    assert.deepEqual(
      report.steps.map((step: { step: string; status: string }) => `${step.step} ${step.status}`),
      ['schema types passed', 'typecheck failed', 'validation failed', 'components failed', 'routes passed', 'design passed'],
    );
    const problems = report.problems as Problem[];
    /* The action's `when` twice: defineApp reads the whole condition against its block's table and names the
       column, and `satisfies App` still holds its first word to the table's columns. */
    assert.deepEqual(problems.map(said), [
      'typecheck error TS2322 resources.task.actions.done 8',
      'typecheck error TS2322 resources.task.actions.done 8',
      'typecheck error TS2322 views.tasks 10',
      'typecheck error TS2322 pages.task 11',
      'validation error unknown-column resources.task.computed.late 9',
      'validation error unknown-column views.tasks.filters 10',
      'validation error unknown-column resources.task.actions.done.when 8',
      'validation error unknown-action pages.task 11',
      'validation warning admin-grants-nothing auth.roles.admin 12',
      'components error component-markup components.loud 2',
      'design warning default-shell ui.shell 0',
    ]);
    assert.match(problems[0].message, /`complted` is not a column of task/);
    const typo = problems[2];
    assert.equal(typo.file, join(dir, 'app.ts'));
    assert.equal(typo.column, 12);
    // A list's filter is a label path since filters reach across related tables (af79c70b): the fix says which place.
    assert.match(typo.fix!, /"complted" is not a column of task, nor a label path from it through its references/);
    assert.equal(typo.docs, 'https://mistriwork.dev/docs/check-codes/#typecheck');
    // A header's destructive id is checked by tsc against the page's resource's action ids, and by validation.
    assert.match(problems[3].message, /Type '"drop"' is not assignable to type '"done"'/);
    assert.match(problems[7].message, /the header's destructive "drop" is not an action of "task"\. Its actions: "done"\./);
    assert.equal(problems[7].docs, 'https://mistriwork.dev/docs/check-codes/#unknown-action');
    assert.match(problems.find((problem) => problem.step === 'design')!.fix!, /ui: \{ theme: \{ preset:/);
    assert.equal(report.routes[0].path, '/');
  });

  test("a database it cannot reach fails the schema types, and a call it cannot act on is one could-not-check problem; the exit codes are the command's", async () => {
    const elsewhere = app('elsewhere', {
      'app.ts': BROKEN['app.ts'].replace("connection: 'tick'", "connection: 'nowhere'"),
      'components.ts': BROKEN['components.ts'],
      'widgets/Loud.jsx': BROKEN['widgets/Loud.jsx'],
      'mistri-schema.d.ts': '// Generated by `mistri check --app <app>` from the "Tiny" app resources.\nexport type App = any;\n',
    });
    const unreached = await run(['check', '--app', elsewhere, '--config', config, '--json']);
    assert.equal(unreached.code, 2, unreached.err);
    const report = JSON.parse(unreached.out);
    conforms(report);
    assert.equal(report.problems[0].code, 'unknown-connection');
    assert.equal(report.problems[0].step, 'schema types');

    const refused = await run(['check', '--json']);
    assert.equal(refused.code, 1);
    const said = JSON.parse(refused.out);
    conforms(said);
    assert.deepEqual(
      said.problems.map((problem: Problem) => [problem.code, problem.step]),
      [['could-not-check', 'check']],
    );
    assert.match(said.problems[0].message, /--app <dir> names the App to check/);
  });

  test("a pending migration that fails on the copy is the pending step's, exit 6", async () => {
    const dir = app('pending', {
      'app.ts':
        "export default { id: 'tiny', name: 'Tiny', connection: 'tick', resources: { task: {} }, views: { tasks: { kind: 'list', from: 'task' } }, home: 'tasks' };\n",
      'migrations/V1__broken.sql': 'CREATE TABLE task (id INTEGER PRIMARY KEY);\n',
    });
    const ran = await run(['check', '--app', dir, '--config', config, '--pending', '--json']);
    assert.equal(ran.code, 6, ran.out + ran.err);
    const report = JSON.parse(ran.out);
    conforms(report);
    assert.deepEqual(
      report.problems.map((problem: Problem) => [problem.step, problem.code]),
      [['pending', 'pending-migration']],
    );
  });

  /* Three misplacements a real run hit: a check.json left in the App's folder was read as a source, a `show`
     array on its own line lost its line, and Tick's misspelt column went to the record page's line, which held
     the table's name and the "Did you mean" column. */
  test("a validation finding is placed at the line of the App's own source that says it", async () => {
    const source = [
      "import { defineApp, listView } from '@mistriwork/mistri/app';",
      '',
      'export default defineApp({',
      "  id: 'tiny', name: 'Tiny', connection: 'tick',",
      "  resources: { task: { access: 'write' } },",
      '  views: {',
      "    tasks: listView('Tasks', 'task', {",
      "      show: ['name', 'complted'],",
      '    }),',
      '  },',
      "  home: 'tasks',",
      '});',
      '',
    ].join('\n');
    const dir = app('placed', { 'app.ts': source });
    const lineOf = (text: string, needle: string) => text.split('\n').findIndex((line) => line.includes(needle)) + 1;
    const placed = async (where: string) => {
      const ran = await run(['check', '--app', where, '--config', config, '--json']);
      const finding = (JSON.parse(ran.out).problems as Problem[]).find((problem) => problem.code === 'unknown-column');
      assert.ok(finding, ran.out + ran.err);
      return { finding, out: ran.out };
    };
    const first = await placed(dir);
    assert.deepEqual([first.finding.file, first.finding.line], [join(dir, 'app.ts'), lineOf(source, "show: ['name'")]);
    // The report saved beside the App holds the same words; it is not a source.
    writeFileSync(join(dir, 'check.json'), JSON.stringify(JSON.parse(first.out), null, 2));
    const again = await placed(dir);
    assert.deepEqual([again.finding.file, again.finding.line], [join(dir, 'app.ts'), lineOf(source, "show: ['name'")]);
    const text = await run(['check', '--app', dir, '--config', config]);
    assert.match(text.out, new RegExp(`app\\.ts:${lineOf(source, "show: ['name'")}  (app\\.ts: )?view "tasks"`));

    const tick = readFileSync(join(ROOT, 'examples/apps/tick/app.ts'), 'utf8');
    const shown = "show: ['name', 'completed', 'due_on']";
    assert.ok(tick.includes(shown));
    const misspelt = tick.replace(shown, "show: ['name', 'completed', 'due_onn']");
    const tickDir = app('tick-misspelt', { 'app.ts': misspelt });
    const tickFinding = (await placed(tickDir)).finding;
    assert.deepEqual([tickFinding.file, tickFinding.line], [join(tickDir, 'app.ts'), lineOf(misspelt, "'due_onn'")]);
  });

  /* N2: a changed lock is a change the author made on purpose, accepted with --write-authority. Its diff is the one
     finding's, never a line each said as an invalid App with "Correct the declaration". */
  test('a changed authority lock is one authority-lock finding that carries its diff', async () => {
    const dir = app('lock-changed', { 'app.ts': readFileSync(join(ROOT, 'examples/apps/tick/app.ts'), 'utf8') });
    const wrote = await run(['check', '--app', dir, '--config', config, '--write-authority']);
    assert.equal(wrote.code, 0, wrote.out + wrote.err);
    const lock = readFileSync(join(dir, 'authority.lock'), 'utf8');
    const fact = lock.split('\n').find((line) => line.startsWith('resource '));
    assert.ok(fact, lock);
    writeFileSync(join(dir, 'authority.lock'), lock.replace(`${fact}\n`, ''));
    const ran = await run(['check', '--app', dir, '--config', config, '--json']);
    assert.equal(ran.code, 4, ran.out + ran.err);
    const report = JSON.parse(ran.out);
    conforms(report);
    const errors = (report.problems as Problem[]).filter((problem) => problem.severity === 'error');
    assert.deepEqual(
      errors.map((problem) => problem.code),
      ['authority-lock'],
      JSON.stringify(errors),
    );
    assert.match(errors[0]!.message, /--write-authority/);
    assert.ok(errors[0]!.message.includes(`+ ${fact}`), errors[0]!.message);
  });

  test('check and the served App agree: a validation reading a computed column is accepted by both (DM5)', async () => {
    const tick = readFileSync(join(ROOT, 'examples/apps/tick/app.ts'), 'utf8');
    const written = (must: string) =>
      tick.replace("      access: 'write',", `      access: 'write',\n      validation: [{ must: '${must}', message: 'Not overdue.' }],`);
    // The computed column is worked out of the stored row where the rule is judged, as a list works it out.
    const computed = app('validation-computed', { 'app.ts': written('is_overdue = false') });
    const ran = await run(['check', '--app', computed, '--config', config, '--json']);
    assert.equal(ran.code, 0, ran.out + ran.err);
    assert.equal((await served(computed)).status, 200);
    // A column that is neither stored nor computed is refused by both.
    const broken = app('validation-unknown', { 'app.ts': written('is_overdo = false') });
    const refused = await run(['check', '--app', broken, '--config', config, '--json']);
    assert.equal(refused.code, 4, refused.out + refused.err);
    const finding = (JSON.parse(refused.out).problems as Problem[]).find((problem) => /is_overdo/.test(problem.message));
    assert.ok(finding, refused.out);
    assert.equal(finding.file, join(broken, 'app.ts'));
    assert.equal((await served(broken)).status, 500);
  });

  test('a finding about a resource kept in its own module is placed there, never in a test or seed beside it', async () => {
    const dir = app('placed-module', {
      'app.ts': [
        "import { defineApp, listView } from '@mistriwork/mistri/app';",
        "import { resources } from './resources.ts';",
        '',
        "export default defineApp({ id: 'tiny', name: 'Tiny', connection: 'tick', resources, views: { tasks: listView('Tasks', 'task', {}) }, home: 'tasks' });",
        '',
      ].join('\n'),
      'resources.ts': [
        "import { action } from '@mistriwork/mistri/app';",
        '',
        'export const resources = {',
        '  task: {',
        "    access: 'write' as const,",
        "    actions: { finish: action('Finish', { set: { completd: true } }) },",
        '  },',
        '};',
        '',
      ].join('\n'),
      // The same words in a test and a seed script: neither is where the App says them.
      'tests/authorization.test.mjs': "export const rows = [['task', 'finish', 'completd']];\n",
      'db/seed.mjs': "export const finish = { completd: 'completd' };\n",
    });
    const ran = await run(['check', '--app', dir, '--config', config, '--json']);
    const finding = (JSON.parse(ran.out).problems as Problem[]).find((problem) => problem.code === 'unknown-column');
    assert.ok(finding, ran.out + ran.err);
    assert.deepEqual([finding.file, finding.line], [join(dir, 'resources.ts'), 6]);
  });

  test('--design --fix says what is left after its deletions, not the warnings it just answered', async () => {
    const tick = readFileSync(join(ROOT, 'examples/apps/tick/app.ts'), 'utf8');
    const restated = tick.replace("      access: 'write',", "      access: 'write',\n      labels: { name: 'Name' },");
    const dir = app('fix-then-check', { 'app.ts': restated });
    const before = await run(['check', '--app', dir, '--config', config, '--design', '--json']);
    assert.ok(
      (JSON.parse(before.out).problems as Problem[]).some((problem) => problem.code === 'restated'),
      before.out,
    );
    const ran = await run(['check', '--app', dir, '--config', config, '--design', '--fix', '--json']);
    assert.equal(ran.code, 0, ran.out + ran.err);
    const report = JSON.parse(ran.out);
    conforms(report);
    assert.deepEqual(
      report.problems.filter((problem: Problem) => problem.code === 'restated'),
      [],
    );
    assert.doesNotMatch(readFileSync(join(dir, 'app.ts'), 'utf8'), /labels:/);
  });

  test('warnings print as one line a kind after the errors, and --warnings lists them in full', async () => {
    const tick = readFileSync(join(ROOT, 'examples/apps/tick/app.ts'), 'utf8');
    const restated = tick.replace("      access: 'write',", "      access: 'write',\n      labels: { name: 'Name' },");
    const dir = app('warnings-summary', { 'app.ts': restated });
    const brief = await run(['check', '--app', dir, '--config', config, '--design']);
    assert.match(brief.out, /1 warning \(restated 1\); --warnings lists them\./, brief.out);
    assert.doesNotMatch(brief.out, /warning: [^\n]*\[restated\]/);
    const full = await run(['check', '--app', dir, '--config', config, '--design', '--warnings']);
    assert.match(full.out, /warning: [^\n]*\[restated\]/, full.out);
    assert.doesNotMatch(full.out, /lists them\./);
    // The JSON report keeps every finding either way.
    const json = await run(['check', '--app', dir, '--config', config, '--design', '--json']);
    assert.ok((JSON.parse(json.out).problems as Problem[]).some((problem) => problem.code === 'restated'));
  });

  test('an App that uses flags and an experiment gets one preview-feature finding at information severity, and still passes', async () => {
    const dir = app('preview-flags', {
      'app.ts': `export default { id: 'tiny', name: 'Tiny', connection: 'tick', resources: { task: {} },
        views: { tasks: { kind: 'list', from: 'task' } }, home: 'tasks',
        flags: { copy: { type: 'string', default: 'a', variants: ['a', 'b'], safeValue: 'a', owner: 'growth' } },
        experiments: { copy: { version: 'v1', unit: 'subject', control: 'a', startsAt: '2026-11-01T00:00:00.000Z',
          endsAt: '2026-11-15T00:00:00.000Z', conversionWindow: '48 hours', deliveryGrace: '24 hours',
          eligibility: { rollout: 100 }, allocation: [{ value: 'a', weight: 50 }, { value: 'b', weight: 50 }],
          primary: { conversion: 'submitted' } } } };\n`,
    });
    const ran = await run(['check', '--app', dir, '--config', config, '--json']);
    const report = JSON.parse(ran.out);
    conforms(report);
    const errors = report.problems.filter((found: Problem) => found.severity === 'error').map((found: Problem) => found.message);
    const said = report.problems.filter((found: Problem) => found.code === 'preview-feature');
    assert.equal(said.length, 1, ran.out);
    assert.equal(said[0].severity, 'info');
    assert.match(said[0].message, /flags, experiments/);
    assert.match(said[0].message, /may change in any 1\.x release/);
    assert.ok(!errors.some((message: string) => /Preview/.test(message)), errors.join('\n'));
    // The text outputs say it once too: info is not a problem, but an author should hear which Preview features they use.
    const text = await run(['check', '--app', dir, '--config', config]);
    assert.equal(text.out.match(/Preview features/g)?.length, 1, text.out);
    assert.match(text.out, /^ {2}preview: This App uses Preview features \(flags, experiments\)/m, text.out);
    const brief = await run(['check', '--app', dir, '--config', config, '--brief']);
    assert.match(brief.out, /^ok\npreview-feature \(info\) \S+app\.ts This App uses Preview features \(flags, experiments\)/, brief.out);
  });

  test('an App that uses no Preview feature says nothing about Preview', async () => {
    const ran = await run(['check', '--app', 'examples/apps/tick', '--config', config, '--json']);
    assert.equal(JSON.parse(ran.out).problems.filter((found: Problem) => found.code === 'preview-feature').length, 0);
  });

  test('Lintel, the flagship, checks with no error; its Gantt is one information finding', async () => {
    const { seed } = await import('../examples/databases/lintel/seed.mjs');
    const file = seed(join(work, 'lintel.db'), { stores: true });
    const ran = await run([
      'check',
      '--app',
      'examples/apps/lintel',
      '--config',
      `${file}.json`,
      '--jobs',
      'examples/apps/lintel/jobs.ts',
      '--policy',
      'examples/apps/lintel/policy.ts',
      '--json',
    ]);
    const report = JSON.parse(ran.out);
    conforms(report);
    assert.deepEqual(
      report.problems.filter((found: Problem) => found.severity === 'error'),
      [],
      ran.out,
    );
    const said = report.problems.filter((found: Problem) => found.code === 'preview-feature');
    assert.equal(said.length, 1);
    assert.equal(said[0].severity, 'info');
    assert.match(said[0].message, /gantt/);
    assert.equal(report.ok, true);
  });

  test('a clean App is ok with no errors', async () => {
    const ran = await run(['check', '--app', 'examples/apps/tick', '--config', config, '--json']);
    assert.equal(ran.code, 0, ran.err);
    const report = JSON.parse(ran.out);
    conforms(report);
    assert.equal(report.ok, true);
    assert.deepEqual(
      report.problems.filter((problem: Problem) => problem.severity === 'error'),
      [],
    );
  });
});

describe('the codes and the paths', () => {
  test('every code a check can say is documented in check-codes.md', () => {
    const page = readFileSync(join(ROOT, 'site/src/content/docs/docs/check-codes.md'), 'utf8');
    const codes = [
      ...VALIDATION_CODES.map((entry) => entry.code),
      'invalid-app',
      'deprecated',
      'could-not-check',
      'pending-migration',
      'unknown-connection',
      'database-unreachable',
      'schema-types-stale',
      'schema-types',
      'mount',
      'route-clash',
      'app-on-mysql',
      ...['markup', 'code-from-text', 'environment', 'color', 'radius', 'motion', 'shadow', 'class', 'ruler'].map(
        (rule) => `component-${rule}`,
      ),
      /* A free-form page's refusals carry their code in brackets (appPages.ts, appViews.ts, pageLoaderCheck.ts). */
      ...['file', 'path', 'nav', 'reads', 'params', 'commands', 'public', 'coverage', 'loader', 'undeclared', 'layout'].map(
        (rule) => `page-${rule}`,
      ),
      /* A page's archetype carries its code in brackets (shared/pageLayouts.ts). */
      ...['conversation', 'showcase', 'article'].map((layout) => `layout-${layout}`),
      /* An App's words carry their code in brackets (server/app/appMessages.ts). */
      ...['missing', 'syntax', 'placeholder', 'arg', 'untranslated', 'unused'].map((rule) => `message-${rule}`),
      /* An App's use of integrations carries its code in brackets (integrationChecks.ts, integrationDeclaration.ts). */
      ...['unknown', 'action-unknown', 'event-unknown', 'channel-unknown', 'event-input', 'service-role'].map(
        (rule) => `integration-${rule}`,
      ),
      /* A row-policy App's services and events (policyServiceChecks.ts, apiEventFeed.ts). */
      ...['service-unnamed', 'service-unused', 'service-rows', 'events-feed'].map((rule) => `policy-${rule}`),
      /* The human check `auth.challenge` names (commands/challenges.ts, app/apps.ts). */
      'auth-challenge',
      /* Mail to an address a record holds (integrationChecks.ts contactEmailFindings). */
      ...['transport', 'links-secret', 'timezone', 'source', 'unproven', 'consent'].map((rule) => `notify-send-${rule}`),
    ];
    for (const code of codes) assert.match(page, new RegExp(`\`${code}\``), code);
    /* The steps, exit codes and --json contract share the page with the codes, and each code's row is the anchor a problem's `docs` link names. */
    assert.match(page, /## For an agent: `--json`/);
    for (const code of codes) assert.match(page, new RegExp(`<span id="${code}"></span>`), `${code} has no anchor for its docs link`);
  });

  test('a sentence is read for its code and its path', () => {
    assert.equal(validationCode('resources "loan", role "x" [outside-ceiling]: …'), 'outside-ceiling');
    assert.equal(validationCode('view "tasks": has no "sho". Did you mean "show"? It takes: kind, table'), 'unknown-key');
    assert.equal(validationCode('something else entirely'), 'invalid-app');
    assert.equal(componentCode('eval runs text as code'), 'component-code-from-text');
    assert.equal(
      pathOfMessage('features "billing", view "invoices": "total" is not a column on invoice'),
      'features.billing.views.invoices',
    );
    assert.equal(pathOfMessage('"auth", role "staff", "fields", "task", write names "x"'), 'auth.roles.staff.fields.task.write');
    assert.equal(pathOfMessage('nav entry 3 (Work): nav entry 2: names the view "x"'), 'nav[2].children[1]');
    assert.equal(pathOfMessage('page "Order": the header\'s primary "x"', new Map([['Order', 'order']])), 'pages.order');
  });
});

describe('mistri observe --mcp', () => {
  test('lists a check tool that answers the same document, with no dev server running', async () => {
    const dir = app('mcp', BROKEN);
    const messages = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check', arguments: { app: dir, config } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'recent_errors', arguments: {} } },
    ]
      .map((message) => JSON.stringify(message))
      .join('\n');
    const mcp = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, 'observe', '--mcp'], {
      cwd: ROOT,
      env,
      input: `${messages}\n`,
      encoding: 'utf8',
      timeout: 180_000,
    });
    const answers = new Map(
      mcp.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .map((answer) => [answer.id, answer]),
    );
    const check = answers.get(2).result.tools.find((tool: { name: string }) => tool.name === 'check');
    assert.equal(check.annotations.readOnlyHint, false);
    const report = answers.get(3).result.structuredContent;
    conforms(report);
    assert.equal(report.exit, 3);
    assert.ok(report.problems.some((problem: Problem) => problem.code === 'unknown-action' && problem.path === 'pages.task'));
    // The telemetry tools say what is missing rather than failing the session.
    assert.equal(answers.get(4).result.isError, true);
    assert.match(answers.get(4).result.content[0].text, /No dev server is running/);
  });
});
