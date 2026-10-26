/**
 * A tab, chosen as a reader chooses it: in the strip where it is drawn, or from the strip's More where it did not
 * fit the row (useTabFold.ts). A folded tab is out of the row and of the accessibility tree, so `getByRole('tab')`
 * finds only the drawn ones.
 */
import { expect, type Page } from '@playwright/test';

export async function chooseTab(page: Page, name: string | RegExp, options: { exact?: boolean } = {}): Promise<void> {
  await expect(page.getByRole('tablist').first()).toBeVisible();
  const drawn = page.getByRole('tab', { name, exact: options.exact });
  if (await drawn.count()) return drawn.first().click();
  const words = (text: string) =>
    typeof name === 'string' ? (options.exact ? text.trim() === name : text.includes(name)) : name.test(text.trim());
  const mores = page.locator(':is(.tab-more, .page-tab-more):not([data-folded]) button');
  for (let i = 0; i < (await mores.count()); i++) {
    await mores.nth(i).click();
    const items = page.locator('.page-actions-popup [role="menuitem"]');
    await expect(items.first()).toBeVisible();
    for (let j = 0; j < (await items.count()); j++) {
      // A list's item is its tab's word and count, as the tab is: the word is matched.
      const said = (await items.nth(j).innerText()).split('\n')[0].trim();
      if (words(said)) {
        return items.nth(j).click();
      }
    }
    await page.keyboard.press('Escape');
  }
  throw new Error(`No tab ${String(name)} is drawn or under More.`);
}
