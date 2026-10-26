/**
 * A public form saved on every step, in a browser: personal details, address,
 * income and a co-applicant, each saved to the App's own tables on Next; the
 * review drawn from the page's memory; a reload that keeps the application
 * and not its values; one submit. Throughout, no reply carries anything typed
 * and nothing typed reaches browser storage or the address.
 */
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from './support/harness';
import { SAVED_APP_ID, startSavedFormApp } from './support/savedFormServer';

type Fixture = Awaited<ReturnType<typeof startSavedFormApp>>;
const TYPED = [
  'Ada',
  'Lovelace',
  'ada@example.invalid',
  '12 Analytical Row',
  'Springfield',
  '02134',
  'Engine Works',
  'Charles Babbage',
  'charles@example.invalid',
];

function stored(app: Fixture) {
  const db = new DatabaseSync(app.database, { readOnly: true, timeout: 5000 });
  try {
    return {
      application: db
        .prepare('SELECT status, first_name, reference, resume_token_hash, resume_progress FROM application')
        .all()
        .map((row) => ({ ...row })),
      rows: ['applicant_address', 'income', 'co_applicant'].map((table) =>
        Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n),
      ),
    };
  } finally {
    db.close();
  }
}

async function next(page: Page, heading: string) {
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
}

test.describe('A public form saved on every step', () => {
  test.setTimeout(90_000);
  let app: Fixture;
  test.beforeEach(async () => {
    app = await startSavedFormApp();
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  test("each step lands in its table, the review is the page's own, a reload keeps the application and not the values", async ({
    page,
  }) => {
    const replies: string[] = [];
    page.on('response', async (response) => {
      if (new URL(response.url()).pathname.startsWith('/api/forms/') && response.request().method() === 'POST')
        replies.push(await response.text());
    });
    await page.goto(`${app.origin}/form/apply`);
    await expect(page.getByRole('heading', { name: 'Apply for financing' })).toBeVisible();
    await expect(page.getByText(/keep this tab open to review them before you submit/)).toBeVisible();
    const address = page.url();

    await page.getByLabel('First name', { exact: false }).fill('Ada');
    await page.getByLabel('Last name', { exact: false }).fill('Lovelace');
    await page.getByLabel('Email', { exact: false }).fill('ada@example.invalid');
    await next(page, 'Address');
    expect(stored(app).application).toMatchObject([{ status: 'in_progress', first_name: 'Ada', resume_progress: 'about-you' }]);
    // The cookie is the server's alone: the page cannot read it.
    expect(await page.evaluate(() => document.cookie)).toBe('');
    const cookies = await page.context().cookies();
    expect(cookies).toEqual([
      expect.objectContaining({ name: 'tw_form_apply', httpOnly: true, sameSite: 'Strict', path: '/api/forms/apply' }),
    ]);
    expect(stored(app).application[0].resume_token_hash).not.toBe(cookies[0].value);

    await page.getByLabel('Street address', { exact: false }).fill('12 Analytical Row');
    await page.getByLabel('City', { exact: false }).fill('Springfield');
    await page.getByLabel('ZIP code', { exact: false }).fill('02134');
    await next(page, 'Income');
    await page.getByLabel('Employer', { exact: false }).fill('Engine Works');
    await page.getByLabel('Annual income', { exact: false }).fill('84000');
    await next(page, 'Co-applicant');
    await page.getByRole('button', { name: 'Add row to Co-applicants' }).click();
    await page.getByLabel('Full name', { exact: false }).fill('Charles Babbage');
    await page.getByLabel('Email', { exact: false }).fill('charles@example.invalid');
    await next(page, 'Review');
    expect(stored(app).rows).toEqual([1, 1, 1]);
    // The review is what this page sent, from its memory.
    for (const value of ['Ada', 'Springfield', 'Engine Works', 'Charles Babbage'])
      await expect(page.getByText(value, { exact: false }).first()).toBeVisible();

    // Leaving now asks first; the reload is accepted, and the page comes back without the values.
    page.once('dialog', (dialog) => {
      expect(dialog.type()).toBe('beforeunload');
      void dialog.accept();
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Review' })).toBeVisible();
    await expect(page.getByText('Saved — not shown for your privacy')).toHaveCount(4);
    await expect(page.getByText('Ada', { exact: true })).toHaveCount(0);

    // Change one step, then submit without entering the others again.
    await page.getByRole('button', { name: 'Change Income' }).click();
    await page.getByLabel('Employer', { exact: false }).fill('Difference Engines');
    await page.getByLabel('Annual income', { exact: false }).fill('91000');
    await next(page, 'Review');
    await expect(page.getByText('Difference Engines')).toBeVisible();
    await expect(page.getByText('Saved — not shown for your privacy')).toHaveCount(3);
    // Sent unchecked, the handler's refusal is said once, beside the box, in a person's words, never under the actions.
    await page.getByRole('button', { name: 'Submit application' }).click();
    await expect(page.getByText('Check this box to continue.')).toHaveCount(1);
    await expect(page.getByText(/command input/)).toHaveCount(0);
    await expect(page.locator('.form-page-failure:not([hidden])')).toHaveCount(0);
    await page.getByLabel('The details I gave are true', { exact: false }).check();
    await page.getByRole('button', { name: 'Submit application' }).click();
    await expect(page.getByRole('heading', { name: 'Application received' })).toBeVisible();
    const reference = (await page.locator('.form-page-reference strong').textContent())?.trim() ?? '';
    expect(reference).toMatch(/^APP-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    await expect(page.getByText('Difference Engines')).toHaveCount(0);
    expect(stored(app)).toMatchObject({ application: [{ status: 'submitted', reference, resume_token_hash: null }], rows: [1, 1, 1] });
    // The draft's cookie is gone; the claim a submit leaves beside the receipt is the one left (saved-form-account.spec.ts).
    expect((await page.context().cookies()).map((cookie) => cookie.name)).toEqual(['tw_claim_apply']);

    // Write-only throughout: no reply said anything typed, and nothing typed is kept in the browser.
    expect(replies.length).toBeGreaterThan(5);
    for (const reply of replies) for (const value of [...TYPED, 'Difference Engines']) expect(reply).not.toContain(value);
    // The page's own conveniences (its look, say) may be there; nothing the applicant typed is.
    const kept = await page.evaluate(() =>
      [localStorage, sessionStorage].flatMap((store) => Object.keys(store).map((key) => `${key}=${store.getItem(key)}`)).join('\n'),
    );
    for (const value of [...TYPED, 'Difference Engines', reference]) expect(kept).not.toContain(value);
    expect(await page.evaluate(async () => (await indexedDB.databases?.())?.length ?? 0)).toBe(0);
    expect(page.url()).toBe(address);
  });
});
