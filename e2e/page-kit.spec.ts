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
