import { expect, test, type Page } from './support/harness';
import { scalar } from './support/db';
import { startMultisourceApp } from './support/multisourceServer';

async function navigate(page: Page, destination: 'Operations' | 'Inventory') {
  /* Folded, the one level of groups is labelled sections: the destination is one tap away.
     Wait for whichever control this width draws; an instant visibility check
     can run before the top bar has painted and pick the wrong one. */
  await page
    .getByRole('button', { name: 'Menu', exact: true })
    .or(page.getByRole('button', { name: 'Records', exact: true }))
    .first()
    .click();
  await page.getByRole('menuitem', { name: destination, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: destination, exact: true })).toBeVisible();
}

async function openRecord(page: Page, name: string) {
  // A card on a phone, a grid cell on a desktop: wait for whichever the list draws.
  await page
    .getByRole('button', { name, exact: true })
    .or(page.getByRole('gridcell', { name, exact: true }))
    .first()
    .click();
}

test.describe('one App with independently owned database sources', () => {
  let app: Awaited<ReturnType<typeof startMultisourceApp>>;
  test.beforeAll(async () => {
    // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
    test.setTimeout(120_000);
    app = await startMultisourceApp();
  });
  test.afterAll(async () => {
    await app?.stop();
  });

  for (const width of [1440, 390]) {
    test(`${width}px: navigate sources and save without touching the read-only default`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 924 });
      await page.goto(`${app.origin}/`);
      await expect(page.locator('body')).toHaveClass(/app-mode/);
      await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'lumen');
      await expect(page.locator('#conn-picker')).toBeHidden();
      await expect(page.locator('.app-issues')).toHaveCount(0);

      await navigate(page, 'Operations');
      await expect(page.getByRole('button', { name: /New / })).toHaveCount(0);
      await openRecord(page, 'Operations ticket');
      await expect(page.getByRole('heading', { level: 1, name: 'Operations ticket', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Edit Name', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`multisource-readonly-${width}.png`) });

      await navigate(page, 'Inventory');
      await openRecord(page, 'Inventory ticket');
      await expect(page.getByRole('heading', { level: 1, name: 'Inventory ticket', exact: true })).toBeVisible();
      expect(new URL(page.url()).pathname).toBe('/inventory/1');
      await page.getByRole('button', { name: 'Edit Name', exact: true }).click();
      const changed = `Inventory checked at ${width}px`;
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill(changed);
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      const saved = page.getByRole('region', { name: 'Saved changes', exact: true });
      await expect(saved).toContainText('Changes saved');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(scalar(app.secondary, 'SELECT name FROM ticket WHERE id=1')).toBe(changed);
      expect(scalar(app.primary, 'SELECT name FROM ticket WHERE id=1')).toBe('Operations ticket');
      await page.screenshot({ path: info.outputPath(`multisource-saved-${width}.png`) });

      // An App has no Undo: a save is put back by another save.
      await expect(saved.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
      await saved.getByRole('button', { name: 'Dismiss', exact: true }).click();
      // Saving keeps the editing surface open for the next edit.
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Inventory ticket');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect(saved).toContainText('Changes saved');
      expect(scalar(app.secondary, 'SELECT name FROM ticket WHERE id=1')).toBe('Inventory ticket');
      expect(scalar(app.primary, 'SELECT name FROM ticket WHERE id=1')).toBe('Operations ticket');
      await saved.getByRole('button', { name: 'Dismiss', exact: true }).click();
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: 'Inventory ticket', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Edit Name', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`multisource-details-${width}.png`) });
    });
  }
});
