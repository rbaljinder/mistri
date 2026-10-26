/**
 * The token-saving forms of the authoring loop: `schema --brief`, `check
 * --brief` and `explain <code>`. Each is a reading of something that already
 * exists (the catalog, the check's findings, the check-codes page), so what
 * is held here is that the short form says the same thing and keeps the
 * exit codes.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { toBrief, briefType } from '../packages/mistri/src/shared/schemaBrief.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { explainCode, nearestCodes } from '../packages/mistri/src/server/build/explain.js';
import { briefLines } from '../packages/mistri/src/server/build/check.js';
import { APP_ICONS } from '../packages/engine/src/shared/appIcons.js';
import { codeRows, documentedFix } from '../packages/mistri/src/server/build/checkCodes.js';
import { entryFor } from './support/bins.js';

const ROOT = resolve('.');
const work = mkdtempSync(join(tmpdir(), 'tablewalk-brief-'));
after(() => rmSync(work, { recursive: true, force: true }));
const db = join(work, 'tick.db');
spawnSync(process.execPath, [join(ROOT, 'examples/databases/tick/seed.mjs'), db], { encoding: 'utf8' });
const env = { ...process.env, XDG_CONFIG_HOME: join(work, 'xdg') };

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', entryFor(args), ...args],
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

const col = (name: string, type: string, more: Record<string, unknown> = {}) => ({
  name,
  type,
  nullable: false,
  primaryKey: false,
  ...more,
});
const schema = {
  label: 'shop',
  dialect: 'postgres',
  readAt: '2026-10-03T00:00:00.000Z',
  foreignKeys: [],
  tables: [
    {
      id: 'public.customer',
      name: 'customer',
      schema: 'public',
      isView: false,
      columns: [col('id', 'integer', { primaryKey: true }), col('email', 'character varying')],
    },
    {
      id: 'public.order',
      name: 'order',
      schema: 'public',
      isView: false,
      columns: [
        col('id', 'bigint', { primaryKey: true }),
        col('customer_id', 'integer', { references: { table: 'public.customer', column: 'id' } }),
        col('status', 'text', { allowed: ['open', 'paid', 'void'] }),
        col('total', 'numeric(10,2)', { nullable: true }),
        col('placed_at', 'timestamp with time zone'),
      ],
    },
  ],
} as unknown as DatabaseSchema;

describe('schema --brief', () => {
  test('one line per table: short types, keys, nullable, vocabularies and relations', () => {
    assert.equal(
      toBrief(schema),
      [
        'shop (postgres): 2 tables. * pk, ? nullable, {…} allowed values, → foreign key',
        'customer(id* int, email text)',
        'order(id* int, customer_id int → customer, status text {open|paid|void}, total num?, placed_at ts)',
      ].join('\n'),
    );
  });

  test('type families, and a name two schemas share is said with its schema', () => {
    assert.deepEqual(
      ['integer', 'BIGINT', 'tinyint(1)', 'interval', 'varchar(20)', 'timestamp without time zone', 'jsonb'].map(briefType),
      ['int', 'int', 'bool', 'interval', 'text', 'ts', 'json'],
    );
    const twice = {
      ...schema,
      tables: [schema.tables[0], { ...schema.tables[0], id: 'audit.customer', schema: 'audit' }],
    } as DatabaseSchema;
    assert.match(toBrief(twice), /^audit\.customer\(/m);
  });

  test("the platform's own store tables are left out and counted, unless asked for", () => {
    const withStore = {
      ...schema,
      tables: [
        schema.tables[0],
        { ...schema.tables[0], id: '__mistri_command_journal', name: '__mistri_command_journal' },
        { ...schema.tables[0], id: 'mistri.auth_user', name: 'auth_user', schema: 'mistri' },
      ],
    } as DatabaseSchema;
    const brief = toBrief(withStore);
    assert.doesNotMatch(brief, /__mistri_|auth_user/);
    assert.match(brief.split('\n')[0]!, /: 1 tables \(2 platform store tables hidden\)\./);
    assert.match(toBrief(withStore, { all: true }), /__mistri_command_journal\(/);
  });

  test("schema --help prints the schema command's own flags, not the root help", async () => {
    for (const flag of ['--help', '-h']) {
      const ran = await run(['schema', flag]);
      assert.equal(ran.code, 0, ran.err);
      assert.match(ran.out, /^mistri schema --brief \[<db>/);
      assert.match(ran.out, /--schema <name>/);
      assert.doesNotMatch(ran.out, /tablewalk migrate|--mcp/);
    }
  });

  test('the command reads the connection like --export does, and is shorter than the markdown', async () => {
    const brief = await run(['schema', '--brief', db]);
    assert.equal(brief.code, 0, brief.err);
    assert.match(brief.out, /^task\(.*\)$/m);
    const markdown = await run([db, '--export', 'md']);
    assert.ok(brief.out.length < markdown.out.length, `${brief.out.length} vs ${markdown.out.length}`);
  });
});

describe('explain', () => {
  test('a code: where it comes from, what it means, the fix, the page', () => {
    const { found, text } = explainCode('unknown-column');
    assert.ok(found);
    assert.match(text, /^unknown-column\n/);
    assert.match(text, /validation/);
    assert.match(text, /fix: /);
    assert.match(text, /mistri docs check-codes/);
  });

  test('every code the page documents is explained, and the design rules too', () => {
    const rows = codeRows();
    assert.ok(rows.length > 60);
    for (const row of rows) assert.ok(explainCode(row.code).found, row.code);
    assert.match(explainCode('bare-title').text, /^bare-title\n\ndesign/);
    assert.match(explainCode('TS2322').text, /typecheck/);
  });

  test('an unknown code lists the nearest, and the command exits 1', async () => {
    assert.deepEqual(nearestCodes('unknown-colum', ['unknown-column', 'route-clash', 'unknown-view']).slice(0, 1), ['unknown-column']);
    const ran = await run(['explain', 'unknown-colum']);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /"unknown-colum" is not a check code\. Nearest: unknown-column/);
    const ok = await run(['explain', 'route-clash']);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /Give one of them a `path`/);
  });
});

describe('check --brief', () => {
  test('a line per problem, the fix borrowed from the documentation where the check names none', () => {
    const lines = briefLines({
      problems: [
        { code: 'unknown-column', severity: 'error', step: 'validation', file: 'app.ts', line: 8, message: 'x\n  y', docs: '' },
        {
          code: 'made-up-fix',
          severity: 'error',
          step: 'validation',
          file: join(process.cwd(), 'app.ts'),
          line: 9,
          message: 'z',
          fix: documentedFix('route-clash'),
          docs: '',
        },
        { code: 'typecheck', severity: 'error', step: 'typecheck', file: 'app.ts', line: 3, message: 'bad', fix: 'use "done"', docs: '' },
        { code: 'preview', severity: 'info', step: 'validation', message: 'preview', docs: '' },
        { code: 'made-up', severity: 'warning', step: 'validation', message: 'm', docs: '' },
      ],
    });
    assert.deepEqual(lines, [
      'unknown-column app.ts:8 x y — fix: use a column the table has (the message names the nearest; mistri schema --brief lists them)',
      `made-up-fix app.ts:9 z — fix: ${documentedFix('route-clash')}`,
      'typecheck app.ts:3 bad — fix: use "done"',
      'made-up (warning) m',
    ]);
    assert.deepEqual(briefLines({ problems: [] }), ['ok']);
  });

  test('the Preview features an App uses are one information line, after ok or the problems', () => {
    const preview = {
      code: 'preview-feature',
      severity: 'info' as const,
      step: 'validation' as const,
      file: 'app.ts',
      message: 'This App uses Preview features (flags, experiments). They work as documented and may change in any 1.x release.',
      docs: '',
    };
    const said = `preview-feature (info) app.ts ${preview.message}`;
    assert.deepEqual(briefLines({ problems: [preview] }), ['ok', said]);
    const error = { code: 'unknown-key', severity: 'error' as const, step: 'validation' as const, message: 'k', docs: '' };
    assert.deepEqual(briefLines({ problems: [preview, error] }), ['unknown-key k — fix: use one of the keys the message lists', said]);
  });

  test('repeated warnings are a line a code and resource with a count and one example; errors stay whole', () => {
    const warn = (path: string, message: string) => ({
      code: 'index-missing',
      severity: 'warning' as const,
      step: 'validation' as const,
      path,
      message,
      docs: '',
    });
    const problems = [
      { code: 'unknown-column', severity: 'error' as const, step: 'validation' as const, message: 'bad', docs: '' },
      ...Array.from({ length: 40 }, (_, n) => warn('resources.visit.roles', `visit read by role ${n}`)),
      warn('resources.lab.roles', 'lab alone'),
      warn('resources.lab.roles', 'lab twice'),
      { code: 'role-table', severity: 'info' as const, step: 'validation' as const, message: 'info', docs: '' },
    ];
    const lines = briefLines({ problems });
    assert.equal(lines.length, 4, lines.join('\n'));
    assert.match(lines[0]!, /^unknown-column bad/);
    assert.match(lines[1]!, /^index-missing \(warning ×40 on visit, first shown\) visit read by role 0/);
    assert.match(lines[2]!, /^index-missing \(warning ×2 on lab, first shown\) lab alone/);
    assert.match(lines[3]!, /^42 warnings in 2 groups, one example each; --warnings lists every one$/);
    assert.equal(briefLines({ problems }, { all: true }).length, 1 + 40 + 2);
  });

  test('the icon list is said once per run, not after each unknown icon', () => {
    const list = APP_ICONS.join(', ');
    const lines = briefLines({
      problems: [1, 2, 3].map((n) => ({
        code: 'invalid-app',
        severity: 'error' as const,
        step: 'validation' as const,
        message: `views "v${n}" has "icon": "nope${n}", which is not one of the App icons. The icons: ${list}.`,
        docs: '',
      })),
    });
    assert.equal(lines.length, 4, lines.join('\n'));
    for (const line of lines.slice(0, 3)) assert.doesNotMatch(line, /The icons:/);
    assert.match(lines[3]!, new RegExp(`^The icons: ${list}\\.`));
  });

  test('every documented code says a fix of its own, never a pointer at the message', () => {
    for (const row of codeRows()) assert.doesNotMatch(row.fix, /what the message names/i, row.code);
    for (const code of ['invalid-app', 'schema-types', 'could-not-check', 'page-file', 'theme-font', 'api-write-unsupported']) {
      const [line] = briefLines({ problems: [{ code, severity: 'error', step: 'validation', message: 'said it', docs: '' }] });
      assert.match(line, new RegExp(`^${code} said it — fix: \\S`), code);
    }
    assert.match(documentedFix('message-syntax')!, /every `\{` with its `\}`/);
  });

  test('a broken App: the same exit code as --json, one line each, and nothing else', async () => {
    const dir = join(work, 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
    writeFileSync(
      join(dir, 'app.ts'),
      "export default { id: 'tiny', name: 'Tiny', connection: 'tick', resources: { task: {} }, views: { tasks: { kind: 'list', from: 'task', filters: ['complted'] } }, home: 'tasks' };\n",
    );
    const config = `${db}.json`;
    const json = await run(['check', '--app', dir, '--config', config, '--json']);
    const brief = await run(['check', '--app', dir, '--config', config, '--brief']);
    assert.equal(brief.code, json.code, brief.err);
    assert.notEqual(brief.code, 0);
    const lines = brief.out.trim().split('\n');
    assert.equal(lines.length, JSON.parse(json.out).problems.filter((found: { severity: string }) => found.severity !== 'info').length);
    assert.match(lines[0], /^unknown-column \S*app\.ts:\d+ .*"complted".* — fix: /);
  });
});
