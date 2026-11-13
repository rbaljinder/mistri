/**
 * The page kit's layout vocabulary, in a browser (test/fixtures/apps/page-kit): a rail beside a column that stacks when
 * the box is narrow, a Card's description, an Item's lead column and tone mark, a button that is a link followed in
 * place, a Skeleton that holds its size, a segmented choice whose chosen count reads, and a file field drawn as a
 * button. It starts its own server over a disposable database (support/layersServer.ts).
 */
import { settled } from '@mistriwork/mistri/testing';
import { LONG_MS } from './support/budgets';
import { expect, test } from './support/harness';
import { startLayersApp } from './support/layersServer';

type Fixture = Awaited<ReturnType<typeof startLayersApp>>;

/** WCAG's relative luminance contrast of two computed `rgb(...)` colors. */
const contrast = (a: string, b: string) => {
  const light = (color: string) => {
    const [r, g, bl] = (color.match(/[\d.]+/g) ?? [])
      .slice(0, 3)
      .map(Number)
      .map((v) => {
        const s = v! / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [light(a), light(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

test.describe('The page kit vocabulary', () => {
  test.setTimeout(LONG_MS);
  let app: Fixture;
  test.beforeAll(async () => {
    app = await startLayersApp('page-kit');
  });
  test.afterAll(async () => {
    await app?.stop();
  });

  test('a rail stands beside the column at a desk and under it at a phone, with nothing running sideways', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
    let main = await box('.kit-beside-main');
    let rail = await box('.kit-beside-rail');
    expect(rail.x).toBeGreaterThanOrEqual(main.x + main.width - 1);
    expect(Math.abs(rail.y - main.y)).toBeLessThan(2);
    await page.setViewportSize({ width: 390, height: 800 });
    await settled(page);
    main = await box('.kit-beside-main');
    rail = await box('.kit-beside-rail');
    expect(rail.y).toBeGreaterThanOrEqual(main.y + main.height - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("a free-form page's first part starts one space under its head, not three margins' worth", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    const gap = await page.evaluate(() => {
      const head = document.querySelector('.dash-head')!.getBoundingClientRect();
      const first = document.querySelector('.free-page-body .custom-room')!.getBoundingClientRect();
      return first.top - head.bottom;
    });
    /* A field report measured 62px (the head's margin, the body's and the section's); a list's tabs sit about 27px under. */
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(24);
  });

  test("a Card says what it holds, in its tone; an Item's lead and tone mark share one column", async ({ page }) => {
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    await expect(page.getByText('Everything we hold')).toBeVisible();
    const title = page.getByRole('heading', { name: 'Things', level: 3 }).first();
    expect(await title.getAttribute('class')).toContain('kit-card-title-warn');
    const leads = page.locator('.kit-item-lead');
    await expect(leads).toHaveCount(2);
    const [first, second] = await Promise.all([leads.nth(0).boundingBox(), leads.nth(1).boundingBox()]);
    // One column the rows share: both lead boxes are as wide as the widest, and the third row's text lines up with them.
    expect(Math.abs(first!.width - second!.width)).toBeLessThan(1);
    const titles = page.locator('.kit-item-body');
    const [a, b, c] = await Promise.all([0, 1, 2].map(async (at) => (await titles.nth(at).boundingBox())!.x));
    expect(Math.abs(a! - b!)).toBeLessThan(1);
    expect(Math.abs(a! - c!)).toBeLessThan(1);
  });

  test('a button with an address is a link, followed in place', async ({ page }) => {
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
    const open = page.getByRole('link', { name: 'Open' });
    await expect(open).toHaveAttribute('href', '/vocabulary?opened=1');
    expect(await open.getAttribute('class')).toContain('btn');
    await open.click();
    await expect(page).toHaveURL(/opened=1/);
    expect(await page.evaluate(() => (window as unknown as { marker: number }).marker)).toBe(1);
  });

  test("a row's link is followed in place too, from anywhere on the row", async ({ page }) => {
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
    await page
      .locator('.kit-item')
      .first()
      .click({ position: { x: 300, y: 8 } });
    await expect(page).toHaveURL(/seen=1/);
    expect(await page.evaluate(() => (window as unknown as { marker: number }).marker)).toBe(1);
  });

  test("at a phone's width a row's actions stand under its words, and the row is a finger tall", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    const row = page.locator('.kit-item', { has: page.locator('.kit-item-action') });
    const [body, action, whole] = await Promise.all(
      ['.kit-item-body', '.kit-item-action', ''].map(async (selector) => (await (selector ? row.locator(selector) : row).boundingBox())!),
    );
    // Three buttons would squeeze the words into a sliver beside them: the action wraps under the note instead.
    expect(action.y).toBeGreaterThanOrEqual(body.y + body.height - 1);
    expect(body.width).toBeGreaterThan(150);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // A clickable row answers a finger anywhere on it, and is at least 44px tall to be hit.
    expect(whole.height).toBeGreaterThanOrEqual(44);
    for (const item of await page.locator('.kit-item-clickable').all())
      expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });

  test('a row of five choices is a picker at a phone, and the row at a desk; className reaches whichever is drawn', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    const row = page.getByRole('radiogroup', { name: 'Stage' });
    const pick = page.getByRole('combobox', { name: 'Stage' });
    await expect(row).toBeVisible();
    await expect(pick).toBeHidden();
    await expect(row).toHaveClass(/vocabulary-stage/);
    await page.setViewportSize({ width: 390, height: 800 });
    await settled(page);
    await expect(row).toBeHidden();
    await expect(pick).toBeVisible();
    await expect(pick).toHaveClass(/vocabulary-stage/);
    // Nothing runs past the window, and the picker is a finger tall.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await pick.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await pick.selectOption('quoted');
    await expect(pick).toHaveValue('quoted');
    // The two-choice row beside it is never folded.
    await expect(page.getByRole('radiogroup', { name: 'Range' })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole('radio', { name: /Quoted/ })).toHaveAttribute('aria-checked', 'true');
  });

  test('a Skeleton holds the size it was given', async ({ page }) => {
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    const bar = (await page.locator('.kit-skeleton-bar').last().boundingBox())!;
    expect([Math.round(bar.height), Math.round(bar.width)]).toEqual([24, 160]);
  });

  test("the chosen segment's count reads against its fill, 4.5:1 at least", async ({ page }) => {
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    const chosen = page.getByRole('radio', { name: /Week/ }).or(page.locator('[aria-checked="true"], [aria-pressed="true"]')).first();
    const colors = await chosen.evaluate((button) => {
      const count = button.querySelector<HTMLElement>('[class*="count"]')!;
      return [getComputedStyle(count).color, getComputedStyle(count).backgroundColor];
    });
    expect(contrast(colors[0]!, colors[1]!)).toBeGreaterThanOrEqual(4.5);
  });

  test('a file field is drawn with the house button', async ({ page }) => {
    await page.goto(`${app.origin}/vocabulary`);
    await settled(page);
    await expect(page.locator('.btn', { hasText: /Choose file/ }).first()).toBeVisible();
  });
});
