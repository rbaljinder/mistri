// test-package: shared — drives the database browser and an App to one behavior (scripts/test-owners.mjs).
import { COMPASS, DEMO, expect, type Page, test } from './support/ownServers';
import { open } from './support/app';
import { startSample } from './support/sampleServer';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer', 'crm'] });

/* Three things a reader does without a mouse, or does a second way: peek and
   step through records, arrange a board, and fold the menu to a rail. Each
   asserts what the reader sees and, where there is a write, that it holds. */

const CRM = COMPASS;
/* Where the focus is: inside the open glance, and on which row of the list. */
const inGlance = (page: Page) => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"].peekpanel-glance')));
const focusedRow = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest<HTMLElement>('tbody tr[data-row]')?.dataset.row ?? null);

test('records by keyboard: Space peeks the focused row, Escape returns, and j and k step through the list', async ({ page }) => {
  await open(page, DEMO, 'customer');
  const grid = page.locator('.table-wrap table').first();
  // Focus lands the cursor on a row; Space peeks whichever row that is.
  await grid.focus();
  await page.keyboard.press(' ');
  const peek = page.getByRole('dialog', { name: /a glance/ });
  await expect(peek).toBeVisible();
  // The glance covers the list's right side, so it takes the focus as a dialog does.
  await expect.poll(() => inGlance(page)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(peek).toHaveCount(0);
  // Focus is back on a row of the list the peek came from, not lost to the page.
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('tbody tr')))).toBe(true);

  await page.keyboard.press('Enter');
  const trail = page.getByRole('navigation', { name: 'Records in this list' });
  await expect(trail).toContainText(/\d+ of \d+/);
  // Wherever the row was, j is the next one in the list and k the one before.
  const at = async () => Number(/(\d+) of \d+/.exec((await trail.textContent()) ?? '')?.[1]);
  const start = await at();
  await page.keyboard.press(start > 1 ? 'k' : 'j');
  await expect.poll(at).toBe(start > 1 ? start - 1 : start + 1);
  await page.keyboard.press(start > 1 ? 'j' : 'k');
  await expect.poll(at).toBe(start);
});

test('a glance holds Tab as a dialog does: the focus moves in, Tab and Shift+Tab stay, j steps, and Escape gives the row back', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 924 });
  // Compass's contacts open as a glance (`open: 'drawer'`), over the list's right side and the controls there.
  await page.goto(`${CRM}/contact`);
  const grid = page.locator('.table-wrap table').first();
  await expect(grid.locator('tbody tr[data-row]').nth(3)).toBeVisible();
  // From the keyboard: the cursor two rows down, then Enter opens the row the App's way.
  await grid.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const opener = await focusedRow(page);
  expect(opener).toBe('2');
  await page.keyboard.press('Enter');
  const glance = page.getByRole('dialog', { name: /a glance/ });
  await expect(glance).toBeVisible();
  await expect(glance).toHaveAttribute('aria-modal', 'true');
  await expect.poll(() => inGlance(page)).toBe(true);

  /* Round the glance's stops and past them, both ways: the focus never walks on
     under it. Past either end it passes a focus guard beside the panel, which
     hands it to the far end a frame later (Base UI), so each press is awaited. */
  const stops = await glance.evaluate(
    (box) => box.querySelectorAll('button:not(:disabled), a[href], input, select, textarea, [tabindex="0"]').length,
  );
  expect(stops).toBeGreaterThan(1);
  const visited = new Set<string>();
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let press = 0; press < stops + 2; press++) {
      await page.keyboard.press(key);
      await expect.poll(() => inGlance(page), { message: `${key} ${press + 1}` }).toBe(true);
      visited.add(
        await page.evaluate(
          () => (document.activeElement as HTMLElement).getAttribute('aria-label') ?? document.activeElement?.textContent ?? '',
        ),
      );
    }
  }
  expect(visited.size).toBeGreaterThan(1);

  // J still steps the glance through the list, and the focus stays in it.
  const name = await glance.getAttribute('aria-label');
  await page.keyboard.press('j');
  await expect(glance).not.toHaveAttribute('aria-label', name ?? '');
  expect(await inGlance(page)).toBe(true);

  // Escape: gone, and the focus back on the row it was opened from, not the one J reached.
  await page.keyboard.press('Escape');
  await expect(glance).toHaveCount(0);
  await expect.poll(() => focusedRow(page)).toBe(opener);
});

test.describe('on Thread', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.beforeEach(async () => {
    sample = await startSample('thread');
  });
  test.afterEach(async () => {
    await sample?.stop();
  });

  test('a board you arrange: a card moves by its ⋯ menu and back by Alt+Up, and the place holds', async ({ page }) => {
    // Through the menu: the board is the `board` view over `issue`, not a path of its own.
    await page.goto(`${sample.origin}/`);
    await page.getByRole('button', { name: /^Board/ }).click();
    await expect(page.locator('section.triage-lane').first()).toBeVisible();
    // The first lane with at least two cards: a card needs a neighbor to move past.
    // Lanes are the board's sections; the side menu is a list too, so scope to the board.
    const lane = page
      .locator('section.triage-lane')
      .filter({ has: page.locator('article.triage-card-wrap').nth(1) })
      .first();
    const cards = lane.locator('article.triage-card-wrap');
    const title = async (index: number) =>
      ((await cards.nth(index).getByRole('button').first().getAttribute('aria-label')) ?? '').split(',')[0];
    const first = await title(0);
    const second = await title(1);

    /* The ⋯ is a finger's target on the card (24px square, WCAG 2.5.8), and its
       menu, opened from the keyboard, rings the entry the arrows are on: the
       rows are transparent, so the ring is the only mark of where they are. */
    const actions = lane.getByRole('button', { name: `Actions for ${first}`, exact: true });
    // Rounded: the density zoom on the root leaves 23.9955px of a 24px box.
    expect(
      await actions.evaluate((el) => [getComputedStyle(el).width, getComputedStyle(el).height].map((size) => Math.round(parseFloat(size)))),
    ).toEqual([24, 24]);
    await actions.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    const lit = page.locator('[role="menuitem"]:focus');
    await expect(lit).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Escape');
    await expect(actions).toBeFocused();

    await actions.click();
    await page.getByRole('menuitem', { name: 'Move down', exact: true }).click();
    await expect.poll(() => title(0)).toBe(second);
    await expect.poll(() => title(1)).toBe(first);
    // The place was written, not only drawn: a reload reads it back.
    await page.reload();
    await expect.poll(() => title(1)).toBe(first);

    await cards.nth(1).getByRole('button').first().focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => title(0)).toBe(first);

    /* Across lanes the card is drawn anew, in the next lane, after the rows
       are read again; the focus goes with it rather than falling to the page,
       and the move is said. */
    const mover = page.locator('section.triage-lane').first().locator('article.triage-card-wrap').first().getByRole('button').first();
    const moving = ((await mover.getAttribute('aria-label')) ?? '').split(',')[0];
    await mover.focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator('.triage-sr')).toContainText(`Moved “${moving}” to `);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''))
      .toMatch(new RegExp(`^${moving.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  test('the icon rail: folded, the menu keeps every entry, named and usable', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 924 });
    await page.goto(`${sample.origin}/`);
    await page.getByRole('button', { name: 'Hide the table list' }).click();
    await expect(page.locator('body')).toHaveClass(/sidebar-hidden/);
    const issues = page.getByRole('button', { name: /^Issues/ });
    await expect(issues).toBeVisible();
    // The words are hidden in the rail; the name is still the button's, and said on hover.
    await expect(issues).toHaveAttribute('title', 'Issues');
    await issues.click();
    await expect(page.getByRole('heading', { name: 'Issues', level: 1 })).toBeVisible();
  });
});
