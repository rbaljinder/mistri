/**
 * Opening a record field for inline edit swaps its text for an input. The swap must be height-neutral: every row below
 * the field stays where it was, and stays there when the edit closes (docs/design.md, layout shift).
 */
import { CRM, expect, test } from './support/ownServers';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

/* The heading's name (a larger face with no padding) and a plain field of the form: each swaps its text for an input. */
for (const [which, index] of [
  ['the record name in the heading', 0],
  ['a field of the form', 1],
] as const) {
  test(`opening ${which} for inline edit moves nothing below it`, async ({ page }) => {
    await page.goto(`${CRM}/@lead~127`);
    await expect(page.locator('body')).toHaveClass(/app-mode/);
    const values = page.locator('.inline-edit-value');
    const opened = values.nth(index);
    await expect(values.nth(index + 1)).toBeVisible();
    // The field after the one opened: its handle survives the first one turning into an input.
    const below = (await values.nth(index + 1).elementHandle())!;
    const top = async () => (await below.boundingBox())!.y;
    const before = await top();
    await opened.click();
    await expect(page.locator('.inline-field-open .cell-edit, .inline-field-open .cell-edit-control').first()).toBeVisible();
    expect(await top()).toBeCloseTo(before, 1);
    await page
      .getByRole('button', { name: /^Done editing/ })
      .first()
      .click();
    await expect(page.locator('.inline-field-open')).toHaveCount(0);
    expect(await top()).toBeCloseTo(before, 1);
  });
}
