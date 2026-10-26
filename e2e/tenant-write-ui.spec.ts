import { test, expect, type Page } from './support/harness.js';
import { follow } from './support/app.js';
import { scalar } from './support/db.js';
import { startTenantApp, type TenantAppFixture } from './support/tenantServer.js';
import { TENANT_HTTP_HEADERS as headers, type TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';
import { COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournal.js';

// Every mutation below goes through shared UI and genuine native authentication.
// Response interception loses/holds actual committed replies, never invents
// successful writes, membership evidence or a client selection.
test.describe('private tenant membership-driven write UI', () => {
  test.setTimeout(60000);
  let app: TenantAppFixture;
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
  });
  test.afterEach(async ({ page }) => {
    try {
      await page.unrouteAll({ behavior: 'wait' });
    } finally {
      await app?.stop();
    }
  });

  const choose = async (page: Page, tenant: 'north' | 'south', switching = false) => {
    const path = `/api/tenant/context/${switching ? 'switch' : 'open'}`;
    const response = page.waitForResponse((reply) => new URL(reply.url()).pathname === path);
    await page.getByRole('list', { name: 'Available tenants' }).getByRole('button', { name: tenant, exact: true }).click();
    const reply = await response;
    expect(reply.status()).toBe(200);
    const owner = (await reply.json()) as TenantContextReply;
    await expect(page.getByRole('button', { name: `Tenant: ${tenant}`, exact: true })).toBeVisible();
    return owner;
  };
  const enter = async (page: Page) => {
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
    const owner = await choose(page, 'north');
    await expect(page.getByRole('row').filter({ hasText: 'North item' })).toBeVisible();
    return owner;
  };
  const openRecord = async (page: Page) => {
    await page.getByRole('row').filter({ hasText: 'North item' }).click();
    await expect(page.getByRole('heading', { name: 'North item', exact: true })).toBeVisible();
  };
  const editName = async (page: Page, name: string) => {
    await page.getByRole('button', { name: 'Edit Name', exact: true }).click();
    const field = page.getByRole('textbox', { name: 'Name', exact: true });
    await field.fill(name);
    await field.press('Tab');
  };
  const noUndo = async (page: Page) => {
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /^Account: / }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: /^Editing enabled/ })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: /^Undo/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
  };
  const switchTo = async (page: Page, tenant: 'north' | 'south') => {
    await page.getByRole('button', { name: `Tenant: ${tenant === 'north' ? 'south' : 'north'}`, exact: true }).click();
    const owner = await choose(page, tenant, true);
    await follow(page, `/${app.appId}/item?tenant=${tenant}`);
    await expect(page.getByRole('row').filter({ hasText: tenant === 'north' ? 'North item' : 'South item' })).toBeVisible();
    return owner;
  };
  const call = (page: Page, owner: TenantContextReply, path: string, data: Record<string, unknown>) =>
    page.request.post(`${app.origin}${path}?${new URLSearchParams({ app: app.appId, tenant: owner.tenantId })}`, {
      headers: {
        origin: app.origin,
        [headers.app]: owner.appId,
        [headers.account]: owner.accountId,
        [headers.tab]: owner.tabId,
        [headers.context]: owner.context,
        [headers.revision]: String(owner.revision),
      },
      data,
    });
  const commandForm = async (page: Page) => {
    await page.getByRole('button', { name: 'Advance item', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'Advance item', exact: true });
    await expect(form.getByRole('status')).toContainText('Ready to submit');
    await form.getByLabel('Reason', { exact: false }).fill('North desk review');
    return form;
  };

  test('shared Save, generated/defaulted creation and preview-confirm Delete work while Undo stays absent', async ({ page }) => {
    app = await startTenantApp({ writable: true });
    await enter(page);
    await openRecord(page);
    await expect(page.getByRole('button', { name: 'Edit Tenant ID', exact: true })).toHaveCount(0);
    await editName(page, 'North saved');
    const update = page.waitForResponse((reply) => new URL(reply.url()).pathname === '/api/update');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    const saved = await (await update).json();
    expect(saved).toMatchObject({ affected: 1, applied: { name: 'North saved' }, undoId: expect.any(String) });
    await expect(page.getByRole('region', { name: 'Saved changes' })).toContainText('Changes saved');
    expect(scalar(app.database, "SELECT name FROM physical_item WHERE id='north-1'")).toBe('North saved');
    await noUndo(page);
    await follow(page, `/${app.appId}/item?tenant=north`);
    await page.getByRole('button', { name: '+ New item', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New item', exact: true });
    await expect(form.getByRole('textbox', { name: 'ID', exact: true })).toHaveCount(0);
    await expect(form.getByRole('textbox', { name: /Tenant/i })).toHaveCount(0);
    await form.getByRole('textbox', { name: 'Business ID', exact: true }).fill('new-business');
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill('New north item');
    // Leave Status blank: public hasDefault, not SQL default text, tells the
    // shared form to omit it and lets SQLite produce the actual stored value.
    await expect(form.getByRole('textbox', { name: 'Status', exact: true })).toHaveValue('');
    const insertion = page.waitForResponse((reply) => new URL(reply.url()).pathname === '/api/insert');
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    const insertedResponse = await insertion,
      inserted = await insertedResponse.json();
    expect(insertedResponse.request().postDataJSON().values).toEqual({ business_id: 'new-business', name: 'New north item' });
    expect(inserted.key.id).toMatch(/^[a-f0-9]{32}$/);
    expect(scalar(app.database, 'SELECT tenant_id FROM physical_item WHERE id=?', inserted.key.id)).toBe('north');
    expect(scalar(app.database, 'SELECT status FROM physical_item WHERE id=?', inserted.key.id)).toBe('open');
    await expect(page.getByRole('heading', { name: 'New north item', exact: true })).toBeVisible();
    const preview = page.waitForResponse(
      (reply) => new URL(reply.url()).pathname === '/api/delete' && reply.request().postDataJSON()?.confirm !== true,
    );
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
    expect(await (await preview).json()).toMatchObject({ deleted: false, impact: [] });
    expect(scalar(app.database, 'SELECT count(*) FROM physical_item WHERE id=?', inserted.key.id)).toBe(1);
    const deletion = page.waitForResponse(
      (reply) => new URL(reply.url()).pathname === '/api/delete' && reply.request().postDataJSON()?.confirm === true,
    );
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    expect(await (await deletion).json()).toMatchObject({ deleted: true, affected: 1, undoId: expect.any(String) });
    await expect(page.getByRole('row').filter({ hasText: 'North saved' })).toBeVisible();
    expect(scalar(app.database, 'SELECT count(*) FROM physical_item WHERE id=?', inserted.key.id)).toBe(0);
    expect(scalar(app.database, "SELECT name FROM physical_item WHERE id='south-1'")).toBe('South item');
    await noUndo(page);
  });

  test('a held then lost committed Save cannot navigate, switch tenants or retry', async ({ page }) => {
    app = await startTenantApp({ writable: true });
    await enter(page);
    await openRecord(page);
    const recordUrl = page.url();
    let writes = 0,
      switches = 0,
      committed = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/tenant/context/switch') switches++;
    });
    await page.route('**/api/update?*', async (route) => {
      writes++;
      const response = await route.fetch({ maxRetries: 0 });
      expect((await response.json()).affected).toBe(1);
      committed = true;
      await gate;
      await route.abort('failed');
    });
    try {
      await editName(page, 'Committed once');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect.poll(() => committed).toBe(true);
      await page.goBack();
      await expect(page).toHaveURL(recordUrl);
      await expect(page.getByRole('button', { name: 'Saving...', exact: true })).toBeDisabled();
      release();
      await expect(page.locator('.pending-uncertain')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Tenant: north', exact: true }).click();
      const chooser = page.getByRole('dialog', { name: 'Choose a tenant', exact: true });
      await chooser.getByRole('button', { name: 'south', exact: true }).click();
      await expect(page.locator('#toast')).toContainText('pending or unconfirmed');
      await chooser.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page).toHaveURL(recordUrl);
      expect(writes).toBe(1);
      expect(switches).toBe(0);
      expect(scalar(app.database, "SELECT name FROM physical_item WHERE id='north-1'")).toBe('Committed once');
      await expect(page.getByRole('button', { name: 'Tenant: north', exact: true })).toBeVisible();
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });

  test('authorized parent picker and parent-page related creation cannot bind a south parent', async ({ page }) => {
    app = await startTenantApp({ writable: true, parents: true });
    const owner = await enter(page);
    await page.getByRole('button', { name: '+ New item', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New item', exact: true });
    await form.getByRole('textbox', { name: 'Business ID', exact: true }).fill('picked-parent');
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Item with selected parent');
    const picker = form.getByRole('combobox', { name: /Parent/ });
    await picker.fill('parent');
    await expect(page.getByRole('option', { name: /North parent/ })).toBeVisible();
    await expect(page.getByRole('option')).toHaveCount(1);
    await expect(page.getByRole('option', { name: /South parent/ })).toHaveCount(0);
    await picker.fill('South');
    await expect(page.locator('.picker-empty')).toContainText('Nothing matches');
    await expect(page.getByRole('option')).toHaveCount(0);
    await picker.fill('North');
    await page.getByRole('option', { name: /North parent/ }).click();
    const insertion = page.waitForResponse((reply) => new URL(reply.url()).pathname === '/api/insert');
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    const reply = await insertion,
      inserted = await reply.json();
    expect(reply.status()).toBe(200);
    expect(reply.request().postDataJSON().values.parent_id).toBe('north-parent');
    expect(inserted.key.id).toMatch(/^[a-f0-9]{32}$/);
    await expect(page.getByRole('heading', { name: 'Item with selected parent', exact: true })).toBeVisible();
    expect(scalar(app.database, 'SELECT parent_id FROM physical_item WHERE id=?', inserted.key.id)).toBe('north-parent');
    expect(scalar(app.database, 'SELECT tenant_id FROM physical_item WHERE id=?', inserted.key.id)).toBe('north');
    const forged = await call(page, owner, '/api/insert', {
      table: 'item',
      values: {
        business_id: 'forged-parent',
        name: 'Must not bind south',
        parent_id: 'south-parent',
      },
    });
    expect(forged.status()).toBe(403);
    expect(await forged.json()).toMatchObject({ outcome: 'rejected' });
    expect(scalar(app.database, "SELECT count(*) FROM physical_item WHERE business_id='forged-parent'")).toBe(0);

    // The metadata-retained create declaration must remain usable on a real
    // parent page, with a server-planned FK binding and no hidden owner input.
    await follow(page, `/${app.appId}/@parent-detail~north-parent?tenant=north`);
    await expect(page.getByRole('heading', { name: 'North parent', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '+ Add related item', exact: true }).click();
    const related = page.getByRole('dialog', { name: 'New item', exact: true });
    await expect(related.getByRole('combobox', { name: /Parent/ })).toHaveCount(0);
    await expect(related.getByRole('textbox', { name: /Tenant/ })).toHaveCount(0);
    await related.getByRole('textbox', { name: 'Business ID', exact: true }).fill('related-parent');
    await related.getByRole('textbox', { name: 'Name', exact: true }).fill('Related north item');
    const created = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/insert');
    await related.getByRole('button', { name: 'Add', exact: true }).click();
    const relatedResponse = await created,
      added = await relatedResponse.json();
    expect(relatedResponse.request().postDataJSON().values).toEqual({
      parent_id: 'north-parent',
      business_id: 'related-parent',
      name: 'Related north item',
    });
    expect(added.key.id).toMatch(/^[a-f0-9]{32}$/);
    await expect(related).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: 'Related north item' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/@parent-detail~north-parent\\?tenant=north$`));
    expect(scalar(app.database, 'SELECT parent_id FROM physical_item WHERE id=?', added.key.id)).toBe('north-parent');
    expect(scalar(app.database, 'SELECT tenant_id FROM physical_item WHERE id=?', added.key.id)).toBe('north');
    await expect(page.locator('#content')).not.toContainText('South parent');
    await noUndo(page);
  });

  test('lost creation acknowledgement keeps Add locked and blocks a cross-tenant exit', async ({ page }) => {
    app = await startTenantApp({ writable: true });
    await enter(page);
    let writes = 0,
      switches = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/tenant/context/switch') switches++;
    });
    await page.route('**/api/insert?*', async (route) => {
      writes++;
      const response = await route.fetch({ maxRetries: 0 });
      expect((await response.json()).key.id).toMatch(/^[a-f0-9]{32}$/);
      await route.abort('failed');
    });
    await page.getByRole('button', { name: '+ New item', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New item', exact: true }),
      current = page.url();
    await form.getByRole('textbox', { name: 'Business ID', exact: true }).fill('lost-create');
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Created once');
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(form).toContainText('Creation was not confirmed');
    await expect(form.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
    await follow(page, `/${app.appId}/item?tenant=south`);
    await expect(page).toHaveURL(current);
    await expect(form).toBeVisible();
    expect(writes).toBe(1);
    expect(switches).toBe(0);
    expect(scalar(app.database, "SELECT count(*) FROM physical_item WHERE business_id='lost-create' AND tenant_id='north'")).toBe(1);
    expect(scalar(app.database, "SELECT count(*) FROM physical_item WHERE business_id='lost-create' AND tenant_id='south'")).toBe(0);
  });

  test('lost Delete acknowledgement blocks another deletion and navigation without pretending rollback', async ({ page }) => {
    app = await startTenantApp({ writable: true });
    await enter(page);
    await openRecord(page);
    const current = page.url();
    let deletes = 0,
      switches = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/tenant/context/switch') switches++;
    });
    await page.route('**/api/delete?*', async (route) => {
      if (route.request().postDataJSON()?.confirm !== true) {
        await route.continue();
        return;
      }
      deletes++;
      const response = await route.fetch({ maxRetries: 0 });
      expect((await response.json()).deleted).toBe(true);
      await route.abort('failed');
    });
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('#toast')).toContainText('Deletion was not confirmed');
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Delete…', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.goBack();
    await expect(page).toHaveURL(current);
    await page.getByRole('button', { name: 'Tenant: north', exact: true }).click();
    const chooser = page.getByRole('dialog', { name: 'Choose a tenant', exact: true });
    await chooser.getByRole('button', { name: 'south', exact: true }).click();
    await expect(page.locator('#toast')).toContainText('pending or unconfirmed');
    await chooser.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page).toHaveURL(current);
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Delete…', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    expect(deletes).toBe(1);
    expect(switches).toBe(0);
    expect(scalar(app.database, "SELECT count(*) FROM physical_item WHERE id='north-1'")).toBe(0);
    expect(scalar(app.database, "SELECT name FROM physical_item WHERE id='south-1'")).toBe('South item');
  });

  test('revocation while a committed Save reply is held forces lock and its stale success cannot repaint', async ({ page }) => {
    app = await startTenantApp({ writable: true });
    await enter(page);
    await openRecord(page);
    let committed = false,
      delivered = false,
      writes = 0,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/update?*', async (route) => {
      writes++;
      const response = await route.fetch({ maxRetries: 0 });
      expect((await response.json()).affected).toBe(1);
      committed = true;
      await gate;
      try {
        await route.fulfill({ response });
      } catch (error) {
        // Owner retirement may cancel the old fetch; either cancellation or
        // stale owned-success delivery must leave the locked surface intact.
        if (!/closed|cancel|disposed|Invalid InterceptionId/i.test(String(error))) throw error;
      } finally {
        delivered = true;
      }
    });
    try {
      await editName(page, 'Held private update');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect.poll(() => committed).toBe(true);
      expect(scalar(app.database, "SELECT name FROM physical_item WHERE id='north-1'")).toBe('Held private update');
      await app.revoke(app.accounts.alice.id, 'north');
      // Native focus monitoring uses the real context-owned runtime check.
      // A pending mutation must not veto revocation/security retirement.
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.locator('#session-lock')).toBeVisible();
      await expect(page.locator('body')).toHaveClass(/session-locked/);
      release();
      await expect.poll(() => delivered).toBe(true);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.locator('#session-lock')).toBeVisible();
      await expect(page.locator('body')).not.toContainText('Held private update');
      await expect(page.locator('body')).not.toContainText('North item');
      await expect(page.getByRole('region', { name: 'Saved changes' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Tenant: north', exact: true })).toHaveCount(0);
      expect(writes).toBe(1);
      expect(scalar(app.database, "SELECT name FROM physical_item WHERE id='north-1'")).toBe('Held private update');
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });

  test('same native account gets editable north and read-only south from membership, not login role', async ({ page }) => {
    app = await startTenantApp({ writable: true, southReadOnly: true });
    const north = await enter(page);
    await expect(page.getByRole('button', { name: '+ New item', exact: true })).toBeVisible();
    await openRecord(page);
    await expect(page.getByRole('button', { name: 'Edit Name', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Delete…', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    const south = await switchTo(page, 'south');
    expect(south.accountId).toBe(north.accountId);
    expect(south.tabId).toBe(north.tabId);
    await expect(page.getByRole('button', { name: '+ New item', exact: true })).toHaveCount(0);
    await page.getByRole('row').filter({ hasText: 'South item' }).click();
    await expect(page.getByRole('heading', { name: 'South item', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete…', exact: true })).toHaveCount(0);
    const refusal = await call(page, south, '/api/update', { table: 'item', key: { id: 'south-1' }, values: { name: 'Not granted' } });
    expect(refusal.status()).toBe(403);
    expect(await refusal.json()).toMatchObject({ outcome: 'rejected' });
    expect(scalar(app.database, "SELECT name FROM physical_item WHERE id='south-1'")).toBe('South item');
    await switchTo(page, 'north');
    await expect(page.getByRole('button', { name: '+ New item', exact: true })).toBeVisible();
    await noUndo(page);
  });

  test('command-only membership exposes prepare/execute but no CRUD and no command for viewer south', async ({ page }) => {
    app = await startTenantApp({ commandOnly: true, southReadOnly: true });
    const north = await enter(page);
    await expect(page.getByRole('button', { name: '+ New item', exact: true })).toHaveCount(0);
    await openRecord(page);
    await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete…', exact: true })).toHaveCount(0);
    const form = await commandForm(page);
    await form.getByRole('button', { name: 'Advance item', exact: true }).click();
    await expect(form.getByRole('status')).toHaveAttribute('data-phase', 'success');
    expect(scalar(app.database, "SELECT version FROM physical_item WHERE id='north-1'")).toBe(1);
    expect(scalar(app.database, "SELECT version FROM physical_item WHERE id='south-1'")).toBe(0);
    expect((await call(page, north, '/api/update', { table: 'item', key: { id: 'north-1' }, values: { version: 2 } })).status()).toBe(403);
    await form.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Advance item', exact: true })).toHaveCount(0);
    const south = await switchTo(page, 'south');
    await page.getByRole('row').filter({ hasText: 'South item' }).click();
    await expect(page.getByRole('heading', { name: 'South item', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Advance item', exact: true })).toHaveCount(0);
    expect(
      (await call(page, south, '/api/commands/prepare', { command: 'advance', commandVersion: 1, key: { id: 'south-1' } })).status(),
    ).toBe(403);
    await noUndo(page);
  });

  test('lost command replies keep one envelope and receipt until an owned status confirms the commit', async ({ page }) => {
    app = await startTenantApp({ commandOnly: true });
    await enter(page);
    await openRecord(page);
    const current = page.url(),
      executions: unknown[] = [],
      statuses: unknown[] = [];
    await page.route('**/api/commands/execute?*', async (route) => {
      executions.push(route.request().postDataJSON());
      const committed = await route.fetch({ maxRetries: 0 });
      expect((await committed.json()).status).toBe('applied');
      await route.abort('failed');
    });
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/commands/status') statuses.push(request.postDataJSON());
    });
    const form = await commandForm(page);
    await form.getByRole('button', { name: 'Advance item', exact: true }).click();
    await expect(form.getByRole('button', { name: 'Retry same submission', exact: true })).toBeVisible();
    await expect(form.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await expect(form.getByLabel('Reason', { exact: false })).toBeDisabled();
    await page.goBack();
    await expect(page).toHaveURL(current);
    await expect(form).toBeVisible();
    await form.getByRole('button', { name: 'Retry same submission', exact: true }).click();
    await expect.poll(() => executions.length).toBe(2);
    await expect(form.getByRole('button', { name: 'Check result', exact: true })).toBeVisible();
    expect(executions[1]).toEqual(executions[0]);
    await form.getByRole('button', { name: 'Check result', exact: true }).click();
    await expect(form.getByRole('status')).toHaveAttribute('data-phase', 'success');
    expect(statuses).toEqual([executions[0]]);
    expect(scalar(app.database, "SELECT version FROM physical_item WHERE id='north-1'")).toBe(1);
    expect(scalar(app.database, `SELECT count(*) FROM ${COMMAND_JOURNAL_TABLES.receipt}`)).toBe(1);
    await form.getByRole('button', { name: 'Done', exact: true }).click();
    await switchTo(page, 'south');
    expect(executions).toHaveLength(2);
  });
});
