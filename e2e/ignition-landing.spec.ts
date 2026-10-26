/**
 * The two front doors, and the room behind each.
 *
 * Signed out, `/` is the lender's public page: content only, no shell,
 * no query bar, and two calls to action that go where they say. Signed in, the
 * same address is the App — and which App it is depends on the membership that
 * admitted you, which is the half no single-tenant spec can reach. So this file
 * also carries the lender's own proof: the platform realm chooses `Lender`, not
 * a dealership, and lands on rooms built over the lender's own tables and on a
 * book that spans every dealership at once.
 */
import { expect, test, type Page } from './support/harness';
import { DEALER_NAMES, DEALERS, IGNITION_SKIP, startIgnition, type IgnitionFixture } from './support/ignitionServer';
import { LENDER, offeredContexts } from './support/ignitionSession';

const headline = (page: Page) => page.getByRole('heading', { level: 1, name: 'Finance your next car' });

/** The page and the content pane: neither may be wider than its window. */
async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const content = document.getElementById('content')!;
    return { page: root.scrollWidth - root.clientWidth, content: content.scrollWidth - content.clientWidth };
  });
  expect(overflow).toEqual({ page: 0, content: 0 });
}

test.describe("Ignition landing and the lender's realm", () => {
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

  test('a signed-out visitor meets the front page, and each call to action goes where it says', async ({ page }) => {
    await page.goto(`${app.origin}/`);
    await expect(headline(page)).toBeVisible();
    await expect(page.locator('h1')).toHaveCount(1);
    // The page is the landing: no sign-in screen, no sidebar, no query bar.
    await expect(page.locator('.signin')).toHaveCount(0);
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.getByRole('combobox', { name: 'Query' })).toHaveCount(0);
    for (const name of ['How it works', 'What you need', 'Questions', 'Have your quotation to hand?', 'Contact us']) {
      await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
    }
    await expect(page.getByRole('link', { name: 'applications@example.test' })).toHaveAttribute('href', 'mailto:applications@example.test');

    // The FAQ is an accordion: a real button over its answer, shut, then open.
    const question = page.getByRole('button', { name: 'Is Ignition a real lender?' });
    await expect(question).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText(/demonstration lender/)).toBeHidden();
    await question.click();
    await expect(question).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText(/demonstration lender/)).toBeVisible();

    await page.getByRole('link', { name: 'Apply for financing' }).first().click();
    await expect(page).toHaveURL(`${app.origin}/form/finance`);
    await expect(page.getByRole('heading', { name: 'Apply for financing' })).toBeVisible();
    await expect(page.getByText('Step 1 of 6')).toBeVisible();

    await page.goto(`${app.origin}/`);
    await page.getByRole('link', { name: 'Staff sign in' }).click();
    await expect(page).toHaveURL(`${app.origin}/sign-in`);
    await expect(page.locator('.signin')).toBeVisible();
    await expect(headline(page)).toHaveCount(0);
  });

  test("signing in at the staff door enters the account's one dealership, never the public front", async ({ page }) => {
    const north = app.account('dealer_admin', DEALERS.north);
    await page.goto(`${app.origin}/sign-in`);
    const signIn = page.locator('.signin');
    await signIn.getByLabel('Email').fill(north.email);
    await signIn.getByLabel('Password').fill(north.password);
    const opened = page.waitForResponse((reply) => new URL(reply.url()).pathname === '/api/tenant/context/open');
    await signIn.getByRole('button', { name: 'Sign in', exact: true }).click();
    /* A native sign-in grants nothing on its own: authority is the membership.
       This account has one, so it is entered without the chooser, said by its name. */
    expect((await opened).request().url()).toContain(`tenant=${DEALERS.north}`);
    await expect(page.getByRole('button', { name: `Dealer: ${DEALER_NAMES[DEALERS.north]}`, exact: true })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Available dealers' })).toHaveCount(0);
    await expect(page.locator('.front')).toHaveCount(0);
  });

  test('the lender enters its own realm and reads across every dealership at once', async ({ page }) => {
    const manager = app.account('manager');
    // The lender's people are offered the lender, and no dealership at all.
    expect(await offeredContexts(page, app, manager.email)).toEqual([LENDER]);
    await page.getByRole('list', { name: 'Available dealers' }).getByRole('button', { name: LENDER, exact: true }).click();
    await expect(page.locator('.sidebar')).toBeVisible();
    // The chip says the lender by its label, never the reserved platform id.
    await expect(page.getByRole('button', { name: LENDER, exact: true })).toBeVisible();

    /* Rooms over the lender's own tables — every one of which is absent from a
       dealership's catalog (see ignition-tenancy.spec.ts). */
    const tables = await page
      .locator('#table-list button[data-table]')
      .evaluateAll((buttons) => [...new Set(buttons.map((button) => (button as HTMLElement).dataset.table))]);
    expect(tables).toEqual(
      expect.arrayContaining(['review_file', 'intake_submission', 'dealer', 'lender_staff', 'review_desk', 'applicants.applicant']),
    );

    /* And the book itself. The lender's home is the portfolio, and it breaks the
       book down by dealership — sixteen applications in each of the three active
       ones. A dealership's own home counts sixteen and is never told there are
       others; this is the same data read from the realm above. */
    const content = page.locator('#content');
    await expect(content).toContainText('Book by dealer and stage');
    /* Each dealership by its name, as a grid says the same reference, and
       never by the id its rows are grouped on. */
    for (const dealer of [DEALERS.north, DEALERS.harbor, DEALERS.valley]) {
      await expect(content.locator('.page-breakdown-rows'), dealer).toContainText(DEALER_NAMES[dealer]);
      await expect(content, dealer).not.toContainText(dealer);
    }
    // The suspended dealership holds no rows, so the breakdown never names it.
    await expect(content.locator('.page-breakdown-rows')).not.toContainText(DEALER_NAMES[DEALERS.suspended]);
  });

  test('at phone width the front page fits, closed or open, and nothing scrolls sideways', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${app.origin}/`);
    await expect(headline(page)).toBeVisible();
    await expectNoSidewaysScroll(page);
    for (const trigger of await page.locator('.front-questions .accordion-trigger').all()) await trigger.click();
    await expect(page.locator('.front-questions .accordion-trigger[aria-expanded="true"]')).toHaveCount(5);
    await expectNoSidewaysScroll(page);
    // The calls to action are full-width targets at this size.
    const box = await page.getByRole('link', { name: 'Apply for financing' }).first().boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});
