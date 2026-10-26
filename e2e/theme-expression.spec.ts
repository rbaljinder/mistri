import { type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import { PART_SELECTORS } from '../packages/mistri/src/server/app/themePartSelectors';
import { expect, test } from './support/harness';

/**
 * What a theme says beyond the recipe menu, drawn: the built-in look where a rule was folded into the type roles,
 * and (TH-3) a band under every other row, a pattern behind the page and the menu, a part's own colors, the icons'
 * weight and a theme's own stylesheet. One App wears each theme by the reader's pick, as `shot` switches them.
 *
 * A server of its own over a fresh database (listen(0), mkdtemp).
 */
let origin = '';
let directory = '';
let child: ChildProcess | undefined;

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-theme-expression-'));
  const db = join(directory, 'yard.db');
  const source = new DatabaseSync(db);
  try {
    source.exec(
      `CREATE TABLE job (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, total REAL NOT NULL, due_on TEXT NOT NULL);`,
    );
    const job = source.prepare('INSERT INTO job VALUES (?, ?, ?, ?, ?)');
    for (let i = 1; i <= 12; i++) job.run(i, `Job ${i}`, i % 3 ? 'Open' : 'Done', i * 120, `2026-09-${String(i).padStart(2, '0')}`);
  } finally {
    source.close();
  }
  const config = join(directory, 'connections.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'yard', url: db, writable: true }] }));
  const app = join(directory, 'app');
  mkdirSync(join(app, 'node_modules'), { recursive: true });
  mkdirSync(join(app, 'node_modules', '@mistriwork'), { recursive: true });
  symlinkSync(join(resolve('.'), 'packages', 'mistri'), join(app, 'node_modules', '@mistriwork', 'mistri'), 'dir');
  writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(app, 'app.ts'),
    `import { dashboard, defineApp, defineTheme, listView, metric } from '@mistriwork/mistri/app';
const dressed = defineTheme({
  id: 'dressed',
  label: 'Dressed',
  extends: 'lumen',
  colors: { light: { band: '#eef3fb' } },
  recipes: { table: 'banded' },
  surface: { ground: { kind: 'grid', strength: 2 }, nav: { kind: 'dots' } },
  parts: {
    stat: { ground: 'accentSoft', edge: 'accent', radius: 'square' },
    'page.title': { case: 'upper' },
    'table.head': { ground: 'nav.ground', ink: 'nav.ink' },
  },
  type: { icons: 'fill' },
});
const sheeted = defineTheme({ id: 'sheeted', label: 'Sheeted', extends: 'lumen', stylesheet: './sheeted.css' });
export default defineApp({
  id: 'yard',
  name: 'Yard',
  connection: 'yard',
  resources: { job: { access: 'write' } },
  views: {
    today: dashboard('Today', [metric('Open jobs', 'job', { query: "status = 'Open'" })], { description: 'What the yard has on, at a glance.' }),
    jobs: listView('Jobs', 'job'),
  },
  home: 'today',
  ui: { customThemes: [dressed, sheeted], theme: { preset: 'lumen' } },
});
`,
  );
  writeFileSync(
    join(app, 'sheeted.css'),
    '[data-part="stat"] {\n  border-top: 3px solid var(--accent);\n}\n[data-part="stat"]:hover {\n  background-color: var(--accent-soft);\n}\n',
  );
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  origin = `http://127.0.0.1:${port}`;
  const started = spawn(
    process.execPath,
    ['--import', 'tsx', 'packages/mistri/src/server/index.ts', '--config', config, '--app', app, '--port', String(port)],
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
    const timer = setTimeout(() => fail(new Error(`The fixture did not start: ${log}`)), 30_000);
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
  if (directory) rmSync(directory, { recursive: true, force: true });
});

/** The App's page in the theme the reader picked (`shot`'s preference), once its look has arrived. */
async function open(page: Page, path: string, theme?: string) {
  if (theme)
    await page.addInitScript((pick) => localStorage.setItem('mistri.custom-theme-choices', JSON.stringify([['yard', pick]])), theme);
  await page.goto(`${origin}${path}`);
  await expect(page.locator('html')).not.toHaveAttribute('data-starting', { timeout: 30_000 });
}

test("Lumen's dashboard description is the page's muted ink at 14px, as Lumen drew it before its type became roles", async ({ page }) => {
  // The first visit compiles the client under tsx (devclient.ts): give it the time a cold start takes.
  test.setTimeout(60_000);
  await open(page, '/today');
  const description = page.locator('.dash-head .dash-description');
  await expect(description).toHaveText('What the yard has on, at a glance.');
  // Lumen said `color: var(--ink-muted); font-size: 14px` here under its large scale; the rule went with the scale,
  // and what it said is what the page draws without it.
  const drawn = await description.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--ink-muted)';
    element.append(probe);
    const muted = getComputedStyle(probe).color;
    probe.remove();
    return {
      color: getComputedStyle(element).color,
      muted,
      size: getComputedStyle(element).fontSize,
      look: document.documentElement.dataset.themeStyle,
    };
  });
  expect(drawn.look).toBe('lumen');
  expect(drawn.size).toBe('14px');
  expect(drawn.color).toBe(drawn.muted);
});

/** What a page fetched of the theme's own sheets and chunks, by their module names under the dev server. */
function fetched(page: Page) {
  const names: string[] = [];
  page.on('request', (request) => {
    const match = /\/(partsLook|surfacesLook|iconWeights)[.-]/.exec(request.url());
    if (match) names.push(match[1]!);
  });
  return names;
}

test('a theme that says no band, pattern, part or icon weight sets no attribute and fetches none of their sheets', async ({ page }) => {
  test.setTimeout(60_000);
  const names = fetched(page);
  await open(page, '/jobs');
  await expect(page.locator('.table-wrap tbody tr').first()).toBeVisible();
  const root = await page
    .locator('html')
    .evaluate((element) =>
      ['data-parts', 'data-surface-ground', 'data-surface-nav', 'data-icons'].filter((name) => element.hasAttribute(name)),
    );
  expect(root).toEqual([]);
  expect(names).toEqual([]);
});

test('a dressed theme: its parts where the platform draws them, a band under every other row, its patterns and its icons', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await open(page, '/today');
  const plainIcon = await page.locator('.tw-icon path').first().getAttribute('d');
  const names = fetched(page);
  await open(page, '/today', 'dressed');
  await expect(page.locator('html')).toHaveAttribute('data-parts', /stat:ground/);
  /* The two sheets are asked for by name. The icon weights are proven by the drawing instead (the path below that
     is no longer the plain one): a module the first visit's page already holds may not be asked for again. */
  await expect.poll(() => new Set(names.filter((name) => name !== 'iconWeights'))).toEqual(new Set(['partsLook', 'surfacesLook']));

  /* Every part said here names an element on the page that draws it. */
  for (const part of ['ground', 'page.title', 'stat', 'stat.figure'] as const)
    expect(await page.locator(PART_SELECTORS[part]).count(), part).toBeGreaterThan(0);
  const stat = await page
    .locator(PART_SELECTORS.stat)
    .first()
    .evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--accent-soft)';
      document.body.append(probe);
      const soft = getComputedStyle(probe).color;
      probe.style.color = 'var(--accent)';
      const accent = getComputedStyle(probe).color;
      probe.remove();
      const style = getComputedStyle(element);
      return { ground: style.backgroundColor, soft, edge: style.borderTopColor, accent, radius: style.borderTopLeftRadius };
    });
  expect(stat.ground).toBe(stat.soft);
  expect(stat.edge).toBe(stat.accent);
  expect(stat.radius).toBe('0px');
  await expect(page.locator(PART_SELECTORS['page.title']).first()).toHaveCSS('text-transform', 'uppercase');

  /* The patterns: gradients in the line color behind the page and the menu, none behind a panel. */
  expect(
    await page
      .locator('.app-mode .content')
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundImage),
  ).toContain('linear-gradient');
  const nav = page.locator('.app-mode :is(.sidebar, .topbar)').first();
  expect(await nav.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain('radial-gradient');
  expect(
    await page
      .locator(PART_SELECTORS.stat)
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundImage),
  ).toBe('none');

  /* The icons in the theme's weight: the same glyph, drawn filled. */
  expect(await page.locator('.tw-icon path').first().getAttribute('d')).not.toBe(plainIcon);

  /* A band under every other row, and the table's head on the menu's ground in its ink. */
  await open(page, '/jobs', 'dressed');
  const rows = page.locator(PART_SELECTORS['table.row']);
  await expect(rows.nth(1)).toBeVisible();
  const [odd, even] = await Promise.all(
    [0, 1].map((index) =>
      rows
        .nth(index)
        .locator('td')
        .first()
        .evaluate((cell) => getComputedStyle(cell).backgroundColor),
    ),
  );
  expect(even).toBe('rgb(238, 243, 251)');
  expect(odd).not.toBe(even);
  const head = await page
    .locator(PART_SELECTORS['table.head'])
    .first()
    .evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--nav-ground)';
      document.body.append(probe);
      const ground = getComputedStyle(probe).color;
      probe.remove();
      return { drawn: getComputedStyle(element).backgroundColor, ground };
    });
  expect(head.drawn).toBe(head.ground);
});

test("a theme's own stylesheet: linked only while the theme is worn, and drawn on the part it names", async ({ page }) => {
  test.setTimeout(60_000);
  await open(page, '/today');
  await expect(page.locator('link[data-theme-sheet]')).toHaveCount(0);
  const plain = await page
    .locator(PART_SELECTORS.stat)
    .first()
    .evaluate((element) => getComputedStyle(element).borderTopWidth);
  await open(page, '/today', 'sheeted');
  const link = page.locator('link[data-theme-sheet]');
  await expect(link).toHaveCount(1);
  // A single App is served at the root, so its inside address `/yard/_brand/…` is linked as `/_brand/…`.
  expect(await link.getAttribute('href')).toMatch(/^\/_brand\/sheeted-[0-9a-f]{12}\.css$/);
  const stat = page.locator(PART_SELECTORS.stat).first();
  const drawn = await stat.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(element);
    return { width: style.borderTopWidth, color: style.borderTopColor, accent };
  });
  expect(drawn.width).toBe('3px');
  expect(drawn.width).not.toBe(plain);
  expect(drawn.color).toBe(drawn.accent);
  // The sheet is the theme's alone: worn as Lumen again, its rule no longer matches.
  await page.evaluate(() => document.documentElement.setAttribute('data-visual-theme', 'lumen'));
  expect(await stat.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe(plain);
});
