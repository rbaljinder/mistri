/**
 * The public intake form: where an application lands, and what a visitor may learn.
 *
 * The form asks for no dealer code — deliberately, because a typed code is
 * guessable and refusing an unknown one would say which dealerships exist. The
 * dealership is decided by the intake address on the link it published, which
 * only the server resolves, and anything that address does not place goes to the
 * lender's triage with the identical answer.
 *
 * The form is saved on every step: each step is its own submission, resolved
 * from the link's address every time, and saved into the place it resolved to.
 * So there are three things to prove here, and they pull against each other:
 * the application really does land in the one dealership whose `?via=` link
 * was used (checked by signing in as that dealership and finding it, and as
 * another and not); a visitor who applies through no link at all cannot tell
 * the difference from the answer; and a draft started through one dealership's
 * link cannot be continued through another's.
 */
import { expect, test, type Page } from './support/harness';
import { DEALERS, IGNITION_SKIP, startIgnition, type IgnitionFixture } from './support/ignitionServer';
import { enter, openRoom } from './support/ignitionSession';

async function next(page: Page, heading: string) {
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
}

/** The first step: who is applying. Saved on Next, into the place the link resolves to. */
async function aboutYou(page: Page, applicant: string) {
  await expect(page.getByRole('heading', { name: 'Apply for financing' })).toBeVisible();
  await expect(page.getByText('Step 1 of 6')).toBeVisible();
  await page.getByLabel('Full name', { exact: false }).fill(applicant);
  await page.getByLabel('Email', { exact: false }).fill(`${applicant.toLowerCase().replace(/\W+/g, '-')}@example.invalid`);
}

/** Every step, each saved as it is left, the review, the submit; and the reference the server made. */
async function apply(page: Page, applicant: string): Promise<string> {
  await aboutYou(page, applicant);
  await next(page, 'Address');
  await page.getByLabel('Street address', { exact: false }).fill('12 Demonstration Row');
  await page.getByLabel('City', { exact: false }).fill('Example City');
  await page.getByRole('textbox', { name: /^State/ }).fill('ny');
  await page.getByLabel('ZIP code', { exact: false }).fill('10001');
  await next(page, 'Income');
  await page.getByLabel('Employer', { exact: false }).fill('Example Logistics');
  await page.getByLabel('Annual income', { exact: false }).fill('64000');
  await next(page, 'The loan');
  await page.getByLabel('Vehicle stock number', { exact: false }).fill('DEMO-STOCK-1011');
  await page.getByLabel('Amount to finance', { exact: false }).fill('21000');
  await page.getByLabel('Down payment', { exact: false }).fill('2500');
  await page.getByRole('radio', { name: '48 months', exact: true }).check();
  await next(page, 'Co-applicant');
  await page.getByRole('button', { name: 'Add row to Co-applicants' }).click();
  await page.getByLabel('Full name', { exact: false }).fill(`${applicant} Junior`);
  await page.getByLabel('Email', { exact: false }).fill('junior@example.invalid');
  // The last step is the review, drawn from the page's memory before the one submit.
  await next(page, 'Review');
  await expect(page.getByText(applicant, { exact: true })).toBeVisible();
  // Sent unchecked, the box that must be checked is caught here and said once, beside it, in a person's words.
  const consent = page.getByRole('checkbox', { name: /The details I gave are true/ });
  await page.getByRole('button', { name: 'Submit application' }).click();
  await expect(consent).toBeFocused();
  await expect(page.getByText('Check this box to continue.')).toHaveCount(1);
  await expect(page.getByText(/command input/)).toHaveCount(0);
  await expect(page.locator('.form-page-failure:not([hidden])')).toHaveCount(0);
  // Its label is beside it and checks it.
  await page.locator('.form-field-check-row label', { hasText: 'The details I gave are true' }).click();
  await expect(consent).toBeChecked();
  await expect(page.getByText('Check this box to continue.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Submit application' }).click();
  await expect(page.getByRole('heading', { name: 'Application received' })).toBeVisible();
  const reference = (await page.locator('.form-page-reference strong').textContent())?.trim() ?? '';
  expect(reference).toMatch(/^IGN-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  return reference;
}

/**
 * Whether the dealership this tab is in holds a lead with that reference. The
 * Leads room opens on `Open` — `status = new or status = qualified` — and a
 * submission arrives as `new`, so this is the tab it would be in.
 *
 * `openRoom` leaves the room settled, which is what makes the negative answer
 * worth anything: without it, "no such row" and "the rows have not arrived" are
 * the same reading, and this used to be the flake. The count the room reports
 * is read here too, so a room that settled on nothing is a loud failure rather
 * than a quiet `false`.
 */
async function holdsLead(page: Page, reference: string): Promise<boolean> {
  await openRoom(page, 'lead');
  expect(
    Number((await page.locator('.applist-count').innerText()).replace(/\D/g, '')),
    "the dealership's Leads room is not empty, so a missing reference means missing",
  ).toBeGreaterThan(0);
  return (await page.locator('tbody tr', { hasText: reference }).count()) > 0;
}

test.describe('Ignition public intake', () => {
  test.skip(IGNITION_SKIP !== false, String(IGNITION_SKIP));
  test.setTimeout(120_000);
  let app: IgnitionFixture;
  test.beforeAll(async () => {
    // Two databases seeded and a server started: the setting above times the tests, not this hook (Playwright).
    test.setTimeout(120_000);
    app = await startIgnition();
  });
  test.afterAll(async () => {
    await app?.stop();
  });

  test("an application through a dealership's own link lands in that dealership and no other", async ({ page, browser }) => {
    await page.goto(`${app.origin}${app.intake(DEALERS.north)}`);
    // The form is the page: no shell behind it and no sign-in screen over it.
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('.signin')).toHaveCount(0);
    const reference = await apply(page, 'Mara Alder');

    const north = await browser.newContext();
    const harbour = await browser.newContext();
    try {
      const northPage = await north.newPage();
      await enter(northPage, app, app.account('dealer_admin', DEALERS.north).email, DEALERS.north);
      expect(await holdsLead(northPage, reference), 'the dealership whose link was used').toBe(true);
      // And it arrives as a lead at the start of that dealership's own gate.
      await northPage.locator('tbody tr', { hasText: reference }).first().click();
      await expect(northPage.locator('.workflow-steps li[aria-current="step"]')).toHaveText(/New/);

      const harbourPage = await harbour.newPage();
      await enter(harbourPage, app, app.account('dealer_admin', DEALERS.harbor).email, DEALERS.harbor);
      expect(await holdsLead(harbourPage, reference), 'a dealership whose link was not used').toBe(false);
    } finally {
      await north.close();
      await harbour.close();
    }
  });

  test('the form names no dealership, and an unplaced application is answered the same way', async ({ page, browser }) => {
    /* Nothing on the form asks which dealership, and nothing on it names one:
       not a code, not a list, not a hint in the copy. */
    await page.goto(`${app.origin}/form/finance`);
    /* allTextContents does not wait: read the labels once the form has drawn,
       or an empty list is the page still loading its surface, not an answer. */
    await expect(page.getByText('Step 1 of 6')).toBeVisible();
    expect(await page.locator('#content label').allTextContents()).toEqual(['Full name (required)', 'Email (required)', 'Phone']);
    const visible = await page.locator('#content').innerText();
    for (const dealer of Object.values(DEALERS)) expect(visible, dealer).not.toContain(dealer);
    for (const code of ['NORTH', 'HARBOR', 'VALLEY', 'PARKSIDE']) expect(visible, code).not.toContain(code);

    /* No `?via=` at all: the same steps, the same receipt, the same shape
       of reference. Nothing about the answer says it went to the lender. */
    const unplaced = await apply(page, 'Ines Brook');
    const placed = await page.goto(`${app.origin}${app.intake(DEALERS.valley)}`).then(() => apply(page, 'Otto Vane'));
    expect(unplaced).not.toBe(placed);
    // The prefix alone: the rest of a reference is random.
    expect(unplaced.slice(0, 4)).toBe(placed.slice(0, 4));

    // Only one of them is in a dealership. The other went to the lender's triage.
    const context = await browser.newContext();
    try {
      const valley = await context.newPage();
      await enter(valley, app, app.account('dealer_admin', DEALERS.valley).email, DEALERS.valley);
      expect(await holdsLead(valley, placed), 'the placed application').toBe(true);
      expect(await holdsLead(valley, unplaced), 'the unplaced application').toBe(false);
    } finally {
      await context.close();
    }
  });

  test("a draft started through one dealership's link is not continued through another's", async ({ page, browser }) => {
    // The first step is saved in North, and this browser keeps its place.
    await page.goto(`${app.origin}${app.intake(DEALERS.north)}`);
    await aboutYou(page, 'Wren Hale');
    await next(page, 'Address');

    /* The same browser, Harbor's link. The place this browser holds was issued
       in North, so under Harbor it names nothing: the page starts afresh, and
       the step it saves first is refused as a forged one is. Nothing about the
       answer says where the first draft is. */
    await page.goto(`${app.origin}${app.intake(DEALERS.harbor)}`);
    await aboutYou(page, 'Wren Hale');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('.form-page-failure')).toContainText('can no longer be continued');
    // A fresh start from here is Harbor's own draft.
    await aboutYou(page, 'Wren Hale');
    await next(page, 'Address');

    /* Neither dealership sees a draft among its leads: the lists over a saved
       form's root leave unfinished applications out. */
    const context = await browser.newContext();
    try {
      const north = await context.newPage();
      await enter(north, app, app.account('dealer_admin', DEALERS.north).email, DEALERS.north);
      await openRoom(north, 'lead');
      await expect(north.locator('tbody tr', { hasText: 'Wren Hale' })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('what a visitor may read is the form and the forms index, and nothing of the App', async ({ page }) => {
    await page.goto(`${app.origin}/form/nope`);
    await expect(page.locator('#content')).toContainText('There is no such form here.');
    /* The catalog, the schema and the App's own description are all behind the
       tenant lease, which a visitor holds none of. */
    for (const path of ['/api/app', '/api/schema']) {
      const refused = await page.request.get(`${app.origin}${path}`);
      expect([400, 401, 403], `${path} answered ${refused.status()}`).toContain(refused.status());
    }
    const listed = await page.request.get(`${app.origin}/api/forms`);
    expect(listed.status()).toBe(200);
    const body = JSON.stringify(await listed.json());
    // The public index names the App and its public forms. Never a dealership,
    // never an intake address, never a role or a table.
    for (const secret of [...Object.values(DEALERS), 'intake_address', 'loan_application', 'lender_staff']) {
      expect(body, secret).not.toContain(secret);
    }
  });
});
