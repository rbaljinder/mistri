import type { Response } from '@playwright/test';
import { isSelection, selectionRoute } from './support/tenantSelection.js';
import { test, expect, invitationArtifactOptions, type Page } from './support/invitationTest.js';
import { startTenantInvitations, type TenantInvitationFixture } from './support/tenantInvitationServer.js';
import {
  INVITATION_HTTP_ROOT as root,
  INVITATION_HTTP_HEADER as contextHeader,
  type InvitationAttempt,
} from '../packages/mistri/src/shared/tenantInvitations.js';
import { ADMINISTRATION_HTTP_ROOT, ADMINISTRATION_HTTP_HEADER } from '../packages/mistri/src/shared/tenantAdministration.js';
import { TENANT_HTTP_HEADERS as headers } from '../packages/mistri/src/shared/tenantContext.js';
import { captureResponse } from './support/responseCapture.js';

test.use(invitationArtifactOptions);
test.setTimeout(60_000);
const modal = (page: Page) => page.getByRole('dialog', { name: 'Manage invitations', exact: true });
// Bodies are captured before the page can navigate away from them; the
// status-only waits below (held tenant open, denial, sign-out) stay on
// waitForResponse, whose status is recorded when the response arrives.
const responseAt = (page: Page, path: string) => captureResponse(page, `${root}/${path}`, { timeout: 45_000 });
const identity = (app: TenantInvitationFixture) => ({
  origin: app.origin,
  [headers.app]: app.appId,
  [headers.account]: app.accounts.operator.id,
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function login(page: Page, app: TenantInvitationFixture) {
  await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
  await page.goto(`${app.origin}/${app.appId}`);
  await page.getByLabel('Email', { exact: true }).fill(app.accounts.operator.email);
  await page.getByLabel('Password', { exact: true }).fill(app.accounts.operator.password);
  // The account control can mount under the pointer or gain restored focus
  // before the chooser assertion finishes. Capture before sign-in mounts it.
  const opened = await responseAt(page, 'open-issuer');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Choose a tenant', exact: true })).toBeVisible({ timeout: 45_000 });
  // The issuer opens when the account menu is reached for, not with the shell (AccountControl.tsx).
  await page.getByRole('button', { name: /^Account:/ }).hover();
  const response = await opened();
  expect(response.status()).toBe(200);
  return response;
}

async function post(page: Page, app: TenantInvitationFixture, operation: string, data: unknown, context?: string) {
  const response = await page.request.post(`${app.origin}${root}/${operation}?app=${app.appId}`, {
    headers: { ...identity(app), ...(context ? { [contextHeader]: context } : {}) },
    data,
    timeout: 45_000,
  });
  expect(response.status()).toBe(200);
  return response.json();
}

/** Grant no synthetic business authority: the actual issuer issues to itself,
 * then its native recipient session previews and accepts the real invitation. */
/* The accepted membership is the account's only one, so the reload enters it without a click; a test that holds
   or watches that selection sets it up in `beforeReload`. */
async function selfMemberChooser(page: Page, app: TenantInvitationFixture, beforeReload?: () => Promise<void>) {
  await login(page, app);
  const opened = await post(page, app, 'open-issuer', {});
  const issued = await post(
    page,
    app,
    'execute',
    {
      idempotencyKey: 'self-issue',
      intent: {
        operation: 'issueInvitation',
        tenantId: 'north',
        expectedTenantVersion: '1',
        accountId: app.accounts.operator.id,
        roles: ['reader'],
        redeemUntil: Date.now() + 600_000,
        validUntil: Date.now() + 1_800_000,
      },
    },
    opened.session.context,
  );
  const recipient = await post(page, app, 'open-recipient', { invitationId: issued.result.change.after.invitation.invitationId });
  const preview = await post(page, app, 'preview', { token: issued.token }, recipient.session.context);
  const accepted = await post(
    page,
    app,
    'execute',
    { idempotencyKey: 'self-accept', intent: preview.preview.intent, token: issued.token },
    recipient.session.context,
  );
  expect(accepted.result.status).toBe('accepted');
  const fresh = await responseAt(page, 'open-issuer');
  await beforeReload?.();
  await page.reload();
  await page.getByRole('button', { name: /^Account:/ }).hover({ timeout: 45_000 });
  expect((await fresh()).status()).toBe(200);
  expect(app.snapshot().memberships.map((member) => member.status)).toEqual(['active']);
  return accepted.result as { membershipId: string; membershipVersion: string };
}

async function reviewIssue(page: Page, app: TenantInvitationFixture) {
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Manage invitations', exact: true }).click();
  await modal(page)
    .getByRole('region', { name: 'Invitation targets', exact: true })
    .getByRole('button', { name: 'north active', exact: true })
    .click();
  const editor = modal(page).getByRole('region', { name: 'Invitations for north', exact: true });
  await editor.getByRole('button', { name: 'Issue invitation', exact: true }).click();
  await editor.getByLabel('Native account ID', { exact: true }).fill(app.accounts.target.id);
  await editor.getByRole('checkbox', { name: 'Reader', exact: true }).check();
  await editor.getByRole('button', { name: 'Review change', exact: true }).click();
  await expect(modal(page).getByRole('region', { name: 'Review invitation change', exact: true })).toBeVisible();
}

async function loseIssueReply(page: Page) {
  const executions: InvitationAttempt[] = [];
  let receiptId = '',
    context = '';
  await page.route(`**${root}/execute?*`, async (route) => {
    executions.push(route.request().postDataJSON());
    context = route.request().headers()[contextHeader];
    const response = await route.fetch({ maxRetries: 0, timeout: 45_000 });
    expect(response.status()).toBe(200);
    receiptId = (await response.json()).result.receiptId;
    await route.abort('failed');
  });
  await modal(page).getByRole('button', { name: 'Issue invitation', exact: true }).click();
  await expect(modal(page).getByRole('alert')).toContainText('unconfirmed', { timeout: 45_000 });
  expect(executions).toHaveLength(1);
  await expect(modal(page).getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
  return { executions, receiptId, context, attempt: executions[0] };
}

async function recover(page: Page, app: TenantInvitationFixture, lost: Awaited<ReturnType<typeof loseIssueReply>>) {
  await expect(modal(page).getByRole('region', { name: 'Review invitation change', exact: true })).toContainText(
    lost.attempt.idempotencyKey,
  );
  const checked = await responseAt(page, 'status');
  await modal(page).getByRole('button', { name: 'Check attempt status', exact: true }).click();
  const response = await checked();
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toEqual(lost.attempt);
  expect(response.headers()[contextHeader]).toBe(lost.context);
  expect(response.headers()[headers.account]).toBe(app.accounts.operator.id);
  const body = await response.json();
  expect(body).toMatchObject({ status: 'completed', outcome: 'applied', result: { receiptId: lost.receiptId, replayed: true } });
  expect(body.token).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain('twi1.');
  await expect(modal(page)).toContainText('The original token cannot be recovered');
  expect(lost.executions).toHaveLength(1);
}

test('unknown invitation survives a held real business selection for the same native account', async ({ page }) => {
  const app = await startTenantInvitations();
  const release = gate(),
    committed = gate();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    let selected!: Promise<Response>;
    await selfMemberChooser(page, app, async () => {
      await page.route(selectionRoute, async (route) => {
        const response = await route.fetch({ maxRetries: 0, timeout: 45_000 });
        expect(response.status()).toBe(200);
        committed.release();
        await release.promise;
        await route.fulfill({ response });
      });
      selected = page.waitForResponse(isSelection, { timeout: 45_000 });
    });
    // The sole membership's selection, made as the page loaded, is held after it committed.
    // A sole member is never shown the chooser while it is entered, held or not.
    await committed.promise;
    await expect(page.getByRole('list', { name: 'Available tenants' })).toHaveCount(0);
    await reviewIssue(page, app);
    const lost = await loseIssueReply(page);
    expect(app.snapshot().receipts).toHaveLength(3);
    release.release();
    expect((await selected).status()).toBe(200);
    // The modal hides background controls from accessibility, so inspect the
    // mounted business DOM to prove the transition has actually completed.
    await expect(page.locator('.tenant-control-host')).toContainText('Tenant: north', { timeout: 45_000 });
    await expect(page.locator('#content')).toContainText('Private north business row', { timeout: 45_000 });
    await expect(modal(page).getByRole('alert')).toContainText('unconfirmed');
    await recover(page, app, lost);
    expect(app.snapshot().receipts).toHaveLength(3);
    await modal(page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Tenant: north/ })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    release.release();
    await page.unrouteAll({ behavior: 'wait' });
    await app.stop();
  }
});

test('unknown invitation remains recoverable after real membership revocation denies the selected business lease', async ({ page }) => {
  const app = await startTenantInvitations({ administration: true });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const self = await selfMemberChooser(page, app);
    await expect(page.locator('#content')).toContainText('Private north business row', { timeout: 45_000 });
    await reviewIssue(page, app);
    const lost = await loseIssueReply(page);
    const opened = await page.request.post(`${app.origin}${ADMINISTRATION_HTTP_ROOT}/open?app=${app.appId}`, {
      headers: identity(app),
      data: {},
      timeout: 45_000,
    });
    expect(opened.status()).toBe(200);
    const context = (await opened.json()).session.context;
    const revoked = await page.request.post(`${app.origin}${ADMINISTRATION_HTTP_ROOT}/execute?app=${app.appId}`, {
      headers: { ...identity(app), [ADMINISTRATION_HTTP_HEADER]: context },
      timeout: 45_000,
      data: {
        idempotencyKey: 'revoke-self-membership',
        intent: {
          operation: 'revokeMembership',
          tenantId: 'north',
          expectedTenantVersion: '1',
          membershipId: self.membershipId,
          expectedMembershipVersion: self.membershipVersion,
        },
      },
    });
    expect(revoked.status()).toBe(200);
    const denied = page.waitForResponse(
      (response) => new URL(response.url()).pathname.startsWith('/api/tenant/context/') && response.status() === 403,
      { timeout: 45_000 },
    );
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect((await denied).status()).toBe(403);
    await expect(page.locator('#content')).not.toContainText('Private north business row', { timeout: 45_000 });
    await expect(page.locator('.tenant-control-host')).toHaveCount(0);
    await expect(modal(page).getByRole('alert')).toContainText('unconfirmed');
    await recover(page, app, lost);
    expect(app.snapshot().receipts).toHaveLength(4);
    await modal(page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Tenant access ended', exact: true })).toBeVisible();
    const discovery = await page.request.get(`${app.origin}/api/tenant/bootstrap?app=${app.appId}`, {
      headers: identity(app),
      timeout: 45_000,
    });
    expect(discovery.status()).toBe(200);
    expect((await discovery.json()).memberships).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await app.stop();
  }
});

for (const phase of ['unknown', 'handoff'] as const)
  test(`actual sign-out and same-account relogin clear ${phase} UI and reject its old invitation context`, async ({ page }) => {
    const app = await startTenantInvitations();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const other = await page.context().newPage();
    other.on('pageerror', (error) => errors.push(error.message));
    try {
      await login(page, app);
      await reviewIssue(page, app);
      let attempt: InvitationAttempt, oldContext: string, receiptId: string;
      if (phase === 'unknown') {
        const lost = await loseIssueReply(page);
        ({ attempt, context: oldContext, receiptId } = lost);
      } else {
        const executed = await responseAt(page, 'execute');
        await modal(page).getByRole('button', { name: 'Issue invitation', exact: true }).click();
        const response = await executed();
        expect(response.status()).toBe(200);
        attempt = response.request().postDataJSON();
        oldContext = response.headers()[contextHeader];
        receiptId = (await response.json()).result.receiptId;
        await expect(modal(page).getByLabel('One-time invitation token', { exact: true })).toBeVisible();
      }
      // A genuine second tab shares native cookies, and uses the real sign-out
      // menu. The first tab neither calls a lock helper nor fabricates WHOAMI.
      await other.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
      await other.goto(`${app.origin}/${app.appId}`);
      await expect(other.getByRole('heading', { name: 'Choose a tenant', exact: true })).toBeVisible({ timeout: 45_000 });
      await other.getByRole('button', { name: /^Account:/ }).click();
      const signedOut = other.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/sign-out', { timeout: 45_000 });
      await other.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
      expect((await signedOut).status()).toBe(200);
      // The tab that signed out reloads itself to the sign-in form. Closing it
      // while that reload commits could leave page.close() waiting for good —
      // the 60 s timeout on a two-core runner, reproduced at 6x CPU throttling.
      await expect(other.getByLabel('Password', { exact: true })).toBeVisible({ timeout: 45_000 });
      await expect(modal(page)).toHaveCount(0, { timeout: 45_000 });
      await expect(page.getByLabel('One-time invitation token', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Review invitation change', exact: true })).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(app.accounts.target.id);
      const native = await page.request.get(`${app.origin}/api/whoami?app=${app.appId}`, { timeout: 45_000 });
      expect((await native.json()).signedIn).toBe(false);
      await page.unrouteAll({ behavior: 'wait' });
      await other.close();
      const reopened = await login(page, app);
      const freshContext = reopened.headers()[contextHeader];
      expect(freshContext).not.toBe(oldContext);
      const stale = await page.request.post(`${app.origin}${root}/status?app=${app.appId}`, {
        headers: { ...identity(app), [contextHeader]: oldContext },
        data: attempt,
        timeout: 45_000,
      });
      expect(stale.status()).toBeGreaterThanOrEqual(400);
      expect(await stale.json()).toMatchObject({ code: 'tenant_invitation_unavailable', outcome: 'unknown' });
      const recovered = await post(page, app, 'status', attempt, freshContext);
      expect(recovered).toMatchObject({ status: 'completed', outcome: 'applied', result: { receiptId, replayed: true } });
      expect(JSON.stringify(recovered)).not.toContain('twi1.');
      await page.getByRole('button', { name: /^Account:/ }).click();
      await page.getByRole('menuitem', { name: 'Manage invitations', exact: true }).click();
      await expect(modal(page).getByRole('region', { name: 'Invitation targets', exact: true })).toBeVisible();
      await expect(modal(page).getByRole('region', { name: 'Review invitation change', exact: true })).toHaveCount(0);
      await expect(modal(page).getByLabel('One-time invitation token', { exact: true })).toHaveCount(0);
      expect(app.snapshot().receipts).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      try {
        if (!other.isClosed()) await other.close();
        if (!page.isClosed()) await page.unrouteAll({ behavior: 'wait' });
      } finally {
        await app.stop();
      }
    }
  });
