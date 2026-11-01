import { COMPASS, CRM_CLOCK, expect, test } from './support/ownServers';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

const CRM = COMPASS;

/* The fixture's tasks fall within weeks of its seeded day (CRM_CLOCK, the server's clock too), but the calendar opens
   on the browser's month: left on the real clock it is a month with no tasks once the seed ages out. */
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(CRM_CLOCK);
});

/* Compass's Task calendar: the tasks list asked again for the month in view,
   each task on its due date, opened like a board card. */
test('the task calendar puts open tasks on their days, opens one, and moves by month', async ({ page }) => {
  await page.goto(CRM);
  await page
    .getByRole('button', { name: /^Activity/ })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Task calendar', exact: true }).click();
  const calendar = page.getByRole('region', { name: 'Task calendar' });
  await expect(calendar).toBeVisible();
  await expect(calendar.getByRole('columnheader')).toHaveCount(7);
  const title = calendar.locator('.calendar-title');
  const month = await title.innerText();
  expect(month).toMatch(/^[A-Z][a-z]+ \d{4}$/);
  const card = calendar.locator('.calendar-card').first();
  await expect(card).toBeVisible();
  const subject = (await card.locator('.calendar-card-title').innerText()).trim();

  await card.click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(subject);
  await page.goBack();
  await expect(calendar).toBeVisible();

  await calendar.getByRole('button', { name: 'Next month', exact: true }).click();
  await expect(title).not.toHaveText(month);
  await calendar.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(title).toHaveText(month);
});

/* A task's due date is Compass's to change: dragged to the next day it is due
   then, and Alt+← brings it back, so the shared fixture's dates end as they began. */
test('a task moves to another day by dragging, and back by the keyboard', async ({ page }) => {
  await page.goto(CRM);
  await page
    .getByRole('button', { name: /^Activity/ })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Task calendar', exact: true }).click();
  const calendar = page.getByRole('region', { name: 'Task calendar' });
  await expect(calendar.locator('.calendar-card').first()).toBeVisible();
  // A shown task whose next day is in the same week and month.
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
  await inDay(from).dragTo(calendar.locator(`td[data-date="${to}"]`));
  await expect(inDay(to)).toBeVisible();
  await expect(inDay(from)).toHaveCount(0);
  await expect(inDay(to)).toBeFocused();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(inDay(from)).toBeVisible();
  await expect(inDay(to)).toHaveCount(0);
  /* Said as well as drawn, in a status region that was on the page before
     the words: the toast's own box comes and goes, so it cannot be the one. */
  const said = page.locator('#toast-live');
  await expect(said).toHaveAttribute('role', 'status');
  await expect(said).toHaveText(/^Moved “.+” to /);
});

test('on a phone the month reads as an agenda', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(CRM);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Task calendar', exact: true }).click();
  const calendar = page.getByRole('region', { name: 'Task calendar' });
  await expect(calendar.locator('.calendar-agenda > li').first()).toBeVisible();
  await expect(calendar.locator('.calendar-grid')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

/* Seven days across half a dashboard leave a card forty pixels of text. A title was cut to "Priy…" on one line while
   the card had height to spare; in a narrow calendar it takes two lines and breaks inside a word before it is cut. */
test('in a narrow calendar a card says its title on two lines instead of cutting it on one', async ({ page }) => {
  await page.goto(CRM);
  await page
    .getByRole('button', { name: /^Activity/ })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Task calendar', exact: true }).click();
  const calendar = page.getByRole('region', { name: 'Task calendar' });
  await expect(calendar.locator('.calendar-card').first()).toBeVisible();
  // The calendar, not the window, is what is narrow: a half-width section on a wide desk.
  await calendar.evaluate((root) => ((root as HTMLElement).style.width = '540px'));
  const cut = await calendar
    .locator('.calendar-card-title')
    .evaluateAll((titles) => titles.filter((title) => title.scrollWidth > title.clientWidth + 1).map((title) => title.textContent));
  expect(cut, 'titles cut at the side').toEqual([]);
  const heights = await calendar
    .locator('.calendar-card')
    .evaluateAll((cards) => [...new Set(cards.map((card) => Math.round(card.getBoundingClientRect().height)))]);
  expect(heights, 'every card one height, so a bar keeps its lane').toHaveLength(1);
});
