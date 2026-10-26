/**
 * Tenancy, in a browser, on a real two-realm App — the first such proof in this
 * repository.
 *
 * Every other tenant browser spec runs on a fixture App built for the test. This
 * one runs on Ignition as an operator deploys it: two PostgreSQL databases seeded
 * by `examples/databases/ignition/seed-postgres.mjs`, real native accounts, real
 * memberships, `--policy`, `--commands`, `--jobs`.
 *
 * What makes it a proof rather than a demonstration: the three active
 * dealerships hold the *same* business references. `L-2001` and `AL-1001` exist
 * in all three. So a screen showing `L-2001` says nothing on its own — the
 * question is always *whose* `L-2001`, and every assertion here is written on a
 * value that differs between dealerships (the applicant's email domain, the
 * applicant reference, the opaque record key) rather than on the reference the
 * reader sees.
 */
import { expect, test } from './support/harness';
import { DEALERS, IGNITION_SKIP, startIgnition, type IgnitionFixture } from './support/ignitionServer';
import {
  contextName,
  enter,
  LENDER,
  offeredContexts,
  openRoom,
  openRow,
  recordField,
  signIn,
  switchTo,
  workspaceReady,
} from './support/ignitionSession';

test.describe('Ignition tenancy', () => {
  test.skip(IGNITION_SKIP !== false, String(IGNITION_SKIP));
  test.setTimeout(120_000);
  let app: IgnitionFixture;
  /* One deployment for the file: seeding creates fourteen native accounts and
     about seven hundred rows over two fresh databases, and no test here changes
     what another reads. */
  test.beforeAll(async () => {
    // Two databases seeded and a server started: the setting above times the tests, not this hook (Playwright).
    test.setTimeout(120_000);
    app = await startIgnition();
  });
  test.afterAll(async () => {
    await app?.stop();
  });

  /** The lead every dealership has, opened in whichever dealership this tab is in. */
  async function openSharedLead(page: import('@playwright/test').Page) {
    await openRoom(page, 'lead');
    await openRow(page, 'L-2001');
  }

  test('the signed-in staff door opens the workspace and ordinary focus changes do not pause it', async ({ page }) => {
    await signIn(page, app, app.account('manager').email);
    await page.goto(`${app.origin}/sign-in?realm=platform`);
    await page.getByRole('list', { name: 'Available dealers' }).getByRole('button', { name: LENDER, exact: true }).click();
    await workspaceReady(page);
    await expect(page).toHaveURL(`${app.origin}/?realm=platform`);
    await expect(page.locator('#content')).not.toContainText('Fix the query above');
    await expect(page.locator('#table-list .rows')).toHaveCount(0);
    const paused = await page.evaluate(async () => {
      let paused = false;
      const observer = new MutationObserver(() => {
        paused ||= document.body.classList.contains('tenant-suspended');
      });
      observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      window.dispatchEvent(new Event('blur'));
      paused ||= document.body.classList.contains('tenant-suspended');
      window.dispatchEvent(new Event('focus'));
      await new Promise((resolve) => setTimeout(resolve, 500));
      observer.disconnect();
      return paused;
    });
    expect(paused).toBe(false);
  });

  test('two dealerships hold the same references, and each reader only ever sees their own', async ({ page, browser }) => {
    const north = app.account('dealer_admin', DEALERS.north);
    await enter(page, app, north.email, DEALERS.north);
    await openSharedLead(page);
    await expect(recordField(page, 'Applicant email')).toHaveText('applicant-1@north.example.invalid');
    const northKey = new URL(page.url()).pathname;
    expect(northKey).toContain(encodeURIComponent(`${DEALERS.north}:lead:0001`));

    /* The same room, the same reference, a different dealership — in its own
       browser context, because a tenant context belongs to the tab. */
    const other = await browser.newContext();
    try {
      const harbourPage = await other.newPage();
      const harbour = app.account('dealer_admin', DEALERS.harbor);
      await enter(harbourPage, app, harbour.email, DEALERS.harbor);
      await openSharedLead(harbourPage);
      await expect(recordField(harbourPage, 'Applicant email')).toHaveText('applicant-1@harbor.example.invalid');
      const harbourKey = new URL(harbourPage.url()).pathname;
      expect(harbourKey).toContain(encodeURIComponent(`${DEALERS.harbor}:lead:0001`));
      expect(harbourKey).not.toBe(northKey);

      /* And neither counts the other. Return to the authorized list: each
         dealership holds eight leads; the three of them together hold
         twenty-four, and no reader is ever told so. */
      for (const [reader, where] of [
        [page, DEALERS.north],
        [harbourPage, DEALERS.harbor],
      ] as const) {
        await openRoom(reader, 'lead');
        await reader.getByRole('tab', { name: /^All/ }).click();
        await expect(reader.locator('.applist-count'), where).toHaveText('8');
      }
    } finally {
      await other.close();
    }
  });

  test("a dealership cannot reach another dealership's record by asking for it", async ({ page }) => {
    const north = app.account('dealer_admin', DEALERS.north);
    await enter(page, app, north.email, DEALERS.north);
    await openSharedLead(page);
    /* Harbor's own key, pasted into North's lease. The key is opaque and this
       reader could not have guessed it; the fixture knows it because the seed
       is deterministic, which is exactly the adversary worth testing. */
    const harbourKey = `${DEALERS.harbor}:lead:0001`;
    await page.evaluate(
      (to) => {
        window.history.pushState(null, '', to);
        window.dispatchEvent(new PopStateEvent('popstate'));
      },
      `/leads/@lead~${encodeURIComponent(harbourKey)}?tenant=${DEALERS.north}`,
    );
    /* Nothing of Harbor's is drawn — not the row, not a field of it. The screen
       may say the record is gone or refuse the address; what it may never do is
       answer with another dealership's applicant. */
    await expect(page.locator('#content')).not.toContainText('applicant-1@harbor.example.invalid');
    await expect(page.getByRole('button', { name: `Dealer: ${contextName(DEALERS.north)}` })).toBeVisible();
  });

  test('one person with two memberships gets one dealership per choice, never both at once', async ({ page }) => {
    /* The seed grants exactly one person two memberships, which is what makes
       per-tab switching something a test can drive rather than describe. */
    const both = [...app.accounts.values()].find((entry) => entry.roles.length === 2);
    expect(both, 'the seed grants one person two dealership memberships').toBeDefined();
    const offered = await offeredContexts(page, app, both!.email);
    expect([...offered].sort()).toEqual([DEALERS.harbor, DEALERS.north].map(contextName).sort());

    await page
      .getByRole('list', { name: 'Available dealers' })
      .getByRole('button', { name: contextName(DEALERS.north), exact: true })
      .click();
    await workspaceReady(page);
    await openSharedLead(page);
    await expect(recordField(page, 'Applicant email')).toHaveText('applicant-1@north.example.invalid');

    await switchTo(page, DEALERS.north, DEALERS.harbor);
    await expect(page.getByRole('button', { name: `Dealer: ${contextName(DEALERS.harbor)}` })).toBeVisible();
    await openSharedLead(page);
    await expect(recordField(page, 'Applicant email')).toHaveText('applicant-1@harbor.example.invalid');
  });

  test("a dealership's rooms are its own four tables, and none of the lender's", async ({ page }) => {
    const north = app.account('dealer_admin', DEALERS.north);
    await enter(page, app, north.email, DEALERS.north);
    const tables = await page
      .locator('#table-list button[data-table]')
      .evaluateAll((buttons) => [...new Set(buttons.map((button) => (button as HTMLElement).dataset.table))].sort());
    /* The lender's tables are not merely filtered out of these lists: they are
       absent from a dealership's catalog, so no room could name one. */
    for (const lenders of [
      'review_file',
      'application_review',
      'loan_decision',
      'assignment_history',
      'review_alert',
      'intake_submission',
      'dealer',
      'lender_staff',
      'review_desk',
      'applicants.applicant',
    ]) {
      expect(tables, lenders).not.toContain(lenders);
    }
    expect(tables).toEqual(expect.arrayContaining(['lead', 'loan_application', 'vehicle']));
  });

  test("each realm's menu draws its own headings and rooms, and none of the other realm's", async ({ page, browser }) => {
    /* Rooms by table say nothing here, and that is the point. The lender's
       "Document checklist" reads `application_document` — the dealership's own
       table — so it passes the check above and used to be drawn in a
       dealership's menu, under the lender's own headings, answering with the
       dealership's 48 documents. Which realm a room belongs to is authored, and
       it is the only thing that may decide who is offered it, so this test reads
       the menu the way a person does: by its words. */
    type Reader = import('@playwright/test').Page;
    /* Words, not their rendering: Mono sets the current room in capitals (docs/design.md). */
    const rooms = async (reader: Reader) => (await reader.locator('.sidebar .nav-label').allTextContents()).map((text) => text.trim());
    /* The sidebar draws a heading uppercased, so the words are compared in one
       case rather than as the stylesheet happens to render them. */
    const headings = async (reader: Reader) =>
      (await reader.locator('.sidebar [role="heading"]').allInnerTexts()).map((text) => text.trim().toLowerCase());
    const lower = (words: readonly string[]) => words.map((word) => word.toLowerCase());
    /* Rooms only one realm has. "Leads" and "Applications" are deliberately in
       both — the lender's are the same lists across every dealership — so they
       discriminate nothing and are left out. */
    const DEALER_ONLY = ['Dealership', 'New leads', 'Inventory'];
    const LENDER_ONLY = ['Document checklist', 'Review files', 'Overdue reviews', 'Dealerships'];
    const LENDER_HEADINGS = [
      'Lending',
      'Review records',
      'Desks',
      'Review clock',
      'Intake',
      'Dealerships',
      'People',
      'Applicant directory',
    ];

    const north = app.account('dealer_admin', DEALERS.north);
    await enter(page, app, north.email, DEALERS.north);
    expect(await rooms(page)).toEqual(expect.arrayContaining(DEALER_ONLY));
    expect(await headings(page)).toEqual(['work']);
    // Not the lender's rooms — "Document checklist" included, which reads the
    // dealership's own table and so resolves here perfectly well.
    for (const room of LENDER_ONLY) expect(await rooms(page), room).not.toContain(room);
    for (const heading of lower(LENDER_HEADINGS)) expect(await headings(page), heading).not.toContain(heading);

    /* And the lender, in its own context: the platform realm's catalog holds
       every table, so nothing about a dealership's rooms fails to resolve there
       — only the realm keeps them out. */
    const other = await browser.newContext();
    try {
      const lender = await other.newPage();
      await enter(lender, app, app.account('manager').email, LENDER);
      expect(await rooms(lender)).toEqual(expect.arrayContaining(LENDER_ONLY));
      expect(await headings(lender)).toEqual(expect.arrayContaining(lower(LENDER_HEADINGS)));
      for (const room of DEALER_ONLY) expect(await rooms(lender), room).not.toContain(room);
      expect(await headings(lender)).not.toContain('work');
    } finally {
      await other.close();
    }
  });
});
