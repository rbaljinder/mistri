/**
 * A tenant App's public form, in the shared browser UI over the dedicated tenant host (support/tenantIntakeFixture.ts),
 * when the App names a human check: the stock form draws the provider's widget (Turnstile's local stand-in) on a
 * dealer's link and sends the token it hands over, and the application lands with that dealer. A submission with no
 * token is refused and written nowhere. A form whose field is a choice from a table is served each dealer's own rows,
 * placed by the address its link carries, and the chosen one lands with that dealer. Its own server on a port of its
 * own, so it runs beside others.
 */
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './support/harness.js';
import { INTAKE_ADDRESSES } from './support/tenantIntakeAddresses.js';
import { startTenantApp, type TenantAppFixture } from './support/tenantServer.js';

test.describe("a tenant App's public form behind a human check", () => {
  test.setTimeout(60000);
  let app: TenantAppFixture;
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
    app = await startTenantApp({ intake: { challenge: true } });
  });
  test.afterEach(async () => {
    await app?.stop();
  });
  const rows = (sql: string) => {
    const db = new DatabaseSync(app.database, { readOnly: true, timeout: 5000 });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  };

  test("a dealer's link draws the widget, sends its token, and lands with that dealer", async ({ page }) => {
    await page.goto(`${app.origin}/${app.appId}/form/apply?via=${INTAKE_ADDRESSES.north}`);
    await expect(page.getByRole('heading', { name: 'Apply for financing' })).toBeVisible();
    await expect(page.locator('[data-turnstile-stub="intake-site-key"]')).toHaveText('Verified');
    await page.getByLabel('Full name', { exact: false }).fill('Ada Lovelace');
    const sent = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/forms/apply');
    await page.getByRole('button', { name: 'Submit' }).click();
    const request = await sent;
    // A fresh token of the person's, issued on this page's host; the dealer's address rides in the link, not the body.
    expect(request.headers()['x-mistri-challenge']).toMatch(/^person~\w+~127\.0\.0\.1$/);
    expect(new URL(request.url()).searchParams.get('via')).toBe(INTAKE_ADDRESSES.north);
    await expect(page.getByRole('heading', { name: 'Application received' })).toBeVisible();
    expect(rows("SELECT tenant_id, name FROM lead WHERE name = 'Ada Lovelace'")).toEqual([{ tenant_id: 'north', name: 'Ada Lovelace' }]);
  });

  test('a submission without a token, or with one already spent, is refused and written nowhere', async ({ page }) => {
    const post = (token: string | undefined, name: string, n: number) =>
      page.request.post(`${app.origin}/api/forms/apply?via=${INTAKE_ADDRESSES.north}`, {
        headers: { origin: app.origin, ...(token ? { 'x-mistri-challenge': token } : {}) },
        data: { input: { name }, submission: `tenant-guard-${String(n).padStart(8, '0')}` },
      });
    const bare = await post(undefined, 'No Token', 1);
    expect(bare.status()).toBe(403);
    expect((await bare.json()).code).toBe('challenge_failed');
    expect((await post('spec-person', 'Grace Hopper', 2)).status()).toBe(200);
    expect((await post('spec-person', 'Spent Token', 3)).status()).toBe(403);
    expect(rows('SELECT name FROM lead ORDER BY name')).toEqual([{ name: 'Grace Hopper' }]);
    expect(rows('SELECT name FROM intake_submission')).toEqual([]);
  });
});

test.describe("a tenant App's public form with a choice from a table", () => {
  test.setTimeout(60000);
  let app: TenantAppFixture;
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
    app = await startTenantApp({ intake: { choices: true } });
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  test("each dealer's link offers that dealer's own makes, and the chosen one lands with it", async ({ page }) => {
    const reads: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname === '/api/forms/quote') reads.push(url.search);
    });
    /* A radio's name is its label beside it, so the makes offered are read off the radios' accessible names. */
    const offered = async (names: string[]) => {
      const radios = page.getByRole('radiogroup', { name: /^Make/ }).getByRole('radio');
      await expect(radios).toHaveCount(names.length);
      for (const [i, name] of names.entries()) await expect(radios.nth(i)).toHaveAccessibleName(name);
    };
    await page.goto(`${app.origin}/${app.appId}/form/quote?via=${INTAKE_ADDRESSES.south}`);
    await expect(page.getByRole('heading', { name: 'Ask for a quote' })).toBeVisible();
    await offered(['Fiat']);

    await page.goto(`${app.origin}/${app.appId}/form/quote?via=${INTAKE_ADDRESSES.north}`);
    const makes = page.getByRole('radiogroup', { name: /^Make/ });
    await offered(['Ford', 'Kia']);
    // The form's own read carried the dealer's address: the page read no rows of its own.
    expect(reads).toContain(`?via=${INTAKE_ADDRESSES.north}`);
    await makes.getByText('Kia').click();
    await page.getByLabel('Full name', { exact: false }).fill('Ada Lovelace');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('heading', { name: 'Quote requested' })).toBeVisible();
    const db = new DatabaseSync(app.database, { readOnly: true, timeout: 5000 });
    try {
      expect(db.prepare("SELECT tenant_id, make_id FROM lead WHERE name = 'Ada Lovelace'").all()).toEqual([
        { tenant_id: 'north', make_id: 'n-kia' },
      ]);
    } finally {
      db.close();
    }
  });
});
