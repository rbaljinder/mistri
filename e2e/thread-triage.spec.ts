import { expect, test, type Page } from './support/harness';
import { startSample } from './support/sampleServer';
import { rows, scalar } from './support/db';

/**
 * Thread's Triage queue and cycle Board: the two list presentations that
 * write, each through the ordinary update route one record at a time. The
 * seed's statuses cycle in_progress, ready, in_review, backlog, done, ready
 * over ids 1–24, so ready issues are 2, 6, 8, 12, 14, 18, 20, 24 and backlog
 * issues are 4, 10, 16, 22; cycle 1 holds ids 1–15. The queue has no sort
 * of its own, so it reads newest first: …, 8, 6, 4, 2.
 */
const title = (db: string, id: number) => String(scalar(db, 'SELECT name FROM issue WHERE id=?', id));
const status = (db: string, id: number) => String(scalar(db, 'SELECT status FROM issue WHERE id=?', id));

async function openEntry(page: Page, width: number, label: string) {
  if (width > 900)
    await page
      .locator('.sidebar')
      .getByRole('button', { name: new RegExp(`^${label}`) })
      .click();
  else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    // Sidebar Apps keep the same navigation buttons in the phone drawer.
    await page.getByRole('dialog', { name: 'Thread navigation', exact: true }).getByRole('button', { name: label, exact: true }).click();
  }
  await expect(page.locator('.applist-title')).toHaveText(label);
}

test.describe('Thread triage queue and board', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.setTimeout(60_000);
  test.beforeEach(async () => {
    sample = await startSample('thread');
  });
  test.afterEach(async () => {
    await sample?.stop();
  });

  for (const width of [1440, 390]) {
    test(`${width}px: a keyboard selection applies one bulk action per issue and reports each result`, async ({ page }) => {
      await page.setViewportSize({ width, height: 924 });
      await page.goto(`${sample.origin}/`);
      await openEntry(page, width, 'Triage');
      const queue = page.getByRole('grid', { name: 'Triage' });
      await expect(queue).toBeVisible();
      const listed = rows<{ id: number }>(sample.db, "SELECT id FROM issue WHERE status IN ('backlog','ready') ORDER BY id");
      await expect(queue.getByRole('row')).toHaveCount(listed.length);
      const toolbar = page.getByRole('toolbar', { name: 'Selected records' });
      // Nothing chosen, nothing to do: the verbs appear with the first selection.
      await expect(toolbar).toHaveCount(0);

      // Two ready issues and one backlog issue: the when-guarded action reaches only the ready ones.
      const updates: unknown[] = [];
      page.on('request', (request) => {
        if (request.url().endsWith('/api/update')) updates.push(request.postDataJSON());
      });
      const first = queue.getByRole('row', { name: new RegExp(title(sample.db, 6)) });
      await first.click();
      await first.focus();
      await page.keyboard.press('Shift+ArrowDown'); // id 4 (backlog)
      await page.keyboard.press('Shift+ArrowDown'); // id 2 (ready)
      await expect(toolbar).toContainText('3 selected');
      await toolbar.getByRole('button', { name: 'Start work', exact: true }).click();
      const result = page.locator('.queue-result');
      await expect(result).toContainText('Start work: 2 applied, 1 not written.');
      await expect(result).toContainText(`${title(sample.db, 4)}: Does not match "status = ready" now.`);
      await expect(result).toHaveAttribute('role', 'status');
      expect(status(sample.db, 2)).toBe('in_progress');
      expect(status(sample.db, 6)).toBe('in_progress');
      expect(status(sample.db, 4)).toBe('backlog');
      expect(updates).toHaveLength(2);
      expect(updates.map((body) => (body as { key: { id: number } }).key.id).sort()).toEqual([2, 6]);
      // The started issues left the queue's standing question; the selection kept only what is still here.
      await expect(queue.getByRole('row')).toHaveCount(listed.length - 2);
      await expect(toolbar).toContainText('1 selected');

      // Cancelling asks why, and a reason is one issue's: the selection is not offered it.
      await expect(toolbar.getByRole('button', { name: 'Cancel issue', exact: true })).toHaveCount(0);
      expect(status(sample.db, 4)).toBe('backlog');
      expect(updates).toHaveLength(2);

      // Open keeps the queue mounted underneath the modal and does not touch the selection.
      const queueNode = await queue.elementHandle();
      await queue.getByRole('button', { name: `Open ${title(sample.db, 4)}`, exact: true }).click();
      const modal = page.locator('.record-modal');
      await expect(modal).toBeVisible();
      await modal.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(modal).toHaveCount(0);
      expect(await queueNode!.evaluate((node) => node.isConnected)).toBe(true);
      await expect(toolbar).toContainText('1 selected');
    });
  }

  for (const width of [1440, 390]) {
    test(`${width}px: the Issues grid selects all from the header row's checkbox, which has no label or count`, async ({ page }) => {
      await page.setViewportSize({ width, height: 924 });
      await page.goto(`${sample.origin}/issues`);
      await expect(page.locator('.applist-title')).toHaveText('Issues');
      // A phone reads the list as record summaries; the grid is one press away.
      if (width < 760) await page.getByRole('button', { name: 'Table', exact: true }).click();
      const boxes = page.locator('tbody .row-select');
      await expect(boxes.first()).toBeVisible();
      const loaded = await boxes.count();
      const all = page.getByRole('columnheader').getByRole('checkbox', { name: 'Select all issues', exact: true });
      const toolbar = page.getByRole('toolbar', { name: 'Selected records' });
      await expect(all).toBeVisible();
      await expect(page.getByText(/^Select all/)).toHaveCount(0);
      // Level with the rows' boxes, in the same column.
      const [head, row] = await Promise.all([all.boundingBox(), boxes.first().boundingBox()]);
      expect(Math.abs(head!.x - row!.x)).toBeLessThanOrEqual(1);
      await expect(all).toBeChecked({ checked: false });
      await expect(toolbar).toHaveCount(0);

      await boxes.nth(1).check();
      await expect(all).toBeChecked({ indeterminate: true });
      await expect(toolbar).toContainText('1 selected');

      // Mixed takes everything; the keyboard reaches it and Space presses it.
      await all.focus();
      await page.keyboard.press('Space');
      await expect(all).toBeChecked();
      await expect(all).toBeFocused();
      await expect(toolbar).toContainText(`${loaded} selected`);
      // The house ring: 2px of it, which the root's density zoom may scale.
      const [ring, ringWidth] = await all.evaluate(
        (el) => [getComputedStyle(el).outlineStyle, parseFloat(getComputedStyle(el).outlineWidth)] as const,
      );
      expect(ring).toBe('solid');
      expect(ringWidth).toBeGreaterThanOrEqual(1.5);

      await page.keyboard.press('Space');
      await expect(all).toBeChecked({ checked: false });
      await expect(boxes.nth(1)).not.toBeChecked();
      await expect(toolbar).toHaveCount(0);
    });
  }

  test('a rejected write on one issue neither stops nor undoes the others', async ({ page }) => {
    await page.goto(`${sample.origin}/`);
    await openEntry(page, 1440, 'Triage');
    const queue = page.getByRole('grid', { name: 'Triage' });
    let refused = 0;
    await page.route('**/api/update', async (route) => {
      const body = route.request().postDataJSON() as { key: { id: number } };
      if (body.key.id === 6 && refused++ === 0) {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Someone else changed this issue.', outcome: 'rejected' }),
        });
        return;
      }
      await route.continue();
    });
    await queue.getByRole('row', { name: new RegExp(title(sample.db, 2)) }).click();
    await queue.getByRole('row', { name: new RegExp(title(sample.db, 6)) }).click({ modifiers: ['ControlOrMeta'] });
    await queue.getByRole('row', { name: new RegExp(title(sample.db, 8)) }).click({ modifiers: ['ControlOrMeta'] });
    await page.getByRole('toolbar', { name: 'Selected records' }).getByRole('button', { name: 'Start work', exact: true }).click();
    const result = page.locator('.queue-result');
    await expect(result).toContainText('Start work: 2 applied, 1 rejected.');
    await expect(result).toContainText(`${title(sample.db, 6)}: Someone else changed this issue.`);
    await expect(result).toHaveAttribute('role', 'alert');
    expect(status(sample.db, 2)).toBe('in_progress');
    expect(status(sample.db, 6)).toBe('ready');
    expect(status(sample.db, 8)).toBe('in_progress');
  });

  for (const width of [1440, 390]) {
    test(`${width}px: a board card moves only through an authored transition`, async ({ page }) => {
      await page.setViewportSize({ width, height: 924 });
      await page.goto(`${sample.origin}/`);
      await openEntry(page, width, 'Board');
      const board = page.getByRole('group', { name: 'Board', exact: true });
      await expect(board).toBeVisible();
      const lanes = board.locator('.triage-lane');
      await expect(lanes).toHaveCount(5);
      const inCycle = (state: string) => rows(sample.db, 'SELECT id FROM issue WHERE cycle_id=1 AND status=?', state).length;
      await expect(lanes.nth(1).locator('.triage-card')).toHaveCount(inCycle('ready'));
      await expect(lanes.nth(2).locator('.triage-card')).toHaveCount(inCycle('in_progress'));

      // A ready card may only start work: its ⋯ menu offers exactly that lane.
      const ready = title(sample.db, 2);
      const actions = (id: number) => board.getByRole('button', { name: `Actions for ${title(sample.db, id)}`, exact: true });
      await actions(2).click();
      await expect(page.getByRole('group', { name: 'Move to' }).getByRole('menuitem')).toHaveText(['In progress']);
      await page.keyboard.press('Escape');
      // A done card has no authored way out: its menu edits it and moves it nowhere.
      await actions(5).click();
      await expect(page.getByRole('group', { name: 'Edit' })).toBeVisible();
      await expect(page.getByRole('group', { name: 'Move to' })).toHaveCount(0);
      await page.keyboard.press('Escape');

      await actions(2).click();
      await page.getByRole('menuitem', { name: 'In progress', exact: true }).click();
      await expect.poll(() => status(sample.db, 2)).toBe('in_progress');
      await expect(lanes.nth(2).locator('.triage-card')).toHaveCount(inCycle('in_progress'));
      await expect(lanes.nth(1).locator('.triage-card')).toHaveCount(inCycle('ready'));
      await expect(lanes.nth(2).getByRole('button', { name: new RegExp(`^${ready}`) })).toBeVisible();

      // A card opens its record the way the entry says.
      await lanes
        .nth(2)
        .getByRole('button', { name: new RegExp(`^${ready}`) })
        .click();
      const modal = page.locator('.record-modal');
      await expect(modal).toBeVisible();
      await expect(modal.getByRole('heading', { level: 1 })).toContainText(ready);
      await modal.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(modal).toHaveCount(0);
    });
  }
});
