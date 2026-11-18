import { DatabaseSync } from 'node:sqlite';
import { COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournalSchema';
import { expect, test, type Page } from './support/harness';
import { startProposalsApp } from './support/aiProposalsServer';
import { SLOW_MS } from './support/budgets';

/* The whole loop of an AI proposal, through the real assistant (a scripted model): the assistant drafts a command
   instead of running it, the person sees it waiting in For review, approves one and dismisses the other. The approved
   one runs as the approver, and its receipt names the proposal the AI made; the dismissed one changes nothing. */
type Fixture = Awaited<ReturnType<typeof startProposalsApp>>;

async function login(page: Page, app: Fixture) {
  const response = await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin },
    data: { email: app.account.email, password: app.account.password },
  });
  expect(response.ok(), await response.text()).toBe(true);
}
function read<T>(app: Fixture, sql: string, ...values: Array<string | number>): T[] {
  const db = new DatabaseSync(app.database, { readOnly: true, timeout: 5000 });
  try {
    return db.prepare(sql).all(...values) as T[];
  } finally {
    db.close();
  }
}
const claim = (app: Fixture, id: number) =>
  read<{ status: string; note: string | null }>(app, 'SELECT status, note FROM claim WHERE id=?', id)[0];
type Proposal = { id: string; command: string; actor_kind: string; state: string; decided_by: string | null; reason: string | null };
const proposals = (app: Fixture) =>
  read<Proposal>(
    app,
    `SELECT id, command, actor_kind, state, decided_by, reason FROM "${COMMAND_JOURNAL_TABLES.proposal}" ORDER BY created_at`,
  );

async function ask(page: Page, words: string) {
  const panel = page.getByRole('complementary', { name: 'Assistant' });
  const sent = await panel.locator('.assistant-person').count();
  await panel.getByRole('textbox', { name: 'Message the assistant' }).fill(words);
  await panel.getByRole('textbox', { name: 'Message the assistant' }).press('Enter');
  await expect(panel.locator('.assistant-person')).toHaveCount(sent + 1);
  await expect(panel.locator('.assistant-body')).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 });
}

test.describe('AI proposals', () => {
  test.setTimeout(SLOW_MS);
  let app: Fixture;
  test.beforeEach(async () => {
    app = await startProposalsApp();
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  test('an AI proposal waits for review, runs as its approver when approved, and leaves the queue when dismissed', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, app);
    await page.goto(`${app.origin}/claims`);

    // Nothing is waiting yet, so the nav has no For review key.
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.locator('.review-trigger')).toHaveCount(0);

    await page.locator('.assistant-trigger').click();
    await ask(page, 'Please appeal the crown claim');
    await ask(page, 'Please close the cleaning claim');

    // The assistant drafted both and ran neither.
    const drafted = proposals(app);
    expect(drafted.map((p) => [p.command, p.actor_kind, p.state])).toEqual([
      ['sendAppeal', 'assistant', 'proposed'],
      ['closeClaim', 'assistant', 'proposed'],
    ]);
    expect(claim(app, 1).status).toBe('open');
    expect(claim(app, 2).status).toBe('open');

    await page.goto(`${app.origin}/review`);
    await expect(page.getByRole('button', { name: 'For review, 2 waiting' })).toBeVisible();
    const room = page.locator('main');
    await expect(room.locator('#review-room-title')).toBeVisible();
    const appeal = room.locator(`li.review-row[data-proposal="${drafted[0]!.id}"]`);
    const close = room.locator(`li.review-row[data-proposal="${drafted[1]!.id}"]`);
    await expect(appeal).toBeVisible();
    await expect(appeal).toContainText('The denial cites a missing X-ray that is on file.');
    await expect(close).toBeVisible();

    await appeal.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.locator('#toast').getByText('Approved.', { exact: true })).toBeVisible();
    await expect(appeal).toHaveCount(0);
    await expect.poll(() => claim(app, 1)).toEqual({ status: 'appealed', note: 'The crown was medically necessary.' });

    // The receipt is the approver's, and it names the proposal the AI made.
    const session = await page.request.get(`${app.origin}/api/auth/get-session`, { headers: { origin: app.origin } });
    const approver = ((await session.json()) as { user: { id: string } }).user.id;
    const approved = proposals(app).find((p) => p.id === drafted[0]!.id)!;
    expect(approved).toMatchObject({ actor_kind: 'assistant', state: 'approved', decided_by: approver });
    const receipts = read<{ actor_id: string; actor_kind: string; proposal_id: string | null }>(
      app,
      `SELECT actor_id, actor_kind, proposal_id FROM "${COMMAND_JOURNAL_TABLES.receipt}" WHERE proposal_id IS NOT NULL`,
    );
    expect(receipts).toEqual([{ actor_id: approver, actor_kind: 'person', proposal_id: drafted[0]!.id }]);

    // The record's history names both hands: the AI that proposed the write and the person who approved it.
    await page.goto(`${app.origin}/claims/1`);
    const written = page.locator('.history-entry').filter({ hasText: 'Send appeal' });
    await expect(written.locator('.history-by')).toHaveText(/Proposed by AI · approved by Dana Clerk/);
    await expect(written.locator('.history-by .ai-mark')).toBeVisible();
    await page.goto(`${app.origin}/review`);

    await close.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(page.locator('#toast').getByText('Dismissed.', { exact: true })).toBeVisible();
    await expect(close).toHaveCount(0);
    expect(proposals(app).find((p) => p.id === drafted[1]!.id)).toMatchObject({ state: 'dismissed', decided_by: approver });
    expect(claim(app, 2).status).toBe('open');

    // An approved proposal's write is the AI's value, so its fields wait in Unconfirmed until a person confirms them;
    // confirming both leaves nothing waiting, and the nav key goes.
    const unconfirmed = room.getByRole('region', { name: 'Unconfirmed' });
    await expect(unconfirmed.getByRole('listitem')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'For review, 2 waiting' })).toBeVisible();
    await unconfirmed.getByRole('listitem').first().getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(unconfirmed.getByRole('listitem')).toHaveCount(1);
    await unconfirmed.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.locator('.review-trigger')).toHaveCount(0);
    await page.reload();
    await expect(room.locator('#review-room-title')).toBeVisible();
    await expect(room.locator('li.review-row')).toHaveCount(0);
    await expect(room.getByRole('region', { name: 'Unconfirmed' })).toHaveCount(0);
  });
});
