/**
 * Public intake in the shared browser UI, over a tenant App's dedicated host
 * (support/tenantIntakeFixture.ts): a dealer publishes its form with its
 * intake address, `?via=…`; a signed-out applicant fills it in; the
 * submission lands in that dealer. A link without a live address lands with
 * the lender's triage. The page is the same either way and says nothing
 * about where the application went.
 */
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from './support/harness.js';
import { INTAKE_ADDRESSES } from './support/tenantIntakeAddresses.js';
import { startTenantApp, type TenantAppFixture } from './support/tenantServer.js';

test.describe('public intake on a tenant App', () => {
  test.setTimeout(60000);
  let app: TenantAppFixture;
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
    app = await startTenantApp({ intake: true });
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  /** Where a reference landed, read beside the server (which may be mid-write). */
  const landed = (reference: string) => {
    const db = new DatabaseSync(app.database, { readOnly: true, timeout: 5000 });
    try {
      return {
        lead: db.prepare('SELECT tenant_id, name FROM lead WHERE reference = ?').get(reference) ?? null,
        triage: db.prepare('SELECT name FROM intake_submission WHERE reference = ?').get(reference) ?? null,
      };
    } finally {
      db.close();
    }
  };
  /** Apply signed out from the given link; the reference the page shows, and the submissions' query strings. */
  const apply = async (page: Page, query: string, name: string) => {
    const posted: string[] = [];
    const record = (request: { method(): string; url(): string }) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/forms/apply') posted.push(new URL(request.url()).search);
    };
    page.on('request', record);
    try {
      await page.goto(`${app.origin}/${app.appId}/form/apply${query}`);
      await expect(page.getByRole('heading', { name: 'Apply for financing' })).toBeVisible();
      await expect(page.locator('.signin')).toHaveCount(0);
      await page.getByLabel('Full name', { exact: false }).fill(name);
      await page.getByRole('button', { name: 'Submit' }).click();
      await expect(page.getByRole('heading', { name: 'Application received' })).toBeVisible();
      const reference = (await page.locator('.form-page-reference strong').textContent())?.trim() ?? '';
      expect(reference).toMatch(/^IGN-\d{6}$/);
      return { reference, posted };
    } finally {
      page.off('request', record);
    }
  };

  test("a dealer's published link places the application with that dealer", async ({ page }) => {
    const { reference, posted } = await apply(page, `?via=${INTAKE_ADDRESSES.north}`, 'Ada Lovelace');
    // The page carried on the address it was published with, and nothing else.
    expect(posted).toEqual([`?via=${INTAKE_ADDRESSES.north}`]);
    expect(landed(reference)).toEqual({ lead: { tenant_id: 'north', name: 'Ada Lovelace' }, triage: null });
  });

  test('a link without a live address lands with the lender, and the applicant sees the same page', async ({ page }) => {
    for (const [query, name] of [
      ['', 'Grace Hopper'],
      ['?via=not-a-dealer-address-000000', 'Katherine Johnson'],
    ] as const) {
      const { reference, posted } = await apply(page, query, name);
      expect(posted).toEqual([query]);
      expect(landed(reference)).toEqual({ lead: null, triage: { name } });
    }
  });

  test("signed out at the App's root, the visitor is shown the public form, not the sign-in screen", async ({ page }) => {
    await page.goto(`${app.origin}/${app.appId}`);
    await expect(page.getByRole('heading', { name: 'Apply for financing' })).toBeVisible();
    await expect(page.locator('.signin')).toHaveCount(0);
  });
});
