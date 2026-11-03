import { CRM, expect, type Page, test } from './support/ownServers';

// This spec controls API responses; exercise boot through its fetch fallback.
test.use({ carryFirstPaint: false });

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

async function newLead(page: Page) {
  await page.route(/\/api\/app(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    (payload.app.resources.lead ??= {}).form = {
      show: ['name', 'company'],
      defaults: {
        name: 'Submission test lead',
        company: 'Submission test company',
        source: 'event',
        owner_id: 1,
        email: 'submission@example.test',
        created_on: '2026-09-04',
        status: 'new',
      },
    };
    await route.fulfill({ response, json: payload });
  });
  await page.goto(`${CRM}/lead`);
  await page.getByRole('button', { name: '+ New lead' }).click();
  return page.locator('.newpanel');
}

test('unsaved creation: drawer dismissal requires discard and restores focus when kept', async ({ page }, testInfo) => {
  const form = await newLead(page);
  let attempts = 0;
  await page.route('**/api/insert', async (route) => {
    attempts += 1;
    await route.abort();
  });
  const name = form.getByRole('textbox', { name: 'Name', exact: true });
  await name.fill('Unfinished lead');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await name.focus();
    await page.keyboard.press('Escape');
    const confirm = page.getByRole('dialog', { name: 'Discard new record?' });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Keep editing' })).toBeFocused();
    const box = (await confirm.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await confirm.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect(confirm.getByRole('button', { name: 'Discard record' })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`insert-discard-${width}.png`) });
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(name).toBeFocused();
    await expect(name).toHaveValue('Unfinished lead');
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.mouse.click(4, 200);
  await expect(page.getByRole('dialog', { name: 'Discard new record?' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await form.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Discard record' }).click();
  await expect(form).toHaveCount(0);
  expect(attempts).toBe(0);
});

test('insert reliability: pending drawer resists dismissal; a rejection preserves values for correction', async ({ page }, testInfo) => {
  const form = await newLead(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  let key: Record<string, unknown> | undefined;
  await page.route('**/api/insert', async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await held;
      await route.fulfill({ json: { outcome: 'rejected', errors: [{ message: 'Choose another name.' }] } });
    } else {
      const response = await route.fetch();
      key = (await response.json()).key;
      await route.fulfill({ response });
    }
  });
  try {
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(form.getByRole('status')).toHaveText('Adding...');
    await expect(form.getByRole('status')).toBeFocused();
    await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toBeDisabled();
    await expect(form.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await expect(form.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.mouse.click(4, 200);
    await form.locator('form').evaluate((node: HTMLFormElement) => node.requestSubmit());
    await expect(form).toBeVisible();
    expect(attempts).toBe(1);
    await page.screenshot({ path: testInfo.outputPath('insert-pending.png') });
    release();
    await expect(form.getByRole('alert')).toHaveText('Choose another name.');
    await expect(form.getByRole('alert')).toBeFocused();
    await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Submission test lead');
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Corrected submission lead');
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Corrected submission lead');
    expect(attempts).toBe(2);
    expect(key?.id).toBeDefined();
  } finally {
    release();
    if (key) {
      const removed = await page.request.post(`${CRM}/api/delete`, { data: { app: 'compass', table: 'lead', key, confirm: true } });
      expect((await removed.json()).deleted).toBe(true);
    }
  }
});

test('insert reliability: a response lost after a real insert never offers another Add', async ({ page }, testInfo) => {
  const form = await newLead(page);
  let key: Record<string, unknown> | undefined;
  let attempts = 0;
  await page.route('**/api/insert', async (route) => {
    attempts += 1;
    const response = await route.fetch();
    key = (await response.json()).key;
    await route.abort('failed');
  });
  try {
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('The row may already exist');
    await expect(form.getByRole('alert')).toBeFocused();
    await expect(form.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
    await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Submission test lead');
    await form.locator('form').evaluate((node: HTMLFormElement) => node.requestSubmit());
    expect(attempts).toBe(1);
    expect(key?.id).toBeDefined();
    const read = await page.request.post(`${CRM}/api/run`, { data: { app: 'compass', q: `lead id = ${key!.id}` } });
    expect((await read.json()).rows).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath('insert-unconfirmed.png') });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const bounds = await form.getByRole('alert').boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(await form.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await expect(form.locator('.newpanel-foot').getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`insert-unconfirmed-${width}.png`) });
    }
    await form.locator('.newpanel-foot').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(form).toHaveCount(0);
  } finally {
    if (key) {
      const removed = await page.request.post(`${CRM}/api/delete`, { data: { app: 'compass', table: 'lead', key, confirm: true } });
      expect((await removed.json()).deleted).toBe(true);
    }
  }
});
