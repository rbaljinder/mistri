// e2e-client: source — imports /sessionIdentity.ts from the page
/**
 * Live sync in a tenant App, from two browsers: two people in one tenant (Northstar) on one discussion, one changing
 * it while the other reads, edits and writes notes on it. The tenant proof's own process on a `listen(0)` port over
 * a `mkdtemp` database (support/tenantServer.ts, `notes`), so it runs beside others.
 *
 *   - a command form being filled says the change where it is seen, and moves nothing;
 *   - a record's every value follows, and its history names who;
 *   - a person's own notes are drawn, and one sent while the page reads itself again is neither lost nor stuck.
 */
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect, test } from './support/harness.js';
import { startTenantApp } from './support/tenantServer.js';
import { tenantProofModel, tenantProofRows } from '../test/support/tenantProofModel.js';
import { TENANT_HTTP_HEADERS as headers, type TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';

const APP_ID = 'tenant-thread-notes';
const TARGET = tenantProofRows.north.target;

test.describe('live sync in a tenant App', () => {
  test.setTimeout(90_000);
  let app: Awaited<ReturnType<typeof startTenantApp>>;
  test.beforeEach(async () => {
    app = await startTenantApp({ appId: APP_ID, tenantProof: 'thread', notes: true });
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  /** A person signed in, in Northstar, on the discussion's page at a desk. */
  async function person(browser: Browser, who: 'alice' | 'bob') {
    const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
    const account = app.accounts[who];
    const signed = await context.request.post(`${app.origin}/api/auth/sign-in/email`, {
      headers: { origin: app.origin },
      data: { email: account.email, password: account.password },
    });
    expect(signed.ok()).toBe(true);
    const page = await context.newPage();
    await page.goto(`${app.origin}/${APP_ID}/discussions/${TARGET}?tenant=northstar`);
    const opened = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/tenant/context/open');
    await page.getByRole('list', { name: 'Available tenants' }).getByRole('button', { name: 'northstar', exact: true }).click();
    expect((await opened).status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Northstar target', { timeout: 30_000 });
    /* A reload would lose this; a refresh in place keeps it. */
    await page.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true));
    /* Every stream names its tenant, and neither it nor a record's history is refused: a bare `/api/live` is one only
       the tenant host can refuse, and a refused history read once locked a page whose write had committed. */
    const refused: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/live' && !url.searchParams.has('tenant')) refused.push(`untenanted ${url.pathname}`);
    });
    page.on('response', (response) => {
      const { pathname } = new URL(response.url());
      if ((pathname === '/api/live' && response.status() >= 400) || (pathname === '/api/record-history' && response.status() === 403))
        refused.push(`${response.status()} ${pathname}`);
    });
    return { context, page, name: account.name, refused };
  }
  /** Nothing refused the page's stream or history, and its session stands. */
  const held = async (by: { page: Page; refused: string[] }) => {
    expect(by.refused).toEqual([]);
    await expect(by.page.getByRole('alertdialog', { name: 'Session unavailable' })).toHaveCount(0);
  };
  const sameDocument = (page: Page) => page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument === true);
  /** A change made as this person, under the tenant lease their page holds now: `renameDiscussion`, prepared for the
   *  discussion's revision and sent once, as a page sends it. `settled` is false where another change got there first. */
  const edit = async (by: { page: Page }, input: Record<string, string>, must = true) => {
    const lease = (await by.page.evaluate(async () => {
      const path = '/sessionIdentity.ts';
      return (await import(path)).captureTenantLease();
    })) as TenantContextReply;
    const call = (path: string, data: Record<string, unknown>) =>
      by.page.request.post(`${app.origin}${path}?${new URLSearchParams({ app: APP_ID, tenant: 'northstar' })}`, {
        headers: {
          origin: app.origin,
          [headers.app]: lease.appId,
          [headers.account]: lease.accountId,
          [headers.tab]: lease.tabId,
          [headers.context]: lease.context,
          [headers.revision]: String(lease.revision),
        },
        data,
      });
    const asked = { command: 'renameDiscussion', commandVersion: 1, key: { id: TARGET } };
    const prepared = await call('/api/commands/prepare', asked);
    expect(prepared.status(), await prepared.text()).toBe(200);
    const sent = await call('/api/commands/execute', {
      ...asked,
      expectedVersion: (await prepared.json()).expectedVersion,
      idempotencyKey: crypto.randomUUID(),
      input,
    });
    if (must) expect(sent.status(), await sent.text()).toBe(200);
    else expect([200, 409], await sent.text()).toContain(sent.status());
  };
  const fieldValue = (page: Page, caption: string) =>
    page
      .locator('.page-fields .page-field')
      .filter({ has: page.getByText(caption, { exact: true }) })
      .locator('dd');

  test('a command form being filled says the change where it is seen, and nothing moves', async ({ browser }) => {
    const alice = await person(browser, 'alice');
    const bob = await person(browser, 'bob');
    await bob.page.getByRole('button', { name: 'Add discussion', exact: true }).click();
    const form = bob.page.getByRole('dialog', { name: 'Add discussion' });
    const body = form.getByRole('textbox').first();
    await body.fill('Half a thought');
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
    await edit(alice, { name: 'Changed under the form' });
    const status = form.getByRole('status');
    await expect(status).toContainText(`${alice.name} changed this discussion`, { timeout: 10_000 });
    expect(await actions.boundingBox()).toEqual(before);
    await status.getByRole('button', { name: 'Keep editing' }).click();
    await expect(status).not.toContainText('changed this discussion');
    await expect(body).toHaveValue('Half a thought');
    await held(alice);
    await held(bob);
    await alice.context.close();
    await bob.context.close();
  });

  test('every value of a discussion another person changed follows, and its history names them', async ({ browser }) => {
    const alice = await person(browser, 'alice');
    const bob = await person(browser, 'bob');
    const title = bob.page.getByRole('heading', { level: 1 });
    await expect(fieldValue(bob.page, 'Status')).toHaveText('open');
    await edit(alice, { name: 'Renamed in place', status: 'waiting' });
    await expect(bob.page.locator('.history-entry').first()).toContainText('Renamed in place', { timeout: 10_000 });
    await expect(title).toHaveText('Renamed in place');
    await expect(fieldValue(bob.page, 'Status')).toHaveText('waiting');
    await expect(bob.page.locator('.history-entry').first().locator('.history-by')).toHaveText(alice.name);
    await expect(bob.page.getByText(`Updated by ${alice.name} just now`, { exact: true })).toBeVisible();
    expect(await sameDocument(bob.page)).toBe(true);
    await held(alice);
    await held(bob);
    await alice.context.close();
    await bob.context.close();
  });

  test('a history the reader cannot read is not-found, and the session it was asked in stands', async ({ browser }) => {
    const bob = await person(browser, 'bob');
    /* As a record's head asks it for any table a live change names: a record out of reach, or one whose page keeps no
       history. Answered as the context's denial, it locked the page over a save that had committed. */
    const status = await bob.page.evaluate(async (table) => {
      const path = '/core.js';
      try {
        await (await import(path)).api('/api/record-history', { table, key: { id: 'missing' }, limit: 1 });
        return 200;
      } catch (error) {
        return (error as { status?: number }).status ?? 0;
      }
    }, tenantProofModel('thread').target);
    expect(status).toBe(404);
    await held(bob);
    await expect(bob.page.getByRole('heading', { level: 1 })).toHaveText('Northstar target');
    expect(await sameDocument(bob.page)).toBe(true);
    await bob.context.close();
  });

  test("a person's own notes are drawn, and one sent while the page reads itself again is neither lost nor stuck", async ({ browser }) => {
    const alice = await person(browser, 'alice');
    const bob = await person(browser, 'bob');
    const composer = bob.page.getByRole('form', { name: 'Conversation' });
    const box = composer.getByRole('textbox');
    const send = composer.getByRole('button', { name: 'Reply', exact: true });
    await expect(box).toBeVisible();
    /* The other person keeps the discussion changing, so the page is reading itself again whenever a note is sent: a
       change about every half second, a busy record's pace. A note is prepared for the discussion's revision, and a
       change landing between its prepare and its execute refuses it as stale; the composer sends it again (up to three
       times). Faster than its own round trip, as a loaded machine makes a tenant's, every try would be refused. */
    let busy = true;
    const churn = (async () => {
      for (let n = 0; busy; n++) {
        await edit(alice, { name: `Churn ${n}` }, false);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    })();
    const refused: string[] = [];
    bob.page.on('response', (response) => {
      if (response.status() >= 500) refused.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
    try {
      for (let n = 1; n <= 6; n++) {
        const note = `Own note ${n}`;
        await box.fill(note);
        await send.click();
        await expect(bob.page.getByText(note, { exact: true })).toBeVisible({ timeout: 10_000 });
        await expect(box).toHaveValue('');
        await expect(composer.getByRole('button', { name: /Sending/ })).toHaveCount(0);
      }
    } finally {
      busy = false;
      await churn;
    }
    expect(refused).toEqual([]);
    expect(await sameDocument(bob.page)).toBe(true);
    await held(alice);
    await held(bob);
    await alice.context.close();
    await bob.context.close();
  });
});
