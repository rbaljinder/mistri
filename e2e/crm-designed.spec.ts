/**
 * The designed Compass pages (test/fixtures/apps/crm-designed: the leads list, a lead and the sales dashboard, drawn on
 * the kit's parts), each in the fixture's own custom theme (Quarry) and in Workshop, at a desk and at a phone. A page
 * that throws fails the test (support/harness.ts); one that scrolls sideways is named here. It starts its own server over
 * a disposable database (support/layersServer.ts), so it runs beside the other specs.
 */
import { LONG_MS } from './support/budgets';
import { expect, test } from './support/harness';
import { startLayersApp } from './support/layersServer';

type Fixture = Awaited<ReturnType<typeof startLayersApp>>;

const LOOKS = [
  { name: 'Quarry', custom: 'quarry' },
  { name: 'Workshop', look: 'workshop' },
] as const;
const WIDTHS = [
  { name: 'desk', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;

test.describe('The designed Compass pages', () => {
  test.setTimeout(LONG_MS * 2);
  let app: Fixture;
  test.beforeAll(async () => {
    app = await startLayersApp('crm-designed');
  });
  test.afterAll(async () => {
    await app?.stop();
  });

  for (const look of LOOKS) {
    test(`${look.name}: the leads list, a lead and the sales dashboard draw, and none scrolls sideways`, async ({ page }) => {
      const sideways: string[] = [];
      const measure = async (at: string) => {
        const over = await page.evaluate(() => {
          const pane = document.querySelector('.content');
          return Math.max(
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
            pane ? pane.scrollWidth - pane.clientWidth : 0,
          );
        });
        if (over > 1) sideways.push(`${at}: ${over}px`);
      };
      for (const { name, width, height } of WIDTHS) {
        await page.setViewportSize({ width, height });
        /* The look, chosen as a reader would, on the origin before the page boots: a custom theme by the App's id. */
        await page.goto(`${app.origin}/api/runtime`);
        await page.evaluate(
          ([custom, chosen]) => {
            localStorage.setItem('mistri.tour.v1', 'done');
            if (custom) localStorage.setItem('mistri.custom-theme-choices', JSON.stringify([['compass', custom]]));
            else localStorage.removeItem('mistri.custom-theme-choices');
            if (chosen) localStorage.setItem('mistri.visual-theme', chosen);
            else localStorage.removeItem('mistri.visual-theme');
          },
          ['custom' in look ? look.custom : '', 'look' in look ? look.look : ''],
        );

        await page.goto(`${app.origin}/leads`);
        await expect(page.locator('html')).not.toHaveAttribute('data-starting', { timeout: 30_000 });
        await expect(page.locator('.free-page-body tbody tr').first()).toBeVisible();
        await measure(`${look.name} ${name} leads`);

        await page.locator('.free-page-body tbody tr').first().locator('.kit-table-link').click();
        await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();
        await measure(`${look.name} ${name} lead`);

        await page.goto(`${app.origin}/sales-dashboard`);
        await expect(page.locator('.free-page-body .home-card').first()).toBeVisible();
        await expect(page.locator('.free-page-body tbody tr').first()).toBeVisible();
        await measure(`${look.name} ${name} sales dashboard`);
      }
      expect(sideways).toEqual([]);
    });
  }
});
