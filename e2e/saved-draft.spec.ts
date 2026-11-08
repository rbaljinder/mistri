/**
 * A signed-in form saved on every step, in a browser (design test 11): a person
 * starts it, goes two steps in and closes the browser; a new browser signed in as
 * the same person lands straight back in the draft at the step they were on, and
 * submits it. A second account opening the same form sees no draft. The server
 * and its database are this spec's own, so it runs beside others.
 */
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { SLOW_MS } from './support/budgets';
import { SAVED_DRAFT, startSavedFormApp } from './support/savedFormServer';

type Fixture = Awaited<ReturnType<typeof startSavedFormApp>>;
const PASSWORD = 'disposable-saved-draft-password';

/** Sign up, prove the address as following the mailed link would (`me` waits for it), and sign in: a fresh context. */
async function account(app: Fixture, name: string) {
  const email = `${name}@example.test`;
  const headers = { origin: app.origin };
  const made = await fetch(`${app.origin}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password: PASSWORD }),
  });
  expect(made.ok, await made.text()).toBe(true);
  const sessions = new DatabaseSync(app.sessions);
  try {
    sessions.prepare('UPDATE "user" SET emailVerified = 1 WHERE email = ?').run(email);
  } finally {
    sessions.close();
  }
  return email;
}

async function signedIn(browser: Browser, app: Fixture, email: string): Promise<BrowserContext> {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [{ origin: app.origin, localStorage: [{ name: 'mistri.tour.v1', value: 'done' }] }] },
  });
  const answer = await context.request.post(`${app.origin}/api/auth/sign-in/email`, {
    headers: { origin: app.origin },
    data: { email, password: PASSWORD },
  });
  expect(answer.ok(), await answer.text()).toBe(true);
  return context;
}

/** A step's text box: the page also names its steps and progress by the same words. */
const field = (page: Page, label: string) => page.getByRole('textbox', { name: new RegExp(`^${label}`) });

const rows = (app: Fixture) => {
  const db = new DatabaseSync(app.database, { readOnly: true, timeout: 5000 });
  try {
    return db
      .prepare('SELECT person_id, status, full_name, tier, resume_progress, reference FROM membership')
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
};

test.describe('A signed-in form saved on every step', () => {
  test.setTimeout(SLOW_MS);
  let app: Fixture;
  test.beforeEach(async () => {
    app = await startSavedFormApp([], SAVED_DRAFT);
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  test('a new browser signed in as the same person resumes the draft at its step and submits; another account sees none', async ({
    browser,
  }) => {
    const ann = await account(app, 'ann');
    const bob = await account(app, 'bob');

    // Two steps in, then the browser closes.
    const first = await signedIn(browser, app, ann);
    const page = await first.newPage();
    await page.goto(`${app.origin}/join`);
    await field(page, 'Full name').fill('Ann Lee');
    await page.getByRole('button', { name: 'Continue' }).click();
    await field(page, 'Tier').fill('team');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(field(page, 'Contact')).toBeVisible();
    await first.close();
    expect(rows(app)).toMatchObject([{ person_id: 1, status: 'in_progress', full_name: 'Ann Lee', tier: 'team' }]);

    // The same person in a new browser: straight back in at the third step, with a way to start over.
    const second = await signedIn(browser, app, ann);
    const back = await second.newPage();
    await back.goto(`${app.origin}/join`);
    await expect(field(back, 'Contact')).toBeVisible();
    await expect(back.getByRole('button', { name: 'Start over' })).toBeVisible();
    await field(back, 'Contact').fill('ann@work.test');
    await back.getByRole('button', { name: 'Continue' }).click();
    await expect(back.getByRole('heading', { name: 'Review' })).toBeVisible();
    // The review lists what step 1 and 2 saved in the earlier session, with this one's step.
    const review = back.locator('.form-review');
    await expect(review.getByText('Ann Lee')).toBeVisible();
    await expect(review.getByText('team')).toBeVisible();
    await expect(review.getByText('Saved earlier')).toHaveCount(0);
    await back.getByRole('checkbox', { name: /These details are true/ }).check();
    await back.getByRole('button', { name: 'Submit application' }).click();
    await expect(back.getByRole('heading', { name: 'Application received' })).toBeVisible();
    expect(rows(app)).toMatchObject([{ person_id: 1, status: 'submitted', reference: 'MEM-0001' }]);
    await second.close();

    // Another account opening the same form starts blank.
    const other = await signedIn(browser, app, bob);
    const blank = await other.newPage();
    await blank.goto(`${app.origin}/join`);
    await expect(field(blank, 'Full name')).toBeVisible();
    await expect(blank.getByRole('button', { name: 'Start over' })).toHaveCount(0);
    await other.close();
  });

  test('start over discards the draft and its rows and begins at the first step', async ({ browser }) => {
    const ann = await account(app, 'ann');
    const context = await signedIn(browser, app, ann);
    const page = await context.newPage();
    await page.goto(`${app.origin}/join`);
    await field(page, 'Full name').fill('Ann Lee');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(field(page, 'Tier')).toBeVisible();
    await page.reload();
    await expect(field(page, 'Tier')).toBeVisible();
    await page.getByRole('button', { name: 'Start over' }).click();
    await expect(field(page, 'Full name')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start over' })).toHaveCount(0);
    expect(rows(app)).toEqual([]);
    await context.close();
  });
});
