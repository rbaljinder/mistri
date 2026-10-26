import { expect, test } from './support/harness';
import { startSample } from './support/sampleServer';
import { scalar } from './support/db';

/* An issue's status moves only through Thread's actions: the server refuses any
   other change, a new issue starts where the form says, and Cancel issue asks
   why and keeps the reason with the issue. */
test.describe('Thread transitions', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.beforeAll(async () => {
    // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
    test.setTimeout(120_000);
    sample = await startSample('thread');
  });
  test.afterAll(async () => {
    await sample?.stop();
  });

  test('status moves through the actions only, and Cancel issue keeps its reason', async ({ page }) => {
    const id = 2;
    const status = () => scalar(sample.db, `SELECT status FROM issue WHERE id=${id}`);
    expect(status()).toBe('ready');

    // A new issue starts at the form's backlog: the form does not ask for a status.
    await page.goto(`${sample.origin}/issue`);
    await page.getByRole('button', { name: '+ New issue', exact: true }).click();
    const form = page.locator('.newpanel');
    await expect(form.getByLabel('Name', { exact: true })).toBeVisible();
    await expect(form.getByLabel('Status', { exact: true })).toHaveCount(0);
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();

    // The server refuses a move no action makes, and the issue stays where it was.
    const refused = await page.request.post(`${sample.origin}/api/update`, {
      data: { app: 'thread', table: 'issue', key: { id }, values: { status: 'done' } },
    });
    expect(refused.ok()).toBe(false);
    expect(await refused.text()).toMatch(/moves only by its machine's verbs/);
    expect(status()).toBe('ready');

    // The action whose `when` holds moves it.
    await page.goto(`${sample.origin}/@issue~${id}`);
    await page.getByRole('button', { name: 'Start work', exact: true }).click();
    await expect.poll(status).toBe('in_progress');

    // Cancel issue asks why; its own Cancel writes nothing; the reason is written with the change.
    // The head draws the forward verbs; cancelling waits in More.
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Cancel issue/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel issue: reason' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(status()).toBe('in_progress');
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Cancel issue/ }).click();
    await dialog.getByLabel('Reason').fill('Duplicate of an earlier issue');
    await dialog.getByRole('button', { name: 'Cancel issue', exact: true }).click();
    await expect.poll(status).toBe('canceled');
    expect(scalar(sample.db, `SELECT cancel_note FROM issue WHERE id=${id}`)).toBe('Duplicate of an earlier issue');
  });
});
