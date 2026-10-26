// test-package: shared — drives the database browser and an App to one behavior (scripts/test-owners.mjs).
/**
 * What the rooms look like, pixel for pixel.
 *
 * The shell is moving to components one surface at a time, and the promise
 * for every move is that nothing a reader sees changes. The other suites
 * check that things work; this one checks that they look the same — the
 * workbench landing and a walk with its crumbs, the app's landing, a list,
 * a record page, the New drawer, the dashboard, and the top bar folded on a
 * narrow screen. A port that shifts a gutter fails here.
 *
 * The baselines are this machine's Chromium; text rasterises differently
 * across platforms, so the suite runs locally and stands down on CI until
 * a Linux baseline is recorded there.
 *
 *   npx playwright test e2e/visual.spec.ts                    compare
 *   npx playwright test e2e/visual.spec.ts --update-snapshots re-record
 */
import { expect, test, type Page } from './support/harness';
import { CRM_CLOCK, DEMO } from './support/fixtures';
import { open } from './support/app';

const CRM = `http://127.0.0.1:${process.env.TABLEWALK_E2E_CRM_PORT}`;

test.skip(Boolean(process.env.CI), 'baselines are recorded on one machine');

/* Scrollbars take no room. Chromium on macOS draws classic scrollbars
   whenever a mouse is attached and overlay ones when it is not, and the
   pane's `scrollbar-gutter: stable` reserved fifteen pixels in one state
   and none in the other — every right-aligned control moved with the desk
   setup. Zero-width scrollbars make the gutter zero either way. Injected
   before the app's own scripts run, so the widths its diagrams and charts
   measure are the widths the shot will show. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    /* `scrollbar-width` as well as the WebKit pseudo-element: the App's panes
       ask for a thin bar drawn from the theme (style.css), and a thin bar is
       still a bar — it reserves a gutter and moves every right-aligned
       control, which is the drift this pin exists to keep out of the shots. */
    const pin = () => {
      const style = document.createElement('style');
      style.textContent = '::-webkit-scrollbar { width: 0; height: 0; }\n' + '* { scrollbar-width: none !important; }';
      document.head.appendChild(style);
    };
    if (document.head) pin();
    else document.addEventListener('DOMContentLoaded', pin);
    /* The tour opens two frames after the first paint, so whether a shot
       catches it is a race — one baseline recorded with it and the next
       without. A returning reader has seen it; that is the state to draw. */
    try {
      window.localStorage.setItem('mistri.tour.v1', 'done');
    } catch {
      /* private window */
    }
  });
});

/* Timings and the like: true, and different every run. */
const MASK = ['.stat', '.dash-count'];

async function looks(page: Page, name: string): Promise<void> {
  await expect(page.locator('html')).not.toHaveAttribute('data-starting');
  /* Fonts and the last skeleton must be settled before the shot. */
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('.skeleton')).toHaveCount(0, { timeout: 10_000 });
  // Collect every room's diff in one run so review does not stop at the first drift.
  await expect.soft(page).toHaveScreenshot(`${name}.png`, {
    animations: 'disabled',
    caret: 'hide',
    mask: MASK.map((m) => page.locator(m)),
    maxDiffPixelRatio: 0.001,
  });
}

async function crm(page: Page, path = ''): Promise<void> {
  /* The browser's today matches the server's pinned one, so a relative
     date ("in 3 days") reads the same on every run. Timers keep running. */
  await page.clock.setFixedTime(new Date(CRM_CLOCK));
  await page.goto(`${CRM}${path || '/'}`);
  await expect(page.locator('#db-label')).toContainText('Compass');
}

test('the workbench: landing, and a row at the end of a walk', async ({ page }) => {
  await open(page, DEMO);
  await expect(page.locator('.shape')).toBeVisible();
  await looks(page, 'workbench-landing');
  await page.goto(`/${DEMO}/customer/~1`);
  await expect(page.locator('.crumbs .current')).toBeVisible();
  await expect(page.locator('.record, .record-view, dl').first()).toBeVisible();
  await looks(page, 'workbench-record');
});

test('the app: landing, list, record page, New drawer, dashboard', async ({ page }) => {
  await crm(page);
  await expect(page.locator('.home-card-value').first()).not.toHaveText('…');
  await expect(page.locator('.chart-line').first()).toBeVisible({ timeout: 20_000 });
  await looks(page, 'app-landing');

  await crm(page, '/lead');
  await expect(page.locator('.applist-title')).toHaveText('Leads');
  await expect(page.locator('tbody tr').first()).toBeVisible();
  await expect(page.locator('.tab-count').first()).toHaveText(/\d/);
  await looks(page, 'app-list');

  await page.getByRole('button', { name: '+ New lead' }).click();
  await expect(page.locator('.newpanel')).toBeVisible();
  await looks(page, 'app-new-drawer');

  await crm(page, '/@lead~127');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Margot Fontaine');
  await expect(page.locator('.page-field dd').first()).toBeVisible();
  await looks(page, 'app-record');

  await crm(page, '/@dash-sales-dashboard');
  await expect(page.locator('.chart-line').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.home-card-value').first()).not.toHaveText('…');
  await looks(page, 'app-dashboard');
});

/* Compass's groups are one level deep, so its folded top menu is one
   sectioned popup — each group a labelled section, every room a tap away.
   Only a group that nests another folds the menu into drill-in levels. */
test('the top bar, folded on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 800 });
  await crm(page, '/lead');
  await expect(page.locator('.applist-title')).toHaveText('Leads');
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.locator('.tn-folded-pop')).toBeVisible();
  await looks(page, 'app-topnav-folded');
});
