import { expect, test, type Page } from './support/harness';
import { DEPOT_ADMIN, startSample } from './support/sampleServer';
import { scalar } from './support/db';

/* Row-defined fields, in Depot: a product's specifications are the rows of
   `attribute` for its category (and those for every category), kept in its
   one `specs` JSON column. The page draws and edits them as its own fields,
   the server holds a write to them and names the field it refuses, the New
   form asks the chosen category's, and the Catalog rail offers them as
   facets. Each test owns its seed and its server (the parallel lane). */
test.describe('Row-defined fields', () => {
  test.setTimeout(120_000);

  const signIn = async (page: Page, origin: string) => {
    const login = await page.request.post(`${origin}/api/auth/sign-in/email`, { headers: { origin }, data: DEPOT_ADMIN });
    expect(login.ok()).toBe(true);
  };
  const specs = (db: string, id: number) => JSON.parse(String(scalar(db, 'SELECT specs FROM product WHERE id = ?', id)));

  test('a product page draws its category’s fields, saves one into the object and says a refusal under its field', async ({ page }) => {
    const sample = await startSample('depot');
    try {
      await signIn(page, sample.origin);
      const id = Number(scalar(sample.db, "SELECT id FROM product WHERE sku LIKE 'TNT-RB2-%' ORDER BY id LIMIT 1"));
      const before = specs(sample.db, id);
      await page.goto(`${sample.origin}/products/${id}`);
      const section = page.getByRole('complementary', { name: 'Record context' });
      // In the definitions' order, by their captions: the tent's three, then the field every product has.
      await expect(section.locator('.page-field dt')).toContainText(['Sleeps', 'Season', 'Freestanding', 'Warranty (years)']);
      await section.getByRole('button', { name: 'Edit Sleeps', exact: true }).click();
      await section.getByRole('textbox', { name: 'Sleeps', exact: true }).fill('3');
      const dock = page.getByRole('region', { name: 'Unsaved changes', exact: true });
      await dock.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect(dock).toHaveCount(0);
      await expect(section.getByRole('textbox', { name: 'Sleeps', exact: true })).toHaveValue('3');
      // One key changed; the rest of the object is as it was.
      expect(specs(sample.db, id)).toEqual({ ...before, capacity: 3 });

      // Sleeps is required: emptied, the server refuses the write and the page says why under it.
      await section.getByRole('textbox', { name: 'Sleeps', exact: true }).fill('');
      await dock.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect(section.getByText('This field is required.')).toBeVisible();
      expect(specs(sample.db, id)).toEqual({ ...before, capacity: 3 });
    } finally {
      await sample.stop();
    }
  });

  test('the server refuses a value its definition does not allow, naming the field', async ({ page }) => {
    const sample = await startSample('depot');
    try {
      await signIn(page, sample.origin);
      const id = Number(scalar(sample.db, "SELECT id FROM product WHERE sku LIKE 'TNT-RB2-%' ORDER BY id LIMIT 1"));
      const before = specs(sample.db, id);
      const update = (values: Record<string, unknown>) =>
        page.request.post(`${sample.origin}/api/update`, {
          headers: { origin: sample.origin },
          data: { table: 'product', key: { id }, values, expected: {} },
        });
      const refused = await update({ specs: JSON.stringify({ ...before, season: 'winter', lumens: 300 }) });
      const body = await refused.json();
      // Each break by its field and a fixed sentence: the definitions' order, then the keys none defines.
      expect(body.outcome).toBe('rejected');
      expect(body.errors[0].code).toBe('validation_failed');
      expect(body.errors[0].fields).toEqual([
        { field: 'specs.season', message: 'Choose from the list.' },
        { field: 'specs.lumens', message: 'This is not one of the fields this record has.' },
      ]);
      expect(specs(sample.db, id)).toEqual(before);
    } finally {
      await sample.stop();
    }
  });

  test('the New form asks the chosen category’s fields and writes them as one object', async ({ page }) => {
    const sample = await startSample('depot');
    try {
      await signIn(page, sample.origin);
      await page.goto(`${sample.origin}/products/new`);
      const form = page.locator('form');
      await expect(form.getByLabel('Sleeps')).toHaveCount(0);
      await form.getByLabel('SKU', { exact: true }).fill('TNT-TST-1');
      await form.getByLabel('Product', { exact: true }).fill('Test Tent');
      await form.getByRole('combobox', { name: 'Category' }).fill('Tents');
      await page.getByRole('option', { name: /Tents & shelters/ }).click();
      await form.getByLabel('Sleeps').fill('2');
      await form.getByRole('radio', { name: '4-season' }).check();
      await form.getByRole('combobox', { name: 'Supplier' }).fill('Ridgeline');
      await page.getByRole('option', { name: /Ridgeline Outdoor/ }).click();
      await form.getByLabel('Unit cost').fill('100');
      await form.getByLabel('List price').fill('200');
      await form.getByRole('button', { name: 'Add', exact: true }).click();
      await expect.poll(() => scalar(sample.db, "SELECT count(*) FROM product WHERE sku = 'TNT-TST-1'")).toBe(1);
      expect(JSON.parse(String(scalar(sample.db, "SELECT specs FROM product WHERE sku = 'TNT-TST-1'")))).toEqual({
        capacity: 2,
        season: '4-season',
      });
    } finally {
      await sample.stop();
    }
  });

  test('the Catalog rail offers the fields as facets and narrows by one', async ({ page }) => {
    const sample = await startSample('depot');
    try {
      await signIn(page, sample.origin);
      await page.goto(`${sample.origin}/catalog`);
      const rail = page.getByRole('complementary', { name: 'Catalog filters' });
      await expect(rail.getByRole('group', { name: 'Sleeps' })).toBeVisible();
      // A list of choices offers its options, not the lists products hold.
      const certification = rail.getByRole('group', { name: 'Certification' });
      await expect(certification.getByRole('checkbox')).toHaveCount(3);
      await certification.getByRole('checkbox', { name: 'MIPS' }).check();
      const mips = Number(scalar(sample.db, "SELECT count(*) FROM product WHERE status = 'active' AND specs LIKE '%MIPS%'"));
      expect(mips).toBeGreaterThan(0);
      await expect(page.getByRole('heading', { name: 'Catalog', level: 1 }).locator('..')).toContainText(String(mips));
    } finally {
      await sample.stop();
    }
  });
});
