import { expect, test } from './support/harness';
import { rows, scalar } from './support/db';
import { startSample } from './support/sampleServer';

test.describe('Service Atlas catalog filters', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.beforeAll(async () => {
    // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
    test.setTimeout(120_000);
    sample = await startSample('service-desk');
  });
  test.afterAll(async () => {
    await sample?.stop();
  });

  for (const width of [1440, 390])
    test(`${width}px: catalog boolean drilldown survives refresh and Back`, async ({ page }) => {
      await page.setViewportSize({ width, height: 924 });
      const catalog = `${sample.origin}/@dash-service-catalog`;
      const query = 'catalog_item category_id = 3 and active = true';
      const expected = rows<{ name: string }>(sample.db, 'SELECT name FROM catalog_item WHERE category_id = ? AND active = ?', 3, 1);
      const count = page.locator('.applist-count');
      const trail = page.getByRole('navigation', { name: 'Trail' });

      await page.goto(catalog);
      const software = page.locator('.dash-list-head').filter({
        has: page.getByRole('heading', { name: 'Software', exact: true }),
      });
      await software.getByRole('button', { name: 'View all', exact: true }).click();
      await expect.poll(() => decodeURIComponent(page.url())).toContain(query);
      await expect(count).toHaveText(expected.length.toLocaleString());
      for (const { name } of expected) await expect(page.locator('main')).toContainText(name);
      await expect(page.locator('main')).not.toContainText('cannot be bound to SQLite');

      await page.reload();
      await expect(count).toHaveText(expected.length.toLocaleString());
      await expect(trail.getByRole('button', { name: 'Service catalog', exact: true })).toBeVisible();
      await expect(trail).not.toContainText('dash-service-catalog');
      await expect(trail.getByRole('button', { name: 'Back', exact: true })).toHaveAttribute('title', 'Back to Service catalog');
      await trail.getByRole('button', { name: 'Back', exact: true }).click();
      // Back is the dashboard, said as its key.
      await expect(page).toHaveURL(`${sample.origin}/service-catalog`);
      await expect(software).toBeVisible();
      await page.goBack();
      await expect.poll(() => decodeURIComponent(page.url())).toContain(query);
      await expect(count).toHaveText(expected.length.toLocaleString());

      const falseQuery = 'catalog_item category_id = 3 and active = false';
      await page.goto(`${catalog}/${encodeURIComponent(falseQuery)}`);
      const inactive = Number(scalar(sample.db, 'SELECT count(*) FROM catalog_item WHERE category_id = ? AND active = ?', 3, 0));
      await expect(count).toHaveText(inactive.toLocaleString());
      await expect(page.locator('main')).not.toContainText('cannot be bound to SQLite');
      await expect(trail.getByRole('button', { name: 'Service catalog', exact: true })).toBeVisible();
      expect(decodeURIComponent(page.url())).toContain(falseQuery);
      /* `active = false` is said as its chip; the chip opens the flag's picker —
       a popover at a desk, the filter sheet on a phone — and a tick applies there. */
      await page.locator('.applist-chip', { hasText: 'Active is No' }).locator('.applist-chip-open').click();
      const picker = page.getByRole('dialog', { name: width > 600 ? 'Filter by Active' : 'Filters' });
      const active = picker.getByRole('checkbox', { name: /^Active/ });
      await expect(active).not.toBeChecked();
      await active.check();
      await picker.getByRole('button', { name: /^Show/ }).click();
      await expect.poll(() => decodeURIComponent(page.url())).toContain('active = true');
      expect(decodeURIComponent(page.url())).toContain('category_id = 3');
      await expect(count).toHaveText(expected.length.toLocaleString());
      for (const { name } of expected) await expect(page.locator('main')).toContainText(name);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    });
});
