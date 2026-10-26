import { type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './support/harness';
import { card, chart, dashboard, fields, headline, metric, page, related } from '../packages/mistri/schema/app.mjs';

/**
 * A record page composed the way the samples compose one, drawn in a real
 * browser, for the defects that only a layout shows: a related list beside
 * an aside cut its status column off at the edge; on a phone the whole aside
 * came up after the first section, ahead of the lists; a page chart over
 * months stood in count order; a day chart's hidden data table made the
 * dashboard scroll thousands of pixels into nothing; a 0/1 flag read "0";
 * and a multi-word status read "partially paid" beside "Paid".
 *
 * A server of its own over a fresh database (listen(0), mkdtemp).
 */
let origin = '';
let directory = '';
let child: ChildProcess | undefined;

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-record-page-fit-'));
  const db = join(directory, 'leases.db');
  const source = new DatabaseSync(db);
  try {
    source.exec(`
      CREATE TABLE unit (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO unit VALUES (1, 'Maple Court 102');
      CREATE TABLE lease (id INTEGER PRIMARY KEY, unit_id INTEGER NOT NULL REFERENCES unit(id), tenant TEXT NOT NULL, rent REAL NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'in review', 'ended')),
        auto_renew INTEGER NOT NULL DEFAULT 0 CHECK (auto_renew IN (0, 1)));
      INSERT INTO lease VALUES (1, 1, 'Noah Lindqvist', 2003, 'in review', 1), (2, 1, 'Ada North', 1800, 'ended', 0),
        (3, 1, 'Bea South', 1900, 'ended', 0), (4, 1, 'Cy West', 2100, 'active', 0);
      CREATE TABLE payment (id INTEGER PRIMARY KEY, lease_id INTEGER NOT NULL REFERENCES lease(id), due_on DATE NOT NULL,
        amount REAL NOT NULL, paid_on DATE, method TEXT, reference TEXT, note TEXT,
        status TEXT NOT NULL CHECK (status IN ('paid', 'late', 'partially paid')));
      CREATE TABLE charge (id INTEGER PRIMARY KEY, unit_id INTEGER NOT NULL REFERENCES unit(id), label TEXT);
      CREATE TABLE deposit (id INTEGER PRIMARY KEY, unit_id INTEGER NOT NULL REFERENCES unit(id), label TEXT);
      CREATE TABLE inspection (id INTEGER PRIMARY KEY, unit_id INTEGER NOT NULL REFERENCES unit(id), label TEXT);
      CREATE TABLE memo (id INTEGER PRIMARY KEY, unit_id INTEGER NOT NULL REFERENCES unit(id), label TEXT);
      INSERT INTO unit VALUES (2, 'Birch Court 3');
      INSERT INTO memo VALUES (1, 2, 'Move-out walk-through');
      CREATE TABLE receipt (id INTEGER PRIMARY KEY, memo_id INTEGER NOT NULL REFERENCES memo(id), reference TEXT NOT NULL,
        received_on DATE NOT NULL, amount REAL NOT NULL, method TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('cleared', 'pending', 'returned')));
      INSERT INTO receipt VALUES (1, 1, 'RCPT-2026-0001', '2026-03-03', 450, 'bank transfer', 'cleared'),
        (2, 1, 'RCPT-2026-0002', '2026-04-03', 1200, 'cashier check', 'pending');`);
    const insert = source.prepare(
      'INSERT INTO payment (lease_id, due_on, amount, paid_on, method, reference, note, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    /* Two years of days for the dashboard's day chart; the lease's own months
       hold more payments in the older months, so count order is not time order. */
    for (let day = 0; day < 700; day += 1) {
      const due = new Date(Date.UTC(2024, 9, 1 + day)).toISOString().slice(0, 10);
      insert.run(2 + (day % 3), due, 100, due, 'transfer', `REF-${day}`, 'Autopay', 'paid');
    }
    const months: Array<[string, number]> = [
      ['2026-01-03', 3],
      ['2026-02-03', 1],
      ['2026-03-03', 2],
    ];
    for (const [due, times] of months) {
      for (let n = 0; n < times; n += 1)
        insert.run(
          1,
          due,
          2003,
          null,
          'bank transfer',
          `LEASE-1-${due}-${n}`,
          'Rent for the month, sent late',
          n ? 'partially paid' : 'paid',
        );
    }
  } finally {
    source.close();
  }
  const config = join(directory, 'connections.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'leases', url: db }] }));
  const appDirectory = join(directory, 'app');
  mkdirSync(appDirectory);
  writeFileSync(
    join(appDirectory, 'app.json'),
    JSON.stringify({
      id: 'leases',
      name: 'Leases',
      connection: 'leases',
      resources: {
        lease: { display: { status: { tone: { active: 'good', 'in review': 'info', ended: 'neutral' } } } },
        payment: { display: { status: { tone: { paid: 'good', late: 'bad', 'partially paid': 'warn' } } } },
        unit: {},
        charge: {},
        deposit: {},
        inspection: {},
        memo: {},
        receipt: { display: { status: { tone: { cleared: 'good', pending: 'warn', returned: 'bad' } } } },
      },
      views: {
        overview: dashboard('Overview', [chart('Payments by day', 'payment', 'day due_on', { shape: 'bar' })]),
        leases: { kind: 'list', from: 'lease', label: 'Leases', show: ['tenant', 'status'] },
        units: { kind: 'list', from: 'unit', label: 'Units', show: ['name'] },
        memos: { kind: 'list', from: 'memo', label: 'Memos', show: ['label'] },
      },
      pages: {
        unit: page(
          'unit',
          [
            fields(['name']),
            related('Charges', 'charge', 'unit_id', { show: ['label'] }),
            related('Deposits', 'deposit', 'unit_id', { show: ['label'] }),
            related('Inspections', 'inspection', 'unit_id', { show: ['label'] }),
            related('Memos', 'memo', 'unit_id', { show: ['label'] }),
          ],
          { empty: 'collapse' },
        ),
        memo: page('memo', [
          fields(['label']),
          related('Receipts', 'receipt', 'memo_id', {
            show: ['reference', 'received_on', 'amount', 'method', 'status'],
            region: 'aside',
          }),
        ]),
        lease: page('lease', [
          fields(['tenant', 'status', 'auto_renew']),
          metric('Payments made', 'payment', { whose: 'lease_id', width: 'half' }),
          related('Payments', 'payment', 'lease_id', {
            show: ['due_on', 'reference', 'amount', 'paid_on', 'method', 'note', 'status'],
            sort: 'due_on desc',
          }),
          chart('Payments by month', 'payment', 'month due_on', { whose: 'lease_id', shape: 'bar' }),
          headline('rent', { region: 'aside' }),
          card('Unit', 'unit_id', ['name'], { region: 'aside' }),
          fields(['auto_renew'], { title: 'Terms', region: 'aside' }),
        ]),
      },
      home: 'leases',
      nav: ['overview', 'leases', 'units'],
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
    const ready = () => {
      if (log.includes('Listening on ')) {
        clearTimeout(timer);
        done();
      }
    };
    started.stdout!.on('data', ready);
    started.once('exit', () => {
      clearTimeout(timer);
      fail(new Error(`The fixture exited: ${log}`));
    });
  });
});

test.afterAll(async () => {
  child?.kill();
  rmSync(directory, { recursive: true, force: true });
});

const section = (page: import('@playwright/test').Page, title: string) =>
  page
    .locator('.page-section')
    .filter({ has: page.locator('.page-section-head', { hasText: new RegExp(`^\\s*${title}\\s*$`) }) })
    .first();

test('beside the aside, a related list keeps its name and its whole status; a flag says yes; words read one way', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/leases/1`);
  const payments = section(page, 'Payments');
  const grid = payments.locator('table').first();
  await expect(grid.locator('tbody tr').first()).toBeVisible();
  const heads = await grid.locator('thead th').allTextContents();
  // A moment is said by what happened (columnCaption.ts): `due_on` heads as "Due".
  expect(heads.join('|')).toMatch(/(^|\|)\s*Due\b/i);
  expect(heads.join('|')).toMatch(/Status/i);
  expect(heads.length).toBeLessThan(7);
  // The status column ends inside the list's own box, never under its edge.
  const box = await payments.boundingBox();
  const status = grid.locator('thead th', { hasText: /Status/i }).first();
  const head = await status.boundingBox();
  expect(head!.x + head!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
  // One column, one way of wording its values.
  await expect(grid.locator('tbody')).toContainText('Partially paid');
  await expect(page.locator('.page-section').first()).toContainText('In review');
  // The CHECK (auto_renew IN (0, 1)) flag reads as yes, not "1".
  await expect(section(page, 'Terms').locator('.bool-value')).toHaveText(/yes/i);
});

test('a page chart over months stands in time order', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/leases/1`);
  const bars = section(page, 'Payments by month').locator('.chart-bar title');
  await expect(bars).toHaveCount(3);
  const said = await bars.allTextContents();
  expect(said.map((text) => text.split(':')[0])).toEqual(['Jan 2026', 'Feb 2026', 'Mar 2026']);
});

test("on a phone the aside's headline leads the lists, and its card and properties follow the main work", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/leases/1`);
  const headline = page.locator('.page-section:has(.page-headline)');
  const payments = section(page, 'Payments');
  const unit = page.locator('.page-card-section');
  const terms = section(page, 'Terms');
  await expect(unit).toBeVisible();
  const [top, lists, card, rail] = await Promise.all([
    headline.boundingBox(),
    payments.boundingBox(),
    unit.boundingBox(),
    terms.boundingBox(),
  ]);
  expect(top!.y).toBeLessThan(lists!.y);
  // The card of the record a reference names is context, not the work: it follows the lists, as the skill's rubric
  // says the main work comes before the aside on a phone.
  expect(card!.y).toBeGreaterThanOrEqual(lists!.y + lists!.height - 1);
  expect(rail!.y).toBeGreaterThanOrEqual(lists!.y + lists!.height - 1);
});

test('a dashboard with a chart of two years of days ends where its content ends', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/overview`);
  await expect(page.locator('.chart-bar').first()).toBeAttached();
  const { scroll, drawn, window } = await page.evaluate(() => {
    const pane = [...document.querySelectorAll<HTMLElement>('main, .content')].find((e) => e.scrollHeight > 0)!;
    const bottom = Math.max(...[...pane.querySelectorAll('.page-section')].map((e) => e.getBoundingClientRect().bottom));
    return { scroll: pane.scrollHeight, drawn: bottom - pane.getBoundingClientRect().top, window: pane.clientHeight };
  });
  // A pane never scrolls shorter than its own window: a dashboard that ends high on the page fills it and no more.
  expect(scroll).toBeLessThanOrEqual(Math.max(window, drawn + 400));
});

for (const [name, size] of [
  ['a desk', { width: 1280, height: 900 }],
  ['a phone', { width: 390, height: 844 }],
] as const) {
  test(`on ${name}, four empty related lists are one quiet line, not four empty tables`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto(`${origin}/units/1`);
    const line = page.locator('.page-empty-run');
    await expect(line).toHaveCount(1);
    await expect(line).toContainText(/No charges, deposits, inspections, or memos yet/i);
    await expect(page.locator('.page-section table')).toHaveCount(0);
    // The line sits inside the page: nothing scrolls sideways.
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(sideways).toBe(false);
  });
}

/* A related list in the aside is a table in a column a third of the record wide: it fits that column by leaving
   columns out, never by scrolling sideways under a cut-off header. */
for (const [label, width, height] of [
  ['at a desk', 1280, 900],
  ['at the narrowest window that still has an aside', 1101, 800],
  ['at a narrow window, the aside under the record', 1000, 800],
  ['on a phone', 390, 800],
] as const) {
  test(`a table in the aside fits its column ${label}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${origin}/memos/1`);
    const receipts = section(page, 'Receipts');
    // On a phone a list opens as records; its Table pick is the table a person asks for.
    if (width < 600) await receipts.getByRole('button', { name: 'Table', exact: true }).click();
    await expect(receipts.locator('tbody tr').first()).toBeVisible();
    const box = (await receipts.boundingBox())!;
    // Nothing in the section stands past its edge, and the page itself does not scroll sideways.
    const overflow = await receipts.evaluate((node) => {
      const edge = node.getBoundingClientRect().right;
      return [...node.querySelectorAll('th, td')].filter((cell) => cell.getBoundingClientRect().right > edge + 1).length;
    });
    expect(overflow, 'cells past the section edge').toBe(0);
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')).toBe(true);
    // No scroller of its own holds the table wider than itself.
    expect(
      await receipts.evaluate((node) =>
        [...node.querySelectorAll('*')].some(
          (el) => el.scrollWidth > el.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowX),
        ),
      ),
      'a scroller inside the section',
    ).toBe(false);
    // A header reads whole or not at all: its text is never cut mid-word by the cell.
    const cut = await receipts.evaluate((node) =>
      [...node.querySelectorAll('thead th')]
        .filter((th) => {
          const label = th.querySelector('button, span') ?? th;
          return label.scrollWidth > label.clientWidth + 1;
        })
        .map((th) => th.textContent?.trim()),
    );
    expect(cut, 'headers cut by their cell').toEqual([]);
    // The name and the status are the columns kept.
    const heads = (await receipts.locator('thead th').allTextContents()).join('|');
    expect(heads).toMatch(/Status/i);
    expect(heads).toMatch(/Reference|Receipt/i);
    expect(box.width).toBeGreaterThan(0);
  });
}
