import { expect, test, type Page } from './support/harness';
import { startSample } from './support/sampleServer';
import { scalar } from './support/db';

/**
 * An App list's filter bar, on Thread's Issues: one search box, a "+" per
 * filter that opens its picker, and what is applied said as chips in the
 * same row — each change read back from the address and the database, by
 * pointer, by keyboard and on a phone. The rail keeps its own suites
 * (compass-filter-rail, forecourt-filters).
 */
const address = (page: Page) => {
  const url = new URL(page.url());
  return decodeURIComponent(url.pathname + url.search);
};
const count = (page: Page) => page.locator('.applist-count');
const many = (n: unknown) => Number(n).toLocaleString();
const chips = (page: Page) => page.locator('.applist-fields .applist-chip');
const picker = (page: Page, label: string) => page.getByRole('dialog', { name: `Filter by ${label}` });
/* The Active tab Issues opens on. */
const ACTIVE = "status NOT IN ('done', 'canceled')";

test.describe('Thread Issues filter bar', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.setTimeout(60_000);
  test.beforeEach(async () => {
    sample = await startSample('thread');
  });
  test.afterEach(async () => {
    await sample?.stop();
  });
  const issues = async (page: Page) => {
    await page.goto(`${sample.origin}/issues`);
    await expect(page.getByRole('tab', { name: /^Active/ })).toHaveAttribute('aria-selected', 'true');
  };

  test('a "+" adds a filter, its chip edits and removes it, and two earn one Clear all', async ({ page }) => {
    /* Wide enough that no "+" gives way to "+ Filter" when the Priority chip
       grows to "in (urgent, high)". At 1440 that row is exactly full on a Mac
       (1010 of 1010px) and a few pixels over with Linux's wider fonts, where
       Assignee folds, as the bar means it to, and this walk could not find
       its "+". The fold is filter-toolbar.spec's to prove. */
    await page.setViewportSize({ width: 1680, height: 924 });
    await issues(page);
    await expect(count(page)).toHaveText(many(scalar(sample.db, `SELECT count(*) FROM issue WHERE ${ACTIVE}`)));
    // Nothing applied: the search, a "+" per filter, and no chip, no Clear all.
    await expect(page.getByRole('searchbox', { name: 'Filter by Name' })).toBeVisible();
    for (const label of ['Status', 'Priority', 'Assignee'])
      await expect(page.getByRole('button', { name: `Filter by ${label}` })).toBeVisible();
    await expect(chips(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clear all' })).toHaveCount(0);

    // A tick is a draft, and the button says what it will show before it shows it.
    await page.getByRole('button', { name: 'Filter by Priority' }).click();
    const priority = picker(page, 'Priority');
    await priority.locator('input[data-value="high"]').check();
    const highs = scalar(sample.db, `SELECT count(*) FROM issue WHERE ${ACTIVE} AND priority = 'high'`);
    await expect(priority.getByRole('button', { name: /^Show/ })).toHaveText(`Show ${many(highs)}`);
    expect(address(page)).toBe('/issues');
    await priority.getByRole('button', { name: /^Show/ }).click();
    await expect(page.locator('.applist-chip', { hasText: 'Priority is High' })).toBeVisible();
    await expect.poll(() => address(page)).toBe('/issues?priority=high');
    await expect(count(page)).toHaveText(many(highs));
    // Narrowing Active is still Active, and the focus is on the chip that says it.
    await expect(page.getByRole('tab', { name: /^Active/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Priority is High', exact: true })).toBeFocused();

    // The chip opens its picker again, its value ticked; a second value asks for either.
    await page.getByRole('button', { name: 'Priority is High', exact: true }).click();
    await expect(priority.locator('input[data-value="high"]')).toBeChecked();
    await priority.locator('input[data-value="urgent"]').check();
    await priority.getByRole('button', { name: /^Show/ }).click();
    await expect(page.locator('.applist-chip', { hasText: 'Priority is Urgent or High' })).toBeVisible();
    await expect.poll(() => address(page)).toBe('/issues?priority=urgent,high');
    await expect(count(page)).toHaveText(
      many(scalar(sample.db, `SELECT count(*) FROM issue WHERE ${ACTIVE} AND priority IN ('urgent', 'high')`)),
    );

    // A reference is picked by name from its typeahead; the chip says the name, the address the id.
    await page.getByRole('button', { name: 'Filter by Assignee' }).click();
    const assignee = picker(page, 'Assignee').getByRole('combobox', { name: 'Filter by Assignee' });
    await expect(assignee).toBeFocused();
    await assignee.fill('Maya');
    await page.locator('.dd-popup .dd-option', { hasText: 'Maya Chen' }).click();
    const maya = scalar(sample.db, "SELECT id FROM member WHERE name = 'Maya Chen'");
    await expect(page.locator('.applist-chip', { hasText: 'Assignee is Maya Chen' })).toBeVisible();
    await expect.poll(() => address(page)).toBe(`/issues?priority=urgent,high&assignee_id=${maya}`);
    await expect(count(page)).toHaveText(
      many(scalar(sample.db, `SELECT count(*) FROM issue WHERE ${ACTIVE} AND priority IN ('urgent', 'high') AND assignee_id = ?`, maya)),
    );
    await expect(page.getByRole('button', { name: 'Clear all' })).toHaveCount(1);

    // × takes one out, the rest stand, and the focus is on the "+" that took its place.
    await page.getByRole('button', { name: 'Remove Assignee is Maya Chen' }).click();
    await expect.poll(() => address(page)).toBe('/issues?priority=urgent,high');
    await expect(page.getByRole('button', { name: 'Filter by Assignee' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Clear all' })).toHaveCount(0);

    // The search is the second: Enter asks, its words stay in its box, and Clear all empties the row, not the tab.
    const search = page.getByRole('searchbox', { name: 'Filter by Name' });
    await search.fill('focus');
    await search.press('Enter');
    await expect(count(page)).toHaveText(
      many(scalar(sample.db, `SELECT count(*) FROM issue WHERE ${ACTIVE} AND priority IN ('urgent', 'high') AND name LIKE '%focus%'`)),
    );
    await expect(search).toHaveValue('focus');
    await page.getByRole('button', { name: 'Clear all' }).click();
    await expect.poll(() => address(page)).toBe('/issues');
    await expect(chips(page)).toHaveCount(0);
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    await expect(page.getByRole('tab', { name: /^Active/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('the keyboard reaches each control: Enter and Space open a picker, Escape gives the focus back, Backspace removes a chip', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 924 });
    await issues(page);
    await page.getByRole('searchbox', { name: 'Filter by Name' }).focus();
    for (const label of ['Status', 'Priority', 'Tags', 'Assignee']) {
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: `Filter by ${label}` })).toBeFocused();
    }
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    const priority = picker(page, 'Priority');
    await expect(priority.locator('input[data-value="urgent"]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(priority).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Filter by Priority' })).toBeFocused();

    await page.keyboard.press('Space');
    await expect(priority.locator('input[data-value="urgent"]')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(priority.locator('input[data-value="urgent"]')).toBeChecked();
    await priority.getByRole('button', { name: /^Show/ }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => address(page)).toBe('/issues?priority=urgent');
    const chip = page.getByRole('button', { name: 'Priority is Urgent', exact: true });
    await expect(chip).toBeFocused();
    // The house ring on the chip, as on every control.
    await expect(chip).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Backspace');
    await expect.poll(() => address(page)).toBe('/issues');
    await expect(page.getByRole('button', { name: 'Filter by Priority' })).toBeFocused();
  });

  test('390px: Filters opens the sheet; chips wrap inside the window under the search, and the tabs keep a row of their own', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await issues(page);
    const search = page.getByRole('searchbox', { name: 'Filter by Name' });
    await expect(search).toBeVisible();
    const controls = page.locator('.applist-controls');
    /* The tabs have a row of their own under the search, every one in sight: sharing the row, the first tab's
       count was cut off and the next was past the edge. */
    const tabs = controls.getByRole('tablist');
    const [searchBox, tabRow] = [(await search.boundingBox())!, (await tabs.boundingBox())!];
    expect(tabRow.y).toBeGreaterThanOrEqual(searchBox.y + searchBox.height);
    expect(tabRow.x).toBeGreaterThanOrEqual(0);
    expect(tabRow.x + tabRow.width).toBeLessThanOrEqual(390);
    const first = (await tabs.getByRole('tab').first().boundingBox())!;
    expect(first.x + first.width).toBeLessThanOrEqual(390);
    const before = (await controls.boundingBox())!;
    await expect(page.getByRole('button', { name: 'Filter by Priority' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Filters' });
    // The sheet holds the pickers, not a second search.
    await expect(sheet.getByRole('group', { name: 'Priority' })).toBeVisible();
    await expect(sheet.getByRole('searchbox')).toHaveCount(0);
    await sheet.getByRole('group', { name: 'Priority' }).getByRole('checkbox', { name: /^High/ }).check();
    await sheet.getByRole('button', { name: /^Show \d/ }).click();
    await expect.poll(() => address(page)).toBe('/issues?priority=high');
    await expect(count(page)).toHaveText(many(scalar(sample.db, `SELECT count(*) FROM issue WHERE ${ACTIVE} AND priority = 'high'`)));
    await expect(page.getByRole('button', { name: 'Filters · 1' })).toBeVisible();
    const chip = page.locator('.applist-chip', { hasText: 'Priority is High' });
    await expect(chip).toBeVisible();
    /* With a filter applied, Save view… joins the search row and the chips wrap onto a row of their own (a strip
       wraps on a phone rather than scrolling sideways, docs/design.md "Standing layout rules"). They must stay in
       the window, clear of the search, and leave no sideways scroll. */
    const [box, pill] = [(await search.boundingBox())!, (await chip.boundingBox())!];
    expect(pill.x).toBeGreaterThanOrEqual(0);
    expect(pill.x + pill.width).toBeLessThanOrEqual(390);
    expect(pill.y).toBeGreaterThanOrEqual(box.y + box.height);
    const withChip = (await controls.boundingBox())!;
    expect(pill.y + pill.height).toBeLessThanOrEqual(withChip.y + withChip.height + 1);
    // The tabs keep their row under the chips, none of it overlapping.
    expect((await tabs.boundingBox())!.y).toBeGreaterThanOrEqual(pill.y + pill.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    // On a phone a chip's words open the sheet; its × still takes it out.
    await chip.locator('.applist-chip-open').click();
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await chip.getByRole('button', { name: 'Remove Priority is High' }).click();
    await expect.poll(() => address(page)).toBe('/issues');
    // The bar returns to the height it had: the chip row leaves nothing behind.
    await expect.poll(async () => Math.abs((await controls.boundingBox())!.height - before.height)).toBeLessThan(1);
    await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeVisible();
  });
});
