import { expect, test } from './support/harness';
import { startSample } from './support/sampleServer';
import { scalar } from './support/db';

/* Thread's labels: rows of label linked to an issue through issue_label,
   toned chips under the issue's title. One goes with its ×, another comes
   from the picker; each is one link row deleted or inserted. */
test.describe('Thread labels', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.beforeAll(async () => {
    // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
    test.setTimeout(120_000);
    sample = await startSample('thread');
  });
  test.afterAll(async () => {
    await sample?.stop();
  });

  test('an issue shows its labels, loses one and gains another', async ({ page }) => {
    const labels = () =>
      scalar(
        sample.db,
        `SELECT group_concat(name, ',') FROM (SELECT label.name AS name FROM issue_label
      JOIN label ON label.id = issue_label.label_id WHERE issue_label.issue_id = 3 ORDER BY label.name)`,
      );
    expect(labels()).toBe('accessibility,bug');
    await page.goto(`${sample.origin}/issue/~3`);
    const tags = page.getByRole('group', { name: 'Label', exact: true });
    await expect(tags.getByText('bug', { exact: true })).toBeVisible();
    await expect(tags.locator('.record-tag').filter({ hasText: 'bug' })).toHaveClass(/tone-bad/);

    await tags.getByRole('button', { name: 'Remove bug', exact: true }).click();
    await expect(tags.getByText('bug', { exact: true })).toHaveCount(0);
    expect(labels()).toBe('accessibility');

    await tags.getByRole('button', { name: '+ Add label', exact: true }).click();
    await tags.getByLabel('Add label', { exact: true }).fill('perf');
    await page.getByRole('option', { name: 'performance' }).click();
    await expect(tags.getByText('performance', { exact: true })).toBeVisible();
    expect(labels()).toBe('accessibility,performance');
  });
});
