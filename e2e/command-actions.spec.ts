import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from './support/harness';
import { COMMAND_APP_ID, startCommandApp } from './support/commandDeskServer';

type Fixture = Awaited<ReturnType<typeof startCommandApp>>;
async function login(page: Page, app: Fixture, account = app.accounts[0]) {
  const response = await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin },
    data: { email: account.email, password: account.password },
  });
  expect(response.ok(), await response.text()).toBe(true);
}
async function open(page: Page, app: Fixture) {
  await page.goto(`${app.origin}/@application~1`);
  await expect(page.getByRole('button', { name: 'Assign reviewer', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Assign reviewer', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Assign reviewer', exact: true });
  await expect(form).toBeVisible();
  await expect(form.getByRole('status')).toContainText('Ready to submit');
  return form;
}
async function fill(page: Page) {
  const form = page.getByRole('dialog', { name: 'Assign reviewer', exact: true });
  await form.getByRole('combobox', { name: 'Reviewer (required)', exact: true }).fill('Robin');
  await page.getByRole('option', { name: 'Robin Bell', exact: true }).click();
  await form.getByLabel('Assignment reason', { exact: false }).fill('North desk allocation');
}
function stored(app: Fixture) {
  /* This reads the file beside the server, which may still be committing the
     write the test just caused: without a busy timeout the read is a coin
     flip against SQLITE_BUSY (e2e/support/db.ts says the same). */
  const db = new DatabaseSync(app.database, { readOnly: true, timeout: 5000 });
  try {
    return {
      loan: db.prepare('SELECT reviewer_id, version, status FROM loan_application WHERE id=1').get(),
      history: db.prepare('SELECT assigned_to, assigned_by, reason FROM assignment_history WHERE application_id=1').all(),
    };
  } finally {
    db.close();
  }
}

test.describe('Command-desk assignment', () => {
  test.setTimeout(60_000);
  let app: Fixture;
  test.beforeEach(async () => {
    app = await startCommandApp();
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  for (const width of [1440, 1024, 390])
    test(`assignment commits through a command form at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await login(page, app);
      let crud = 0;
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/update') crud++;
      });
      const form = await open(page, app);
      await fill(page);
      await form.getByRole('button', { name: 'Assign reviewer', exact: true }).click();
      await expect(form.getByRole('status')).toHaveAttribute('data-phase', 'success');
      expect(stored(app)).toEqual({
        loan: { reviewer_id: 3, version: 1, status: 'submitted' },
        history: [{ assigned_to: 3, assigned_by: 1, reason: 'North desk allocation' }],
      });
      expect(crud).toBe(0);
      expect(await form.evaluate((element) => element.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
      await form.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(form).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Assign reviewer', exact: true })).toHaveCount(0);
    });

  test('lost response keeps the form and retry envelope until durable replay confirms success', async ({ page }) => {
    await login(page, app);
    const envelopes: unknown[] = [];
    let first = true;
    await page.route('**/api/commands/execute*', async (route) => {
      envelopes.push(route.request().postDataJSON());
      if (!first) {
        await route.continue();
        return;
      }
      first = false;
      const committed = await route.fetch();
      expect(committed.ok()).toBe(true);
      await route.abort('failed');
    });
    const form = await open(page, app);
    await fill(page);
    await form.getByRole('button', { name: 'Assign reviewer', exact: true }).click();
    await expect(form.getByRole('button', { name: 'Retry same submission' })).toBeVisible();
    await expect(form.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(form).toBeVisible();
    await form.getByRole('button', { name: 'Retry same submission' }).click();
    await expect(form.getByRole('status')).toHaveAttribute('data-phase', 'success');
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).toEqual(envelopes[1]);
    expect(stored(app).history).toHaveLength(1);
    expect(stored(app).loan?.version).toBe(1);
  });

  test('keyboard submission validates required inputs and denies assignment across desks', async ({ page }) => {
    await login(page, app, app.accounts[1]);
    const form = await open(page, app);
    await form.getByRole('button', { name: 'Assign reviewer', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(form.getByRole('status')).toContainText('Reviewer is required');
    await fill(page);
    await form.getByRole('button', { name: 'Assign reviewer', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(form.getByRole('status')).toContainText('not available to this account');
    expect(stored(app).loan).toMatchObject({ reviewer_id: null, version: 0 });
    expect(stored(app).history).toHaveLength(0);
  });

  test('an account switch cannot execute a prepared form under the new account', async ({ page }) => {
    await login(page, app);
    const form = await open(page, app);
    await fill(page);
    await login(page, app, app.accounts[1]);
    await form.getByRole('button', { name: 'Assign reviewer', exact: true }).click();
    await expect(page.locator('#session-lock')).toBeVisible();
    expect(stored(app).loan).toMatchObject({ reviewer_id: null, version: 0 });
    expect(stored(app).history).toHaveLength(0);
  });
});
