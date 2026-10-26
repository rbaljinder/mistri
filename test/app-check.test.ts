/**
 * `mistri check` as a command: each step's verdict on its own line, the
 * exit code of the first step that failed, the generated schema types kept
 * in step with the database (and a hand-written file left alone), and tsc's
 * report cut down to where, what and a hint.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readableTypeErrors } from '../packages/mistri/src/server/build/typecheck.js';
import { checkedRoutes, splitWarnings, warningKind, warningSummary } from '../packages/mistri/src/server/build/check.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { NO_MOUNT } from '../packages/engine/src/shared/mount.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const ROOT = resolve('.');
/* An App's starts are mistri's (test/support/bins.ts). */
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');
/* Outside the checkout, with tablewalk "installed" beside the Apps: the way
   a project that ran npm install resolves @mistriwork/mistri/app. */
const work = mkdtempSync(join(tmpdir(), 'tablewalk-check-'));
after(() => rmSync(work, { recursive: true, force: true }));
mkdirSync(join(work, 'node_modules'));
mkdirSync(join(work, 'node_modules', '@mistriwork'), { recursive: true });
symlinkSync(join(ROOT, 'packages', 'mistri'), join(work, 'node_modules', '@mistriwork', 'mistri'), 'dir');
// The project installs TypeScript, as the quickstart does: the typecheck reads only the project's.
symlinkSync(join(ROOT, 'node_modules', 'typescript'), join(work, 'node_modules', 'typescript'), 'dir');
const db = join(work, 'tick.db');
spawnSync(process.execPath, [join(ROOT, 'examples/databases/tick/seed.mjs'), db], { encoding: 'utf8' });
const config = `${db}.json`;

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
      { cwd: ROOT, timeout: 120_000, killSignal: 'SIGKILL' },
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
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries({ 'package.json': '{ "type": "module" }\n', ...files })) writeFileSync(join(dir, file), text);
  return dir;
}
/** A tiny App over Tick's table, typed by the generated file; `view` is spliced into its one list view. */
const tiny = (view: string) =>
  [
    "import type { App } from './mistri-schema.d.ts';",
    "import { listView } from '@mistriwork/mistri/app';",
    "export default { id: 'tiny', name: 'Tiny', connection: 'tick', resources: { task: {} },",
    `  views: { tasks: listView('Tasks', 'task'${view ? `, { ${view.slice(2)} }` : ''}) }, home: 'tasks' } satisfies App;`,
    '',
  ].join('\n');

describe('mistri check, the command', () => {
  test('refuses a call it cannot act on, with exit code 1', async () => {
    const none = await run(['check']);
    assert.equal(none.code, 1);
    assert.match(none.err, /--app <dir> names the App to check/);
    const unknown = await run(['check', '--app', 'examples/apps/tick', '--strict']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /unknown option "--strict"/);
    const mode = await run(['check', '--app', 'examples/apps/tick', '--mcp']);
    assert.equal(mode.code, 1);
    assert.match(mode.err, /--mcp is a mode of its own/);
    const nothing = await run(['check', '--app', 'examples/apps/tick', '--no-config']);
    assert.equal(nothing.code, 1);
    assert.match(nothing.err, /no database to check the App against/);
    const help = await run(['check', '--help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /Exit codes: 1 could not check, 2 schema types, 3 typecheck, 4 validation/);
  });

  test('checks Tick: inline types need no generated file, the typecheck and validation pass', async () => {
    const ran = await run(['check', '--app', 'examples/apps/tick', '--config', config]);
    assert.equal(ran.code, 0, ran.out + ran.err);
    const lines = ran.out.trim().split('\n');
    assert.equal(lines[0], 'Checking "Tick" in examples/apps/tick');
    assert.match(lines[1], /^ {2}schema types {2}skipped the App keeps its types inline/);
    assert.match(lines[2], /^ {2}typecheck {5}passed {2}tsc \d+\.\d+\.\d+, 1 file, no tsconfig\.json$/);
    assert.match(lines[3], /^ {2}validation {4}passed {2}Tick: ok$/);
    assert.match(lines.at(-1)!, /^Checked in [\d.]+s: 2 of 3 steps passed, the rest skipped as said\.$/);
  });

  test('writes missing schema types, then a type error fails the typecheck with exit code 3, a hint and where', async () => {
    const dir = app('mistyped', { 'app.ts': tiny(", filters: ['complted']") });
    const ran = await run(['check', '--app', dir, '--config', config]);
    assert.equal(ran.code, 3, ran.out + ran.err);
    assert.match(ran.out, /schema types {2}passed {2}wrote mistri-schema\.d\.ts from the database/);
    assert.match(
      readFileSync(join(dir, 'mistri-schema.d.ts'), 'utf8'),
      /\n {2}task: "id" \| "name" \| "completed" \| "due_on" \| "position";/,
    );
    assert.match(ran.out, /typecheck {5}failed {2}tsc/);
    assert.match(ran.out, /\n {24}app\.ts:\d+:\d+ {2}TS\d+ {2}/);
    assert.match(ran.out, /Type '"complted"' is not assignable to type .*Did you mean '"completed"'\?/);
    // A list's filter is a label path since filters reach across related tables (af79c70b): the hint says which place.
    assert.match(ran.out, /hint: "complted" is not a column of task, nor a label path from it through its references/);
    // Every step runs, so one pass has every finding: validation names it too.
    assert.match(ran.out, /validation {4}failed/);
    assert.match(ran.out, /typecheck and validation failed \(1 of 3 passed\) in [\d.]+s\. Exit 3\.$/m);
  });

  test('a query naming a column the table lacks fails the typecheck, and the error names the column', async () => {
    const dir = app('misqueried', { 'app.ts': tiny(", query: 'nmae = x'") });
    const ran = await run(['check', '--app', dir, '--config', config]);
    assert.equal(ran.code, 3, ran.out + ran.err);
    assert.match(ran.out, /`nmae` is not a column of task/);
    assert.match(
      ran.out,
      /hint: `nmae` is not a column of task\. A query string is read against its table's columns in mistri-schema\.d\.ts/,
    );
  });

  test('a related list that sets both whose and same fails validation, naming the section', async () => {
    // The types refuse the pair too; `as never` is the untyped author the catalog still has to catch.
    const dir = app('both-keys', {
      'app.ts': tiny('')
        .replace(
          'resources: { task: {} },',
          "resources: { task: {} }, pages: { task: page('task', [related('Peers', 'task', { same: ['name'] }, { whose: 'id' } as never)]) },",
        )
        .replace('import { listView }', 'import { listView, page, related }'),
    });
    const ran = await run(['check', '--app', dir, '--config', config]);
    assert.equal(ran.code, 4, ran.out + ran.err);
    assert.match(ran.out, /section 1 \("Peers"\) has "whose" beside "same"/);
  });

  test('a mistake only the catalog sees fails validation, with exit code 4', async () => {
    // The schema types stand down on an upper-case AND (packages/mistri/schema/query.d.ts reads lower-case words only),
    // so this query reaches the catalog, which reads every spelling.
    const dir = app('unresolved', { 'app.ts': tiny(", query: 'nmae = x AND id > 0'") });
    const ran = await run(['check', '--app', dir, '--config', config]);
    assert.equal(ran.code, 4, ran.out + ran.err);
    assert.match(ran.out, /typecheck {5}passed/);
    assert.match(ran.out, /validation {4}failed {2}Tiny: 1 problem/);
    assert.match(ran.out, /"nmae" is not a column on task\. Did you mean "name"\?/);
    // The types let this string through, so the finding is placed where its words were typed.
    assert.match(ran.out, /app\.ts:4 {2}.*"nmae" is not a column on task/);
  });

  test('generated types that drifted from the database are rewritten and said; a hand-written file is left alone', async () => {
    const stale = [
      '// Generated by `mistri check --app <app>` from the "Tiny" app resources.',
      "import type { TypedAppConfig } from '@mistriwork/mistri/app';",
      'export type Tables = {',
      '  task: "id" | "name";',
      '};',
      "export type App = TypedAppConfig<Tables, never, 'tick'>;",
      '',
    ].join('\n');
    const dir = app('drifted', { 'app.ts': tiny(", show: ['due_on']"), 'mistri-schema.d.ts': stale });
    const ran = await run(['check', '--app', dir, '--config', config]);
    assert.equal(ran.code, 0, ran.out + ran.err);
    assert.match(ran.out, /updated mistri-schema\.d\.ts to match the database and the App's resources — task \(columns changed\)/);
    assert.match(readFileSync(join(dir, 'mistri-schema.d.ts'), 'utf8'), /"due_on"/);
    const again = await run(['check', '--app', dir, '--config', config]);
    assert.match(again.out, /schema types {2}passed {2}mistri-schema\.d\.ts matches the database/);

    const own = stale.replace(/^\/\/ Generated by .*\n/, '// Kept by hand.\n');
    const kept = app('handwritten', { 'app.ts': tiny(''), 'mistri-schema.d.ts': own });
    const left = await run(['check', '--app', kept, '--config', config]);
    assert.match(left.out, /schema types {2}skipped mistri-schema\.d\.ts was not generated by mistri, so it is left as it is/);
    assert.equal(readFileSync(join(kept, 'mistri-schema.d.ts'), 'utf8'), own);
  });
});

describe('types an older mistri wrote', () => {
  // A field report from the user's own App: a header the generator no longer writes made `check` skip the file as
  // someone else's, and the typecheck's errors never said the types were stale.
  for (const header of ['// Generated by `mistri --app <app> --export types` from the "Tiny" app resources.'])
    test(`${header.slice(3, 40)}... is recognised as mistri's own and regenerated`, async () => {
      const old = [
        header,
        "import type { TypedAppConfig } from '@mistriwork/mistri/app';",
        'export type Tables = {',
        '  task: "id";',
        '};',
        '',
      ].join('\n');
      const dir = app(`older-${header.length}`, { 'app.ts': tiny(''), 'mistri-schema.d.ts': old });
      const ran = await run(['check', '--app', dir, '--config', config]);
      assert.doesNotMatch(ran.out, /was not generated by mistri/);
      assert.match(ran.out, /updated mistri-schema\.d\.ts/);
      assert.match(readFileSync(join(dir, 'mistri-schema.d.ts'), 'utf8'), /^\/\/ Generated by `mistri check --app <app>`/);
    });
});

describe('tsc, said readably', () => {
  test('a config beside the App may list it with the environment its definition reads; another App is still refused', async () => {
    process.env.TABLEWALK_TEST_TITLE = 'Tiny from env';
    const read = JSON.parse(readFileSync(config, 'utf8')) as { connections: unknown[] };
    const dir = app('with-env', {
      'app.mjs':
        "export default { id: 'tiny', name: process.env.TABLEWALK_TEST_TITLE, connection: 'tick', resources: { task: {} }, views: { tasks: { kind: 'list', from: 'task' } }, home: 'tasks' };\n",
    });
    writeFileSync(
      join(dir, 'mistri.json'),
      JSON.stringify({ connections: read.connections, apps: [{ dir: '.', env: ['TABLEWALK_TEST_TITLE'] }] }),
    );
    const ran = await run(['check', '--app', dir, '--config', join(dir, 'mistri.json')]);
    assert.equal(ran.code, 0, ran.out + ran.err);
    assert.match(ran.out, /^Checking "Tiny from env" in /);
    assert.match(ran.out, /validation {4}passed {2}Tiny from env: ok/);
    writeFileSync(join(dir, 'other.json'), JSON.stringify({ connections: read.connections, apps: ['../mistyped'] }));
    const other = await run(['check', '--app', dir, '--config', join(dir, 'other.json')]);
    assert.equal(other.code, 1, other.out + other.err);
    assert.match(other.err, /lists "apps" other than/);
  });

  test('a column where a reference goes is said to be a column but not a foreign key', () => {
    const lines = readableTypeErrors(
      ['pages/work.ts(5,40): error TS2322: Type \'"site_code"\' is not assignable to type \'"technician_id.region_id"\'.'].join('\n'),
      20,
      new Set(['id', 'site_code', 'technician_id']),
    );
    assert.match(lines[1], /hint: "site_code" is a column, but not a foreign key[\s\S]*mistri docs relationships/);
    // A typo that is no column keeps the spelling hint.
    assert.match(
      readableTypeErrors(
        'a.ts(1,1): error TS2322: Type \'"sit_code"\' is not assignable to type \'"technician_id"\'.',
        20,
        new Set(['site_code']),
      )[1],
      /hint: "sit_code" is not a name this place accepts/,
    );
  });

  test('a hidden column where a column is shown is said to be hidden, not misspelled', () => {
    const hidden = new Map([['vehicle', new Set(['cost'])]]);
    const shown = readableTypeErrors(
      'views.ts(4,9): error TS2322: Type \'"cost"\' is not assignable to type \'LabelPath<Tables, References, "vehicle">\'.',
      20,
      new Set(['id', 'price']),
      false,
      hidden,
    );
    assert.match(shown[1], /hint: "cost" is a column of vehicle that no reader is served \(`hidden`, or outside every role's `fields`\)/);
    // The same name judged against another table is that table's typo.
    const elsewhere = readableTypeErrors(
      'views.ts(4,9): error TS2322: Type \'"cost"\' is not assignable to type \'LabelPath<Tables, References, "lead">\'.',
      20,
      new Set(['id', 'price']),
      false,
      hidden,
    );
    assert.doesNotMatch(elsewhere[1], /no reader is served/);
  });

  test('where, the headline, the innermost elaboration, and a hint', () => {
    const output = [
      'app.ts(12,5): error TS2322: Type \'{ kind: "list"; table: "ticket"; show: string[]; filters: string[]; label: string; icon: string; }\' is not assignable to type \'TypedView<Tables>\'.',
      "  Types of property 'filters' are incompatible.",
      '    Type \'"statuz"\' is not assignable to type \'"id" | "status"\'. Did you mean \'"status"\'?',
      "app.ts(1,22): error TS2307: Cannot find module '@mistriwork/mistri/app' or its corresponding type declarations.",
      "views.ts(3,7): error TS2353: Object literal may only specify known properties, and 'lable' does not exist in type 'AppListView'.",
    ].join('\n');
    const lines = readableTypeErrors(output);
    assert.match(
      lines[0],
      /^app\.ts:12:5 {2}TS2322 {2}Type '\{ kind: "list"; table: "ticket"; [^']{0,60}…' is not assignable to type 'TypedView<Tables>'\.$/,
    );
    assert.equal(lines[1], '    Type \'"statuz"\' is not assignable to type \'"id" | "status"\'. Did you mean \'"status"\'?');
    assert.match(lines[2], /^ {4}hint: "statuz" is not a name this place accepts/);
    assert.match(lines[3], /^app\.ts:1:22 {2}TS2307/);
    assert.match(lines[4], /hint: mistri is not installed where this App can import it: run npm install/);
    assert.match(lines[6], /hint: "lable" is not a key this place takes/);
  });

  test('a label path the schema does not have names the table it was judged against', () => {
    const lines = readableTypeErrors(
      [
        'views.ts(4,67): error TS2820: Type \'"statuz"\' is not assignable to type \'LabelPath<Tables, References, "lead">\'. Did you mean \'"status"\'?',
        "pages/account.ts(8,14): error TS2322: Type '{ base: \"account\"; sections: … }' is not assignable to type 'TypedPage<Tables, References>'.",
        "  Types of property 'whose' are incompatible.",
        '    Type \'"acount_id"\' is not assignable to type \'ReferencePathTo<Tables, References, "contact", Reach<References, "account", []>>\'. Did you mean \'"account_id"\'?',
      ].join('\n'),
    );
    assert.match(lines[1], /^ {4}hint: "statuz" is not a column of lead, nor a label path from it through its references/);
    assert.match(lines[4], /^ {4}hint: "acount_id" is not a path of references from contact to the page's record/);
  });

  /* A load error left the schema types as they were, and every rollup added
     since read as "not a column": one real error, a screen of false ones. */
  test('when the App did not load, the names its stale types lack are said once, and the rest as they are', () => {
    const output = [
      ...['app.ts(17,3)', 'pages/index.ts(7,42)', 'pages/patient.ts(39,24)'].map(
        (at) =>
          `${at}: error TS2322: Type '{ base: "patient"; … }' is not assignable to type 'TypedPage<Tables, References>'.\n` +
          '    Type \'"no_shows"\' is not assignable to type \'LabelPath<Tables, References, "patient">\'.',
      ),
      "views.ts(3,7): error TS2353: Object literal may only specify known properties, and 'lable' does not exist in type 'AppListView'.",
    ].join('\n');
    const lines = readableTypeErrors(output, 20, new Set(), true);
    assert.match(
      lines[0],
      /^The App did not load, so mistri-schema\.d\.ts could not be brought up to date: 3 errors naming "no_shows" may be only that/,
    );
    assert.ok(!lines.some((line) => /is not a column of patient/.test(line)), lines.join('\n'));
    assert.match(lines[1], /^views\.ts:3:7 {2}TS2353/);
    // Loaded, the same errors are each said with their hint.
    assert.equal(readableTypeErrors(output).filter((line) => /hint: "no_shows" is not a column of patient/.test(line)).length, 3);
  });

  test('a long report is capped, and says how many more', () => {
    const output = Array.from({ length: 25 }, (_, i) => `app.ts(${i + 1},1): error TS2322: Type 'x' is not assignable to type 'y'.`).join(
      '\n',
    );
    const lines = readableTypeErrors(output, 20);
    assert.equal(lines.length, 21);
    assert.equal(lines.at(-1), '…and 5 more; run tsc for all of them.');
  });
});

describe('mistri check --routes, where the App is served', () => {
  test("a role served other views says its records at its own address, one line each where it differs from the App's", () => {
    const app = parseAppConfig(
      {
        id: 'lintel',
        name: 'Lintel',
        auth: { roles: { resident: { read: true }, manager: { read: true }, accountant: { read: true } } },
        resources: { maintenance_request: {}, charge: {} },
        views: {
          'my-requests': { kind: 'list', from: 'maintenance_request', roles: ['resident'] },
          ledger: { kind: 'list', from: 'charge', roles: ['manager', 'accountant'] },
          repairs: { kind: 'list', from: 'maintenance_request', roles: ['manager'] },
        },
        nav: ['my-requests', 'ledger', 'repairs'],
        home: 'ledger',
      },
      'lintel App',
    );
    const table = (id: string) => ({
      id,
      name: id,
      kind: 'table',
      columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }],
    });
    const schema = { tables: [table('maintenance_request'), table('charge')] } as unknown as DatabaseSchema;
    const rows = checkedRoutes({ path: 'lintel.ts', sources: {}, pages: [], app } as never, schema, NO_MOUNT);
    const records = rows.filter((row) => row.what.startsWith('one record of "maintenance_request"'));
    assert.deepEqual(records, [
      { path: '/lintel/my-requests/{id}', what: 'one record of "maintenance_request"' },
      { path: '/lintel/repairs/{id}', what: 'one record of "maintenance_request", as the role "manager" opens it' },
      { path: '/lintel/maintenance_request/{id}', what: 'one record of "maintenance_request", as the role "accountant" opens it' },
    ]);
    // A charge is said alike by everyone served the ledger; a resident, who is not, by the table's own word.
    assert.deepEqual(
      rows.filter((row) => row.what.startsWith('one record of "charge"')).map((row) => row.path),
      ['/lintel/ledger/{id}', '/lintel/charge/{id}'],
    );
  });

  test("one App's routes at the root, under its id, and under a base path; beside another at the root, a route that App holds is refused by name", async () => {
    const root = await run(['check', '--app', 'examples/apps/tick', '--config', config, '--routes']);
    assert.equal(root.code, 0, root.out + root.err);
    assert.match(root.out, /\n {2}routes +passed +\d+ addresses\n {2}.* {2}\/ +home\n.* \/tasks +the list view "tasks"/);
    const byId = await run(['check', '--app', 'examples/apps/tick', '--config', config, '--routes', '--mount', 'tick=/tick']);
    assert.match(byId.out, / \/tick +home\n.* \/tick\/tasks +the list view "tasks"/);
    const proxied = await run(['check', '--app', 'examples/apps/tick', '--config', config, '--routes', '--base-path', '/tools']);
    assert.match(proxied.out, / \/tools\/ +home\n.* \/tools\/tasks +the list view "tasks"/);
    // Tick at the root beside an App mounted at /tasks: its list could never be reached.
    const clash = await run([
      'check',
      '--app',
      'examples/apps/tick',
      '--config',
      config,
      '--routes',
      '--mount',
      'tick=/',
      '--mount',
      'board=/tasks',
    ]);
    assert.equal(clash.code, 4, clash.out + clash.err);
    assert.match(
      clash.out,
      /routes +failed +1 address another App holds\n.*the list view "tasks": its address "\/tasks" is where the App "board" is mounted, beside this one at the root\./,
    );
  });
});

test("a step's lines split into errors and warnings, each in the order said, and the warnings sum up by kind", () => {
  const lines = [
    'warning: command "a" [restated]: x',
    'app.ts:3  the view is wrong',
    'app.ts:9  warning: command "b" [restated]: y',
    'warning: index missing on t(c)',
  ];
  const { errors, warnings } = splitWarnings(lines);
  assert.deepEqual(errors, ['app.ts:3  the view is wrong']);
  assert.equal(warnings.length, 3);
  assert.equal(warningKind(warnings[0]), 'restated');
  const kinds = new Map<string, number>();
  for (const line of warnings) kinds.set(warningKind(line), (kinds.get(warningKind(line)) ?? 0) + 1);
  assert.match(warningSummary(kinds), /^3 warnings \(restated 2, [a-z-]+ 1\); --warnings lists them\.$/);
});
