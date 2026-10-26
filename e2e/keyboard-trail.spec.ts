import { CRM, expect, type Page, test } from './support/ownServers';
import { startSample } from './support/sampleServer';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

/* A record opened from a list steps through that list with J and K: beside a
   split list, whose row the list marks as it goes, and past the edge of a
   page, in a record page and in a glance. The list is the reader's list —
   its order, its filter, its next page — never a second question. */

/* The split's selected row is the address: `…/{id}` after the list's key. */
const selected = (page: Page) => Number(new URL(page.url()).pathname.match(/\/updates\/(\d+)$/)?.[1]);
/* A row opened by a value, not its checkbox or its menu. */
const openRow = (page: Page, row: ReturnType<Page['locator']>) =>
  row
    .getByRole('gridcell')
    .filter({ hasNot: page.getByRole('checkbox') })
    .first()
    .click();
const place = async (trail: ReturnType<Page['locator']>) => {
  const [, at, of] = /(\d+) of ([\d,]+)/.exec((await trail.textContent()) ?? '') ?? [];
  return { at: Number(at), of: Number(of?.replace(/,/g, '')) };
};

test.describe('on Thread', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.setTimeout(60_000);
  test.beforeEach(async () => {
    sample = await startSample('thread');
  });
  test.afterEach(async () => {
    await sample?.stop();
  });

  test("a split list's detail steps through the list with J and K, and the list marks the row it is on", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 924 });
    await page.goto(`${sample.origin}/`);
    await page
      .locator('.sidebar')
      .getByRole('button', { name: /^Updates/ })
      .click();
    await expect(page.locator('.applist-title')).toHaveText('Updates');
    await openRow(page, page.locator('tbody tr[data-row="1"]').first());

    const list = page.getByRole('region', { name: 'Updates list' });
    const detail = page.getByRole('complementary', { name: 'Updates details' });
    const trail = detail.getByRole('navigation', { name: 'Records in this list' });
    const marked = list.locator('tbody tr[aria-current="true"]');
    await expect(trail).toContainText(/^.*2 of \d+/);
    await expect(marked).toHaveCount(1);
    await expect(marked).toHaveAttribute('data-row', '1');
    const first = selected(page);

    await page.keyboard.press('j');
    await expect(trail).toContainText(/3 of \d+/);
    await expect.poll(() => selected(page)).not.toBe(first);
    await expect(marked).toHaveAttribute('data-row', '2');
    // The detail is the next row's record, and the list is still beside it.
    await expect(list).toBeVisible();

    await page.keyboard.press('k');
    await expect(trail).toContainText(/2 of \d+/);
    await expect.poll(() => selected(page)).toBe(first);
    await expect(marked).toHaveAttribute('data-row', '1');
  });
});

test("the last record of an App list's page steps onto the next page with J, and back with K", async ({ page }) => {
  await page.goto(`${CRM}/lead`);
  await expect(page.locator('.applist-title')).toHaveText('Leads');
  const rows = page.locator('.result-table tbody tr[data-row]');
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  await openRow(page, rows.nth(count - 1));

  const trail = page.getByRole('navigation', { name: 'Records in this list' });
  await expect(trail).toContainText(`${count} of `);
  const { of } = await place(trail);
  expect(of).toBeGreaterThan(count);
  const lastOfPage = page.url();

  await page.keyboard.press('j');
  await expect(trail).toContainText(`${count + 1} of ${of}`);
  await expect.poll(() => page.url()).not.toBe(lastOfPage);
  await page.keyboard.press('k');
  await expect(trail).toContainText(`${count} of ${of}`);
  await expect.poll(() => page.url()).toBe(lastOfPage);
});

test('a glance opened from the last row of a page steps onto the next page', async ({ page }) => {
  // Compass's contacts open as a glance (`open: 'drawer'`).
  await page.goto(`${CRM}/contact`);
  await expect(page.locator('.applist-title')).toHaveText('Contacts');
  const rows = page.locator('.result-table tbody tr[data-row]');
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  await openRow(page, rows.nth(count - 1));

  const glance = page.getByRole('dialog', { name: /a glance/ });
  const trail = glance.getByRole('navigation', { name: 'Records in this list' });
  await expect(trail).toContainText(`${count} of `);
  const { of } = await place(trail);
  test.skip(!(of > count), 'the contacts fit on one page');
  const name = await glance.getAttribute('aria-label');

  await page.keyboard.press('j');
  await expect(trail).toContainText(`${count + 1} of ${of}`);
  await expect(glance).not.toHaveAttribute('aria-label', name ?? '');
});
