import { type ChildProcess } from 'node:child_process';
import { withFreePort } from './support/freePort';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { expect, test as base } from './support/harness';
import { fixture } from './support/fixture';

/*
 * The bar beside the sidebar (`ui.shell.header`, unsaid, so the default; docs/design.md, the shell): no band across
 * the window — the sidebar runs its full height with the mark and New at its head, and the room is a pane beside it
 * whose own bar says where the reader is and holds the search, the bell and the account. Walking between rooms
 * moves none of it; folding leaves the rail with the mark and New still in it; a phone keeps the bar.
 *
 * A server of its own over a fresh database (listen(0), mkdtemp), so the spec runs in the parallel lane.
 */
let origin = '';
let directory = '';
let child: ChildProcess | undefined;

const test = base.extend<object, { started: void }>({
  started: fixture(
    async () => {
      directory = mkdtempSync(join(tmpdir(), 'mistri-sidebar-shell-'));
      const db = join(directory, 'shop.db');
      const source = new DatabaseSync(db);
      try {
        source.exec(`CREATE TABLE supplier (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE part (id INTEGER PRIMARY KEY, name TEXT NOT NULL, supplier_id INTEGER REFERENCES supplier(id));
      INSERT INTO supplier VALUES (1, 'Cascade Cycle Supply'), (2, 'Harbor Bearings');
      INSERT INTO part VALUES (1, 'Chain', 1), (2, 'Hub', 2);`);
      } finally {
        source.close();
      }
      const config = join(directory, 'connections.json');
      writeFileSync(config, JSON.stringify({ connections: [{ name: 'shop', url: db, writable: true }] }));
      const app = join(directory, 'app');
      mkdirSync(join(app, 'node_modules', '@mistriwork'), { recursive: true });
      symlinkSync(join(resolve('.'), 'packages', 'mistri'), join(app, 'node_modules', '@mistriwork', 'mistri'), 'dir');
      writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
      writeFileSync(
        join(app, 'app.ts'),
        `import { defineApp, listView, navGroup } from '@mistriwork/mistri/app';
export default defineApp({
  id: 'shop',
  name: 'Harborside Cycle Works',
  connection: 'shop',
  resources: { supplier: {}, part: { access: 'write' } },
  views: { suppliers: listView('Suppliers', 'supplier'), parts: listView('Parts', 'part') },
  nav: [navGroup('stock', 'Stock', ['suppliers', 'parts'])],
  home: 'suppliers',
  ui: {
    theme: { preset: 'lumen' },
    shell: { new: [{ view: 'parts' }], sidebar: { footer: { title: 'Harborside', description: 'Portland shop' } } },
  },
});
`,
      );
      await withFreePort(async (port) => {
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
    },
    async () => {
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
    },
  ),
});

type Box = { x: number; y: number; width: number; height: number } | null;

/** Where the shell's parts stand, in viewport pixels. */
function shellGeometry(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const found = document.querySelector(selector);
      if (!(found instanceof HTMLElement) || !found.offsetParent) return null;
      const { x, y, width, height } = found.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      inSidebar: Boolean(document.querySelector('.layout > .sidebar > header.topbar')),
      sidebar: box('.layout > .sidebar'),
      content: box('#content'),
      brand: box('.sidebar .brand-mark'),
      name: box('.sidebar .brand-name'),
      paneBar: box('.layout > #pane-bar'),
      search: box('#pane-bar > #search-button'),
      keys: box('#pane-bar > .topbar-actions'),
      newButton: box('.sidebar .new-menu-trigger'),
      identity: box('.sidebar-identity'),
      collapse: box('#pane-bar > .sidebar-collapse'),
      trail: box('#pane-bar > .pane-trail'),
    } as Record<string, Box | boolean>;
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('mistri.tour.v1', 'done');
      localStorage.setItem('mistri.sidebar-hidden', '0');
    } catch {
      /* Storage is optional. */
    }
  });
});

test("the sidebar runs the window's height with the mark and New at its head; the pane's bar holds the trail, the search and the account", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/suppliers`);
  // The first visit compiles the client under tsx (devclient.ts): give it the time a cold start takes.
  await expect(page.getByRole('heading', { level: 1, name: 'Suppliers' })).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('body')).toHaveClass(/\bapp-sidebar-shell\b/);
  // The New menu is a part of its own (NewMenu.tsx), drawn once it has arrived.
  await expect(page.locator('.sidebar .new-menu-trigger')).toBeVisible();
  const at = await shellGeometry(page);
  expect(at.inSidebar).toBe(true);
  const sidebar = at.sidebar as NonNullable<Box>;
  const content = at.content as NonNullable<Box>;
  // No band over either: the sidebar runs the window's height, and the room is a pane beside it, inset from the
  // window's edge on the three sides the menu is not.
  expect(sidebar).toMatchObject({ x: 0, y: 0, width: 240, height: 800 });
  const paneBar = at.paneBar as NonNullable<Box>;
  expect(paneBar).toMatchObject({ x: 240, y: 8, height: 52 });
  expect(content.x).toBe(240);
  expect(content.y).toBe(paneBar.y + paneBar.height);
  expect(content.x + content.width).toBe(1272);
  expect(content.y + content.height).toBe(792);
  // The head: the mark and the name, New beside them as a 28px square, on the pane's bar's line.
  const brand = at.brand as NonNullable<Box>;
  const newButton = at.newButton as NonNullable<Box>;
  expect(newButton).toMatchObject({ width: 28, height: 28 });
  expect(Math.abs(newButton.y + newButton.height / 2 - (brand.y + brand.height / 2))).toBeLessThanOrEqual(2);
  expect(Math.abs(brand.y + brand.height / 2 - (paneBar.y + paneBar.height / 2))).toBeLessThanOrEqual(2);
  // The pane's bar: where the reader is, then the search and the bar's keys at its far end.
  await expect(page.locator('#pane-bar > .pane-trail')).toHaveText(/Suppliers$/);
  const search = at.search as NonNullable<Box>;
  const keys = at.keys as NonNullable<Box>;
  expect(search.height).toBe(32);
  expect(search.x + search.width).toBeLessThanOrEqual(keys.x);
  expect(keys.x + keys.width).toBeLessThanOrEqual(paneBar.x + paneBar.width);
  await expect(page.locator('#pane-bar #search-button')).toContainText('⌘K');
  // The foot is the workspace's identity alone: the menu's toggle is the pane's bar's first key, before the trail.
  const identity = at.identity as NonNullable<Box>;
  const collapse = at.collapse as NonNullable<Box>;
  expect(identity.y + identity.height).toBeLessThanOrEqual(800);
  await expect(page.locator('.sidebar-footer')).toBeHidden();
  expect(collapse).toMatchObject({ width: 32, height: 32 });
  expect(collapse.x).toBeGreaterThanOrEqual(paneBar.x);
  expect(collapse.x + collapse.width).toBeLessThanOrEqual((at.trail as NonNullable<Box>).x);
  // The room's head row is the pane's first line under its bar.
  const head = page.locator('#content .applist-head').first();
  const headBox = (await head.boundingBox())!;
  expect(Math.abs(headBox.y - content.y)).toBeLessThanOrEqual(1);
  expect(headBox.height).toBeGreaterThanOrEqual(52);

  // The search is the palette's door, from the pane's bar, and New opens its menu, from the sidebar.
  await page.locator('#pane-bar #search-button').click();
  await expect(page.getByRole('combobox', { name: 'Search' })).toBeFocused();
  await page.keyboard.press('Escape');
  await page.locator('.sidebar .new-menu-trigger').click();
  await expect(page.getByRole('menuitem', { name: /Part/ })).toBeVisible();
  await page.keyboard.press('Escape');
});

test("recipes.pane: 'edge' runs the room to the window's right and bottom edges, square and unlifted", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/suppliers`);
  await expect(page.getByRole('heading', { level: 1, name: 'Suppliers' })).toBeVisible({ timeout: 45_000 });
  // The theme says nothing, so the server serves the default (recipeAttributes): the inset pane above.
  await expect(page.locator('html')).toHaveAttribute('data-look-pane', 'inset');
  // The recipe is the one attribute the server would serve for `recipes.pane: 'edge'`; the sheet is always loaded.
  await page.evaluate(() => document.documentElement.setAttribute('data-look-pane', 'edge'));
  const at = await shellGeometry(page);
  const sidebar = at.sidebar as NonNullable<Box>;
  const paneBar = at.paneBar as NonNullable<Box>;
  const content = at.content as NonNullable<Box>;
  expect(sidebar).toMatchObject({ x: 0, y: 0, width: 240, height: 800 });
  expect(paneBar).toMatchObject({ x: 240, y: 0, width: 1040, height: 52 });
  expect(content.x).toBe(240);
  expect(content.y).toBe(paneBar.y + paneBar.height);
  expect(content.x + content.width).toBe(1280);
  expect(content.y + content.height).toBe(800);
  // One hairline between the menu and the room, none on the window's edges, no corners, and no lift (Lumen's
  // raised buttons lift the inset pane, lumenLook.css).
  const drawn = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector('#content')!);
    return {
      left: style.borderLeftWidth,
      right: style.borderRightWidth,
      bottom: style.borderBottomWidth,
      radius: style.borderBottomRightRadius,
      shadow: style.boxShadow,
    };
  });
  expect(drawn).toEqual({ left: '1px', right: '0px', bottom: '0px', radius: '0px', shadow: 'none' });
});

test('walking between rooms moves nothing in the sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/suppliers`);
  await expect(page.getByRole('heading', { level: 1, name: 'Suppliers' })).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('.sidebar .new-menu-trigger')).toBeVisible();
  const before = await shellGeometry(page);
  await page.evaluate(() => {
    const w = window as unknown as { shifts_: string[] };
    w.shifts_ = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { sources?: Array<{ node?: Node }> }>) {
        for (const source of entry.sources ?? []) {
          const node = source.node instanceof Element ? source.node : source.node?.parentElement;
          if (node?.closest('.sidebar')) w.shifts_.push(node.className.toString() || node.tagName);
        }
      }
    }).observe({ type: 'layout-shift' });
  });
  for (const room of ['Parts', 'Suppliers', 'Parts']) {
    await page.locator('#table-list').getByRole('button', { name: room }).click();
    await expect(page.getByRole('heading', { level: 1, name: room })).toBeVisible();
    await expect(page.locator('#table-list button[aria-current="true"]')).toHaveText(new RegExp(room));
  }
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Suppliers' })).toBeVisible();
  expect(await shellGeometry(page)).toEqual(before);
  expect(await page.evaluate(() => (window as unknown as { shifts_: string[] }).shifts_)).toEqual([]);
});

test("folded, the sidebar is a rail that keeps the mark and New, and the pane's bar keeps the search; a phone keeps the bar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/suppliers`);
  await expect(page.getByRole('heading', { level: 1, name: 'Suppliers' })).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('.sidebar .new-menu-trigger')).toBeVisible();
  await page.locator('#pane-bar > .sidebar-collapse').click();
  await expect(page.locator('body')).toHaveClass(/\bsidebar-hidden\b/);
  const folded = await shellGeometry(page);
  expect((folded.sidebar as NonNullable<Box>).width).toBe(56);
  expect(folded.name).toBeNull();
  for (const part of ['brand', 'newButton'] as const) {
    const box = folded[part] as NonNullable<Box>;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(56);
  }
  await page.locator('#pane-bar #search-button').click();
  await expect(page.getByRole('combobox', { name: 'Search' })).toBeFocused();
  await page.keyboard.press('Escape');
  await page.locator('#pane-bar > .sidebar-collapse').click();
  await expect(page.locator('body')).not.toHaveClass(/\bsidebar-hidden\b/);
  expect(((await shellGeometry(page)).sidebar as NonNullable<Box>).width).toBe(240);

  // A phone: the drawer and the bar across its top, as every App has there.
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.locator('body')).not.toHaveClass(/\bapp-sidebar-shell\b/);
  await expect(page.locator('body > header.topbar')).toBeVisible();
  await expect(page.locator('header.topbar #search-button')).toBeVisible();
  // And back at a desk, the sidebar holds it again.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('.layout > .sidebar > header.topbar')).toBeVisible();
  expect((await shellGeometry(page)).paneBar).not.toBeNull();
});

test('docked, the controls are named by what they show (WCAG 2.5.3, label in name)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/suppliers`);
  await expect(page.getByRole('heading', { level: 1, name: 'Suppliers' })).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('#pane-bar').getByRole('button', { name: 'Search ⌘K', exact: true })).toBeVisible();
  // The toggle shows a mark and no word in the pane's bar, so its name is its own to say.
  const collapse = page.locator('#pane-bar').getByRole('button', { name: 'Collapse menu', exact: true });
  await expect(collapse).toHaveText('');
  // axe-core ships the rule off (experimental); here it is on, over the sidebar, open and folded.
  const audit = async () =>
    (
      await new AxeBuilder({ page })
        .include('.sidebar')
        .include('#pane-bar')
        .options({ rules: { 'label-content-name-mismatch': { enabled: true } } })
        .withRules(['label-content-name-mismatch'])
        .analyze()
    ).violations.flatMap((violation) => violation.nodes.map((node) => node.html.slice(0, 120)));
  expect(await audit()).toEqual([]);
  await collapse.click();
  await expect(page.locator('body')).toHaveClass(/\bsidebar-hidden\b/);
  await expect(page.locator('#pane-bar').getByRole('button', { name: 'Expand menu', exact: true })).toBeVisible();
  expect(await audit()).toEqual([]);
});
