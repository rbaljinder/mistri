/**
 * A tenant App's public form in the reader's language, in the browser over the tenant host
 * (support/tenantPublicFormsServer.ts), the App's catalogs English and Spanish: the browser's own language picks
 * Spanish. A dealer's form then says its label, its choices (`labelColumns`, a row with no Spanish name keeping its own)
 * and the platform's form words (`mistri.form.*`) in the App's Spanish. A picked language (the App's locale cookie) says
 * it to an English browser too: the form is read without credentials (publicForm.js), so the read names the pick in
 * its address (`?locale=`), and so does a submission and each step a saved form takes, which the fixture's handlers
 * answer with the language they ran in (`ctx.locale`).
 * A fresh server per test, on a port of its own, so it runs beside others.
 */
import { expect, test } from './support/harness.js';
import type { Browser, Page } from '@playwright/test';
import { NORTH, startTenantPublicForms, type TenantPublicFormsApp, via } from './support/tenantPublicFormsServer.js';

/** A page in a browser that asks for Spanish (`Accept-Language: es-ES`), closed after. */
async function inSpanish(browser: Browser, use: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ locale: 'es-ES' });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
    await use(page);
  } finally {
    await context.close();
  }
}

test.describe("a tenant App's public form in the reader's language", () => {
  test.setTimeout(60000);
  let app: TenantPublicFormsApp | undefined;
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('mistri.tour', 'done'));
    app = await startTenantPublicForms({ words: 'both', publicReads: true, localMakes: true, localeReference: true });
  });
  test.afterEach(async () => {
    await app?.stop();
    app = undefined;
  });

  test('English where the browser asks for it', async ({ page }) => {
    await page.goto(`${app!.origin}/yard/form/apply${via(NORTH)}`);
    await expect(page.getByRole('heading', { name: 'Apply for financing' })).toBeVisible();
  });

  test("the visitor's pick says the form in Spanish to an English browser, though the form is read without cookies", async ({ page }) => {
    await page.context().addCookies([{ name: 'mistri-locale-yard', value: 'es', url: app!.origin }]);
    const read = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith('/api/forms/apply'));
    await page.goto(`${app!.origin}/yard/form/apply${via(NORTH)}`);
    const asked = new URL((await read).url()).searchParams;
    expect([asked.get('via'), asked.get('locale')]).toEqual([NORTH, 'es']);
    await expect(page.getByRole('heading', { name: 'Solicitar financiación' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Apply for financing' })).toHaveCount(0);
  });

  test("the visitor's pick comes back on the submission too: the command runs in Spanish for an English browser", async ({ page }) => {
    await page.context().addCookies([{ name: 'mistri-locale-yard', value: 'es', url: app!.origin }]);
    const sent = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/forms/apply');
    await page.goto(`${app!.origin}/yard/form/apply${via(NORTH)}`);
    await page.getByRole('textbox', { name: /^Name/ }).fill('Ada');
    await page.getByRole('button', { name: /^Submit/ }).click();
    expect(new URL((await sent).url()).searchParams.get('locale')).toBe('es');
    await expect(page.locator('.form-page-reference strong')).toHaveText('YRD-Ada-es');
  });

  test("a stepped form's steps and its submit are sent in the visitor's pick, not only its read", async ({ page }) => {
    await page.context().addCookies([{ name: 'mistri-locale-yard', value: 'es', url: app!.origin }]);
    const posted: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/forms/draft/')) posted.push(request.url());
    });
    await page.goto(`${app!.origin}/yard/form/draft${via(NORTH)}`);
    await page.getByRole('textbox', { name: /^Name/ }).fill('Ada');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('.multi-step-count')).toHaveText('Paso 2 de 2');
    await page.getByRole('button', { name: /^Submit/ }).click();
    // The step ran in Spanish and so did the submit: the draft's reference says the first, the receipt's the second.
    await expect(page.locator('.form-page-reference strong')).toHaveText(/^YRD-D-es-[0-9a-f]{8}\/es$/);
    const named = posted.map((url) => [new URL(url).pathname, new URL(url).searchParams.get('locale')]);
    expect(named).toContainEqual(['/api/forms/draft/steps/name', 'es']);
  });

  test("the browser's own language picks Spanish", async ({ browser }) => {
    await inSpanish(browser, async (page) => {
      await page.goto(`${app!.origin}/yard/form/apply${via(NORTH)}`);
      await expect(page.getByRole('heading', { name: 'Solicitar financiación' })).toBeVisible();
    });
  });

  test("a dealer's choices are said by their Spanish names, and a row without one keeps its own", async ({ browser }) => {
    await inSpanish(browser, async (page) => {
      await page.goto(`${app!.origin}/yard/form/quote${via(NORTH)}`);
      const makes = page.getByRole('radiogroup', { name: /^Make/ }).getByRole('radio');
      await expect(makes).toHaveCount(2);
      await expect(page.getByRole('radio', { name: 'Vado' })).toBeVisible();
      await expect(page.getByRole('radio', { name: 'Kia' })).toBeVisible();
      await expect(page.getByRole('radio', { name: 'Ford' })).toHaveCount(0);
    });
  });

  test("a stepped form at a dealer's address says the platform's form words in the App's Spanish", async ({ browser }) => {
    await inSpanish(browser, async (page) => {
      await page.goto(`${app!.origin}/yard/form/draft${via(NORTH)}`);
      await expect(page.locator('.multi-step-count')).toHaveText('Paso 1 de 2');
      await expect(page.getByRole('button', { name: 'Atrás' })).toHaveCount(0);
      await page.getByRole('textbox', { name: /^Name/ }).fill('Ada');
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.locator('.multi-step-count')).toHaveText('Paso 2 de 2');
      await expect(page.getByRole('button', { name: 'Atrás' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
    });
  });
});
