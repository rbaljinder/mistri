/**
 * The browser fixture: one Lintel per worker (start.ts), and a page that fails
 * its test on any uncaught page error or a section drawn as an error — the
 * rule mistri's own browser suite holds every page to.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { emailOf, PASSWORD, startLintel, type Lintel, type Role } from './start.ts';

export const test = base.extend<object, { lintel: Lintel }>({
  lintel: [
    async ({ browser }, use) => {
      const lintel = await startLintel();
      try {
        /* The host serves its client from source, compiled on first ask: under load that is longer than a test's
           wait. One page loads it here, before any test's clock starts. */
        const warm = await browser.newPage();
        await warm.goto(`${lintel.host.url}/`);
        await warm.waitForSelector('html:not([data-starting])', { timeout: 170_000 });
        await warm.close();
        await use(lintel);
      } finally {
        await lintel.close();
      }
    },
    { scope: 'worker', timeout: 300_000 },
  ],
  page: async ({ page }, use) => {
    const errors: Error[] = [];
    page.on('pageerror', (error) => errors.push(error));
    await use(page);
    expect(errors, 'uncaught page errors').toEqual([]);
    expect(await page.locator('[data-section-error]').count(), 'sections drawn as errors').toBe(0);
  },
});
export { expect };

/** Opens an address and waits for the client to finish starting: it is served from source, slow when cold. */
export async function open(page: Page, lintel: Lintel, path: string) {
  await page.goto(`${lintel.host.url}${path}`);
  await page.waitForSelector('html:not([data-starting])', { timeout: 90_000 });
}

/** Signs in as a role through the sign-in screen, and waits for something the person can see. */
export async function signIn(page: Page, lintel: Lintel, role: Role) {
  await open(page, lintel, '/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(emailOf(role));
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // The sign-in screen has a main of its own: signed in is having left it, for the role's home.
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 90_000 });
  await page.waitForSelector('html:not([data-starting])', { timeout: 90_000 });
  await expect(page.getByRole('main')).toBeVisible();
}

/** No sideways scroll: what a phone shows fits it. */
export async function fitsTheWidth(page: Page) {
  // Said as a string: this module runs in Node, and only the page knows a document.
  expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth + 1')).toBe(true);
}
