/**
 * The handles these tests reach for, and only the ones that need explaining.
 *
 * The rule everywhere below is to address the page the way a reader does —
 * `getByRole('row')`, `getByRole('tab', { name: … })` — and to fall back to a
 * class only where tablewalk has genuinely not given the thing a name. Those
 * cases are marked, because each one is a small note that the interface could
 * be more legible than it is.
 */
import { expect, type Locator, type Page } from '@playwright/test';

/** Open a view by its link, the way a pasted URL arrives. */
export async function open(page: Page, connection: string, query = ''): Promise<void> {
  const link = `/${connection}${query ? `/${encodeURIComponent(query)}` : ''}`;
  await page.goto(link);
  await expect(page.locator('html')).not.toHaveAttribute('data-starting');
  await expect(page.locator('#db-label')).toContainText(connection);

  /* Wait for the address bar to settle before anything reads it.

     Boot renders the empty state, writes *that* into the address, and only then
     applies the incoming link — so for a few milliseconds `page.url()` is a
     URL the reader never asked for. A test that captured it there and compared
     later failed perhaps one run in ten, which is the worst kind of test. */
  await expect.poll(() => new URL(page.url()).pathname).toBe(link);
}

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

/** The query bar, which is also where a sort or a filter ends up written. */
export const queryBar = (page: Page): Locator => page.getByRole('combobox', { name: 'Query' });

export async function runQuery(page: Page, text: string): Promise<void> {
  await queryBar(page).fill(text);
  await queryBar(page).press('Enter');
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

/**
 * The table a record shows under its fields, for the chosen relationship.
 *
 * A class, because the panel has no role of its own — it is a heading and a
 * grid in a div. The grid inside it is addressed by role from here on.
 */
export const childPanel = (page: Page): Locator => page.locator('.child-panel');

export const trail = (page: Page): Locator => page.getByRole('navigation', { name: 'Trail' });

/**
 * The crumbs as text, in order, which is what a trail is for the reader.
 *
 * The steps of the walk only. The leading "Schema" crumb is a way home rather
 * than somewhere you walked to, and the trailing Back button is a control — both
 * are chrome the trail carries, and counting them as steps would make every
 * assertion here about the furniture instead of the journey.
 */
export async function trailText(page: Page): Promise<string[]> {
  const parts = await trail(page).locator(':scope > button:not(.crumb-home):not(.crumb-back), :scope > span.current').allInnerTexts();
  return parts.map((t) => t.trim()).filter(Boolean);
}

/**
 * The banner's toast.
 *
 * By id, not by role. It *is* a status region and one test asserts that —
 * but so is every loading skeleton, correctly: "loading" is exactly what a
 * status region is for. Matching by role therefore resolved to two elements
 * whenever a section was still loading as the toast appeared, which is
 * always eventually and on a slow machine reliably.
 */
export const toast = (page: Page): Locator => page.locator('#toast');

/** The error strip under the query bar. */
export const errors = (page: Page): Locator => page.locator('#errors');

/** The cursor a row actually draws — the thing that makes it look clickable. */
export function cursorOf(locator: Locator): Promise<string> {
  return locator.evaluate((node) => getComputedStyle(node as Element).cursor);
}

/**
 * Turn write mode on, agreeing to the dialog that explains what it means.
 *
 * The confirmation is deliberate in the app and so is walking through it here:
 * a test that reached into `state.canWrite` would pass with the dialog broken.
 */
export async function enableWriteMode(page: Page): Promise<void> {
  /* Already on, if this context has been here before: the choice is remembered
     per connection and survives a reload, which is the app's own rule and not
     something a helper should quietly re-ask. */
  /* The Workbench's menu is "More"; an App's is its settings gear, or — signed
     in — the account menu, which holds the settings then (OverflowMenu.tsx). */
  const app = await page.locator('body').evaluate((node) => node.classList.contains('app-mode'));
  const signedIn = app && (await page.locator('.account-host button.account').count()) > 0;
  const menu = page.getByRole('button', signedIn ? { name: /^Account: / } : { name: app ? 'Settings' : 'More', exact: true });
  await menu.click();
  const toggle = page.getByRole('menuitemcheckbox', { name: /^Editing enabled/ });
  if ((await toggle.getAttribute('aria-checked')) === 'true') {
    await page.keyboard.press('Escape');
    return;
  }
  await toggle.click();
  if (!app) await page.getByRole('dialog').getByRole('button', { name: 'Enable write mode' }).click();
  await menu.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
}
