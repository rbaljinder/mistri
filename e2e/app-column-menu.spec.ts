import { COMPASS, expect, type Page, test } from './support/ownServers';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

/* An App list's column menu is short: two sorts in the column's words, one
   Filter… that opens the rail's own control for the column, Clear filter
   while there is one, Pin column. The Workbench's power menu is not here. */
const header = (page: Page, label: string) => page.getByRole('button', { name: `${label} column options` });

async function menu(page: Page, label: string) {
  await header(page, label).click();
  const open = page.getByRole('menu');
  await expect(open).toBeVisible();
  return open;
}

test("a column menu has at most five entries in words, and Filter… narrows through the rail's control", async ({ page }) => {
  await page.goto(`${COMPASS}/opportunities`);
  await page.getByRole('tab', { name: /^All/ }).click();
  await expect(page.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');
  const count = page.locator('.applist-count');
  await expect(count).toHaveText(/\d/);
  const everything = await count.innerText();

  const stage = await menu(page, 'Stage');
  const entries = stage.getByRole('menuitem');
  expect(await entries.count()).toBeLessThanOrEqual(5);
  await expect(entries.last()).toHaveText('Pin column');
  // No language beside the entries, and none of the Workbench's typed conditions.
  await expect(stage).not.toContainText('=');
  await expect(stage).not.toContainText('equals');

  await stage.getByRole('menuitem', { name: 'Filter…' }).click();
  const pop = page.getByRole('dialog', { name: 'Filter by Stage' });
  // The focus is in the popover, on its first choice.
  await expect(pop.getByRole('checkbox').first()).toBeFocused();
  // Not a stage a tab already says: the tab would say it, not a chip.
  await pop.getByRole('checkbox', { name: /^Negotiation/ }).check();
  // One button, saying what it will show; the popover's live count says it to a screen reader too.
  await expect(pop.getByRole('status')).toHaveText(/\d+ match/);
  await pop.getByRole('button', { name: /^Show \d/ }).click();
  await expect(page.locator('.applist-chip', { hasText: 'Stage is Negotiation' })).toBeVisible();
  await expect(count).not.toHaveText(everything);
  // The focus comes back to the ⌄ the choice was made from.
  await expect(header(page, 'Stage')).toBeFocused();

  // Filtered, the menu offers its way out.
  await (await menu(page, 'Stage')).getByRole('menuitem', { name: 'Clear filter' }).click();
  await expect(page.locator('.applist-chip', { hasText: 'Stage is' })).toHaveCount(0);
  await expect(count).toHaveText(everything);

  // A figure sorts Low → high, and then that entry is not offered again.
  await (await menu(page, 'Amount')).getByRole('menuitem', { name: 'Low → high' }).click();
  await expect(page).toHaveURL(/sort=amount/);
  const again = await menu(page, 'Amount');
  await expect(again.getByRole('menuitem', { name: 'High → low' })).toBeVisible();
  await expect(again.getByRole('menuitem', { name: 'Low → high' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(header(page, 'Amount')).toBeFocused();
});

test('beside a rail, Filter… goes to the facet; the rail and the menu say one filter alike', async ({ page }) => {
  await page.goto(`${COMPASS}/task`);
  await page.getByRole('tab', { name: /^All/ }).click();
  const rail = page.getByRole('complementary', { name: 'Tasks filters' });
  const priority = rail.getByRole('group', { name: 'Priority' });
  await expect(priority.getByRole('checkbox').first()).toBeVisible();

  // Set in the rail: the column menu knows, and clears it.
  await priority.getByRole('checkbox').first().check();
  await expect(page.locator('.applist-chip', { hasText: 'Priority is' })).toBeVisible();
  const menuNow = await menu(page, 'Priority');
  await expect(menuNow.getByRole('menuitem', { name: 'Clear filter' })).toBeVisible();
  // Filter… does not draw a second control over the rail's: it goes to the facet.
  await menuNow.getByRole('menuitem', { name: 'Filter…' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(priority.getByRole('checkbox').first()).toBeFocused();
  await (await menu(page, 'Priority')).getByRole('menuitem', { name: 'Clear filter' }).click();
  await expect(page.locator('.applist-chip', { hasText: 'Priority is' })).toHaveCount(0);
  await expect(priority.getByRole('checkbox').first()).not.toBeChecked();
});

test("where the rail is a sheet, the menu's popover and the sheet are one control", async ({ page }) => {
  // Narrower than a rail beside the rows, wider than a phone's cards: the headers stay, the rail is a sheet.
  await page.setViewportSize({ width: 820, height: 900 });
  await page.goto(`${COMPASS}/task`);
  await page.getByRole('tab', { name: /^All/ }).click();
  await expect(page.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');

  // Set from the menu's popover, it reads back ticked in the sheet.
  await (await menu(page, 'Priority')).getByRole('menuitem', { name: 'Filter…' }).click();
  const pop = page.getByRole('dialog', { name: 'Filter by Priority' });
  await pop.getByRole('checkbox', { name: /^3/ }).check();
  await pop.getByRole('button', { name: /^Show/ }).click();
  await expect(page.locator('.applist-chip', { hasText: 'Priority is 3' })).toBeVisible();
  await page.getByRole('button', { name: /^Filters/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Filters' });
  await expect(sheet.getByRole('group', { name: 'Priority' }).getByRole('checkbox', { name: /^3/ })).toBeChecked();

  // Set in the sheet, it reads back chosen in the menu's popover.
  await sheet.getByRole('group', { name: 'Due' }).getByRole('radio', { name: 'Next 7 days' }).check();
  await sheet.getByRole('button', { name: /^Show \d/ }).click();
  await expect(page.locator('.applist-chip', { hasText: 'Due in the next 7 days' })).toBeVisible();
  await (await menu(page, 'Due')).getByRole('menuitem', { name: 'Filter…' }).click();
  await expect(page.getByRole('dialog', { name: 'Filter by Due' }).getByRole('radio', { name: 'Next 7 days' })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(header(page, 'Due')).toBeFocused();

  // The rarer conditions sit behind one quiet disclosure, and say themselves in words.
  await (await menu(page, 'Task')).getByRole('menuitem', { name: 'Filter…' }).click();
  const task = page.getByRole('dialog', { name: 'Filter by Task' });
  await expect(task.getByRole('radio', { name: 'Starts with' })).toHaveCount(0);
  await task.getByRole('button', { name: 'More conditions' }).click();
  await task.getByRole('radio', { name: 'Starts with' }).check();
  await task.getByRole('textbox', { name: 'Starts with' }).fill('Call');
  await page.keyboard.press('Enter');
  await expect(page.locator('.applist-chip', { hasText: 'Task starts with “Call”' })).toBeVisible();
});
