import { readFile } from 'node:fs/promises';
import { expect, test } from './support/harness';
import { startSample } from './support/sampleServer';
import { scalar } from './support/db';

/* Thread's issue files: listed on the issue, each a download of the stored
   bytes and, for text, a preview; a new one attached from the page, a row
   with its name, type and size bound to the issue; one renamed in its row
   and one removed after a confirmation that says Undo cannot bring it back. */
test.describe('Thread attachments', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.beforeAll(async () => {
    // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
    test.setTimeout(120_000);
    sample = await startSample('thread');
  });
  test.afterAll(async () => {
    await sample?.stop();
  });

  test('an issue lists its files, previews and downloads one as stored, and attaches another', async ({ page }) => {
    await page.goto(`${sample.origin}/issue/~1`);
    const files = page.locator('.attachments');
    const repro = files.getByRole('button', { name: 'repro-steps.txt', exact: true });
    await expect(repro).toBeVisible();
    await expect(files.getByRole('button', { name: 'error-log.txt', exact: true })).toBeVisible();

    await repro.click();
    const preview = page.getByRole('dialog', { name: 'Preview of repro-steps.txt' });
    await expect(preview.getByLabel('repro-steps.txt')).toContainText('Rotate to landscape');
    await preview.getByRole('button', { name: 'Close' }).click();
    await expect(preview).toBeHidden();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      files.getByRole('link', { name: 'Download repro-steps.txt', exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('repro-steps.txt');
    expect(await readFile((await download.path())!, 'utf8')).toContain('Rotate to landscape');

    await files.getByLabel('Attach file', { exact: true }).setInputFiles({
      name: 'trace.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"ok":true}'),
    });
    await expect(files.getByRole('status')).toHaveText('Attached “trace.json”');
    await expect(files.getByRole('button', { name: 'trace.json', exact: true })).toBeVisible();
    expect(
      scalar(sample.db, "SELECT byte_size || ' ' || content_type || ' ' || issue_id FROM attachment WHERE file_name = 'trace.json'"),
    ).toBe('11 application/json 1');
  });

  test('a file is renamed in its row, and removed only once asked', async ({ page }) => {
    await page.goto(`${sample.origin}/issue/~1`);
    const files = page.locator('.attachments');
    await files.getByRole('button', { name: 'More for error-log.txt' }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const box = files.getByLabel('File name');
    await box.fill('crash-log.txt');
    await box.press('Enter');
    await expect(files.getByRole('button', { name: 'crash-log.txt', exact: true })).toBeVisible();
    expect(scalar(sample.db, "SELECT COUNT(*) FROM attachment WHERE file_name = 'crash-log.txt'")).toBe(1);

    await files.getByRole('button', { name: 'More for crash-log.txt' }).click();
    await page.getByRole('menuitem', { name: 'Remove…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Remove crash-log.txt?' });
    await expect(confirm).toContainText('Undo cannot bring it back');
    await confirm.getByRole('button', { name: 'Remove' }).click();
    await expect(files.getByRole('button', { name: 'crash-log.txt', exact: true })).toBeHidden();
    expect(scalar(sample.db, "SELECT COUNT(*) FROM attachment WHERE file_name = 'crash-log.txt'")).toBe(0);
  });

  test('a file past the cap is refused on the page and never sent', async ({ page }) => {
    await page.goto(`${sample.origin}/issue/~2`);
    const files = page.locator('.attachments');
    await expect(files.getByRole('button', { name: 'layout-notes.md', exact: true })).toBeVisible();
    await files.getByLabel('Attach file', { exact: true }).setInputFiles({
      name: 'too-big.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    await expect(files.getByRole('alert')).toContainText('“too-big.bin” is over the 10 MB limit for a file.');
    expect(scalar(sample.db, "SELECT COUNT(*) FROM attachment WHERE file_name = 'too-big.bin'")).toBe(0);
  });
});
