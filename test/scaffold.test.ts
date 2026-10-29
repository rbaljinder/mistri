/**
 * The app scaffolder: the drafting brain behind `--scaffold-app` (CLI), tested against a fixture schema that has one of
 * everything a draft should notice — a big dated transactional table named
 * in the plural, a money column, a status vocabulary, a lookup hub — plus
 * the standing rule that the draft validates against the schema it came
 * from, and the promise the CLI makes: a project that passes
 * `mistri check` the moment it is written.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SCAFFOLD_HELPERS, scaffoldApp, writeScaffold } from '../packages/mistri/src/server/scaffold.js';
import { typesForSchema } from '../packages/mistri/src/server/typegen.js';
// eslint-disable-next-line import/no-relative-packages — the shipped veneer, eaten here.
import * as dsl from '../packages/mistri/schema/app.mjs';
import { breakdown, chart, dashboard, defineApp, listView, metric, note, page, rows, stream } from '../packages/mistri/schema/app.mjs';
import {
  appLabelTemplates,
  parseAppConfig,
  parseAppPages,
  resolveDisplay,
  resolveViews,
  withRollups,
} from '../packages/mistri/src/shared/app.js';
import { designLint, sayDesignFinding } from '../packages/mistri/src/server/app/designLint.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { parsePagesConfig, validatePage } from '../packages/engine/src/shared/page.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { VALIDATE, validating } from './support/validation.js';

const ROOT = resolve('.');
/* The display rules a scaffolded App is drawn by: what it wrote over the conventions the runtime applies. */
const drawn = (app: unknown, schema: DatabaseSchema) => {
  const parsed = parseAppConfig(app, 'the draft');
  return resolveDisplay(parsed, withRollups(parsed, schema)).display as Record<string, Record<string, unknown>>;
};
const col = (name: string, type = 'text', extra: Record<string, unknown> = {}) => ({
  name,
  type,
  nullable: true,
  primaryKey: false,
  ...extra,
});

const SCHEMA: DatabaseSchema = {
  label: 'ops',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    {
      name: 'orders',
      schema: '',
      id: 'orders',
      approxRows: 900,
      columns: [
        { ...col('id', 'integer'), primaryKey: true },
        col('reference'),
        col('customer_id', 'integer', { references: { table: 'customers', column: 'id' } }),
        col('status', 'text', { allowed: ['open', 'on_hold', 'completed', 'cancelled'] }),
        col('total_amount', 'numeric'),
        col('notes'),
        col('version', 'integer'),
        col('created_on', 'date'),
      ],
      isView: false,
    },
    {
      name: 'customers',
      schema: '',
      id: 'customers',
      approxRows: 120,
      columns: [{ ...col('id', 'integer'), primaryKey: true }, col('name'), col('credit_limit', 'numeric'), col('signed_up', 'date')],
      isView: false,
    },
  ],
  foreignKeys: [
    { name: 'fk_orders_customer', from: { table: 'orders', columns: ['customer_id'] }, to: { table: 'customers', columns: ['id'] } },
  ],
};

type Draft = {
  id: string;
  name: string;
  home: string;
  nav: string[];
  resources: Record<string, { noun?: unknown; display?: Record<string, Record<string, unknown>> }>;
  views: Record<string, Record<string, unknown>>;
  pages: Record<string, { label: string; base: string; sections: Array<Record<string, unknown>> }>;
};

describe('scaffoldApp', () => {
  const { app, files, problems } = scaffoldApp(SCHEMA);
  const draft = app as unknown as Draft;

  test('generated npm scripts pass config paths as data and forward CLI arguments on every platform', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-scaffold-launcher-'));
    try {
      const installed = join(dir, 'node_modules', '@mistriwork', 'mistri');
      const entry = join(installed, 'bin', 'cli #fixture.mjs');
      mkdirSync(join(installed, 'bin'), { recursive: true });
      writeFileSync(
        join(installed, 'package.json'),
        JSON.stringify({
          name: '@mistriwork/mistri',
          type: 'module',
          exports: { './package.json': './package.json' },
          bin: { mistri: './bin/cli #fixture.mjs' },
        }),
      );
      writeFileSync(entry, 'console.log(JSON.stringify(process.argv));\n');
      for (const config of [
        '../mistri.json',
        '../Team\'s "config" $HOME %PATH% & files.json',
        'C:\\Team files\\config\'s "$HOME" %PATH% & settings.json',
      ]) {
        const generated = scaffoldApp(SCHEMA, { database: { config } }).files;
        const scripts = JSON.parse(generated['package.json']).scripts;
        assert.deepEqual(scripts, {
          check: 'node mistri-run.mjs check',
          start: 'node mistri-run.mjs start',
          format: 'oxfmt "**/*.ts"',
          'format:check': 'oxfmt --check "**/*.ts"',
        });
        assert.match(generated['README.md'], /^npm run check\s+#/m);
        assert.match(generated['README.md'], /^npm start\s+#/m);
        assert.ok(!generated['README.md'].includes(config));
        writeFileSync(join(dir, 'package.json'), generated['package.json']);
        writeFileSync(join(dir, 'mistri-run.mjs'), generated['mistri-run.mjs']);
        for (const action of ['check', 'start']) {
          const userArgs = ['--port', '4567', '--no-open'];
          const args = ['--silent', 'run', action, '--', ...userArgs];
          // npm_execpath lets npm itself run through Node, including on Windows.
          const npm = process.env.npm_execpath;
          const out = npm
            ? spawnSync(process.execPath, [npm, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 })
            : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
                cwd: dir,
                encoding: 'utf8',
                timeout: 30_000,
                shell: process.platform === 'win32',
              });
          assert.equal(out.status, 0, out.stdout + out.stderr);
          assert.deepEqual(JSON.parse(out.stdout), [
            process.execPath,
            realpathSync(entry),
            ...(action === 'check' ? ['check'] : []),
            '--config',
            config,
            '--app',
            '.',
            ...userArgs,
          ]);
        }
      }
      /* seed is not an npm script (a draft's database is not always one to fill), but the README runs it the same way. */
      const seeded = spawnSync(process.execPath, ['mistri-run.mjs', 'seed', '--rows', '5'], { cwd: dir, encoding: 'utf8' });
      assert.equal(seeded.status, 0, seeded.stderr);
      assert.deepEqual(JSON.parse(seeded.stdout).slice(2), [
        'seed',
        '--config',
        'C:\\Team files\\config\'s "$HOME" %PATH% & settings.json',
        '--app',
        '.',
        '--rows',
        '5',
      ]);
      for (const args of [[], ['invalid']]) {
        const out = spawnSync(process.execPath, ['mistri-run.mjs', ...args], { cwd: dir, encoding: 'utf8' });
        assert.equal(out.status, 1);
        assert.match(out.stderr, /Usage: node mistri-run\.mjs <check\|start\|seed>/);
        assert.equal(out.stdout, '', 'invalid actions never load the CLI');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the draft validates clean against the schema it came from', () => {
    assert.deepEqual(problems, [], problems.join('; '));
    assert.equal(draft.name, 'Ops');
    assert.equal(draft.id, 'ops', 'the id is written, never left to a default');
    assert.equal(draft.home, 'overview');
  });

  test('records are called in the singular, lists in the plural, each with an icon', () => {
    /* A table named in the plural says its noun, or every New reads "New orders". */
    assert.equal(draft.resources.orders.noun, 'order');
    assert.equal(draft.resources.customers.noun, 'customer');
    assert.equal(draft.views.orders.label, 'Orders');
    assert.equal(draft.views.orders.icon, 'shopping-cart');
    assert.equal(draft.views.customers.icon, 'users');
  });

  test("money, and tones guessed from what a CHECK vocabulary says, are the runtime's: the draft writes neither", () => {
    assert.equal(draft.resources.orders.display, undefined, 'nothing restated');
    const display = drawn(app, SCHEMA);
    assert.equal(display['orders.total_amount'].format, 'money');
    // Calling an order off is not a failure: red is kept for what went wrong.
    assert.deepEqual(display['orders.status'].tone, { open: 'info', on_hold: 'warn', completed: 'good', cancelled: 'neutral' });
  });

  test('a list hides keys, versions, long text and raw reference ids, and tabs by its status', () => {
    const orders = draft.views.orders as { show: string[]; tabs: Array<string | { label: string }>; sort: string };
    assert.ok(orders.show.includes('customer_id.name'), 'a reference reads by name');
    for (const hidden of ['id', 'customer_id', 'version', 'notes']) assert.ok(!orders.show.includes(hidden), `${hidden} is not in a list`);
    assert.equal(orders.show[0], 'reference', 'the label column leads');
    // The states in order, All last, as every sample App's lists run: each a segment its resource declares once.
    assert.deepEqual(orders.tabs, ['open', 'on_hold', 'completed', 'cancelled', { label: 'All' }]);
    assert.deepEqual((draft.resources.orders as { segments?: unknown }).segments, {
      open: 'status = open',
      on_hold: 'status = on_hold',
      completed: 'status = completed',
      cancelled: 'status = cancelled',
    });
    assert.equal(orders.sort, 'created_on desc');
  });

  test('main tables get a record page in the anatomy: a header, a summary of rollups, lists as tabs and a rail beside them', () => {
    const customer = draft.pages.customers as { base: string; listTabs?: boolean; sections: Array<Record<string, unknown>> };
    assert.equal(customer.base, 'customers');
    assert.equal(customer.listTabs, true);
    assert.deepEqual(
      customer.sections.map((section) => [section.kind, section.presentation ?? section.region ?? null]),
      [
        ['header', null],
        ['fields', null],
        ['list', null],
        ['current', null],
        ['fields', 'aside'],
      ],
    );
    // Beside the tabs, the order still in play, and the rail titled by what it holds.
    assert.deepEqual(customer.sections[3], {
      kind: 'current',
      title: 'Current order',
      from: 'orders',
      whose: 'customer_id',
      query: 'status in (open, on_hold)',
      sort: 'created_on desc',
      show: ['total_amount'],
    });
    assert.equal(customer.sections[4].title, 'Customer');
    // The summary is what the draft counts about a customer: their orders, and what those come to.
    assert.deepEqual((draft.resources.customers as { rollups?: unknown }).rollups, {
      orders: { fn: 'count', from: 'orders' },
      total_amount: { fn: 'sum', from: 'orders', column: 'total_amount' },
    });
    assert.deepEqual(customer.sections[1].show, ['orders', 'total_amount']);
    const related = customer.sections.find((section) => section.kind === 'list') as
      | { from: string; whose: string; title: string; show: string[] }
      | undefined;
    assert.deepEqual(related && { from: related.from, whose: related.whose, title: related.title }, {
      from: 'orders',
      whose: 'customer_id',
      title: 'Orders',
    });
    assert.ok(
      related!.show.length <= 4 && related!.show.at(-1) === 'status',
      'at most four columns, the status last where it cannot be cut',
    );
    // An order's head: its status as the chip, what it belongs to, its figure and its date as the facts.
    assert.deepEqual(draft.pages.orders.sections[0], {
      kind: 'header',
      status: 'status',
      facts: ['customer_id', 'total_amount', 'created_on'],
    });
    const shown = draft.pages.orders.sections.flatMap((section) => [
      ...((section.show as string[] | undefined) ?? []),
      ...((section.facts as string[] | undefined) ?? []),
    ]);
    assert.ok(!shown.includes('id') && !shown.includes('version'), 'the record page leaves out the key and the version');
    assert.ok(shown.includes('notes'), 'long text is kept, after the rest');
    assert.deepEqual(problems, []);
  });

  test('the Overview counts each main table and breaks the busiest down by its status', () => {
    const overview = draft.views.overview as { sections: Array<{ kind: string; from?: string; by?: string }> };
    const metrics = overview.sections.filter((section) => section.kind === 'metric').map((section) => section.from);
    assert.deepEqual(metrics.sort(), ['customers', 'orders']);
    assert.ok(overview.sections.some((section) => section.kind === 'breakdown' && section.from === 'orders' && section.by === 'status'));
    assert.deepEqual(draft.nav.slice(0, 2), ['overview', 'orders'], 'the Overview, then the busiest table');
  });

  test('the draft starts in Workshop, its Overview a flow of steps and a trend by month, its lookups folded', () => {
    assert.deepEqual((app as unknown as { ui: { theme: unknown } }).ui.theme, { preset: 'workshop' });
    const sections = (draft.views.overview as { sections: Array<Record<string, unknown>> }).sections;
    assert.ok(sections.some((s) => s.kind === 'breakdown' && s.by === 'status' && s.shape === 'steps'));
    assert.ok(sections.some((s) => s.kind === 'chart' && s.by === 'month created_on' && s.curve === 'smooth'));
    const reserved = scaffoldApp({
      ...SCHEMA,
      tables: [
        { ...SCHEMA.tables[0], name: 'assets', id: 'assets' },
        { ...SCHEMA.tables[0], name: 'work_order', id: 'work_order' },
      ],
      foreignKeys: [],
    }).app as unknown as Draft;
    assert.ok(reserved.views['assets-list'] && !reserved.views.assets, 'a reserved address is not a view key');
    assert.equal(Object.values(reserved.views).find((v) => v.from === 'work_order' && v.icon)?.icon, 'wrench');
  });

  test('over an empty database the Overview opens on a first run, parents first, and each main list says what belongs there', () => {
    /* Only over a connection that takes writes: a read-only one is never asked to add a first record. */
    assert.ok(!(draft.views.overview as { sections: Array<{ kind: string }> }).sections.some((section) => section.kind === 'firstRun'));
    assert.deepEqual((draft.views.orders as { empty?: unknown }).empty, { title: 'No orders yet' });
    const { app: writing, files } = scaffoldApp(SCHEMA, { writable: true });
    const draft2 = writing as unknown as Draft;
    const overview = draft2.views.overview as { sections: Array<{ kind: string; steps?: Array<{ label: string; to: string }> }> };
    // A customer before an order: an order names its customer.
    assert.deepEqual(overview.sections[0], {
      kind: 'firstRun',
      title: 'Get started',
      steps: [
        { label: 'Add your first customer', to: 'customers' },
        { label: 'Add your first order', to: 'orders' },
      ],
    });
    assert.deepEqual((draft2.views.orders as { empty?: unknown }).empty, {
      title: 'No orders yet',
      description: 'Add the first order with New.',
    });
    assert.match(files['dashboard.ts'], /firstRun\('Get started', \[/);
  });

  test('the files are helper-built TypeScript in the house style, not JSON', () => {
    assert.match(files['app.ts'], /import \{ defineApp \} from '@mistriwork\/mistri\/app';/);
    assert.match(files['app.ts'], /export default defineApp\(\{[\s\S]*\} satisfies App\);/);
    assert.match(files['views.ts'], /orders: listView\('Orders', 'orders', \{/);
    assert.match(files['dashboard.ts'], /export const overview = dashboard\('Overview', \[/);
    assert.doesNotMatch(files['resources.ts'], /tone: \{|format: 'money'/, 'the conventions are not written out');
    assert.match(files['pages/customers.ts'], /related\('Orders', 'orders', 'customer_id'/);
    assert.match(files['pages/index.ts'], /customers: customersPage\b/);
    for (const [file, text] of Object.entries(files)) {
      if (file.endsWith('.ts') && !file.endsWith('.d.ts'))
        assert.doesNotMatch(text, /"kind":|"table":/, `${file} reads as authored TypeScript`);
    }
    const pkg = JSON.parse(files['package.json']) as {
      type: string;
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    assert.equal(pkg.type, 'module');
    assert.deepEqual(Object.keys(pkg.dependencies), ['@mistriwork/mistri']);
    assert.deepEqual(pkg.scripts, {
      check: 'mistri check --app .',
      start: 'mistri --app .',
      format: 'oxfmt "**/*.ts"',
      'format:check': 'oxfmt --check "**/*.ts"',
    });
    // The project formats the way the shipped examples do, with the same oxfmt as this checkout.
    assert.ok(JSON.parse(files['package.json']).devDependencies.oxfmt);
    assert.deepEqual(JSON.parse(files['.oxfmtrc.json']), {
      printWidth: 140,
      singleQuote: true,
      semi: true,
      trailingComma: 'all',
      tabWidth: 2,
      ignorePatterns: ['**/mistri-schema.d.ts', '**/mistri-commands.d.ts', '**/mistri-components.d.ts'],
    });
    assert.ok(!Object.hasOwn(files, 'mistri-run.mjs'));
    assert.ok(JSON.parse(files['tsconfig.json']).compilerOptions.allowImportingTsExtensions);
    /* TypeScript 7 loads no @types package unless one is named: a test's or a command's node: import reads as missing. */
    assert.deepEqual(JSON.parse(files['tsconfig.json']).compilerOptions.types, ['node']);
    assert.ok(JSON.parse(files['package.json']).devDependencies['@types/node']);
  });

  test('the helpers the draft is evaluated with are the shipped ones, argument for argument', () => {
    const samples: Record<keyof typeof SCAFFOLD_HELPERS, unknown[][]> = {
      listView: [
        ['Orders', 'orders'],
        ['Orders', 'orders', { icon: 'receipt', show: ['reference'] }],
      ],
      dashboard: [
        ['Overview', []],
        ['Overview', [{ kind: 'note', text: 'x' }], { icon: 'gauge' }],
      ],
      metric: [
        ['Orders', 'orders'],
        ['Orders', 'orders', { width: 'half' }],
      ],
      breakdown: [
        ['By status', 'orders', 'status'],
        ['By status', 'orders', 'status', { width: 'half' }],
      ],
      chart: [
        ['By month', 'orders', 'month created_on'],
        ['By kind', 'orders', 'kind', { shape: 'donut', total: 'Orders', width: 'half' }],
      ],
      rows: [
        ['Newest', 'orders'],
        ['Newest', 'orders', { show: ['reference'], limit: 6 }],
      ],
      firstRun: [
        ['Get started', [{ label: 'Add your first order', view: 'orders' }]],
        ['Welcome', [], { text: 'Start here.' }],
      ],
      page: [
        ['orders', [{ kind: 'fields' }]],
        ['orders', [{ kind: 'fields' }], { listTabs: true }],
      ],
      card: [
        ['Customer', 'customer_id'],
        ['Customer', 'customer_id', ['rating', 'city'], { region: 'main' }],
      ],
      fields: [[['reference']], [['reference'], { title: 'Order', columns: 2 }]],
      header: [[{ status: 'status', facts: ['customer_id', 'total'] }]],
      history: [['History'], ['History', { region: 'aside', limit: 10 }]],
      related: [
        ['Orders', 'orders', 'customer_id'],
        ['Orders', 'orders', 'customer_id', { sort: 'created_on desc' }],
      ],
      current: [
        ['Next order', 'orders', 'customer_id'],
        ['Next order', 'orders', 'customer_id', { query: 'status = open', sort: 'due_on asc', region: 'aside' }],
      ],
      count: [['orders'], ['orders', { whose: 'customer_id' }]],
      sum: [
        ['orders', 'total_amount'],
        ['orders', 'total_amount', { query: 'status = open' }],
      ],
      navGroup: [
        ['records', 'Records', ['claims', 'insurers']],
        ['records', 'Records', ['claims'], { icon: 'stack' }],
      ],
      machine: [
        ['status', { open: { on: { close: 'closed' } }, closed: { final: true } }],
        [
          'status',
          { open: { on: { cancel: { to: 'cancelled', confirm: true } } }, cancelled: { final: true } },
          { since: 'status_changed_at' },
        ],
      ],
      'computed.number': [['quantity * unit_price']],
      action: [['Confirm'], ['Confirm', { command: 'confirmBooking' }]],
    };
    for (const [name, calls] of Object.entries(samples)) {
      const ours = SCAFFOLD_HELPERS[name as keyof typeof SCAFFOLD_HELPERS] as (...args: unknown[]) => unknown;
      // A helper under a namespace (`computed.number`) is reached the way the draft's import names it.
      const shipped = name.split('.').reduce<unknown>((at, part) => (at as Record<string, unknown>)[part], dsl) as (
        ...args: unknown[]
      ) => unknown;
      for (const args of calls) assert.deepEqual(ours(...args), shipped(...args), `${name}(${JSON.stringify(args)})`);
    }
  });

  test('with no --name, a URL names the App after its database, never the redacted URL', () => {
    assert.equal(scaffoldApp({ ...SCHEMA, label: 'postgres://app:***@127.0.0.1:55471/help_desk' }).app.name, 'Help desk');
    assert.equal(scaffoldApp({ ...SCHEMA, label: 'postgresql://root@localhost/shop?ssl=true' }).app.name, 'Shop');
    assert.equal(scaffoldApp({ ...SCHEMA, label: '/data/inventory.sqlite' }).app.name, 'Inventory');
  });
  test('a chosen table list narrows the draft, and the hero comes from it', () => {
    const narrowed = scaffoldApp(SCHEMA, { name: 'Billing', tables: ['customers'] });
    assert.deepEqual(narrowed.problems, []);
    const billing = narrowed.app as unknown as Draft;
    assert.equal(billing.name, 'Billing');
    assert.deepEqual(billing.nav, ['overview', 'customers']);
  });

  test("inside a mistri checkout no package.json is written: it would hide the workspace's packages", async () => {
    const dir = mkdtempSync(join(ROOT, 'test', '.scaffold-'));
    try {
      const made = await writeScaffold(SCHEMA, join(dir, 'app'));
      /* The files are the draft: loaded by the server's own loader, they are
         the App the draft object says, view for view and page for page. */
      const loaded = await loadApp(join(dir, 'app'));
      assert.deepEqual(loaded.app.views, parseAppConfig(app, 'the draft').views);
      assert.deepEqual(
        loaded.pages.map((p) => ({ ...p, source: undefined })),
        parseAppPages(app, 'the draft').map((p) => ({ ...p, source: undefined })),
      );
      assert.ok(!made.written.includes('package.json'));
      assert.ok(made.written.includes('tsconfig.json'));
      assert.ok(!made.written.includes('.oxfmtrc.json'), "the checkout's own formatter config governs");
      assert.match(made.packageNote ?? '', /workspace's own package/);
      await assert.rejects(writeScaffold(SCHEMA, join(dir, 'app')), /already exist.*refuses to overwrite/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the CLI front door: --scaffold-app, then mistri check', () => {
  /* Outside the checkout, as a new project would be: npm install is stood
     in for by a symlink to this checkout, which is what it would install. */
  const dir = mkdtempSync(join(tmpdir(), 'tw-scaffold-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'thread.db');
  spawnSync(process.execPath, [join(ROOT, 'test/fixtures/databases/thread/seed.mjs'), db], { encoding: 'utf8' });
  const config = `${db}.json`;
  const run = (args: string[]) => {
    const child = validating(args);
    return spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'packages/mistri/src/server/index.ts'), ...child.args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: child.env,
    });
  };
  const project = join(dir, 'issues');

  test('scaffolds a standalone project that passes mistri check at once', () => {
    const out = run(['--config', config, '--scaffold-app', project]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /Drafted "Thread"/);
    assert.match(out.stdout, /npm install/);
    assert.ok(!out.stdout.includes('Listening on'), 'a build step does not start a server');
    for (const file of [
      'app.ts',
      'resources.ts',
      'views.ts',
      'dashboard.ts',
      'pages/index.ts',
      'pages/issue.ts',
      'mistri-schema.d.ts',
      'tsconfig.json',
      '.oxfmtrc.json',
      '.gitignore',
      'package.json',
      'mistri-run.mjs',
      'README.md',
    ]) {
      assert.ok(existsSync(join(project, file)), `${file} is written`);
    }
    /* A connection from a config is bound by name, and the project's scripts reach it without a secret. */
    assert.match(readFileSync(join(project, 'app.ts'), 'utf8'), /connection: 'thread',/);
    assert.match(readFileSync(join(project, 'package.json'), 'utf8'), /"check": "node mistri-run\.mjs check"/);

    mkdirSync(join(project, 'node_modules'));
    mkdirSync(join(project, 'node_modules', '@mistriwork'), { recursive: true });
    symlinkSync(join(ROOT, 'packages', 'mistri'), join(project, 'node_modules', '@mistriwork', 'mistri'), 'dir');
    // The project installs TypeScript, as the quickstart does: the typecheck reads only the project's.
    symlinkSync(join(ROOT, 'node_modules', 'typescript'), join(project, 'node_modules', 'typescript'), 'dir');
    // What `npm install` brings for the tsconfig's `types: ['node']`.
    mkdirSync(join(project, 'node_modules', '@types'), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules', '@types', 'node'), join(project, 'node_modules', '@types', 'node'), 'dir');
    const check = run(['check', '--app', project, '--config', config]);
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /schema types\s+passed\s+mistri-schema\.d\.ts matches the database/);
    assert.match(check.stdout, /typecheck\s+passed\s+tsc [\d.]+/);
    assert.match(check.stdout, /validation\s+passed\s+Thread: ok/);
  });

  test('the CLI prints copyable commands for a project and config with spaces and quotes', () => {
    const special = join(dir, "team's config file.json");
    const destination = join(dir, "team's project files");
    writeFileSync(special, readFileSync(config));
    const out = run(['--config', special, '--scaffold-app', destination]);
    assert.equal(out.status, 0, out.stderr);
    const lines = out.stdout.split('\n');
    const cd = lines.find((line) => line.startsWith('  cd '));
    const check = lines.find((line) => line.startsWith('  mistri check '));
    assert.ok(cd && check, out.stdout);
    for (const [command, expected] of [
      [cd, ['cd', destination]],
      [check, ['mistri', 'check', '--app', '.', '--config', "../team's config file.json"]],
    ] as const) {
      const parsed = spawnSync('sh', ['-c', `set -- ${command}; printf '%s\\n' "$@"`], { encoding: 'utf8' });
      assert.equal(parsed.status, 0, parsed.stderr);
      assert.deepEqual(parsed.stdout.trimEnd().split('\n'), expected);
    }
    mkdirSync(join(destination, 'node_modules'));
    mkdirSync(join(destination, 'node_modules', '@mistriwork'), { recursive: true });
    symlinkSync(join(ROOT, 'packages', 'mistri'), join(destination, 'node_modules', '@mistriwork', 'mistri'), 'dir');
    symlinkSync(join(ROOT, 'node_modules', 'typescript'), join(destination, 'node_modules', 'typescript'), 'dir');
    // What `npm install` brings for the tsconfig's `types: ['node']`.
    mkdirSync(join(destination, 'node_modules', '@types'), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules', '@types', 'node'), join(destination, 'node_modules', '@types', 'node'), 'dir');
    const checked = spawnSync(
      process.execPath,
      [
        '--import',
        join(ROOT, 'node_modules/tsx/dist/loader.mjs'),
        join(ROOT, 'packages/mistri/src/server/index.ts'),
        'check',
        '--app',
        '.',
        '--config',
        "../team's config file.json",
      ],
      { cwd: destination, encoding: 'utf8', timeout: 120_000 },
    );
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.match(checked.stdout, /validation\s+passed\s+Thread: ok/);
  });

  test('refuses to scaffold over an App', () => {
    const again = run(['--config', config, '--scaffold-app', project]);
    assert.equal(again.status, 1, 'a second scaffold refuses to overwrite');
    assert.match(again.stderr, /already exist/);
  });

  test('mistri check still fails the build when the app names what the schema lacks', () => {
    writeFileSync(join(project, 'pages', 'broken.json'), JSON.stringify({ base: 'ghost_table', sections: [{ kind: 'fields' }] }, null, 2));
    const check = run(['--config', config, '--app', project, VALIDATE]);
    assert.equal(check.status, 1);
    assert.match(check.stdout, /pages[/\\]broken\.json: page "Ghost table"/);
    rmSync(join(project, 'pages', 'broken.json'));
  });

  test('mistri check without an app says what it needs', () => {
    const check = run(['--config', config, VALIDATE]);
    assert.equal(check.status, 1);
    assert.match(check.stderr, /check needs an app/);
  });
});

describe('the veneer helpers compose real config', () => {
  test('an app built from helpers parses and resolves like its JSON twin', () => {
    const app = defineApp({
      name: 'Helper Ops',
      resources: {
        orders: { display: { total_amount: { format: 'money' }, status: { tone: { completed: 'good', cancelled: 'bad' } } } },
        customers: { display: { credit_limit: { format: 'percent', bar: true } } },
      },
      views: {
        overview: dashboard('Overview', [
          metric('Orders', 'orders', { over: 'created_on' }),
          chart('Orders by month', 'orders', 'month created_on', { width: 'half' }),
          breakdown('By status', 'orders', 'status', { width: 'half', over: 'created_on' }),
          rows('Newest', 'orders', { show: ['reference', 'customer_id.name', 'status'], sort: 'created_on desc' }),
          note('Reading this board: top row is all time unless windowed.'),
        ]),
        'open-orders': listView('Open orders', 'orders', { query: 'status = open' }),
        orders: listView('Orders', 'orders'),
        customers: listView('customers'),
      },
      home: 'overview',
      nav: ['overview', 'open-orders', 'orders', 'customers'],
    });
    const parsed = parseAppConfig(app, 'helpers');
    const resolved = Object.values(resolveViews(parsed, SCHEMA));
    const errors = resolved.filter((e) => e.error).map((e) => `${e.label}: ${e.error}`);
    assert.deepEqual(errors, [], errors.join('; '));
  });

  test('page() and stream() build pages the parser and validator accept whole', () => {
    const built = page('orders', [
      { kind: 'fields' },
      {
        kind: 'timeline',
        title: 'Notes',
        streams: [stream('orders', 'customer_id', 'created_on', 'reference', { detail: 'status' })],
        limit: 10,
      },
    ]);
    const [parsed] = parsePagesConfig({ pages: [built] }, 'the veneer');
    /* The veneer's page lands on the customers page: streams lead home. */
    const checked = validatePage(SCHEMA, { ...parsed, base: 'customers' });
    assert.equal(checked.error, undefined, checked.error);
  });
});

describe('schema-typed names: --export types', () => {
  test('the generated types compile clean for real names and squiggle a typo, with the fix suggested', () => {
    /* The whole feature in one pin: write the generated .d.ts and two
       app files inside the repo (so '@mistriwork/mistri/app' self-resolves), and
       ask tsc itself. The bad file must fail, and the mismatch names the
       real table beside the typo: a helper call fixes its table from the
       argument, so TypeScript says `'"ordrs"' is not assignable to
       '"orders"'` where an object literal got a "did you mean". */
    const dir = mkdtempSync(
      (mkdirSync(join(process.cwd(), 'e2e', '.tmp'), { recursive: true }), join(process.cwd(), 'e2e', '.tmp', 'typegen-')),
    );
    try {
      writeFileSync(join(dir, 'mistri-schema.d.ts'), typesForSchema(SCHEMA));
      writeFileSync(
        join(dir, 'good.ts'),
        'import type { App } from "./mistri-schema.d.ts";\n' +
          'import { board, dashboard, listView, metric, note, page } from "@mistriwork/mistri/app";\n' +
          'const overview = dashboard("Overview", [metric("Orders", "orders", { better: "down" }), note("Orders overview"), board("Queue", "orders", "status", { lanes: ["open", "in progress"] })]);\n' +
          '// @ts-expect-error Metric direction must remain a supported value.\n' +
          'metric("Orders", "orders", { better: "sideways" });\n' +
          '// @ts-expect-error Lane values are strings, not counts.\n' +
          'board("Queue", "orders", "status", { lanes: [1] });\n' +
          '// @ts-expect-error Only board helpers accept lanes.\n' +
          'metric("Orders", "orders", { lanes: ["open"] });\n' +
          'const scoped = dashboard("Scoped", [], { from: "orders" });\n' +
          'const detail = page("orders", []);\n' +
          'const composed: App = { name: "Composed", views: { overview, scoped }, pages: { detail }, home: "overview", nav: ["overview", "scoped"] };\n' +
          '// @ts-expect-error A helper must preserve an invalid page table too.\n' +
          'const badPage: App = { name: "Bad", pages: { bad: page("ordrs", []) } };\n' +
          '// @ts-expect-error A dashboard base must not lose its table name.\n' +
          'const badDashboard: App = { name: "Bad", views: { bad: dashboard("Bad", [], { from: "ordrs" }) } };\n' +
          '// @ts-expect-error Section table names must survive dashboard composition.\n' +
          'const badSection: App = { name: "Bad", views: { bad: dashboard("Bad", [metric("Bad", "ordrs")]) } };\n' +
          'export default { name: "G", resources: { orders: { display: { status: { format: "number" } } } },\n' +
          '  views: { orders: listView("orders") }, home: "orders", nav: ["orders"] } satisfies App;\n',
      );
      writeFileSync(
        join(dir, 'bad.ts'),
        'import type { App } from "./mistri-schema.d.ts";\n' +
          'import { listView } from "@mistriwork/mistri/app";\n' +
          'export default { name: "B", views: { b: listView("ordrs") }, home: "b", nav: ["b"] } satisfies App;\n',
      );
      const tsc = (file: string) =>
        spawnSync(
          'npx',
          [
            'tsc',
            '--noEmit',
            '--ignoreConfig',
            '--strict',
            '--skipLibCheck',
            '--module',
            'nodenext',
            '--moduleResolution',
            'nodenext',
            '--allowImportingTsExtensions',
            '--target',
            'es2022',
            join(dir, file),
          ],
          { encoding: 'utf8', timeout: 120_000 },
        );
      const good = tsc('good.ts');
      assert.equal(good.status, 0, good.stdout + good.stderr);
      const bad = tsc('bad.ts');
      assert.notEqual(bad.status, 0, 'a mistyped table must fail to compile');
      assert.match(bad.stdout, /ordrs/);
      assert.match(bad.stdout, /'"ordrs"' is not assignable to type '"orders"'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a display key that names no real column fails to compile too', () => {
    const dir = mkdtempSync(
      (mkdirSync(join(process.cwd(), 'e2e', '.tmp'), { recursive: true }), join(process.cwd(), 'e2e', '.tmp', 'typegen-')),
    );
    try {
      writeFileSync(join(dir, 'mistri-schema.d.ts'), typesForSchema(SCHEMA));
      writeFileSync(
        join(dir, 'bad.ts'),
        'import type { App } from "./mistri-schema.d.ts";\n' +
          'export default { name: "B", resources: { orders: { display: { totl_amount: { format: "money" } } } } } satisfies App;\n',
      );
      const bad = spawnSync(
        'npx',
        [
          'tsc',
          '--noEmit',
          '--ignoreConfig',
          '--strict',
          '--skipLibCheck',
          '--module',
          'nodenext',
          '--moduleResolution',
          'nodenext',
          '--allowImportingTsExtensions',
          '--target',
          'es2022',
          join(dir, 'bad.ts'),
        ],
        { encoding: 'utf8', timeout: 120_000 },
      );
      assert.notEqual(bad.status, 0);
      assert.match(bad.stdout, /totl_amount/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* An inventory, as a first-time author's database is: an order named by no
   column (its only free text is who received it, empty until someone does),
   its lines, and stock that is little more than the product and warehouse it
   joins. The draft reads it the way a person would. */
const INVENTORY: DatabaseSchema = {
  label: 'inv.db',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    {
      name: 'supplier',
      schema: '',
      id: 'supplier',
      isView: false,
      approxRows: 8,
      columns: [
        { ...col('id', 'INTEGER'), primaryKey: true, nullable: false },
        { ...col('name', 'TEXT'), nullable: false },
        col('email', 'TEXT'),
      ],
    },
    {
      name: 'warehouse',
      schema: '',
      id: 'warehouse',
      isView: false,
      approxRows: 3,
      columns: [
        { ...col('id', 'INTEGER'), primaryKey: true, nullable: false },
        { ...col('name', 'TEXT'), nullable: false },
        col('city', 'TEXT'),
      ],
    },
    {
      name: 'product',
      schema: '',
      id: 'product',
      isView: false,
      approxRows: 120,
      columns: [
        { ...col('id', 'INTEGER'), primaryKey: true, nullable: false },
        { ...col('sku', 'TEXT'), nullable: false },
        { ...col('name', 'TEXT'), nullable: false },
        col('supplier_id', 'INTEGER', { references: { table: 'supplier', column: 'id' } }),
        col('unit_cost', 'NUMERIC'),
      ],
    },
    {
      name: 'stock',
      schema: '',
      id: 'stock',
      isView: false,
      approxRows: 360,
      columns: [
        { ...col('id', 'INTEGER'), primaryKey: true, nullable: false },
        col('product_id', 'INTEGER', { nullable: false, references: { table: 'product', column: 'id' } }),
        col('warehouse_id', 'INTEGER', { nullable: false, references: { table: 'warehouse', column: 'id' } }),
        { ...col('on_hand', 'INTEGER'), nullable: false },
      ],
    },
    {
      name: 'purchase_order',
      schema: '',
      id: 'purchase_order',
      isView: false,
      approxRows: 40,
      columns: [
        { ...col('id', 'INTEGER'), primaryKey: true, nullable: false },
        col('supplier_id', 'INTEGER', { nullable: false, references: { table: 'supplier', column: 'id' } }),
        { ...col('ordered_on', 'DATE'), nullable: false },
        { ...col('status', 'TEXT', { allowed: ['draft', 'sent', 'received', 'cancelled'] }), nullable: false },
        col('received_by', 'TEXT'),
      ],
    },
    {
      name: 'po_line',
      schema: '',
      id: 'po_line',
      isView: false,
      approxRows: 101,
      columns: [
        { ...col('id', 'INTEGER'), primaryKey: true, nullable: false },
        col('purchase_order_id', 'INTEGER', { nullable: false, references: { table: 'purchase_order', column: 'id' } }),
        col('product_id', 'INTEGER', { nullable: false, references: { table: 'product', column: 'id' } }),
        { ...col('qty', 'INTEGER'), nullable: false },
        col('unit_cost', 'NUMERIC'),
      ],
    },
  ],
  foreignKeys: [
    { name: 'fk1', from: { table: 'product', columns: ['supplier_id'] }, to: { table: 'supplier', columns: ['id'] } },
    { name: 'fk2', from: { table: 'stock', columns: ['product_id'] }, to: { table: 'product', columns: ['id'] } },
    { name: 'fk3', from: { table: 'stock', columns: ['warehouse_id'] }, to: { table: 'warehouse', columns: ['id'] } },
    { name: 'fk4', from: { table: 'purchase_order', columns: ['supplier_id'] }, to: { table: 'supplier', columns: ['id'] } },
    { name: 'fk5', from: { table: 'po_line', columns: ['purchase_order_id'] }, to: { table: 'purchase_order', columns: ['id'] } },
    { name: 'fk6', from: { table: 'po_line', columns: ['product_id'] }, to: { table: 'product', columns: ['id'] } },
  ],
};

describe('scaffoldApp reads a first database the way a person would', () => {
  const { app, problems } = scaffoldApp(INVENTORY, { emptyColumns: new Set(['supplier.name']) });
  const draft = app as unknown as Draft & { resources: Record<string, { recordLabel?: string }> };

  test("lines and stock are read on their parents' pages, not from the menu", () => {
    assert.deepEqual(problems, [], problems.join('; '));
    assert.ok(!draft.nav.some((key) => /line|stock/.test(key)), draft.nav.join(', '));
    assert.ok(!Object.keys(draft.views).some((key) => /line|stock/.test(key)));
    const order = Object.values(draft.pages).find((page) => page.base === 'purchase_order')!;
    assert.ok(order.sections.some((section) => section.from === 'po_line' && section.title === 'PO lines'));
    const product = Object.values(draft.pages).find((page) => page.base === 'product')!;
    assert.ok(
      product.sections.some((section) => section.from === 'stock' && section.title === 'Stock'),
      'stock has no plural',
    );
  });

  test('a record with no name of its own is said by its noun and key, never by an empty column', () => {
    /* Who received an order is not its name; with nothing else to name it the
       App says its noun and key, so the draft needs to write nothing. */
    assert.equal(draft.resources.purchase_order.recordLabel, undefined);
    assert.equal(appLabelTemplates(parseAppConfig(app, 'the draft'), INVENTORY).get('purchase_order'), 'Purchase order #{id}');
    /* A name column a sample found empty in every row is written over. */
    assert.equal(draft.resources.supplier.recordLabel, 'Supplier #{id}');
    const orders = draft.views['purchase-orders'] as { show: string[] };
    assert.notEqual(orders.show[0], 'received_by');
    assert.deepEqual(draft.resources.po_line.noun, 'PO line');
    assert.equal(draft.views.warehouses.icon, 'archive');
  });
});

describe('the CLI front door over a SQLite file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-scaffold-sqlite-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'thread.db');
  spawnSync(process.execPath, [join(ROOT, 'test/fixtures/databases/thread/seed.mjs'), db], { encoding: 'utf8' });
  const project = join(dir, 'desk');

  test('a scaffolded SQLite config works from the App and another directory without changing its database', () => {
    const out = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(ROOT, 'packages/mistri/src/server/index.ts'), db, '--scaffold-app', project, '--name', 'Help desk'],
      { cwd: ROOT, encoding: 'utf8', timeout: 120_000 },
    );
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /Drafted "Help desk"/);
    const config = JSON.parse(readFileSync(join(project, 'mistri.json'), 'utf8')) as {
      connections: Array<{ name: string; url: string }>;
    };
    assert.deepEqual(config.connections, [{ name: 'help-desk', url: db }]);
    const pkg = readFileSync(join(project, 'package.json'), 'utf8');
    assert.ok(!pkg.includes(dir) && !pkg.includes(tmpdir()), pkg);
    assert.match(pkg, /"check": "mistri check --app \."/);
    assert.ok(!existsSync(join(project, 'mistri-run.mjs')));
    assert.match(readFileSync(join(project, 'README.md'), 'utf8'), /"writable": true/);

    mkdirSync(join(project, 'node_modules'));
    mkdirSync(join(project, 'node_modules', '@mistriwork'), { recursive: true });
    symlinkSync(join(ROOT, 'packages', 'mistri'), join(project, 'node_modules', '@mistriwork', 'mistri'), 'dir');
    symlinkSync(join(ROOT, 'node_modules', 'typescript'), join(project, 'node_modules', 'typescript'), 'dir');
    // What `npm install` brings for the tsconfig's `types: ['node']`.
    mkdirSync(join(project, 'node_modules', '@types'), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules', '@types', 'node'), join(project, 'node_modules', '@types', 'node'), 'dir');
    const check = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), join(ROOT, 'packages/mistri/src/server/index.ts'), 'check', '--app', '.'],
      { cwd: project, encoding: 'utf8', timeout: 120_000 },
    );
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /schema types\s+passed\s+mistri-schema\.d\.ts matches the database/);
    const elsewhere = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        join(ROOT, 'packages/mistri/src/server/index.ts'),
        'check',
        '--app',
        project,
        '--config',
        join(project, 'mistri.json'),
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 120_000 },
    );
    assert.equal(elsewhere.status, 0, elsewhere.stdout + elsewhere.stderr);
    assert.match(elsewhere.stdout, /validation\s+passed/);
  });
});

/* A property manager's database, the design audit's: a root the busiest table
   is far from, a unit named by a code within its property, a lease with no
   name at all, a request whose unit belongs to the property it also names,
   and more tables than a flat menu holds. */
const key = { ...col('id', 'INTEGER'), primaryKey: true, nullable: false, identity: 'by-default' as const };
const req = (name: string, type = 'TEXT', extra: Record<string, unknown> = {}) => col(name, type, { nullable: false, ...extra });
const ref = (name: string, table: string, nullable = false) => col(name, 'INTEGER', { nullable, references: { table, column: 'id' } });
const LETTING: DatabaseSchema = {
  label: 'letting.db',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    {
      name: 'property',
      schema: '',
      id: 'property',
      isView: false,
      approxRows: 4,
      columns: [key, req('name'), req('city'), col('manager')],
    },
    {
      name: 'unit',
      schema: '',
      id: 'unit',
      isView: false,
      approxRows: 30,
      columns: [
        key,
        ref('property_id', 'property'),
        req('label'),
        req('bedrooms', 'INTEGER'),
        col('square_feet', 'INTEGER'),
        req('market_rent', 'REAL'),
        req('status', 'TEXT', { allowed: ['occupied', 'vacant', 'make ready'] }),
      ],
    },
    {
      name: 'tenant',
      schema: '',
      id: 'tenant',
      isView: false,
      approxRows: 30,
      columns: [key, req('name'), col('email'), col('phone'), col('notes')],
    },
    {
      name: 'lease',
      schema: '',
      id: 'lease',
      isView: false,
      approxRows: 20,
      columns: [
        key,
        ref('unit_id', 'unit'),
        ref('tenant_id', 'tenant'),
        req('starts_on', 'DATE'),
        req('monthly_rent', 'REAL'),
        req('status', 'TEXT', { allowed: ['active', 'expiring', 'ended'] }),
        req('auto_renew', 'INTEGER', { default: '0' }),
      ],
    },
    {
      name: 'payment',
      schema: '',
      id: 'payment',
      isView: false,
      approxRows: 700,
      columns: [
        key,
        ref('lease_id', 'lease'),
        req('due_on', 'DATE'),
        req('amount', 'REAL'),
        col('method'),
        req('status', 'TEXT', { allowed: ['due', 'paid', 'late'] }),
      ],
    },
    {
      name: 'request',
      schema: '',
      id: 'request',
      isView: false,
      approxRows: 45,
      columns: [
        key,
        ref('property_id', 'property'),
        ref('unit_id', 'unit', true),
        req('title'),
        req('priority', 'TEXT', { allowed: ['LOW', 'NORMAL', 'URGENT'] }),
        req('reported_on', 'DATE'),
        col('duration_minutes', 'INTEGER'),
        col('description'),
      ],
    },
    { name: 'vendor', schema: '', id: 'vendor', isView: false, approxRows: 6, columns: [key, req('name'), col('trade')] },
    {
      name: 'inspection',
      schema: '',
      id: 'inspection',
      isView: false,
      approxRows: 12,
      columns: [
        key,
        ref('unit_id', 'unit'),
        ref('vendor_id', 'vendor'),
        req('inspected_on', 'DATE'),
        col('passed', 'INTEGER', { flag: true }),
      ],
    },
  ],
  foreignKeys: [
    ['unit', 'property_id', 'property'],
    ['lease', 'unit_id', 'unit'],
    ['lease', 'tenant_id', 'tenant'],
    ['payment', 'lease_id', 'lease'],
    ['request', 'property_id', 'property'],
    ['request', 'unit_id', 'unit'],
    ['inspection', 'unit_id', 'unit'],
    ['inspection', 'vendor_id', 'vendor'],
  ].map(([table, column, target]) => ({
    name: `fk_${table}_${column}`,
    from: { table, columns: [column] },
    to: { table: target, columns: ['id'] },
  })),
};

describe('the scaffold raises the floor the design audit found', () => {
  const { app, files, problems } = scaffoldApp(LETTING, { writable: true });
  type Resource = {
    recordLabel?: string;
    labels?: Record<string, string>;
    display?: Record<string, Record<string, unknown>>;
    form?: {
      show: string[];
      defaults?: Record<string, string>;
      groups?: Array<{ label: string; fields: string[] }>;
      fields?: Record<string, { help?: string; where?: Record<string, string> }>;
    };
  };
  const draft = app as unknown as Omit<Draft, 'nav' | 'resources'> & {
    nav: unknown[];
    resources: Record<string, Resource>;
    ui: { logo: string; theme: { preset: string }; shell: { placement?: string; counts?: boolean } };
  };

  test('it validates clean, and the design check has nothing to say', () => {
    assert.deepEqual(problems, [], problems.join('; '));
    const parsed = parseAppConfig(app, 'the draft');
    const findings = designLint(parsed, parseAppPages(app, 'the draft'), withRollups(parsed, LETTING));
    assert.deepEqual(findings.map(sayDesignFinding), []);
  });

  test('a look, a mark and the top menu; a long menu folds into groups', () => {
    assert.ok(draft.ui.theme.preset && draft.ui.theme.preset !== 'mono', 'not the unstyled default');
    assert.equal(draft.ui.logo, 'credit-card', 'the mark of what the App is busiest with');
    // The anatomy's summary holds up to four figures: beside a sidebar and an aside, at 1280, the fourth wraps.
    assert.equal(draft.ui.shell.placement, 'top');
    assert.ok(
      draft.nav.some((entry) => typeof entry === 'object'),
      JSON.stringify(draft.nav),
    );
    assert.ok(draft.nav.length <= 7, `${draft.nav.length} top-level entries`);
    assert.match(files['app.ts'], /import \{ defineApp, navGroup \} from '@mistriwork\/mistri\/app';/);
  });

  test('every table others point at has a page, the root too', () => {
    const bases = Object.values(draft.pages).map((page) => page.base);
    for (const base of ['property', 'unit', 'lease', 'payment']) assert.ok(bases.includes(base), `${base}: ${bases.join(', ')}`);
  });

  test('a record with no name of its own is named by its parent', () => {
    assert.equal(draft.resources.unit.recordLabel, '{property_id.name} {label}', 'Maple Court B103, not B103');
    assert.equal(draft.resources.lease.recordLabel, '{tenant_id.name} · {unit_id.label}');
    assert.equal(draft.resources.payment.recordLabel, 'Payment #{id}', 'never an optional payment method');
    assert.equal(draft.resources.property.recordLabel, undefined);
    // The name says the property, so the unit's facts line does not say it again.
    const unit = Object.values(draft.pages).find((page) => page.base === 'unit')!;
    assert.ok(!((unit.sections[0].facts as string[] | undefined) ?? []).includes('property_id'));
  });

  test('values dress by what they are: money, units, words for a code — at runtime, with only a caption written', () => {
    const display = drawn(app, LETTING);
    assert.equal(display['lease.monthly_rent'].format, 'money');
    assert.equal(display['unit.market_rent'].format, 'money');
    assert.deepEqual(display['unit.square_feet'], { unit: 'sq ft' });
    assert.deepEqual(display['request.duration_minutes'], { unit: 'min' });
    assert.equal(draft.resources.request.labels!.duration_minutes, 'Duration');
    // A tone makes a code read as words by itself, so a toned vocabulary carries no `values`.
    assert.deepEqual(display['request.priority'], { tone: { LOW: 'neutral', NORMAL: 'neutral', URGENT: 'bad' } }, 'LOW reads Low');
    assert.deepEqual(display['unit.status'].tone, { occupied: 'good', vacant: 'warn', 'make ready': 'info' });
    // A 0/1 the database does not pin is still said as words.
    assert.deepEqual(display['lease.auto_renew'], { values: { 0: 'No', 1: 'Yes' } });
    for (const resource of ['lease', 'unit', 'request'])
      for (const rule of Object.values(draft.resources[resource].display ?? {}))
        assert.ok(!('format' in rule) && !('tone' in rule) && !('unit' in rule), JSON.stringify(rule));
  });

  test('a New form in groups, with its stamps and required vocabularies filled and a picker narrowed to the parent', () => {
    const form = draft.resources.request.form!;
    // Groups are named by what they hold, never "Details": what describes the request joins its own group.
    assert.deepEqual(
      form.groups?.map((group) => group.label),
      ['Request', 'Notes'],
    );
    assert.deepEqual(
      draft.resources.lease.form!.groups?.map((group) => group.label),
      ['Lease', 'Terms'],
      'the rent, the start and the renewal are its terms',
    );
    for (const [file, text] of Object.entries(files)) assert.doesNotMatch(text, /'Details'/, file);
    assert.deepEqual(form.groups![0].fields.slice(0, 3), ['title', 'property_id', 'unit_id'], 'the name, then what it belongs to');
    assert.deepEqual(form.defaults?.reported_on, { auto: 'today' });
    assert.equal(form.defaults?.priority, 'LOW');
    assert.match(form.fields!.reported_on.help!, /^Today, unless/);
    assert.deepEqual(form.fields!.unit_id.where, { property_id: 'property_id' });
    // A tenant's contact is its own group; a lease's picker is not narrowed by a parent it does not share.
    assert.deepEqual(draft.resources.tenant.form!.show, ['name', 'email', 'phone', 'notes']);
    assert.equal(draft.resources.lease.form!.fields?.unit_id, undefined);
  });
});

/* A clinic's database, the design acceptance's: a provider with no parent,
   figure or date, a patient whose visits are booked ahead, and visits named
   by their patient. The raw draft is what an agent starts from, so it has to
   pass the design check it is graded by, and the check has to have caught
   what the draft used to be. */
const CLINIC: DatabaseSchema = {
  label: 'clinic.db',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    {
      name: 'provider',
      schema: '',
      id: 'provider',
      isView: false,
      approxRows: 5,
      columns: [key, req('name'), col('specialty'), col('phone'), col('email'), col('active', 'INTEGER', { flag: true })],
    },
    {
      name: 'patient',
      schema: '',
      id: 'patient',
      isView: false,
      approxRows: 40,
      columns: [
        key,
        req('name'),
        req('date_of_birth', 'DATE'),
        col('phone'),
        ref('primary_provider_id', 'provider', true),
        req('status', 'TEXT', { allowed: ['active', 'inactive'] }),
        col('allergies'),
      ],
    },
    {
      name: 'visit',
      schema: '',
      id: 'visit',
      isView: false,
      approxRows: 160,
      columns: [
        key,
        ref('patient_id', 'patient'),
        ref('provider_id', 'provider'),
        req('scheduled_at', 'TIMESTAMP'),
        req('reason'),
        col('charge', 'REAL'),
        req('kind', 'TEXT', { allowed: ['annual physical', 'follow-up', 'telehealth'] }),
        req('status', 'TEXT', { allowed: ['scheduled', 'completed', 'cancelled', 'no-show'] }),
      ],
    },
  ],
  foreignKeys: [
    ['patient', 'primary_provider_id', 'provider'],
    ['visit', 'patient_id', 'patient'],
    ['visit', 'provider_id', 'provider'],
  ].map(([table, column, target]) => ({
    name: `fk_${table}_${column}`,
    from: { table, columns: [column] },
    to: { table: target, columns: ['id'] },
  })),
};

describe('the raw scaffold passes the design check it is graded by', () => {
  const { app, files, problems } = scaffoldApp(CLINIC, { writable: true });
  type Section = Record<string, unknown>;
  const pages = (app as { pages: Record<string, { base: string; sections: Section[] }> }).pages;
  const pageOf = (base: string) => Object.values(pages).find((page) => page.base === base)!;
  const lint = (draft: Record<string, unknown>) => {
    const parsed = parseAppConfig(draft, 'the draft');
    return designLint(parsed, parseAppPages(draft, 'the draft'), withRollups(parsed, CLINIC)).map(sayDesignFinding);
  };

  test('clean, over the clinic and the ops schema both', () => {
    assert.deepEqual(problems, [], problems.join('; '));
    assert.deepEqual(lint(app), []);
    assert.deepEqual(lint(scaffoldApp(SCHEMA, { writable: true }).app), []);
    for (const [file, text] of Object.entries(files)) assert.doesNotMatch(text, /'Details'/, file);
  });

  test('every record page opens on a head, and its aside holds the parent and the child that is current', () => {
    for (const base of ['provider', 'patient', 'visit']) assert.equal(pageOf(base).sections[0].kind, 'header', base);
    // A provider has no parent, figure or date: its head says what it is.
    assert.deepEqual(pageOf('provider').sections[0].facts, ['specialty', 'phone', 'email']);
    const patient = pageOf('patient').sections;
    assert.deepEqual(
      patient.find((section) => section.kind === 'card'),
      {
        kind: 'card',
        show: ['primary_provider_id', 'primary_provider_id.specialty', 'primary_provider_id.phone'],
        title: 'Primary provider',
      },
    );
    const next = patient.find((section) => section.kind === 'current')!;
    assert.deepEqual([next.title, next.query, next.sort], ['Next visit', 'status = scheduled', 'scheduled_at asc']);
  });

  test('beside the side menu the draft fits three figures, and a fourth would be told it wraps', () => {
    const side = { ...app, ui: { ...(app.ui as object), shell: { rail: true, counts: true } } };
    assert.deepEqual(lint(side), []);
    const patient = Object.entries(pages).find(([, page]) => page.base === 'patient')![0];
    const four = structuredClone(side) as typeof side & { pages: typeof pages };
    const summary = four.pages[patient].sections.find((section) => section.kind === 'fields' && !section.region)!;
    summary.show = ['date_of_birth', 'status', 'phone', 'allergies'];
    const said = lint(four);
    assert.ok(
      said.some((line) => /\[aside-summary\].*side menu.*3 share a row/.test(line)),
      said.join('\n'),
    );
  });
});

/* A tenant schema: a deal points at its account twice — by the account alone
   and, so it cannot cross tenants, by tenant and account together. The
   rollup the draft counts found both references, and the draft said twelve
   "scaffold problem (a bug)" lines instead of naming the one it meant. */
test('a child that points at its parent by a single key and a composite one is rolled up through the single one, by name', () => {
  const col = (name: string, type = 'integer', primaryKey = false) => ({ name, type, primaryKey, nullable: false });
  const schema: DatabaseSchema = {
    label: 'tenants',
    dialect: 'postgres',
    readAt: '2026-09-26',
    tables: [
      {
        id: 'account',
        schema: 'public',
        name: 'account',
        isView: false,
        approxRows: 50,
        columns: [col('id', 'integer', true), col('tenant_id'), col('name', 'text'), col('city', 'text')],
      },
      {
        id: 'deal',
        schema: 'public',
        name: 'deal',
        isView: false,
        approxRows: 500,
        columns: [
          col('id', 'integer', true),
          col('tenant_id'),
          col('account_id'),
          col('title', 'text'),
          col('amount', 'numeric'),
          col('stage', 'text'),
          col('closed_on', 'date'),
        ],
      },
      {
        id: 'contact',
        schema: 'public',
        name: 'contact',
        isView: false,
        approxRows: 300,
        columns: [col('id', 'integer', true), col('tenant_id'), col('account_id'), col('name', 'text'), col('email', 'text')],
      },
    ],
    foreignKeys: ['deal', 'contact'].flatMap((child) => [
      { name: `${child}_account_fkey`, from: { table: child, columns: ['account_id'] }, to: { table: 'account', columns: ['id'] } },
      {
        name: `${child}_tenant_account_fkey`,
        from: { table: child, columns: ['tenant_id', 'account_id'] },
        to: { table: 'account', columns: ['tenant_id', 'id'] },
      },
    ]),
  };
  const made = scaffoldApp(schema);
  assert.deepEqual(made.problems, []);
  const rollups = (made.app.resources as Record<string, { rollups?: Record<string, { whose?: string }> }>).account.rollups!;
  assert.deepEqual(Object.keys(rollups), ['deals', 'amount', 'contacts']);
  for (const rollup of Object.values(rollups)) assert.equal(rollup.whose, 'account_id');
});

/* A 0/1 flag named like money ("paid") is a yes/no, not an amount: the draft summed it as money, and its own
   types then refused the sum ("paid is boolean; a sum reads numbers"), so the draft failed `check`. */
test('a money-named 0/1 flag is never rolled up as a sum', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { SqliteAdapter } = await import('../packages/engine/src/adapters/sqlite.js');
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-scaffold-flag-'));
  const file = join(directory, 'shop.db');
  const db = new DatabaseSync(file);
  db.exec(`
    create table customer(id integer primary key, name text not null);
    create table invoice(id integer primary key, customer_id integer not null references customer(id),
                         paid integer not null default 0 check (paid in (0, 1)));
  `);
  db.close();
  const adapter = new SqliteAdapter(file);
  try {
    const schema = await adapter.introspect();
    assert.equal(schema.tables.find((t) => t.name === 'invoice')!.columns.find((c) => c.name === 'paid')!.flag, true);
    const made = scaffoldApp(schema);
    const customer = (
      made.app.resources as Record<
        string,
        { rollups?: Record<string, { fn?: string; args?: unknown[] }>; display?: Record<string, unknown> }
      >
    ).customer;
    assert.equal(customer.rollups?.paid, undefined, `rolled up: ${JSON.stringify(customer.rollups)}`);
    assert.equal(customer.display?.paid, undefined);
  } finally {
    await adapter.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
