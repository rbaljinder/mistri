// e2e-client: source — imports /sessionIdentity.ts from the page
import { test, expect, invitationArtifactOptions, type Page } from './support/invitationTest.js';
import { startTenantInvitations, type TenantInvitationFixture } from './support/tenantInvitationServer.js';
import { captureResponse } from './support/responseCapture.js';
import { INVITATION_HTTP_ROOT as root } from '../packages/mistri/src/shared/tenantInvitations.js';

test.use(invitationArtifactOptions);
test.setTimeout(60_000);

const dialog = (page: Page, issuer = true) =>
  page.getByRole('dialog', { name: issuer ? 'Manage invitations' : 'Accept invitation', exact: true });
const responseAt = (page: Page, path: string) => captureResponse(page, `${root}/${path}`);

async function login(page: Page, app: TenantInvitationFixture, role: keyof TenantInvitationFixture['accounts']) {
  const account = app.accounts[role];
  await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
  await page.goto(`${app.origin}/${app.appId}`);
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Choose a tenant', exact: true })).toBeVisible();
  // The issuer opens when the account menu is reached for, not with the shell (AccountControl.tsx).
  const opened = await responseAt(page, 'open-issuer');
  await page.getByRole('button', { name: /^Account:/ }).hover();
  expect((await opened()).status()).toBe(200);
}

async function manage(page: Page) {
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Manage invitations', exact: true }).click();
  await dialog(page)
    .getByRole('region', { name: 'Invitation targets', exact: true })
    .getByRole('button', { name: 'north active', exact: true })
    .click();
}

async function reviewIssue(page: Page, accountId: string) {
  const editor = dialog(page).getByRole('region', { name: 'Invitations for north', exact: true });
  await editor.getByRole('button', { name: 'Issue invitation', exact: true }).click();
  await editor.getByLabel('Native account ID', { exact: true }).fill(accountId);
  await editor.getByRole('checkbox', { name: 'Reader', exact: true }).check();
  await editor.getByRole('button', { name: 'Review change', exact: true }).click();
  await expect(dialog(page).getByRole('region', { name: 'Review invitation change', exact: true })).toBeVisible();
}

async function issue(page: Page, accountId: string): Promise<string> {
  await manage(page);
  await reviewIssue(page, accountId);
  const executed = await responseAt(page, 'execute');
  await dialog(page).getByRole('button', { name: 'Issue invitation', exact: true }).click();
  expect((await executed()).status()).toBe(200);
  const field = dialog(page).getByLabel('One-time invitation token', { exact: true });
  await expect(field).toBeVisible();
  const token = await field.inputValue();
  expect(token.startsWith('twi1.')).toBe(true);
  await dialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByLabel('One-time invitation token', { exact: true })).toHaveCount(0);
  return token;
}

async function preview(page: Page, token: string) {
  await page.getByRole('button', { name: /^Account:/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Manage invitations', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Accept invitation', exact: true }).click();
  await dialog(page, false).getByLabel('Invitation token', { exact: true }).fill(token);
  await dialog(page, false).getByRole('button', { name: 'Review invitation', exact: true }).click();
  await expect(dialog(page, false).getByRole('region', { name: 'Review invitation change', exact: true })).toBeVisible();
  await expect(dialog(page, false).getByText('Reader', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href })),
  ).not.toContain('twi1.');
}

for (const phone of [false, true])
  test(`account-bound invitation review and acceptance ${phone ? 'phone' : 'desktop'}`, async ({ browser }) => {
    const app = await startTenantInvitations();
    const viewport = phone ? { width: 390, height: 844 } : { width: 1280, height: 900 };
    const issuerContext = await browser.newContext({ viewport }),
      recipientContext = await browser.newContext({ viewport });
    const issuer = await issuerContext.newPage(),
      recipient = await recipientContext.newPage();
    const errors: string[] = [];
    issuer.on('pageerror', (e) => errors.push(e.message));
    recipient.on('pageerror', (e) => errors.push(e.message));
    try {
      await login(issuer, app, 'operator');
      const token = await issue(issuer, app.accounts.target.id);
      const pending = app.snapshot();
      expect(pending.memberships.map((m) => m.status)).toEqual(['invited']);
      expect(pending.invitations.map((i) => i.status)).toEqual(['pending']);
      expect(JSON.stringify(pending).includes(token)).toBe(false);
      await login(recipient, app, 'target');
      await expect(recipient.getByText('No available tenants. Contact your administrator for access.', { exact: true })).toBeVisible();
      await preview(recipient, token);
      expect(app.snapshot().memberships.map((m) => m.status)).toEqual(['invited']);
      if (phone) {
        const bounds = await dialog(recipient, false).boundingBox();
        expect(bounds?.width).toBeCloseTo(viewport.width, 0);
        expect(bounds?.height).toBeCloseTo(viewport.height, 0);
      }
      const accepted = await responseAt(recipient, 'execute');
      await dialog(recipient, false).getByRole('button', { name: 'Accept invitation', exact: true }).click();
      const response = await accepted();
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.result.status).toBe('accepted');
      expect(body.result.change).toBeUndefined();
      expect(body.token).toBeUndefined();
      await expect(dialog(recipient, false)).toContainText('Change confirmed.');
      await dialog(recipient, false).getByRole('button', { name: 'Close', exact: true }).click();
      await expect(recipient.getByRole('heading', { name: 'Choose a tenant', exact: true })).toBeVisible();
      await expect(recipient.getByRole('button', { name: 'north', exact: true })).toBeVisible();
      await expect(recipient.locator('body')).not.toContainText('Private north business row');
      const confirmed = app.snapshot();
      expect(confirmed.memberships.map((m) => m.status)).toEqual(['active']);
      expect(confirmed.invitations.map((i) => i.status)).toEqual(['accepted']);
      expect(confirmed.receipts).toHaveLength(2);
      expect(confirmed.audit).toHaveLength(2);
      expect(JSON.stringify(confirmed).includes(token)).toBe(false);
      await recipient.getByRole('button', { name: 'north', exact: true }).click();
      // The bar's control on a desk, the account menu's first item on a phone: its words are the same either way.
      await expect(recipient.locator('.tenant-control-host')).toContainText('Tenant: north');
      expect(errors).toEqual([]);
    } finally {
      await issuerContext.close();
      await recipientContext.close();
      await app.stop();
    }
  });

test('lost issuance handoff retains an exact attempt and status never regenerates its token', async ({ page }) => {
  const app = await startTenantInvitations();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await login(page, app, 'operator');
    await manage(page);
    await reviewIssue(page, app.accounts.target.id);
    let executed = 0;
    await page.route(`**${root}/execute*`, async (route) => {
      executed++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort('failed');
    });
    await dialog(page).getByRole('button', { name: 'Issue invitation', exact: true }).click();
    await expect(dialog(page).getByRole('alert')).toContainText('unconfirmed');
    await expect(dialog(page).getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeVisible();
    expect(app.snapshot().receipts).toHaveLength(1);
    const checked = await responseAt(page, 'status');
    await dialog(page).getByRole('button', { name: 'Check attempt status', exact: true }).click();
    const response = await checked();
    expect(response.status()).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain('twi1.');
    await expect(dialog(page)).toContainText('The original token cannot be recovered');
    await expect(dialog(page).getByLabel('One-time invitation token', { exact: true })).toHaveCount(0);
    expect(executed).toBe(1);
    expect(app.snapshot().receipts).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    await app.stop();
  }
});

test('lost acceptance acknowledgement recovers once and refreshes choices without another activation', async ({ browser }) => {
  const app = await startTenantInvitations();
  const issuerContext = await browser.newContext(),
    recipientContext = await browser.newContext();
  const issuer = await issuerContext.newPage(),
    recipient = await recipientContext.newPage();
  const errors: string[] = [];
  recipient.on('pageerror', (e) => errors.push(e.message));
  try {
    await login(issuer, app, 'operator');
    const token = await issue(issuer, app.accounts.target.id);
    await login(recipient, app, 'target');
    await preview(recipient, token);
    let executed = 0;
    await recipient.route(`**${root}/execute*`, async (route) => {
      executed++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort('failed');
    });
    await dialog(recipient, false).getByRole('button', { name: 'Accept invitation', exact: true }).click();
    await expect(dialog(recipient, false).getByRole('alert')).toContainText('unconfirmed');
    expect(app.snapshot().receipts).toHaveLength(2);
    await dialog(recipient, false).getByRole('button', { name: 'Check attempt status', exact: true }).click();
    await expect(dialog(recipient, false)).toContainText('Change confirmed.');
    await dialog(recipient, false).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(recipient.getByRole('button', { name: 'north', exact: true })).toBeVisible();
    expect(app.snapshot().receipts).toHaveLength(2);
    expect(executed).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await issuerContext.close();
    await recipientContext.close();
    await app.stop();
  }
});

test('issuer explicitly reissues and revokes a pending reservation from the account menu', async ({ page }) => {
  const app = await startTenantInvitations();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await login(page, app, 'operator');
    const oldToken = await issue(page, app.accounts.target.id);
    await manage(page);
    const editor = () => dialog(page).getByRole('region', { name: 'Invitations for north', exact: true });
    await editor().getByRole('button', { name: 'Reissue invitation', exact: true }).click();
    await editor()
      .getByRole('region', { name: 'Pending invitations', exact: true })
      .getByRole('button', { name: new RegExp(app.accounts.target.id) })
      .click();
    await editor().getByRole('button', { name: 'Review change', exact: true }).click();
    expect(app.snapshot().receipts).toHaveLength(1);
    const replaced = await responseAt(page, 'execute');
    await dialog(page).getByRole('button', { name: 'Reissue invitation', exact: true }).click();
    expect((await replaced()).status()).toBe(200);
    const field = dialog(page).getByLabel('One-time invitation token', { exact: true });
    await expect(field).toBeVisible();
    const newToken = await field.inputValue();
    expect(newToken === oldToken).toBe(false);
    const reissued = app.snapshot();
    expect(reissued.invitations.map((i) => i.status)).toEqual(['revoked', 'pending']);
    expect(reissued.memberships.map((m) => m.status)).toEqual(['revoked', 'invited']);
    expect(reissued.receipts).toHaveLength(2);
    await dialog(page).getByRole('button', { name: 'Close', exact: true }).click();
    await manage(page);
    await editor().getByRole('button', { name: 'Revoke invitation', exact: true }).click();
    await editor()
      .getByRole('region', { name: 'Pending invitations', exact: true })
      .getByRole('button', { name: new RegExp(app.accounts.target.id) })
      .click();
    await editor().getByRole('button', { name: 'Review change', exact: true }).click();
    const revoked = await responseAt(page, 'execute');
    await dialog(page).getByRole('button', { name: 'Revoke invitation', exact: true }).click();
    expect((await revoked()).status()).toBe(200);
    expect(app.snapshot().invitations.map((i) => i.status)).toEqual(['revoked', 'revoked']);
    expect(app.snapshot().memberships.map((m) => m.status)).toEqual(['revoked', 'revoked']);
    expect(app.snapshot().receipts).toHaveLength(3);
    expect(errors).toEqual([]);
  } finally {
    await app.stop();
  }
});

test('an authenticated wrong recipient cannot preview or accept another account invitation', async ({ browser }) => {
  const app = await startTenantInvitations();
  const issuerContext = await browser.newContext(),
    outsiderContext = await browser.newContext();
  const issuer = await issuerContext.newPage(),
    outsider = await outsiderContext.newPage();
  try {
    await login(issuer, app, 'operator');
    const token = await issue(issuer, app.accounts.target.id);
    await login(outsider, app, 'outsider');
    await outsider.getByRole('button', { name: /^Account:/ }).click();
    await outsider.getByRole('menuitem', { name: 'Accept invitation', exact: true }).click();
    await dialog(outsider, false).getByLabel('Invitation token', { exact: true }).fill(token);
    await dialog(outsider, false).getByRole('button', { name: 'Review invitation', exact: true }).click();
    await expect(dialog(outsider, false)).toContainText('The invitation could not be reviewed');
    await expect(dialog(outsider, false).getByRole('region', { name: 'Review invitation change', exact: true })).toHaveCount(0);
    await expect(dialog(outsider, false).getByLabel('Invitation token', { exact: true })).toHaveValue('');
    expect(app.snapshot().receipts).toHaveLength(1);
    expect(app.snapshot().memberships.map((m) => m.status)).toEqual(['invited']);
    await expect(dialog(outsider, false)).not.toContainText(app.accounts.target.id);
  } finally {
    await issuerContext.close();
    await outsiderContext.close();
    await app.stop();
  }
});

test('native retirement removes the one-time handoff and cannot reopen its old controller', async ({ page }) => {
  const app = await startTenantInvitations();
  try {
    await login(page, app, 'operator');
    await manage(page);
    await reviewIssue(page, app.accounts.target.id);
    await dialog(page).getByRole('button', { name: 'Issue invitation', exact: true }).click();
    await expect(dialog(page).getByLabel('One-time invitation token', { exact: true })).toBeVisible();
    await page.evaluate(async () => {
      const identity = await import('/sessionIdentity.ts');
      identity.lockSessionIdentity();
    });
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByLabel('One-time invitation token', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /^Account:/ }).click();
    await expect(page.getByRole('menuitem', { name: 'Manage invitations', exact: true })).toHaveCount(0);
    expect(app.snapshot().receipts).toHaveLength(1);
  } finally {
    await app.stop();
  }
});

async function issueByEmail(page: Page, email: string): Promise<string> {
  await manage(page);
  const editor = dialog(page).getByRole('region', { name: 'Invitations for north', exact: true });
  await editor.getByRole('button', { name: 'Issue invitation', exact: true }).click();
  await editor.getByRole('radio', { name: 'By email address', exact: true }).check();
  await editor.getByLabel('Email address', { exact: true }).fill(email);
  await editor.getByRole('checkbox', { name: 'Reader', exact: true }).check();
  await editor.getByRole('button', { name: 'Review change', exact: true }).click();
  await expect(dialog(page).getByRole('region', { name: 'Review invitation change', exact: true })).toContainText(email);
  const executed = await responseAt(page, 'execute');
  await dialog(page).getByRole('button', { name: 'Issue invitation', exact: true }).click();
  expect((await executed()).status()).toBe(200);
  const token = await dialog(page).getByLabel('One-time invitation token', { exact: true }).inputValue();
  expect(token.startsWith('twi1.')).toBe(true);
  await dialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  return token;
}

async function claimForm(page: Page, app: TenantInvitationFixture, token: string, name: string, password: string) {
  await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
  await page.goto(`${app.origin}/${app.appId}`);
  await page.getByRole('button', { name: 'Have an invitation? Create your account', exact: true }).click();
  await page.getByLabel('Invitation token', { exact: true }).fill(token);
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
}

test('an email invitation creates its account from the signed-out claim form, and the token works once', async ({ browser }) => {
  const app = await startTenantInvitations();
  const issuerContext = await browser.newContext(),
    claimContext = await browser.newContext();
  const issuer = await issuerContext.newPage(),
    claimant = await claimContext.newPage();
  const errors: string[] = [];
  issuer.on('pageerror', (e) => errors.push(e.message));
  claimant.on('pageerror', (e) => errors.push(e.message));
  try {
    await login(issuer, app, 'operator');
    const token = await issueByEmail(issuer, 'newcomer@example.test');
    const pending = app.snapshot();
    expect(pending.memberships.map((m) => [m.account_id, m.status])).toEqual([['email:newcomer@example.test', 'invited']]);
    expect(JSON.stringify(pending).includes(token)).toBe(false);

    await claimForm(claimant, app, token, 'Newcomer', 'disposable-newcomer-password');
    const claimed = await responseAt(claimant, 'claim');
    await claimant.getByRole('button', { name: 'Create account and join', exact: true }).click();
    const response = await claimed();
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.outcome).toBe('applied');
    expect(body.email).toBe('newcomer@example.test');
    expect(JSON.stringify(body)).not.toContain('twi1.');
    expect(JSON.stringify(body)).not.toContain('disposable-newcomer-password');
    expect(
      await claimant.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href })),
    ).not.toContain('twi1.');

    // Created and accepted, still signed out: signing in is the person's next step.
    await expect(claimant.getByText('Your account is ready. Sign in to continue.', { exact: true })).toBeVisible();
    await expect(claimant.getByLabel('Email', { exact: true })).toHaveValue('newcomer@example.test');
    await claimant.getByLabel('Password', { exact: true }).fill('disposable-newcomer-password');
    await claimant.getByRole('button', { name: 'Sign in', exact: true }).click();
    // The claimed membership is the account's only one: it is entered without the chooser.
    await expect(claimant.getByRole('button', { name: 'Tenant: north', exact: true })).toBeVisible();
    const confirmed = app.snapshot();
    expect(confirmed.invitations.map((i) => i.status)).toEqual(['revoked', 'accepted']);
    expect(confirmed.memberships.map((m) => m.status)).toEqual(['revoked', 'active']);
    expect(confirmed.receipts.map((r) => r.operation)).toEqual(['issueInvitation', 'claimInvitation']);

    // The token was the one-time handoff: claimed again, it reads as any unusable token.
    const again = await claimContext.request.post(`${app.origin}${root}/claim?app=${app.appId}`, {
      headers: { origin: app.origin, 'content-type': 'application/json' },
      data: { token, name: 'Someone else', password: 'another-disposable-password' },
    });
    expect(again.status()).toBe(403);
    expect(await again.json()).toEqual({
      error: 'The invitation operation could not be confirmed.',
      code: 'tenant_invitation_unavailable',
      outcome: 'not_applied',
    });
    expect(errors).toEqual([]);
  } finally {
    await issuerContext.close();
    await claimContext.close();
    await app.stop();
  }
});

test('an email invitation to an address with an account is refused to claim, then accepted signed in with the same token', async ({
  browser,
}) => {
  const app = await startTenantInvitations();
  const issuerContext = await browser.newContext(),
    recipientContext = await browser.newContext();
  const issuer = await issuerContext.newPage(),
    recipient = await recipientContext.newPage();
  try {
    await login(issuer, app, 'operator');
    const token = await issueByEmail(issuer, app.accounts.target.email);
    await claimForm(recipient, app, token, 'Target again', 'disposable-other-password');
    await recipient.getByRole('button', { name: 'Create account and join', exact: true }).click();
    await expect(recipient.getByRole('alert').filter({ hasText: /\S/ })).toContainText("already uses this invitation's email address");
    expect(app.snapshot().memberships.map((m) => m.status)).toEqual(['invited']);

    await recipient.getByRole('button', { name: 'Back to sign in', exact: true }).click();
    await login(recipient, app, 'target');
    await preview(recipient, token);
    const accepted = await responseAt(recipient, 'execute');
    await dialog(recipient, false).getByRole('button', { name: 'Accept invitation', exact: true }).click();
    expect((await accepted()).status()).toBe(200);
    await expect(dialog(recipient, false)).toContainText('Change confirmed.');
    expect(app.snapshot().memberships.map((m) => [m.account_id, m.status])).toEqual([
      [`email:${app.accounts.target.email}`, 'revoked'],
      [app.accounts.target.id, 'active'],
    ]);
  } finally {
    await issuerContext.close();
    await recipientContext.close();
    await app.stop();
  }
});
