// test-package: shared — drives the database browser and an App to one behavior (scripts/test-owners.mjs).
import { CRM, CRM_DB, expect, SCRATCH, SCRATCH_DB, test } from './support/ownServers';
import { scalar } from './support/db';
import { dataRows, enableWriteMode, follow, open } from './support/app';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer', 'crm'] });

test('staged updates distinguish database NULL from literal null text in both directions', async ({ page, request }) => {
  const id = 3;
  const original = scalar(SCRATCH_DB, 'SELECT email FROM customer WHERE id = ?', id);
  const name = String(scalar(SCRATCH_DB, 'SELECT name FROM customer WHERE id = ?', id));
  const update = (email: unknown) =>
    request.post('/api/update', {
      data: { conn: SCRATCH, table: 'customer', key: { id }, values: { email } },
    });
  try {
    expect((await update(null)).ok()).toBe(true);
    await open(page, SCRATCH, 'customer');
    await enableWriteMode(page);
    await dataRows(page).filter({ hasText: name }).click();
    const input = page.getByRole('textbox', { name: 'email (TEXT)', exact: true });
    await expect(input).toHaveValue('');
    for (const value of ['null', '']) {
      await input.fill(value);
      await expect(page.locator('.pending')).toContainText('1 unsaved change');
      await page.getByRole('button', { name: 'Review & apply', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(page.locator('.pending')).toHaveCount(0);
      await expect(input).toHaveValue(value);
      expect(scalar(SCRATCH_DB, 'SELECT email FROM customer WHERE id = ?', id)).toBe(value === '' ? null : value);
    }
  } finally {
    expect((await update(original)).ok()).toBe(true);
  }
});

for (const failure of ['lost response', 'invalid acknowledgement'] as const) {
  test(`a real update with ${failure} preserves proposed values and never offers a blind retry`, async ({ page, request }, info) => {
    const id = 3;
    const original = scalar(SCRATCH_DB, 'SELECT email FROM customer WHERE id = ?', id);
    const name = String(scalar(SCRATCH_DB, 'SELECT name FROM customer WHERE id = ?', id));
    const proposed = 'unconfirmed@example.test';
    let attempts = 0;
    await open(page, SCRATCH, 'customer');
    await enableWriteMode(page);
    await dataRows(page).filter({ hasText: name }).click();
    const recordLink = new URL(page.url()).pathname;
    await page.route('**/api/update', async (route) => {
      attempts++;
      const response = await route.fetch();
      expect((await response.json()).affected).toBe(1);
      if (failure === 'lost response') await route.abort('failed');
      else await route.fulfill({ response, json: { affected: 1, applied: {} } });
    });
    try {
      const input = page.getByRole('textbox', { name: 'email (TEXT)', exact: true });
      await input.fill(proposed);
      await page.getByRole('button', { name: 'Review & apply', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click();
      const notice = page.locator('.pending-uncertain');
      await expect(notice).toContainText('Update not confirmed');
      await expect(input).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Review & apply', exact: true })).toHaveCount(0);
      expect(scalar(SCRATCH_DB, 'SELECT email FROM customer WHERE id = ?', id)).toBe(proposed);
      await notice.getByText('Proposed changes', { exact: true }).click();
      await expect(notice).toContainText(proposed);
      await follow(page, `/${SCRATCH}/country`);
      await expect(page.locator('.pending-uncertain')).toHaveCount(0);
      await follow(page, recordLink);
      await expect(page.locator('.pending-uncertain')).toContainText('Update not confirmed');
      await expect(input).toBeDisabled();
      for (const width of [1440]) {
        await page.setViewportSize({ width, height: 924 });
        expect(await notice.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
        await page.screenshot({ path: info.outputPath(`update-unconfirmed-${width}.png`) });
      }
      expect(attempts).toBe(1);
    } finally {
      expect(
        (await request.post('/api/update', { data: { conn: SCRATCH, table: 'customer', key: { id }, values: { email: original } } })).ok(),
      ).toBe(true);
    }
  });
}

test('an explicit update refusal retains fields for correction and one deliberate resubmission', async ({ page, request }) => {
  const id = 3;
  const original = scalar(SCRATCH_DB, 'SELECT email FROM customer WHERE id = ?', id);
  const name = String(scalar(SCRATCH_DB, 'SELECT name FROM customer WHERE id = ?', id));
  let attempts = 0;
  await open(page, SCRATCH, 'customer');
  await enableWriteMode(page);
  await dataRows(page).filter({ hasText: name }).click();
  await page.route('**/api/update', async (route) => {
    attempts++;
    if (attempts === 1) await route.fulfill({ status: 400, json: { error: 'Review the email address.' } });
    else await route.continue();
  });
  try {
    const input = page.getByRole('textbox', { name: 'email (TEXT)', exact: true });
    for (const email of ['rejected@example.test', 'corrected@example.test']) {
      await input.fill(email);
      await page.getByRole('button', { name: 'Review & apply', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(input).toBeEnabled();
    }
    await expect(page.locator('.pending')).toHaveCount(0);
    expect(scalar(SCRATCH_DB, 'SELECT email FROM customer WHERE id = ?', id)).toBe('corrected@example.test');
    expect(attempts).toBe(2);
  } finally {
    expect(
      (await request.post('/api/update', { data: { conn: SCRATCH, table: 'customer', key: { id }, values: { email: original } } })).ok(),
    ).toBe(true);
  }
});

test('an unconfirmed app action also locks field editing, with a contained mobile notice', async ({ page }, info) => {
  const crm = CRM;
  const id = 1;
  const original = scalar(CRM_DB, 'SELECT status FROM lead WHERE id = ?', id);
  let attempts = 0;
  await page.request.post(`${crm}/api/update`, { data: { app: 'compass', table: 'lead', key: { id }, values: { status: 'new' } } });
  await page.goto(`${crm}/lead/~${id}`);
  await page.route('**/api/update', async (route) => {
    attempts++;
    await route.fetch();
    await route.abort('failed');
  });
  try {
    const action = page.getByRole('button', { name: 'Start working', exact: true });
    await action.click();
    const notice = page.locator('.pending-uncertain');
    await expect(notice).toContainText('Update not confirmed');
    await expect(action).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Edit Name', exact: true })).toBeDisabled();
    expect(scalar(CRM_DB, 'SELECT status FROM lead WHERE id = ?', id)).toBe('working');
    await notice.getByText('Proposed changes', { exact: true }).click();
    await expect(notice).toContainText('working');
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 924 });
      const bounds = (await notice.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await notice.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: info.outputPath(`action-unconfirmed-${width}.png`) });
    }
    expect(attempts).toBe(1);
  } finally {
    await page.request.post(`${crm}/api/update`, { data: { app: 'compass', table: 'lead', key: { id }, values: { status: original } } });
  }
});
