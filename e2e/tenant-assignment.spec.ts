// e2e-client: source — imports /sessionIdentity.ts from the page
import { test, expect, type Page, type Locator } from './support/harness.js';
import { follow } from './support/app.js';
import { rows } from './support/db.js';
/* A command is one journal row; its audit is that row's targets, read back one row each. */
import { sqliteAuditRows } from '../test/support/commandTargets.js';
import { startTenantAssignment, type TenantAssignmentFixture } from './support/tenantProofServer.js';
import { TENANT_HTTP_HEADERS as headers, type TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';

type Fixture = TenantAssignmentFixture;
type Row = Record<string, unknown>;
type Receipt = { status: string; receiptId: string; result: Row; replayed: boolean };

// Responsive lists mount both presentations; click the one the user can see.
const recordName = (page: Page, label: string) => page.locator('#content').getByText(label, { exact: true }).filter({ visible: true });
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
  // Recovery may renew the lease while retaining the selected authority.
  const selected = await page.evaluate(async () => {
    const path = '/sessionIdentity.ts',
      identity = await import(path);
    return {
      same: identity.captureSessionIdentity() === Reflect.get(window, 'assignmentSelectedIdentity'),
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

async function enter(page: Page, app: Fixture, role: keyof Fixture['accounts'] = 'manager', nativeForm = false) {
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
  // The selection: a click on the chooser, or for the viewer's one membership, made as the page loads.
  const selected = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/tenant/context/open' && response.request().method() === 'POST',
  );
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
  if (role !== 'viewer') {
    await expect(page.getByRole('heading', { name: 'Choose a tenant', exact: true })).toBeVisible();
    await expect(page.locator('.tenant-chooser-app')).toHaveText(app.appName);
    const tenants = page.getByRole('list', { name: 'Available tenants' });
    await expect(tenants.getByRole('button')).toHaveText(['northstar', 'riverview']);
    await tenants.getByRole('button', { name: 'northstar', exact: true }).click();
  }
  const response = await selected;
  expect(response.status()).toBe(200);
  const owner = (await response.json()) as TenantContextReply;
  expect(owner).toMatchObject({ appId: app.appId, accountId: account.id, tenantId: 'northstar' });
  // The bar's control on a desk, the account menu's first item on a phone: its words are the same either way.
  await expect(page.locator('.tenant-control-host')).toContainText('Tenant: northstar');
  await page.evaluate(async () => {
    const path = '/sessionIdentity.ts';
    Object.assign(window, { assignmentSelectedIdentity: (await import(path)).captureSessionIdentity() });
  });
  await follow(page, `/${app.appId}/${app.model.work}?tenant=northstar`);
  await expect(recordName(page, 'Northstar work')).toBeVisible();
  await expect(page.locator('#content')).not.toContainText('Riverview work');
  return owner;
}

async function openApplication(page: Page) {
  await recordName(page, 'Northstar work').click();
  await expect(page.getByRole('heading', { name: 'Northstar work', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Applications', exact: true }).click();
  const applications = page.getByRole('tabpanel', { name: 'Applications', exact: true });
  await expect(applications.getByText('Northstar application', { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(applications.getByRole('columnheader', { name: 'ID', exact: true })).toHaveCount(0);
  await expect(applications).not.toContainText('Northstar other application');
  await expect(applications).not.toContainText('Riverview application');
  await recordName(page, 'Northstar application').click();
  await expect(page.getByRole('heading', { name: 'Northstar application', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete…', exact: true })).toHaveCount(0);
}

async function prepare(page: Page, app: Fixture) {
  const prepared = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/commands/prepare');
  await page.getByRole('button', { name: app.assignment.action, exact: true }).click();
  const response = await prepared;
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ expectedVersion: 0 });
  expect(response.request().postDataJSON()).toMatchObject({
    command: app.assignment.command,
    commandVersion: 1,
    key: { id: app.assignmentRows.north.application },
  });
  const form = page.getByRole('dialog', { name: app.assignment.action, exact: true });
  await expect(form.getByRole('status')).toContainText('Ready to submit');
  return form;
}

async function fill(page: Page, form: Locator, reason: string) {
  await form.getByRole('combobox', { name: 'Reviewer (required)', exact: true }).fill('Northstar reviewer');
  await page.getByRole('option', { name: 'Northstar reviewer', exact: true }).click();
  await form.getByRole('textbox', { name: /^Assignment reason/ }).fill(reason);
}

function stored(app: Fixture) {
  return {
    applications: rows(app.database, `SELECT * FROM physical_${app.assignment.application} ORDER BY id`),
    history: rows(app.database, `SELECT * FROM physical_${app.assignment.history} ORDER BY id`),
    receipts: rows(app.database, 'SELECT * FROM __mistri_command_receipt ORDER BY id'),
    audit: rows(app.database, `SELECT * FROM ${sqliteAuditRows} a ORDER BY receipt_id, ordinal`),
  };
}

function assigned(app: Fixture, before: ReturnType<typeof stored>, receipt: Receipt, reason: string) {
  const north = app.assignmentRows.north;
  expect(receipt).toMatchObject({
    status: 'applied',
    receiptId: expect.any(String),
    result: {
      applicationId: north.application,
      reviewerId: north.reviewer,
      assignmentId: expect.stringMatching(/^[a-f0-9]{32}$/),
      managerId: north.manager,
      version: 1,
      message: 'Reviewer assigned.',
    },
  });
  const after = stored(app);
  expect(after.applications).toEqual(
    before.applications.map((row) => (row.id === north.application ? { ...row, reviewer_id: north.reviewer, version: 1 } : row)),
  );
  expect(after.history).toHaveLength(before.history.length + 1);
  expect(after.history).toEqual(
    expect.arrayContaining([
      ...before.history,
      expect.objectContaining({
        id: receipt.result.assignmentId,
        tenant_id: 'northstar',
        location_id: app.rows.north.unit,
        application_id: north.application,
        assigned_to: north.reviewer,
        assigned_by: north.manager,
        name: 'Reviewer assigned',
        reason,
        assigned_on: expect.any(String),
      }),
    ]),
  );
  expect(after.receipts).toHaveLength(before.receipts.length + 1);
  expect(after.audit).toHaveLength(before.audit.length + 1);
  expect(after.receipts.find((row) => row.id === receipt.receiptId)).toMatchObject({
    app_id: app.appId,
    tenant_id: 'northstar',
    actor_id: app.accounts.manager.id,
    command_id: app.assignment.command,
  });
  expect(after.audit.find((row) => row.receipt_id === receipt.receiptId)).toMatchObject({
    app_id: app.appId,
    tenant_id: 'northstar',
    actor_id: app.accounts.manager.id,
  });
}

async function openHistory(page: Page, app: Fixture, form: Locator, receipt: Receipt, reason: string) {
  expect(
    await form.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth;
    }),
  ).toBe(true);
  await form.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('button', { name: app.assignment.action, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  // The authored related section has no role; its heading identifies the list.
  const history = page.locator('.page-section').filter({ has: page.getByRole('heading', { name: 'Assignments', exact: true }) });
  await expect(history.getByText('Reviewer assigned', { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expect(history.getByRole('columnheader', { name: 'ID', exact: true })).toHaveCount(0);
  await expect(history).not.toContainText(String(receipt.result.assignmentId));
  await history.getByText('Reviewer assigned', { exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole('heading', { name: 'Reviewer assigned', exact: true })).toBeVisible();
  await expect(page.locator('#content')).toContainText(reason);
  await expect(page.locator('#content')).toContainText('Northstar reviewer');
  await expect(page.locator('#content')).toContainText('Northstar manager');
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  // The record's own address ends in its id, never a walk of `~` tokens.
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname)).toMatch(new RegExp(`/${receipt.result.assignmentId}$`));
  // The record's Application field, not the trail's step back to the same record: since the trail gave the
  // table a step of its own (e0bb7e0c4) that step is named by the record alone, as the field's link is.
  await page.locator('#content').getByRole('definition').getByRole('button', { name: 'Northstar application', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Northstar application', exact: true })).toBeVisible();
}

test.describe('Ignition tenant assignment browser proof', () => {
  test.setTimeout(90_000);
  let app: Fixture;
  test.beforeEach(async () => {
    app = await startTenantAssignment();
  });
  test.afterEach(async ({ page }) => {
    try {
      await page.unrouteAll({ behavior: 'wait' });
    } finally {
      await app?.stop();
    }
  });

  for (const width of [1440, 390])
    test(`manager selects a scoped reviewer and opens related history without visible IDs at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const owner = await enter(page, app, 'manager', true);
      await expect(recordName(page, 'Northstar hidden work')).toBeVisible();
      const applications = await query(page, app, owner, app.assignment.application);
      expect(applications.map((row) => row.id)).toContain(app.assignmentRows.north.otherApplication);
      expect(applications.map((row) => row.id)).not.toContain(app.assignmentRows.south.application);
      const staff = await query(page, app, owner, app.assignment.staff);
      expect(staff.map((row) => row.id).sort()).toEqual(
        [
          app.assignmentRows.north.manager,
          app.assignmentRows.north.reviewer,
          app.assignmentRows.north.alternateReviewer,
          app.assignmentRows.north.wrongRole,
        ].sort(),
      );
      const before = stored(app);
      await openApplication(page);
      const form = await prepare(page, app);
      await form.getByRole('button', { name: app.assignment.action, exact: true }).click();
      await expect(form.getByRole('status')).toContainText('Reviewer is required');
      const picker = form.getByRole('combobox', { name: 'Reviewer (required)', exact: true });
      for (const search of ['other-location', 'Riverview', 'inactive', 'clerk', 'manager']) {
        const searched = page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/run' && response.request().postData()?.includes(search) === true,
        );
        await picker.fill(search);
        const response = await searched;
        expect(response.status()).toBe(200);
        expect((await response.json()).rows).toEqual([]);
        await expect(page.locator('.picker-empty')).toContainText('No matching choices');
        await expect(page.getByRole('option')).toHaveCount(0);
      }
      await picker.fill('Northstar');
      await expect(page.getByRole('option')).toHaveText(['Northstar alternate reviewer', 'Northstar reviewer']);
      const reason = `Manager allocation at ${width}px`;
      await fill(page, form, reason);
      const executed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/commands/execute');
      await form.getByRole('button', { name: app.assignment.action, exact: true }).click();
      await expect(form.getByRole('status')).toHaveAttribute('data-phase', 'success');
      const response = await executed;
      expect(response.status()).toBe(200);
      const receipt = (await response.json()) as Receipt;
      expect(response.request().postDataJSON()).toMatchObject({
        command: app.assignment.command,
        commandVersion: 1,
        key: { id: app.assignmentRows.north.application },
        expectedVersion: 0,
        input: { reviewer: app.assignmentRows.north.reviewer, reason },
      });
      assigned(app, before, receipt, reason);
      const history = await query(page, app, owner, app.assignment.history);
      expect(history).toEqual([expect.objectContaining({ id: receipt.result.assignmentId, reason })]);
      await openHistory(page, app, form, receipt, reason);
    });

  test('phone lost acknowledgements recover the exact assignment through replay and status', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const owner = await enter(page, app);
    const before = stored(app),
      reason = 'Recover this exact assignment';
    const executions: Row[] = [],
      statuses: Row[] = [],
      receipts: Receipt[] = [];
    // Execute against the real host before dropping both success replies.
    await page.route('**/api/commands/execute?*', async (route) => {
      executions.push(route.request().postDataJSON());
      const committed = await route.fetch({ maxRetries: 0 });
      expect(committed.status()).toBe(200);
      receipts.push((await committed.json()) as Receipt);
      await route.abort('failed');
    });
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/commands/status') statuses.push(request.postDataJSON());
    });
    await openApplication(page);
    const form = await prepare(page, app);
    await fill(page, form, reason);
    await form.getByRole('button', { name: app.assignment.action, exact: true }).click();
    await expect(form.getByRole('button', { name: 'Retry same submission', exact: true })).toBeVisible();
    expect(executions).toHaveLength(1);
    await expect(form.getByRole('combobox', { name: 'Reviewer (required)', exact: true })).toBeDisabled();
    await expect(form.getByRole('textbox', { name: /^Assignment reason/ })).toHaveValue(reason);
    await expect(form.getByRole('textbox', { name: /^Assignment reason/ })).toBeDisabled();
    await expect(form.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(form).toBeVisible();
    await form.getByRole('button', { name: 'Retry same submission', exact: true }).click();
    await expect.poll(() => receipts.length).toBe(2);
    await expect(form.getByRole('button', { name: 'Check result', exact: true })).toBeVisible();
    expect(executions).toHaveLength(2);
    expect(executions[1]).toEqual(executions[0]);
    expect(executions[0]).toMatchObject({
      command: app.assignment.command,
      commandVersion: 1,
      key: { id: app.assignmentRows.north.application },
      expectedVersion: 0,
      idempotencyKey: expect.any(String),
      input: { reviewer: app.assignmentRows.north.reviewer, reason },
    });
    expect(receipts[1].receiptId).toBe(receipts[0].receiptId);
    expect(receipts[1].result).toEqual(receipts[0].result);
    expect(receipts[0].replayed).toBe(false);
    expect(receipts[1].replayed).toBe(true);
    const checked = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/commands/status');
    await form.getByRole('button', { name: 'Check result', exact: true }).click();
    await expect(form.getByRole('status')).toHaveAttribute('data-phase', 'success');
    const response = await checked;
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'applied',
      replayed: true,
      receiptId: receipts[0].receiptId,
      result: receipts[0].result,
    });
    expect(statuses).toEqual([executions[0]]);
    assigned(app, before, receipts[0], reason);
    expect(await query(page, app, owner, app.assignment.history)).toEqual([
      expect.objectContaining({ id: receipts[0].result.assignmentId, reason }),
    ]);
    await openHistory(page, app, form, receipts[0], reason);
    expect(executions).toHaveLength(2);
  });

  /* The `actor` axis stays: it changes both the refusal code and the sentence
     the reader is shown (`forbidden` / "not available to this account" versus
     `reviewer_unavailable` / "selected reviewer is unavailable"). The
     `inactive`/`wrong role` axis changed nothing observable, and the node
     suite loops it over the same HTTP (`test/tenant-assignment.test.ts`). */
  for (const actor of ['manager', 'reviewer'] as const)
    test(`${actor} becoming inactive after prepare refuses assignment without effects`, async ({ page }) => {
      const change = 'inactive' as const;
      await enter(page, app);
      await openApplication(page);
      const form = await prepare(page, app);
      await fill(page, form, 'Prepared before staff changed');
      const before = stored(app);
      await app.setStaffState(app.assignmentRows.north[actor], change === 'inactive' ? { active: 0 } : { role: 'clerk' });
      const executed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/commands/execute');
      await form.getByRole('button', { name: app.assignment.action, exact: true }).click();
      const response = await executed;
      expect(response.status()).toBeGreaterThanOrEqual(400);
      expect(response.status()).toBeLessThan(500);
      const failure = await response.json();
      expect(failure).toMatchObject({ outcome: 'not_applied', code: actor === 'manager' ? 'forbidden' : 'reviewer_unavailable' });
      await expect(form.getByRole('status')).toContainText(
        actor === 'manager' ? 'not available to this account' : 'selected reviewer is unavailable',
      );
      await expect(form.getByRole('button', { name: 'Refresh and review', exact: true })).toBeVisible();
      await expect(form.getByRole('button', { name: 'Retry same submission', exact: true })).toHaveCount(0);
      expect(stored(app)).toEqual(before);
    });

  for (const role of ['member', 'viewer'] as const)
    test(`${role} can read the application but cannot assign a reviewer`, async ({ page }) => {
      const owner = await enter(page, app, role);
      await openApplication(page);
      await expect(page.getByRole('button', { name: app.assignment.action, exact: true })).toHaveCount(0);
      const before = stored(app);
      const response = await call(page, app, owner, '/api/commands/prepare', {
        command: app.assignment.command,
        commandVersion: 1,
        key: { id: app.assignmentRows.north.application },
      });
      expect([403, 404]).toContain(response.status());
      expect(await response.text()).not.toMatch(/Northstar (?:reviewer|manager)|Riverview|expectedVersion/);
      expect(stored(app)).toEqual(before);
    });
});
