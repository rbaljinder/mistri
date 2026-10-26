/**
 * A stepped public form drawn as a page, in a browser at a desk and on a phone: the controls of a row stand level,
 * one answer's cards draw a radio's mark and several answers' a checkbox's. It starts its own server over a disposable
 * database (support/intakeServer.ts, the quote fixture), so it shares nothing with another spec.
 */
import { expect, test, type Page } from './support/harness';
import { startIntakeApp } from './support/intakeServer';

type Fixture = Awaited<ReturnType<typeof startIntakeApp>>;

const next = async (page: Page, step: number) => {
  await page.getByRole('button', { name: /^(Continue|Review)$/ }).click();
  await expect(page.getByRole('progressbar', { name: new RegExp(`^Step ${step} of 6`) })).toBeVisible();
};

async function address(page: Page) {
  await page.getByRole('textbox', { name: /^Street address/ }).fill('1427 Larkspur Lane');
  await page.getByRole('textbox', { name: /^City/ }).fill('Boulder');
  await page.getByRole('button', { name: /^State/ }).click();
  await page.getByRole('option', { name: 'CO', exact: true }).click();
  await page.getByRole('textbox', { name: /^ZIP code/ }).fill('80302');
}

test.describe('A stepped page form', () => {
  test.setTimeout(90_000);
  let app: Fixture;
  test.beforeEach(async () => {
    app = await startIntakeApp([], 'quote');
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ])
    test(`every control in a row is one height (${viewport.width}px)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`${app.origin}/form/quote`);
      const state = page.getByRole('button', { name: /^State/ });
      const boxes = [page.getByRole('textbox', { name: /^City/ }), state, page.getByRole('textbox', { name: /^ZIP code/ })];
      const heights = await Promise.all(boxes.map(async (box) => (await box.boundingBox())!.height));
      expect(new Set(heights).size, `heights ${heights.join(', ')}`).toBe(1);
    });

  test("an intake page's brand row names the App beside its mark", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${app.origin}/form/quote`);
    await expect(page.locator('.topbar .brand-name')).toBeVisible();
    await expect(page.locator('.topbar .brand-name')).toHaveText('Example Home Energy');
  });

  test("one answer's cards draw a radio's round mark; several answers' keep the square", async ({ page }) => {
    await page.goto(`${app.origin}/form/quote`);
    await address(page);
    await next(page, 2);
    const mark = (name: string) =>
      page.getByRole('radio', { name, exact: false }).locator('xpath=ancestor::label[1]').locator('.choice-box');
    const round = await mark('Townhouse').evaluate((box) => getComputedStyle(box).borderRadius);
    expect(round).toBe('50%');
    await page.getByText('Townhouse', { exact: true }).click();
    await next(page, 3);
    await page.getByRole('slider').focus();
    await page.keyboard.press('ArrowRight');
    await next(page, 4);
    await page.locator('label.choice-card', { hasText: 'Show me both' }).click();
    const square = await page
      .getByRole('checkbox', { name: /^Fridge/ })
      .locator('.choice-box')
      .evaluate((box) => getComputedStyle(box).borderRadius);
    expect(square).not.toBe('50%');
  });

  test('at a desk the steps stand beside the form, the ones done a way back; on a phone they are not drawn', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${app.origin}/form/quote`);
    const steps = page.getByRole('navigation', { name: 'Form steps' });
    await expect(steps).toBeVisible();
    const form = (await page.locator('.multi-step-panel').boundingBox())!;
    const aside = (await steps.boundingBox())!;
    // Beside it, not under it: the list starts right of the column and level with its top.
    expect(aside.x).toBeGreaterThan(form.x + form.width);
    expect(aside.y).toBeLessThan(form.y);
    await expect(steps.locator('[aria-current="step"]')).toHaveText(/Address/);
    await address(page);
    await next(page, 2);
    const done = steps.getByRole('button', { name: /^Address\W+done$/ });
    await expect(done).toBeVisible();
    await expect(steps.getByText('1427 Larkspur Lane, Boulder, CO, 80302')).toBeVisible();
    await done.click();
    await expect(page.getByRole('progressbar', { name: /^Step 1 of 6/ })).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^Street address/ })).toHaveValue('1427 Larkspur Lane');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(steps).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
});
