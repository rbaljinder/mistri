/**
 * The authoring loop over a real-sized database: several schemas that share
 * table names, the bookkeeping a migration tool keeps in each, a table with
 * no key, a config naming several connections; and a load that names every
 * refusal in one run instead of one per reload, with the schema types kept
 * current while it does.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { scaffoldApp } from '../packages/mistri/src/server/scaffold.js';
import { appAdvisories, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { AppProblems, parseAppConfig, parseAppPages } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';

const ROOT = resolve('.');
const col = (name: string, type = 'text', extra: Record<string, unknown> = {}) => ({
  name,
  type,
  nullable: true,
  primaryKey: false,
  ...extra,
});
const key = (name = 'id') => ({ ...col(name, 'integer'), primaryKey: true, nullable: false });
const table = (schema: string, name: string, columns: TableMeta['columns'], approxRows = 10): TableMeta => ({
  schema,
  name,
  id: `${schema}.${name}`,
  columns,
  isView: false,
  approxRows,
});
const changelog = (schema: string) =>
  table(schema, 'databasechangelog', [col('id'), col('author'), col('filename'), col('dateexecuted', 'timestamp')]);

/* Two schemas an ops team keeps in one Postgres database: each migrated by
   Liquibase (a changelog each), each with a `partner` of its own, and an audit
   table with no key. */
const MULTI: DatabaseSchema = {
  label: 'ops',
  dialect: 'postgres',
  readAt: '',
  tables: [
    table(
      'sales',
      'deal',
      [
        key(),
        col('title'),
        col('partner_id', 'integer', { references: { table: 'sales.partner', column: 'id' } }),
        col('status', 'text', { allowed: ['open', 'won', 'lost'] }),
        col('amount', 'numeric'),
        col('created_at', 'timestamp'),
      ],
      500,
    ),
    table('sales', 'partner', [key(), col('name'), col('region')], 40),
    table('settings', 'partner', [key(), col('code'), col('name')], 12),
    table('settings', 'audit_entry', [col('happened_at', 'timestamp'), col('actor'), col('message')], 900),
    changelog('sales'),
    changelog('settings'),
    table('settings', 'databasechangeloglock', [key(), col('locked', 'boolean')]),
    table('settings', 'flyway_schema_history', [key('installed_rank'), col('version'), col('script')]),
  ],
  foreignKeys: [
    { name: 'fk_deal_partner', from: { table: 'sales.deal', columns: ['partner_id'] }, to: { table: 'sales.partner', columns: ['id'] } },
  ],
};

describe('a catalog over schemas that share table names', () => {
  test('a shared name is qualified by its schema for every copy; a unique name stays bare', () => {
    const { schema, toPhysical } = appResourceCatalog(MULTI);
    const names = schema.tables.map((t) => t.name).sort();
    assert.ok(names.includes('deal') && names.includes('audit_entry'), names.join(', '));
    assert.ok(names.includes('sales_partner') && names.includes('settings_partner'), names.join(', '));
    assert.ok(names.includes('sales_databasechangelog') && names.includes('settings_databasechangelog'));
    assert.ok(!names.includes('partner'), 'neither copy wins the bare name');
    assert.equal(toPhysical('settings_partner'), 'settings.partner');
  });

  test("binding one copy leaves its twin's inferred name as it was", () => {
    const { schema, toPhysical } = appResourceCatalog(MULTI, { partner: 'sales.partner' });
    assert.equal(toPhysical('partner'), 'sales.partner');
    assert.equal(toPhysical('settings_partner'), 'settings.partner');
    assert.ok(!schema.tables.some((t) => t.name === 'sales_partner'));
  });
});

type Draft = {
  nav: string[];
  sources?: Record<string, { connection: string; default?: true }>;
  resources: Record<string, { physical?: string }>;
  views: Record<string, { from?: string; sections?: Array<{ kind: string }>; empty?: unknown }>;
  pages?: Record<string, { base: string }>;
};

describe('scaffolding a database of several schemas', () => {
  const { app, problems } = scaffoldApp(MULTI);
  const draft = app as unknown as Draft;
  const tables = Object.values(draft.views)
    .map((view) => view.from)
    .filter(Boolean);

  test('drafts clean: the qualified twins are listed and pinned to their tables', () => {
    assert.deepEqual(problems, [], problems.join('; '));
    assert.ok(tables.includes('sales_partner') && tables.includes('settings_partner'), tables.join(', '));
    assert.equal(draft.resources.sales_partner.physical, 'sales.partner');
    assert.equal(draft.resources.settings_partner.physical, 'settings.partner');
    assert.equal(draft.resources.deal.physical, undefined, 'a unique name needs no pin');
    assert.doesNotThrow(() => parseAppConfig(app, 'the draft'));
  });

  test("a migration tool's bookkeeping is left out", () => {
    for (const name of Object.keys(draft.resources)) assert.doesNotMatch(name, /databasechangelog|flyway/);
    assert.ok(!tables.some((name) => /databasechangelog|flyway/.test(String(name))));
  });

  test('a table with no key is listed but never paged', () => {
    assert.ok(tables.includes('audit_entry'));
    assert.ok(!Object.values(draft.pages ?? {}).some((page) => page.base === 'audit_entry'));
  });

  test('over a read-only connection the Overview asks for no first records', () => {
    const overview = draft.views.overview;
    assert.ok(overview?.sections?.length);
    assert.ok(!overview.sections.some((section) => section.kind === 'firstRun'));
    const writing = scaffoldApp(MULTI, { writable: true }).app as unknown as Draft;
    assert.ok(writing.views.overview.sections!.some((section) => section.kind === 'firstRun'));
  });
});

describe('scaffolding several connections as one App', () => {
  const sales: DatabaseSchema = { ...MULTI, tables: MULTI.tables.filter((t) => t.schema === 'sales'), foreignKeys: MULTI.foreignKeys };
  const settings: DatabaseSchema = { ...MULTI, tables: MULTI.tables.filter((t) => t.schema === 'settings'), foreignKeys: [] };
  const { app, problems } = scaffoldApp(sales, {
    sources: [
      { name: 'sales', connection: 'sales-db', schema: sales },
      { name: 'settings', connection: 'settings-db', schema: settings },
    ],
  });
  const draft = app as unknown as Draft;

  test("a source per connection, the first the default; the others' tables named source.table", () => {
    assert.deepEqual(problems, [], problems.join('; '));
    assert.deepEqual(draft.sources, { sales: { connection: 'sales-db', default: true }, settings: { connection: 'settings-db' } });
    assert.ok(draft.resources.partner, "the default source's tables stay bare");
    assert.ok(draft.resources['settings.partner'], Object.keys(draft.resources).join(', '));
    assert.equal((app as { connection?: string }).connection, undefined);
    const parsed = parseAppConfig(app, 'the draft');
    assert.equal(parsed.resources?.['settings.partner']?.source, 'settings');
  });
});

describe('a load names every refusal in one run', () => {
  const LIST = { kind: 'list', from: 'task' };
  const tabbed = {
    base: 'customer',
    sections: [
      { kind: 'fields', show: ['name'], tab: 'Main' },
      { kind: 'list', from: 'task', whose: 'customer_id', empty: false, tab: 'Tasks' },
    ],
  };
  const refused = (raw: Record<string, unknown>): string[] => {
    try {
      parseAppConfig({ name: 'Desk', home: 'tasks', nav: ['tasks'], resources: { task: {}, customer: {} }, ...raw }, 'app.json');
    } catch (err) {
      assert.ok(err instanceof AppProblems, String(err));
      return err.problems;
    }
    assert.fail('the App parsed');
  };

  test('two views and a page, each refused on its own line', () => {
    const problems = refused({
      views: {
        tasks: LIST,
        board: {
          kind: 'dashboard',
          label: 'Board',
          sections: [
            { kind: 'metrik', from: 'task' },
            { kind: 'rows', from: 'task', better: 'up' },
          ],
        },
        people: { kind: 'list' },
      },
      nav: ['tasks', 'board', 'people'],
      pages: { customer: tabbed },
    });
    assert.equal(problems.length, 4, problems.join('\n'));
    assert.ok(problems.some((p) => /views "board", section 1 has an unknown kind "metrik"/.test(p)));
    assert.ok(problems.some((p) => /views "board", section 2 has "better", which only a metric carries/.test(p)));
    assert.ok(problems.some((p) => /views "people" has no "from"/.test(p)));
    assert.ok(problems.some((p) => /pages "customer".*has "empty: false", which is now "empty: 'hide'"/.test(p)));
  });

  test('a resource and a page together; views over the refused resources wait', () => {
    const problems = refused({
      resources: { task: { access: 'rw' }, customer: { noun: 7 } },
      views: { tasks: LIST },
      pages: { customer: tabbed },
    });
    assert.equal(problems.length, 3, problems.join('\n'));
    assert.ok(problems.some((p) => /resources "task" has an "access" of "rw"/.test(p)));
    assert.ok(problems.some((p) => /resources "customer"/.test(p)));
    assert.ok(problems.some((p) => /pages "customer"/.test(p)));
  });

  test("the checks across views are gathered too: the menu's typo, the home's and a list's empty action in one run (UX-16)", () => {
    const problems = refused({
      views: { tasks: { ...LIST, empty: { title: 'None', action: { to: 'nowhere', label: 'Add' } } } },
      nav: ['tasks', 'ghost'],
      home: 'elsewhere',
    });
    assert.equal(problems.length, 3, problems.join('\n'));
    assert.ok(problems.some((p) => /"empty.action.view" names "nowhere"/.test(p)));
    assert.ok(problems.some((p) => /nav entry 2 names the view "ghost"/.test(p)));
    assert.ok(problems.some((p) => /elsewhere/.test(p)));
  });

  test('one problem reads exactly as it always did', () => {
    assert.throws(
      () => parseAppConfig({ name: 'Desk', views: { tasks: { kind: 'list' } }, home: 'tasks' }, 'app.json'),
      (err: Error) => err.message === 'app.json: views "tasks" has no "from": a list view shows the rows of one resource.',
    );
  });

  test('the pages parse names every page too', () => {
    assert.throws(
      () => parseAppPages({ pages: { a: { base: 'task', bogus: 1 }, b: { base: 'task', sections: 'x' } } }, 'app.json'),
      (err: Error) => err instanceof AppProblems && err.problems.length === 2,
    );
  });

  test('"better" without "compare" loads, and the check warns', () => {
    const app = parseAppConfig(
      {
        name: 'Desk',
        resources: { task: {} },
        views: {
          tasks: LIST,
          board: { kind: 'dashboard', label: 'Board', sections: [{ kind: 'metric', title: 'Open', from: 'task', better: 'down' }] },
        },
        home: 'board',
        nav: ['board', 'tasks'],
      },
      'app.json',
    );
    const loaded = { path: 'desk/app.json', app, pages: [], sources: {} } as LoadedApp;
    const schema: DatabaseSchema = {
      label: 'desk',
      dialect: 'sqlite',
      readAt: '',
      foreignKeys: [],
      tables: [{ schema: '', name: 'task', id: 'task', isView: false, columns: [key(), col('name')] }],
    };
    assert.ok(appAdvisories(loaded, schema).some((w) => /metric "Open" has "better" and no "compare"/.test(w)));
  });
});

/* The command line, outside the checkout, as a project that ran npm install would be. */
const work = mkdtempSync(join(tmpdir(), 'tablewalk-loop-'));
after(() => rmSync(work, { recursive: true, force: true }));
function run(args: string[], cwd = ROOT): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done, reject) => {
    execFile(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), join(ROOT, 'packages/mistri/src/server/index.ts'), ...args],
      { cwd, timeout: 120_000, killSignal: 'SIGKILL' },
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
function database(file: string, sql: string): string {
  const db = new DatabaseSync(join(work, file));
  db.exec(sql);
  db.close();
  return join(work, file);
}

describe('the command line', () => {
  const crm = database(
    'crm.db',
    `
    CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL, region TEXT);
    CREATE TABLE deal (id INTEGER PRIMARY KEY, title TEXT, account_id INTEGER NOT NULL REFERENCES account(id),
      status TEXT CHECK (status IN ('open','won','lost')), amount NUMERIC, created_at TEXT);
    INSERT INTO account (name) VALUES ('North');
    INSERT INTO deal (title, account_id, status, amount, created_at) VALUES ('First', 1, 'open', 100, '2026-01-01');`,
  );
  const lookup = database(
    'lookup.db',
    `
    CREATE TABLE region (id INTEGER PRIMARY KEY, code TEXT, name TEXT);
    CREATE TABLE account (id INTEGER PRIMARY KEY, code TEXT);
    INSERT INTO region (code, name) VALUES ('N', 'North');`,
  );
  const config = join(work, 'mistri.json');
  writeFileSync(
    config,
    JSON.stringify(
      {
        connections: [
          { name: 'crm', url: crm },
          { name: 'lookup', url: lookup },
        ],
      },
      null,
      2,
    ),
  );

  test('--scaffold-app over a config of two connections drafts a sources App that passes mistri check', async () => {
    const project = join(work, 'desk');
    const made = await run(['--config', config, '--scaffold-app', project]);
    assert.equal(made.code, 0, made.out + made.err);
    assert.match(made.out, /over 2 sources \(crm, lookup\)/);
    const text = readFileSync(join(project, 'app.ts'), 'utf8');
    assert.match(text, /sources: \{/);
    assert.match(readFileSync(join(project, 'resources.ts'), 'utf8'), /'lookup\.region'/);
    mkdirSync(join(project, 'node_modules'));
    mkdirSync(join(project, 'node_modules', '@mistriwork'), { recursive: true });
    symlinkSync(join(ROOT, 'packages', 'mistri'), join(project, 'node_modules', '@mistriwork', 'mistri'), 'dir');
    symlinkSync(join(ROOT, 'node_modules', 'typescript'), join(project, 'node_modules', 'typescript'), 'dir');
    // What `npm install` brings for the tsconfig's `types: ['node']`.
    mkdirSync(join(project, 'node_modules', '@types'), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules', '@types', 'node'), join(project, 'node_modules', '@types', 'node'), 'dir');
    const check = await run(['check', '--app', project, '--config', config]);
    assert.equal(check.code, 0, check.out + check.err);
    assert.match(check.out, /validation\s+passed/);
  });

  test('a refused view still has its schema types regenerated, and every refusal is said', async () => {
    const dir = join(work, 'stale');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'node_modules'));
    mkdirSync(join(dir, 'node_modules', '@mistriwork'), { recursive: true });
    symlinkSync(join(ROOT, 'packages', 'mistri'), join(dir, 'node_modules', '@mistriwork', 'mistri'), 'dir');
    symlinkSync(join(ROOT, 'node_modules', 'typescript'), join(dir, 'node_modules', 'typescript'), 'dir');
    // What `npm install` brings for the tsconfig's `types: ['node']`.
    mkdirSync(join(dir, 'node_modules', '@types'), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules', '@types', 'node'), join(dir, 'node_modules', '@types', 'node'), 'dir');
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
    /* Types from before a column was added: the App now shows it. */
    writeFileSync(
      join(dir, 'mistri-schema.d.ts'),
      [
        '// Generated by `mistri check --app <app>` from the "Stale" app resources.',
        "import type { TypedAppConfig } from '@mistriwork/mistri/app';",
        'export type Tables = {',
        '  account: "id" | "name";',
        '};',
        "export type App = TypedAppConfig<Tables, never, 'crm'>;",
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'app.ts'),
      [
        "import { dashboard, listView } from '@mistriwork/mistri/app';",
        "import type { App } from './mistri-schema.d.ts';",
        "export default { id: 'stale', name: 'Stale', connection: 'crm', resources: { account: {} },",
        "  views: { accounts: listView('Accounts', 'account', { show: ['name', 'region'] }),",
        "    board: dashboard('Board', [{ kind: 'metrik', from: 'account' }]),",
        "    spare: { kind: 'list' } },",
        "  home: 'accounts', nav: ['accounts', 'board'] } as App;",
        '',
      ].join('\n'),
    );
    const ran = await run(['check', '--app', dir, '--config', config]);
    // The typecheck fails on the one real type error, never on the column the stale file lacked.
    assert.equal(ran.code, 3, ran.out + ran.err);
    assert.match(
      ran.out,
      /schema types\s+passed\s+updated mistri-schema\.d\.ts to match the database and the App's resources — account \(columns changed\)/,
    );
    assert.match(ran.out, /"metrik"/);
    assert.doesNotMatch(ran.out, /"region"' is not/);
    assert.match(ran.out, /App error: 2 problems/);
    assert.match(readFileSync(join(dir, 'mistri-schema.d.ts'), 'utf8'), /"region"/);
    assert.match(ran.out, /unknown kind "metrik"/);
    assert.match(ran.out, /views "spare" has no "from"/);
  });

  /* One key in the wrong place (a resource's `validation` inside its `form`) stops the App loading. Its schema types
     are still regenerated from the connection and the tables its resources name, so the typecheck that follows judges
     fresh types: the stale ones said "not a column" for every rollup and new column, about 40 lines before the one
     real problem. */
  test('an App whose resources are refused still has its schema types regenerated before it stops', async () => {
    const dir = join(work, 'misplaced');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'node_modules'));
    mkdirSync(join(dir, 'node_modules', '@mistriwork'), { recursive: true });
    symlinkSync(join(ROOT, 'packages', 'mistri'), join(dir, 'node_modules', '@mistriwork', 'mistri'), 'dir');
    symlinkSync(join(ROOT, 'node_modules', 'typescript'), join(dir, 'node_modules', 'typescript'), 'dir');
    // What `npm install` brings for the tsconfig's `types: ['node']`.
    mkdirSync(join(dir, 'node_modules', '@types'), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules', '@types', 'node'), join(dir, 'node_modules', '@types', 'node'), 'dir');
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
    writeFileSync(
      join(dir, 'mistri-schema.d.ts'),
      [
        '// Generated by `mistri check --app <app>` from the "Misplaced" app resources.',
        "import type { TypedAppConfig } from '@mistriwork/mistri/app';",
        'export type Tables = {',
        '  account: "id" | "name";',
        '};',
        "export type App = TypedAppConfig<Tables, never, 'crm'>;",
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'app.ts'),
      [
        "import { listView } from '@mistriwork/mistri/app';",
        "import type { App } from './mistri-schema.d.ts';",
        "export default { id: 'misplaced', name: 'Misplaced', connection: 'crm',",
        "  resources: { account: { form: { show: ['name'], validation: [] } } },",
        "  views: { accounts: listView('Accounts', 'account', { show: ['name', 'region'] }),",
        "    regions: listView('Regions', 'account', { show: ['region'] }) },",
        "  home: 'accounts', nav: ['accounts', 'regions'] } as App;",
        '',
      ].join('\n'),
    );
    const ran = await run(['check', '--app', dir, '--config', config]);
    assert.equal(ran.code, 4, ran.out + ran.err);
    assert.match(ran.out, /schema types\s+passed\s+updated mistri-schema\.d\.ts to match the database/);
    assert.match(readFileSync(join(dir, 'mistri-schema.d.ts'), 'utf8'), /"region"/);
    assert.match(ran.out, /validation\s+failed/);
    assert.match(ran.out, /"validation" belongs inside a resource block/);
    assert.doesNotMatch(ran.out, /"region"' is not/);
  });

  /* R6/TR9: a refused App is typed from what it declares, rollups and computed columns included, and a computed
     column whose own expression is refused is still typed by the kind it says, so the typecheck beside the one
     real problem is not a screen of "not a column" for every name the pages show. */
  test('a refused App keeps its rollups and computed columns in its schema types, so its one problem is said alone', async () => {
    for (const [name, resource, said] of [
      // A key in the wrong place stops the resources parsing at all.
      [
        'refused-resource',
        "{ form: { show: ['name'], validation: [] }, rollups: { open_deals: { fn: 'count', from: 'deal', query: 'status = open' } }, computed: { label: { type: 'boolean', value: 'open_deals > 0' } } }",
        /"validation" belongs inside a resource block/,
      ],
      // The resources parse; one computed column's expression is refused.
      [
        'refused-expression',
        "{ rollups: { open_deals: { fn: 'count', from: 'deal', query: 'status = open' } }, computed: { label: { type: 'boolean', value: 'open_deals >>> 0' } } }",
        /computed "label"/,
      ],
    ] as const) {
      const dir = join(work, name);
      mkdirSync(dir, { recursive: true });
      mkdirSync(join(dir, 'node_modules'));
      mkdirSync(join(dir, 'node_modules', '@mistriwork'), { recursive: true });
      symlinkSync(join(ROOT, 'packages', 'mistri'), join(dir, 'node_modules', '@mistriwork', 'mistri'), 'dir');
      symlinkSync(join(ROOT, 'node_modules', 'typescript'), join(dir, 'node_modules', 'typescript'), 'dir');
      // What `npm install` brings for the tsconfig's `types: ['node']`.
      mkdirSync(join(dir, 'node_modules', '@types'), { recursive: true });
      symlinkSync(join(ROOT, 'node_modules', '@types', 'node'), join(dir, 'node_modules', '@types', 'node'), 'dir');
      writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
      writeFileSync(
        join(dir, 'app.ts'),
        [
          "import { listView } from '@mistriwork/mistri/app';",
          "import type { App } from './mistri-schema.d.ts';",
          `export default { id: '${name}', name: 'Refused', connection: 'crm',`,
          `  resources: { account: ${resource}, deal: {} },`,
          "  views: { accounts: listView('Accounts', 'account', { show: ['name', 'open_deals', 'label'] }) },",
          "  home: 'accounts', nav: ['accounts'] } as App;",
          '',
        ].join('\n'),
      );
      const ran = await run(['check', '--app', dir, '--config', config]);
      assert.equal(ran.code, 4, ran.out + ran.err);
      const types = readFileSync(join(dir, 'mistri-schema.d.ts'), 'utf8');
      assert.match(/\n {2}account: ([^\n]*);/.exec(types)?.[1] ?? '', /"open_deals".*"label"|"label".*"open_deals"/, `${name}: ${types}`);
      assert.match(ran.out, said);
      assert.doesNotMatch(ran.out, /typecheck\s+failed/, ran.out);
    }
  });

  test("a connection-level types file keeps the App's rollups when the check regenerates it", async () => {
    const dir = join(work, 'whole');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'node_modules'));
    mkdirSync(join(dir, 'node_modules', '@mistriwork'), { recursive: true });
    symlinkSync(join(ROOT, 'packages', 'mistri'), join(dir, 'node_modules', '@mistriwork', 'mistri'), 'dir');
    symlinkSync(join(ROOT, 'node_modules', 'typescript'), join(dir, 'node_modules', 'typescript'), 'dir');
    // What `npm install` brings for the tsconfig's `types: ['node']`.
    mkdirSync(join(dir, 'node_modules', '@types'), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules', '@types', 'node'), join(dir, 'node_modules', '@types', 'node'), 'dir');
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
    /* The spelling Compass commits: the whole connection, not the App's resources. */
    writeFileSync(
      join(dir, 'mistri-schema.d.ts'),
      [
        '// Generated by `mistri --export types` from the "crm" connection.',
        "import type { TypedAppConfig } from '@mistriwork/mistri/app';",
        'export type Tables = {',
        '  account: "id" | "name";',
        '};',
        'export type App = TypedAppConfig<Tables, never>;',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'app.ts'),
      [
        "import { listView } from '@mistriwork/mistri/app';",
        "import type { App } from './mistri-schema.d.ts';",
        "export default { id: 'whole', name: 'Whole', connection: 'crm',",
        "  resources: { account: { rollups: { open_deals: { fn: 'count', from: 'deal', query: 'status = open' } } }, deal: {} },",
        "  views: { accounts: listView('Accounts', 'account', { show: ['name', 'open_deals'] }) },",
        "  home: 'accounts', nav: ['accounts'] } satisfies App;",
        '',
      ].join('\n'),
    );
    const ran = await run(['check', '--app', dir, '--config', config]);
    assert.equal(ran.code, 0, ran.out + ran.err);
    const text = readFileSync(join(dir, 'mistri-schema.d.ts'), 'utf8');
    assert.match(text, /^\/\/ Generated by `mistri --export types` from the "crm" connection\./, 'it stays the connection-level spelling');
    assert.match(/\n {2}account: ([^\n]*);/.exec(text)?.[1] ?? '', /"open_deals"/);
    assert.match(text, /\n {2}deal: /, 'every table of the connection');
  });

  test('--scaffold-app over a many-table clinic with a staff table to sign in by drafts an App that passes mistri check', async () => {
    /* A read-only table of an App with sign-in used to be drafted `access: 'read'`, which the validator refuses: one
       "invalid-app" per table, from the draft's own first check. */
    const sql = [
      'CREATE TABLE patients (id INTEGER PRIMARY KEY, name TEXT NOT NULL, dob TEXT);',
      'CREATE TABLE doctors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, role TEXT);',
      ...Array.from(
        { length: 10 },
        (_, n) =>
          `CREATE TABLE visit_${n} (id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(id), doctor_id INTEGER REFERENCES doctors(id), note TEXT, amount REAL, created_at TEXT);`,
      ),
      "INSERT INTO doctors (name, email, role) VALUES ('Dr A', 'a@example.com', 'admin');",
    ].join('\n');
    const clinic = database('clinic.db', sql);
    const project = join(work, 'clinic');
    const made = await run([clinic, '--scaffold-app', project]);
    assert.equal(made.code, 0, made.out + made.err);
    assert.doesNotMatch(made.err, /scaffold problem/);
    assert.doesNotMatch(readFileSync(join(project, 'resources.ts'), 'utf8'), /access: 'read'/);
    mkdirSync(join(project, 'node_modules', '@types'), { recursive: true });
    mkdirSync(join(project, 'node_modules', '@mistriwork'), { recursive: true });
    symlinkSync(join(ROOT, 'packages', 'mistri'), join(project, 'node_modules', '@mistriwork', 'mistri'), 'dir');
    symlinkSync(join(ROOT, 'node_modules', 'typescript'), join(project, 'node_modules', 'typescript'), 'dir');
    symlinkSync(join(ROOT, 'node_modules', '@types', 'node'), join(project, 'node_modules', '@types', 'node'), 'dir');
    const check = await run(['check', '--app', project, clinic]);
    assert.equal(check.code, 0, check.out + check.err);
    assert.match(check.out, /validation\s+passed/);
  });
});
