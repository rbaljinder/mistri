/**
 * The connections screen, once there is already a database open.
 *
 * Its own file rather than a describe inside `onboarding.spec.ts`, because
 * that file opts every test into a browser that has never been here — which
 * is right for a first run and wrong here: the tour opens over the page and
 * its scrim swallows the click this test is about. This one wants the
 * ordinary browser the rest of the suite uses.
 */
import { DEMO, expect, SCRATCH_DB, test } from './support/ownServers';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer'] });

test.describe('adding one while another is open', () => {
  test('"Add and open" opens it', async ({ page }) => {
    await page.goto(`/${DEMO}`);
    await expect(page.getByRole('button', { name: 'Manage connections' })).toBeVisible();

    await page.getByRole('button', { name: 'Manage connections' }).click();
    await page.getByRole('button', { name: '+ Add' }).click();
    await page.getByLabel('Connection URL or file path').fill(SCRATCH_DB);
    await page.getByLabel('Connection name').fill('opened');
    await page.getByRole('button', { name: 'Add and open' }).click();

    /* The button names the act, and did not perform it. `add` on the server
       makes a connection active only when there is not one already, so
       adding a second left you looking at the first — and when that first one
       was broken, at its error, with the connection you had just successfully
       added sitting unselected in the list. */
    await expect.poll(() => new URL(page.url()).pathname).toBe('/opened');
    // And the manager gets out of the way, because you asked to open it.
    await expect(page.locator('.conn-manager')).toHaveCount(0);

    /* Take it out again, and not only for tidiness. The suite shares one
       server, so a connection left behind is in every later test's picker —
       and this one points at `scratch.db`, which made the write tests'
       `getByRole('option', { name: /scratch/ })` match two rows and fail four
       tests in a file that has nothing to do with this one. */
    const gone = await page.request.post('/api/connections/remove', { data: { id: 'opened' } });
    expect(gone.ok()).toBe(true);

    /* And put the tab back where the rest of the run expects it. A link
       rather than the manager's list: which connection a tab is looking at is
       the tab's own state, and a URL is how that state is addressed. */
    await page.goto(`/${DEMO}`);
    await expect(page.locator('#conn-picker')).toContainText(DEMO);
  });
});

test.describe('a panel that says it is modal', () => {
  test('keeps the keyboard, and gives it back', async ({ page }) => {
    await page.goto(`/${DEMO}`);
    /* The gear, not `#db-label`: with more than one connection the label is
       hidden and the picker beside it is what is on screen. */
    const opener = page.getByRole('button', { name: 'Manage connections' });
    await opener.click();
    const panel = page.locator('.conn-manager');
    await expect(panel).toBeVisible();

    /* `aria-modal="true"` is a promise that everything behind this is inert.
       Eight surfaces here made it on a plain `<div>` with nothing enforcing
       it, so Tab walked out into the table underneath — a page that reads as
       sealed to a screen reader and is open to a keyboard. */
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Tab');
      await expect(panel).toContainText(/./);
      const inside = await page.evaluate(() => document.querySelector('.conn-manager')?.contains(document.activeElement) ?? false);
      expect(inside, `Tab ${i + 1} left the panel`).toBe(true);
    }

    /* And back to what opened it. Closing used to drop focus on `<body>`, so
       the next Tab started again from the top of the document. */
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
});

test.describe('editing an existing connection', () => {
  test('Test says there is nothing to test rather than doing nothing', async ({ page }) => {
    await page.goto(`/${DEMO}`);
    await page.getByRole('button', { name: 'Manage connections' }).click();
    /* The row's actions are `visibility: hidden` until the row is hovered,
       focused within, or under the keyboard cursor. */
    await page.locator('.conn-row').first().hover();
    await page.getByRole('button', { name: /^Edit/ }).first().click();
    await expect(page.getByRole('heading', { name: /^Edit / })).toBeVisible();

    /* A stored connection string never leaves the server — only its redacted
       form does — so this form opens blank on purpose. Test had nothing to
       send and returned silently, which reads as a broken button. */
    await page.getByRole('button', { name: 'Test' }).click();
    await expect(page.locator('.conn-result.bad')).toContainText('Nothing to test yet');
  });
});
