// test-package: shared — drives the database browser and an App to one behavior (scripts/test-owners.mjs).
import { CRM, CRM_DB, EXPLORER, expect, test } from './support/ownServers';
import { DatabaseSync } from 'node:sqlite';
import { scalar } from './support/db';

// This spec controls API responses; exercise boot through its fetch fallback.
test.use({ carryFirstPaint: false });

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm', 'explorer'] });

for (const width of [1440, 390])
  test(`date column range uses a nested themed calendar at ${width}px`, async ({ page }) => {
    // The Workbench's column menu asks a range in a dialog (an App's asks it in
    // the rail's facet). Column menus are desktop-only; an already open dialog
    // must also survive a narrow resize (mobile opens date filters through the filter sheet).
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${EXPLORER}/demo/invoice`);
    await page
      .locator('th', { hasText: /^invoice_date/ })
      .locator('.th-filter')
      .click();
    await page
      .locator('.th-menu')
      .getByRole('menuitem', { name: /between…/ })
      .click();
    await page.setViewportSize({ width, height: 900 });
    const dialog = page.locator('.modal.confirm');
    const from = dialog.getByRole('textbox', { name: 'Date from', exact: true });
    const to = dialog.getByRole('textbox', { name: 'Date to', exact: true });
    await from.fill('2026-09-');
    await to.fill('2026-09-30');
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(from).toHaveAttribute('aria-invalid', 'true');
    await from.fill('2026-09-13');
    const trigger = dialog.getByRole('button', { name: 'Choose date for Date from', exact: true });
    await trigger.click();
    await expect(dialog.locator('.date-field-popup')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog.locator('.date-field-popup')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/2026-09-13/);
    await expect(page).toHaveURL(/2026-09-30/);
  });

test('date filter preserves invalid drafts and submits the latest typed date', async ({ page }) => {
  await page.goto(`${CRM}/task-calendar`);
  await expect(page.locator('.calendar-grid')).toBeVisible();
  await page.getByRole('button', { name: 'Filter by Due', exact: true }).click();
  const form = page.locator('.filter-pop-form');
  const from = form.getByRole('textbox', { name: 'From', exact: true });
  await from.fill('2026-09-');
  await from.press('Enter');
  await expect(form).toBeVisible();
  await expect(from).toHaveAttribute('aria-invalid', 'true');
  await from.fill('2026-09-13');
  await form.getByRole('button', { name: /^Show / }).click();
  await expect(form).toHaveCount(0);
  await expect(page).toHaveURL(/2026-09-13/);
});

test('date filter calendar is nested, keyboard accessible, and leaves its filter open on Escape', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mistri.visual-theme', 'lumen'));
  await page.goto(`${CRM}/task-calendar`);
  await page.getByRole('button', { name: 'Filter by Due', exact: true }).click();
  const form = page.locator('.filter-pop-form');
  const from = form.getByRole('textbox', { name: 'From', exact: true });
  await from.fill('2026-09-13');
  const trigger = form.getByRole('button', { name: 'Choose date for From', exact: true });
  await trigger.click();
  await expect(page.locator('.date-field-popup')).toBeVisible();
  await expect(page.locator('.date-field-calendar td').first()).toHaveCSS('padding-top', '1px');
  const height = await page.locator('.date-field-calendar').evaluate((element) => element.getBoundingClientRect().height);
  expect(height).toBeLessThan(300);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.date-field-calendar [data-date="2026-09-14"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.date-field-popup')).toHaveCount(0);
  await expect(form).toBeVisible();
  await expect(trigger).toBeFocused();
});

for (const width of [1440, 390])
  test(`New task uses the custom date field and stores its selected date at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem('mistri.visual-theme', 'lumen'));
    await page.route(/\/api\/app(?:\?|$)/, async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      // Narrow the disposable fixture's form; actual insert validation/storage
      // remain the real framework and CRM database, never a preview database.
      payload.app.resources.task.form = { show: ['subject', 'due_on'], defaults: { owner_id: 1, created_on: '2026-09-04' } };
      await route.fulfill({ response, json: payload });
    });
    const subject = `Date picker task ${width} ${Date.now()}`;
    let writes = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/insert') writes++;
    });
    try {
      await page.goto(`${CRM}/task-calendar`);
      await page.getByRole('button', { name: '+ New task', exact: true }).click();
      const form = page.locator('.newpanel .insert-form');
      await form.getByRole('textbox', { name: 'Task', exact: true }).fill(subject);
      const due = form.getByRole('textbox', { name: 'Due', exact: true });
      await due.fill('2026-02-30');
      await form.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(form).toBeVisible();
      await expect(due).toHaveAttribute('aria-invalid', 'true');
      expect(writes).toBe(0);
      await due.fill('2026-09-13');
      const trigger = form.getByRole('button', { name: 'Choose date for Due', exact: true });
      await trigger.click();
      await expect(page.locator('.newpanel .date-field-popup')).toBeVisible();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      await expect(due).toHaveValue('09/14/2026');
      await expect(trigger).toBeFocused();
      await expect(form.getByRole('textbox', { name: 'Task', exact: true })).toHaveValue(subject);
      const written = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/insert');
      await form.getByRole('button', { name: 'Add', exact: true }).click();
      const result = await (await written).json();
      expect(result.errors).toBeUndefined();
      expect(result.key?.id).toBeDefined();
      expect(writes).toBe(1);
      expect(scalar(CRM_DB, 'SELECT due_on FROM task WHERE id = ?', result.key.id)).toBe('2026-09-14');
    } finally {
      // Delete only this test's uniquely named row; preserve shared seeded data.
      const db = new DatabaseSync(CRM_DB);
      try {
        db.prepare('DELETE FROM task WHERE subject = ?').run(subject);
      } finally {
        db.close();
      }
    }
  });
