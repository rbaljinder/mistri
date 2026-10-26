import { expect, test, type Page } from './support/harness';
import { COMMONS_ADMIN, DEPOT_ADMIN, confirmEmail, startSample } from './support/sampleServer';
import { scalar } from './support/db';
import { chooseTab } from './support/tabs';

/**
 * Notifications, in the two samples that send them. A write tells the
 * people the App's `notify` rules name off the record — never the person
 * who made it — and each reads their own: the bell in the App bar counts
 * what they have not read, its menu lists the latest, the room at
 * `/{app}/notifications` holds them all, and opening one marks it read and
 * opens its record. Every expectation is read back from the fixture.
 */
const NOTICES = '__mistri_inbox_notice';
const bell = (page: Page) => page.getByRole('button', { name: /^Notifications/ });

/* The harness watches its own page; a second person's page is watched here, to the same rule. */
const crashes: string[] = [];
async function person(browser: import('@playwright/test').Browser, viewport = { width: 1440, height: 900 }): Promise<Page> {
  const page = await (await browser.newContext({ viewport })).newPage();
  page.on('pageerror', (error) => crashes.push(String(error)));
  return page;
}
test.afterEach(() => {
  expect(crashes.splice(0), "uncaught page errors on a second person's page").toEqual([]);
});

/** Sign up and follow the confirmation link: the inbox and `me` wait for a proven address where sign-up is open. */
async function signUp(page: Page, sample: { origin: string; log: () => string }, email: string, name: string) {
  const answer = await page.request.post(`${sample.origin}/api/auth/sign-up/email`, {
    headers: { origin: sample.origin },
    data: { name, email, password: 'disposable-notified-member-password' },
  });
  expect(answer.ok(), await answer.text()).toBe(true);
  await confirmEmail(page.request, sample.log, email);
}

let request = 0;
/** A command through the App's own command route, as the signed-in page would send it. */
async function command(page: Page, origin: string, app: string, body: Record<string, unknown>) {
  const reply = await page.request.post(`${origin}/api/commands/execute?app=${app}`, {
    headers: { origin },
    data: { expectedVersion: 0, idempotencyKey: `notifications-e2e-${Date.now()}-${request++}`, ...body },
  });
  expect(reply.ok(), await reply.text()).toBe(true);
  return reply.json();
}

test.describe('Notifications', () => {
  test.setTimeout(150_000);

  for (const width of [1440, 390]) {
    test(`${width}px: a reply tells the thread's author, whose bell, menu and inbox say so, and nobody else hears`, async ({ browser }) => {
      const sample = await startSample('commons');
      const viewport = { width, height: 900 };
      const author = await person(browser, viewport);
      const replier = await person(browser, viewport);
      try {
        // The author joins and starts a thread; the member row carries the email the account joined with.
        await signUp(author, sample, `author-${width}@example.test`, 'Avery Author');
        await command(author, sample.origin, 'commons', {
          command: 'joinCommunity',
          commandVersion: 1,
          key: {},
          input: { handle: `avery${width}`, display_name: 'Avery Author' },
        });
        expect(scalar(sample.db, 'SELECT email FROM member WHERE handle = ?', `avery${width}`)).toBe(`author-${width}@example.test`);
        const board = Number(scalar(sample.db, "SELECT id FROM board WHERE status = 'open' ORDER BY position LIMIT 1"));
        const title = `Kiln shelf spacing, take ${width}`;
        await command(author, sample.origin, 'commons', {
          command: 'startThread',
          commandVersion: 1,
          key: {},
          input: { board, title, body: 'How far apart do you set the shelves for a mixed glaze load?' },
        });
        const thread = Number(scalar(sample.db, 'SELECT id FROM thread WHERE title = ?', title));

        await author.goto(`${sample.origin}/latest`);
        await expect(bell(author)).toHaveAccessibleName('Notifications');
        // "My threads": the author's own, through `me` and the member row auth.me names.
        await chooseTab(author, /^My threads/);
        await expect(author.getByText(title, { exact: true }).filter({ visible: true }).first()).toBeVisible();

        // Another member replies, through the page's own Reply.
        await signUp(replier, sample, `replier-${width}@example.test`, 'Riley Replier');
        await command(replier, sample.origin, 'commons', {
          command: 'joinCommunity',
          commandVersion: 1,
          key: {},
          input: { handle: `riley${width}`, display_name: 'Riley Replier' },
        });
        await replier.goto(`${sample.origin}/latest/${thread}`);
        const more = replier.getByRole('button', { name: 'More actions', exact: true });
        const reply = replier.getByRole('button', { name: 'Reply', exact: true });
        await expect(reply.or(more).first()).toBeVisible();
        if (await reply.isVisible()) await reply.click();
        else {
          await more.click();
          await replier.getByRole('menuitem', { name: 'Reply', exact: true }).click();
        }
        const dialog = replier.getByRole('dialog', { name: 'Reply' });
        await dialog.getByLabel('Your reply', { exact: false }).fill('An inch and a half between shelves, and a cone pack on each.');
        await dialog.getByRole('button', { name: 'Reply', exact: true }).click();
        await expect(dialog.getByRole('status')).toHaveAttribute('data-phase', 'success');

        // Written in the reply's own transaction, to the author alone.
        expect(scalar(sample.db, `SELECT count(*) FROM ${NOTICES}`)).toBe(1);
        expect(scalar(sample.db, `SELECT recipient || ' ' || resource || ' ' || key_json FROM ${NOTICES}`)).toBe(
          `author-${width}@example.test thread {"id":${thread}}`,
        );
        // The replier hears nothing of their own reply.
        await replier.reload();
        await expect(bell(replier)).toHaveAccessibleName('Notifications');

        await author.reload();
        await expect(bell(author)).toHaveAccessibleName('Notifications, 1 unread');
        await bell(author).click();
        const notice = author.getByRole('menuitem', { name: new RegExp(`Riley Replier replied in ${title}`) });
        await expect(notice).toBeVisible();
        await notice.click();
        // Opening it opens the thread and reads it.
        await expect(author).toHaveURL(new RegExp(`/latest/${thread}$`));
        await expect(author.getByRole('heading', { name: title, level: 1 })).toBeVisible();
        await expect(bell(author)).toHaveAccessibleName('Notifications');
        expect(scalar(sample.db, `SELECT read_at IS NOT NULL FROM ${NOTICES}`)).toBe(1);

        // The room holds it, read, under its own address.
        await author.goto(`${sample.origin}/notifications`);
        await expect(author.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
        await expect(author.getByRole('button', { name: new RegExp(`Riley Replier replied in ${title}`) })).toBeVisible();
        await chooseTab(author, 'Unread');
        await expect(author.getByText('Nothing unread.')).toBeVisible();
      } finally {
        await author.context().close();
        await replier.context().close();
        await sample.stop();
      }
    });
  }

  test('a signed-out reader has no bell, no inbox and no tab about themselves; an inbox read is refused', async ({ page }) => {
    const sample = await startSample('commons');
    try {
      await page.goto(`${sample.origin}/latest`);
      await expect(page.getByRole('heading', { name: 'Latest' }).first()).toBeVisible();
      await expect(bell(page)).toHaveCount(0);
      await expect(page.getByRole('tab', { name: /^My threads/ })).toHaveCount(0);
      const refused = await page.request.post(`${sample.origin}/api/inbox`, {
        headers: { origin: sample.origin },
        data: { app: 'commons' },
      });
      expect(refused.status()).toBe(401);
      // A moderator is signed in and has one, empty.
      const signIn = await page.request.post(`${sample.origin}/api/auth/sign-in/email`, {
        headers: { origin: sample.origin },
        data: COMMONS_ADMIN,
      });
      expect(signIn.ok()).toBe(true);
      await page.goto(`${sample.origin}/notifications`);
      await expect(page.getByText('No notifications yet.')).toBeVisible();
    } finally {
      await sample.stop();
    }
  });

  test("a manager cancelling a buyer's purchase order tells the buyer, and the ledger says who moved stock", async ({ page, browser }) => {
    const sample = await startSample('depot');
    const buyer = await person(browser);
    try {
      const signIn = await page.request.post(`${sample.origin}/api/auth/sign-in/email`, {
        headers: { origin: sample.origin },
        data: DEPOT_ADMIN,
      });
      expect(signIn.ok()).toBe(true);
      const account = { email: 'buyer@depot.example.test', password: 'disposable-depot-buyer-password' };
      const made = await page.request.post(`${sample.origin}/api/auth/admin/create-user`, {
        headers: { origin: sample.origin },
        data: { ...account, name: 'Parker Buyer', role: 'purchaser' },
      });
      expect(made.ok(), await made.text()).toBe(true);
      const login = await buyer.request.post(`${sample.origin}/api/auth/sign-in/email`, {
        headers: { origin: sample.origin },
        data: account,
      });
      expect(login.ok()).toBe(true);

      // The buyer drafts an order: the draft is stamped with who they are, from their session.
      const supplier = Number(scalar(sample.db, "SELECT supplier_id FROM product WHERE status = 'active' ORDER BY id LIMIT 1"));
      const product = Number(
        scalar(sample.db, "SELECT id FROM product WHERE status = 'active' AND supplier_id = ? ORDER BY id LIMIT 1", supplier),
      );
      const drafted = await command(buyer, sample.origin, 'depot', {
        command: 'draftPurchaseOrder',
        commandVersion: 1,
        key: {},
        input: { supplier, warehouse: 1, lines: [{ product, quantity: 12 }] },
      });
      const po = Number(String(drafted.result.reference).replace('PO-', ''));
      expect(scalar(sample.db, "SELECT buyer || ' <' || buyer_email || '>' FROM purchase_order WHERE id = ?", po)).toBe(
        'Parker Buyer <buyer@depot.example.test>',
      );
      await buyer.goto(`${sample.origin}/purchase-orders?tab=mine`);
      // The order is named as the App labels it (`recordLabel: 'PO-{id}'`), in the buyer's own tab.
      await expect(buyer.getByRole('gridcell', { name: `PO-${po}`, exact: true }).first()).toBeVisible();
      await expect(bell(buyer)).toHaveAccessibleName('Notifications');

      // The manager cancels it from its page.
      await page.goto(`${sample.origin}/purchase-orders/${po}`);
      const cancel = page.getByRole('button', { name: 'Cancel order', exact: true });
      const more = page.getByRole('button', { name: 'More actions', exact: true });
      await expect(cancel.or(more).first()).toBeVisible();
      if (await cancel.isVisible()) await cancel.click();
      else {
        await more.click();
        await page.getByRole('menuitem', { name: 'Cancel order', exact: true }).click();
      }
      const dialog = page.getByRole('dialog', { name: 'Cancel order' });
      await dialog.getByLabel('Reason', { exact: false }).fill('Supplier discontinued the size run.');
      await dialog.getByRole('button', { name: 'Cancel order', exact: true }).click();
      await expect(dialog.getByRole('status')).toHaveAttribute('data-phase', 'success');
      const supplierName = String(scalar(sample.db, 'SELECT name FROM supplier WHERE id = ?', supplier));

      await buyer.reload();
      await expect(bell(buyer)).toHaveAccessibleName('Notifications, 1 unread');
      await buyer.goto(`${sample.origin}/notifications`);
      await expect(buyer.getByRole('button', { name: `Unread: PO-${po} from ${supplierName} is cancelled` }).first()).toBeVisible();
      await buyer.getByRole('button', { name: 'Mark all read', exact: true }).click();
      await expect(bell(buyer)).toHaveAccessibleName('Notifications');

      // Receiving writes a ledger line stamped with the account that moved it.
      const line = Number(
        scalar(
          sample.db,
          `SELECT l.id FROM po_line l JOIN purchase_order o ON o.id = l.purchase_order_id
        WHERE o.status = 'sent' AND o.warehouse_id = 1 AND l.status = 'open' ORDER BY l.id LIMIT 1`,
        ),
      );
      await page.goto(`${sample.origin}/receiving/~${line}`);
      await page.getByRole('button', { name: 'Receive', exact: true }).first().click();
      const receive = page.getByRole('dialog', { name: 'Receive' });
      await receive.getByRole('button', { name: 'Receive', exact: true }).click();
      await expect(receive.getByRole('status')).toHaveAttribute('data-phase', 'success');
      expect(scalar(sample.db, 'SELECT moved_by FROM stock_movement ORDER BY id DESC LIMIT 1')).toBe(DEPOT_ADMIN.email);
    } finally {
      await buyer.context().close();
      await sample.stop();
    }
  });
});
