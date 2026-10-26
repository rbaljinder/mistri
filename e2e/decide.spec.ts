/*
 * A decision's suggestions in the browser (design §7): on a list, a muted
 * mark in the empty cell; on a record, the chip in the empty mark's place or
 * after a person's value, with Accept running the command as the person, and
 * "Why this?" saying what was asked. A suggestion that arrives after the page
 * has painted moves nothing: the layout shift is zero, at a desk and on a phone,
 * where a list's card marks its empty fact as a desk's list marks the cell.
 */
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from './support/harness';
import { startDecideApp } from './support/decideServer';

type Fixture = Awaited<ReturnType<typeof startDecideApp>>;

async function signIn(page: Page, app: Fixture) {
  const response = await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin },
    data: { email: app.account.email, password: app.account.password },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

function stored(app: Fixture, id: number) {
  const db = new DatabaseSync(app.database, { readOnly: true, timeout: 5000 });
  try {
    return db.prepare('SELECT category FROM incident WHERE id = ?').get(id) as { category: string | null };
  } finally {
    db.close();
  }
}

/** The layout shift the page has had since it was opened, read after a settle: input-caused shifts aside. */
const shifted = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((done) => {
        let total = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
            if (!entry.hadRecentInput) total += entry.value;
        }).observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => done(total), 500);
      }),
  );

test.describe('Decisions', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);
  let app: Fixture;
  test.beforeAll(async () => {
    app = await startDecideApp();
  });
  test.afterAll(async () => {
    await app?.stop();
  });

  test('a list marks the row a suggestion waits on, in the empty cell, and the mark moves nothing', async ({ page }) => {
    await signIn(page, app);
    // Held back until the rows are on screen: the marks arrive into a list already painted.
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    await page.route('**/api/record-decisions/marks*', async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(`${app.origin}/incidents`);
    const printer = page.getByRole('row', { name: /Printer jams on floor 3/ });
    await expect(printer).toBeVisible();
    release();
    await expect(printer.locator('.decision-mark')).toHaveText('printer');
    expect(await shifted(page)).toBe(0);
    // Applied is a value like any other; a suggestion beside a person's value is the record's to show.
    await expect(page.getByRole('row', { name: /VPN down/ }).locator('.decision-mark')).toHaveCount(0);
    await expect(page.getByRole('row', { name: /Laptop is slow/ }).locator('.decision-mark')).toHaveCount(0);
  });

  test('on a phone the card marks its empty fact, and the mark moves nothing', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await signIn(page, app);
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    await page.route('**/api/record-decisions/marks*', async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(`${app.origin}/incidents`);
    const printer = page.locator('.record-summary', { hasText: 'Printer jams on floor 3' });
    await expect(printer).toBeVisible();
    await expect(printer.locator('.decision-fact')).toHaveCount(1);
    release();
    await expect(printer.locator('.decision-fact-mark')).toBeVisible();
    expect(await shifted(page)).toBe(0);
    // A person's value is the card's own: no mark beside it.
    await expect(page.locator('.record-summary', { hasText: 'Laptop is slow' }).locator('.decision-fact-mark')).toHaveCount(0);
  });

  for (const width of [1280, 390])
    test(`a suggestion arriving after the record painted moves nothing at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signIn(page, app);
      // Held back until the record's fields are on screen: it arrives into a page already painted.
      let release!: () => void;
      const held = new Promise<void>((done) => (release = done));
      await page.route('**/api/record-decisions*', async (route) => {
        if (new URL(route.request().url()).pathname === '/api/record-decisions') await held;
        await route.continue();
      });
      await page.goto(`${app.origin}/incidents/3`);
      await expect(page.getByText('software', { exact: true })).toBeVisible();
      release();
      const chip = page.locator('.decision-chip');
      await expect(chip).toBeVisible();
      await expect(chip.getByLabel('Suggested: hardware, very likely')).toBeVisible();
      expect(await shifted(page)).toBe(0);
      // Beside a person's value, never over it: the value is still theirs.
      expect(stored(app, 3).category).toBe('software');
    });

  test('Accept runs the command as the person, and the suggestion becomes the value', async ({ page }) => {
    await signIn(page, app);
    await page.goto(`${app.origin}/incidents/2`);
    const chip = page.locator('.decision-chip');
    await expect(chip.getByLabel('Suggested: printer, likely')).toBeVisible();
    await chip.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(chip).toHaveCount(0);
    expect(stored(app, 2).category).toBe('printer');
    await expect.poll(() => app.decided().find((row) => row.record_key === '{"id":2}')?.outcome).toBe('accepted');
  });

  test('"Why this?" says what was asked, with what, of whom and how surely', async ({ page }) => {
    await signIn(page, app);
    await page.goto(`${app.origin}/incidents/3`);
    await page.getByRole('button', { name: 'More about the suggestion hardware' }).click();
    await page.getByRole('menuitem', { name: 'Why this?' }).click();
    const why = page.getByRole('dialog', { name: 'Why hardware?' });
    await expect(why).toContainText('Which category is this incident?');
    await expect(why).toContainText('Laptop is slow');
    await expect(why).toContainText('jev-1-2026-10');
    await expect(why).toContainText('88% · very likely');
    await why.getByRole('button', { name: 'Close' }).click();
    // Dismissed, it is gone, and the person's value stands.
    await page.getByRole('button', { name: 'More about the suggestion hardware' }).click();
    await page.getByRole('menuitem', { name: 'Dismiss' }).click();
    await expect(page.locator('.decision-chip')).toHaveCount(0);
    expect(stored(app, 3).category).toBe('software');
  });
});
