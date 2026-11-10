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
        layer === 'drawer' ? page.locator('.ui-drawer') : layer === 'modal' ? page.locator('.modal') : page.locator('.ui-popover');
      await expect(box).toBeVisible();
      const centre = await box.boundingBox();
      const hit = await page.evaluate(
        ([x, y]) => {
          const found = document.elementFromPoint(x, y);
          return found?.closest('.ui-drawer, .modal, .ui-popover') !== null;
        },
        [centre!.x + centre!.width / 2, centre!.y + 12],
      );
      expect(hit, 'the page child at z-index 9 does not paint over the layer').toBe(true);
      if (layer !== 'popover') {
        const scrim = page.locator(layer === 'drawer' ? '.ui-drawer-backdrop' : '.modal-backdrop');
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

  test('a bare page’s root is the window', async ({ page }) => {
    await page.goto(`${app.origin}/wall`);
    await settled(page);
    const viewport = page.viewportSize()!;
    const root = await page.locator('.c-page-wall').boundingBox();
    expect(root).toMatchObject({ x: 0, y: 0, width: viewport.width });
    expect(root!.height).toBeGreaterThanOrEqual(viewport.height);
  });

  test('a page with no head starts at the top of the content pane', async ({ page }) => {
    await page.goto(`${app.origin}/hero`);
    await settled(page);
    const pane = await page.locator('#content').boundingBox();
    const first = await page.locator('.c-page-hero').boundingBox();
    expect(first!.y).toBeCloseTo(pane!.y, 0);
  });

  /* A field report: openPage loaded the App again, so a marker on the window was lost and the context ran once more. */
  test('openPage moves to another page in place: the document, and a marker on its window, are kept', async ({ page }) => {
    await page.goto(`${app.origin}/hero`);
    await settled(page);
    await page.evaluate(() => {
      (window as unknown as { marker: string }).marker = 'kept';
    });
    await page.getByRole('button', { name: 'Open the wall' }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/wall');
    await settled(page);
    expect(await page.evaluate(() => (window as unknown as { marker?: string }).marker)).toBe('kept');
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
      .locator('.form-field')
      .filter({ has: page.locator('.field-select') })
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
