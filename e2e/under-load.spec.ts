/**
 * A loaded server, from a browser: reads that take seconds, and a session check that misses once. Its own server on a
 * `listen(0)` port over a `mkdtemp` database (support/sessionServer.ts), so it runs beside others.
 *
 *   - G211: while another person changes a ticket every half second and each of the reader's reads takes 2.5 s, the
 *     reader's page keeps painting the changes as they come — no read is cancelled by the next change — and the last
 *     one is drawn within a bound of its commit;
 *   - G212: a session check that meets a gateway's 503 once is asked again and the session stays; a 401 still locks.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './support/harness';
import { SESSION_APP_ID, startSessionApp } from './support/sessionServer';

test.describe('under load', () => {
  test.setTimeout(90_000);
  let app: Awaited<ReturnType<typeof startSessionApp>>;
  test.beforeEach(async () => {
    app = await startSessionApp({ live: true, history: true });
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  async function person(browser: import('@playwright/test').Browser, who: 0 | 1, path?: string) {
    const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const account = app.accounts[who];
    const signed = await context.request.post(`${app.origin}/api/auth/sign-in/email`, {
      headers: { origin: app.origin },
      data: { email: account.email, password: account.password },
    });
    expect(signed.ok()).toBe(true);
    const page = await context.newPage();
    if (path) await page.goto(`${app.origin}${path}`);
    return { context, page };
  }
  const rename = async (by: { context: BrowserContext }, name: string) => {
    const reply = await by.context.request.post(`${app.origin}/api/update?app=${SESSION_APP_ID}`, {
      headers: { origin: app.origin },
      data: { table: 'ticket', key: { id: 1 }, values: { name } },
    });
    expect(reply.ok(), await reply.text()).toBe(true);
  };
  const seen = (page: Page, mark: number) =>
    page.evaluate((n) => (window as unknown as { __seen: Record<string, number> }).__seen[n], String(mark));

  test('a steady stream of changes to a record whose reads are slow is painted as it comes, never starved', async ({ browser }) => {
    const READ_MS = 2_500,
      MARKS = 24;
    const alice = await person(browser, 0);
    const bob = await person(browser, 1, '/tickets/1');
    await expect(bob.page.getByText('Session-owned ticket').first()).toBeVisible({ timeout: 30_000 });
    /* Every read the page asks from now on is answered at once and handed over READ_MS later, as a loaded server's is:
       what it says is the database as the read began. The stream itself is not slowed. */
    await bob.page.route(
      (url) => url.pathname.startsWith('/api/') && !/^\/api\/(live|auth|whoami)/.test(url.pathname),
      async (route) => {
        try {
          const response = await route.fetch();
          const body = await response.body();
          await new Promise((resolve) => setTimeout(resolve, READ_MS));
          await route.fulfill({ response, body });
        } catch {
          /* The page went away, or the request was dropped: nothing to hand over. */
        }
      },
    );
    await bob.page.evaluate(() => {
      const marks: Record<string, number> = {};
      (window as unknown as { __seen: Record<string, number> }).__seen = marks;
      const look = () => {
        for (const found of document.body.innerText.matchAll(/\bMark (\d+)\b/g)) marks[found[1]] ??= Date.now();
      };
      new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    const committed: number[] = [];
    for (let n = 1; n <= MARKS; n++) {
      await rename(alice, `Mark ${n}`);
      committed[n] = Date.now();
      await bob.page.waitForTimeout(500);
    }
    const streamEnded = Date.now();
    await expect.poll(() => seen(bob.page, MARKS), { timeout: 30_000, intervals: [100] }).toBeTruthy();
    const marks = await bob.page.evaluate(() => (window as unknown as { __seen: Record<string, number> }).__seen);
    const paintedDuring = Object.values(marks).filter((at) => at < streamEnded).length;
    const last = marks[String(MARKS)] - committed[MARKS];
    test.info().annotations.push({ type: 'g211', description: JSON.stringify({ paintedDuring, last }) });
    // Changes were drawn while they kept coming, not only once they stopped.
    expect(paintedDuring).toBeGreaterThanOrEqual(2);
    // The last: the read already out, the hot gap and one read, with room for a browser under test.
    expect(last).toBeLessThan(15_000);
    await alice.context.close();
    await bob.context.close();
  });

  test('a session check that meets a 503 once is asked again, and the session stays; a 401 locks at once', async ({ browser }) => {
    const bob = await person(browser, 1, '/tickets/1');
    await expect(bob.page.getByText('Session-owned ticket').first()).toBeVisible({ timeout: 30_000 });
    const asked: number[] = [];
    let answer: 'miss-once' | 'expired' = 'miss-once';
    await bob.page.route(
      (url) => url.pathname === '/api/whoami',
      async (route) => {
        asked.push(Date.now());
        if (answer === 'miss-once' && asked.length === 1)
          return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"busy"}' });
        if (answer === 'expired') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"expired"}' });
        return route.continue();
      },
    );
    await bob.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => asked.length, { timeout: 10_000 }).toBe(2);
    expect(asked[1] - asked[0]).toBeGreaterThanOrEqual(700);
    await bob.page.waitForTimeout(300);
    await expect(bob.page.locator('#session-lock')).toHaveCount(0);
    await expect(bob.page.getByText('Session-owned ticket').first()).toBeVisible();

    answer = 'expired';
    asked.length = 0;
    await bob.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(bob.page.locator('#session-lock')).toHaveAttribute('role', 'alertdialog');
    expect(asked).toHaveLength(1);
    await bob.context.close();
  });
});
