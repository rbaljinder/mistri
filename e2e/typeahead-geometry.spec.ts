import { expect, test, type Locator, type Page } from './support/harness';
import { CRM_DB } from './support/fixtures';
import { scalar } from './support/db';

const CRM = `http://127.0.0.1:${process.env.TABLEWALK_E2E_CRM_PORT}`;

async function bounded(page: Page, popup: Locator, anchor: Locator) {
  // Both rectangles are screen pixels, already including root density zoom.
  // Compare like rulers rather than mixing layout widths with screen bounds.
  await expect(async () => {
    const box = await popup.boundingBox(),
      reference = await anchor.boundingBox();
    const viewport = page.viewportSize()!;
    const diagnostic = JSON.stringify({
      popup: box,
      anchor: reference,
      viewport,
      zoom: await page.locator('html').evaluate((element) => getComputedStyle(element).zoom),
    });
    expect(box, diagnostic).not.toBeNull();
    expect(reference, diagnostic).not.toBeNull();
    if (!box || !reference) return;
    expect(
      box.width > 0 &&
        box.height > 0 &&
        box.x >= -1 &&
        box.y >= -1 &&
        box.x + box.width <= viewport.width + 1 &&
        box.y + box.height <= viewport.height + 1 &&
        Math.abs(box.width - reference.width) <= 2 &&
        Math.abs(box.x - reference.x) <= 2,
      diagnostic,
    ).toBe(true);
  }).toPass({ timeout: 7000 });
}

for (const width of [1440, 390])
  for (const [density, zoom] of [
    ['compact', 1],
    ['comfortable', 1.12],
  ] as const) {
    test(`New drawer fixed-fit picker remains bounded at ${width}px and ${zoom} zoom`, async ({ page }) => {
      const warnings: string[] = [];
      page.on('console', (message) => {
        if (message.text().startsWith('typeahead-resize-warning:')) warnings.push(message.text());
      });
      await page.addInitScript(() => {
        window.addEventListener('error', (event) => {
          if (event.message.includes('ResizeObserver')) console.info(`typeahead-resize-warning:${event.message}`);
          // Observe only: never preventDefault or suppress the actual error.
        });
      });
      await page.addInitScript((value) => localStorage.setItem('mistri.density', value), density);
      const account = String(scalar(CRM_DB, 'SELECT name FROM account WHERE id = 1'));
      const owner = String(scalar(CRM_DB, 'SELECT name FROM sales_rep WHERE id = 1'));
      await page.setViewportSize({ width, height: 700 });
      await page.goto(`${CRM}/opportunity`);
      await expect(page.locator('html')).toHaveCSS('zoom', String(zoom));
      await page.getByRole('button', { name: '+ New opportunity', exact: true }).click();
      const form = page.locator('.newpanel');
      await expect(form.getByRole('heading')).toHaveText('New opportunity');
      for (const [label, name] of [
        ['Account', account],
        ['Owner', owner],
      ]) {
        const field = form.locator('.insert-field').filter({ has: page.locator('label', { hasText: new RegExp(`^${label}\\*?$`) }) });
        const input = field.locator('.picker-input');
        await input.scrollIntoViewIfNeeded();
        // Cold search and then a narrower asynchronous result set exercise
        // option arrival without introducing a test-only network stub.
        await input.fill(name.split(' ')[0]);
        const popup = form.locator('.picker-popup');
        await expect(popup).toBeVisible();
        await expect(popup.getByRole('option').first()).toBeVisible();
        await bounded(page, popup, field.locator('.picker'));
        await input.fill(name);
        await expect(popup.getByRole('option').filter({ hasText: name }).first()).toBeVisible();
        await bounded(page, popup, field.locator('.picker'));
        const body = form.locator('.newpanel-body');
        await body.evaluate((element) => {
          const maximum = element.scrollHeight - element.clientHeight;
          if (maximum > 0)
            element.scrollTop =
              element.scrollTop < maximum ? Math.min(maximum, element.scrollTop + 12) : Math.max(0, element.scrollTop - 12);
        });
        await bounded(page, popup, field.locator('.picker'));
        await popup.getByRole('option').filter({ hasText: name }).first().click();
        await expect(popup).toHaveCount(0);
        await expect(input).toHaveValue(name);
      }
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(warnings, 'fixed-fit picker must not emit ResizeObserver loop errors').toEqual([]);
      // No insert: this regression only edits an owned, unsaved form draft.
      await page.keyboard.press('Escape');
      const discard = page.getByRole('dialog', { name: 'Discard new record?', exact: true });
      await expect(discard).toBeVisible();
      await expect(form).toBeVisible();
      await discard.getByRole('button', { name: 'Discard record', exact: true }).click();
      await expect(discard).toHaveCount(0);
      await expect(form).toHaveCount(0);
    });
  }
