import { expect, test } from './support/harness';
import { startSample } from './support/sampleServer';
import { scalar } from './support/db';

test.describe('Thread editable issue modal', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.setTimeout(45_000);
  test.beforeEach(async () => {
    sample = await startSample('thread');
  });
  test.afterEach(async () => {
    await sample?.stop();
  });

  for (const width of [1440, 390]) {
    test(`${width}px: manual Save and contextual creation preserve the queue and parent draft`, async ({ page }) => {
      await page.setViewportSize({ width, height: 924 });
      await page.goto(`${sample.origin}/issue`);
      const original = String(scalar(sample.db, 'SELECT name FROM issue WHERE id=2'));
      const queue = page.locator('.applist-grid');
      await expect(queue).toBeVisible();
      const queueNode = await queue.elementHandle();
      const route = page.url();
      await queue
        .getByRole('gridcell', { name: original, exact: true })
        .or(queue.getByRole('button', { name: original, exact: true }))
        .click();
      const modal = page.locator('.record-modal');
      await expect(modal).toBeVisible();
      await modal.getByRole('button', { name: 'Edit Name', exact: true }).click();
      const input = modal.getByRole('textbox', { name: 'Name', exact: true });
      await input.fill('A manually saved Thread issue');
      await modal.getByRole('button', { name: '+ Add update', exact: true }).click();
      const form = page.getByRole('dialog', { name: 'New comment', exact: true });
      await form.getByLabel('Name', { exact: true }).fill('Update from an issue modal');
      await form.getByLabel('Body', { exact: true }).fill('The modal uses the shared related-record form.');
      await form.locator('.picker-input').fill('Maya');
      await form.locator('.picker-option').first().click();
      await form.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(form).toHaveCount(0);
      await expect(modal.locator('.timeline')).toContainText('Update from an issue modal');
      expect(scalar(sample.db, "SELECT issue_id FROM comment WHERE name='Update from an issue modal'")).toBe(2);
      await expect(input).toHaveValue('A manually saved Thread issue');
      expect(scalar(sample.db, 'SELECT name FROM issue WHERE id=2')).toBe(original);
      await modal.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect.poll(() => scalar(sample.db, 'SELECT name FROM issue WHERE id=2')).toBe('A manually saved Thread issue');
      await expect(modal.getByRole('region', { name: 'Saved changes', exact: true })).toBeVisible();
      await expect(page).toHaveURL(route);
      expect(await queueNode!.evaluate((node) => node.isConnected)).toBe(true);
      await modal.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(modal).toHaveCount(0);
      await expect(queue).toContainText('A manually saved Thread issue');
      await expect(page).toHaveURL(route);
    });
  }

  test('lost related-insert acknowledgement keeps both modal owners and never repeats the insert', async ({ page }) => {
    await page.goto(`${sample.origin}/issue`);
    const original = String(scalar(sample.db, 'SELECT name FROM issue WHERE id=2'));
    const queue = page.locator('.applist-grid');
    await queue
      .getByRole('gridcell', { name: original, exact: true })
      .or(queue.getByRole('button', { name: original, exact: true }))
      .click();
    const modal = page.locator('.record-modal');
    await modal.getByRole('button', { name: '+ Add update', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New comment', exact: true });
    await form.getByLabel('Name', { exact: true }).fill('Unconfirmed modal update');
    await form.getByLabel('Body', { exact: true }).fill('Committed once, acknowledgement lost.');
    await form.locator('.picker-input').fill('Maya');
    await form.locator('.picker-option').first().click();
    let writes = 0;
    await page.route(
      (url) => url.pathname === '/api/insert',
      async (route) => {
        writes++;
        const response = await route.fetch({ maxRetries: 0 });
        expect(response.status()).toBe(200);
        await route.abort('failed');
      },
    );
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('Creation was not confirmed');
    expect(scalar(sample.db, "SELECT count(*) FROM comment WHERE name='Unconfirmed modal update' AND issue_id=2")).toBe(1);
    await page.keyboard.press('Escape');
    await expect(form).toBeVisible();
    await expect(modal).toBeVisible();
    await expect(form.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
    expect(writes).toBe(1);
  });

  test('focus refetch failure retains an unconfirmed related insert and all modal exit fences', async ({ page }) => {
    await page.goto(`${sample.origin}/issue`);
    const original = String(scalar(sample.db, 'SELECT name FROM issue WHERE id=2'));
    const queue = page.locator('.applist-grid');
    const issue = queue
      .getByRole('gridcell', { name: original, exact: true })
      .or(queue.getByRole('button', { name: original, exact: true }));
    await expect(issue).toBeVisible();
    const routeBefore = page.url();
    await issue.click();
    const modal = page.locator('.record-modal');
    await modal.getByRole('button', { name: 'Edit Name', exact: true }).click();
    const parentInput = modal.locator('input[aria-label="Name"]');
    await parentInput.fill('Parent draft survives a background failure');
    await modal.getByRole('button', { name: '+ Add update', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New comment', exact: true });
    const name = form.getByLabel('Name', { exact: true });
    // Body is the rich text editor (a contenteditable), typed into and read as text.
    const body = form.getByRole('textbox', { name: 'Body' });
    await name.fill('Unconfirmed update across a failed refetch');
    await body.click();
    await page.keyboard.type('Committed once; preserve this exact form after the read fails.');
    await form.locator('.picker-input').fill('Maya');
    await form.locator('.picker-option').first().click();
    const retainedNodes = await Promise.all([modal, form, parentInput, name, body].map((locator) => locator.elementHandle()));
    let writes = 0;
    await page.route(
      (url) => url.pathname === '/api/insert',
      async (route) => {
        writes++;
        const response = await route.fetch({ maxRetries: 0 });
        expect(response.status()).toBe(200);
        await route.abort('failed');
      },
    );
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('Creation was not confirmed');
    const inserted = () =>
      scalar(sample.db, "SELECT count(*) FROM comment WHERE name='Unconfirmed update across a failed refetch' AND issue_id=2");
    expect(inserted()).toBe(1);

    // Configured definitions are cached; the planner is a real network read on
    // focus. Fail only that read, without replacing the route or session owner.
    let failedPlans = 0;
    await page.route(
      (url) => url.pathname === '/api/pages/compose',
      (route) => route.fulfill({ status: 500, json: { message: 'Background composed page unavailable.' } }),
    );
    await page.route(
      (url) => url.pathname === '/api/pages/plan',
      async (route) => {
        failedPlans++;
        await route.fulfill({ status: 500, json: { message: 'Background record plan unavailable.' } });
      },
    );
    const failedRead = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/pages/plan' && response.status() === 500,
    );
    // Exercise Query's installed browser-focus listener, not a direct cache
    // invalidation/refetch or a mocked query result.
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    expect(await (await failedRead).finished()).toBeNull();
    await expect(modal.getByText('Could not refresh this record. Showing the last loaded layout.', { exact: true })).toBeVisible();
    expect(failedPlans).toBe(1);

    const retained = async () => {
      await expect(modal).toBeVisible();
      await expect(form).toBeVisible();
      for (const node of retainedNodes) expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
      await expect(parentInput).toHaveValue('Parent draft survives a background failure');
      await expect(name).toHaveValue('Unconfirmed update across a failed refetch');
      await expect(body).toHaveText('Committed once; preserve this exact form after the read fails.');
      await expect(form.getByRole('alert')).toContainText('Creation was not confirmed');
      await expect(form.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
      await expect(form.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
      await expect(page).toHaveURL(routeBefore);
      expect(writes).toBe(1);
      expect(inserted()).toBe(1);
      expect(scalar(sample.db, 'SELECT name FROM issue WHERE id=2')).toBe(original);
    };
    await retained();
    await page.keyboard.press('Escape');
    await retained();
    // The nested backdrop normally intercepts these controls. Dispatch directly
    // to prove the parent's own guards also refuse Close, Details and record navigation.
    await modal.locator('button.peekpanel-close').dispatchEvent('click');
    await retained();
    await modal.locator('button.peekpanel-open').dispatchEvent('click');
    await retained();
    let navigationAttempts = 0;
    for (const label of ['Next record', 'Previous record']) {
      const button = modal.locator(`button[aria-label="${label}"]`);
      if ((await button.count()) && (await button.isEnabled())) {
        navigationAttempts++;
        await button.dispatchEvent('click');
        await retained();
      }
    }
    expect(navigationAttempts, 'the loaded collection must exercise at least one record-navigation guard').toBeGreaterThan(0);
    await form.locator('form').evaluate((node: HTMLFormElement) => node.requestSubmit());
    await retained();
  });
});
