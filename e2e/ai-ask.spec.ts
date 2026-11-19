import { resolve } from 'node:path';
import { expect, test, type Page } from './support/harness';
import { startProposalsApp } from './support/aiProposalsServer';
import { SLOW_MS } from './support/budgets';

/* Ask, through the real assistant (a scripted model): opened from a list's toolbar and from the palette, a question
   is answered with the query it ran, in the App's query language, and the records it read, each opening as its
   record. The model reads as the signed-in clerk; nothing is written. */
type Fixture = Awaited<ReturnType<typeof startProposalsApp>>;

async function login(page: Page, app: Fixture) {
  const response = await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin },
    data: { email: app.account.email, password: app.account.password },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function ask(page: Page, words: string) {
  const panel = page.getByRole('complementary', { name: 'Assistant' });
  const box = panel.getByRole('textbox', { name: 'Ask about your records' });
  await box.fill(words);
  await box.press('Enter');
  await expect(panel.locator('.assistant-body')).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 });
  return panel;
}

test.describe('Ask', () => {
  test.setTimeout(SLOW_MS);
  let app: Fixture;
  test.beforeEach(async () => {
    app = await startProposalsApp({ script: resolve('test/fixtures/apps/ai-proposals/ask.json') });
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  test('a question from the list or the palette shows the query it ran and the records it read, each a link', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, app);
    await page.goto(`${app.origin}/claims`);
    await expect(page.getByRole('heading', { name: 'Claims', level: 1 })).toBeVisible();

    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    const panel = await ask(page, 'Which claims are open?');
    await expect(panel.getByText('Both claims are open.')).toBeVisible();
    const read = panel.getByRole('region', { name: 'Ran' });
    await expect(read.locator('code')).toHaveText('claim show id, name, status sort id');
    await expect(read).toContainText('2 rows');
    const rows = read.getByRole('list', { name: 'Records read' }).getByRole('button');
    await expect(rows).toHaveText(['Corner dental, crown', 'Hart family, cleaning']);
    // Nothing to confirm: an Ask reads.
    await expect(panel.getByRole('region', { name: 'Proposed change' })).toHaveCount(0);

    // Each row read opens as its record.
    await rows.nth(1).click();
    await expect(page).toHaveURL(/\/claims\/2$/);

    // The palette opens the same Ask, on a fresh conversation.
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('combobox', { name: 'Search' }).fill('Ask');
    await page.locator('.palette-item', { hasText: /^Ask/ }).first().click();
    const again = page.getByRole('complementary', { name: 'Assistant' });
    await expect(again.getByRole('region', { name: 'Ran' })).toHaveCount(0);
    await ask(page, 'Are any claims open?');
    await expect(again.getByRole('region', { name: 'Ran' })).toHaveCount(1);
  });
});
