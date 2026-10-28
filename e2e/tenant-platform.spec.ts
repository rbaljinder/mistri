import { test, expect, type Page } from './support/harness.js';
import { scalar } from './support/db.js';
import { startTenantApp, type TenantAppFixture } from './support/tenantServer.js';
import { TENANT_HTTP_HEADERS as headers, type TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';
import { isSelection, leaseOfSelection } from './support/tenantSelection.js';
import { COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from '../test/support/commandTargets.js';

// The platform realm in the shared browser UI, over genuine native sign-in
// (support/tenantPlatformFixture.ts). A command's button is offered only on
// its own realm's lease and only to a member whose role grants it: the
// lender's lease offers the platform's command and no edits; a dealer's lease
// offers the dealer's command and never the platform's.
test.describe('the platform realm in the browser', () => {
  test.setTimeout(60000);
  let app: TenantAppFixture;
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
    app = await startTenantApp({ platform: true });
  });
  test.afterEach(async ({ page }) => {
    try {
      await page.unrouteAll({ behavior: 'wait' });
    } finally {
      await app?.stop();
    }
  });

  /** Sign in, open the link, and choose from the chooser by its shown name. Alice's one dealer membership is
      entered without the chooser; Bob's sole platform membership is still asked for. */
  const enter = async (page: Page, who: 'alice' | 'bob', link: string, choice: string, current: string) => {
    const account = app.accounts[who];
    expect(
      (
        await page.request.post(app.origin + '/api/auth/sign-in/email', {
          headers: { origin: app.origin },
          data: { email: account.email, password: account.password },
        })
      ).status(),
    ).toBe(200);
    const response = page.waitForResponse(isSelection);
    await page.goto(`${app.origin}/${app.appId}/${link}`);
    if (who === 'bob')
      await page.getByRole('list', { name: 'Available dealers' }).getByRole('button', { name: choice, exact: true }).click();
    const reply = await response;
    expect(reply.status()).toBe(200);
    await expect(page.getByRole('button', { name: current, exact: true })).toBeVisible();
    return leaseOfSelection(reply);
  };
  /** A request on the tab's own lease, outside the UI: what the server says, not what the page shows. */
  const call = (page: Page, owner: TenantContextReply, path: string, data: Record<string, unknown>) =>
    page.request.post(
      `${app.origin}${path}?${new URLSearchParams({
        app: app.appId,
        ...(owner.realm === 'platform' ? { realm: 'platform' } : { tenant: owner.tenantId }),
      })}`,
      {
        headers: {
          origin: app.origin,
          [headers.app]: owner.appId,
          [headers.account]: owner.accountId,
          [headers.tab]: owner.tabId,
          [headers.context]: owner.context,
          [headers.revision]: String(owner.revision),
        },
        data,
      },
    );
  const open = async (page: Page, name: string) => {
    await page.getByRole('row').filter({ hasText: name }).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  };
  /* Both commands ask nothing, so each runs on one click with no dialog and says so in its notice (df773272). */
  const run = async (page: Page, label: string) => {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('#toast')).toBeVisible();
    await expect(page.getByRole('dialog', { name: label, exact: true })).toHaveCount(0);
  };
  const audit = (id: string) =>
    scalar(app.database, `SELECT realm || ':' || owner_tenant_id FROM ${sqliteAuditRows} a WHERE key_json = ?`, JSON.stringify({ id }));

  test("the lender's lease offers the platform's command on every dealer's lead, and nothing to edit", async ({ page }) => {
    const lender = await enter(page, 'bob', 'lead?realm=platform', 'Lender', 'Lender');
    expect(lender).toMatchObject({ realm: 'platform', tenantId: '@platform' });
    await expect(page.getByRole('row').filter({ hasText: 'North lead' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'South lead' })).toBeVisible();
    await open(page, 'South lead');
    await expect(page.getByRole('button', { name: 'Escalate lead', exact: true })).toBeVisible();
    // The dealer's command is not the lender's, and the platform realm edits nothing generically.
    await expect(page.getByRole('button', { name: 'Flag lead', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete…', exact: true })).toHaveCount(0);
    await run(page, 'Escalate lead');
    expect(scalar(app.database, "SELECT status || ':' || version FROM lead WHERE id = 'south-1'")).toBe('escalated:1');
    expect(audit('south-1')).toBe('platform:south');
    // The server agrees with the page: the dealer's command, and any generic write, are refused here.
    expect(
      (await call(page, lender, '/api/commands/prepare', { command: 'flag', commandVersion: 1, key: { id: 'north-1' } })).status(),
    ).toBe(403);
    expect((await call(page, lender, '/api/update', { table: 'lead', key: { id: 'north-1' }, values: { name: 'Renamed' } })).status()).toBe(
      403,
    );
    expect(scalar(app.database, "SELECT name || ':' || status FROM lead WHERE id = 'north-1'")).toBe('North lead:open');
  });

  test("a dealer's lease offers the dealer's own command and never the platform's", async ({ page }) => {
    const north = await enter(page, 'alice', 'lead?tenant=north', 'North Motors', 'Dealer: North Motors');
    await expect(page.getByRole('row').filter({ hasText: 'North lead' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'South lead' })).toHaveCount(0);
    await open(page, 'North lead');
    await expect(page.getByRole('button', { name: 'Flag lead', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Escalate lead', exact: true })).toHaveCount(0);
    expect(
      (await call(page, north, '/api/commands/prepare', { command: 'escalate', commandVersion: 1, key: { id: 'north-1' } })).status(),
    ).toBe(403);
    await run(page, 'Flag lead');
    expect(scalar(app.database, "SELECT status || ':' || version FROM lead WHERE id = 'north-1'")).toBe('flagged:1');
    expect(audit('north-1')).toBe('tenant:north');
    expect(scalar(app.database, `SELECT count(*) FROM ${COMMAND_JOURNAL_TABLES.receipt}`)).toBe(1);
  });
});
