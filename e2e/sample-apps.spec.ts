import { expect, test } from './support/harness';
import { startSample } from './support/sampleServer';
import { scalar } from './support/db';

for (const name of ['relay', 'thread'] as const) {
  test.describe(name, () => {
    let sample: Awaited<ReturnType<typeof startSample>>;
    test.beforeAll(async () => {
      // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
      test.setTimeout(120_000);
      sample = await startSample(name);
    });
    test.afterAll(async () => {
      await sample?.stop();
    });
    const table = name === 'relay' ? 'release_run' : 'issue';
    const detail = name === 'relay' ? 'release' : 'issue';
    const inventory = name === 'relay' ? 'service' : 'member';

    for (const width of [1440, 768, 390]) {
      test(`${width}px: dashboard, navigation, details and save/undo`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 924 });
        await page.goto(`${sample.origin}/`);
        await expect(page.locator('body')).toHaveClass(/app-mode/);
        await expect(page.locator('html')).toHaveAttribute('data-visual-theme', 'lumen');
        await expect(page.locator('.board-card').first()).toBeVisible();
        await expect(page.locator('.app-issues')).toHaveCount(0);
        if (name === 'thread' && width > 900) {
          await expect(page.getByRole('navigation', { name: 'App menu' })).toBeVisible();
          const filter = page.getByRole('searchbox', { name: 'Filter menu' });
          await expect(filter).toBeHidden();
          await expect(page.locator('.sidebar').getByRole('button', { name: /^Issues/ })).toBeVisible();
          await expect(page.locator('.sidebar').getByRole('button', { name: /^Cycles/ })).toBeVisible();
        } else await expect(page.locator('.sidebar')).toBeHidden();
        await expect(page.locator('#db-label')).toBeHidden();
        await expect(page.locator('#conn-picker')).toBeHidden();
        expect(await page.locator('.content').evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(
          width * (width > 900 ? 0.65 : 0.85),
        );
        await page.screenshot({ path: info.outputPath(`${name}-home-${width}.png`) });
        await page.locator('.board-card').first().click();
        await expect(page.locator('.page-field-grid').first()).toBeVisible();
        await page.goto(`${sample.origin}/@${detail}~1`);
        await expect(page.getByRole('heading', { level: 1 })).toContainText(
          String(scalar(sample.db, `SELECT name FROM ${table} WHERE id=1`)),
        );
        const grid = page.locator('.page-field-grid').first();
        // One field to a row on a phone, but a record's figures under its name two (docs/design.md); three at a desk.
        await expect(grid).toHaveCSS('grid-template-columns', width <= 600 ? /^[\d.]+px( [\d.]+px)?$/ : /^[\d.]+px [\d.]+px [\d.]+px$/);
        const original = String(scalar(sample.db, `SELECT name FROM ${table} WHERE id=1`));
        await page.getByRole('button', { name: 'Edit Name', exact: true }).click();
        const input = page.getByRole('textbox', { name: 'Name', exact: true });
        await input.fill(`${original} checked`);
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
        const saved = page.getByRole('region', { name: 'Saved changes', exact: true });
        await expect(saved).toContainText('Changes saved');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        expect(scalar(sample.db, `SELECT name FROM ${table} WHERE id=1`)).toBe(`${original} checked`);
        // An App has no Undo: the saved name is put back by another save.
        await expect(saved.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
        await saved.getByRole('button', { name: 'Dismiss', exact: true }).click();
        await page.request.post(`${sample.origin}/api/update`, { data: { app: name, table, key: { id: 1 }, values: { name: original } } });
        await page.screenshot({ path: info.outputPath(`${name}-detail-${width}.png`) });
        const refused = await page.request.post(`${sample.origin}/api/update`, {
          data: { app: name, table: inventory, key: { id: 1 }, values: { name: 'Forbidden' } },
        });
        expect(refused.status()).toBe(403);
        expect((await refused.json()).error).toContain(`does not write "${inventory}"`);
        expect(String(scalar(sample.db, `SELECT name FROM ${inventory} WHERE id=1`))).not.toBe('Forbidden');
      });
    }

    test('authored status action submits directly and persists', async ({ page }) => {
      await page.goto(`${sample.origin}/@${detail}~1`);
      const action = name === 'relay' ? 'Mark shipped' : 'Request review';
      await page.getByRole('button', { name: action, exact: true }).click();
      await expect.poll(() => scalar(sample.db, `SELECT status FROM ${table} WHERE id=1`)).toBe(name === 'relay' ? 'shipped' : 'in_review');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });

    if (name === 'relay')
      test('manual approval decisions persist without executing a deployment', async ({ page }) => {
        const deployments = scalar(sample.db, 'SELECT count(*) FROM deployment');
        await page.goto(`${sample.origin}/approval/@approval~3`);
        await page.getByRole('button', { name: 'Approve', exact: true }).click();
        await expect.poll(() => scalar(sample.db, 'SELECT decision FROM approval WHERE id=3')).toBe('approved');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        expect(scalar(sample.db, 'SELECT count(*) FROM deployment')).toBe(deployments);
      });

    if (name === 'thread')
      test('resizing the shell preserves an active draft and exposes every menu destination', async ({ page }) => {
        await page.goto(`${sample.origin}/@issue~2`);
        await page.getByRole('button', { name: 'Edit Name', exact: true }).click();
        const input = page.getByRole('textbox', { name: 'Name', exact: true });
        await input.fill('A draft across viewports');
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.locator('.sidebar')).toBeHidden();
        await expect(input).toHaveValue('A draft across viewports');
        await page.getByRole('button', { name: 'Menu', exact: true }).click();
        // The sidebar's groups and destinations remain available in its phone drawer.
        const menu = page.getByRole('dialog', { name: 'Thread navigation', exact: true });
        await expect(menu.getByRole('heading', { level: 2 })).toHaveText(['Plan', 'Team']);
        await expect(menu.getByRole('button', { name: 'Issues', exact: true })).toBeVisible();
        await expect(menu.getByRole('button', { name: 'Cycles', exact: true })).toBeVisible();
        await expect(menu.getByRole('button', { name: 'People', exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await page.setViewportSize({ width: 1440, height: 924 });
        await expect(page.locator('.sidebar')).toBeVisible();
        await expect(input).toHaveValue('A draft across viewports');
        await page.getByRole('button', { name: 'Discard', exact: true }).click();
      });

    if (name === 'thread')
      test('add a contextual discussion update while retaining a parent draft', async ({ page }) => {
        await page.goto(`${sample.origin}/@issue~2`);
        await page.getByRole('button', { name: 'Edit Name', exact: true }).click();
        await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Retained Thread draft');
        await page.getByRole('button', { name: '+ Add update', exact: true }).click();
        const form = page.locator('.newpanel');
        await form.getByLabel('Name', { exact: true }).fill('Contextual Thread update');
        await form.getByLabel('Body', { exact: true }).fill('The issue reference was supplied by the parent.');
        await form.locator('.picker-input').fill('Maya');
        await form.locator('.picker-option').first().click();
        await form.getByRole('button', { name: 'Add', exact: true }).click();
        await expect(form).toHaveCount(0);
        await expect(page.locator('.timeline')).toContainText('Contextual Thread update');
        expect(scalar(sample.db, "SELECT issue_id FROM comment WHERE name='Contextual Thread update'")).toBe(2);
        await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Retained Thread draft');
        await page.getByRole('button', { name: 'Discard', exact: true }).click();
      });

    if (name === 'thread')
      test('create an issue, add a discussion update and read it in the activity stream', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 924 });
        await page.goto(`${sample.origin}/issue`);
        await page.getByRole('button', { name: '+ New issue', exact: true }).click();
        const form = page.locator('.newpanel');
        await form.getByLabel('Name', { exact: true }).fill('New acceptance issue');
        await form.getByRole('button', { name: 'Add', exact: true }).click();
        await expect(page.locator('.record-modal').getByRole('heading', { level: 1 })).toContainText('New acceptance issue');
        const id = scalar(sample.db, "SELECT id FROM issue WHERE name='New acceptance issue'");
        expect(id).toBeTruthy();
        expect(scalar(sample.db, `SELECT status FROM issue WHERE id=${id}`)).toBe('backlog');
        await page.goto(`${sample.origin}/comment`);
        await page.getByRole('button', { name: '+ New update', exact: true }).click();
        await form.getByLabel('Name', { exact: true }).fill('Acceptance update');
        await form.getByLabel('Body', { exact: true }).fill('Verified the issue workflow end to end.');
        const pickers = form.locator('.picker-input');
        await pickers.nth(0).fill('New acceptance issue');
        await form.locator('.picker-option').first().click();
        await pickers.nth(1).fill('Maya');
        await form.locator('.picker-option').first().click();
        await form.getByRole('button', { name: 'Add', exact: true }).click();
        await expect.poll(() => scalar(sample.db, "SELECT count(*) FROM comment WHERE name='Acceptance update'")).toBe(1);
        // Each picker saved the record its text named, not the first row of an earlier search.
        expect(scalar(sample.db, "SELECT issue_id FROM comment WHERE name='Acceptance update'")).toBe(id);
        expect(scalar(sample.db, "SELECT m.name FROM comment c JOIN member m ON m.id=c.author_id WHERE c.name='Acceptance update'")).toBe(
          'Maya Chen',
        );
        await page.goto(`${sample.origin}/@issue~${id}`);
        await expect(page.locator('.timeline')).toContainText('Acceptance update');
        await expect(page.locator('.timeline')).toContainText('Verified the issue workflow end to end.');
      });
  });
}
