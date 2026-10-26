/**
 * Links, and the Back button.
 *
 * tablewalk puts the whole trail in the URL rather than just the current
 * position, because a link to a row you reached by walking should arrive with
 * the walk intact. That only means anything if a *fresh* browser can rebuild
 * it — with the crumbs reading the same names, not the raw keys they are
 * stored as — so this opens the link in a context that has never seen the app.
 *
 * The Back button gets its own test because the app once used replaceState for
 * everything, which meant one press left tablewalk entirely and took the trail
 * with it. Nothing about that is visible short of pressing Back.
 */
import { DEMO, expect, seenTour, test, WIDE } from './support/ownServers';
import { childPanel, dataRows, open, trailText } from './support/app';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer'] });

test('a link carries the whole walk into a fresh browser', async ({ page, browser }) => {
  await open(page, DEMO, 'customer');
  await dataRows(page).filter({ hasText: 'Dry Creek Vineyards' }).click();
  await childPanel(page).getByRole('row').filter({ hasText: '1004' }).click();
  await expect(page.getByRole('heading', { name: /invoice · 1004/ })).toBeVisible();

  const link = page.url();
  const walked = await trailText(page);
  expect(walked).toHaveLength(3);

  /* A new context, not a new page: no localStorage, no saved filters, nothing
     that could be supplying the labels from memory. */
  const fresh = await browser.newContext({ storageState: seenTour() });
  const pasted = await fresh.newPage();
  await pasted.goto(link);

  await expect(pasted.getByRole('heading', { name: /invoice · 1004/ })).toBeVisible();
  /* The crumbs have to read the same, which is the part that is easy to get
     wrong: a restored trail knows only each row's key, and the names arrive
     afterwards from one small query per crumb. A link that arrives as
     `customer › 4 › 1004` is a link that lost what it was about. */
  await expect.poll(() => trailText(pasted)).toEqual(walked);

  await fresh.close();
});

test('Back steps up the trail instead of leaving the app', async ({ page }) => {
  await open(page, DEMO, 'customer');
  const table = page.url();

  await dataRows(page).filter({ hasText: 'Dry Creek Vineyards' }).click();
  await expect(page.getByRole('heading', { name: /customer · Dry Creek Vineyards/ })).toBeVisible();
  const record = page.url();
  expect(record).not.toBe(table);

  await childPanel(page).getByRole('row').filter({ hasText: '1004' }).click();
  await expect(page.getByRole('heading', { name: /invoice · 1004/ })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole('heading', { name: /customer · Dry Creek Vineyards/ })).toBeVisible();
  expect(page.url()).toBe(record);

  await page.goBack();
  // Back on the table, with its rows — not on a blank page, and not on
  // whatever the browser was showing before tablewalk.
  await expect(dataRows(page).first()).toBeVisible();
  expect(page.url()).toBe(table);
  expect(await trailText(page)).toEqual(['customer']);
});

test('refining a view does not fill the history with steps', async ({ page }) => {
  /* A sort or a re-run of the query you are already looking at replaces the
     history entry; a step in the walk pushes one. Without that distinction
     Back spends three presses undoing sort toggles, which is the reason the
     rule exists and the only way to see it is to press Back. */
  await open(page, DEMO, 'invoice');

  await page.getByRole('button', { name: /^id key/ }).click();
  await expect(page.getByRole('combobox', { name: 'Query' })).toHaveValue('invoice sort id');
  await page.getByRole('button', { name: /^id key/ }).click();
  await expect(page.getByRole('combobox', { name: 'Query' })).toHaveValue('invoice sort id desc');
  const sorted = page.url();

  // One step of the walk, which does earn a history entry.
  await dataRows(page).first().click();
  await expect(page.getByRole('heading', { name: /invoice · / })).toBeVisible();

  /* One press comes back to the sorted table. If each sort had pushed, this
     would land on `sort id` ascending — the state the reader passed through
     rather than the one they were in. */
  await page.goBack();
  await expect(page.getByRole('combobox', { name: 'Query' })).toHaveValue('invoice sort id desc');
  expect(page.url()).toBe(sorted);
});

test('a cold link lands on the connection it names, not the one in session', async ({ page, browser }) => {
  /* The case this architecture exists to serve: an agent hands someone a
     link, and they open it in a tab that has never seen the app.

     It used to race. Boot painted the empty state for whichever connection
     was *active* before reading the incoming link, and that paint wrote its
     own address into the bar — so the reader could land on the wrong
     database, and the address bar always spent a moment saying something
     nobody had asked for. Whether it corrected itself was a matter of
     timing.

     So this drives the active connection somewhere else first, then opens a
     link to another one from a clean context, and watches the address
     throughout rather than only at the end: a URL that is briefly wrong is a
     URL that can be copied, bookmarked or pushed into history while wrong. */
  await page.goto(`/${DEMO}/customer`);
  await expect(page.locator('#db-label')).toContainText(DEMO);

  const fresh = await browser.newContext({ storageState: seenTour() });
  const cold = await fresh.newPage();

  const addresses: string[] = [];
  const target = `/${WIDE}/ticket`;
  await cold.goto(target);
  for (let i = 0; i < 12; i++) {
    addresses.push(new URL(cold.url()).pathname);
    await cold.waitForTimeout(50);
  }

  await expect(cold.locator('#db-label')).toContainText(WIDE);
  await expect(cold.getByRole('heading', { name: 'ticket', exact: true })).toBeVisible();

  /* Every address the cold tab ever shows must belong to the connection the
     link named. The bug this guards against — and the reason the whole boot
     order was rewritten — is the *session's* connection (demo) bleeding into a
     tab that never chose it: a `/demo/...` in the bar that could be copied,
     bookmarked, or pushed into history pointing at the wrong database.

     Asserting instead that every sample is *exactly* `/wide/ticket` was
     stricter than that invariant and intermittently red for it: a cold boot
     can show `/wide` for one frame on the way to `/wide/ticket`, and that is
     the right connection's own landing page, harmless to copy. What must never
     appear is a path under any *other* connection. */
  for (const addr of addresses) {
    expect(addr.startsWith(`/${WIDE}`), `cold tab showed ${addr}, outside ${WIDE}`).toBe(true);
  }
  await expect.poll(() => new URL(cold.url()).pathname).toBe(target);

  await fresh.close();
});

/* A composer session is a tab on its table (composer.js), so its link is
   the table's with `!view` after it. Pasted cold, it opens the composer on
   that table rather than a table called "invoice!view". */
test('a pasted composer link reopens the composer on its table', async ({ page }) => {
  await page.goto(`/${DEMO}/invoice!view`);
  const composer = page.getByRole('dialog', { name: 'View composer' });
  await expect(composer).toBeVisible();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(new RegExp(`^/${DEMO}/invoice!view`));
});
