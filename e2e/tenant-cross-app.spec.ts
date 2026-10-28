// e2e-client: source — imports /sessionIdentity.ts from the page
import { fileURLToPath } from 'node:url';
import type { APIResponse, Response } from '@playwright/test';
import { test, expect, type Page } from './support/harness.js';
import { follow } from './support/app.js';
import { count, rows, scalar } from './support/db.js';
import { startTenantProof, type TenantProofFixture } from './support/tenantProofServer.js';
import { TENANT_HTTP_HEADERS as headers, type TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';
import { isSelection, leaseOfSelection } from './support/tenantSelection.js';

/* The App framework's tenant client lives in the mistri package, outside the kit's client root: Vite serves it by path. */
const TENANT_BROWSER = `/@fs${fileURLToPath(new URL('../packages/mistri/src/client/tenantBrowser.ts', import.meta.url))}`;

type Fixture = TenantProofFixture;
type Tenant = 'northstar' | 'riverview';
type Row = Record<string, unknown>;

// Responsive lists mount both presentations; only one is visible at a time.
const recordName = (page: Page, label: string) => page.locator('#content').getByText(label, { exact: true }).filter({ visible: true });

// Use the shared authenticated host and its public logical resources. Every
// intercepted success comes from real HTTP execution before its reply is lost.
const assertion = (app: Fixture, owner: TenantContextReply) => ({
  origin: app.origin,
  [headers.app]: owner.appId,
  [headers.account]: owner.accountId,
  [headers.tab]: owner.tabId,
  [headers.context]: owner.context,
  [headers.revision]: String(owner.revision),
});
const call = (page: Page, app: Fixture, owner: TenantContextReply, path: string, data: Row) =>
  page.request.post(`${app.origin}${path}?${new URLSearchParams({ app: app.appId, tenant: owner.tenantId })}`, {
    headers: assertion(app, owner),
    data,
  });

async function query(page: Page, app: Fixture, owner: TenantContextReply, table: string): Promise<Row[]> {
  // Recovery may renew access without replacing the selected authority. Reads
  // use its current lease; deliberate stale requests below still call directly.
  const selected = await page.evaluate(async () => {
    const path = '/sessionIdentity.ts',
      identity = await import(path);
    return {
      same: identity.captureSessionIdentity() === Reflect.get(window, 'crossAppSelectedIdentity'),
      lease: identity.captureTenantLease() as TenantContextReply | undefined,
    };
  });
  expect(selected.same).toBe(true);
  expect(selected.lease).toMatchObject({
    appId: owner.appId,
    accountId: owner.accountId,
    tenantId: owner.tenantId,
    tabId: owner.tabId,
    context: owner.context,
  });
  const current = selected.lease!;
  expect(current.revision).toBeGreaterThanOrEqual(owner.revision);
  const response = await call(page, app, current, '/api/query', { table });
  expect(response.status()).toBe(200);
  for (const [name, value] of Object.entries(assertion(app, current))) {
    if (name !== 'origin') expect(response.headers()[name], name).toBe(value);
  }
  expect(response.headers()[headers.tenant]).toBe(owner.tenantId);
  const result = await response.json();
  expect(JSON.stringify(result)).not.toContain('tenant_id');
  return result.rows;
}

async function denied(response: APIResponse) {
  expect([400, 401, 403, 404, 409]).toContain(response.status());
  expect(await response.text()).not.toMatch(/Northstar (?:hidden )?(?:work|target)|Riverview (?:work|target)|Seed update/);
}

/** `entered`: a sole membership's selection, made as the page loaded, in place of a click on the chooser. */
async function choose(
  page: Page,
  app: Fixture,
  tenant: Tenant,
  switching = false,
  entered?: Promise<Response>,
): Promise<TenantContextReply> {
  const reply =
    entered ??
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/tenant/context/${switching ? 'switch' : 'open'}` &&
        response.request().method() === 'POST',
    );
  if (!entered) await page.getByRole('list', { name: 'Available tenants' }).getByRole('button', { name: tenant, exact: true }).click();
  const response = await reply;
  expect(response.status()).toBe(200);
  const owner = await leaseOfSelection(response);
  expect(owner).toMatchObject({ appId: app.appId, tenantId: tenant });
  // The bar's control on a desk, the account menu's first item on a phone: its words are the same either way.
  await expect(page.locator('.tenant-control-host')).toContainText(`Tenant: ${tenant}`);
  await page.evaluate(async () => {
    const path = '/sessionIdentity.ts';
    Object.assign(window, { crossAppSelectedIdentity: (await import(path)).captureSessionIdentity() });
  });
  return owner;
}

async function workList(page: Page, app: Fixture, tenant: Tenant) {
  await follow(page, `/${app.appId}/${app.model.work}?tenant=${tenant}`);
  await expect(recordName(page, tenant === 'northstar' ? 'Northstar work' : 'Riverview work')).toBeVisible();
  await expect(page.locator('#content')).not.toContainText(tenant === 'northstar' ? 'Riverview work' : 'Northstar work');
}

async function enter(page: Page, app: Fixture, role: keyof Fixture['accounts'] = 'member', nativeForm = false) {
  await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
  const account = app.accounts[role];
  if (!nativeForm)
    expect(
      (
        await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
          headers: { origin: app.origin },
          data: { email: account.email, password: account.password },
        })
      ).status(),
    ).toBe(200);
  // The viewer's one membership is entered without the chooser.
  const entered = role === 'viewer' ? page.waitForResponse(isSelection) : undefined;
  await page.goto(`${app.origin}/${app.appId}/${app.model.work}?tenant=northstar`);
  if (nativeForm) {
    await expect(page.getByRole('heading', { name: `Sign in to ${app.appName}`, exact: true })).toBeVisible();
    await expect(page.locator('#content')).not.toContainText('Northstar work');
    await page.getByLabel('Email', { exact: true }).fill(account.email);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    const signedIn = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/sign-in/email');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    expect((await signedIn).status()).toBe(200);
  }
  if (!entered) {
    await expect(page.getByRole('heading', { name: 'Choose a tenant', exact: true })).toBeVisible();
    await expect(page.locator('.tenant-chooser-app')).toHaveText(app.appName);
    await expect(page.getByRole('list', { name: 'Available tenants' }).getByRole('button')).toHaveText(['northstar', 'riverview']);
  }
  const owner = await choose(page, app, 'northstar', false, entered);
  expect(owner.accountId).toBe(account.id);
  await workList(page, app, 'northstar');
  return owner;
}

async function switchTo(page: Page, app: Fixture, current: Tenant, next: Tenant) {
  // The bar's control on a desk; on a phone the context is the account menu's first item.
  const control = page.getByRole('button', { name: `Tenant: ${current}`, exact: true });
  if (await control.isVisible()) await control.click();
  else {
    await page.getByRole('button', { name: /^Account/ }).click();
    await page.getByRole('menuitem', { name: `Tenant: ${current}`, exact: true }).click();
  }
  const owner = await choose(page, app, next, true);
  await workList(page, app, next);
  return owner;
}

async function openWork(page: Page) {
  await recordName(page, 'Northstar work').click();
  await expect(page.getByRole('heading', { name: 'Northstar work', exact: true })).toBeVisible();
}

async function openTarget(page: Page) {
  await openWork(page);
  await expect(page.locator('#content')).not.toContainText('Northstar hidden target');
  await expect(page.locator('#content')).not.toContainText('Riverview target');
  await recordName(page, 'Northstar target').click();
  await expect(page.getByRole('heading', { name: 'Northstar target', exact: true })).toBeVisible();
}

async function rememberDraft(page: Page, value: string) {
  await openWork(page);
  await page.getByRole('button', { name: 'Edit Name', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Name', exact: true });
  await field.fill(value);
  await page.evaluate(async () => {
    const path = '/sessionIdentity.ts',
      identity = await import(path);
    Object.assign(window, {
      crossAppIdentity: identity.captureSessionIdentity(),
      crossAppLease: identity.captureTenantLease(),
      crossAppField: document.activeElement,
    });
  });
  return field;
}

const renew = (page: Page) =>
  page.evaluate(async (path) => {
    try {
      await (await import(path)).checkBrowserTenant();
      return true;
    } catch {
      return false;
    }
  }, TENANT_BROWSER);

for (const kind of ['ignition', 'thread'] as const)
  test.describe(`${kind} cross-App tenant proof`, () => {
    test.setTimeout(90_000);
    let app: Fixture;
    test.beforeEach(async () => {
      app = await startTenantProof(kind);
    });
    test.afterEach(async ({ page }) => {
      try {
        await page.unrouteAll({ behavior: 'wait' });
      } finally {
        await app?.stop();
      }
    });

    test('native sign-in and A→B→A selection scope equal business IDs to the entitled unit', async ({ page }) => {
      const north = await enter(page, app, 'member', true);
      const northWork = await query(page, app, north, app.model.work);
      expect(northWork).toHaveLength(1);
      expect(northWork[0]).toMatchObject({
        id: app.rows.north.work,
        name: 'Northstar work',
        [app.model.unitForeignKey]: app.rows.north.unit,
      });
      expect((await query(page, app, north, app.model.unit)).map((row) => row.id)).toEqual([app.rows.north.unit]);
      await expect(page.locator('#content')).not.toContainText('Northstar hidden work');
      await page.evaluate(() => Object.assign(window, { crossAppDocument: 'retained' }));
      const south = await switchTo(page, app, 'northstar', 'riverview');
      expect(south.accountId).toBe(north.accountId);
      expect(south.tabId).toBe(north.tabId);
      expect(south.context).not.toBe(north.context);
      const southWork = await query(page, app, south, app.model.work);
      expect(southWork).toHaveLength(1);
      expect(southWork[0]).toMatchObject({
        id: app.rows.south.work,
        name: 'Riverview work',
        [app.model.unitForeignKey]: app.rows.south.unit,
      });
      expect(northWork[0].business_id).toEqual(expect.any(String));
      expect(southWork[0].business_id).toBe(northWork[0].business_id);
      expect(southWork[0].id).not.toBe(northWork[0].id);
      expect((await query(page, app, south, app.model.unit)).map((row) => row.id)).toEqual([app.rows.south.unit]);
      await denied(await call(page, app, north, '/api/query', { table: app.model.work }));
      await switchTo(page, app, 'riverview', 'northstar');
      await expect(page.locator('#content')).not.toContainText('Northstar hidden work');
      expect(await page.evaluate(() => Reflect.get(window, 'crossAppDocument'))).toBe('retained');
    });

    for (const role of ['manager', 'viewer'] as const)
      test(`${role} gets only its explicit unit and write grants`, async ({ page }) => {
        const owner = await enter(page, app, role);
        expect((await query(page, app, owner, app.model.unit)).map((row) => row.id).sort()).toEqual(
          (role === 'manager' ? [app.rows.north.unit, app.rows.north.otherUnit] : [app.rows.north.unit]).sort(),
        );
        expect((await query(page, app, owner, app.model.work)).map((row) => row.id).sort()).toEqual(
          (role === 'manager' ? [app.rows.north.work, app.rows.north.otherWork] : [app.rows.north.work]).sort(),
        );
        if (role === 'manager') {
          await expect(recordName(page, 'Northstar hidden work')).toBeVisible();
          await expect(page.getByRole('button', { name: /^\+ New / })).toBeVisible();
        } else {
          await expect(page.locator('#content')).not.toContainText('Northstar hidden work');
          await expect(page.getByRole('button', { name: /^\+ New / })).toHaveCount(0);
        }
        await openTarget(page);
        await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Delete…', exact: true })).toHaveCount(0);
        if (role === 'manager') await expect(page.getByRole('button', { name: app.model.action, exact: true })).toBeVisible();
        else {
          await expect(page.getByRole('button', { name: app.model.action, exact: true })).toHaveCount(0);
          await denied(
            await call(page, app, owner, '/api/commands/prepare', {
              command: app.model.command,
              commandVersion: 1,
              key: { id: app.rows.north.target },
            }),
          );
        }
      });

    test('generic New uses a scoped unit picker and refuses hidden or foreign owner claims', async ({ page }) => {
      const owner = await enter(page, app);
      const units = await query(page, app, owner, app.model.unit);
      expect(units).toHaveLength(1);
      const unitName = String(units[0].name);
      await page.getByRole('button', { name: /^\+ New / }).click();
      const form = page.getByRole('dialog', { name: /^New / });
      await expect(form.getByRole('textbox', { name: /Tenant/i })).toHaveCount(0);
      await expect(form.getByRole('textbox', { name: 'ID', exact: true })).toHaveCount(0);
      await form.getByRole('textbox', { name: 'Business ID', exact: true }).fill('browser-created');
      await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Created in Northstar');
      const picker = form.getByRole('combobox', { name: /Location|Project/i });
      for (const search of ['hidden', 'Riverview']) {
        const searched = page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/run' && response.request().postData()?.includes(search) === true,
        );
        await picker.fill(search);
        expect((await searched).status()).toBe(200);
        await expect(page.locator('.picker-empty')).toContainText('Nothing matches');
        await expect(page.getByRole('option')).toHaveCount(0);
      }
      await picker.fill('Northstar');
      const choice = page.getByRole('option').filter({ hasText: unitName });
      await expect(choice).toBeVisible();
      await expect(page.getByRole('option')).toHaveCount(1);
      await choice.click();
      const inserted = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/insert');
      await form.getByRole('button', { name: 'Add', exact: true }).click();
      const response = await inserted,
        created = await response.json();
      expect(response.status()).toBe(200);
      expect(response.request().postDataJSON().values).toEqual({
        business_id: 'browser-created',
        name: 'Created in Northstar',
        [app.model.unitForeignKey]: app.rows.north.unit,
        status: 'open',
      });
      expect(created.key.id).toMatch(/^[a-f0-9]{32}$/);
      expect(scalar(app.database, `SELECT tenant_id FROM physical_${app.model.work} WHERE id=?`, created.key.id)).toBe('northstar');
      await expect(page.getByRole('heading', { name: 'Created in Northstar', exact: true })).toBeVisible();
      expect(await query(page, app, owner, app.model.work)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: created.key.id, name: 'Created in Northstar', [app.model.unitForeignKey]: app.rows.north.unit }),
        ]),
      );
      for (const values of [
        { [app.model.unitForeignKey]: app.rows.north.otherUnit },
        { [app.model.unitForeignKey]: app.rows.south.unit },
        { [app.model.unitForeignKey]: app.rows.north.unit, tenant_id: 'riverview' },
      ])
        await denied(
          await call(page, app, owner, '/api/insert', {
            table: app.model.work,
            values: { business_id: 'forged-browser-create', name: 'Must not exist', ...values },
          }),
        );
      expect(count(app.database, `SELECT count(*) FROM physical_${app.model.work} WHERE business_id=?`, 'forged-browser-create')).toBe(0);
      expect((await query(page, app, owner, app.model.work)).map((row) => row.name).sort()).toEqual([
        'Created in Northstar',
        'Northstar work',
      ]);
      const south = await switchTo(page, app, 'northstar', 'riverview');
      expect((await query(page, app, south, app.model.work)).map((row) => row.name)).toEqual(['Riverview work']);
    });

    for (const width of [1440, 390])
      test(`related target command recovers lost acknowledgements with one event at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        const owner = await enter(page, app, 'member', true);
        const before = await query(page, app, owner, app.model.event);
        const storedBefore = count(app.database, `SELECT count(*) FROM physical_${app.model.event}`);
        const body = `${kind} browser command at ${width}px`;
        const executions: Row[] = [],
          statuses: Row[] = [],
          receipts: Row[] = [];
        await page.route('**/api/commands/execute?*', async (route) => {
          executions.push(route.request().postDataJSON());
          const committed = await route.fetch({ maxRetries: 0 });
          expect(committed.status()).toBe(200);
          const receipt = await committed.json();
          expect(receipt).toMatchObject({
            status: 'applied',
            result: {
              targetId: app.rows.north.target,
              eventId: expect.any(String),
              version: 1,
              message: 'Update recorded.',
            },
          });
          receipts.push(receipt);
          await route.abort('failed');
        });
        page.on('request', (request) => {
          if (new URL(request.url()).pathname === '/api/commands/status') statuses.push(request.postDataJSON());
        });
        await openTarget(page);
        await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Delete…', exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: app.model.action, exact: true }).click();
        const form = page.getByRole('dialog', { name: app.model.action, exact: true });
        await expect(form.getByRole('status')).toContainText('Ready to submit');
        const input = form.getByRole('textbox', { name: /^Body/ });
        await input.fill(body);
        await form.getByRole('button', { name: app.model.action, exact: true }).click();
        await expect(form.getByRole('button', { name: 'Retry same submission', exact: true })).toBeVisible();
        await expect(input).toBeDisabled();
        await expect(form.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
        await form.getByRole('button', { name: 'Retry same submission', exact: true }).click();
        await expect.poll(() => executions.length).toBe(2);
        await expect(form.getByRole('button', { name: 'Check result', exact: true })).toBeVisible();
        expect(executions[1]).toEqual(executions[0]);
        expect(executions[0]).toMatchObject({
          command: app.model.command,
          commandVersion: 1,
          key: { id: app.rows.north.target },
          expectedVersion: 0,
          idempotencyKey: expect.any(String),
          input: { body },
        });
        expect(receipts).toHaveLength(2);
        expect(receipts[1].receiptId).toBe(receipts[0].receiptId);
        expect(receipts[1].result).toEqual(receipts[0].result);
        const checked = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/commands/status');
        await form.getByRole('button', { name: 'Check result', exact: true }).click();
        await expect(form.getByRole('status')).toHaveAttribute('data-phase', 'success');
        const statusResponse = await checked;
        expect(statusResponse.status()).toBe(200);
        expect(await statusResponse.json()).toMatchObject({
          status: 'applied',
          receiptId: receipts[0].receiptId,
          result: receipts[0].result,
        });
        expect(statuses).toEqual([executions[0]]);
        expect(await query(page, app, owner, app.model.target)).toEqual([
          expect.objectContaining({ id: app.rows.north.target, status: 'done', version: 1 }),
        ]);
        const events = await query(page, app, owner, app.model.event);
        expect(events).toHaveLength(before.length + 1);
        expect(events.filter((row) => row.body === body)).toEqual([
          expect.objectContaining({ [app.model.targetForeignKey]: app.rows.north.target }),
        ]);
        expect(count(app.database, `SELECT count(*) FROM physical_${app.model.event}`)).toBe(storedBefore + 1);
        expect(
          rows(app.database, `SELECT tenant_id, ${app.model.targetForeignKey} FROM physical_${app.model.event} WHERE body=?`, body),
        ).toEqual([{ tenant_id: 'northstar', [app.model.targetForeignKey]: app.rows.north.target }]);
        expect(
          rows(
            app.database,
            `SELECT id, status, version FROM physical_${app.model.target} WHERE id != ? ORDER BY id`,
            app.rows.north.target,
          ),
        ).toEqual([app.rows.north.otherTarget, app.rows.south.target].sort().map((id) => ({ id, status: 'open', version: 0 })));
        expect(
          await form.evaluate((node) => {
            const box = node.getBoundingClientRect();
            return box.left >= 0 && box.right <= innerWidth;
          }),
        ).toBe(true);
        await form.getByRole('button', { name: 'Done', exact: true }).click();
        await expect(page.getByRole('button', { name: app.model.action, exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
        const south = await switchTo(page, app, 'northstar', 'riverview');
        expect(await query(page, app, south, app.model.target)).toEqual([
          expect.objectContaining({ id: app.rows.south.target, status: 'open', version: 0 }),
        ]);
        expect((await query(page, app, south, app.model.event)).filter((row) => row.body === body)).toEqual([]);
        expect(executions).toHaveLength(2);
      });

    test('lost renewal preserves dirty work while the other App rejects transplanted context claims', async ({ page, browser }) => {
      const owner = await enter(page, app);
      const other = await startTenantProof(kind === 'ignition' ? 'thread' : 'ignition');
      // Auth cookies on localhost are not partitioned by port. Give each host
      // its own native login so a refusal proves context ownership, not logout.
      const otherContext = await browser.newContext();
      const otherPage = await otherContext.newPage();
      const crashes: string[] = [];
      otherPage.on('pageerror', (error) => crashes.push(String(error)));
      try {
        const otherOwner = await enter(otherPage, other);
        const draft = `${app.appId} unsaved work`,
          otherDraft = `${other.appId} unsaved work`;
        const field = await rememberDraft(page, draft),
          otherField = await rememberDraft(otherPage, otherDraft);
        let requests = 0,
          expected: unknown,
          receipt: unknown;
        await page.route('**/api/tenant/context/renew?*', async (route) => {
          requests++;
          const response = await route.fetch({ maxRetries: 0 });
          expect(response.status()).toBe(200);
          if (requests === 1) {
            expected = route.request().postDataJSON();
            receipt = await response.json();
            await route.abort('failed');
          } else {
            expect(route.request().postDataJSON()).toEqual(expected);
            expect(await response.json()).toEqual(receipt);
            await route.fulfill({ response });
          }
        });
        expect(await renew(page)).toBe(false);
        /* The reply was lost, which says nothing about the context (G172): the lease still runs, so the page stays open and
         the same exact attempt is asked again. */
        await expect(page.getByRole('dialog', { name: 'Tenant access paused' })).toHaveCount(0);
        await expect(page.locator('body > .layout')).not.toHaveAttribute('inert', '');
        await expect(otherPage.getByRole('dialog', { name: 'Tenant access paused' })).toHaveCount(0);
        await expect(otherField).toHaveValue(otherDraft);
        expect(await renew(page)).toBe(true);
        expect(requests).toBe(2);
        await expect(page.getByRole('dialog', { name: 'Tenant access paused' })).toHaveCount(0);
        await expect(field).toHaveValue(draft);
        const preserved = await page.evaluate(async () => {
          const path = '/sessionIdentity.ts',
            identity = await import(path);
          const before = Reflect.get(window, 'crossAppLease'),
            after = identity.captureTenantLease();
          return {
            same: identity.captureSessionIdentity() === Reflect.get(window, 'crossAppIdentity'),
            context: after?.context === before.context,
            renewed: after?.revision > before.revision,
            mounted: Reflect.get(window, 'crossAppField').isConnected,
            focused: document.activeElement === Reflect.get(window, 'crossAppField'),
          };
        });
        expect(preserved).toEqual({ same: true, context: true, renewed: true, mounted: true, focused: true });
        await expect(otherField).toHaveValue(otherDraft);
        expect(
          await otherPage.evaluate(async () => {
            const path = '/sessionIdentity.ts',
              identity = await import(path);
            return (
              identity.captureSessionIdentity() === Reflect.get(window, 'crossAppIdentity') &&
              identity.captureTenantLease()?.revision === Reflect.get(window, 'crossAppLease').revision &&
              Reflect.get(window, 'crossAppField').isConnected
            );
          }),
        ).toBe(true);

        // Authenticate to the destination, then transplant a different App's
        // genuine context. Matching its public app/account labels cannot mint it.
        const current = receipt as TenantContextReply;
        await denied(
          await call(otherPage, other, { ...current, appId: other.appId, accountId: otherOwner.accountId }, '/api/query', {
            table: other.model.work,
          }),
        );
        await denied(
          await call(page, app, { ...otherOwner, appId: app.appId, accountId: owner.accountId }, '/api/update', {
            table: app.model.work,
            key: { id: app.rows.north.work },
            values: { name: 'Forged cross-App write' },
          }),
        );
        await denied(await call(page, app, owner, '/api/query', { table: app.model.work }));
        expect(await query(page, app, current, app.model.work)).toEqual([
          expect.objectContaining({ id: app.rows.north.work, name: 'Northstar work' }),
        ]);
        expect(await query(otherPage, other, otherOwner, other.model.work)).toEqual([
          expect.objectContaining({ id: other.rows.north.work, name: 'Northstar work' }),
        ]);
        await expect(field).toHaveValue(draft);
        await expect(otherField).toHaveValue(otherDraft);
        expect(crashes).toEqual([]);
      } finally {
        try {
          await otherContext.close();
        } finally {
          await other.stop();
        }
      }
    });
  });
