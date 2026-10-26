import { test, expect, type Page } from './support/harness.js';
import { scalar } from './support/db.js';
import { startTenantApp, type TenantAppFixture } from './support/tenantServer.js';
import { TENANT_HTTP_HEADERS as headers, type TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';

// Audited support ("enter as dealer", pieces 5A and 5B) in the shared browser
// UI, over genuine native sign-in (support/tenantSupportFixture.ts). A lender
// opens a session inside a dealer from the platform realm; the banner names the
// dealer, the role and the end; a reload resumes the same login's session; Exit
// returns to the platform.
//
// The page still shows the dealer nothing. 5B opened the audited read path on
// the server — a request naming the support realm is served and ledgered — but
// the client has not been taught to address it, so the UI grants nothing and
// says so. This spec pins both halves at once, because the interesting claim is
// that they differ on purpose: the transport is audited, the screen is empty,
// and nothing anywhere may act.
test.describe('entering a dealer for audited support', () => {
  test.setTimeout(60000);
  let app: TenantAppFixture;
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
    app = await startTenantApp({ support: true });
  });
  test.afterEach(async ({ page }) => {
    try {
      await page.unrouteAll({ behavior: 'wait' });
    } finally {
      await app?.stop();
    }
  });

  const signIn = async (page: Page) => {
    const bob = app.accounts.bob;
    expect(
      (
        await page.request.post(app.origin + '/api/auth/sign-in/email', {
          headers: { origin: app.origin },
          data: { email: bob.email, password: bob.password },
        })
      ).status(),
    ).toBe(200);
    await page.goto(`${app.origin}/${app.appId}`);
    await page.getByRole('list', { name: 'Available dealers' }).getByRole('button', { name: 'Lender', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Lender', exact: true })).toBeVisible();
  };

  test('a lender enters a dealer, sees the banner and no dealer data, resumes after a reload, and exits', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Enter dealer', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Enter a dealer' });
    // The dealer by its profile row's name; entered by its id.
    await dialog.getByRole('radio', { name: 'North Motors', exact: true }).check();
    await expect(dialog.getByRole('radio', { name: 'Dealer staff', exact: true })).toBeChecked();
    await dialog.getByRole('textbox', { name: 'Reason' }).fill('Checking a stuck application');
    const opened = page.waitForResponse((reply) => new URL(reply.url()).pathname === '/api/tenant/support/open');
    await dialog.getByRole('button', { name: 'Enter dealer', exact: true }).click();
    const reply = await opened;
    expect(reply.status()).toBe(200);
    const lease = (await reply.json()).context as TenantContextReply;
    expect(lease.realm).toBe('support');

    const banner = page.getByRole('region', { name: 'Support session' });
    await expect(banner).toContainText('North Motors as Dealer staff');
    await expect(banner.getByRole('button', { name: 'Exit' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Support access is not available yet' })).toBeVisible();
    await expect(page.getByText('North lead')).toHaveCount(0);

    // What the server says, not what the page shows. Addressed as the dealer's
    // own lease, the read is refused exactly as it was before 5B.
    const onLease = (selector: Record<string, string>, target: string, data: unknown) =>
      page.request.post(`${app.origin}${target}?${new URLSearchParams({ app: app.appId, ...selector })}`, {
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
    const refused = await onLease({ tenant: 'north' }, '/api/query', { table: 'lead' });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe('tenant_support_unavailable');

    // Named to the support realm it is served, and the ledger has recorded it
    // before the body was released: one entry per request, beside the open.
    const served = await onLease({ realm: 'support', tenant: 'north' }, '/api/query', { table: 'lead' });
    expect(served.status()).toBe(200);
    expect((await served.json()).rows.map((row: { id: string }) => row.id)).toEqual(['north-1']);
    expect(await scalar(app.database, "SELECT count(*) FROM __mistri_support_entry WHERE kind = 'read'")).toBe(1);

    // Acting stays refused on that same address, and records no write.
    const edit = await onLease({ realm: 'support', tenant: 'north' }, '/api/update', {
      table: 'lead',
      key: { id: 'north-1' },
      values: { name: 'Changed under support' },
    });
    expect(edit.status()).toBe(403);
    expect(await scalar(app.database, "SELECT count(*) FROM __mistri_support_entry WHERE kind = 'write'")).toBe(0);
    expect(await scalar(app.database, "SELECT name FROM lead WHERE id = 'north-1'")).toBe('North lead');

    // The same login's session resumes after a reload, without the chooser.
    await page.reload();
    await expect(page.getByRole('region', { name: 'Support session' })).toContainText('North Motors as Dealer staff');
    await expect(page.getByRole('list', { name: 'Available dealers' })).toHaveCount(0);

    await page.getByRole('region', { name: 'Support session' }).getByRole('button', { name: 'Exit' }).click();
    await expect(page.getByRole('button', { name: 'Lender', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Support session' })).toHaveCount(0);
    expect(await scalar(app.database, 'SELECT end_reason FROM __mistri_support_session')).toBe('exit');
    expect(await scalar(app.database, 'SELECT operator_name FROM __mistri_support_session')).toBe('bob');
  });

  test("a dealer's own member, in the dealer's realm, is offered no Enter dealer", async ({ page }) => {
    const alice = app.accounts.alice;
    expect(
      (
        await page.request.post(app.origin + '/api/auth/sign-in/email', {
          headers: { origin: app.origin },
          data: { email: alice.email, password: alice.password },
        })
      ).status(),
    ).toBe(200);
    // Her one dealer membership is entered without the chooser.
    await page.goto(`${app.origin}/${app.appId}`);
    await expect(page.getByRole('button', { name: 'Dealer: North Motors' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enter dealer' })).toHaveCount(0);
  });
});
