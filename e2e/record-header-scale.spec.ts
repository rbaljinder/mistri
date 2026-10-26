import { type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import { expect, test } from './support/harness';
import { inPage, probePage, type Probe } from '../packages/mistri/src/server/build/gradeProbe';

/**
 * TC14: the shared record header under the largest type scale and the most
 * spacious density a theme may pick, at 1280, 390 and 320 wide. Its pieces —
 * the eyebrow, the name, the star, the facts, the verbs — never share pixels;
 * the verbs wrap rather than run off the window; and on a phone, where the
 * verbs are a bar pinned at the window's foot and the page scrolls under it,
 * every control of the page can be scrolled clear of the bar. Grade's own
 * probe reads the page as having no overlap (it read the page scrolling under
 * the bar as one, in four themes).
 *
 * A server of its own over a fresh database (listen(0), mkdtemp).
 */
let origin = '';
let directory = '';
let child: ChildProcess | undefined;

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-record-header-scale-'));
  const db = join(directory, 'shop.db');
  const source = new DatabaseSync(db);
  try {
    source.exec(`CREATE TABLE purchase_order (id INTEGER PRIMARY KEY, name TEXT NOT NULL, supplier TEXT NOT NULL, status TEXT NOT NULL, total REAL NOT NULL);
      CREATE TABLE po_line (id INTEGER PRIMARY KEY, purchase_order_id INTEGER NOT NULL REFERENCES purchase_order(id), item TEXT NOT NULL, qty INTEGER NOT NULL);
      INSERT INTO purchase_order VALUES (1, 'PO-1042 Shimano drivetrain restock for the spring service season', 'Cascade Cycle Supply of Portland', 'Waiting on the supplier', 4812.5);`);
    const line = source.prepare('INSERT INTO po_line VALUES (?, 1, ?, ?)');
    for (let i = 1; i <= 14; i++) line.run(i, `Deore M6100 12-speed chain, 126 links, quick link (${i})`, i * 2);
  } finally {
    source.close();
  }
  const config = join(directory, 'connections.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'shop', url: db, writable: true }] }));
  const app = join(directory, 'app');
  mkdirSync(join(app, 'node_modules'), { recursive: true });
  mkdirSync(join(app, 'node_modules', '@mistriwork'), { recursive: true });
  symlinkSync(join(resolve('.'), 'packages', 'mistri'), join(app, 'node_modules', '@mistriwork', 'mistri'), 'dir');
  writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(app, 'app.ts'),
    `import { action, defineApp, defineTheme, fields, listView, page, related } from '@mistriwork/mistri/app';
/* The largest type and the roomiest spacing the menu has. */
const large = defineTheme({ id: 'large', label: 'Large', extends: 'lumen', type: { base: '16px', roles: { title: { size: '36px', weight: 700 } } }, density: 'spacious' });
export default defineApp({
  id: 'shop',
  name: 'Shop',
  connection: 'shop',
  resources: {
    // Four verbs with words of some length, Edit and Delete: more than a phone's bar holds.
    purchase_order: {
      access: 'write',
      delete: true,
      actions: {
        approve: action('Approve for purchasing', { set: { status: 'Approved' } }),
        send: action('Send to supplier', { set: { status: 'Sent' } }),
        receive: action('Receive everything', { set: { status: 'Received' } }),
        hold: action('Put on hold', { set: { status: 'On hold' } }),
      },
    },
    po_line: { access: 'write' },
  },
  views: { orders: listView('Purchase orders', 'purchase_order') },
  pages: {
    'purchase-order': page('purchase_order', [
      fields(['supplier', 'total'], { presentation: 'facts' }),
      fields(['status', 'supplier', 'total']),
      related('Lines', 'po_line', 'purchase_order_id', { show: ['item', 'qty'], create: { label: 'Add line', show: ['item', 'qty'] } }),
    ]),
  },
  home: 'orders',
  ui: { customThemes: [large], theme: { preset: 'large' } },
});
`,
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
  rmSync(directory, { recursive: true, force: true });
});

/** The header's drawn pieces, each a box: none may share pixels with another, nor leave the window sideways. */
async function headerPieces(page: Page) {
  return page.evaluate(() => {
    /* At a desk the verbs stand in the trail's tools beside the crumbs; on a phone in the head, pinned at the foot. */
    const pieces = [
      ...document.querySelectorAll(
        [
          '.page-head.has-record :is(.page-title, .root-current, .fav-star, .page-head-status, .page-fact)',
          '.page-head.has-record > .page-head-actions > *',
          '.crumbs > :is(button, a, span)',
          '.crumb-tools button',
        ].join(', '),
      ),
    ].filter((el) => el.checkVisibility() && !el.closest('.visually-hidden, [aria-hidden="true"]'));
    return pieces.map((el) => {
      const box = el.getBoundingClientRect();
      return {
        what: `${el.className || el.tagName} "${(el.textContent ?? '').trim().slice(0, 24)}"`,
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
      };
    });
  });
}

for (const width of [1280, 390, 320]) {
  test(`a record header under the largest type and the roomiest spacing keeps its pieces apart at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 700 });
    await page.goto(`${origin}/orders/1`);
    // The first visit compiles the client under tsx (devclient.ts): give it the time a cold start takes.
    test.setTimeout(60_000);
    await expect(page.getByRole('button', { name: 'More actions' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Lines' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // The theme is worn: spacious is the root's zoom (density.js).
    expect(Number(await page.evaluate(() => getComputedStyle(document.documentElement).zoom))).toBeGreaterThan(1);

    const boxes = await headerPieces(page);
    expect(boxes.length).toBeGreaterThan(2);
    for (const box of boxes) {
      expect(box.left, box.what).toBeGreaterThanOrEqual(-0.5);
      expect(box.right, box.what).toBeLessThanOrEqual(width + 0.5);
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!,
          b = boxes[j]!;
        const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        expect(across > 1 && down > 1, `${a.what} and ${b.what} share pixels`).toBe(false);
      }

    // Grade's own reading of the page: no two controls drawn over each other, the page scrolled under a pinned bar included.
    const probe = (await page.evaluate(inPage(probePage, { tap: width <= 760 ? 40 : 0, record: true }))) as Probe;
    expect(probe.overlaps).toEqual([]);
    expect(probe.sideways).toBe(0);

    if (width < 600) {
      // Scrolled to its end, the page's last control stands clear of the verbs' bar at the window's foot.
      const bar = page.locator('.page-head.has-record > .page-head-actions');
      const last = await page.evaluate(() => {
        const controls = [...document.querySelectorAll('.page-body :is(a[href], button)')].filter((el) => el.checkVisibility());
        const lowest = controls.at(-1)!;
        // The App's content scrolls in a box of its own, not the document: every box that scrolls it, to its end.
        for (let e = lowest.parentElement; e; e = e.parentElement) if (e.scrollHeight > e.clientHeight) e.scrollTop = e.scrollHeight;
        return Math.max(...controls.map((el) => el.getBoundingClientRect().bottom));
      });
      const barTop = (await bar.boundingBox())!.y;
      expect(last).toBeLessThanOrEqual(barTop + 0.5);
    }
  });
}

test('the theme’s type is worn before the page is shown, so nothing on it moves when the type arrives', async ({ page }) => {
  test.setTimeout(60_000);
  // At the moment boot reveals the page, the root already carries the base size and the roles' words (CLS 0).
  await page.addInitScript(() => {
    new MutationObserver((_, observer) => {
      const root = document.documentElement;
      if (!root || root.hasAttribute('data-starting')) return;
      observer.disconnect();
      (window as unknown as { revealed: unknown }).revealed = {
        k: getComputedStyle(root).getPropertyValue('--type-k').trim(),
        title: root.getAttribute('data-type-title'),
      };
      // The root does not exist yet when this runs: watch the document for it, and for its attribute.
    }).observe(document, { attributes: true, attributeFilter: ['data-starting'], subtree: true });
  });
  await page.goto(`${origin}/orders/1`);
  await expect(page.getByRole('button', { name: 'More actions' })).toBeVisible({ timeout: 30_000 });
  const revealed = (await page.evaluate(() => (window as unknown as { revealed: unknown }).revealed)) as {
    k: string;
    title: string | null;
  };
  expect(revealed.k).toBe('calc(16 / 13)');
  expect(revealed.title).toContain('size');
  const shifts = await page.evaluate(
    () =>
      new Promise<number>((done) => {
        let total = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
            if (!entry.hadRecentInput) total += entry.value;
        }).observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => done(total), 500);
      }),
  );
  expect(shifts).toBeLessThan(0.1);
});
