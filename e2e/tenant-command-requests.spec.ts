import { test, expect, type Page } from './support/harness.js';
import { follow } from './support/app.js';
import { startTenantAssignment, type TenantAssignmentFixture } from './support/tenantProofServer.js';

/*
 * What one command costs a tenant's record page once it lands (G173). A
 * command's receipt asked the whole cache again, and closing its form asked
 * the record page again on top: two composes and every read the page and the
 * shell had made, about 25 requests, before the page settled. The record a
 * command acts on re-reads once: its page (one compose, which answers its
 * sections), its root, and the questions its verbs ask. Anything more here is
 * a refresh asked twice, or a section asking beside the compose that answers it.
 */
type Fixture = TenantAssignmentFixture;
const recordName = (page: Page, label: string) => page.locator('#content').getByText(label, { exact: true }).filter({ visible: true });

/** Every API request from here on, by path, beside the tenant's lease control. */
function requests(page: Page) {
  const asked: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes('/api/') && !path.includes('/api/tenant/context/')) asked.push(path.replace(/^.*\/api\//, '/api/'));
  });
  return asked;
}

/** Until no request has gone out for a while: the page has settled. */
async function settled(page: Page, asked: string[]) {
  let seen = -1;
  await expect
    .poll(
      async () => {
        const now = asked.length;
        const still = now === seen;
        seen = now;
        return still;
      },
      { intervals: [750], timeout: 20_000 },
    )
    .toBe(true);
}

test.describe('one tenant command on a record page', () => {
  test.setTimeout(90_000);
  let app: Fixture;
  test.beforeEach(async () => {
    app = await startTenantAssignment();
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  test('re-reads the record it changed once: one compose, no sweep of the whole cache', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
    const account = app.accounts.manager;
    expect(
      (
        await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
          headers: { origin: app.origin },
          data: { email: account.email, password: account.password },
        })
      ).status(),
    ).toBe(200);
    await page.goto(`${app.origin}/${app.appId}/${app.model.work}?tenant=northstar`);
    await page.getByRole('list', { name: 'Available tenants' }).getByRole('button', { name: 'northstar', exact: true }).click();
    await expect(page.locator('.tenant-control-host')).toContainText('Tenant: northstar');
    await follow(page, `/${app.appId}/${app.model.work}?tenant=northstar`);
    await recordName(page, 'Northstar work').click();
    await expect(page.getByRole('heading', { name: 'Northstar work', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Applications', exact: true }).click();
    const applications = page.getByRole('tabpanel', { name: 'Applications', exact: true });
    await applications.getByText('Northstar application', { exact: true }).filter({ visible: true }).click();
    await expect(page.getByRole('heading', { name: 'Northstar application', exact: true })).toBeVisible();

    await page.getByRole('button', { name: app.assignment.action, exact: true }).click();
    const form = page.getByRole('dialog', { name: app.assignment.action, exact: true });
    await expect(form.getByRole('status')).toContainText('Ready to submit');
    await form.getByRole('combobox', { name: 'Reviewer (required)', exact: true }).fill('Northstar reviewer');
    await page.getByRole('option', { name: 'Northstar reviewer', exact: true }).click();
    await form.getByRole('textbox', { name: /^Assignment reason/ }).fill('Counted');
    await settled(page, requests(page));
    page.removeAllListeners('request');

    const asked = requests(page);
    await form.getByRole('button', { name: app.assignment.action, exact: true }).click();
    await expect(form.getByRole('status')).toHaveAttribute('data-phase', 'success');
    await form.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(form).toHaveCount(0);
    const history = page.locator('.page-section').filter({ has: page.getByRole('heading', { name: 'Assignments', exact: true }) });
    await expect(history.getByText('Reviewer assigned', { exact: true }).filter({ visible: true })).toHaveCount(1);
    await settled(page, asked);
    const count = (path: string) => asked.filter((asking) => asking === path).length;
    expect(count('/api/commands/execute')).toBe(1);
    expect(count('/api/pages/compose'), asked.join('\n')).toBe(1);
    // The command, the compose and at most one verb check: measured at 2 (6 before G173).
    expect(asked.length, asked.join('\n')).toBeLessThanOrEqual(3);
  });
});
