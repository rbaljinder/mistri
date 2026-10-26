/**
 * The ordered workflow strip, on a tenant-owned record.
 *
 * Ignition declares two — the lead's gate and the application's — and until this
 * file neither had ever been drawn in a test. The strip is read-only by design:
 * it draws the order the author wrote down and where this row stands in it, and
 * it moves nothing. What moves a record is the command the action bar offers, so
 * the strip and the action bar are asserted together on the same record.
 *
 * Paired with tenancy on purpose. Every dealership holds `AL-1001`, so a strip
 * drawn beside that reference proves nothing by itself; each case here reads a
 * value that differs between dealerships (`applicant_ref`, which the seed
 * numbers across the whole book) beside the strip, so the strip is shown to be
 * drawn from *this* dealership's row.
 *
 * Not asserted, because it does not happen: the strip's `data-reachable` mark.
 * It is computed from a record's fixed *update* actions (`useReachable` in
 * `components/Actions.tsx` filters commands out), and every Ignition action is a
 * command — so no step of either strip is ever marked reachable. See the report
 * that came with this file.
 */
import { expect, test, type Page } from './support/harness';
import { DEALERS, IGNITION_SKIP, startIgnition, type IgnitionFixture } from './support/ignitionServer';
import { enter, LENDER, openRoom, openRow, recordField } from './support/ignitionSession';

/** The strip's steps, each as its label and its state. */
const strip = (page: Page) =>
  page.locator('.workflow-steps li').evaluateAll((items) =>
    items.map((item) => ({
      label: item.textContent?.replace(/\s*\((passed|available from here)\)\s*$/, '').trim(),
      state: item.getAttribute('aria-current') === 'step' ? 'current' : item.hasAttribute('data-passed') ? 'passed' : 'ahead',
    })),
  );

/** The verbs the open record offers, in the order the bar draws them. */
const actions = (page: Page) => page.locator('.page-head-actions .page-action');

test.describe('Ignition workflow strips', () => {
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

  test('the lead gate draws where this lead stands, and only the steps already passed', async ({ page }) => {
    await enter(page, app, app.account('dealer_admin', DEALERS.north).email, DEALERS.north);
    await openRoom(page, 'lead');

    // L-2001 is `new`: the first step is current and nothing is behind it.
    await openRow(page, 'L-2001', true);
    await expect(page.locator('.workflow-steps')).toHaveAttribute('aria-label', 'Workflow status');
    await expect
      .poll(() => strip(page))
      .toEqual([
        { label: 'Draft', state: 'passed' },
        { label: 'New', state: 'current' },
        { label: 'Qualified', state: 'ahead' },
        { label: 'Converted', state: 'ahead' },
      ]);
    await expect(recordField(page, 'Applicant email')).toHaveText('applicant-1@north.example.invalid');
    /* The lead's own verbs, beside the strip. Three are declared on `lead` and
       this admin holds all three, so what is drawn is the `when` of each: on a
       `new` lead, Qualify and Disqualify, and not Convert. They are asserted
       because they once all vanished together — a record offering more than one
       command asked about them in one request, and the request failed. */
    await expect(actions(page)).toHaveText(['Qualify lead', 'Disqualify']);

    // L-2003 is `qualified`: the step before it is drawn as passed.
    await page.locator('.crumbs button', { hasText: 'Leads' }).click();
    await openRow(page, 'L-2003', true);
    await expect
      .poll(() => strip(page))
      .toEqual([
        { label: 'Draft', state: 'passed' },
        { label: 'New', state: 'passed' },
        { label: 'Qualified', state: 'current' },
        { label: 'Converted', state: 'ahead' },
      ]);
    /* A qualified lead is past Qualify and ready to convert: the forward verb
       is the filled one, and Disqualify, named destructive in the header, is
       drawn last and quiet. */
    await expect(actions(page)).toHaveText(['Convert to application', 'Disqualify']);
    await expect(page.locator('.page-head-actions .page-action.btn-primary')).toHaveText('Convert to application');
  });

  test('the application strip moves with the row, and the action bar is what could move it', async ({ page }) => {
    await enter(page, app, app.account('dealer_admin', DEALERS.north).email, DEALERS.north);
    await openRoom(page, 'loan_application');

    // AL-1001 is `submitted`: the start of the gate, with the dealership's own
    // last word — Withdraw — offered on it.
    await openRow(page, 'AL-1001', true);
    await expect
      .poll(() => strip(page))
      .toEqual([
        { label: 'Submitted', state: 'current' },
        { label: 'In review', state: 'ahead' },
        { label: 'With a manager', state: 'ahead' },
        { label: 'Approved', state: 'ahead' },
      ]);
    await expect(page.getByRole('button', { name: 'Withdraw application', exact: true })).toBeVisible();
    // The seed numbers applicant references across the whole book, so this one
    // says which dealership's `AL-1001` the strip above was drawn from.
    await expect(page.locator('#content')).toContainText('APPLICANT-0001');

    // AL-1003 is `in_review`: two steps behind it, three ahead.
    await page.locator('.crumbs button', { hasText: 'Applications' }).click();
    await openRow(page, 'AL-1003', true);
    await expect
      .poll(() => strip(page))
      .toEqual([
        { label: 'Submitted', state: 'passed' },
        { label: 'In review', state: 'current' },
        { label: 'With a manager', state: 'ahead' },
        { label: 'Approved', state: 'ahead' },
      ]);

    /* AL-1006 is `approved`: the strip is full, and the dealership's Withdraw is
       gone because its `when` no longer holds. The strip never decided that —
       the action's own condition did. It is on the `Decided` tab, since the room
       opens on what is still in flight; the tab's name carries its count. */
    await page.locator('.crumbs button', { hasText: 'Applications' }).click();
    await page.getByRole('tab', { name: /^Decided/ }).click();
    await openRow(page, 'AL-1006', true);
    await expect
      .poll(() => strip(page))
      .toEqual([
        { label: 'Submitted', state: 'passed' },
        { label: 'In review', state: 'passed' },
        { label: 'With a manager', state: 'passed' },
        { label: 'Approved', state: 'current' },
      ]);
    await expect(page.getByRole('button', { name: 'Withdraw application', exact: true })).toHaveCount(0);
  });

  test('the lender reads the same application on its own page, its activity beside it', async ({ page }) => {
    /* The dealership's page of this row is in the tenant realm, where the
       lender's tables are not in the schema; the lender's is a platform-realm
       page over the same tenant-owned table, so its reviews, decisions and
       assignments are one timeline beside the strip. */
    await enter(page, app, app.account('manager').email, LENDER);
    await openRoom(page, 'loan_application');
    await page.getByRole('tab', { name: /^Decided/ }).click();
    await openRow(page, 'AL-1006', true);
    await expect
      .poll(() => strip(page))
      .toEqual([
        { label: 'Submitted', state: 'passed' },
        { label: 'In review', state: 'passed' },
        { label: 'With a manager', state: 'passed' },
        { label: 'Approved', state: 'current' },
      ]);
    await expect(page.locator('ol.timeline')).toContainText('Approved');
    // The dealership's last word is not the lender's to offer.
    await expect(page.getByRole('button', { name: 'Withdraw application', exact: true })).toHaveCount(0);
  });

  test("the same reference in another dealership draws that dealership's own strip", async ({ page }) => {
    await enter(page, app, app.account('dealer_admin', DEALERS.harbor).email, DEALERS.harbor);
    await openRoom(page, 'loan_application');
    await openRow(page, 'AL-1001', true);
    /* The same reference, the same position in the gate — and a different row:
       Harbor's first application is the seventeenth applicant in the book. Two
       dealerships reading `AL-1001` are reading two records, and each strip is
       drawn from the one its own reader owns. */
    await expect
      .poll(() => strip(page))
      .toEqual([
        { label: 'Submitted', state: 'current' },
        { label: 'In review', state: 'ahead' },
        { label: 'With a manager', state: 'ahead' },
        { label: 'Approved', state: 'ahead' },
      ]);
    await expect(page.locator('#content')).toContainText('APPLICANT-0017');
    expect(new URL(page.url()).pathname).toContain(encodeURIComponent(`${DEALERS.harbor}:application:0001`));
  });
});
