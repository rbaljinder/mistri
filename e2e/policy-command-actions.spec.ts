import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from './support/harness';
import { COMMAND_APP_ID, startCommandApp } from './support/commandDeskServer';

type Fixture = Awaited<ReturnType<typeof startCommandApp>>;
async function open(page: Page, app: Fixture) {
  const account = app.accounts[0];
  const login = await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin },
    data: { email: account.email, password: account.password },
  });
  expect(login.ok()).toBe(true);
  await page.goto(`${app.origin}/@application~1`);
  await page.getByRole('button', { name: 'Assign reviewer', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Assign reviewer', exact: true });
  await expect(form.getByRole('status')).toContainText('Ready to submit');
  return form;
}
function stored(app: Fixture) {
  /* This reads the file beside the server, which may still be committing the
     write the test just caused: without a busy timeout the read is a coin
     flip against SQLITE_BUSY (e2e/support/db.ts says the same). */
  const db = new DatabaseSync(app.database, { readOnly: true, timeout: 5000 });
  try {
    return {
      loan: db.prepare('SELECT reviewer_id, version FROM loan_application WHERE id=1').get(),
      history: db.prepare('SELECT assigned_to FROM assignment_history WHERE application_id=1').all(),
      foreign: db.prepare("SELECT id, name FROM reviewer WHERE team_id=2 AND role='reviewer' AND active=1 LIMIT 1").get()!,
    };
  } finally {
    db.close();
  }
}

test.describe('Command-desk row-policy commands', () => {
  test.setTimeout(60_000);
  let app: Fixture;
  test.beforeEach(async () => {
    app = await startCommandApp({ rowPolicy: true });
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  for (const width of [1440, 390])
    test(`desk-scoped picker and assignment at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const form = await open(page, app);
      const foreign = stored(app).foreign;
      const picker = form.getByRole('combobox', { name: 'Reviewer (required)', exact: true });
      const queried = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/run' && response.request().postData()?.includes(String(foreign.name)) === true,
        { timeout: 7000 },
      );
      await picker.fill(String(foreign.name));
      expect((await queried).ok()).toBe(true);
      await expect(page.getByRole('option', { name: String(foreign.name), exact: true })).toHaveCount(0);
      const hidden = await page.request.post(`${app.origin}/api/query?app=${COMMAND_APP_ID}`, {
        data: {
          table: 'reviewer',
          columns: ['id', 'name'],
          limit: 10,
          offset: 0,
          filter: { groups: [[{ column: 'id', op: '=', value: foreign.id }]] },
        },
      });
      expect(hidden.ok(), await hidden.text()).toBe(true);
      expect((await hidden.json()).rows).toEqual([]);
      await picker.fill('Robin');
      await page.getByRole('option', { name: 'Robin Bell', exact: true }).click();
      await form.getByLabel('Assignment reason', { exact: false }).fill('Scoped North desk allocation');
      await form.getByRole('button', { name: 'Assign reviewer', exact: true }).click();
      await expect(form.getByRole('status')).toHaveAttribute('data-phase', 'success');
      expect(stored(app)).toMatchObject({ loan: { reviewer_id: 3, version: 1 }, history: [{ assigned_to: 3 }] });
      expect(await form.evaluate((element) => element.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
      for (const path of ['update', 'revert']) {
        const denied = await page.request.post(`${app.origin}/api/${path}?app=${COMMAND_APP_ID}`, { data: {} });
        expect(denied.status()).toBe(path === 'revert' ? 404 : 403);
      }
      expect(stored(app).loan).toEqual({ reviewer_id: 3, version: 1 });
    });

  test('lost scoped response replays the exact submission without a second assignment', async ({ page }) => {
    const envelopes: unknown[] = [];
    await page.route('**/api/commands/execute*', async (route) => {
      envelopes.push(route.request().postDataJSON());
      if (envelopes.length > 1) {
        await route.continue();
        return;
      }
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort('failed');
    });
    const form = await open(page, app);
    await form.getByRole('combobox', { name: 'Reviewer (required)', exact: true }).fill('Robin');
    await page.getByRole('option', { name: 'Robin Bell', exact: true }).click();
    await form.getByLabel('Assignment reason', { exact: false }).fill('Scoped retry proof');
    await form.getByRole('button', { name: 'Assign reviewer', exact: true }).click();
    await form.getByRole('button', { name: 'Retry same submission' }).click();
    await expect(form.getByRole('status')).toHaveAttribute('data-phase', 'success');
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).toEqual(envelopes[1]);
    expect(stored(app)).toMatchObject({ loan: { reviewer_id: 3, version: 1 }, history: [{ assigned_to: 3 }] });
  });
});
