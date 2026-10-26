/**
 * Three 0.8.13 blocks (Preview) in a real browser, over the Desk blocks fixture's own server: a conversation's other
 * side (a timeline's `side`), a calendar's shaded spans (`backdrop`), and an author's component on a dashboard, told
 * the reader's window.
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
/* A day of this month, as the seed wrote it and the calendar reads it. */
const now = new Date();
const day = (n: number) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(n).padStart(2, '0')}`;

test.describe('0.8.13 preview blocks', () => {
  test.setTimeout(60_000);
  let app: Fixture;
  test.beforeAll(async () => {
    // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
    test.setTimeout(120_000);
    app = await startDeskBlocks();
  });
  test.afterAll(async () => {
    await app?.stop();
  });

  test("the caller's messages sit against the far edge, named once per run; on a phone they take the width", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, app);
    await page.goto(`${app.origin}/all/1`);
    const rows = page.locator('.timeline-scroll [data-timeline-row]');
    const first = rows.filter({ hasText: 'VPN drops about once an hour' });
    const second = rows.filter({ hasText: "It started after Monday's update." });
    const reply = rows.filter({ hasText: 'Thanks, looking into it now.' });
    await expect(first).toHaveClass(/\bis-other\b/);
    await expect(second).toHaveClass(/\bis-other\b/);
    await expect(reply).not.toHaveClass(/\bis-other\b/);
    // The system line stays a line across the width.
    await expect(rows.filter({ hasText: 'Priority raised to urgent' })).not.toHaveClass(/\bis-other\b/);
    await expect(first.locator('.timeline-by')).toHaveText('Ana Pereira');
    await expect(second).toHaveClass(/\bis-continued\b/);
    await expect(second.locator('.timeline-by')).toHaveCount(0);
    await expect(second.locator('time')).toHaveCount(1);
    await expect(reply.locator('.timeline-by')).toHaveText('Robin Bell');
    const list = (await page.locator('.timeline-rows').boundingBox())!;
    const other = (await first.boundingBox())!;
    const ours = (await reply.boundingBox())!;
    expect(Math.abs(other.x + other.width - (list.x + list.width))).toBeLessThan(2);
    expect(other.x).toBeGreaterThan(list.x + 40);
    expect(Math.abs(ours.x - list.x)).toBeLessThan(2);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(first).toHaveClass(/\bis-other\b/);
    const narrow = (await page.locator('.timeline-rows').boundingBox())!;
    const full = (await first.boundingBox())!;
    expect(Math.abs(full.width - narrow.width)).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('a calendar shades the freeze behind its changes, and its label opens the freeze; a holiday with no view is words', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, app);
    await page.goto(`${app.origin}/changes`);
    await expect(page.locator('.calendar-card', { hasText: 'Gateway firmware' }).first()).toBeVisible();
    for (const n of [8, 10, 12]) await expect(page.locator(`td[data-date="${day(n)}"]`)).toHaveAttribute('data-backdrop', 'warn');
    for (const n of [7, 13]) await expect(page.locator(`td[data-date="${day(n)}"]`)).not.toHaveAttribute('data-backdrop', /.*/);
    await expect(page.locator(`td[data-date="${day(25)}"]`)).toHaveAttribute('data-backdrop', 'neutral');
    const closed = page.locator(`td[data-date="${day(25)}"] .calendar-backdrop`);
    await expect(closed).toHaveText('Office closed');
    expect(await closed.evaluate((node) => node.tagName)).toBe('SPAN');
    const freeze = page.locator(`td[data-date="${day(8)}"] button.calendar-backdrop`);
    await expect(freeze).toHaveText('Quarter-end freeze');
    await freeze.click();
    await expect(page).toHaveURL(`${app.origin}/freezes/1`);
    await expect(page.getByRole('heading', { name: 'Quarter-end freeze' }).first()).toBeVisible();

    // A phone's agenda says the span on the day it starts, with its days.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${app.origin}/changes`);
    await expect(page.locator('.calendar-agenda-backdrops').getByText(/^Quarter-end freeze, /)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("a dashboard's custom section draws its read under the reader's window, at the width it was given", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, app);
    await page.goto(`${app.origin}/desk?period=last-30-days`);
    const section = page.locator('.page-section.dash-custom');
    await expect(section.getByRole('heading', { name: 'Urgent and open' })).toBeVisible();
    await expect(section.getByText('Opened last 30 days')).toBeVisible();
    await expect(section.getByRole('button', { name: 'VPN drops every hour' })).toBeVisible();
    await expect(section.getByText('Laptop swap')).toHaveCount(0);
    // The width keys every section takes: half of a row, which a section alone in its row may grow to fill.
    await expect(section).toHaveClass(/\bwidth-half\b/);
    await section.getByRole('button', { name: 'VPN drops every hour' }).click();
    await expect(page).toHaveURL(/\/1$/);
  });
});
