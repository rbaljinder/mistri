import { expect, test, type Page } from './support/harness';
import { startSample } from './support/sampleServer';
import { rows, scalar } from './support/db';

/**
 * Thread's boards past their lanes: a lane's work-in-progress limit on its
 * head; the Planning board by cycle, whose lanes are the cycles after one for
 * none and whose rows are the priorities, every move an ordinary edit of the
 * issue; a card dropped in another lane landing where it was let go; and a
 * card's name edited in place. Each write is read back from the database.
 * The seed puts ids 1–15 in cycle 1 ("Cycle 18"), 16–21 in cycle 2, the rest
 * in none; statuses run in_progress, ready, in_review, backlog, done, ready and
 * priorities urgent, high, normal, normal, low, by id.
 */
const value = (db: string, column: string, id: number) => scalar(db, `SELECT ${column} FROM issue WHERE id=?`, id);

async function open(page: Page, origin: string, label: string) {
  await page.setViewportSize({ width: 1440, height: 924 });
  await page.goto(`${origin}/`);
  // Through the menu: a board is a view over `issue`, not a path of its own.
  await page
    .locator('.sidebar')
    .getByRole('button', { name: new RegExp(`^${label}`) })
    .click();
  const board = page.getByRole('group', { name: label, exact: true });
  await expect(board.locator('section.triage-lane').first()).toBeVisible();
  return board;
}

test.describe('Thread boards: limits, planning by cycle, drops and edits in place', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.setTimeout(60_000);
  test.beforeEach(async () => {
    sample = await startSample('thread');
  });
  test.afterEach(async () => {
    await sample?.stop();
  });

  test('a lane head says its count against its limit, and warns past it', async ({ page }) => {
    const board = await open(page, sample.origin, 'Board');
    const count = (lane: string) =>
      board.locator('header', { has: page.getByRole('heading', { level: 2, name: lane, exact: true }) }).locator('.triage-lane-count');
    const inReview = rows(sample.db, "SELECT id FROM issue WHERE cycle_id=1 AND status='in_review'").length;
    expect(inReview).toBeGreaterThan(2);
    await expect(count('In review')).toHaveText(`${inReview} / 2`);
    await expect(count('In review')).toHaveClass(/is-over/);
    await expect(count('In progress')).not.toHaveClass(/is-over/);
  });

  test('Planning: a lane per cycle after one for none, a row per priority, and a move is an edit of the issue', async ({ page }) => {
    const board = await open(page, sample.origin, 'Planning');
    await expect(board.getByRole('heading', { level: 2 })).toHaveText(['No cycle', 'Cycle 18', 'Cycle 19', 'Cycle 20']);
    await expect(board.getByRole('heading', { level: 3 })).toHaveText(['Urgent', 'High', 'Normal', 'Low']);
    // An empty cell is a place, not a box: no edge of its own until a card is carried over it, and none once it is put back.
    const empty = board.locator('section.triage-cell:not([data-lane="0"]):not(:has(article))').first();
    await expect(empty).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    const carried = (await board.locator('.triage-card').first().boundingBox())!;
    const cell = (await empty.boundingBox())!;
    await page.mouse.move(carried.x + carried.width / 2, carried.y + carried.height / 2);
    await page.mouse.down();
    await page.mouse.move(cell.x + cell.width / 2, cell.y + cell.height / 2, { steps: 8 });
    await expect(empty).toHaveClass(/is-over/);
    await expect(empty).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    // The card's copy is the card: no "Details" summary drawn above it by its row's copy.
    await expect(page.locator('.drag-ghost [data-ghost]')).toHaveCount(1);
    await expect(page.locator('.drag-ghost details')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(empty).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    // Issue 2: ready, high, in Cycle 18.
    const name = String(value(sample.db, 'name', 2));
    const actions = board.getByRole('button', { name: `Actions for ${name}`, exact: true });
    await actions.click();
    await page.getByRole('group', { name: 'Move to' }).getByRole('menuitem', { name: 'Cycle 19', exact: true }).click();
    await expect.poll(() => value(sample.db, 'cycle_id', 2)).toBe(2);
    await actions.click();
    await page.getByRole('menuitem', { name: 'Low', exact: true }).click();
    await expect.poll(() => value(sample.db, 'priority', 2)).toBe('low');
    // Redrawn where it now stands: Cycle 19's column in the Low row.
    const low = page.locator('details.triage-swimlane', { has: page.getByRole('heading', { level: 3, name: 'Low', exact: true }) });
    await expect(low.getByRole('region', { name: /^Cycle 19/ }).getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  });

  test('a card dropped before another in the next lane moves through its action and takes that place', async ({ page }) => {
    const board = await open(page, sample.origin, 'Board');
    const lanes = board.locator('section.triage-lane');
    const nameOf = async (card: ReturnType<typeof lanes.locator>) =>
      ((await card.getByRole('button').first().getAttribute('aria-label')) ?? '').split(',')[0];
    const mover = lanes.nth(1).locator('article.triage-card-wrap').first();
    const target = lanes.nth(2).locator('article.triage-card-wrap').first();
    const moverName = await nameOf(mover);
    const targetName = await nameOf(target);
    const id = (name: string) => Number(scalar(sample.db, 'SELECT id FROM issue WHERE name=?', name));
    // The server has vouched for the move before it is offered: its menu names the lane.
    await mover.getByRole('button', { name: `Actions for ${moverName}`, exact: true }).click();
    await expect(page.getByRole('group', { name: 'Move to' }).getByRole('menuitem')).toHaveText(['In progress']);
    await page.keyboard.press('Escape');
    await mover.getByRole('button').first().dragTo(target);
    await expect.poll(() => value(sample.db, 'status', id(moverName))).toBe('in_progress');
    await expect.poll(() => Number(value(sample.db, 'rank', id(moverName))) < Number(value(sample.db, 'rank', id(targetName)))).toBe(true);
    await expect.poll(() => nameOf(lanes.nth(2).locator('article.triage-card-wrap').first())).toBe(moverName);
  });

  test('F2 on a card edits its name in place, and the save holds', async ({ page }) => {
    const board = await open(page, sample.origin, 'Board');
    const name = String(value(sample.db, 'name', 1));
    const renamed = `${name} (renamed)`;
    await board.getByRole('button', { name: `${name}, Urgent`, exact: true }).focus();
    await page.keyboard.press('F2');
    const editor = board.locator('.triage-card-under').getByRole('textbox');
    await expect(editor).toBeFocused();
    await editor.fill(renamed);
    await page.keyboard.press('Enter');
    await expect.poll(() => value(sample.db, 'name', 1)).toBe(renamed);
    await expect(board.getByRole('button', { name: `${renamed}, Urgent`, exact: true })).toBeVisible();
  });
});
