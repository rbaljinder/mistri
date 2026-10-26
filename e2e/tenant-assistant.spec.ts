import { test, expect, type Page } from './support/harness.js';
import { startTenantAdministration, type TenantAdministrationFixture } from './support/tenantAdministrationServer.js';
import {
  ADMINISTRATION_HTTP_ROOT as root,
  ADMINISTRATION_HTTP_HEADER as contextHeader,
} from '../packages/mistri/src/shared/tenantAdministration.js';
import { TENANT_HTTP_HEADERS as headers } from '../packages/mistri/src/shared/tenantContext.js';

/**
 * The assistant in a tenant App (docs/tenant-apps.md, "The assistant"): drawn
 * for a member only while the platform owner's switch for that tenant is on,
 * and gone again at the next page load once it is switched off. The switch is
 * set through Manage tenants' own routes, as the operator would.
 */
let app: TenantAdministrationFixture;
test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  app = await startTenantAdministration({ assistant: true });
});
test.afterAll(async () => {
  await app?.stop();
});

/** The platform owner sets North's switch through the administration routes. */
async function setSwitch(enabled: boolean) {
  const origin = app.origin;
  const signedIn = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: app.accounts.operator.email, password: app.accounts.operator.password }),
  });
  expect(signedIn.status).toBe(200);
  const identity = {
    origin,
    'content-type': 'application/json',
    cookie: signedIn.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
    [headers.app]: app.appId,
    [headers.account]: app.accounts.operator.id,
  };
  const opened = await (await fetch(`${origin}${root}/open?app=${app.appId}`, { method: 'POST', headers: identity, body: '{}' })).json();
  const owned = { ...identity, [contextHeader]: opened.session.context as string };
  const listed = await (await fetch(`${origin}${root}/tenants?app=${app.appId}`, { headers: owned })).json();
  const north = listed.page.items.find((item: { tenantId: string }) => item.tenantId === 'north');
  expect(north.assistant).toEqual({ enabled: !enabled, consent: enabled ? '' : 'DPA-north-browser' });
  const executed = await fetch(`${origin}${root}/execute?app=${app.appId}`, {
    method: 'POST',
    headers: owned,
    body: JSON.stringify({
      idempotencyKey: `assistant-${enabled}`,
      intent: {
        operation: 'setTenantAssistant',
        tenantId: 'north',
        expectedTenantVersion: north.tenant.version,
        enabled,
        consent: 'DPA-north-browser',
      },
    }),
  });
  expect((await executed.json()).outcome).toBe('applied');
}

const trigger = (page: Page) => page.locator('.assistant-trigger');
/** North's items, choosing North first where the page asks which tenant. A sole membership is entered on its own:
 *  its chooser shows only while it does so, its buttons busy, so only an enabled choice is one to click. */
async function inNorth(page: Page) {
  const choose = page.getByRole('region', { name: 'Choose a tenant' }).getByRole('button', { name: 'north', exact: true, disabled: false });
  const row = page.getByText('Private north business row', { exact: true }).filter({ visible: true }).first();
  await expect(choose.or(row)).toBeVisible();
  if (await choose.isVisible()) await choose.click();
  await expect(row).toBeVisible();
}

test('the panel is drawn only while the tenant’s switch is on', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
  await page.goto(`${app.origin}/items`);
  await page.getByLabel('Email', { exact: true }).fill(app.accounts.target.email);
  await page.getByLabel('Password', { exact: true }).fill(app.accounts.target.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await inNorth(page);
  await expect(page.locator('body')).not.toContainText('Private south business row');
  // Off by default: no trigger, and nothing to open.
  await expect(trigger(page)).toHaveCount(0);

  await setSwitch(true);
  await page.reload();
  await inNorth(page);
  await expect(trigger(page)).toBeVisible();
  await trigger(page).click();
  const panel = page.getByRole('complementary', { name: 'Assistant' });
  const box = panel.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('hello');
  await box.press('Enter');
  await expect(panel.getByText('Hello from the scripted assistant.')).toBeVisible();

  await setSwitch(false);
  await page.reload();
  await inNorth(page);
  await expect(trigger(page)).toHaveCount(0);
});
