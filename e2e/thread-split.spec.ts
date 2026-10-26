import { expect, test, type Page } from './support/harness';
import { startSample } from './support/sampleServer';
import { scalar } from './support/db';

/**
 * Thread's Updates and Inbox entries are split lists (preview): choosing a
 * row keeps a bounded list beside it and reads the whole record in the
 * detail pane. The selected row is the address — `…/{id}` after the list's key —
 * so a click, the grid's own Enter and a pasted link all land on one
 * surface. Inbox shares its table with Issues and is told apart by its id.
 */
const issueOf = (db: string, id: number) =>
  String(scalar(db, 'SELECT i.name FROM comment c JOIN issue i ON i.id = c.issue_id WHERE c.id = ?', id));
const nameOf = (db: string, id: number) => String(scalar(db, 'SELECT name FROM issue WHERE id = ?', id));
/* The description's first line — the issue's own sentence; the rest is shared boilerplate. */
const summaryOf = (db: string, id: number) => String(scalar(db, 'SELECT description FROM issue WHERE id = ?', id)).split('\n')[0];
const bodyOf = (db: string, id: number) => String(scalar(db, 'SELECT body FROM comment WHERE id = ?', id));
/* A list with no sort of its own reads newest first (schema.ts defaultOrder),
   so the newest row is on its first page; the split's own list holds 25. */
const newest = (db: string, table: 'issue' | 'comment') => Number(scalar(db, `SELECT max(id) FROM ${table}`));
/* The row's id follows the list's key: read it off the end. */
const selected = (page: Page) => Number(new URL(page.url()).pathname.match(/\/(\d+)$/)?.[1]);

test.describe('Thread split list', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.setTimeout(60_000);
  test.beforeEach(async () => {
    sample = await startSample('thread');
  });
  test.afterEach(async () => {
    await sample?.stop();
  });

  test('the list and the detail paint side by side, and a click or the keyboard moves the detail', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 924 });
    await page.goto(`${sample.origin}/`);
    await page
      .locator('.sidebar')
      .getByRole('button', { name: /^Updates/ })
      .click();
    await expect(page.locator('.applist-title')).toHaveText('Updates');
    const firstIssue = issueOf(sample.db, newest(sample.db, 'comment'));
    // Issues can be selected in bulk, so a row's first cell is its checkbox: open it by a value.
    await page
      .getByRole('row')
      .filter({ hasText: firstIssue })
      .first()
      .getByRole('gridcell')
      .filter({ hasNot: page.getByRole('checkbox') })
      .first()
      .click();

    const list = page.getByRole('region', { name: 'Updates list' });
    const detail = page.getByRole('complementary', { name: 'Updates details' });
    await expect(list.getByRole('row').filter({ hasText: firstIssue }).first()).toBeVisible();
    await expect(detail.locator('.split-list-detail-title')).toHaveText('Update');
    const opened = selected(page);
    expect(opened).toBeGreaterThan(0);
    await expect(detail).toContainText(issueOf(sample.db, opened));
    await expect(detail).toContainText(bodyOf(sample.db, opened));
    // The list is the split's own bounded list: 25 at most, beside the detail.
    expect(await list.locator('tr[data-row]').count()).toBeLessThanOrEqual(25);

    // A click in the list moves the detail and keeps the list.
    const target = 3;
    await list
      .getByRole('row')
      .filter({ hasText: issueOf(sample.db, target) })
      .first()
      .getByRole('gridcell')
      .filter({ hasNot: page.getByRole('checkbox') })
      .first()
      .click();
    await expect.poll(() => selected(page)).not.toBe(opened);
    const clicked = selected(page);
    await expect(detail).toContainText(issueOf(sample.db, clicked));
    await expect(detail).toContainText(bodyOf(sample.db, clicked));
    await expect(list).toBeVisible();

    // The grid is one tab stop: focusing it puts the cursor on the first row,
    // ArrowDown moves it, and Enter opens that row into the same detail pane.
    const grid = list.getByRole('grid');
    await grid.focus();
    await page.keyboard.press('ArrowDown');
    const cursorRow = list.locator('tr[data-row="1"]');
    await expect(cursorRow.locator('.cell-cursor')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => selected(page)).not.toBe(clicked);
    await expect(detail).toContainText(issueOf(sample.db, selected(page)));
    await expect(detail).toContainText(bodyOf(sample.db, selected(page)));

    // Closing the detail returns to the split's list question, not a new step.
    await detail.getByRole('button', { name: 'Close update' }).click();
    await expect(page.locator('.applist-title')).toHaveText('Updates');
    await expect.poll(() => new URL(page.url()).pathname).not.toMatch(/\/\d+$/);
  });

  /* The pane is the App's record, not the workbench's: one head (the kind,
     the place in the list, the full page, Close), the record's name as its
     heading, the split's authored fields — and none of the database's words. */
  test("Inbox at 1440: the detail is the App's record beside the list, with its place, Details and Close", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 924 });
    // Opened from the list, so the record knows its place in it (a pasted link has none).
    await page.goto(`${sample.origin}/`);
    await page
      .locator('.sidebar')
      .getByRole('button', { name: /^Inbox/ })
      .click();
    await expect(page.locator('.applist-title')).toHaveText('Inbox');
    const id = newest(sample.db, 'issue');
    await page
      .locator('.queue-pick')
      .filter({ hasText: nameOf(sample.db, id) })
      .first()
      .click();
    await expect.poll(() => selected(page)).toBe(id);
    const list = page.getByRole('region', { name: 'Inbox list' });
    const detail = page.getByRole('complementary', { name: 'Inbox details' });
    await expect(detail).toContainText(summaryOf(sample.db, id));
    // Beside, not under: the pane starts at the list's right and level with it.
    const listBox = await list.boundingBox();
    const detailBox = await detail.boundingBox();
    expect(detailBox!.x).toBeGreaterThanOrEqual(listBox!.x + listBox!.width - 1);
    expect(Math.abs(detailBox!.y - listBox!.y)).toBeLessThan(80);
    await expect(detail.locator('.split-list-detail-title')).toHaveText('Issue');
    await expect(detail.getByRole('navigation', { name: 'Records in this list' })).toContainText(/\d+ of \d+/);
    await expect(detail.getByRole('button', { name: 'Details →' })).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Close issue' })).toBeVisible();
    await expect(detail.getByRole('heading', { level: 1 })).toContainText(nameOf(sample.db, id));
    for (const word of ['Copy for agent', 'As a page →', 'REQUIRED', 'Layout']) {
      await expect(detail.getByText(word, { exact: true })).toHaveCount(0);
    }
    // Details opens the App's page for the record.
    await detail.getByRole('button', { name: 'Details →' }).click();
    // The issue's own address: under Issues, the view that shows issues.
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/issues/${id}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(nameOf(sample.db, id));
  });

  test('a link to a selected update restores it beside its list', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 924 });
    const id = 4;
    await page.goto(`${sample.origin}/comment/~${id}`);
    const detail = page.getByRole('complementary', { name: 'Updates details' });
    await expect(detail.locator('.split-list-detail-title')).toHaveText('Update');
    await expect(detail).toContainText(issueOf(sample.db, id));
    await expect(detail).toContainText(bodyOf(sample.db, id));
    await expect(page.getByRole('region', { name: 'Updates list' }).locator('tr[data-row]').first()).toBeVisible();
    expect(selected(page)).toBe(id);
  });

  /* Inbox is a second entry over `issue`, beside Issues: the same question
     of the same rows, told apart only by its `id`, which is the list's
     address — `/inbox`, and `/inbox/7` with a pick. */
  test('Inbox: the list and the detail paint side by side, and a click or the keyboard moves the detail', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 924 });
    await page.goto(`${sample.origin}/`);
    await page
      .locator('.sidebar')
      .getByRole('button', { name: /^Inbox/ })
      .click();
    await expect(page.locator('.applist-title')).toHaveText('Inbox');
    await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe('/inbox');
    await expect(page.locator('.sidebar button[aria-current="true"]')).toHaveText(/^Inbox/);
    const first = newest(sample.db, 'issue');
    await page
      .locator('.queue-pick')
      .filter({ hasText: nameOf(sample.db, first) })
      .first()
      .click();

    const list = page.getByRole('region', { name: 'Inbox list' });
    const detail = page.getByRole('complementary', { name: 'Inbox details' });
    await expect(detail.locator('.split-list-detail-title')).toHaveText('Issue');
    await expect.poll(() => selected(page)).toBe(first);
    await expect(detail).toContainText(nameOf(sample.db, first));
    await expect(detail).toContainText(summaryOf(sample.db, first));
    // The view says how a row reads, so the list is picks (name, assignee, status, priority), not table rows.
    await expect(list.locator('.queue-pick').first()).toBeVisible();
    expect(await list.locator('.queue-pick').count()).toBeLessThanOrEqual(25);
    await expect(list.locator('.queue-pick[aria-current="true"]')).toHaveCount(1);
    expect(new URL(page.url()).pathname).toBe(`/inbox/${first}`);
    // Still the Inbox's room: the menu row, not Issues', is lit.
    await expect(page.locator('.sidebar button[aria-current="true"]')).toHaveText(/^Inbox/);

    // A second click inside the split moves the detail and keeps the list: its 25 reach past the plain list's first page.
    await list
      .locator('.queue-pick')
      .filter({ hasText: nameOf(sample.db, 3) })
      .first()
      .click();
    await expect.poll(() => selected(page)).toBe(3);
    await expect(detail).toContainText(summaryOf(sample.db, 3));
    await expect(list).toBeVisible();
    await expect(page.locator('.record-modal')).toHaveCount(0);

    // A pick is a button: Enter on a focused one opens it into the same pane.
    await list.locator('.queue-pick').nth(1).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => selected(page)).not.toBe(3);
    const entered = selected(page);
    await expect(detail).toContainText(nameOf(sample.db, entered));
    await expect(detail).toContainText(summaryOf(sample.db, entered));
    await expect(list).toBeVisible();

    await detail.getByRole('button', { name: 'Close issue' }).click();
    await expect(page.locator('.applist-title')).toHaveText('Inbox');
    await expect.poll(() => new URL(page.url()).pathname).not.toMatch(/\/\d+$/);
    // Closed, the list half's own show and page size are still the view as it opens: its key alone.
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/inbox');
  });

  for (const width of [1440, 390]) {
    test(`Inbox, ${width}px: a link to a selected issue restores it beside the Inbox list`, async ({ page }) => {
      await page.setViewportSize({ width, height: 924 });
      const id = 7;
      // The address a walk wrote before lists were said in words still opens, and reads as one.
      await page.goto(`${sample.origin}/inbox:issue/~${id}`);
      const detail =
        width > 760 ? page.getByRole('complementary', { name: 'Inbox details' }) : page.getByRole('dialog', { name: 'Inbox details' });
      await expect(detail).toContainText(nameOf(sample.db, id));
      await expect(detail).toContainText(summaryOf(sample.db, id));
      expect(selected(page)).toBe(id);
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/inbox/${id}`);
      if (width > 760) {
        await expect(page.getByRole('region', { name: 'Inbox list' }).locator('.queue-pick').first()).toBeVisible();
      } else {
        // The dialog holds the list inert behind it; closed, the Inbox list is the room.
        await detail.getByRole('button', { name: 'Close issue' }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(page.locator('.applist-title')).toHaveText('Inbox');
        // A phone draws the same picks, full width.
        await expect(
          page
            .locator('.applist-host .queue-pick')
            .filter({ hasText: nameOf(sample.db, newest(sample.db, 'issue')) })
            .first(),
        ).toBeVisible();
        expect(new URL(page.url()).pathname).toBe('/inbox');
      }
    });
  }

  test('Issues, beside the Inbox, still opens its plain list, its modal and its record page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 924 });
    await page.goto(`${sample.origin}/`);
    await page
      .locator('.sidebar')
      .getByRole('button', { name: /^Issues/ })
      .click();
    await expect(page.locator('.applist-title')).toHaveText('Issues');
    expect(new URL(page.url()).pathname).toBe('/issues');
    await expect(page.locator('.sidebar button[aria-current="true"]')).toHaveText(/^Issues/);
    await expect(page.getByRole('complementary', { name: /details$/ })).toHaveCount(0);
    const name = nameOf(sample.db, 2);
    await page.locator('.applist-grid').getByRole('gridcell', { name, exact: true }).click();
    const modal = page.locator('.record-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(name);
    await expect(page.getByRole('complementary', { name: 'Inbox details' })).toHaveCount(0);
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal).toHaveCount(0);

    // A link to the row with no entry in it is Issues', as it always was: the page.
    await page.goto(`${sample.origin}/issue/~2`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(name);
    await expect.poll(() => new URL(page.url()).pathname).toBe('/issues/2');
    await expect(page.getByRole('complementary', { name: 'Inbox details' })).toHaveCount(0);
  });

  test('390px: the same link opens the detail as a dialog over the list', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 924 });
    const id = 5;
    await page.goto(`${sample.origin}/comment/~${id}`);
    const dialog = page.getByRole('dialog', { name: 'Updates details' });
    await expect(dialog).toContainText(bodyOf(sample.db, id));
    await expect(dialog).toContainText(issueOf(sample.db, id));
    await dialog.getByRole('button', { name: 'Close update' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.applist-title')).toHaveText('Updates');
  });
});
