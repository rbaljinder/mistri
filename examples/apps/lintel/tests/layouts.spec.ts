/**
 * The pages that name an archetype (`page(…, { layout })`): a home's listing puts its price and the way to see it
 * straight after the photos, and a repair's conversation ends with its composer, its parts and home beside it at a
 * desk and after it on a phone. Judged by where each thing stands, the way a reader meets it.
 */
import type { Page } from '@playwright/test';
import { expect, fitsTheWidth, open, signIn, test } from './browser.ts';

/* The page's cumulative layout shift while it settles, as the browse check reads it. */
async function shifted(page: Page): Promise<number> {
  return page.evaluate<number>(`new Promise((done) => {
    let total = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) total += entry.value;
    }).observe({ type: 'layout-shift', buffered: true });
    setTimeout(() => done(total), 1500);
  })`);
}

test("a home's listing: the photos, then the asking rent and the way to see it, then the rest", async ({ page, lintel, isMobile }) => {
  const home = lintel.rows<{ id: number }>(`SELECT id FROM unit WHERE listed = 1 ORDER BY id LIMIT 1`)[0];
  await open(page, lintel, `/listings/${home.id}`);
  const layout = page.locator('.page-layout[data-layout="showcase"]');
  await expect(layout).toBeVisible();
  const panel = layout.getByRole('complementary');
  await expect(panel).toHaveCount(1);
  const ask = panel.getByRole('link', { name: 'Ask for a viewing' });
  await expect(ask).toBeVisible();
  const photos = await layout.locator('.page-showcase').boundingBox();
  const offer = await panel.boundingBox();
  const body = await layout.locator('.page-showcase-body > *').first().boundingBox();
  expect(photos && offer && body, 'the three bands are drawn').toBeTruthy();
  if (isMobile) {
    // One column in reading order: the call to action comes before the first thing under the photos.
    expect(offer!.y).toBeGreaterThanOrEqual(photos!.y + photos!.height - 1);
    expect((await ask.boundingBox())!.y).toBeLessThan(body!.y);
    await fitsTheWidth(page);
  } else {
    // The panel beside the photos, and the body under both at the page's width.
    expect(offer!.x).toBeGreaterThan(photos!.x + photos!.width - 1);
    expect(body!.y).toBeGreaterThanOrEqual(Math.max(photos!.y + photos!.height, offer!.y + offer!.height) - 1);
    expect(body!.width).toBeGreaterThan(photos!.width);
  }
  expect(await shifted(page)).toBeLessThanOrEqual(0.1);
});

test("a resident's repair: the thread last in the main column, the home beside it at a desk and after it on a phone", async ({
  page,
  lintel,
  isMobile,
}) => {
  const repair = lintel.rows<{ id: number }>(
    `SELECT id FROM maintenance_request WHERE resident_id = ? ORDER BY id DESC LIMIT 1`,
    lintel.resident.id,
  )[0];
  await signIn(page, lintel, 'resident');
  await open(page, lintel, `/my-requests/${repair.id}`);
  const layout = page.locator('.page-layout[data-layout="conversation"]');
  await expect(layout).toBeVisible();
  const main = layout.locator('> .page-main');
  await expect(main.locator('> *').last().getByText('Conversation').first()).toBeVisible();
  const aside = layout.getByRole('complementary');
  await expect(aside.getByText('Home').first()).toBeVisible();
  const column = (await main.boundingBox())!;
  const beside = (await aside.boundingBox())!;
  if (isMobile) {
    expect(beside.y).toBeGreaterThanOrEqual(column.y + column.height - 1);
    await fitsTheWidth(page);
  } else {
    expect(beside.x).toBeGreaterThan(column.x + column.width - 1);
  }
});

test("the office's repair, picked beside its queue: the composer ends the thread", async ({ page, lintel }) => {
  const repair = lintel.rows<{ id: number }>(
    `SELECT m.id AS id FROM maintenance_request m WHERE EXISTS (SELECT 1 FROM request_note n WHERE n.request_id = m.id) ORDER BY m.id LIMIT 1`,
  )[0];
  await signIn(page, lintel, 'manager');
  await open(page, lintel, `/repairs/${repair.id}`);
  const layout = page.locator('.page-layout[data-layout="conversation"]');
  await expect(layout).toBeVisible();
  // Nothing in the main column after the thread: its last section holds the box a reply is written in.
  await expect(layout.locator('> .page-main > *').last().locator('textarea').last()).toBeVisible();
});
