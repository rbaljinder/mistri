import { FIXTURE_MS } from './support/budgets';
/**
 * A reference picked from its hierarchy (`tree: 'parent_id'`), over the Desk blocks fixture's own server: a command's
 * reference (`field.reference('category', { …, tree: 'parent_id' })`) walked by the keyboard to a category three
 * levels down, said with its path, and the ticket filed under it; a search that tells two categories of one name
 * apart by their paths; and a New form's reference (`form.fields.parent_id.tree`) placing a category under another.
 */
import { expect, test, type Page } from './support/harness';
import { startDeskBlocks } from './support/deskBlocksServer';
import { rows } from './support/db';

type Fixture = Awaited<ReturnType<typeof startDeskBlocks>>;
async function login(page: Page, app: Fixture) {
  const response = await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin },
    data: { email: app.account.email, password: app.account.password },
  });
  expect(response.ok(), await response.text()).toBe(true);
}
const read = <T>(app: Fixture, sql: string): T[] => rows<T>(app.database, sql);
const shots = process.env.TREE_SHOTS;

test.describe('a reference picked from its hierarchy', () => {
  test.setTimeout(60_000);
  let app: Fixture;
  test.beforeAll(async () => {
    // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
    test.setTimeout(FIXTURE_MS);
    app = await startDeskBlocks();
  });
  test.afterAll(async () => {
    await app?.stop();
  });

  test("a command's category is walked to by the keyboard, said with its path, and the ticket filed under it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, app);
    const reads: string[] = [];
    page.on('request', (request) => {
      if (/\/api\/(run|breakdown)\b/.test(request.url())) reads.push(`${new URL(request.url()).pathname} ${request.postData() ?? ''}`);
    });
    await page.goto(`${app.origin}/all/2`);
    await page.getByRole('button', { name: 'Categorize' }).click();
    const box = page.getByRole('combobox', { name: /Category/ });
    await expect(box).toBeVisible();
    await box.focus();
    await box.press('ArrowDown');
    const tree = page.getByRole('tree', { name: /Category/ });
    await expect(tree.getByRole('treeitem')).toHaveText(['Hardware', 'Network', 'Software']);
    // One breakdown says which tops have children; nothing is read per category.
    await expect.poll(() => reads.filter((r) => r.startsWith('/api/breakdown')).length).toBe(1);
    expect(reads.filter((r) => r.startsWith('/api/run'))).toHaveLength(1);

    // Down to Hardware, Right opens it (read as it opens), Right steps in, Right opens Laptops, Down to Batteries.
    await box.press('ArrowDown');
    await box.press('ArrowRight');
    await expect(tree.getByRole('treeitem')).toHaveText(['Hardware', 'Laptops', 'Printers', 'Network', 'Software']);
    await box.press('ArrowRight');
    await box.press('ArrowRight');
    await expect(tree.getByRole('treeitem', { name: 'Batteries' })).toHaveAttribute('aria-level', '3');
    await box.press('ArrowDown');
    const lit = async () => page.locator(`[id="${await box.getAttribute('aria-activedescendant')}"]`).innerText();
    expect(await lit()).toBe('Batteries');
    // Left steps back out to Laptops; Down returns.
    await box.press('ArrowLeft');
    expect(await lit()).toBe('Laptops');
    await box.press('ArrowDown');
    // The dialog's entrance (a scale) settled, so the picture is of the popup drawn over its edge, as it rests.
    if (shots) {
      await expect.poll(() => page.locator('.modal').evaluate((modal) => getComputedStyle(modal).transform)).toBe('none');
      await page.screenshot({ path: `${shots}/tree-picker-desk.png` });
    }
    await box.press('Enter');
    await expect(box).toHaveValue('Batteries');
    await expect(page.locator('.tree-picker-trail')).toHaveText(/Hardware\s*›\s*Laptops\s*›\s*Batteries/);
    await page.getByRole('button', { name: 'Categorize', exact: true }).last().click();
    await expect.poll(() => read<{ category_id: number }>(app, 'SELECT category_id FROM ticket WHERE id = 2')[0].category_id).toBe(6);
  });

  test('a search says each match with its path, so two of one name are told apart', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, app);
    await page.goto(`${app.origin}/all/3`);
    await page.getByRole('button', { name: 'Categorize' }).click();
    const box = page.getByRole('combobox', { name: /Category/ });
    await box.fill('batt');
    const options = page.getByRole('listbox').getByRole('option');
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toContainText('Hardware › Laptops');
    await expect(options.nth(1)).toContainText('Hardware › Printers');
    await box.press('ArrowDown');
    await box.press('Enter');
    await expect(page.locator('.tree-picker-trail')).toHaveText(/Hardware\s*›\s*Printers\s*›\s*Batteries/);
    await page.getByRole('button', { name: 'Categorize', exact: true }).last().click();
    await expect.poll(() => read<{ category_id: number }>(app, 'SELECT category_id FROM ticket WHERE id = 3')[0].category_id).toBe(8);
  });

  test("a New form's reference places a category under another, picked from the tree", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, app);
    await page.goto(`${app.origin}/categories/new`);
    const box = page.getByRole('combobox', { name: /Parent/ });
    await box.click();
    // The picker's own tree, not the categories' list behind the form.
    const tree = page.getByRole('tree', { name: /Parent/ });
    await expect(tree.getByRole('treeitem')).toHaveText(['Hardware', 'Network', 'Software']);
    // A click on a caret opens the branch without choosing it; a click on a name chooses.
    await tree.getByRole('treeitem', { name: 'Hardware' }).locator('.tree-picker-caret').click();
    await tree.getByRole('treeitem', { name: 'Laptops' }).click();
    await expect(box).toHaveValue('Laptops');
    await expect(page.locator('.tree-picker-trail')).toHaveText(/Hardware\s*›\s*Laptops/);
    const form = page.getByRole('dialog', { name: 'New category' });
    await form.getByRole('textbox', { name: 'Name' }).fill('Docking stations');
    if (shots) await page.screenshot({ path: `${shots}/tree-picker-new-form.png` });
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    await expect
      .poll(() => read<{ parent_id: number }>(app, "SELECT parent_id FROM category WHERE name = 'Docking stations'")[0]?.parent_id)
      .toBe(4);
  });
});
