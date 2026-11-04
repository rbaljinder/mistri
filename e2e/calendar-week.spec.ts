import { FIXTURE_MS } from './support/budgets';
/**
 * A week of a calendar as a time grid (`span: 'week'`), over the Desk blocks fixture's own server: today's site
 * visits in their hours, the two that overlap side by side, one dragged to another time and its foot to another end
 * through the ordinary update, and a phone's agenda with each visit's hours.
 */
import { expect, test, type Page } from './support/harness';
import { startDeskBlocks } from './support/deskBlocksServer';

type Fixture = Awaited<ReturnType<typeof startDeskBlocks>>;
async function login(page: Page, app: Fixture) {
  const response = await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin },
    data: { email: app.account.email, password: app.account.password },
  });
  expect(response.ok(), await response.text()).toBe(true);
}
/* The day the seed wrote the visits on, as the grid names its column. */
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const shots = process.env.CALENDAR_SHOTS;

test.describe('a week of hours', () => {
  test.setTimeout(60_000);
  let app: Fixture;
  test.beforeAll(async () => {
    // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
    test.setTimeout(FIXTURE_MS);
    app = await startDeskBlocks();
  });
  test.afterAll(async () => {
    await app?.stop();
  });

  test('visits stand in their hours, side by side where they overlap; one is dragged to another time and its end moved', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    /* The now line is drawn only inside the grid's hours (seven to seven, widened by what it holds), so it is absent
       before seven in the morning: the page's clock is noon today, whenever the suite runs. */
    await page.clock.setFixedTime(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0));
    await login(page, app);
    await page.goto(`${app.origin}/schedule`);
    const grid = page.locator('.calendar-time');
    await expect(grid).toBeVisible();
    await expect(grid.locator('.calendar-time-column')).toHaveCount(7);
    const column = grid.locator(`.calendar-time-column[data-date="${today}"]`);
    const boiler = column.getByRole('button', { name: /Boiler service/ });
    const router = column.getByRole('button', { name: /Router swap/ });
    await expect(boiler).toBeVisible();
    await expect(page.locator('.calendar-time-now')).toHaveCount(1);
    // The two that overlap share the column, one beside the other; the badge check, alone, takes it whole.
    const [a, b, c, day] = await Promise.all([
      boiler.boundingBox(),
      router.boundingBox(),
      column.getByRole('button', { name: /Badge reader check/ }).boundingBox(),
      column.boundingBox(),
    ]);
    expect(a!.width).toBeLessThan(day!.width * 0.6);
    expect(Math.abs(a!.x - b!.x)).toBeGreaterThan(a!.width * 0.8);
    expect(c!.width).toBeGreaterThan(day!.width * 0.8);
    // An hour is an hour: the router swap, an hour and a half, is half as tall again as the boiler's hour.
    expect(b!.height / a!.height).toBeGreaterThan(1.35);
    if (shots) await page.screenshot({ path: `${shots}/calendar-week-desk.png` });

    // Held by its top, the boiler service dropped on two o'clock starts there and keeps its hour.
    await boiler.dragTo(column.locator('.calendar-time-slot[data-minute="840"]'), { sourcePosition: { x: 8, y: 4 } });
    await expect(page.locator('#toast-live')).toHaveText(/^Moved “Boiler service” to /);
    const moved = column.getByRole('button', { name: /Boiler service/ });
    await expect(moved.locator('.calendar-time-times')).toContainText(/2:00\s*–\s*3:00\s*PM/);
    await expect(moved).toBeFocused();
    // Its foot, dragged down an hour, ends it at four.
    const grip = moved.locator('.calendar-time-grip');
    const foot = (await grip.boundingBox())!;
    await page.mouse.move(foot.x + foot.width / 2, foot.y + foot.height / 2);
    await page.mouse.down();
    await page.mouse.move(foot.x + foot.width / 2, foot.y + foot.height / 2 + (a!.height || 48), { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('#toast-live')).toHaveText(/^“Boiler service” now ends /);
    await expect(column.getByRole('button', { name: /Boiler service/ }).locator('.calendar-time-times')).toContainText(
      /2:00\s*–\s*4:00\s*PM/,
    );
    // Written, not only drawn: read again, the visit is where it was put.
    await page.reload();
    await expect(
      page
        .locator(`.calendar-time-column[data-date="${today}"]`)
        .getByRole('button', { name: /Boiler service/ })
        .locator('.calendar-time-times'),
    ).toContainText(/2:00\s*–\s*4:00\s*PM/);

    // Alt and an arrow: half an hour earlier, said and written.
    await page
      .locator(`.calendar-time-column[data-date="${today}"]`)
      .getByRole('button', { name: /Boiler service/ })
      .focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(
      page
        .locator(`.calendar-time-column[data-date="${today}"]`)
        .getByRole('button', { name: /Boiler service/ })
        .locator('.calendar-time-times'),
    ).toContainText(/1:30\s*–\s*3:30\s*PM/);
  });

  test('a phone reads the week as an agenda, each visit with its hours, and nothing scrolls sideways', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, app);
    await page.goto(`${app.origin}/schedule`);
    const agenda = page.locator('.calendar-agenda');
    await expect(agenda).toBeVisible();
    await expect(page.locator('.calendar-time')).toHaveCount(0);
    await expect(agenda.getByRole('button', { name: /Router swap/ })).toContainText(/9:30\s*–\s*11:00\s*AM/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (shots) await page.screenshot({ path: `${shots}/calendar-week-phone.png` });
  });
});
