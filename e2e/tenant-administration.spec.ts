import type { APIResponse, Response } from '@playwright/test';
import { isSelection, selectionRoute } from './support/tenantSelection.js';
import { test, expect, type Locator, type Page } from './support/harness.js';
import { administrationPolicy, startTenantAdministration, type TenantAdministrationFixture } from './support/tenantAdministrationServer.js';
import {
  ADMINISTRATION_HTTP_ROOT as root,
  ADMINISTRATION_HTTP_HEADER as contextHeader,
  ADMINISTRATION_OPERATIONS,
  type AdministrationAttempt,
  type AdministrationChange,
  type AdministrationIntent,
  type AdministrationMembershipImage,
  type AdministrationResult,
  type AdministrationSession,
  type AdministrationTenantImage,
} from '../packages/mistri/src/shared/tenantAdministration.js';
import { TENANT_HTTP_HEADERS as headers } from '../packages/mistri/src/shared/tenantContext.js';

type Fixture = TenantAdministrationFixture;
type Snapshot = ReturnType<Fixture['snapshot']>;
type Login = { session: AdministrationSession; nativeSessionId: string };
const modal = (page: Page) => page.getByRole('dialog', { name: 'Manage tenants', exact: true });
const editor = (page: Page) => modal(page).getByRole('region', { name: 'Manage north', exact: true });
const responseAt = (page: Page, route: string) =>
  page.waitForResponse((response) => new URL(response.url()).pathname === `${root}/${route}`);
const tenant = (status: AdministrationTenantImage['status'], version: string): AdministrationTenantImage => ({
  tenantId: 'north',
  status,
  version,
});

async function enter(page: Page, app: Fixture, role: 'operator' | 'outsider' = 'operator') {
  await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
  await page.goto(`${app.origin}/item`);
  await expect(page.getByRole('heading', { name: `Sign in to ${app.appName}`, exact: true })).toBeVisible();
  const account = app.accounts[role];
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  const signedIn = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/sign-in/email');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const native = await signedIn;
  expect(native.status()).toBe(200);
  const nativeSessionId = app.nativeSessionId(account.id);
  await expect(page.getByText('No available tenants. Contact your administrator for access.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Tenant:/ })).toHaveCount(0);
  expect(app.snapshot().memberships).toEqual([]);
  await expect(page.locator('body')).not.toContainText('Private north business row');
  // Administration opens when the account menu is reached for, not with the shell (AccountControl.tsx).
  const opened = responseAt(page, 'open');
  await page.getByRole('button', { name: /^Account:/ }).click();
  const response = await opened;
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(response.headers()[headers.account]).toBe(account.id);
  const session = (await response.json()).session as AdministrationSession | null;
  if (role === 'outsider') {
    expect(session).toBeNull();
    await expect(page.getByRole('menuitem', { name: 'Manage tenants', exact: true })).toHaveCount(0);
    return null;
  }
  expect(session).toEqual({
    appId: app.appId,
    accountId: account.id,
    context: expect.any(String),
    expiresAt: expect.any(Number),
    maxMembershipLifetimeMs: administrationPolicy.maxMembershipLifetimeMs,
  });
  const listed = responseAt(page, 'tenants');
  await page.getByRole('menuitem', { name: 'Manage tenants', exact: true }).click();
  const list = await listed;
  expect(list.status()).toBe(200);
  expect((await list.json()).page).toEqual({
    items: ['north', 'south'].map((tenantId) => ({
      tenantId,
      tenant: null,
      // The assistant's and decisions' switches are offered only where the App declares them, and a sandbox only
      // where it marks a resource clone; this one does none of these.
      capabilities: ADMINISTRATION_OPERATIONS.filter(
        (operation) =>
          operation !== 'setTenantAssistant' &&
          operation !== 'setTenantDecisions' &&
          operation !== 'cloneTenant' &&
          operation !== 'importTenant',
      ).map((operation) => ({
        operation,
        roles: ['manager', 'reader'],
      })),
    })),
    next: null,
  });
  await expect(modal(page)).toBeVisible();
  await modal(page)
    .getByRole('region', { name: 'Authorized tenants', exact: true })
    .getByRole('button', { name: 'north Not created', exact: true })
    .click();
  return { session: session!, nativeSessionId };
}

function owned(response: Response | APIResponse, app: Fixture, login: Login) {
  expect(response.status()).toBe(200);
  const actual = response.headers();
  expect(actual['cache-control']).toBe('no-store');
  expect(actual[headers.app]).toBe(app.appId);
  expect(actual[headers.account]).toBe(app.accounts.operator.id);
  expect(actual[contextHeader]).toBe(login.session.context);
  for (const name of [headers.tenant, headers.tab, headers.context, headers.revision]) expect(actual[name]).toBeUndefined();
}

async function review(page: Page, operation: string) {
  await editor(page).getByRole('button', { name: operation, exact: true }).click();
}

async function apply(page: Page, app: Fixture, login: Login, intent: AdministrationIntent, destructive = false) {
  await editor(page).getByRole('button', { name: 'Review change', exact: true }).click();
  const retained = modal(page).getByRole('region', { name: 'Review tenant change', exact: true });
  await expect(retained).toBeVisible();
  const executed = responseAt(page, 'execute'),
    listed = responseAt(page, 'tenants');
  await retained.getByRole('button', { name: destructive ? /^Confirm / : 'Apply change' }).click();
  const response = await executed;
  owned(response, app, login);
  const attempt = response.request().postDataJSON() as AdministrationAttempt;
  expect(attempt).toEqual({ idempotencyKey: expect.any(String), intent });
  expect(attempt.idempotencyKey.length).toBeGreaterThan(0);
  const body = await response.json();
  expect(body).toEqual({ outcome: 'applied', result: expect.any(Object) });
  owned(await listed, app, login);
  await expect(modal(page).getByRole('status')).toContainText('Change confirmed.');
  await expect(modal(page)).toContainText(`Receipt ${body.result.receiptId}`);
  await expect(modal(page).getByRole('region', { name: 'Review tenant change', exact: true })).toHaveCount(0);
  // Completion clears the selection and loads current authorized targets.
  await modal(page)
    .getByRole('region', { name: 'Authorized tenants', exact: true })
    .getByRole('button', { name: /^north / })
    .click();
  return { attempt, result: body.result as AdministrationResult };
}

/** Compare complete rows and both images, retaining all preceding evidence.
 * Only server-generated identifiers/timestamps are taken from the receipt. */
function prove(
  app: Fixture,
  login: Login,
  before: Snapshot,
  attempt: AdministrationAttempt,
  result: AdministrationResult,
  change: AdministrationChange,
) {
  expect(result).toEqual({
    receiptId: expect.any(String),
    requestId: expect.any(String),
    completedAt: expect.any(String),
    change,
    replayed: false,
  });
  expect(new Date(result.completedAt).toISOString()).toBe(result.completedAt);
  const after = app.snapshot();
  expect(after.business).toEqual(before.business);
  const image = change.after.tenant;
  // Administration writes a tenant's row and a plain member's, never the
  // platform realm's reserved row or a support membership.
  const tenantRow = { id: image.tenantId, status: image.status, version: image.version, kind: 'tenant' };
  expect(after.tenants).toEqual(
    before.tenants.some((row) => row.id === image.tenantId)
      ? before.tenants.map((row) => (row.id === image.tenantId ? tenantRow : row))
      : [...before.tenants, tenantRow],
  );
  const member = change.after.membership;
  const membershipRow = member && {
    id: member.membershipId,
    tenant_id: member.tenantId,
    account_id: member.accountId,
    status: member.status,
    version: member.version,
    roles_json: JSON.stringify(member.roles),
    valid_until: member.validUntil,
    kind: 'member',
    parent_id: null,
    parent_version: null,
    platform_version: null,
  };
  expect(after.memberships).toEqual(
    !member
      ? before.memberships
      : before.memberships.some((row) => row.id === member.membershipId)
        ? before.memberships.map((row) => (row.id === member.membershipId ? membershipRow : row))
        : [...before.memberships, membershipRow],
  );
  expect(after.memberships.filter((row) => row.account_id === app.accounts.operator.id)).toEqual(
    before.memberships.filter((row) => row.account_id === app.accounts.operator.id),
  );
  expect(after.receipts).toEqual([
    ...before.receipts,
    {
      id: result.receiptId,
      actor_id: app.accounts.operator.id,
      tenant_id: attempt.intent.tenantId,
      operation: attempt.intent.operation,
      operation_version: 1,
      idempotency_key: attempt.idempotencyKey,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      result_json: JSON.stringify(change),
      request_id: result.requestId,
      completed_at: result.completedAt,
    },
  ]);
  expect(after.audit).toEqual([
    ...before.audit,
    {
      receipt_id: result.receiptId,
      policy_id: administrationPolicy.id,
      policy_version: administrationPolicy.version,
      deployment: before.audit[0]?.deployment ?? expect.any(String),
      session_id: login.nativeSessionId,
      change_json: JSON.stringify(change),
    },
  ]);
  return after;
}

async function chooseMembership(
  page: Page,
  app: Fixture,
  operation: 'replaceMembership' | 'revokeMembership',
  member: AdministrationMembershipImage,
) {
  const listed = responseAt(page, 'memberships');
  await review(page, operation === 'replaceMembership' ? 'Replace membership' : 'Revoke membership');
  const response = await listed;
  expect(response.status()).toBe(200);
  expect(new URL(response.url()).searchParams.get('operation')).toBe(operation);
  expect((await response.json()).page).toEqual({
    tenant: tenant('active', '3'),
    operation,
    roles: ['manager', 'reader'],
    items: [member],
    next: null,
  });
  const memberships = editor(page).getByRole('region', { name: 'Authorized memberships', exact: true });
  await memberships.getByRole('button', { name: new RegExp(`^${app.accounts.target.id} `) }).click();
}

async function expiry(form: Locator, value: number) {
  // Pin an absolute expiry in the browser's UTC test timezone. Review/dispatch
  // must preserve the exact milliseconds, including during status recovery.
  // Chromium normalizes fractional trailing zeroes; Playwright fill requires
  // its canonical representation (for example .990 becomes .99).
  const local = new Date(value)
    .toISOString()
    .slice(0, -1)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
  await form.getByLabel('Valid until (local time)', { exact: true }).fill(local);
}

async function fits(page: Page) {
  expect(
    await modal(page).evaluate((node) => {
      const box = node.getBoundingClientRect();
      return (
        box.left >= 0 &&
        box.right <= innerWidth &&
        box.top >= 0 &&
        box.bottom <= innerHeight &&
        document.documentElement.scrollWidth <= innerWidth
      );
    }),
  ).toBe(true);
}

/* The operator's one membership is entered as the page reloads (a sole membership skips the chooser), so a
   test that holds or watches that selection sets it up in `beforeReload`. */
async function selfMemberChooser(page: Page, app: Fixture, beforeReload?: () => Promise<void>): Promise<Login> {
  const login = (await enter(page, app))!;
  await review(page, 'Create tenant');
  await apply(page, app, login, { operation: 'createTenant', tenantId: 'north' });
  await review(page, 'Grant membership');
  await editor(page).getByLabel('Native account ID', { exact: true }).fill(app.accounts.operator.id);
  await editor(page).getByRole('checkbox', { name: 'Reader', exact: true }).check();
  const validUntil = Date.now() + 1_800_000;
  await expiry(editor(page), validUntil);
  await apply(page, app, login, {
    operation: 'grantMembership',
    tenantId: 'north',
    expectedTenantVersion: '1',
    accountId: app.accounts.operator.id,
    roles: ['reader'],
    validUntil,
  });
  await modal(page).getByRole('button', { name: 'Close', exact: true }).click();
  await beforeReload?.();
  await page.reload();
  const opened = responseAt(page, 'open');
  await page.getByRole('button', { name: /^Account:/ }).hover();
  const response = await opened;
  expect(response.status()).toBe(200);
  const session = (await response.json()).session as AdministrationSession;
  expect(session.accountId).toBe(app.accounts.operator.id);
  return { session, nativeSessionId: login.nativeSessionId };
}

async function reopen(page: Page) {
  await page.getByRole('button', { name: /^Account:/ }).click();
  const listed = responseAt(page, 'tenants');
  await page.getByRole('menuitem', { name: 'Manage tenants', exact: true }).click();
  expect((await listed).status()).toBe(200);
  await modal(page).getByRole('region', { name: 'Authorized tenants' }).getByRole('button', { name: 'north active', exact: true }).click();
}

function gate() {
  let release!: () => void;
  return {
    promise: new Promise<void>((done) => {
      release = done;
    }),
    release: () => release(),
  };
}

test.describe('native tenant administration browser integration', () => {
  test.use({ timezoneId: 'UTC' });
  test.setTimeout(90_000);
  let app: Fixture;
  test.beforeEach(async () => {
    app = await startTenantAdministration();
  });
  test.afterEach(async ({ page }) => {
    try {
      await page.unrouteAll({ behavior: 'wait' });
    } finally {
      await app?.stop();
    }
  });

  for (const width of [1440, 390])
    test(`zero-membership operator creates, suspends, reactivates, grants, replaces, revokes and closes at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const login = (await enter(page, app))!;
      let before = app.snapshot();
      expect(before.tenants).toEqual([]);
      expect(before.receipts).toEqual([]);
      expect(before.audit).toEqual([]);
      await review(page, 'Create tenant');
      let accepted = await apply(page, app, login, { operation: 'createTenant', tenantId: 'north' });
      before = prove(app, login, before, accepted.attempt, accepted.result, {
        operation: 'createTenant',
        before: null,
        after: { tenant: tenant('active', '1') },
      });
      await expect(editor(page)).toContainText('active · Tenant version 1');
      for (const [from, to, oldVersion, nextVersion] of [
        ['active', 'suspended', '1', '2'],
        ['suspended', 'active', '2', '3'],
      ] as const) {
        await review(page, 'Change tenant status');
        await editor(page).getByRole('radio', { name: to, exact: true }).check();
        accepted = await apply(page, app, login, {
          operation: 'setTenantStatus',
          tenantId: 'north',
          expectedTenantVersion: oldVersion,
          status: to,
        });
        before = prove(app, login, before, accepted.attempt, accepted.result, {
          operation: 'setTenantStatus',
          before: { tenant: tenant(from, oldVersion) },
          after: { tenant: tenant(to, nextVersion) },
        });
        await expect(editor(page)).toContainText(`${to} · Tenant version ${nextVersion}`);
        if (to === 'suspended') await expect(editor(page).getByRole('button', { name: 'Grant membership', exact: true })).toHaveCount(0);
      }
      await review(page, 'Grant membership');
      await editor(page).getByLabel('Native account ID', { exact: true }).fill(app.accounts.target.id);
      await editor(page).getByRole('checkbox', { name: 'Reader', exact: true }).check();
      const validUntil = Date.now() + 1_800_000;
      await expiry(editor(page), validUntil);
      accepted = await apply(page, app, login, {
        operation: 'grantMembership',
        tenantId: 'north',
        expectedTenantVersion: '3',
        accountId: app.accounts.target.id,
        roles: ['reader'],
        validUntil,
      });
      const membershipId = accepted.result.change.after.membership!.membershipId;
      expect(membershipId).toEqual(expect.any(String));
      const member: AdministrationMembershipImage = {
        membershipId,
        tenantId: 'north',
        accountId: app.accounts.target.id,
        status: 'active',
        version: '1',
        roles: ['reader'],
        validUntil,
      };
      before = prove(app, login, before, accepted.attempt, accepted.result, {
        operation: 'grantMembership',
        before: { tenant: tenant('active', '3') },
        after: { tenant: tenant('active', '3'), membership: member },
      });
      await chooseMembership(page, app, 'replaceMembership', member);
      await editor(page).getByRole('checkbox', { name: 'Reader', exact: true }).uncheck();
      await editor(page).getByRole('checkbox', { name: 'Manager', exact: true }).check();
      const replacementUntil = validUntil + 123_456;
      await expiry(editor(page), replacementUntil);
      accepted = await apply(page, app, login, {
        operation: 'replaceMembership',
        tenantId: 'north',
        expectedTenantVersion: '3',
        membershipId,
        expectedMembershipVersion: '1',
        roles: ['manager'],
        validUntil: replacementUntil,
      });
      const replacement = { ...member, version: '2', roles: ['manager'], validUntil: replacementUntil };
      before = prove(app, login, before, accepted.attempt, accepted.result, {
        operation: 'replaceMembership',
        before: { tenant: tenant('active', '3'), membership: member },
        after: { tenant: tenant('active', '3'), membership: replacement },
      });
      await chooseMembership(page, app, 'revokeMembership', replacement);
      accepted = await apply(
        page,
        app,
        login,
        { operation: 'revokeMembership', tenantId: 'north', expectedTenantVersion: '3', membershipId, expectedMembershipVersion: '2' },
        true,
      );
      const revoked = { ...replacement, version: '3', status: 'revoked' as const };
      before = prove(app, login, before, accepted.attempt, accepted.result, {
        operation: 'revokeMembership',
        before: { tenant: tenant('active', '3'), membership: replacement },
        after: { tenant: tenant('active', '3'), membership: revoked },
      });
      const roster = responseAt(page, 'memberships');
      await review(page, 'Revoke membership');
      // The actionable roster excludes revoked rows; the retained tombstone and
      // exact revocation image were proved directly above.
      expect((await (await roster).json()).page.items).toEqual([]);
      await expect(editor(page).getByRole('region', { name: 'Authorized memberships' })).toContainText(
        'No authorized memberships on this page.',
      );
      await review(page, 'Change tenant status');
      await editor(page).getByRole('radio', { name: 'closed', exact: true }).check();
      accepted = await apply(
        page,
        app,
        login,
        { operation: 'setTenantStatus', tenantId: 'north', expectedTenantVersion: '3', status: 'closed' },
        true,
      );
      prove(app, login, before, accepted.attempt, accepted.result, {
        operation: 'setTenantStatus',
        before: { tenant: tenant('active', '3') },
        after: { tenant: tenant('closed', '4') },
      });
      await expect(editor(page)).toContainText('closed · Tenant version 4');
      await expect(editor(page).getByRole('button', { name: 'Change tenant status', exact: true })).toHaveCount(0);
      await fits(page);
      await modal(page).getByRole('button', { name: 'Close', exact: true }).click();
      await expect(modal(page)).toHaveCount(0);
      await expect(page.getByText('No available tenants. Contact your administrator for access.', { exact: true })).toBeVisible();
    });

  for (const width of [1440, 390])
    test(`lost native grant reply retains exact attempt and blocks exit until status recovery at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const login = (await enter(page, app))!;
      await review(page, 'Create tenant');
      await apply(page, app, login, { operation: 'createTenant', tenantId: 'north' });
      const before = app.snapshot();
      await review(page, 'Grant membership');
      await editor(page).getByLabel('Native account ID', { exact: true }).fill(app.accounts.target.id);
      await editor(page).getByRole('checkbox', { name: 'Reader', exact: true }).check();
      const validUntil = Date.now() + 1_800_123;
      await expiry(editor(page), validUntil);
      await editor(page).getByRole('button', { name: 'Review change', exact: true }).click();
      const executions: AdministrationAttempt[] = [],
        committed: AdministrationResult[] = [];
      await page.route(`**${root}/execute?*`, async (route) => {
        executions.push(route.request().postDataJSON());
        const response = await route.fetch({ maxRetries: 0 });
        owned(response, app, login);
        committed.push((await response.json()).result);
        await route.abort('failed');
      });
      await modal(page).getByRole('button', { name: 'Apply change', exact: true }).click();
      await expect(modal(page).getByRole('alert')).toContainText('The change is unconfirmed.');
      expect(executions).toEqual([
        {
          idempotencyKey: expect.any(String),
          intent: {
            operation: 'grantMembership',
            tenantId: 'north',
            expectedTenantVersion: '1',
            accountId: app.accounts.target.id,
            roles: ['reader'],
            validUntil,
          },
        },
      ]);
      expect(committed).toHaveLength(1);
      const retained = modal(page).getByRole('region', { name: 'Review tenant change' });
      await expect(retained).toContainText(executions[0].idempotencyKey);
      await expect(retained).toContainText(new Date(validUntil).toISOString());
      await expect(modal(page).getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
      await expect(modal(page).getByRole('button', { name: 'Close tenant administration', exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(retained).toBeVisible();
      await fits(page);
      const originalURL = page.url();
      const warning = page.waitForEvent('dialog');
      const navigation = page.goto(`${app.origin}/`).catch((error) => String(error));
      const dialog = await warning;
      expect(dialog.type()).toBe('beforeunload');
      await dialog.dismiss();
      await navigation;
      expect(page.url()).toBe(originalURL);
      await expect(retained).toContainText(executions[0].idempotencyKey);
      const checked = responseAt(page, 'status'),
        listed = responseAt(page, 'tenants');
      await modal(page).getByRole('button', { name: 'Check attempt status', exact: true }).click();
      const response = await checked;
      owned(response, app, login);
      expect(response.request().postDataJSON()).toEqual(executions[0]);
      expect(await response.json()).toEqual({ status: 'completed', outcome: 'applied', result: { ...committed[0], replayed: true } });
      owned(await listed, app, login);
      await expect(modal(page).getByRole('status')).toContainText('Change confirmed.');
      const member: AdministrationMembershipImage = {
        membershipId: committed[0].change.after.membership!.membershipId,
        tenantId: 'north',
        accountId: app.accounts.target.id,
        status: 'active',
        version: '1',
        roles: ['reader'],
        validUntil,
      };
      prove(app, login, before, executions[0], committed[0], {
        operation: 'grantMembership',
        before: { tenant: tenant('active', '1') },
        after: { tenant: tenant('active', '1'), membership: member },
      });
      expect(executions).toHaveLength(1);
      await modal(page)
        .getByRole('region', { name: 'Authorized tenants', exact: true })
        .getByRole('button', { name: /^north / })
        .click();
      const roster = responseAt(page, 'memberships');
      await review(page, 'Replace membership');
      expect((await (await roster).json()).page.items).toEqual([member]);
      await expect(editor(page).getByRole('region', { name: 'Authorized memberships' })).toContainText(member.membershipId);
      await modal(page).getByRole('button', { name: 'Close', exact: true }).click();
      await expect(modal(page)).toHaveCount(0);
    });

  /* The only test here that draws nothing: it asserts a missing menu entry and
     a refused POST. The other four call fits() at both widths, so the phone
     still sees every management surface this file has. */
  test('nonoperator has no management capability and cannot execute', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const before = app.snapshot();
    await enter(page, app, 'outsider');
    await expect(modal(page)).toHaveCount(0);
    const denied = await page.request.post(`${app.origin}${root}/execute?app=${app.appId}`, {
      headers: {
        origin: app.origin,
        [headers.app]: app.appId,
        [headers.account]: app.accounts.outsider.id,
        [contextHeader]: 'forged-administration-context',
      },
      data: { idempotencyKey: 'outsider-create', intent: { operation: 'createTenant', tenantId: 'north' } },
    });
    expect(denied.status()).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'tenant_administration_unavailable', outcome: 'not_applied' });
    expect(await denied.text()).not.toMatch(/private_item|north|south|browser-operators|session_id/);
    expect(app.snapshot()).toEqual(before);
  });

  for (const width of [1440, 390])
    test(`held initial selection cannot erase an unknown administration attempt at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const releaseSelection = gate(),
        selectionCommitted = gate();
      let selectionDelivered!: Promise<Response>;
      const login = await selfMemberChooser(page, app, async () => {
        await page.route(selectionRoute, async (route) => {
          const response = await route.fetch({ maxRetries: 0 });
          expect(response.status()).toBe(200);
          selectionCommitted.release();
          await releaseSelection.promise;
          await route.fulfill({ response });
        });
        selectionDelivered = page.waitForResponse(isSelection);
      });
      try {
        // The sole membership's selection, made as the page loaded, is held after it committed.
        // A sole member is never shown the chooser while it is entered, held or not.
        await selectionCommitted.promise;
        await expect(page.getByRole('list', { name: 'Available tenants' })).toHaveCount(0);
        await reopen(page);
        await review(page, 'Grant membership');
        await editor(page).getByLabel('Native account ID', { exact: true }).fill(app.accounts.target.id);
        await editor(page).getByRole('checkbox', { name: 'Manager', exact: true }).check();
        const validUntil = Date.now() + 1_800_123;
        await expiry(editor(page), validUntil);
        await editor(page).getByRole('button', { name: 'Review change', exact: true }).click();
        const before = app.snapshot(),
          executions: AdministrationAttempt[] = [],
          committed: AdministrationResult[] = [];
        await page.route(`**${root}/execute?*`, async (route) => {
          executions.push(route.request().postDataJSON());
          const response = await route.fetch({ maxRetries: 0 });
          owned(response, app, login);
          committed.push((await response.json()).result);
          await route.abort('failed');
        });
        await modal(page).getByRole('button', { name: 'Apply change', exact: true }).click();
        await expect(modal(page).getByRole('alert')).toContainText('The change is unconfirmed.');
        expect(executions).toEqual([
          {
            idempotencyKey: expect.any(String),
            intent: {
              operation: 'grantMembership',
              tenantId: 'north',
              expectedTenantVersion: '1',
              accountId: app.accounts.target.id,
              roles: ['manager'],
              validUntil,
            },
          },
        ]);
        releaseSelection.release();
        expect((await selectionDelivered).status()).toBe(200);
        // Wait for the selected business surface to finish mounting; recovery must
        // survive that completed transition, not just the network delivery event.
        // The management modal correctly removes background controls from the
        // accessibility tree. Inspect the mounted tenant control's DOM instead.
        await expect(page.locator('.tenant-control-host')).toContainText('Tenant: north');
        await expect(page.locator('#content')).toContainText('Private north business row');
        await expect(modal(page).getByRole('region', { name: 'Review tenant change' })).toContainText(executions[0].idempotencyKey);
        await expect(modal(page).getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
        const checked = responseAt(page, 'status'),
          listed = responseAt(page, 'tenants');
        await modal(page).getByRole('button', { name: 'Check attempt status', exact: true }).click();
        const response = await checked;
        owned(response, app, login);
        expect(response.request().postDataJSON()).toEqual(executions[0]);
        expect(await response.json()).toEqual({ status: 'completed', outcome: 'applied', result: { ...committed[0], replayed: true } });
        owned(await listed, app, login);
        await expect(modal(page).getByRole('status')).toContainText('Change confirmed.');
        const member: AdministrationMembershipImage = {
          membershipId: committed[0].change.after.membership!.membershipId,
          tenantId: 'north',
          accountId: app.accounts.target.id,
          status: 'active',
          version: '1',
          roles: ['manager'],
          validUntil,
        };
        prove(app, login, before, executions[0], committed[0], {
          operation: 'grantMembership',
          before: { tenant: tenant('active', '1') },
          after: { tenant: tenant('active', '1'), membership: member },
        });
        expect(executions).toHaveLength(1);
        await modal(page).getByRole('button', { name: 'Close', exact: true }).click();
        await expect(modal(page)).toHaveCount(0);
      } finally {
        releaseSelection.release();
      }
    });

  for (const width of [1440, 390])
    test(`self-suspension with a lost reply recovers after business lease denial at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      let selected!: Promise<Response>;
      const login = await selfMemberChooser(page, app, async () => {
        selected = page.waitForResponse(isSelection);
      });
      expect((await selected).status()).toBe(200);
      await expect(page.locator('.tenant-control-host')).toContainText('Tenant: north');
      await expect(page.locator('#content')).toContainText('Private north business row');
      await reopen(page);
      await review(page, 'Change tenant status');
      await editor(page).getByRole('radio', { name: 'suspended', exact: true }).check();
      await editor(page).getByRole('button', { name: 'Review change', exact: true }).click();
      const before = app.snapshot(),
        executions: AdministrationAttempt[] = [],
        committed: AdministrationResult[] = [];
      await page.route(`**${root}/execute?*`, async (route) => {
        executions.push(route.request().postDataJSON());
        const response = await route.fetch({ maxRetries: 0 });
        owned(response, app, login);
        committed.push((await response.json()).result);
        await route.abort('failed');
      });
      await modal(page).getByRole('button', { name: 'Apply change', exact: true }).click();
      await expect(modal(page).getByRole('alert')).toContainText('The change is unconfirmed.');
      expect(executions).toEqual([
        {
          idempotencyKey: expect.any(String),
          intent: { operation: 'setTenantStatus', tenantId: 'north', expectedTenantVersion: '1', status: 'suspended' },
        },
      ]);
      // Exercise the actual foreground session/lease checks with the real host.
      const denied = page.waitForResponse(
        (response) => new URL(response.url()).pathname.startsWith('/api/tenant/context/') && response.status() === 403,
      );
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      expect((await denied).status()).toBe(403);
      await expect(page.locator('#content')).not.toContainText('Private north business row');
      await expect(page.locator('.tenant-control-host')).toHaveCount(0);
      await expect(modal(page).getByRole('region', { name: 'Review tenant change' })).toContainText(executions[0].idempotencyKey);
      await expect(modal(page).getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
      const checked = responseAt(page, 'status'),
        listed = responseAt(page, 'tenants');
      await modal(page).getByRole('button', { name: 'Check attempt status', exact: true }).click();
      const response = await checked;
      owned(response, app, login);
      expect(response.request().postDataJSON()).toEqual(executions[0]);
      expect(await response.json()).toEqual({ status: 'completed', outcome: 'applied', result: { ...committed[0], replayed: true } });
      const refreshed = await listed;
      owned(refreshed, app, login);
      expect((await refreshed.json()).page.items.find((item: { tenantId: string }) => item.tenantId === 'north').tenant).toEqual(
        tenant('suspended', '2'),
      );
      await expect(modal(page).getByRole('status')).toContainText('Change confirmed.');
      prove(app, login, before, executions[0], committed[0], {
        operation: 'setTenantStatus',
        before: { tenant: tenant('active', '1') },
        after: { tenant: tenant('suspended', '2') },
      });
      expect(executions).toHaveLength(1);
      await modal(page).getByRole('button', { name: 'Close', exact: true }).click();
      await expect(modal(page)).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Tenant access ended', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Reload and choose a tenant', exact: true })).toBeVisible();
      await expect(page.locator('#content')).not.toContainText('Private north business row');
    });
});
