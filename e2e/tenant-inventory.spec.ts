// e2e-client: source — imports /sessionIdentity.ts from the page
import { test, expect, type Page, type Locator } from './support/harness.js';
import { follow } from './support/app.js';
import { rows } from './support/db.js';
/* A command is one journal row; its audit is that row's targets, read back one row each. */
import { sqliteAuditRows } from '../test/support/commandTargets.js';
import { startTenantInventory, type TenantInventoryFixture } from './support/tenantProofServer.js';
import { TENANT_HTTP_HEADERS as headers, type TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';
import { isSelection, leaseOfSelection } from './support/tenantSelection.js';

type Fixture = TenantInventoryFixture;
type Row = Record<string, unknown>;
type Mode = 'reserve' | 'release';
type Receipt = { status: string; receiptId: string; result: Row; replayed: boolean };

// Responsive lists mount both presentations; use the one a person can see.
const recordName = (page: Page, label: string) => page.locator('#content').getByText(label, { exact: true }).filter({ visible: true });
const referenceChip = (page: Page, label: string) =>
  page.locator('#content').getByRole('definition').getByRole('button', { name: label, exact: true });
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
const action = (app: Fixture, mode: Mode) => (mode === 'reserve' ? app.inventory.reserveAction : app.inventory.releaseAction);
const reasonBox = (form: Locator, mode: Mode) =>
  form.getByRole('textbox', {
    name: mode === 'reserve' ? /^Reservation reason/ : /^Release reason/,
  });

async function selectedLease(page: Page, owner: TenantContextReply) {
  // Recovery can renew the access window without changing selected authority.
  const selected = await page.evaluate(async () => {
    const path = '/sessionIdentity.ts',
      identity = await import(path);
    return {
      same: identity.captureSessionIdentity() === Reflect.get(window, 'inventorySelectedIdentity'),
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
  expect(selected.lease!.revision).toBeGreaterThanOrEqual(owner.revision);
  return selected.lease!;
}

async function query(page: Page, app: Fixture, owner: TenantContextReply, table: string, extra: Row = {}): Promise<Row[]> {
  const current = await selectedLease(page, owner);
  const response = await call(page, app, current, '/api/query', { table, ...extra });
  expect(response.status()).toBe(200);
  for (const [name, value] of Object.entries(assertion(app, current))) {
    if (name !== 'origin') expect(response.headers()[name], name).toBe(value);
  }
  expect(response.headers()[headers.tenant]).toBe(owner.tenantId);
  const result = await response.json();
  expect(JSON.stringify(result)).not.toContain('tenant_id');
  expect(JSON.stringify(result)).not.toMatch(/Riverview|riverview-|Northstar private|northstar-private/);
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
  const selected = page.waitForResponse(isSelection);
  await page.goto(`${app.origin}/${app.appId}/${app.inventory.vehicle}?tenant=northstar`);
  if (nativeForm) {
    await expect(page.getByRole('heading', { name: `Sign in to ${app.appName}`, exact: true })).toBeVisible();
    await expect(page.locator('#content')).not.toContainText('Northstar vehicle');
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
  const owner = await leaseOfSelection(response);
  expect(owner).toMatchObject({ appId: app.appId, accountId: account.id, tenantId: 'northstar' });
  // The bar's control on a desk, the account menu's first item on a phone: its words are the same either way.
  await expect(page.locator('.tenant-control-host')).toContainText('Tenant: northstar');
  await page.evaluate(async () => {
    const path = '/sessionIdentity.ts';
    Object.assign(window, { inventorySelectedIdentity: (await import(path)).captureSessionIdentity() });
  });
  await follow(page, `/${app.appId}/${app.inventory.vehicle}?tenant=northstar`);
  await expect(recordName(page, 'Northstar vehicle')).toBeVisible();
  await expect(page.locator('#content')).not.toContainText('Riverview');
  return owner;
}

async function noGenericActions(page: Page) {
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete…', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
}

async function openVehicle(page: Page, label = 'Northstar vehicle') {
  await recordName(page, label).click();
  await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
  await noGenericActions(page);
}

async function prepare(page: Page, app: Fixture, mode: Mode, id: string, version: number) {
  const prepared = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/commands/prepare');
  await page.getByRole('button', { name: action(app, mode), exact: true }).click();
  const response = await prepared;
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ expectedVersion: version });
  expect(response.request().postDataJSON()).toEqual({ command: app.inventory[mode], commandVersion: 1, key: { id } });
  const form = page.getByRole('dialog', { name: action(app, mode), exact: true });
  await expect(form.getByRole('status')).toContainText('Ready to submit');
  return form;
}

async function fill(page: Page, form: Locator, mode: Mode, reason: string, lead = 'Northstar work') {
  if (mode === 'reserve') {
    await form.getByRole('combobox', { name: 'Lead (required)', exact: true }).fill(lead);
    await page.getByRole('option', { name: lead, exact: true }).click();
  } else await expect(form.getByRole('combobox')).toHaveCount(0);
  await reasonBox(form, mode).fill(reason);
}

async function submit(page: Page, app: Fixture, form: Locator, mode: Mode, id: string, version: number, reason: string) {
  const executed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/commands/execute');
  await form.getByRole('button', { name: action(app, mode), exact: true }).click();
  const response = await executed;
  expect(response.status()).toBe(200);
  await expect(form.getByRole('status')).toHaveAttribute('data-phase', 'success');
  const envelope = response.request().postDataJSON() as Row;
  expect(envelope).toEqual({
    command: app.inventory[mode],
    commandVersion: 1,
    key: { id },
    expectedVersion: version,
    idempotencyKey: expect.any(String),
    input: mode === 'reserve' ? { lead: app.rows.north.work, reason } : { reason },
  });
  return { receipt: (await response.json()) as Receipt, envelope };
}

async function done(page: Page, form: Locator) {
  expect(
    await form.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth;
    }),
  ).toBe(true);
  await form.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(form).toHaveCount(0);
  await noGenericActions(page);
}

function stored(app: Fixture) {
  return {
    vehicles: rows(app.database, `SELECT * FROM physical_${app.inventory.vehicle} ORDER BY id`),
    reservations: rows(app.database, `SELECT * FROM physical_${app.inventory.reservation} ORDER BY id`),
    history: rows(app.database, `SELECT * FROM physical_${app.inventory.history} ORDER BY id`),
    receipts: rows(app.database, 'SELECT * FROM __mistri_command_receipt ORDER BY id'),
    audit: rows(app.database, `SELECT * FROM ${sqliteAuditRows} a ORDER BY receipt_id, ordinal`),
  };
}

function applied(
  app: Fixture,
  before: ReturnType<typeof stored>,
  receipt: Receipt,
  mode: Mode,
  reason: string,
  vehicleId: string = app.inventoryRows.north.vehicle,
  reservationId?: string,
) {
  const vehicle = before.vehicles.find((row) => row.id === vehicleId)!;
  const oldReservation = before.reservations.find((row) => row.id === reservationId);
  const reserved = mode === 'reserve',
    managerId = app.assignmentRows.north.manager;
  expect(receipt).toMatchObject({ status: 'applied', receiptId: expect.any(String) });
  expect(receipt.result).toEqual({
    vehicleId,
    reservationId: reserved ? expect.stringMatching(/^[a-f0-9]{32}$/) : reservationId,
    historyId: expect.stringMatching(/^[a-f0-9]{32}$/),
    leadId: app.rows.north.work,
    managerId,
    vehicleVersion: Number(vehicle.version) + 1,
    reservationVersion: reserved ? 0 : Number(oldReservation!.version) + 1,
    status: reserved ? 'reserved' : 'available',
    message: reserved ? 'Vehicle reserved.' : 'Reservation released.',
  });
  const after = stored(app),
    result = receipt.result;
  expect(after.vehicles).toEqual(
    before.vehicles.map((row) => (row.id === vehicleId ? { ...row, status: result.status, version: result.vehicleVersion } : row)),
  );
  const history = after.history.find((row) => row.id === result.historyId)!;
  expect(history).toEqual({
    id: result.historyId,
    tenant_id: 'northstar',
    location_id: app.rows.north.unit,
    vehicle_id: vehicleId,
    reservation_id: result.reservationId,
    actor_id: managerId,
    name: reserved ? 'Vehicle reserved' : 'Reservation released',
    from_status: reserved ? 'available' : 'reserved',
    to_status: result.status,
    reason,
    recorded_on: expect.any(String),
  });
  expect(Number.isNaN(Date.parse(String(history.recorded_on)))).toBe(false);
  expect(after.history.filter((row) => row.id !== result.historyId)).toEqual(before.history);
  expect(after.history).toHaveLength(before.history.length + 1);
  if (reserved) {
    expect(after.reservations.find((row) => row.id === result.reservationId)).toEqual({
      id: result.reservationId,
      tenant_id: 'northstar',
      location_id: app.rows.north.unit,
      vehicle_id: vehicleId,
      lead_id: app.rows.north.work,
      reserved_by: managerId,
      released_by: null,
      reference: expect.stringMatching(/^RS-[a-f0-9]{12}$/),
      name: 'Vehicle reservation',
      status: 'active',
      version: 0,
      reason,
      reserved_on: history.recorded_on,
      released_on: null,
    });
    expect(after.reservations.filter((row) => row.id !== result.reservationId)).toEqual(before.reservations);
    expect(after.reservations).toHaveLength(before.reservations.length + 1);
  } else {
    expect(after.reservations).toEqual(
      before.reservations.map((row) =>
        row.id === reservationId
          ? { ...row, status: 'released', version: result.reservationVersion, released_by: managerId, released_on: history.recorded_on }
          : row,
      ),
    );
  }
  expect(after.receipts).toHaveLength(before.receipts.length + 1);
  expect(after.receipts.filter((row) => row.id !== receipt.receiptId)).toEqual(before.receipts);
  expect(after.receipts.find((row) => row.id === receipt.receiptId)).toMatchObject({
    app_id: app.appId,
    tenant_id: 'northstar',
    actor_id: app.accounts.manager.id,
    command_id: app.inventory[mode],
  });
  expect(after.audit).toHaveLength(before.audit.length + 1);
  expect(after.audit.filter((row) => row.receipt_id !== receipt.receiptId)).toEqual(before.audit);
  expect(after.audit.find((row) => row.receipt_id === receipt.receiptId)).toMatchObject({
    app_id: app.appId,
    tenant_id: 'northstar',
    actor_id: app.accounts.manager.id,
  });
}

async function relatedList(page: Page, name: string) {
  const tab = page.getByRole('tab', { name, exact: true });
  // Related lists mount after the record's fields; a count taken before they
  // arrive falls through to the single-section path and finds nothing.
  await expect(tab.or(page.getByRole('heading', { name, exact: true }))).toBeVisible();
  if (await tab.count()) {
    await tab.click();
    return page.getByRole('tabpanel', { name, exact: true });
  }
  // A single related list uses a section heading instead of the tabbed layout.
  return page.locator('.page-section').filter({ has: page.getByRole('heading', { name, exact: true }) });
}

async function relatedReservation(page: Page, id: string) {
  const list = await relatedList(page, 'Reservations');
  await expect(list).toBeVisible();
  await expect(list.getByRole('columnheader', { name: 'ID', exact: true })).toHaveCount(0);
  await expect(list).not.toContainText(id);
  await list.getByText('Vehicle reservation', { exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole('heading', { name: 'Vehicle reservation', exact: true })).toBeVisible();
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname)).toMatch(new RegExp(`/${id}$`));
  await noGenericActions(page);
}

async function historyNavigation(page: Page, receipt: Receipt, mode: Mode, reason: string) {
  const name = mode === 'reserve' ? 'Vehicle reserved' : 'Reservation released';
  const list = await relatedList(page, 'Availability history');
  await expect(list).toBeVisible();
  await expect(list.getByRole('columnheader', { name: 'ID', exact: true })).toHaveCount(0);
  await expect(list).not.toContainText(String(receipt.result.historyId));
  await list.getByText(name, { exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname)).toMatch(new RegExp(`/${receipt.result.historyId}$`));
  await expect(page.locator('#content')).toContainText(reason);
  await noGenericActions(page);
  // These are actual direct-FK buttons, not dotted scalar labels in a list.
  await expect(referenceChip(page, 'Northstar manager')).toBeVisible();
  await expect(referenceChip(page, 'Northstar vehicle')).toBeVisible();
  await referenceChip(page, 'Vehicle reservation').click();
  await expect(page.getByRole('heading', { name: 'Vehicle reservation', exact: true })).toBeVisible();
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname)).toMatch(new RegExp(`/${receipt.result.reservationId}$`));
  await expect(referenceChip(page, 'Northstar work')).toBeVisible();
}

test.describe('Ignition tenant inventory browser proof', () => {
  test.setTimeout(90_000);
  let app: Fixture;
  test.beforeEach(async () => {
    app = await startTenantInventory();
  });
  test.afterEach(async ({ page }) => {
    try {
      await page.unrouteAll({ behavior: 'wait' });
    } finally {
      await app?.stop();
    }
  });

  for (const width of [1440, 390])
    test(`manager reserves, releases the related reservation and reserves anew at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const owner = await enter(page, app, 'manager', true);
      const vehicles = await query(page, app, owner, app.inventory.vehicle);
      expect(vehicles.map((row) => row.id)).toContain(app.inventoryRows.north.otherVehicle);
      const leads = await query(page, app, owner, app.model.work);
      expect(leads.map((row) => row.id).sort()).toEqual([app.rows.north.work, app.rows.north.otherWork].sort());
      expect((await query(page, app, owner, app.inventory.reservation)).map((row) => row.id)).not.toContain(
        app.inventoryRows.north.hiddenReservation,
      );
      await page.getByRole('button', { name: 'Advanced', exact: true }).click();
      const filter = page.getByRole('textbox', { name: 'Filter Vehicles', exact: true });
      const filtered = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/run' && response.request().postData()?.includes('status = available') === true,
      );
      await filter.fill('status = available');
      await filter.press('Enter');
      expect((await filtered).status()).toBe(200);
      await expect(recordName(page, 'Northstar vehicle')).toBeVisible();
      await expect(recordName(page, 'Northstar reserved vehicle')).toHaveCount(0);
      await expect(recordName(page, 'Northstar unavailable vehicle')).toHaveCount(0);
      await expect(page.locator('#content')).not.toContainText('Riverview');
      await openVehicle(page);
      const before = stored(app),
        form = await prepare(page, app, 'reserve', app.inventoryRows.north.vehicle, 0);
      await form.getByRole('button', { name: app.inventory.reserveAction, exact: true }).click();
      await expect(form.getByRole('status')).toContainText('Lead is required');
      const picker = form.getByRole('combobox', { name: 'Lead (required)', exact: true });
      for (const search of ['Riverview', 'private']) {
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
      // Both units are granted. The command separately checks the target's unit.
      await expect(page.getByRole('option')).toHaveText(['Northstar hidden work', 'Northstar work']);
      const reason = `Manager reservation at ${width}px `.padEnd(500, 'x');
      await fill(page, form, 'reserve', reason);
      await expect(reasonBox(form, 'reserve')).toHaveAttribute('maxlength', '500');
      const first = await submit(page, app, form, 'reserve', app.inventoryRows.north.vehicle, 0, reason);
      expect(first.receipt.replayed).toBe(false);
      applied(app, before, first.receipt, 'reserve', reason);
      await done(page, form);
      await expect(page.getByRole('button', { name: app.inventory.reserveAction, exact: true })).toHaveCount(0);
      await relatedReservation(page, String(first.receipt.result.reservationId));
      await expect(referenceChip(page, 'Northstar work')).toBeVisible();
      await historyNavigation(page, first.receipt, 'reserve', reason);
      const beforeRelease = stored(app),
        releaseReason = `Release after review at ${width}px`;
      const releaseForm = await prepare(page, app, 'release', String(first.receipt.result.reservationId), 0);
      await fill(page, releaseForm, 'release', releaseReason);
      const released = await submit(page, app, releaseForm, 'release', String(first.receipt.result.reservationId), 0, releaseReason);
      applied(
        app,
        beforeRelease,
        released.receipt,
        'release',
        releaseReason,
        app.inventoryRows.north.vehicle,
        String(first.receipt.result.reservationId),
      );
      expect(released.receipt.result.vehicleVersion).toBe(2);
      await done(page, releaseForm);
      await expect(page.getByRole('button', { name: app.inventory.releaseAction, exact: true })).toHaveCount(0);
      await historyNavigation(page, released.receipt, 'release', releaseReason);
      await referenceChip(page, 'Northstar vehicle').click();
      await expect(page.getByRole('heading', { name: 'Northstar vehicle', exact: true })).toBeVisible();
      expect(
        (await query(page, app, owner, app.inventory.vehicle)).find((row) => row.id === app.inventoryRows.north.vehicle),
      ).toMatchObject({ status: 'available', version: 2 });
      const beforeAgain = stored(app),
        againReason = `New allocation at ${width}px`;
      const againForm = await prepare(page, app, 'reserve', app.inventoryRows.north.vehicle, 2);
      await fill(page, againForm, 'reserve', againReason);
      const again = await submit(page, app, againForm, 'reserve', app.inventoryRows.north.vehicle, 2, againReason);
      applied(app, beforeAgain, again.receipt, 'reserve', againReason);
      expect(new Set([first.envelope.idempotencyKey, released.envelope.idempotencyKey, again.envelope.idempotencyKey]).size).toBe(3);
      expect(new Set([first.receipt.receiptId, released.receipt.receiptId, again.receipt.receiptId]).size).toBe(3);
      expect(again.receipt.result.reservationId).not.toBe(first.receipt.result.reservationId);
      await done(page, againForm);
      const reservations = await query(page, app, owner, app.inventory.reservation);
      expect(reservations.find((row) => row.id === first.receipt.result.reservationId)).toMatchObject({ status: 'released', version: 1 });
      expect(reservations.filter((row) => row.vehicle_id === app.inventoryRows.north.vehicle && row.status === 'active')).toEqual([
        expect.objectContaining({ id: again.receipt.result.reservationId, version: 0 }),
      ]);
      expect((await query(page, app, owner, app.inventory.history)).map((row) => row.id).sort()).toEqual(
        [first.receipt.result.historyId, released.receipt.result.historyId, again.receipt.result.historyId].sort(),
      );
      const final = stored(app);
      const stale = await call(page, app, await selectedLease(page, owner), '/api/commands/execute', {
        ...released.envelope,
        idempotencyKey: `old-reservation-release-${width}`,
      });
      expect(stale.status()).toBe(409);
      expect(await stale.json()).toMatchObject({ code: 'stale_record', outcome: 'not_applied' });
      expect(stored(app)).toEqual(final);
    });

  for (const mode of ['reserve', 'release'] as const)
    test(`phone lost ${mode} acknowledgements recover the exact envelope through replay and status`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 900 });
      const owner = await enter(page, app);
      await openVehicle(page);
      let reservationId: string | undefined;
      if (mode === 'release') {
        const initial = stored(app),
          reserveForm = await prepare(page, app, 'reserve', app.inventoryRows.north.vehicle, 0);
        await fill(page, reserveForm, 'reserve', 'Create the reservation to release');
        const { receipt } = await submit(
          page,
          app,
          reserveForm,
          'reserve',
          app.inventoryRows.north.vehicle,
          0,
          'Create the reservation to release',
        );
        applied(app, initial, receipt, 'reserve', 'Create the reservation to release');
        reservationId = String(receipt.result.reservationId);
        await done(page, reserveForm);
        await relatedReservation(page, reservationId);
      }
      const id = reservationId ?? app.inventoryRows.north.vehicle,
        before = stored(app),
        reason = `Recover this exact ${mode}`;
      const executions: Row[] = [],
        statuses: Row[] = [],
        receipts: Receipt[] = [];
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
      const form = await prepare(page, app, mode, id, 0);
      await fill(page, form, mode, reason);
      await form.getByRole('button', { name: action(app, mode), exact: true }).click();
      await expect(form.getByRole('button', { name: 'Retry same submission', exact: true })).toBeVisible();
      expect(executions).toHaveLength(1);
      expect(receipts).toHaveLength(1);
      applied(app, before, receipts[0], mode, reason, app.inventoryRows.north.vehicle, reservationId);
      const once = stored(app);
      if (mode === 'reserve') await expect(form.getByRole('combobox', { name: 'Lead (required)', exact: true })).toBeDisabled();
      await expect(reasonBox(form, mode)).toHaveValue(reason);
      await expect(reasonBox(form, mode)).toBeDisabled();
      await expect(form.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(form).toBeVisible();
      await form.getByRole('button', { name: 'Retry same submission', exact: true }).click();
      await expect.poll(() => receipts.length).toBe(2);
      await expect(form.getByRole('button', { name: 'Check result', exact: true })).toBeVisible();
      expect(executions).toHaveLength(2);
      expect(executions[1]).toEqual(executions[0]);
      expect(executions[0]).toEqual({
        command: app.inventory[mode],
        commandVersion: 1,
        key: { id },
        expectedVersion: 0,
        idempotencyKey: expect.any(String),
        input: mode === 'reserve' ? { lead: app.rows.north.work, reason } : { reason },
      });
      expect(receipts[0].replayed).toBe(false);
      expect(receipts[1]).toMatchObject({
        status: 'applied',
        receiptId: receipts[0].receiptId,
        result: receipts[0].result,
        replayed: true,
      });
      expect(stored(app)).toEqual(once);
      const checked = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/commands/status');
      await form.getByRole('button', { name: 'Check result', exact: true }).click();
      await expect(form.getByRole('status')).toHaveAttribute('data-phase', 'success');
      const response = await checked;
      expect(response.status()).toBe(200);
      // Status intentionally differs in replay metadata; compare stable fields.
      expect(await response.json()).toMatchObject({
        status: 'applied',
        receiptId: receipts[0].receiptId,
        result: receipts[0].result,
        replayed: true,
      });
      expect(statuses).toEqual([executions[0]]);
      expect(stored(app)).toEqual(once);
      expect((await query(page, app, owner, app.inventory.history)).find((row) => row.id === receipts[0].result.historyId)).toMatchObject({
        reason,
      });
      await done(page, form);
      await historyNavigation(page, receipts[0], mode, reason);
      expect(executions).toHaveLength(2);
      expect(stored(app)).toEqual(once);
    });

  for (const role of ['member', 'viewer'] as const)
    test(`${role} reads inventory and reservations without reserve or release actions`, async ({ page }) => {
      const owner = await enter(page, app, role);
      const before = stored(app);
      expect((await query(page, app, owner, app.inventory.vehicle)).map((row) => row.id)).not.toContain(
        app.inventoryRows.north.otherVehicle,
      );
      expect((await query(page, app, owner, app.model.work)).map((row) => row.id)).toEqual([app.rows.north.work]);
      await openVehicle(page);
      await expect(page.getByRole('button', { name: app.inventory.reserveAction, exact: true })).toHaveCount(0);
      await follow(page, `/${app.appId}/${app.inventory.reservation}?tenant=northstar`);
      await recordName(page, 'Northstar reservation').click();
      await expect(page.getByRole('heading', { name: 'Northstar reservation', exact: true })).toBeVisible();
      await noGenericActions(page);
      await expect(page.getByRole('button', { name: app.inventory.releaseAction, exact: true })).toHaveCount(0);
      expect((await query(page, app, owner, app.inventory.reservation)).map((row) => row.id)).toContain(
        app.inventoryRows.north.reservation,
      );
      for (const [mode, id] of [
        ['reserve', app.inventoryRows.north.vehicle],
        ['release', app.inventoryRows.north.reservation],
      ] as const) {
        const response = await call(page, app, await selectedLease(page, owner), '/api/commands/prepare', {
          command: app.inventory[mode],
          commandVersion: 1,
          key: { id },
        });
        expect([403, 404]).toContain(response.status());
        expect(await response.text()).not.toMatch(/Northstar manager|Riverview|expectedVersion/);
        expect(stored(app)).toEqual(before);
      }
    });

  /* One change per navigation path, not two. The `reserve`/`release` axis
     drives genuinely different UI — one opens a vehicle, the other walks to a
     reservation record — so both stay. The `inactive`/`wrong role` axis
     changed exactly one line and every assertion after it was identical, and
     the node suite loops a superset of it (`test/tenant-inventory.test.ts`)
     over the same HTTP, with before/after evidence. Ten seconds for a second
     spelling of one refusal. */
  for (const mode of ['reserve', 'release'] as const)
    test(`current manager becoming inactive after ${mode} prepare has no inventory or journal effects`, async ({ page }) => {
      const change = 'inactive' as const;
      await enter(page, app);
      const id = mode === 'reserve' ? app.inventoryRows.north.vehicle : app.inventoryRows.north.reservation;
      if (mode === 'reserve') await openVehicle(page);
      else {
        await follow(page, `/${app.appId}/${app.inventory.reservation}?tenant=northstar`);
        await recordName(page, 'Northstar reservation').click();
        await expect(page.getByRole('heading', { name: 'Northstar reservation', exact: true })).toBeVisible();
      }
      const form = await prepare(page, app, mode, id, 0);
      await fill(page, form, mode, 'Prepared before manager changed');
      const before = stored(app);
      await app.setStaffState(app.assignmentRows.north.manager, change === 'inactive' ? { active: 0 } : { role: 'clerk' });
      const executed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/commands/execute');
      await form.getByRole('button', { name: action(app, mode), exact: true }).click();
      const response = await executed;
      expect(response.status()).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'forbidden', outcome: 'not_applied' });
      await expect(form.getByRole('button', { name: 'Refresh and review', exact: true })).toBeVisible();
      await expect(form.getByRole('button', { name: 'Retry same submission', exact: true })).toHaveCount(0);
      expect(stored(app)).toEqual(before);
    });

  for (const change of ['closed', 'moved'] as const)
    test(`lead ${change} after prepare refuses reservation without effects`, async ({ page }) => {
      const owner = await enter(page, app);
      await openVehicle(page);
      const form = await prepare(page, app, 'reserve', app.inventoryRows.north.vehicle, 0);
      await fill(page, form, 'reserve', 'Prepared before lead changed');
      const edited = await call(page, app, await selectedLease(page, owner), '/api/update', {
        table: app.model.work,
        key: { id: app.rows.north.work },
        values: change === 'closed' ? { status: 'closed' } : { location_id: app.rows.north.otherUnit },
      });
      expect(edited.status()).toBe(200);
      expect((await query(page, app, owner, app.model.work)).find((row) => row.id === app.rows.north.work)).toMatchObject(
        change === 'closed' ? { status: 'closed' } : { location_id: app.rows.north.otherUnit },
      );
      const before = stored(app);
      const executed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/commands/execute');
      await form.getByRole('button', { name: app.inventory.reserveAction, exact: true }).click();
      const response = await executed;
      expect(response.status()).toBe(change === 'closed' ? 409 : 403);
      expect(await response.json()).toMatchObject({ code: change === 'closed' ? 'ineligible_state' : 'forbidden', outcome: 'not_applied' });
      await expect(form.getByRole('button', { name: 'Refresh and review', exact: true })).toBeVisible();
      await expect(form.getByRole('button', { name: 'Retry same submission', exact: true })).toHaveCount(0);
      expect(stored(app)).toEqual(before);
    });

  test('a visible open lead in another granted unit is selectable but cannot reserve this vehicle', async ({ page }) => {
    await enter(page, app);
    await openVehicle(page);
    const form = await prepare(page, app, 'reserve', app.inventoryRows.north.vehicle, 0);
    await fill(page, form, 'reserve', 'Wrong unit despite readable lead', 'Northstar hidden work');
    const before = stored(app),
      executed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/commands/execute');
    await form.getByRole('button', { name: app.inventory.reserveAction, exact: true }).click();
    const response = await executed;
    expect(response.request().postDataJSON().input.lead).toBe(app.rows.north.otherWork);
    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'forbidden', outcome: 'not_applied' });
    await expect(form.getByRole('button', { name: 'Refresh and review', exact: true })).toBeVisible();
    expect(stored(app)).toEqual(before);
  });

  test('an invisible malformed active reservation refuses through the database index and rolls back availability', async ({ page }) => {
    const owner = await enter(page, app);
    expect((await query(page, app, owner, app.inventory.reservation)).map((row) => row.id)).not.toContain(
      app.inventoryRows.north.hiddenReservation,
    );
    await openVehicle(page, 'Northstar hidden-reservation vehicle');
    const form = await prepare(page, app, 'reserve', app.inventoryRows.north.hiddenReservationVehicle, 0);
    await fill(page, form, 'reserve', 'Must roll back hidden active conflict');
    const before = stored(app);
    expect(before.reservations.find((row) => row.id === app.inventoryRows.north.hiddenReservation)).toMatchObject({
      vehicle_id: app.inventoryRows.north.hiddenReservationVehicle,
      location_id: app.inventoryRows.north.hiddenUnit,
      status: 'active',
    });
    const executed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/commands/execute');
    await form.getByRole('button', { name: app.inventory.reserveAction, exact: true }).click();
    const response = await executed;
    expect(response.status()).toBe(503);
    const failure = await response.json();
    expect(failure).toMatchObject({ code: 'temporarily_unavailable', outcome: 'not_applied' });
    expect(JSON.stringify(failure)).not.toMatch(/northstar-private|Northstar private|northstar-hidden-reservation|UNIQUE|physical_/);
    await expect(form.getByRole('button', { name: 'Refresh and review', exact: true })).toBeVisible();
    await expect(form.getByRole('button', { name: 'Retry same submission', exact: true })).toHaveCount(0);
    expect(stored(app)).toEqual(before);
  });

  test('manager generic writes cannot change inventory state or managed lead ownership', async ({ page }) => {
    const owner = await enter(page, app),
      before = stored(app);
    const leads = rows(app.database, 'SELECT * FROM physical_lead ORDER BY id');
    for (const data of [
      { table: app.inventory.vehicle, key: { id: app.inventoryRows.north.vehicle }, values: { status: 'reserved', version: 1 } },
      { table: app.inventory.reservation, key: { id: app.inventoryRows.north.reservation }, values: { status: 'released', version: 1 } },
      { table: app.model.work, key: { id: app.rows.north.work }, values: { tenant_id: 'riverview' } },
    ]) {
      const response = await call(page, app, await selectedLease(page, owner), '/api/update', data);
      expect(response.status()).toBeGreaterThanOrEqual(400);
      expect(response.status()).toBeLessThan(500);
      expect(stored(app)).toEqual(before);
      expect(rows(app.database, 'SELECT * FROM physical_lead ORDER BY id')).toEqual(leads);
    }
    expect(
      await query(page, app, owner, app.inventory.vehicle, {
        filter: { groups: [[{ column: 'id', op: '=', value: app.inventoryRows.south.vehicle }]] },
      }),
    ).toEqual([]);
    expect(
      await query(page, app, owner, app.model.work, {
        filter: { groups: [[{ column: 'id', op: '=', value: app.inventoryRows.north.hiddenLead }]] },
      }),
    ).toEqual([]);
  });
});
