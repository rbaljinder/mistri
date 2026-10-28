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
function requests(page: Page, reads?: string[], bodies?: string[]) {
  const asked: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.includes('/api/') || path.includes('/api/tenant/context/')) return;
    const at = path.replace(/^.*\/api\//, '/api/');
    asked.push(at);
    /* Reads asked in one moment travel as one request (tenantTransport.ts `batched`): each is still a read asked. */
    const batch = at === '/api/boot' ? (request.postDataJSON() as { reads?: Array<{ path: string }> } | null)?.reads : undefined;
    reads?.push(...(batch ? batch.map((read) => read.path.split('?')[0]) : [at]));
    /* Each read by what it asks: its path and its body, a batch's each on its own. */
    if (at !== '/api/commands/availability' && !at.startsWith('/api/commands/'))
      bodies?.push(
        ...(batch
          ? (batch as Array<{ path: string; body?: unknown }>).map((read) => `${read.path} ${JSON.stringify(read.body ?? null)}`)
          : [`${at} ${request.postData() ?? ''}`]),
      );
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

  /** Sign in, open the application record, optionally reload it so the page boots there, and run the command. */
  async function command(page: Page, booted: boolean) {
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
    if (booted) {
      /* The record page as a first visit draws it: its reads carried in its boot (shared/tenantBoot.ts). */
      await page.reload();
      /* A fresh visit by a person in two tenants chooses one: the boot rides the lease that choice opens. */
      await page.getByRole('list', { name: 'Available tenants' }).getByRole('button', { name: 'northstar', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Northstar application', exact: true })).toBeVisible();
    }

    await page.getByRole('button', { name: app.assignment.action, exact: true }).click();
    const form = page.getByRole('dialog', { name: app.assignment.action, exact: true });
    await expect(form.getByRole('status')).toContainText('Ready to submit');
    await form.getByRole('combobox', { name: 'Reviewer (required)', exact: true }).fill('Northstar reviewer');
    await page.getByRole('option', { name: 'Northstar reviewer', exact: true }).click();
    await form.getByRole('textbox', { name: /^Assignment reason/ }).fill('Counted');
    await settled(page, requests(page));
    page.removeAllListeners('request');

    const reads: string[] = [];
    const bodies: string[] = [];
    const asked = requests(page, reads, bodies);
    await form.getByRole('button', { name: app.assignment.action, exact: true }).click();
    await expect(form.getByRole('status')).toHaveAttribute('data-phase', 'success');
    await form.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(form).toHaveCount(0);
    const history = page.locator('.page-section').filter({ has: page.getByRole('heading', { name: 'Assignments', exact: true }) });
    await expect(history.getByText('Reviewer assigned', { exact: true }).filter({ visible: true })).toHaveCount(1);
    await settled(page, asked);
    const count = (path: string) => reads.filter((asking) => asking === path).length;
    expect(count('/api/commands/execute')).toBe(1);
    expect(count('/api/pages/compose'), reads.join('\n')).toBe(1);
    // The command, the compose and at most one verb check: measured at 2 (6 before G173).
    expect(asked.length, asked.join('\n')).toBeLessThanOrEqual(3);
    /* No read asked twice, whatever carried it: two observers of one record under two keys each asked it. */
    expect(
      bodies.filter((each, index) => bodies.indexOf(each) !== index),
      bodies.join('\n'),
    ).toEqual([]);
  }

  test('re-reads the record it changed once: one compose, no sweep of the whole cache', async ({ page }) => {
    await command(page, false);
  });

  /* A field report: on a record page its boot had drawn, a save set off 15 requests at once, the compose twice among
     them, where one opened by navigation asked 6. */
  test('a record page drawn by its boot re-reads it once too, no read asked twice', async ({ page }) => {
    await command(page, true);
  });
});
