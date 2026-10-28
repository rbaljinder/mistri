// e2e-client: source — imports /sessionIdentity.ts from the page
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from './support/harness.js';
import { scalar } from './support/db.js';
import { startTenantApp, type TenantAppFixture } from './support/tenantServer.js';

/* The App framework's tenant client lives in the mistri package, outside the kit's client root: Vite serves it by path. */
const TENANT_BROWSER = `/@fs${fileURLToPath(new URL('../packages/mistri/src/client/tenantBrowser.ts', import.meta.url))}`;

// Controls reach the real authenticated host; interception only loses a real
// acknowledgement. No fabricated membership, successful write or client owner.
test.describe('tenant renewal preserves mounted work', () => {
  test.setTimeout(60000);
  let app: TenantAppFixture;
  test.afterEach(async ({ page }) => {
    try {
      await page.unrouteAll({ behavior: 'wait' });
    } finally {
      await app?.stop();
    }
  });
  async function enter(page: Page, commandOnly = false) {
    app = await startTenantApp(commandOnly ? { commandOnly: true } : { writable: true });
    const account = app.accounts.alice;
    expect(
      (
        await page.request.post(app.origin + '/api/auth/sign-in/email', {
          headers: { origin: app.origin },
          data: { email: account.email, password: account.password },
        })
      ).status(),
    ).toBe(200);
    await page.goto(`${app.origin}/${app.appId}/item?tenant=north`);
    await page.getByRole('list', { name: 'Available tenants' }).getByRole('button', { name: 'north', exact: true }).click();
    await expect(page.locator('#content')).toContainText('North item');
  }
  async function remember(page: Page) {
    await page.evaluate(async () => {
      const path = '/sessionIdentity.ts';
      const identity = await import(path);
      Object.assign(window, {
        renewalIdentity: identity.captureSessionIdentity(),
        renewalLease: identity.captureTenantLease(),
        renewalField: document.activeElement,
      });
    });
  }
  async function renew(page: Page) {
    return page.evaluate(async (path) => {
      try {
        await (await import(path)).checkBrowserTenant();
        return true;
      } catch {
        return false;
      }
    }, TENANT_BROWSER);
  }
  async function preserved(page: Page, focused = true) {
    const proof = await page.evaluate(async () => {
      const path = '/sessionIdentity.ts';
      const identity = await import(path),
        before = Reflect.get(window, 'renewalLease'),
        after = identity.captureTenantLease();
      return {
        same: identity.captureSessionIdentity() === Reflect.get(window, 'renewalIdentity'),
        context: after?.context === before.context,
        revision: after?.revision > before.revision,
        mounted: Reflect.get(window, 'renewalField').isConnected,
        focused: document.activeElement === Reflect.get(window, 'renewalField'),
      };
    });
    expect(proof).toMatchObject({ same: true, context: true, revision: true, mounted: true, ...(focused ? { focused: true } : {}) });
  }
  async function record(page: Page) {
    await page
      .getByRole('gridcell', { name: 'North item', exact: true })
      .or(page.getByRole('button', { name: 'North item', exact: true }))
      .click();
    await page.getByRole('button', { name: 'Edit Name', exact: true }).click();
    const field = page.getByRole('textbox', { name: 'Name', exact: true });
    await field.fill('Draft kept through renewal');
    return field;
  }

  async function modalPresentation(page: Page) {
    /* The App's payload as the shell takes it: its own reply, or the answer the page's boot carries for it
       (mistri shared/tenantBoot.ts). */
    const present = (payload: { app: { views: Record<string, unknown> } }) => {
      // Presentation override only: genuine auth, catalog, grants, context and
      // all writes still come from the disposable native tenant host.
      const item = Object.values(payload.app.views).find((view) => (view as { table?: string }).table === 'item') as
        | { open?: string }
        | undefined;
      expect(item).toBeTruthy();
      item!.open = 'modal';
    };
    await page.route(
      (url) => url.pathname === '/api/app' || url.pathname === '/api/boot',
      async (route) => {
        const response = await route.fetch();
        const json = await response.json();
        if (new URL(route.request().url()).pathname === '/api/app') present(json);
        else
          for (const [key, read] of Object.entries(json.reads as Record<string, { body: { app: { views: Record<string, unknown> } } }>))
            if (key.startsWith('GET /api/app?')) present(read.body);
        await route.fulfill({ response, json });
      },
    );
  }

  for (const width of [1440, 390])
    test(`editable modal at ${width}px survives native tenant renewal and offline suspension`, async ({ page, context }) => {
      await page.setViewportSize({ width, height: 900 });
      await modalPresentation(page);
      await enter(page);
      const url = page.url();
      const field = await record(page);
      const modal = page.locator('.record-modal');
      await expect(modal).toBeVisible();
      await remember(page);
      expect(await renew(page)).toBe(true);
      await preserved(page);
      await expect(field).toHaveValue('Draft kept through renewal');
      await remember(page);
      await context.setOffline(true);
      await expect(page.getByRole('dialog', { name: 'Tenant access paused' })).toBeVisible();
      await expect(modal).toBeHidden();
      expect(await modal.evaluate((node) => node.isConnected)).toBe(true);
      await context.setOffline(false);
      await expect(page.getByRole('dialog', { name: 'Tenant access paused' })).toHaveCount(0);
      await expect(modal).toBeVisible();
      await preserved(page);
      await expect(field).toHaveValue('Draft kept through renewal');
      expect(scalar(app.database, "SELECT name FROM physical_item WHERE id='north-1'")).toBe('North item');
      await modal.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect.poll(() => scalar(app.database, "SELECT name FROM physical_item WHERE id='north-1'")).toBe('Draft kept through renewal');
      await expect(modal).toBeVisible();
      await expect(page).toHaveURL(url);
    });

  test('editable modal hosts a genuine native business command without navigating away from its collection', async ({ page }) => {
    await modalPresentation(page);
    await enter(page, true);
    const url = page.url();
    await page.getByRole('row').filter({ hasText: 'North item' }).click();
    const modal = page.locator('.record-modal');
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Advance item', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'Advance item', exact: true });
    await expect(form.getByRole('status')).toContainText('Ready to submit');
    await form.getByLabel('Reason', { exact: false }).fill('Native modal command');
    await form.getByRole('button', { name: 'Advance item', exact: true }).click();
    await expect(form.getByRole('status')).toHaveAttribute('data-phase', 'success');
    expect(scalar(app.database, "SELECT version FROM physical_item WHERE id='north-1'")).toBe(1);
    await form.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(modal).toBeVisible();
    await expect(page).toHaveURL(url);
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(page).toHaveURL(url);
  });

  test('lost renewal acknowledgement recovers the exact receipt without replacing a dirty record', async ({ page }) => {
    await enter(page);
    const field = await record(page);
    await remember(page);
    let committed: unknown,
      expected: unknown,
      requests = 0;
    await page.route('**/api/tenant/context/renew?*', async (route) => {
      requests++;
      const response = await route.fetch({ maxRetries: 0 });
      expect(response.status()).toBe(200);
      if (requests === 1) {
        expected = route.request().postDataJSON();
        committed = await response.json();
        await route.abort('failed');
      } else {
        expect(route.request().postDataJSON()).toEqual(expected);
        expect(await response.json()).toEqual(committed);
        await route.fulfill({ response });
      }
    });
    expect(await renew(page)).toBe(false);
    /* The reply was lost, which says nothing about the context (G172): the lease still runs, so the page stays open and
       the same exact attempt is asked again. */
    await expect(page.getByRole('dialog', { name: 'Tenant access paused' })).toHaveCount(0);
    await expect(page.locator('body > .layout')).not.toHaveAttribute('inert', '');
    expect(await renew(page)).toBe(true);
    await expect(page.getByRole('dialog', { name: 'Tenant access paused' })).toHaveCount(0);
    await expect(field).toHaveValue('Draft kept through renewal');
    await preserved(page);
    expect(requests).toBe(2);
    expect(scalar(app.database, "SELECT name FROM physical_item WHERE id='north-1'")).toBe('North item');
  });

  for (const width of [1440, 390])
    test(`offline suspension at ${width}px covers an open New dialog and restores its input and focus`, async ({ page, context }) => {
      await page.setViewportSize({ width, height: 900 });
      await enter(page);
      await page.getByRole('button', { name: '+ New item', exact: true }).click();
      const form = page.getByRole('dialog', { name: 'New item', exact: true });
      const name = form.getByRole('textbox', { name: 'Name', exact: true });
      await name.fill('Offline draft');
      await remember(page);
      await context.setOffline(true);
      await expect(page.getByRole('dialog', { name: 'Tenant access paused' })).toBeVisible();
      await expect(page.locator('body')).toHaveClass(/tenant-suspended/);
      // Descendants with an explicit visible style must not escape the private
      // root's inherited visibility, including a portal mounted during suspension.
      await page.evaluate(() => {
        const portal = document.createElement('section');
        portal.id = 'late-private-portal';
        const child = document.createElement('span');
        child.style.visibility = 'visible';
        child.textContent = 'Private portal';
        portal.append(child);
        document.body.append(portal);
      });
      await expect(page.locator('#late-private-portal')).toHaveAttribute('inert', '');
      expect(await page.locator('#late-private-portal span').evaluate((node) => getComputedStyle(node).visibility)).toBe('hidden');
      await page.screenshot({ path: `/tmp/tablewalk-tenant-renewal-cover-${width}.png` });
      await page.locator('#late-private-portal').evaluate((node) => node.remove());
      await context.setOffline(false);
      await expect(page.getByRole('dialog', { name: 'Tenant access paused' })).toHaveCount(0);
      await expect(name).toHaveValue('Offline draft');
      await preserved(page);
      expect(scalar(app.database, 'SELECT count(*) FROM physical_item')).toBe(4);
    });

  test('command input and target version survive renewal before explicit submission', async ({ page }) => {
    await enter(page, true);
    await page.getByRole('row').filter({ hasText: 'North item' }).click();
    await page.getByRole('button', { name: 'Advance item', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'Advance item', exact: true });
    await expect(form.getByRole('status')).toContainText('Ready to submit');
    const reason = form.getByLabel('Reason', { exact: false });
    await reason.fill('Preserved review reason');
    await remember(page);
    expect(await renew(page)).toBe(true);
    await expect(reason).toHaveValue('Preserved review reason');
    await preserved(page);
    expect(scalar(app.database, "SELECT version FROM physical_item WHERE id='north-1'")).toBe(0);
  });

  test('renewal does not settle or replay an unconfirmed committed Save', async ({ page }) => {
    await enter(page);
    const field = await record(page);
    await field.press('Tab');
    let writes = 0;
    await page.route('**/api/update?*', async (route) => {
      writes++;
      const response = await route.fetch({ maxRetries: 0 });
      expect((await response.json()).affected).toBe(1);
      await route.abort('failed');
    });
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('.pending-uncertain')).toBeVisible();
    await remember(page);
    expect(await renew(page)).toBe(true);
    await preserved(page, false);
    await expect(page.locator('.pending-uncertain')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
    expect(writes).toBe(1);
    expect(scalar(app.database, "SELECT name FROM physical_item WHERE id='north-1'")).toBe('Draft kept through renewal');
  });
});
