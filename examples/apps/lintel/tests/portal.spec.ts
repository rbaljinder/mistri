/** The resident portal, on a desk and on a phone: their own household, and a problem reported from it. */
import { expect, fitsTheWidth, open, signIn, test } from './browser.ts';

test('a resident reports a problem and follows it from their portal', async ({ page, lintel, isMobile }) => {
  await signIn(page, lintel, 'resident');
  await expect(page.getByText('Balance due').first()).toBeVisible();
  if (isMobile) await fitsTheWidth(page);

  await open(page, lintel, '/report');
  const title = `Hallway light flickers ${isMobile ? 'phone' : 'desk'} ${Date.now()}`;
  // Three steps under one progress bar: the problem, in icon cards; the details; how to visit.
  await expect(page.getByRole('heading', { level: 1, name: 'What’s wrong?' })).toBeVisible();
  await page.getByRole('textbox', { name: /^What’s wrong\?/ }).fill(title);
  await page.getByRole('radio', { name: 'Electrical' }).check({ force: true });
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tell us more' })).toBeVisible();
  await page.getByRole('textbox', { name: /^Tell us more/ }).fill('It started on Sunday evening.');
  await page.getByRole('radio', { name: 'No' }).check({ force: true });
  await page.getByRole('button', { name: 'Continue' }).click();
  const day = page.getByRole('textbox', { name: /^Day that suits you/ });
  // "May we let ourselves in?" No asks for a day and a part of it, in one row; Yes would not.
  await expect(page.getByRole('heading', { level: 1, name: 'How should we visit?' })).toBeVisible();
  // Unanswered is neither: the day waits for a No.
  await expect(day).toHaveCount(0);
  await page.getByRole('radio', { name: 'Yes' }).check({ force: true });
  await expect(day).toHaveCount(0);
  await page.getByRole('radio', { name: 'No' }).check({ force: true });
  await expect(day).toHaveValue('');
  const when = new Date(Date.now() + 3 * 86_400_000);
  await day.fill(`${String(when.getMonth() + 1).padStart(2, '0')}/${String(when.getDate()).padStart(2, '0')}/${when.getFullYear()}`);
  await page.getByRole('button', { name: /^Time of day/ }).click();
  await page.getByRole('option', { name: /^Morning/ }).click();
  await page.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByText('Report sent')).toBeVisible();

  const made = lintel.rows<{ resident_id: number; unit_id: number; status: string }>(
    `SELECT resident_id, unit_id, status FROM maintenance_request WHERE title = ?`,
    title,
  );
  expect(made).toEqual([{ resident_id: lintel.resident.id, unit_id: lintel.resident.unit, status: 'new' }]);

  await open(page, lintel, '/my-requests');
  await expect(page.getByText(title).filter({ visible: true }).first()).toBeVisible();
  if (isMobile) await fitsTheWidth(page);
});

test('a resident reports a problem from their home, in a dialog over it', async ({ page, lintel }) => {
  await signIn(page, lintel, 'resident');
  await open(page, lintel, `/units/${lintel.resident.unit}`);
  await page.getByRole('link', { name: 'Report a problem' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { level: 2, name: 'What’s wrong?' })).toBeVisible();
  // The home stays under the dialog; Escape returns to it.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/(units|listings)/${lintel.resident.unit}$`));
});
