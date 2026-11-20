import { SLOW_MS } from './support/budgets';
/**
 * A public form in an App with two catalogs draws a quiet language switch at its foot. Choosing Español says the
 * platform's own words around the form in Spanish ("Paso 1 de 5"), and the choice outlives the page: a reload and the
 * plain address, with no `?locale=`, still open in Spanish (the App's language cookie). This spec's own server
 * (listen(0), a fresh mkdtemp database) over the saved-application fixture, given English and Spanish catalogs.
 */
import { resolve } from 'node:path';
import { expect, test } from './support/harness';
import { startSavedFormApp } from './support/savedFormServer';

/* Plain catalogs, not defineMessages: the files are written outside the repository, where the DSL does not resolve. */
const catalog = (locale: string) => `export default { kind: 'messages', locale: '${locale}', entries: {} };\n`;

test.describe('a public form in two languages', () => {
  test.setTimeout(SLOW_MS);
  let app: Awaited<ReturnType<typeof startSavedFormApp>>;
  test.beforeAll(async () => {
    app = await startSavedFormApp([], {
      directory: resolve('test/fixtures/apps/saved-application'),
      database: 'lending.db',
      files: { 'messages/en.ts': catalog('en'), 'messages/es.ts': catalog('es') },
    });
  });
  test.afterAll(async () => {
    await app?.stop();
  });

  test('the switch changes the page words, and the choice persists across a reload and a plain address', async ({ page }) => {
    await page.goto(`${app.origin}/form/apply`);
    await expect(page.getByText('Step 1 of 5', { exact: false }).first()).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Language' });
    await expect(nav.getByRole('link', { name: 'English' })).toHaveAttribute('aria-current', 'true');

    await nav.getByRole('link', { name: 'Español' }).click();
    await expect(page).toHaveURL(/[?&]locale=es\b/);
    await expect(page.getByText('Paso 1 de 5', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Step 1 of 5')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Idioma' }).getByRole('link', { name: 'Español' })).toHaveAttribute(
      'aria-current',
      'true',
    );

    await page.reload();
    await expect(page.getByText('Paso 1 de 5', { exact: false }).first()).toBeVisible();

    // The address says no language: the cookie the click kept does.
    await page.goto(`${app.origin}/form/apply`);
    await expect(page.getByText('Paso 1 de 5', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continuar' })).toBeVisible();

    await page.getByRole('navigation', { name: 'Idioma' }).getByRole('link', { name: 'English' }).click();
    await expect(page.getByText('Step 1 of 5', { exact: false }).first()).toBeVisible();
  });
});
