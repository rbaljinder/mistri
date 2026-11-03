/**
 * The handles these tests reach for, and only the ones that need explaining.
 *
 * The rule everywhere below is to address the page the way a reader does —
 * `getByRole('row')`, `getByRole('tab', { name: … })` — and to fall back to a
 * class only where the interface has genuinely not given the thing a name. Those
 * cases are marked, because each one is a small note that the interface could
 * be more legible than it is.
 */
import type { Locator, Page } from '@playwright/test';

/**
 * Follow a link *inside* the running app, the way clicking one does.
 *
 * Not `page.goto`. Links are paths now, so a goto is a real navigation and
 * the document — with whatever panels were open on it — is thrown away. That
 * used to be free: a hash change kept the document, so a test could "switch
 * connection by link" and still be looking at the surface it opened. This is
 * what the app itself does, so it is what a test about state surviving a
 * switch has to do.
 */
export async function follow(page: Page, link: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, link);
}

/**
 * The result grid.
 *
 * `.table-wrap` rather than a role, because the grid is a plain `<table>` and
 * the scrolling element around it is the thing several tests need to address —
 * it is the scrollport the pinned columns are frozen against.
 */
export const grid = (page: Page): Locator => page.locator('.table-wrap').first();

/**
 * The rows of the main grid, excluding the detail row an expander opens.
 *
 * `getByRole('row')` would include the header and the detail, and "the parent
 * row is still one row" is exactly the assertion that has to be able to tell
 * them apart.
 */
export const dataRows = (page: Page): Locator =>
  /* Child combinators throughout: an expanded row contains a whole second grid,
     and a descendant selector counts that grid's rows as though they were the
     table's own — which is exactly the confusion "the parent row is still one
     row" exists to rule out. */
  grid(page).locator('> table > tbody > tr:not(.detail-row)');
