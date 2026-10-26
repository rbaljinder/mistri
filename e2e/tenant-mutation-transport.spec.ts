// test-package: shared — drives the database browser and an App to one behavior (scripts/test-owners.mjs).
// e2e-client: source — imports /core.js from the page
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from './support/harness.js';
import { startTenantApp, type TenantAppFixture } from './support/tenantServer.js';
import { TENANT_HTTP_HEADERS as names, type TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';

/* Undo is the database browser's, in the tablewalk package outside the kit's client root: Vite serves it by path. */
const UNDO = `/@fs${fileURLToPath(new URL('../packages/tablewalk/src/client/undo.js', import.meta.url))}`;

// Exercise the bundled client transport against genuine native-auth HTTP and
// SQLite. Writable fixtures now advertise shared CRUD controls, while tenant
// Undo remains withheld independently. No fake browser owner.
async function call(page: Page, path: string, body: Record<string, unknown>) {
  return page.evaluate(
    async (input) => {
      const modulePath = '/core.js';
      const { api } = await import(modulePath);
      try {
        return { ok: true, value: await api(input.path, input.body) };
      } catch (error) {
        const failure = error as { outcome?: string; status?: number; message?: string };
        return { ok: false, outcome: failure.outcome, status: failure.status, message: failure.message };
      }
    },
    { path, body },
  );
}

test.describe('private tenant bundled mutation transport', () => {
  test.setTimeout(60000);
  let app: TenantAppFixture, owner: TenantContextReply;
  test.beforeEach(async ({ page }) => {
    app = await startTenantApp({ writable: true });
    const account = app.accounts.alice;
    const login = await page.request.post(app.origin + '/api/auth/sign-in/email', {
      headers: { origin: app.origin },
      data: { email: account.email, password: account.password },
    });
    expect(login.status()).toBe(200);
    await page.goto(`${app.origin}/${app.appId}/item?tenant=north`);
    const opened = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/tenant/context/open');
    await page.getByRole('list', { name: 'Available tenants' }).getByRole('button', { name: 'north', exact: true }).click();
    owner = await (await opened).json();
    await expect(page.getByRole('button', { name: 'Tenant: north', exact: true })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'North item' })).toBeVisible();
  });
  test.afterEach(async ({ page }) => {
    try {
      await page.unrouteAll({ behavior: 'wait' });
    } finally {
      await app?.stop();
    }
  });
  const directRead = (page: Page) =>
    page.request.post(`${app.origin}/api/query?${new URLSearchParams({ app: app.appId, tenant: 'north' })}`, {
      headers: {
        origin: app.origin,
        [names.app]: owner.appId,
        [names.account]: owner.accountId,
        [names.tab]: owner.tabId,
        [names.context]: owner.context,
        [names.revision]: String(owner.revision),
      },
      data: { table: 'item' },
    });

  test('real update, creation, deletion and opaque Undo round-trip without exposing Undo UI', async ({ page }) => {
    const updated = await call(page, '/api/update', { table: 'item', key: { id: 'north-1' }, values: { name: 'North edited' } });
    expect(updated.ok).toBe(true);
    expect(updated.value.applied).toEqual({ name: 'North edited' });
    expect(typeof updated.value.undoId).toBe('string');
    const preview = await call(page, '/api/revert', {});
    expect(preview.value.next.id).toBe(updated.value.undoId);
    expect((await call(page, '/api/revert', { confirm: true, expectedId: updated.value.undoId })).value.reverted).toBe(true);
    const added = await call(page, '/api/insert', {
      table: 'item',
      values: { id: 'new-north', business_id: 'new-business', name: 'New north', status: 'open' },
    });
    expect(added.ok).toBe(true);
    expect(added.value.key).toEqual({ id: 'new-north' });
    const impact = await call(page, '/api/delete', { table: 'item', key: added.value.key });
    expect(impact.value.deleted).toBe(false);
    const removed = await call(page, '/api/delete', { table: 'item', key: added.value.key, confirm: true });
    expect(removed.value.deleted).toBe(true);
    expect(typeof removed.value.undoId).toBe('string');
    expect((await call(page, '/api/revert', { confirm: true, expectedId: removed.value.undoId })).value.reverted).toBe(true);
    expect((await call(page, '/api/revert', { confirm: true, expectedId: added.value.undoId })).value.reverted).toBe(true);
    expect((await (await directRead(page)).json()).rows.map((row: { name: string }) => row.name).sort()).toEqual([
      'North item',
      'North second item',
    ]);
    const other = await call(page, '/api/update', { table: 'item', key: { id: 'south-1' }, values: { name: 'Must not change' } });
    expect(other).toMatchObject({ ok: false, outcome: 'rejected' });
    const available = await page.evaluate(async (modulePath) => (await import(modulePath)).canUndo(), UNDO);
    expect(available).toBe(false);
    await expect(page.getByRole('button', { name: '+ New item', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  });

  test('lost acknowledgement after a real commit is unknown and never automatically retried', async ({ page }) => {
    let attempts = 0;
    await page.route('**/api/update?*', async (route) => {
      attempts++;
      const result = await route.fetch({ maxRetries: 0 });
      expect(result.status()).toBe(200);
      expect((await result.json()).affected).toBe(1);
      await route.abort('failed');
    });
    /* A request whose answer is lost makes the page verify its session, and a
       tenant's verification renews its lease: the lease this suite opened with
       is stale from then on (tenant_lease_stale), so the committed row is read
       under the renewed one. */
    const renewed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/tenant/context/renew' && response.ok());
    const result = await call(page, '/api/update', { table: 'item', key: { id: 'north-1' }, values: { name: 'Committed once' } });
    expect(result).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(attempts).toBe(1);
    owner = await (await renewed).json();
    expect((await (await directRead(page)).json()).rows.find((row: { id: string }) => row.id === 'north-1').name).toBe('Committed once');
    expect(attempts).toBe(1);
  });

  test('a contradictory owner on a real rejection is unknown, not permission to retry', async ({ page }) => {
    await page.route('**/api/update?*', async (route) => {
      const result = await route.fetch({ maxRetries: 0 });
      expect(result.status()).toBe(403);
      expect((await result.json()).outcome).toBe('rejected');
      await route.fulfill({ response: result, headers: { ...result.headers(), [names.tenant]: 'south' } });
    });
    const result = await call(page, '/api/update', { table: 'item', key: { id: 'south-1' }, values: { name: 'Must not change' } });
    expect(result).toMatchObject({ ok: false, outcome: 'unknown' });
    await expect(page.locator('#session-lock')).toBeVisible();
    expect((await directRead(page)).status()).toBe(200);
    await expect(page.locator('body')).not.toContainText('South item');
  });
});
