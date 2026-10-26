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

/**
 * TC10: a workflow strip's step says its whole label in every theme. A label
 * of some length ("Waiting on the supplier") was one line: on a phone, where
 * the strip scrolls sideways, it ran past the window's edge and its fade, and
 * read "Waiting on th…". A label now takes up to two lines under its segment,
 * in the track and in the pills, at 1280, 390 and 320 wide.
 *
 * A server of its own over a fresh database (listen(0), mkdtemp).
 */
const origins: Record<string, string> = {};
let directory = '';
const children: ChildProcess[] = [];

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-workflow-labels-'));
  const db = join(directory, 'shop.db');
  const source = new DatabaseSync(db);
  try {
    source.exec(`CREATE TABLE purchase_order (id INTEGER PRIMARY KEY, name TEXT NOT NULL, supplier TEXT NOT NULL, status TEXT NOT NULL, total REAL NOT NULL);
      INSERT INTO purchase_order VALUES (1, 'PO-1042', 'Cascade Cycle Supply', 'waiting_on_the_supplier', 4812.5);`);
  } finally {
    source.close();
  }
  const config = join(directory, 'connections.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'shop', url: db, writable: true }] }));
  /* Two Apps over the one database: the track (the default look's markers) and the pills (Lumen's). */
  for (const [name, recipe] of [
    ['track', 'markers'],
    ['pills', 'pills'],
  ] as const) {
    const app = join(directory, name);
    mkdirSync(join(app, 'node_modules'), { recursive: true });
    mkdirSync(join(app, 'node_modules', '@mistriwork'), { recursive: true });
    symlinkSync(join(resolve('.'), 'packages', 'mistri'), join(app, 'node_modules', '@mistriwork', 'mistri'), 'dir');
    writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
    writeFileSync(
      join(app, 'app.ts'),
      `import { defineApp, defineTheme, fields, listView, machine, page } from '@mistriwork/mistri/app';
const look = defineTheme({ id: 'look', label: 'Look', extends: 'lumen', recipes: { workflow: '${recipe}' } });
export default defineApp({
  id: '${name}',
  name: 'Orders',
  connection: 'shop',
  resources: {
    purchase_order: {
      access: 'write',
      // Steps of some length, as a buyer says them: the strip draws the machine's forward path.
      machine: machine('status', {
        draft: { on: { send: { to: 'waiting_on_the_supplier', label: 'Send' } } },
        waiting_on_the_supplier: { on: { confirm: { to: 'confirmed_by_the_supplier', label: 'Confirm' } } },
        confirmed_by_the_supplier: { on: { receive: { to: 'partially_received_at_the_dock', label: 'Receive' } } },
        partially_received_at_the_dock: { on: { finish: { to: 'received_and_put_away', label: 'Finish' } } },
        received_and_put_away: { final: true },
      }),
    },
  },
  views: { orders: listView('Purchase orders', 'purchase_order') },
  pages: { 'purchase-order': page('purchase_order', [fields(['supplier', 'status', 'total'])]) },
  home: 'orders',
  ui: { customThemes: [look], theme: { preset: 'look' } },
});
`,
    );
    origins[name] = await serve(config, app);
  }
});

/** One tablewalk serving `app` on a free port; its origin. */
async function serve(config: string, app: string): Promise<string> {
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  const started = spawn(
    process.execPath,
    ['--import', 'tsx', 'packages/mistri/src/server/index.ts', '--config', config, '--app', app, '--port', String(port)],
    {
      cwd: resolve('.'),
      env: { ...process.env, DATABASE_URL: '', XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(started);
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
  return `http://127.0.0.1:${port}`;
}

test.afterAll(async () => {
  for (const child of children)
    if (child.exitCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(force);
      }
    }
  rmSync(directory, { recursive: true, force: true });
});

/** Each step's label as drawn: its words, the lines it takes, and whether its box cuts it or the window does. */
async function steps(page: Page) {
  return page.locator('.workflow-steps li').evaluateAll((items) =>
    items.map((li) => {
      const text = [...li.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join('')
        .trim();
      const range = document.createRange();
      const words = [...li.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())!;
      range.selectNodeContents(words);
      const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
      const box = li.getBoundingClientRect();
      const label = range.getBoundingClientRect();
      return { text, lines, cut: li.scrollWidth > li.clientWidth + 1, left: label.left, right: label.right, width: box.width };
    }),
  );
}

for (const look of ['track', 'pills'])
  for (const width of [1280, 390, 320]) {
    test(`a workflow step says its whole label in the ${look}, on two lines at most, at ${width}`, async ({ page }) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${origins[look]}/orders/1`);
      // The first visit compiles the client under tsx (devclient.ts): give it the time a cold start takes.
      await expect(page.locator('.workflow-steps [aria-current="step"]')).toContainText('Waiting on the supplier', { timeout: 30_000 });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));

      const drawn = await steps(page);
      expect(drawn.map((step) => step.text)).toEqual([
        'Draft',
        'Waiting on the supplier',
        'Confirmed by the supplier',
        'Partially received at the dock',
        'Received and put away',
      ]);
      for (const step of drawn) {
        expect(step.cut, `${step.text} is cut by its step`).toBe(false);
        expect(step.lines, `${step.text} takes ${step.lines} lines`).toBeLessThanOrEqual(2);
      }
      if (width < 600) {
        // On a phone the strip still scrolls sideways, but the longest label wraps under its segment rather than
        // running on one line past the window and its fade, and the current step stands whole in the window.
        expect(drawn[3]!.lines, 'Partially received at the dock').toBe(2);
        const current = drawn[1]!;
        expect(current.left).toBeGreaterThanOrEqual(0);
        expect(current.right).toBeLessThanOrEqual(width);
      }
    });
  }
