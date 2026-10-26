import { CRM, CRM_DB, expect, test } from './support/ownServers';
import { scalar } from './support/db';
import { follow } from './support/app';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

const record = `${CRM}/@opportunity~1`;

test('navigation retains a draft for explicit resume and stale originals cannot overwrite another writer', async ({ page }, info) => {
  const original = String(scalar(CRM_DB, 'SELECT name FROM opportunity WHERE id=1'));
  const update = (name: string) =>
    page.request.post(`${CRM}/api/update`, { data: { app: 'compass', table: 'opportunity', key: { id: 1 }, values: { name } } });
  const writes: unknown[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/update')) writes.push(request.postDataJSON());
  });
  await page.goto(record);
  await page.getByRole('button', { name: 'Edit Opportunity', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Opportunity', exact: true });
  await input.fill('Discarded first draft');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await input.fill('My retained draft');
  await follow(page, '/lead');
  await expect(page.getByRole('region', { name: 'Unsaved changes' })).toHaveCount(0);
  await follow(page, '/@opportunity~1');
  const recovery = page.getByRole('region', { name: 'Retained draft' });
  await expect(recovery).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Opportunity', exact: true })).toBeDisabled();
  await recovery.getByText('Proposed changes', { exact: true }).click();
  await expect(recovery).toContainText('My retained draft');
  expect(writes).toHaveLength(0);
  await page.setViewportSize({ width: 390, height: 924 });
  await page.screenshot({ path: info.outputPath('retained-record-draft-390.png') });
  await recovery.getByRole('button', { name: 'Resume draft', exact: true }).click();
  await expect(input).toHaveValue('My retained draft');
  try {
    await update('Other writer');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Unsaved changes' })).toContainText('changed or was removed');
    await expect(page.locator('#toast')).toBeHidden();
    await expect(input).toHaveValue('My retained draft');
    expect(writes).toEqual([expect.objectContaining({ expected: { name: original } })]);
    expect(scalar(CRM_DB, 'SELECT name FROM opportunity WHERE id=1')).toBe('Other writer');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
  } finally {
    await update(original);
  }
});

test('drafts stay separate across records', async ({ page }) => {
  await page.goto(record);
  await page.getByRole('button', { name: 'Edit Opportunity', exact: true }).click();
  await page.getByRole('textbox', { name: 'Opportunity', exact: true }).fill('Record one draft');
  await follow(page, '/@opportunity~2');
  await page.getByRole('button', { name: 'Edit Opportunity', exact: true }).click();
  await page.getByRole('textbox', { name: 'Opportunity', exact: true }).fill('Record two draft');
  await follow(page, '/@opportunity~1');
  let recovery = page.getByRole('region', { name: 'Retained draft' });
  await recovery.getByRole('button', { name: 'Resume draft', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Opportunity', exact: true })).toHaveValue('Record one draft');
  await follow(page, '/@opportunity~2');
  recovery = page.getByRole('region', { name: 'Retained draft' });
  await recovery.getByRole('button', { name: 'Resume draft', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Opportunity', exact: true })).toHaveValue('Record two draft');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
});

test('a late save settles only its original draft after navigation', async ({ page }) => {
  const original = String(scalar(CRM_DB, 'SELECT name FROM opportunity WHERE id=1'));
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sent = false;
  await page.route('**/api/update', async (route) => {
    const response = await route.fetch();
    sent = true;
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.goto(record);
    await page.getByRole('button', { name: 'Edit Opportunity', exact: true }).click();
    await page.getByRole('textbox', { name: 'Opportunity', exact: true }).fill('Saved after navigation');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(() => sent).toBe(true);
    await follow(page, '/lead');
    release();
    await expect(page.locator('#toast')).toContainText('original record');
    await follow(page, '/@opportunity~1');
    await expect(page.getByRole('button', { name: 'Edit Opportunity', exact: true })).toContainText('Saved after navigation');
    await expect(page.getByRole('region', { name: 'Retained draft' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
  } finally {
    release();
    await page.request.post(`${CRM}/api/update`, {
      data: { app: 'compass', table: 'opportunity', key: { id: 1 }, values: { name: original } },
    });
  }
});
