/**
 * Live sync, from two browsers: one person changes a ticket and the other's page follows it, with nothing reloaded.
 * Its own server on a `listen(0)` port over a `mkdtemp` database (support/sessionServer.ts), so it runs beside others.
 *
 *   - a list refreshes in place, quietly;
 *   - a list its reader is working in holds still behind "N updates · Show";
 *   - a record being viewed says it was updated, and by whom (its history names them);
 *   - a record being edited is not changed underneath: a notice that names who, and the typed value stays;
 *   - a command form being filled says the change where it can be seen and pressed, and moves nothing;
 *   - a record's every value follows, its history names who;
 *   - a person's own notes are drawn, and one sent while the page reads itself again is neither lost nor stuck.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './support/harness';
import { SESSION_APP_ID, startSessionApp } from './support/sessionServer';

test.describe('live sync', () => {
  test.setTimeout(60_000);
  let app: Awaited<ReturnType<typeof startSessionApp>>;
  test.beforeEach(async () => {
    app = await startSessionApp({ live: true, history: true, notes: true });
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  /** A person signed in on a page of their own, at a desk. */
  async function person(browser: import('@playwright/test').Browser, who: 0 | 1, path: string) {
    const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const account = app.accounts[who];
    const signed = await context.request.post(`${app.origin}/api/auth/sign-in/email`, {
      headers: { origin: app.origin },
      data: { email: account.email, password: account.password },
    });
    expect(signed.ok()).toBe(true);
    const page = await context.newPage();
    await page.goto(`${app.origin}${path}`);
    /* A reload would lose this; a refresh in place keeps it. */
    await page.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true));
    return { context, page };
  }
  /** The one drawn at this width: a list keeps a row's text in more than one place. */
  const shown = (page: Page, text: string) => page.getByText(text).locator('visible=true').first();
  const sameDocument = (page: Page) => page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument === true);
  const rename = async (by: { context: BrowserContext }, id: number, name: string, more: Record<string, string> = {}) => {
    const reply = await by.context.request.post(`${app.origin}/api/update?app=${SESSION_APP_ID}`, {
      headers: { origin: app.origin },
      data: { table: 'ticket', key: { id }, values: { name, ...more } },
    });
    expect(reply.ok()).toBe(true);
  };

  test("a list follows another person's change without a reload", async ({ browser }) => {
    const alice = await person(browser, 0, '/tickets');
    const bob = await person(browser, 1, '/tickets');
    await expect(shown(bob.page, 'Session-owned ticket')).toBeVisible();
    await rename(alice, 1, 'Renamed by Alice');
    await expect(shown(bob.page, 'Renamed by Alice')).toBeVisible({ timeout: 10_000 });
    expect(await sameDocument(bob.page)).toBe(true);
    await alice.context.close();
    await bob.context.close();
  });

  test('a list its reader is working in holds still behind a pill, and Show refreshes it', async ({ browser }) => {
    const alice = await person(browser, 0, '/tickets');
    const bob = await person(browser, 1, '/tickets');
    await expect(shown(bob.page, 'Session-owned ticket')).toBeVisible();
    /* The pointer over the rows is working in them. */
    await shown(bob.page, 'Another ticket').hover();
    await rename(alice, 1, 'Held until shown');
    const pill = bob.page.getByRole('button', { name: 'Show the updates' });
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await expect(pill).toContainText('Show');
    await expect(bob.page.getByText('Held until shown').locator('visible=true')).toHaveCount(0);
    await pill.click();
    await expect(shown(bob.page, 'Held until shown')).toBeVisible({ timeout: 10_000 });
    await expect(pill).toHaveCount(0);
    expect(await sameDocument(bob.page)).toBe(true);
    await alice.context.close();
    await bob.context.close();
  });

  test('a record being viewed refreshes in place and says it was updated', async ({ browser }) => {
    const alice = await person(browser, 0, '/tickets/1');
    const bob = await person(browser, 1, '/tickets/1');
    await expect(shown(bob.page, 'Session-owned ticket')).toBeVisible();
    await rename(alice, 1, 'Viewed and renamed');
    await expect(shown(bob.page, 'Viewed and renamed')).toBeVisible({ timeout: 10_000 });
    await expect(bob.page.getByText('Updated by Alice just now', { exact: true })).toBeVisible();
    expect(await sameDocument(bob.page)).toBe(true);
    await alice.context.close();
    await bob.context.close();
  });

  test('a record being edited is not changed underneath: a notice, and what was typed stays', async ({ browser }) => {
    const alice = await person(browser, 0, '/tickets/1');
    const bob = await person(browser, 1, '/tickets/1');
    await bob.page.getByRole('button', { name: 'Edit Name', exact: true }).click();
    const input = bob.page.getByRole('textbox', { name: 'Name', exact: true });
    await input.fill('Bob is typing');
    await input.press('Tab');
    await rename(alice, 1, 'Alice got there first');
    const notice = bob.page.locator('.live-notice');
    await expect(notice).toContainText('Alice changed this ticket', { timeout: 10_000 });
    await expect(bob.page.getByRole('button', { name: 'Review changes' })).toBeVisible();
    await expect(input).toHaveValue('Bob is typing');
    await bob.page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(notice).toHaveCount(0);
    await expect(input).toHaveValue('Bob is typing');
    expect(await sameDocument(bob.page)).toBe(true);
    await alice.context.close();
    await bob.context.close();
  });

  /** The value a record's fields section draws for a caption. */
  const fieldValue = (page: Page, caption: string) =>
    page
      .locator('.page-fields .page-field')
      .filter({ has: page.getByText(caption, { exact: true }) })
      .locator('dd');

  test('a command form being filled says the change where it is seen, Keep editing can be pressed, and nothing moves', async ({
    browser,
  }) => {
    const alice = await person(browser, 0, '/tickets/1');
    const bob = await person(browser, 1, '/tickets/1');
    await bob.page.getByRole('button', { name: 'Close', exact: true }).click();
    const form = bob.page.getByRole('dialog', { name: 'Close' });
    const reason = form.getByRole('textbox', { name: 'Reason' });
    await reason.fill('Fixed by a restart');
    const actions = form.locator('.confirm-actions');
    /* Where the actions stand once the dialog has finished opening: its scale-in run out first, since two reads in one
       frame of it agree and passed the check below while the dialog was still at 0.98. */
    await actions.evaluate((el) => Promise.all((el.closest('.modal')?.getAnimations() ?? []).map((animation) => animation.finished)));
    let before = await actions.boundingBox();
    await expect(async () => {
      const now = await actions.boundingBox();
      const same = JSON.stringify(now) === JSON.stringify(before);
      before = now;
      expect(same).toBe(true);
    }).toPass({ intervals: [200] });
    await rename(alice, 1, 'Changed under the form');
    const status = form.getByRole('status');
    await expect(status).toContainText('Alice changed this ticket', { timeout: 10_000 });
    /* Drawn, not a screen reader's alone: a line of text's height, and its answer pressed with the pointer. */
    const drawn = (await status.boundingBox())!;
    expect(drawn.width).toBeGreaterThan(100);
    expect(drawn.height).toBeGreaterThan(16);
    expect(await actions.boundingBox()).toEqual(before);
    await status.getByRole('button', { name: 'Keep editing' }).click();
    await expect(status).not.toContainText('changed this ticket');
    expect(await actions.boundingBox()).toEqual(before);
    await expect(reason).toHaveValue('Fixed by a restart');
    await alice.context.close();
    await bob.context.close();
  });

  test('every value of a record another person changed follows, and its history names them', async ({ browser }) => {
    const alice = await person(browser, 0, '/tickets/1');
    const bob = await person(browser, 1, '/tickets/1');
    const title = bob.page.getByRole('heading', { level: 1 });
    await expect(title).toHaveText('Session-owned ticket');
    await expect(fieldValue(bob.page, 'Status')).toHaveText('open');
    await rename(alice, 1, 'Renamed in place', { status: 'waiting' });
    await expect(bob.page.locator('.history-entry').first()).toContainText('Renamed in place', { timeout: 10_000 });
    /* The head's name and the fields' status, not only the history that says they changed. */
    await expect(title).toHaveText('Renamed in place');
    await expect(fieldValue(bob.page, 'Status')).toHaveText('waiting');
    await expect(bob.page.locator('.history-entry').first().locator('.history-by')).toHaveText('Alice');
    expect(await sameDocument(bob.page)).toBe(true);
    await alice.context.close();
    await bob.context.close();
  });

  test("a person's own notes are drawn, and one sent while the page reads itself again is neither lost nor stuck", async ({ browser }) => {
    const alice = await person(browser, 0, '/tickets/1');
    const bob = await person(browser, 1, '/tickets/1');
    const composer = bob.page.getByRole('form', { name: 'Conversation' });
    const box = composer.getByRole('textbox');
    const send = composer.getByRole('button', { name: 'Reply', exact: true });
    await expect(box).toBeVisible();
    /* Another person keeps the ticket changing, so the page is reading itself again whenever a note is sent. */
    let busy = true;
    const churn = (async () => {
      for (let n = 0; busy; n++) {
        await rename(alice, 1, `Churn ${n}`);
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    })();
    try {
      for (let n = 1; n <= 6; n++) {
        const note = `Own note ${n}`;
        await box.fill(note);
        await send.click();
        /* Written, and drawn on the author's own page; the composer let go of it. */
        await expect(bob.page.getByText(note, { exact: true })).toBeVisible({ timeout: 10_000 });
        await expect(box).toHaveValue('');
        await expect(composer.getByRole('button', { name: /Sending/ })).toHaveCount(0);
      }
    } finally {
      busy = false;
      await churn;
    }
    expect(await sameDocument(bob.page)).toBe(true);
    await alice.context.close();
    await bob.context.close();
  });
});
