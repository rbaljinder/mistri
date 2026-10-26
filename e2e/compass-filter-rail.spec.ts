import { COMPASS, expect, type Page, test } from './support/ownServers';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

const CRM = COMPASS;

/* Compass's Tasks list is worked by narrowing, so its filters are a rail of
   counted facets beside the rows (filterBar: 'rail'). Every facet writes the
   query the address carries: that is what these tests hold it to. */
async function allTasks(page: Page) {
  await page.goto(`${CRM}/task`);
  await page.getByRole('tab', { name: /^All/ }).click();
  await expect(page.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');
  return page.getByRole('complementary', { name: 'Tasks filters' });
}

test('ticked values narrow the rows, say so as a chip, survive a reload, and clear', async ({ page }) => {
  const rail = await allTasks(page);
  const count = page.locator('.applist-count');
  await expect(count).toHaveText(/\d/);
  const everything = await count.innerText();
  const status = rail.getByRole('group', { name: 'Status' });
  // Every value of the vocabulary, each with its count.
  await expect(status.getByRole('checkbox', { name: /^Open \d/ })).toBeVisible();
  await expect(status.getByRole('checkbox', { name: /^Done \d/ })).toBeVisible();

  await status.getByRole('checkbox', { name: /^Open/ }).check();
  await expect(page.locator('.applist-chip', { hasText: 'Status is Open' })).toBeVisible();
  await expect(count).not.toHaveText(everything);
  // The redraw hands focus back to the very box that was ticked.
  await expect(status.getByRole('checkbox', { name: /^Open/ })).toBeFocused();

  // Open or done is every task: two ticks are an `in`, and the whole list again.
  await status.getByRole('checkbox', { name: /^Done/ }).check();
  await expect(page.locator('.applist-chip', { hasText: 'Status is Open or Done' })).toBeVisible();
  await expect(count).toHaveText(everything);

  // The address is the selection.
  await page.reload();
  await expect(rail.getByRole('group', { name: 'Status' }).getByRole('checkbox', { name: /^Done/ })).toBeChecked();

  await rail.getByRole('checkbox', { name: /^Urgent/ }).check();
  await expect(page.locator('.applist-chip', { hasText: 'Urgent' })).toBeVisible();
  // Beside the rows, the chips head the results and carry the one Clear all.
  await page.getByRole('group', { name: 'Tasks filters applied' }).getByRole('button', { name: 'Clear all' }).click();
  await expect(page.locator('.applist-chip')).toHaveCount(0);
  await expect(count).toHaveText(everything);
});

test('a date takes a preset, an owner is ticked by name, and a facet clears on its own', async ({ page }) => {
  const rail = await allTasks(page);
  const due = rail.getByRole('group', { name: 'Due' });
  /* A choice facet's legend, its Clear and its values each keep their own
     line: Clear once sat on the first value, and a fix for that once
     squeezed the values to nothing beside a floated legend. */
  await due.getByRole('radio', { name: 'Next 7 days' }).check();
  const clear = await due.getByRole('button', { name: 'Clear Due' }).boundingBox();
  const option = await due.locator('.facet-option').first().boundingBox();
  const label = await due.locator('.facet-option-label').first().boundingBox();
  expect(clear!.y + clear!.height).toBeLessThanOrEqual(option!.y + 1);
  expect(label!.width).toBeGreaterThan(40);
  await expect(page.locator('.applist-chip', { hasText: 'Due in the next 7 days' })).toBeVisible();

  // An owner is said by name, the most tasks first; the query says the id.
  const owner = rail.getByRole('group', { name: 'Owner' });
  const first = owner.getByRole('checkbox').first();
  const name = (await first.locator('xpath=..').locator('.facet-option-label').innerText()).trim();
  await first.check();
  await expect(page.locator('td').filter({ hasText: name }).first()).toBeVisible();
  // The chip says the owner by name too, never the id the query holds.
  await expect(page.locator('.applist-chip', { hasText: `Owner is ${name}` })).toBeVisible();

  await due.getByRole('button', { name: 'Clear Due' }).click();
  await expect(page.locator('.applist-chip', { hasText: 'Due in' })).toHaveCount(0);
  await expect(page.locator('.applist-chip', { hasText: 'Owner is' })).toBeVisible();
});

/* An App's reader never wrote the query language, so nothing says it back to
   them: not a chip, a facet's note, the empty list, a column menu or a saved
   view's name. The address may carry it (`q=`); the page says it in words. */
test('a question no facet can draw is said in words everywhere the list says it', async ({ page }) => {
  const asked = (text: string) => `${CRM}/tasks?q=${encodeURIComponent(text)}`;
  await page.goto(asked('status != done and account_id.name contains zzzz'));
  const rail = page.getByRole('complementary', { name: 'Tasks filters' });
  await expect(rail.getByRole('group', { name: 'Status' }).locator('.facet-note')).toHaveText('Status is not Done');
  const applied = page.getByRole('group', { name: 'Tasks filters applied' });
  await expect(applied.locator('.applist-chip-text')).toHaveText(['Status is not Done', 'Account contains “zzzz”']);
  await expect(page.locator('.list-no-matches')).toContainText('No tasks match Status is not Done and Account contains “zzzz”.');
  const said = await page.locator('.app-content, main').first().innerText();
  expect(said).not.toMatch(/!=|account_id|status =|contains zzzz/);

  // The column menu's Clear filter says what it takes off.
  await page.goto(asked('status != done'));
  await page.getByRole('button', { name: 'Status column options' }).click();
  await expect(page.getByRole('menuitem', { name: 'Clear filter: Status is not Done' })).toBeVisible();
  await page.keyboard.press('Escape');

  // A view is named for its question until the reader names it.
  await page.getByRole('button', { name: 'Save view…' }).click();
  await expect(page.getByRole('dialog').getByLabel('Name')).toHaveValue('Status is not Done');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
});

test('a reader keeps the question as a saved view, renames it, and removes it', async ({ page }) => {
  const rail = await allTasks(page);
  await rail.getByRole('checkbox', { name: /^Urgent/ }).check();
  await expect(page.locator('.applist-chip', { hasText: 'Urgent' })).toBeVisible();

  await page.getByRole('button', { name: 'Save view…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Save this view');
  await dialog.getByLabel('Name').fill('Urgent');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const view = page.getByRole('tab', { name: /^Urgent/ });
  await expect(view).toHaveAttribute('aria-selected', 'true');
  // Compass signs nobody in, so its list is the one every reader shares.
  await expect(page.locator('.tab-group-label')).toHaveText('Saved views');

  // Kept by the server: back on the plain list, the view is still there and opens its question.
  await allTasks(page);
  await page.getByRole('tab', { name: /^Urgent/ }).click();
  await expect(page.locator('.applist-chip', { hasText: 'Urgent' })).toBeVisible();

  await page.getByRole('button', { name: 'Rename view…' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Hot');
  await page.getByRole('dialog').getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByRole('tab', { name: /^Hot/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Remove the view "Hot"' }).click();
  await expect(page.getByRole('tab', { name: /^Hot/ })).toHaveCount(0);
});

test('on a phone the rail is a Filters sheet, applied by one button', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${CRM}/task`);
  await expect(page.getByRole('complementary', { name: 'Tasks filters' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Filters' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('checkbox', { name: /^Urgent/ }).check();
  // A draft: nothing under the sheet has changed yet.
  await expect(page.locator('.applist-chip', { hasText: 'Urgent' })).toHaveCount(0);
  // Show N applies the draft; a facet's own "Show all" only lengthens its list.
  await sheet.getByRole('button', { name: /^Show \d/ }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('.applist-chip', { hasText: 'Urgent' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Filters · 1', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
