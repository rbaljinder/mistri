import { expect, test } from './support/harness';
import { startSample } from './support/sampleServer';
import { scalar } from './support/db';

/**
 * Forecourt's search, narrowed from a rail on the left of the cards: a make
 * ticked from its counted checklist, a price bounded by a Min/Max range, the
 * selection said as chips at the top of the results with one Clear all, and
 * the address in words through all of it. Every count stands on the list's
 * own "not sold", as the cards do. On a phone the rail is a sheet applied by
 * one button. Every figure is asked of the seeded database.
 */
test.describe("Forecourt's filter rail", () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.setTimeout(120_000);
  test.beforeEach(async () => {
    sample = await startSample('forecourt');
  });
  test.afterEach(async () => {
    await sample?.stop();
  });

  test('1440px: a make ticked and a price bounded from the rail, said as chips above the cards, kept by the address, cleared at once', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${sample.origin}/vehicles`);
    const rail = page.getByRole('complementary', { name: 'Vehicles filters' });
    const cards = page.getByRole('list', { name: 'Vehicles' });
    await expect(cards.getByRole('listitem').first()).toBeVisible();

    // The make is a checklist, each value counted over the cars not yet sold — never the sold ones.
    const toyotas = Number(scalar(sample.db, "SELECT COUNT(*) FROM vehicle WHERE make = 'Toyota' AND status != 'sold'"));
    const make = rail.getByRole('group', { name: 'Make' });
    const toyota = make.getByRole('checkbox', { name: new RegExp(`^Toyota ${toyotas}$`) });
    // A facet shows its five commonest values; Toyota, with three cars, is further down.
    await make.getByRole('button', { name: /^Show all/ }).click();
    await expect(toyota).toBeVisible();
    await toyota.check();
    await expect(page).toHaveURL(/\/vehicles\?make=Toyota$/);
    await expect(cards.getByRole('listitem')).toHaveCount(toyotas);

    // The price is a range, in dollars, applied on Enter.
    const price = rail.getByRole('group', { name: 'Price' });
    await price.getByLabel('Max').fill('15000');
    await price.getByLabel('Max').press('Enter');
    await expect(page).toHaveURL(/\/vehicles\?make=Toyota&price=\.\.15000$/);
    const cheap = Number(scalar(sample.db, "SELECT COUNT(*) FROM vehicle WHERE make = 'Toyota' AND price <= 15000 AND status != 'sold'"));
    await expect(cards.getByRole('listitem')).toHaveCount(cheap);

    // The selection is said at the top of the results, beside the Sort — not under the heading.
    const applied = page.getByRole('group', { name: 'Vehicles filters applied' });
    await expect(applied.locator('.applist-chip', { hasText: 'Make is Toyota' })).toBeVisible();
    await expect(applied.locator('.applist-chip', { hasText: 'Price up to $15,000' })).toBeVisible();
    await expect(page.locator('.applist-results-head').getByRole('button', { name: 'Sort', exact: true })).toBeVisible();

    // The address is the selection: a reload draws the same ticks and ends.
    await page.reload();
    await expect(
      page
        .getByRole('complementary', { name: 'Vehicles filters' })
        .getByRole('group', { name: 'Make' })
        .getByRole('checkbox', { name: /^Toyota/ }),
    ).toBeChecked();
    await expect(
      page.getByRole('complementary', { name: 'Vehicles filters' }).getByRole('group', { name: 'Price' }).getByLabel('Max'),
    ).toHaveValue('15000');

    // One Clear all, beside the chips; the rail has none of its own.
    await expect(page.getByRole('complementary', { name: 'Vehicles filters' }).getByRole('button', { name: 'Clear all' })).toHaveCount(0);
    await page.getByRole('group', { name: 'Vehicles filters applied' }).getByRole('button', { name: 'Clear all' }).click();
    await expect(page).toHaveURL(/\/vehicles$/);
    await expect(page.locator('.applist-chip')).toHaveCount(0);
  });

  test('390px: the rail is a Filters sheet, counted over what is for sale and applied by one button', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${sample.origin}/vehicles`);
    await expect(page.getByRole('list', { name: 'Vehicles' }).getByRole('listitem').first()).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Vehicles filters' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Filters' });
    const hondas = Number(scalar(sample.db, "SELECT COUNT(*) FROM vehicle WHERE make = 'Honda' AND status != 'sold'"));
    await sheet
      .getByRole('group', { name: 'Make' })
      .getByRole('checkbox', { name: /^Honda/ })
      .check();
    // A draft: nothing under the sheet has changed, and its button says what it will show — the unsold Hondas.
    await expect(page).toHaveURL(/\/vehicles$/);
    await sheet.getByRole('button', { name: `Show ${hondas}` }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page).toHaveURL(/\/vehicles\?make=Honda$/);
    await expect(page.locator('.applist-chip', { hasText: 'Make is Honda' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Filters · 1', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
