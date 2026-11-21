/**
 * What a free-form page draws around itself, in a browser (test/fixtures/apps/layers): a layer (Drawer, Modal, Popover)
 * has its backdrop, its close control and the page's own stylesheet inside it, and paints above a page child that
 * sets a z-index; a bare page's root is the window; a page with no head starts at the top of the content pane; a
 * plain link wears the look's link color. It starts its own server over a disposable database (support/layersServer.ts).
 */
import { settled } from '@mistriwork/mistri/testing';
import { inPage, probePage, type Probe } from '../packages/mistri/src/server/build/gradeProbe';
import { TAP } from '../packages/mistri/src/server/build/gradeJudge';
import { LONG_MS } from './support/budgets';
import { expect, test } from './support/harness';
import { startLayersApp } from './support/layersServer';

type Fixture = Awaited<ReturnType<typeof startLayersApp>>;

test.describe('A free-form page and what it draws around itself', () => {
  test.setTimeout(LONG_MS);
  let app: Fixture;
  test.beforeAll(async () => {
    app = await startLayersApp();
  });
  test.afterAll(async () => {
    await app?.stop();
  });

  for (const layer of ['drawer', 'modal', 'popover'] as const) {
    test(`a ${layer} is over the page: its scrim, the page's classes inside it, above a z-index of 9`, async ({ page }) => {
      await page.goto(`${app.origin}/kit?show=${layer}`);
      await settled(page);
      const facts = page.locator('.c-page-kit-facts');
      await expect(facts).toBeVisible();
      // The page's own stylesheet reaches the markup the kit draws in a portal.
      await expect(facts).toHaveCSS('display', 'grid');
      // A layer's box, not a rectangle in the flow.
      const box =
        layer === 'drawer'
          ? page.locator('[data-slot="drawer-content"]')
          : layer === 'modal'
            ? page.locator('[data-slot="dialog-content"]')
            : page.locator('[data-slot="popover-content"]');
      await expect(box).toBeVisible();
      const centre = await box.boundingBox();
      const hit = await page.evaluate(
        ([x, y]) => {
          const found = document.elementFromPoint(x, y);
          return found?.closest('[data-slot="drawer-content"], [data-slot="dialog-content"], [data-slot="popover-content"]') !== null;
        },
        [centre!.x + centre!.width / 2, centre!.y + 12],
      );
      expect(hit, 'the page child at z-index 9 does not paint over the layer').toBe(true);
      if (layer !== 'popover') {
        const scrim = page.locator(
          layer === 'drawer' ? '[data-slot="drawer-backdrop"]' : '[data-slot="dialog-backdrop"][data-kind="modal"]',
        );
        await expect(scrim).toBeVisible();
        const covers = await scrim.boundingBox();
        const viewport = page.viewportSize()!;
        expect([covers!.width, covers!.height], 'the scrim covers the window').toEqual([viewport.width, viewport.height]);
      }
      if (layer === 'drawer') {
        await expect(page.getByRole('button', { name: /close/i })).toBeVisible();
        await expect(box).toHaveCSS('border-left-width', /^[1-9]/);
      }
    });
  }

  test('a page tab on a record joins its related lists in one strip, with no word about listTabs', async ({ page }) => {
    await page.goto(`${app.origin}/things/1`);
    await settled(page);
    const strip = page.getByRole('tablist').filter({ has: page.getByRole('tab', { name: 'Chart' }) });
    await expect(strip.getByRole('tab')).toHaveText([/Parts/, /Notes/, /Chart/]);
  });

  /* A field report: on a record page whose related lists are tabs (`listTabs: true`), a tab whose list is empty drew its
     empty state over the strip. At a desk a list's Add stands on the strip's own line, pulled up by a fixed amount that
     drags the list after it up too; where the Add is shorter than that pull nothing held the list below the strip. A
     layout is not a thing a component test can see, so it is measured: a list's first thing starts at or below the
     strip's foot, with the look's own Add and with one as short as a look may make it. */
  test.describe('related lists as tabs, writable', () => {
    let own: Fixture;
    test.beforeAll(async () => {
      own = await startLayersApp('listtabs', { writable: true });
    });
    test.afterAll(async () => {
      await own?.stop();
    });
    for (const [record, what] of [
      [2, 'an empty list'],
      [1, 'a list with rows'],
    ] as const)
      for (const short of [false, true])
        test(`a tab with ${what} draws it under the strip, never over it${short ? ', beside a short Add' : ''}`, async ({ page }) => {
          await page.setViewportSize({ width: 1280, height: 900 });
          await page.goto(`${own.origin}/things/${record}`);
          await settled(page);
          // A look's Add may be shorter than the pull the strip's line makes room for (the raised buttons are).
          if (short)
            await page.addStyleTag({
              content:
                '.page-related-create button { min-height: 16px !important; padding-block: 0 !important; line-height: 1 !important; } .page-related-create { padding-block: 0 !important; }',
            });
          await page.getByRole('tab', { name: /Parts/ }).click();
          const open = page.locator('.page-tabpanel:not([hidden])');
          await expect(open.locator('.page-section-bar')).toBeVisible();
          const strip = (await page
            .locator('.page-tabstrip')
            .filter({ has: page.getByRole('tab', { name: /Parts/ }) })
            .boundingBox())!;
          // What the open panel draws under the bar of verbs: the table, or the empty note that stands for it.
          const drawn = await open
            .locator('.page-list-body > *')
            .evaluateAll((nodes) => nodes.map((node) => ({ cls: (node as HTMLElement).className, top: node.getBoundingClientRect().top })));
          expect(drawn.length, 'the panel draws something to measure').toBeGreaterThan(0);
          for (const box of drawn)
            expect(box.top, `${box.cls} starts at or below the strip's foot`).toBeGreaterThanOrEqual(strip.y + strip.height - 1);
        });
  });

  /* The same report's other two readings: a read-only list has no Add bar to pull up into the strip, and a phone pulls
     nothing (the pull is a desk rule), so an empty list's note has only the strip's own spacing to keep it below. */
  test.describe('related lists as tabs, read-only', () => {
    let own: Fixture;
    test.beforeAll(async () => {
      own = await startLayersApp('listtabs');
    });
    test.afterAll(async () => {
      await own?.stop();
    });
    for (const [width, height, where] of [
      [1280, 900, 'at a desk'],
      [390, 844, 'on a phone'],
    ] as const)
      test(`an empty list with no Add bar draws its note under the strip ${where}`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await page.goto(`${own.origin}/things/2`);
        await settled(page);
        await page.getByRole('tab', { name: /Parts/ }).click();
        const open = page.locator('.page-tabpanel:not([hidden])');
        await expect(open.locator('.page-related-create')).toHaveCount(0);
        const strip = (await page
          .locator('.page-tabstrip')
          .filter({ has: page.getByRole('tab', { name: /Parts/ }) })
          .boundingBox())!;
        const drawn = await open
          .locator('.page-list-body > *')
          .evaluateAll((nodes) => nodes.map((node) => ({ cls: (node as HTMLElement).className, top: node.getBoundingClientRect().top })));
        expect(drawn.length, 'the panel draws something to measure').toBeGreaterThan(0);
        for (const box of drawn)
          expect(box.top, `${box.cls} starts at or below the strip's foot`).toBeGreaterThanOrEqual(strip.y + strip.height - 1);
      });
  });

  test('a bare page’s root is the window', async ({ page }) => {
    await page.goto(`${app.origin}/wall`);
    await settled(page);
    const viewport = page.viewportSize()!;
    const root = await page.locator('.c-page-wall').boundingBox();
    expect(root).toMatchObject({ x: 0, y: 0, width: viewport.width });
    expect(root!.height).toBeGreaterThanOrEqual(viewport.height);
    // A look's phone gutter stood a 4px inset round it (visualThemes.css); a bare page keeps no gutter there either.
    await page.setViewportSize({ width: 390, height: 844 });
    await settled(page);
    expect(await page.locator('.c-page-wall').boundingBox()).toMatchObject({ x: 0, y: 0, width: 390 });
  });

  /* A field report: a param set with `push` made a second step of the walk, and the shell's sticky bar came over the bare page. */
  test('a bare page draws no trail bar after a pushed param, and its own button takes the click', async ({ page }) => {
    await page.goto(`${app.origin}/wall`);
    await settled(page);
    await page.getByRole('button', { name: 'Lay a brick' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('brick')).toBe('red');
    await expect(page.getByRole('button', { name: 'Brick red' })).toBeVisible();
    await expect(page.locator('.crumbs-host, .crumbs')).toHaveCount(0);
    await page.getByRole('button', { name: 'Brick red' }).click();
  });

  test('a page with no head starts at the top of the content pane', async ({ page }) => {
    await page.goto(`${app.origin}/hero`);
    await settled(page);
    const pane = await page.locator('#content').boundingBox();
    // The pane's own edge: beside a side menu the room is a pane with a rule over it, and its content starts under the rule.
    const rule = await page.locator('#content').evaluate((node) => node.clientTop);
    const first = await page.locator('.c-page-hero').boundingBox();
    expect(first!.y).toBeCloseTo(pane!.y + rule, 0);
  });

  /* A field report: openPage loaded the App again, so a marker on the window was lost and the context ran once more. */
  test('openPage moves to another page in place: the document, and a marker on its window, are kept', async ({ page }) => {
    const logged: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') logged.push(message.text());
    });
    page.on('pageerror', (error) => logged.push(error.message));
    await page.goto(`${app.origin}/hero`);
    await settled(page);
    await page.evaluate(() => {
      (window as unknown as { marker: string }).marker = 'kept';
    });
    await page.getByRole('button', { name: 'Open the wall' }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/wall');
    await settled(page);
    expect(await page.evaluate(() => (window as unknown as { marker?: string }).marker)).toBe('kept');
    // The report also had the console naming a chunk that was not there: the page's own part loads, or nothing is said.
    expect(logged.filter((text) => /chunk|dynamically imported|Failed to fetch/i.test(text))).toEqual([]);
  });

  test('a plain link in a page takes the look’s link color', async ({ page }) => {
    await page.goto(`${app.origin}/kit`);
    await settled(page);
    const link = page.locator('a.c-page-kit-link');
    const [color, token] = await link.evaluate((node) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--link)';
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return [getComputedStyle(node).color, resolved];
    });
    expect(color).toBe(token);
  });

  test('two fields in a Stack are a field apart, not a field and a reserved line', async ({ page }) => {
    await page.goto(`${app.origin}/kit`);
    await settled(page);
    const name = await page.getByLabel('Name').boundingBox();
    const kind = await page
      .locator('[data-slot="field"]')
      .filter({ has: page.locator('[data-slot="select-trigger"]') })
      .boundingBox();
    expect(kind!.y - (name!.y + name!.height)).toBeLessThan(32);
  });

  test('pagination in a narrow card is one row: the steps and the current page', async ({ page }) => {
    await page.goto(`${app.origin}/kit`);
    await settled(page);
    const nav = page.getByRole('navigation', { name: 'Narrow pages' });
    const rows = await nav
      .locator('button:visible')
      .evaluateAll((nodes) => new Set(nodes.map((node) => Math.round(node.getBoundingClientRect().top))).size);
    expect(rows).toBe(1);
    await expect(nav.getByRole('button', { name: '5' })).toHaveAttribute('aria-current', 'page');
  });

  test('a card holds a stat as a figure, not a box in a box', async ({ page }) => {
    await page.goto(`${app.origin}/kit`);
    await settled(page);
    await expect(page.locator('.kit-card .kit-stat')).toHaveCSS('border-top-width', '0px');
  });

  test("the kit's own controls pass grade's tap-target rule at a phone's width", async ({ browser }) => {
    // A phone's window as grade opens it (shot.ts): narrow, and a finger for a pointer.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' });
    try {
      await context.addInitScript(() => localStorage.setItem('mistri.tour.v1', 'done'));
      const page = await context.newPage();
      await page.goto(`${app.origin}/kit`);
      await settled(page);
      const probe = (await page.evaluate(inPage(probePage, { tap: TAP, record: false }))) as Probe;
      expect(probe.small, "every control the page draws, the kit's own among them").toEqual([]);
    } finally {
      await context.close();
    }
  });
});
