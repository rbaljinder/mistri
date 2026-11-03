import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from '@playwright/test';
import { expect, test } from './support/harness';
import {
  contrastReadings,
  inPage,
  probePage,
  watchEvents,
  watchShifts,
  type ContrastReading,
  type Probe,
  contractProbe,
  focusStops,
} from '../packages/mistri/src/server/build/gradeProbe';
import { judge, MOTION, TAP, type GradeCode } from '../packages/mistri/src/server/build/gradeJudge';

/**
 * `mistri grade`'s probe, held to fixture pages: each measurement finds the
 * defect a small page is built to have, and a clean page grades clean at a desk
 * and on a phone. Then the command itself, run as an agent runs it, on Tick.
 *
 * The fixture pages are served by a route on an address no server answers
 * (http://grade.test), in a context of the test's own, so a page built to throw
 * is measured rather than tripping the harness. The Tick run starts its own
 * server on a free port over a mkdtemp database: nothing shared.
 */
const ORIGIN = 'http://grade.test';

async function graded(
  browser: Browser,
  body: string,
  { width = 1280, height = 900, record = false, zoom = 1 }: { width?: number; height?: number; record?: boolean; zoom?: number } = {},
): Promise<GradeCode[]> {
  // Motion reduced, as grade opens every window (shotContext).
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  try {
    await context.addInitScript(inPage(watchShifts, null));
    await context.route(`${ORIGIN}/**`, (route) =>
      route.request().url().endsWith('/missing')
        ? route.fulfill({ status: 500, body: 'no' })
        : route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>
              body { margin: 0; font: 16px/1.5 sans-serif; color: #111; background: #fff; }
              button { min-width: 44px; min-height: 44px; }
              :root { zoom: ${zoom} }
            </style></head><body>${body}</body></html>`,
          }),
    );
    const page = await context.newPage();
    const events = { errors: [] as string[], failed: [] as string[] };
    watchEvents(page, events);
    await page.goto(`${ORIGIN}/page`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const probe = (await page.evaluate(inPage(probePage, { tap: width <= 760 ? TAP : 0, record }))) as Probe;
    const contrast = (await page.evaluate(inPage(contrastReadings, { states: [], text: true }))) as ContrastReading[];
    /* The theme contract's promises, measured as grade measures them: in-page, then a desk's Tab stops and paper. */
    Object.assign(probe, (await page.evaluate(inPage(contractProbe, { reduced: true, ms: MOTION }))) as Partial<Probe>);
    if (width > 760) probe.focus = await focusStops(page);
    if (record) {
      await page.emulateMedia({ media: 'print' });
      probe.print = (await page.evaluate(inPage(contrastReadings, { states: [], text: true }))) as ContrastReading[];
    }
    return judge(probe, contrast, events, { width, dark: false }).map((finding) => finding.code);
  } finally {
    await context.close();
  }
}

const CLEAN = `
  <main>
    <h1>Orders</h1>
    <section><h2>Open</h2><p>Three orders wait for a part.</p>
      <table><thead><tr><th>Order</th><th>Total</th></tr></thead>
        <tbody><tr><td>Brake bleed</td><td>$1,240.00</td></tr><tr><td>Tune-up</td><td>$89.50</td></tr></tbody></table>
      <button>Add order</button>
    </section>
    <section><h2>Revenue</h2>
      <svg width="300" height="120" role="img" aria-label="Revenue">
        <text class="chart-tick chart-y-tick" x="0" y="110">$0</text>
        <text class="chart-tick chart-y-tick" x="0" y="60">$2k</text>
        <text class="chart-tick chart-y-tick" x="0" y="10">$4k</text>
      </svg>
    </section>
  </main>`;

test('a clean page grades clean at a desk and on a phone', async ({ browser }) => {
  expect(await graded(browser, CLEAN)).toEqual([]);
  expect(await graded(browser, CLEAN, { width: 390, height: 844, record: true })).toEqual([]);
});

const defects: Array<[GradeCode, string, { width?: number; height?: number; record?: boolean }?]> = [
  ['sideways-scroll', '<div style="width: 2000px">A wide strip</div>'],
  [
    'clipped-number',
    `<table style="table-layout: fixed; width: 120px"><tbody><tr>
       <td style="width: 60px; max-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">$12,345,678.00</td>
       <td>Due</td></tr></tbody></table>`,
  ],
  [
    'clipped-text',
    '<p><span style="display: inline-block; width: 60px; overflow: hidden; white-space: nowrap">Ready for pickup</span> is a status.</p>',
  ],
  [
    'overlap',
    `<div style="position: relative; height: 60px">
       <button style="position: absolute; left: 0; top: 0; width: 120px">Save</button>
       <button style="position: absolute; left: 60px; top: 10px; width: 120px">Discard</button></div>`,
  ],
  [
    'small-target',
    '<p>Row</p><button style="min-width: 0; min-height: 0; width: 24px; height: 24px">⋯</button>',
    { width: 390, height: 844 },
  ],
  ['low-contrast', '<p style="color: #bbb">Due on Friday</p>'],
  ['faint-edge', '<label>Name <input style="border: 1px solid #e4e4e4; background: #fff" value="Ada"></label>'],
  ['hidden-focus', '<style>a:focus { outline: none }</style><p><a href="#a">Orders</a> and <a href="#b">Parts</a></p>'],
  [
    'color-only',
    '<table><tbody><tr><td>Brake bleed</td><td><span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #d92d20"></span></td></tr></tbody></table>',
  ],
  [
    'long-measure',
    `<p style="max-width: none; font-size: 14px">${'A work order says what was asked, what was found and what was done, '.repeat(6)}</p>`,
  ],
  [
    'unsafe-motion',
    '<style>@keyframes spin { to { transform: rotate(1turn) } }</style><span style="display: inline-block; width: 16px; height: 16px; animation: spin 800ms linear infinite; border: 2px solid #333">.</span><p>Loading</p>',
  ],
  [
    'print-contrast',
    '<style>@media print { .total { color: #c7c7c7 } }</style><h1>Invoice 1042</h1><p class="total">Total due $1,240.00</p>',
    { width: 1280, height: 900, record: true },
  ],
  [
    'layout-shift',
    `<div id="late"></div><p style="height: 600px; background: #eef">The work, drawn first.</p>
     <script>setTimeout(() => { document.getElementById('late').style.height = '300px'; }, 150);</script>`,
  ],
  ['page-error', '<p>Drawn.</p><script>setTimeout(() => { throw new Error("boom"); }, 0);</script>'],
  ['failed-request', '<p>Drawn.</p><script>fetch("/missing");</script>'],
  ['empty-section', '<p>Orders</p><section><h2>Visits</h2></section>'],
  [
    'mixed-format',
    '<table><thead><tr><th>Line</th><th>Total</th></tr></thead><tbody><tr><td>Labor</td><td>$24</td></tr><tr><td>Parts</td><td>$0.00</td></tr></tbody></table>',
  ],
  [
    'round-ticks',
    `<section><h2>Revenue</h2><svg width="300" height="120" role="img" aria-label="Revenue">
       <text class="chart-y-tick" x="0" y="110">$0</text><text class="chart-y-tick" x="0" y="60">$2,039.50</text>
       <text class="chart-y-tick" x="0" y="10">$4,079</text></svg></section>`,
  ],
  [
    'header-wrap',
    '<h1 style="font-size: 32px; line-height: 1.2">Electra Loft 7D for Rafael Rossi, rear brake rub and a squeaking chain</h1><p>A work order.</p>',
    { width: 390, height: 844, record: true },
  ],
];

/* A phone record's verbs are a bar pinned at the foot of the window, and the page scrolls under it (page.css): a
   control beneath the bar in one frame is not drawn over it while the page leaves room to scroll it clear (the
   body's clearance under its last section, style.css). A theme's larger type or roomier spacing only puts more of
   the page under the bar in the first frame; read as an overlap, it was blamed on four themes (TC14). */
const FOOT_BAR = (clearance: number) => `
  <main style="padding: 16px 16px ${clearance}px">
    <h1>Purchase order PO-1042</h1>
    ${Array.from({ length: 14 }, (_, i) => `<p>Line ${i + 1}</p><button style="display: block; width: 100%">Open line ${i + 1}</button>`).join('')}
  </main>
  <div style="position: fixed; inset-inline: 0; bottom: 0; height: 64px; display: flex; gap: 8px; justify-content: flex-end; background: #fff; border-top: 1px solid #ddd">
    <button>Send</button><button aria-label="More actions">More</button>
  </div>`;

test('a control under a bar pinned to the window is no overlap while the page can scroll it clear, and one when it cannot', async ({
  browser,
}) => {
  expect(await graded(browser, FOOT_BAR(132), { width: 390, height: 844 })).not.toContain('overlap');
  expect(await graded(browser, FOOT_BAR(132), { width: 320, height: 640 })).not.toContain('overlap');
  // No room under the last line: it can never come out from under the bar.
  expect(
    await graded(
      browser,
      `<main style="height: 844px; overflow: hidden"><button style="position: absolute; bottom: 10px; right: 20px">Last line</button></main>
       <div style="position: fixed; inset-inline: 0; bottom: 0; height: 64px; background: #fff; display: flex; justify-content: flex-end; gap: 8px">
         <button>Send</button><button aria-label="More actions">More</button></div>`,
      { width: 390, height: 844 },
    ),
  ).toContain('overlap');
});

/* A date field draws its calendar button inside the input's reserved right padding, past where its text can reach
   (DateField.css): that is one control's own room, not two drawn over each other. A button over the text is one. */
const IN_PADDING = (right: string) => `
  <main style="padding: 16px">
    <label>Due <span style="position: relative; display: inline-block">
      <input value="2026-10-13" style="width: 200px; padding: 6px 40px 6px 8px; box-sizing: border-box; font-size: 14px">
      <button aria-label="Open calendar" style="position: absolute; top: 4px; right: ${right}; width: 30px; height: 26px; min-width: 0; min-height: 0; padding: 0">📅</button>
    </span></label>
  </main>`;

test("a control inside a text input's padding, clear of its text, is no overlap; one over the text is", async ({ browser }) => {
  for (const width of [1280, 390, 320]) expect(await graded(browser, IN_PADDING('4px'), { width, height: 800 })).not.toContain('overlap');
  expect(await graded(browser, IN_PADDING('80px'), { width: 1280, height: 800 })).toContain('overlap');
});

/* Under the density zoom a computed length (a padding, a hit area drawn on ::before) and a box's scroll are in layout
   pixels, and a box on the screen is that times the zoom: grade mixed the two, so at the spacious 1.24 a date's button
   in its field's padding read as drawn over its text, and at a zoom under 1 a 44px hit area read as 44 where the
   screen draws 39. Each is measured on the screen now, as the client's one ruler measures (ruler.ts). */
test('the probe reads a padding and a hit area on the screen under the density zoom', async ({ browser }) => {
  for (const zoom of [1.12, 1.24])
    expect(await graded(browser, IN_PADDING('4px'), { width: 1280, height: 800, zoom })).not.toContain('overlap');
  const HIT = `<main style="padding: 40px"><button style="position: relative; width: 30px; height: 30px; min-width: 0; min-height: 0">×</button></main>
    <style>main button::before { content: ''; position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; transform: translate(-50%, -50%) }</style>`;
  expect(await graded(browser, HIT, { width: 390, height: 844 })).not.toContain('small-target');
  expect(await graded(browser, HIT, { width: 390, height: 844, zoom: 0.895 })).toContain('small-target');
});

/* A drawer is fixed over the page and scrolls in itself, its actions sticky at its foot (a New form's sheet): a field
   under the actions in one frame scrolls clear of them while the drawer's body leaves the room, as a page's does under
   a bar pinned to the window. Both are pinned, the actions inside the drawer's layer, which grade took for two bars. */
const SHEET = (clearance: number) => `
  <aside role="dialog" aria-label="New lead" style="position: fixed; inset: 0 0 0 auto; width: 100%; display: flex; flex-direction: column; background: #fff">
    <div style="flex: 1; overflow: auto; padding: 16px 16px ${clearance}px">
      ${Array.from({ length: 12 }, (_, i) => `<label style="display: block; margin-bottom: 16px">Field ${i + 1}<input style="display: block; width: 100%; height: 44px; box-sizing: border-box"></label>`).join('')}
      <div style="position: sticky; bottom: 0; height: 64px; display: flex; gap: 8px; justify-content: flex-end; background: #fff; border-top: 1px solid #ddd">
        <button>Cancel</button><button>Add</button>
      </div>
    </div>
  </aside>`;

test("a field under a drawer's sticky actions is no overlap while the drawer can scroll it clear, and one when it cannot", async ({
  browser,
}) => {
  for (const zoom of [1, 1.12, 1.24]) expect(await graded(browser, SHEET(16), { width: 390, height: 640, zoom })).not.toContain('overlap');
  // The actions over the drawer's last field with no scroll at all: they can never come apart.
  const STUCK = `<aside style="position: fixed; inset: 0; background: #fff"><div style="position: relative; height: 200px; overflow: hidden">
      <input aria-label="Last" style="position: absolute; bottom: 10px; left: 16px; right: 16px; height: 44px">
      <div style="position: sticky; bottom: 0; margin-top: 140px; height: 60px; display: flex; justify-content: flex-end"><button>Add</button></div>
    </div></aside>`;
  expect(await graded(browser, STUCK, { width: 390, height: 640 })).toContain('overlap');
});

/* A donut's slices are each a whole circle drawn as one arc of its stroke: their boxes are one square, and the point
   between them is the hole, where the drawing itself is hit. A field report's grade read every pair of slices as an
   overlap; two shapes that do paint the same pixels still are one. */
const DONUT = `
  <main style="padding: 16px"><svg width="220" height="220" viewBox="0 0 42 42" aria-label="Spend">
    ${[
      [0, 30],
      [30, 35],
      [65, 35],
    ]
      .map(
        ([at, length], i) =>
          `<circle role="button" tabindex="0" aria-label="Slice ${i}" cx="21" cy="21" r="15.9155" fill="none" stroke="#1d4ed8" stroke-width="7"
             stroke-dasharray="${length} 100" stroke-dashoffset="${-at!}"></circle>`,
      )
      .join('')}
  </svg></main>`;
const SHAPES = `
  <main style="padding: 16px"><svg width="220" height="120" viewBox="0 0 220 120">
    <rect role="button" tabindex="0" aria-label="Plan" x="0" y="0" width="120" height="80" fill="#1d4ed8"></rect>
    <rect role="button" tabindex="0" aria-label="Actual" x="60" y="20" width="120" height="80" fill="#b42318"></rect>
  </svg></main>`;

test("a drawing's shapes overlap where they paint the same pixels, not where their boxes meet", async ({ browser }) => {
  for (const width of [1280, 390]) expect(await graded(browser, DONUT, { width, height: 800 })).not.toContain('overlap');
  expect(await graded(browser, SHAPES, { width: 1280, height: 800 })).toContain('overlap');
});

/* The grid's ring under the density zoom (T4). The root's zoom scales a 2px outline to 1.79px, which C3 reads as a ring
   under 2px; style.css divides the width by --density-zoom for the grid. The rules are read from the stylesheets themselves, so
   the fixture cannot drift from what ships. */
test('the grid ring holds 2px under the density zoom, where a plain 2px outline is read as thinner (C3)', async ({ browser }) => {
  /* The tokens are @mistriwork/ui's (tokens.css); the grid's ring is the kit's. */
  const css = ['packages/ui/src/tokens.css', 'packages/kit/src/client/style.css']
    .map((file) => readFileSync(resolve(file), 'utf8'))
    .join('\n');
  const rules = [/--focus-width:[^;]*;/, /--focus-width-true:[^;]*;/, /\.result table:focus-visible \{[^}]*\}/].map(
    (pattern) => pattern.exec(css)?.[0] ?? '',
  );
  expect(rules.every(Boolean)).toBe(true);
  const page = (ring: string) => `
    <style>:root { zoom: 0.895; --density-zoom: 0.895; --focus: #1d4ed8; ${rules[0]} ${rules[1]} }
      ${ring} .result table { border-collapse: collapse } .result td { padding: 12px }</style>
    <main class="result"><table tabindex="0"><tbody><tr><td>Brake bleed</td><td>$1,240.00</td></tr></tbody></table></main>`;
  const ringWidth = async (body: string) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    try {
      await context.route(`${ORIGIN}/**`, (route) =>
        route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head></head><body>${body}</body></html>` }),
      );
      const tab = await context.newPage();
      await tab.goto(`${ORIGIN}/page`);
      return (await focusStops(tab))[0]!.width;
    } finally {
      await context.close();
    }
  };
  expect(await ringWidth(page(rules[2]!))).toBeGreaterThanOrEqual(2);
  // The same outline declared in plain layout pixels is what the zoom thinned.
  expect(await ringWidth(page('.result table:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px }'))).toBeLessThan(2);
});

/* A ring is read on the screen, as grade reads every box. At the comfortable density (a root zoom of 1.12) a 2px outline
   is 2.24 zoomed pixels, drawn as 2 whole ones: 2px on the screen, which the computed style gives back as 1.786 in the
   page's own pixels. Grade read that figure and failed every ring of a theme at that density; a ring the zoom really
   thins (1px on the screen at 0.895) still reads under 2px. */
test('a ring is read in screen pixels under the density zoom: 2px at 1.12, and thinner where the zoom thins it (C3)', async ({
  browser,
}) => {
  const ringWidth = async (zoom: number, outline: string) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    try {
      await context.route(`${ORIGIN}/**`, (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><style>:root { zoom: ${zoom} } input { border: 1px solid #888; outline: none }
            input:focus-visible { outline: ${outline} solid #1d4ed8 }</style></head><body><main><input aria-label="Owner"></main></body></html>`,
        }),
      );
      const tab = await context.newPage();
      await tab.goto(`${ORIGIN}/page`);
      return (await focusStops(tab))[0]!.width;
    } finally {
      await context.close();
    }
  };
  expect(await ringWidth(1.12, '2px')).toBe(2);
  expect(await ringWidth(1.24, '2px')).toBe(2);
  expect(await ringWidth(1, '2px')).toBe(2);
  expect(await ringWidth(0.895, '2px')).toBeLessThan(2);
});

/* A field or a card that wears the ring while its input or button holds focus (a picker's box, a board card) shows the
   reader where they are: the ring is credited to the stop, and a stop whose ancestor draws none still fails. */
test("a ring drawn by the control's own box while it holds focus is the stop's ring (C3)", async ({ browser }) => {
  const stops = async (css: string) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    try {
      await context.route(`${ORIGIN}/**`, (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><style>input { border: 0; outline: none } ${css}</style></head><body><div class="box"><input aria-label="Account"></div></body></html>`,
        }),
      );
      const tab = await context.newPage();
      await tab.goto(`${ORIGIN}/page`);
      return await focusStops(tab);
    } finally {
      await context.close();
    }
  };
  const [held] = await stops('.box:focus-within { outline: 2px solid #1d4ed8; outline-offset: 0 }');
  expect(held!.width).toBe(2);
  expect(held!.ratio).toBeGreaterThanOrEqual(3);
  const [bare] = await stops('.box { border: 1px solid #888 }');
  expect(bare!.width).toBe(0);
});

for (const [code, body, window] of defects) {
  test(`${code}: the probe finds the defect its fixture page is built to have`, async ({ browser }) => {
    expect(await graded(browser, body, window)).toContain(code);
  });
}

test('mistri grade on Tick: every view and a record, each finding a line with its fix, then a score', async () => {
  test.setTimeout(240_000);
  const directory = mkdtempSync(join(tmpdir(), 'mistri-grade-'));
  try {
    const db = join(directory, 'tick.db');
    const seeded = spawnSync(process.execPath, [resolve('examples/databases/tick/seed.mjs'), db], { encoding: 'utf8' });
    expect(seeded.status, seeded.stderr).toBe(0);
    const run = (args: string[]) =>
      new Promise<{ code: number; out: string; err: string }>((done) => {
        execFile(
          process.execPath,
          [
            '--import',
            'tsx',
            resolve('packages/mistri/src/server/index.ts'),
            'grade',
            'examples/apps/tick',
            '--config',
            `${db}.json`,
            ...args,
          ],
          { timeout: 200_000, killSignal: 'SIGKILL', env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'config') } },
          (error, out, err) => done({ code: (error as { code?: number } | null)?.code ?? 0, out, err }),
        );
      });
    const ran = await run(['--json']);
    expect([0, 2], ran.err).toContain(ran.code);
    const report = JSON.parse(ran.out) as {
      app: string;
      ok: boolean;
      score: number;
      pages: number;
      captures: number;
      findings: Array<{ code: string; severity: string; page: string; windows: string[]; file?: string; line?: number; fix: string }>;
      coverage: { pages: Array<{ path: string; kind?: string }>; windows: string[]; skipped: unknown[] };
    };
    expect(report.app).toBe('tick');
    // The list and a task's page (the home is the list, measured once), each in five windows.
    expect(report.pages).toBe(2);
    expect(report.captures).toBe(10);
    // What it covered says so, page by page; Tick has nothing it could not open.
    expect(report.coverage.pages.map((page) => page.kind)).toEqual(['view', 'record']);
    expect(report.coverage.windows).toHaveLength(5);
    expect(report.coverage.skipped).toEqual([]);
    expect(report.ok).toBe(ran.code === 0);
    expect(report.score).toBeGreaterThan(50);
    /* What Tick is clean of: it throws nothing, asks for nothing that fails, never scrolls sideways, cuts no figure,
       stacks no control on another and reads at the contrast rule in light and dark. */
    const clean = ['page-error', 'failed-request', 'sideways-scroll', 'clipped-number', 'overlap', 'low-contrast', 'empty-section'];
    expect(report.findings.filter((finding) => clean.includes(finding.code))).toEqual([]);
    // A view's finding is placed at the line that declares it.
    for (const finding of report.findings.filter((each) => each.page.endsWith('/tasks'))) expect(finding.file).toMatch(/app\.ts$/);
    expect(report.findings.every((finding) => finding.fix.length > 0)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
