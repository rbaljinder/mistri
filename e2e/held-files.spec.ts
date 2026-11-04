import { SLOW_MS } from './support/budgets';
/**
 * A public command form's files and signature, in a browser: a file the field
 * does not take is refused in the server's words, pictures are sent as they
 * are picked and shown by name with a Remove, a signature is typed on the pad
 * and kept, and the submission lands each file as a row of its resource under
 * the repair the command wrote, nothing left held. It starts its own server
 * over a disposable database (support/intakeServer.ts, the Repairs fixture), so
 * it shares nothing with another spec.
 *
 * `HELD_FILES_SHOTS=<dir>` writes the field empty, with two files held, and the
 * pad there instead of the test's output folder.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { expect, test } from './support/harness';
import { startIntakeApp } from './support/intakeServer';

type Fixture = Awaited<ReturnType<typeof startIntakeApp>>;

/* A one-pixel PNG: the server holds a picture by what its bytes are, not by the type the browser claims. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function read<T>(app: Fixture, sql: string): T[] {
  const db = new DatabaseSync(app.database, { readOnly: true, timeout: 5000 });
  try {
    return db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }) as T);
  } finally {
    db.close();
  }
}

test.describe("A command form's files", () => {
  test.setTimeout(SLOW_MS);
  let app: Fixture;
  test.beforeEach(async () => {
    app = await startIntakeApp([], 'repairs');
  });
  test.afterEach(async () => {
    await app?.stop();
  });

  test('refuses a file the field does not take, holds pictures as they are picked, and lands them on the repair', async ({
    page,
  }, info) => {
    const shot = (name: string) => (process.env.HELD_FILES_SHOTS ? join(process.env.HELD_FILES_SHOTS, name) : info.outputPath(name));
    await page.goto(`${app.origin}/form/report`);
    const form = page.getByRole('region', { name: 'Report a repair' }).locator('form');
    await page.getByRole('textbox', { name: /^What needs fixing\?/ }).fill('The brakes squeal');
    const photos = page.getByRole('group', { name: /^Photos/ });
    // The drop area is drawn on demand, the first time a form asks for files.
    await expect(photos.getByRole('button', { name: '+ Choose files' })).toBeVisible({ timeout: 30_000 });
    await form.screenshot({ path: shot('files-empty.png'), animations: 'disabled' });

    // A file the field does not take: refused by the server, said beside the field, nothing held.
    const picker = photos.locator('input[type=file]');
    await picker.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a picture') });
    await expect(photos.getByRole('alert')).toContainText('notes.txt was not sent');
    await expect(photos.getByRole('alert')).toContainText('image/*');

    await picker.setInputFiles([
      { name: 'front.png', mimeType: 'image/png', buffer: PNG },
      { name: 'back.png', mimeType: 'image/png', buffer: PNG },
    ]);
    await expect(photos.getByRole('button', { name: 'Remove back.png' })).toBeVisible();
    await expect(photos.getByRole('button', { name: 'Preview front.png' })).toBeVisible();
    await expect(photos.getByRole('progressbar')).toHaveCount(0);
    await form.screenshot({ path: shot('files-two-held.png'), animations: 'disabled' });
    // A file let go before the form is sent is not sent.
    await photos.getByRole('button', { name: 'Remove back.png' }).click();
    await expect(photos.getByRole('button', { name: 'Remove back.png' })).toHaveCount(0);

    // Sent without a signature: the form says what is missing, and nothing is written.
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Signature is required.')).toBeVisible();
    expect(read(app, 'SELECT id FROM repair')).toHaveLength(0);

    await page.getByRole('button', { name: 'Type instead' }).click();
    await page.getByPlaceholder('Type your full name').fill('Ada Brackwater');
    await page.locator('.signature-input').screenshot({ path: shot('signature-pad.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Use this signature' }).click();
    await expect(page.getByRole('img', { name: 'Signature: the kept signature' })).toBeVisible();

    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Your repair is in').first()).toBeVisible();
    const [repair] = read<{ id: number; title: string }>(app, 'SELECT id, title FROM repair');
    expect(repair).toMatchObject({ title: 'The brakes squeal' });
    expect(read(app, 'SELECT repair_id, file_name, content_type, byte_size FROM repair_photo')).toEqual([
      { repair_id: repair!.id, file_name: 'front.png', content_type: 'image/png', byte_size: PNG.byteLength },
    ]);
    expect(read(app, 'SELECT repair_id, file_name, content_type FROM repair_signature')).toEqual([
      { repair_id: repair!.id, file_name: 'signature.png', content_type: 'image/png' },
    ]);
    // Taken with the command; the one let go stays held until its day is out, never on the repair.
    expect(read(app, 'SELECT name FROM "__mistri_staged_file"')).toEqual([{ name: 'back.png' }]);
  });
});
