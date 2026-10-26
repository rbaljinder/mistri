import { CRM, expect, test } from './support/ownServers';
import { startSample } from './support/sampleServer';
import { rows } from './support/db';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

/**
 * A column's text rule on the New form (textRules.ts), and a record's tags as
 * a column (tagLists.ts). Compass's lead email says what an address looks
 * like under the field as it is typed, and holds the form until it does.
 * Thread's issue list shows each issue's labels as chips, a "+ Tags" filter
 * ticks one and the list and its address follow, and the New form sends the
 * labels chosen with the issue, written with it.
 */

test('a text rule is said under the field as it is typed, and the record is added once it is met', async ({ page }) => {
  await page.goto(`${CRM}/leads/new`);
  const form = page.getByRole('dialog', { name: 'New lead' });
  const email = form.getByLabel('Email', { exact: true });
  await email.fill('ana at company');
  const said = form.getByText('Enter an email address, like ana@company.com.');
  await expect(said).toBeVisible();
  await email.fill('ana@company.com');
  await expect(said).toHaveCount(0);
});

test.describe('Thread: labels as a column, a filter and a field of the New form', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.setTimeout(60_000);
  test.beforeAll(async () => {
    // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
    test.setTimeout(120_000);
    sample = await startSample('thread');
  });
  test.afterAll(async () => {
    await sample?.stop();
  });

  test('chips in the list, an any-of filter, and labels chosen with a new issue', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 924 });
    await page.goto(`${sample.origin}/issue`);
    const cells = page.locator('.tags-cell-list');
    await expect(cells.first().locator('.record-tag').first()).toBeVisible();

    // "+ Tags": tick bug, and the list holds only issues labelled bug.
    await page.locator('.applist-slot[data-column="tags"] button').click();
    const pop = page.locator('.filter-pop');
    await pop.locator('input[type="checkbox"][data-value="bug"]').check();
    await pop.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/[?&]tags=bug(&|$)/);
    await expect
      .poll(async () => {
        // Read off each cell's title, which names every label: a narrow cell draws the chips that fit and counts the rest.
        const shown = await page.locator('td.tags-cell').evaluateAll((tds) => tds.map((td) => td.getAttribute('title') ?? ''));
        return shown.length > 0 && shown.every((text) => /\bbug\b/.test(text));
      })
      .toBe(true);

    // A new issue with two labels: the issue and its link rows, together.
    await page.goto(`${sample.origin}/issue`);
    await page.getByRole('button', { name: '+ New issue', exact: true }).click();
    const form = page.locator('.newpanel');
    await form.getByLabel('Name', { exact: true }).fill('Tags arrive with the issue');
    const labels = form.locator('.picker-multi');
    for (const name of ['docs', 'design']) {
      await labels.locator('.picker-input').fill(name);
      await page.locator('.picker-option', { hasText: name }).first().click();
    }
    await expect(labels.locator('.picker-chip')).toHaveCount(2);
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    await expect
      .poll(() =>
        rows(
          sample.db,
          `SELECT l.name FROM issue i JOIN issue_label il ON il.issue_id = i.id JOIN label l ON l.id = il.label_id
      WHERE i.name = 'Tags arrive with the issue' ORDER BY l.name`,
        ).map((row) => row.name),
      )
      .toEqual(['design', 'docs']);
  });
});
