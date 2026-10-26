import { type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './support/harness';

/**
 * A list's filter rail across related tables (shared/listFilters.ts): the
 * opportunities filter by their account's industry, a path up a reference,
 * and the accounts by the stage of the opportunities that point at them and
 * by a segment of those. A facet's counts are accounts, never opportunities:
 * Acme's two wins count it once.
 *
 * A server of its own over a fresh database (listen(0), mkdtemp).
 */
let origin = '';
let directory = '';
let child: ChildProcess | undefined;
const SHOTS = process.env.TABLEWALK_XFILTER_SHOTS;

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-cross-filters-'));
  const db = join(directory, 'sales.db');
  const source = new DatabaseSync(db);
  try {
    source.exec(`CREATE TABLE industry (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL, industry_id INTEGER REFERENCES industry(id));
      CREATE TABLE opportunity (id INTEGER PRIMARY KEY, name TEXT NOT NULL, account_id INTEGER NOT NULL REFERENCES account(id),
        stage TEXT NOT NULL CHECK (stage IN ('prospect', 'negotiation', 'won', 'lost')));
      INSERT INTO industry VALUES (1, 'Energy'), (2, 'Retail');
      INSERT INTO account VALUES (1, 'Acme', 1), (2, 'Brio', 2), (3, 'Cato', 1), (4, 'Dune', 2);
      INSERT INTO opportunity VALUES (1, 'Acme turbines', 1, 'won'), (2, 'Acme service', 1, 'won'),
        (3, 'Acme renewal', 1, 'negotiation'), (4, 'Brio tills', 2, 'negotiation'), (5, 'Cato pumps', 3, 'lost');`);
  } finally {
    source.close();
  }
  const config = join(directory, 'connections.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'sales', url: db }] }));
  const appDirectory = join(directory, 'app');
  mkdirSync(appDirectory);
  writeFileSync(
    join(appDirectory, 'app.json'),
    JSON.stringify({
      id: 'sales',
      name: 'Sales',
      connection: 'sales',
      resources: {
        industry: {},
        account: {},
        opportunity: { segments: { open: 'stage in (prospect, negotiation)' } },
      },
      views: {
        accounts: {
          kind: 'list',
          from: 'account',
          show: ['name', 'industry_id.name'],
          sort: 'name',
          filterBar: 'rail',
          filters: ['industry_id', { has: 'opportunity', filter: 'stage' }, { has: 'opportunity', segment: 'open' }],
        },
        opportunities: {
          kind: 'list',
          from: 'opportunity',
          show: ['name', 'account_id.name', 'stage'],
          sort: 'name',
          filterBar: 'rail',
          filters: ['stage', 'account_id.industry_id'],
        },
      },
      home: 'accounts',
      nav: ['accounts', 'opportunities'],
    }),
  );
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  origin = `http://127.0.0.1:${port}`;
  const started = spawn(
    process.execPath,
    ['--import', 'tsx', 'packages/mistri/src/server/index.ts', '--config', config, '--app', appDirectory, '--port', String(port)],
    {
      cwd: resolve('.'),
      env: { ...process.env, DATABASE_URL: '', XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child = started;
  let log = '';
  started.stdout!.on('data', (chunk) => {
    log += String(chunk);
  });
  started.stderr!.on('data', (chunk) => {
    log += String(chunk);
  });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`The fixture did not start: ${log}`)), 20_000);
    started.stdout!.on('data', () => {
      if (log.includes('Listening on ')) {
        clearTimeout(timer);
        done();
      }
    });
    started.once('exit', () => {
      clearTimeout(timer);
      fail(new Error(`The fixture exited: ${log}`));
    });
  });
});

test.afterAll(async () => {
  if (child && child.exitCode === null) {
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    const force = setTimeout(() => child?.kill('SIGKILL'), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  }
  rmSync(directory, { recursive: true, force: true });
});

const rows = (page: import('@playwright/test').Page) => page.locator('tbody tr td:first-child');

test('a facet of the rows that point here ticks values counted as records, and a segment of them is a yes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/accounts`);
  const rail = page.getByRole('complementary', { name: 'Account filters' });
  const stage = rail.getByRole('group', { name: 'Opportunity stage' });
  // Acme's two wins are one account; two accounts negotiate.
  await expect(stage.getByRole('checkbox', { name: /^Won 1$/ })).toBeVisible();
  await expect(stage.getByRole('checkbox', { name: /^Negotiation 2$/ })).toBeVisible();
  await expect(stage.getByRole('checkbox', { name: /^Lost 1$/ })).toBeVisible();
  await stage.getByRole('checkbox', { name: /^Won/ }).check();
  await expect(rows(page)).toHaveText(['Acme']);
  await expect(page).toHaveURL(/[?&]has\.opportunity\.stage=won(&|$)/);
  await stage.getByRole('checkbox', { name: /^Lost/ }).check();
  await expect(rows(page)).toHaveText(['Acme', 'Cato']);
  await expect(page.locator('.applist-chip', { hasText: 'Opportunity stage is Won or Lost' })).toBeVisible();
  if (SHOTS) await rail.locator('xpath=..').screenshot({ path: join(SHOTS, 'rail-desk.png') });

  // The address is the question: a reload asks it again.
  await page.reload();
  await expect(rail.getByRole('group', { name: 'Opportunity stage' }).getByRole('checkbox', { name: /^Lost/ })).toBeChecked();
  await expect(rows(page)).toHaveText(['Acme', 'Cato']);

  // A segment of the rows below is a yes-or-no; with the stages ticked, both hold, each of a row of its own.
  await rail.getByRole('checkbox', { name: /^Has open opportunities/ }).check();
  await expect(page).toHaveURL(/[?&]has\.opportunity\.open=yes(&|$)/);
  await expect(rows(page)).toHaveText(['Acme']);
  await page.getByRole('group', { name: 'Account filters applied' }).getByRole('button', { name: 'Clear all' }).click();
  await expect(rows(page)).toHaveCount(4);
});

test("a facet up a reference is called by the record it reaches and lists the parents' names", async ({ page }) => {
  await page.goto(`${origin}/opportunities`);
  const rail = page.getByRole('complementary', { name: 'Opportunity filters' });
  const industry = rail.getByRole('group', { name: 'Industry' });
  await expect(industry.getByRole('checkbox', { name: /^Energy 4$/ })).toBeVisible();
  await expect(industry.getByRole('checkbox', { name: /^Retail 1$/ })).toBeVisible();
  await industry.getByRole('checkbox', { name: /^Retail/ }).check();
  await expect(page).toHaveURL(/[?&]account_id\.industry_id=2(&|$)/);
  await expect(rows(page)).toHaveText(['Brio tills']);
});

test('on a phone the facets across tables are in the Filters sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/accounts`);
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Filters' });
  await expect(sheet.getByRole('group', { name: 'Opportunity stage' }).getByRole('checkbox', { name: /^Negotiation 2$/ })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'rail-phone.png') });
});
