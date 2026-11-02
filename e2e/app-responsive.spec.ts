/**
 * An App on a phone keeps its own navigation, and the Workbench's keys find nothing there to open. The Workbench's
 * half of this check (its table list and query bar at a phone's width) is e2e/workbench-responsive.spec.ts: one spec
 * per product, so each moves with its own package (scripts/test-owners.mjs).
 */
import { expect, test } from './support/harness';

const CRM = `http://127.0.0.1:${process.env.TABLEWALK_E2E_CRM_PORT}/`;

test('a narrow App keeps its own navigation and has no Workbench to switch to', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${CRM}/opportunity`);
  await expect(page.locator('body')).toHaveClass(/app-mode/);
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar-reveal')).toBeHidden();
  await page.keyboard.press('w');
  await expect(page.locator('body')).toHaveClass(/app-mode/);
  await expect(page.locator('.sidebar-reveal')).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Tables', exact: true })).toHaveCount(0);
});
