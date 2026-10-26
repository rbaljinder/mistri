import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test, type Page } from './support/harness';
import { LOANER_ADMIN, startSample } from './support/sampleServer';
import { rows, scalar } from './support/db';

type Sample = Awaited<ReturnType<typeof startSample>>;
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

async function signIn(page: Page, sample: Sample) {
  const response = await page.request.post(`${sample.origin}/api/auth/sign-in/email`, {
    headers: { origin: sample.origin },
    data: LOANER_ADMIN,
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function checkoutForm(page: Page, sample: Sample, borrower: string) {
  await page.goto(`${sample.origin}/@equipment~camera`);
  await page.getByRole('button', { name: 'Check out', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Check out', exact: true });
  await expect(form.getByRole('status')).toContainText('Ready to submit');
  await form.getByRole('combobox', { name: 'Borrower (required)', exact: true }).fill(borrower);
  await page.getByRole('option', { name: borrower, exact: true }).click();
  await form.getByRole('textbox', { name: 'Due on (required)', exact: true }).fill(tomorrow());
  return form;
}

async function stop(sample: Sample) {
  await sample.stop();
  rmSync(dirname(sample.db), { recursive: true, force: true });
}

test.describe('Loaner Desk guarded operations', () => {
  test.setTimeout(90_000);

  test('checkout and return use command forms and keep loan dates and availability together', async ({ page }) => {
    const sample = await startSample('loaner-desk');
    try {
      await signIn(page, sample);
      let plainWrites = 0;
      page.on('request', (request) => {
        if (/^\/api\/(insert|update|delete)$/.test(new URL(request.url()).pathname)) plainWrites++;
      });
      const form = await checkoutForm(page, sample, 'Ada Brooks');
      await form.getByRole('button', { name: 'Check out', exact: true }).click();
      await expect(form.getByRole('status')).toHaveAttribute('data-phase', 'success');
      await expect(form.getByRole('status')).toContainText('Camera kit checked out to Ada Brooks.');
      expect(rows(sample.db, 'SELECT borrower_id, status, returned_on FROM equipment_loan')).toEqual([
        { borrower_id: 'ada', status: 'open', returned_on: null },
      ]);
      expect(scalar(sample.db, "SELECT status FROM equipment WHERE id = 'camera'")).toBe('checked_out');
      await form.getByRole('button', { name: 'Done', exact: true }).click();

      await page.goto(`${sample.origin}/@equipment_loan~1`);
      // Return asks nothing, so it runs on one click with no dialog (df773272) and its notice says what it did.
      const beforeReturnDay = new Date().toISOString().slice(0, 10);
      await page.getByRole('button', { name: 'Return', exact: true }).click();
      await expect(page.locator('#toast')).toContainText('Camera kit returned and available again.');
      await expect(page.getByRole('dialog', { name: 'Return', exact: true })).toHaveCount(0);
      expect(scalar(sample.db, 'SELECT status FROM equipment_loan WHERE id = 1')).toBe('returned');
      expect([beforeReturnDay, new Date().toISOString().slice(0, 10)]).toContain(
        scalar(sample.db, 'SELECT returned_on FROM equipment_loan WHERE id = 1'),
      );
      expect(scalar(sample.db, "SELECT status FROM equipment WHERE id = 'camera'")).toBe('available');
      expect(plainWrites).toBe(0);
    } finally {
      await stop(sample);
    }
  });

  test('a second prepared checkout visibly refuses stale state without claiming success', async ({ page }) => {
    const sample = await startSample('loaner-desk');
    const second = await page.context().newPage();
    try {
      await signIn(page, sample);
      const firstForm = await checkoutForm(page, sample, 'Ada Brooks');
      const secondForm = await checkoutForm(second, sample, 'Ben Chen');
      await firstForm.getByRole('button', { name: 'Check out', exact: true }).click();
      await expect(firstForm.getByRole('status')).toHaveAttribute('data-phase', 'success');
      const refusal = second.waitForResponse((response) => new URL(response.url()).pathname === '/api/commands/execute');
      await secondForm.getByRole('button', { name: 'Check out', exact: true }).click();
      const response = await refusal;
      expect(response.status()).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'stale_record', outcome: 'not_applied' });
      await expect(secondForm).toBeVisible();
      await expect(secondForm.getByRole('status')).toHaveText('The record has changed. Reload it before trying again.');
      await expect(secondForm.getByRole('status')).not.toHaveAttribute('data-phase', 'success');
      expect(rows(sample.db, 'SELECT borrower_id, status, returned_on FROM equipment_loan')).toEqual([
        { borrower_id: 'ada', status: 'open', returned_on: null },
      ]);
      expect(scalar(sample.db, "SELECT version FROM equipment WHERE id = 'camera'")).toBe(1);
    } finally {
      await second.close();
      await stop(sample);
    }
  });
});
