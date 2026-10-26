import { expect, test, type Locator, type Page } from './support/harness';
import { startSample } from './support/sampleServer';
import { scalar } from './support/db';

/**
 * Dragging with a pointer, as a reader does it: a mouse, and a finger that
 * holds an item still for a moment before it lifts — on Thread's board, on
 * Compass's task calendar, and in Tick's list, whose tasks keep the order
 * they are given. Every drop is read back from the database. A finger that
 * moves at once is scrolling, and moves nothing; Escape carries nothing.
 */

const CRM = `http://127.0.0.1:${process.env.TABLEWALK_E2E_CRM_PORT}`;

const centre = async (locator: Locator) => {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
/* A point in `to`: its middle across, and `part` of the way down — the top quarter lands before it. */
const within = async (locator: Locator, part: number) => {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height * part };
};

/** A finger on `from`: held still for `hold` ms, drawn to `to` in steps, and let go. No hold is a swipe. */
async function finger(page: Page, from: Locator, to: Locator | { x: number; y: number }, { hold = 500, part = 0.25 } = {}) {
  const start = await centre(from);
  const end = 'x' in to ? to : await within(to, part);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  if (hold) await page.waitForTimeout(hold);
  for (let i = 1; i <= 12; i++) {
    const point = { x: start.x + ((end.x - start.x) * i) / 12, y: start.y + ((end.y - start.y) * i) / 12 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** A mouse on `from`, moved in steps to `to` and let go there. */
async function mouse(page: Page, from: Locator, to: Locator, part = 0.25) {
  const start = await centre(from);
  const end = await within(to, part);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
}

test.describe('Tick: tasks kept in the order they are given', () => {
  test.use({ hasTouch: true });
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.setTimeout(60_000);
  test.beforeEach(async ({ page }) => {
    sample = await startSample('tick');
    await page.addInitScript(() => localStorage.setItem('mistri.tour.v1', 'done'));
  });
  test.afterEach(async () => {
    await sample?.stop();
  });
  const place = (id: number) => Number(scalar(sample.db, 'SELECT position FROM task WHERE id=?', id));
  const titles = (page: Page) => page.locator('.checklist .checklist-title');
  const task = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
  const row = (page: Page, name: string) => page.locator('.checklist-row', { has: task(page, name) });

  test('a mouse drags a task into place; Alt+↓ and the grip move it again; a tab read by date offers no grip', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${sample.origin}/`);
    await expect(titles(page)).toHaveText(['Plan the week', 'Water the plants', 'Return the library book']);
    await mouse(page, task(page, 'Return the library book'), row(page, 'Plan the week'));
    // One update: a step before the first.
    await expect.poll(() => place(3)).toBe(0);
    await expect(titles(page)).toHaveText(['Return the library book', 'Plan the week', 'Water the plants']);
    await expect(page.locator('.drag-ghost')).toHaveCount(0);
    await expect(task(page, 'Return the library book')).toBeFocused();
    // Alt+↓: halfway between its new neighbors.
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => place(3)).toBe(1536);
    await expect(titles(page)).toHaveText(['Plan the week', 'Return the library book', 'Water the plants']);
    await expect(task(page, 'Return the library book')).toBeFocused();
    // The grip names the places, and was not opened by a drag.
    await page.getByRole('button', { name: 'Reorder Plan the week', exact: true }).click();
    await expect(page.getByRole('menuitem')).toHaveText(['Move down', 'Move to bottom']);
    await page.getByRole('menuitem', { name: 'Move to bottom', exact: true }).click();
    await expect.poll(() => place(1)).toBe(3072);
    await expect(titles(page)).toHaveText(['Return the library book', 'Water the plants', 'Plan the week']);
    // Upcoming reads by date: its tab sorts, so there is no hand order to keep, and no grip.
    await page.locator('[role="tab"]', { hasText: 'Upcoming' }).click();
    await expect(titles(page)).toHaveText(['Return the library book']);
    await expect(page.getByRole('button', { name: /^Reorder / })).toHaveCount(0);
    await page.locator('[role="tab"]', { hasText: 'Open' }).click();
    await expect(page.getByRole('button', { name: /^Reorder / })).toHaveCount(3);
  });

  test('a finger holds a task, then carries it into place; a finger that moves at once moves nothing', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${sample.origin}/`);
    await expect(titles(page)).toHaveText(['Plan the week', 'Water the plants', 'Return the library book']);
    // Held well past the browser's own long press, which must not take it.
    await finger(page, task(page, 'Water the plants'), row(page, 'Plan the week'), { hold: 900 });
    await expect.poll(() => place(2)).toBe(0);
    await expect(titles(page)).toHaveText(['Water the plants', 'Plan the week', 'Return the library book']);
    // A long press is a drag, not a tap: the task did not open.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // A swipe is the page's: nothing lifts, nothing is written, nothing opens. Last, because a
    // swipe ends in a fling, and Chrome hands a press made during a fling to the page, not to its
    // listeners: that press is put back, and the next one lifts.
    await finger(page, task(page, 'Return the library book'), row(page, 'Plan the week'), { hold: 0 });
    await expect(page.locator('.drag-ghost')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(place(3)).toBe(3072);
    await expect(titles(page)).toHaveText(['Water the plants', 'Plan the week', 'Return the library book']);
  });
});

test.describe('Thread board: cards carried by a mouse and by a finger', () => {
  test.use({ hasTouch: true });
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.setTimeout(60_000);
  test.beforeEach(async () => {
    sample = await startSample('thread');
  });
  test.afterEach(async () => {
    await sample?.stop();
  });
  const value = (column: string, id: number) => scalar(sample.db, `SELECT ${column} FROM issue WHERE id=?`, id);
  const id = (name: string) => Number(scalar(sample.db, 'SELECT id FROM issue WHERE name=?', name));
  const nameOf = async (card: Locator) => ((await card.getByRole('button').first().getAttribute('aria-label')) ?? '').split(',')[0];

  async function open(page: Page) {
    await page.setViewportSize({ width: 1440, height: 924 });
    await page.goto(`${sample.origin}/`);
    await page
      .locator('.sidebar, .topbar')
      .getByRole('button', { name: /^Board/ })
      .first()
      .click();
    const board = page.getByRole('group', { name: 'Board', exact: true });
    await expect(board.locator('section.triage-lane').first()).toBeVisible();
    return board.locator('section.triage-lane');
  }

  test("a finger moves a card before another in the next lane, through the lane's action, and takes that place", async ({ page }) => {
    const lanes = await open(page);
    const mover = lanes.nth(1).locator('article.triage-card-wrap').first();
    const target = lanes.nth(2).locator('article.triage-card-wrap').first();
    const moverName = await nameOf(mover);
    const targetName = await nameOf(target);
    // The server has vouched for the move before it is offered: its menu names the lane.
    await mover.getByRole('button', { name: `Actions for ${moverName}`, exact: true }).click();
    await expect(page.getByRole('group', { name: 'Move to' }).getByRole('menuitem')).toHaveText(['In progress']);
    await page.keyboard.press('Escape');
    await finger(page, mover.getByRole('button').first(), target);
    await expect.poll(() => value('status', id(moverName))).toBe('in_progress');
    await expect.poll(() => Number(value('rank', id(moverName))) < Number(value('rank', id(targetName)))).toBe(true);
    await expect.poll(() => nameOf(lanes.nth(2).locator('article.triage-card-wrap').first())).toBe(moverName);
    await expect(page.locator('.drag-ghost')).toHaveCount(0);
  });

  test('a mouse puts a card in its place within its lane, and Escape carries nothing', async ({ page }) => {
    const lanes = await open(page);
    const lane = lanes.first();
    const first = lane.locator('article.triage-card-wrap').nth(0);
    const second = lane.locator('article.triage-card-wrap').nth(1);
    const [firstName, secondName] = [await nameOf(first), await nameOf(second)];
    const rankOf = (name: string) => Number(value('rank', id(name)));
    const before = rankOf(secondName);
    // Lifted and carried over the first card, then Escape: the card goes back and nothing is written.
    const start = await centre(second.getByRole('button').first());
    const over = await within(first, 0.25);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(over.x, over.y, { steps: 8 });
    await expect(page.locator('.drag-ghost')).toHaveCount(1);
    // The place it would take opens as a gap: the card it lands before slides down, by transform alone.
    await expect.poll(() => first.evaluate((element) => (element as HTMLElement).style.translate)).toMatch(/^0(px)? [1-9]/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.drag-ghost')).toHaveCount(0);
    await expect.poll(() => first.evaluate((element) => (element as HTMLElement).style.translate)).toBe('');
    await page.mouse.up();
    expect(rankOf(secondName)).toBe(before);
    // Carried again and let go: in the first place from the frame it lands in, before the write is answered, and
    // never back in between (no snap back, no second jump); one update.
    const names = () =>
      lane
        .locator('article.triage-card-wrap')
        .evaluateAll((cards) => cards.map((card) => card.querySelector('button')?.getAttribute('aria-label')?.split(',')[0]));
    const order = [secondName, firstName];
    await mouse(page, second.getByRole('button').first(), first);
    expect((await names()).slice(0, 2)).toEqual(order);
    for (const wait of [100, 300, 1000]) {
      await page.waitForTimeout(wait);
      expect((await names()).slice(0, 2)).toEqual(order);
    }
    await expect.poll(() => rankOf(secondName) < rankOf(firstName)).toBe(true);
    await expect.poll(() => nameOf(lane.locator('article.triage-card-wrap').first())).toBe(secondName);
    await expect(lane.getByRole('button', { name: new RegExp(`^${secondName}`) }).first()).toBeFocused();
  });

  test('on a phone, a finger swiping across the lanes scrolls them and moves nothing', async ({ page }) => {
    // Opened from the side menu, then narrowed to a phone: a phone's menu is a sheet of its own.
    const lanes = await open(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const board = page.getByRole('group', { name: 'Board', exact: true });
    await expect(lanes.first()).toBeVisible();
    // The first lane starts at the page's gutter, where the list's crumbs do, not at the screen's edge.
    const left = async (locator: Locator) => (await locator.boundingBox())!.x;
    await expect
      .poll(async () => Math.abs((await left(lanes.first())) - (await left(page.locator('.crumbs > :first-child')))))
      .toBeLessThanOrEqual(1);
    const card = lanes.first().locator('article.triage-card-wrap').first();
    const name = await nameOf(card);
    const status = value('status', id(name));
    const from = await centre(card.getByRole('button').first());
    await finger(page, card.getByRole('button').first(), { x: from.x - 220, y: from.y }, { hold: 0 });
    await expect.poll(() => board.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await expect(page.locator('.drag-ghost')).toHaveCount(0);
    expect(value('status', id(name))).toBe(status);
  });

  test('on a phone, a card held at the screen’s edge carries the lanes along a lane at a time, to the last', async ({ page }) => {
    const lanes = await open(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const board = page.getByRole('group', { name: 'Board', exact: true });
    await expect(lanes.first()).toBeVisible();
    const card = lanes.first().locator('article.triage-card-wrap').first();
    const name = await nameOf(card);
    const status = value('status', id(name));
    const start = await centre(card.getByRole('button').first());
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    await page.waitForTimeout(500);
    const edge = { x: 386, y: start.y };
    for (let i = 1; i <= 8; i++)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: start.x + ((edge.x - start.x) * i) / 8, y: start.y }],
      });
    // Snapping is off while the card is carried, and the strip steps until its last lane is in view.
    await expect.poll(() => board.evaluate((element) => getComputedStyle(element).scrollSnapType)).toMatch(/^none/);
    await expect
      .poll(
        async () => {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: edge.x - (Date.now() % 2), y: edge.y }] });
          return board.evaluate((element) => Math.round(element.scrollWidth - element.clientWidth - element.scrollLeft));
        },
        { timeout: 15_000 },
      )
      .toBeLessThanOrEqual(2);
    // Let go off any lane it may enter, it goes back: nothing written, and the strip snaps again.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await cdp.detach();
    await expect(page.locator('.drag-ghost')).toHaveCount(0);
    await expect.poll(() => board.evaluate((element) => getComputedStyle(element).scrollSnapType)).not.toMatch(/^none/);
    expect(value('status', id(name))).toBe(status);
  });
});

test.describe('Thread project plan: rows moved between cycles and to their place', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.setTimeout(60_000);
  test.beforeEach(async () => {
    sample = await startSample('thread');
  });
  test.afterEach(async () => {
    await sample?.stop();
  });
  const value = (column: string, id: number) => scalar(sample.db, `SELECT ${column} FROM issue WHERE id=?`, id);
  const id = (name: string) => Number(scalar(sample.db, 'SELECT id FROM issue WHERE name=?', name));
  const group = (page: Page, name: string) => page.locator('.page-group', { has: page.locator('.page-group-name', { hasText: name }) });
  const rowNames = (page: Page, name: string) => group(page, name).locator('tr[data-row-key] td:first-child').allTextContents();

  test('a row dragged into another cycle stands there at once and is saved there; Alt+↑ takes it back a cycle', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(`${sample.origin}/projects/1`);
    await expect(group(page, 'Cycle 19').locator('tr[data-row-key]').first()).toBeVisible({ timeout: 30_000 });
    await page
      .locator('.page-groups')
      .first()
      .evaluate((element) => element.scrollIntoView({ block: 'start' }));
    const before = await rowNames(page, 'Cycle 18');
    const mover = before[1];
    const target = (await rowNames(page, 'Cycle 19'))[0];
    await mouse(
      page,
      group(page, 'Cycle 18').locator('tr[data-row-key]').nth(1),
      group(page, 'Cycle 19').locator('tr[data-row-key]').first(),
      0.2,
    );
    // Drawn in its new cycle, before the row it was let go over, from the first frame; the counts follow.
    expect((await rowNames(page, 'Cycle 19')).slice(0, 2)).toEqual([mover, target]);
    expect(await rowNames(page, 'Cycle 18')).not.toContain(mover);
    await page.waitForTimeout(1000);
    expect((await rowNames(page, 'Cycle 19')).slice(0, 2)).toEqual([mover, target]);
    await expect.poll(() => Number(value('cycle_id', id(mover)))).toBe(2);
    expect(Number(value('rank', id(mover)))).toBeLessThan(Number(value('rank', id(target))));
    await expect(group(page, 'Cycle 19').locator('.page-group-count')).toHaveText(/^3 of 3/);
    // From the keyboard: Alt+↑ on the first row of a cycle carries it to the end of the cycle before.
    const row = group(page, 'Cycle 19').locator('tr[data-row-key]').first();
    await row.focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => Number(value('cycle_id', id(mover)))).toBe(1);
    await expect.poll(async () => (await rowNames(page, 'Cycle 18')).at(-1)).toBe(mover);
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: `Moved “${mover}”` })).toHaveCount(1);
    await expect(group(page, 'Cycle 18').locator('tr[data-row-key]').last()).toBeFocused();
  });
});

/* A task's due date is Compass's to change: carried by a finger to the next
   day it is due then, and Alt+← brings it back, so the shared fixture's
   dates end as they began. */
test.describe('Compass task calendar by finger', () => {
  test.use({ hasTouch: true });
  test('a finger carries a task to the next day, and Alt+← brings it back', async ({ page }) => {
    await page.goto(CRM);
    await page
      .getByRole('button', { name: /^Activity/ })
      .first()
      .click();
    await page.getByRole('menuitem', { name: 'Task calendar', exact: true }).click();
    const calendar = page.getByRole('region', { name: 'Task calendar' });
    await expect(calendar.locator('.calendar-card').first()).toBeVisible();
    const pick = await calendar.evaluate((root) => {
      for (const day of root.querySelectorAll('td.calendar-day:not(.is-outside)')) {
        const next = day.nextElementSibling;
        const card = day.querySelector('.calendar-card');
        if (card && next && !next.classList.contains('is-outside')) {
          return { from: day.getAttribute('data-date')!, to: next.getAttribute('data-date')!, card: card.getAttribute('data-card')! };
        }
      }
      return null;
    });
    expect(pick).not.toBeNull();
    const { from, to, card } = pick!;
    const inDay = (date: string) => calendar.locator(`td[data-date="${date}"] .calendar-card[data-card='${card}']`);
    await finger(page, inDay(from), calendar.locator(`td[data-date="${to}"]`), { part: 0.6 });
    await expect(inDay(to)).toBeVisible();
    await expect(inDay(from)).toHaveCount(0);
    await expect(inDay(to)).toBeFocused();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(inDay(from)).toBeVisible();
    await expect(inDay(to)).toHaveCount(0);
  });
});
