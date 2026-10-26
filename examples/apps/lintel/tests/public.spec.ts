/** Signed out: the front page, the homes to let, a home's page, and a viewing asked for from it. */
import { expect, fitsTheWidth, open, test } from './browser.ts';

test('a visitor finds a home and asks to see it', async ({ page, lintel, isMobile }) => {
  await open(page, lintel, '/');
  await expect(page.getByRole('heading', { name: 'Homes in three Denver buildings, managed by people who answer' })).toBeVisible();
  await page.getByRole('link', { name: 'See homes to let' }).first().click();
  await expect(page.getByRole('heading', { name: 'Homes to let' })).toBeVisible();

  // A home's page, by the first listed home's address: its asking rent and the way to see it.
  const home = lintel.rows<{ id: number; code: string }>(`SELECT id, code FROM unit WHERE listed = 1 ORDER BY id LIMIT 1`)[0];
  await open(page, lintel, `/listings/${home.id}`);
  await expect(page.getByText('Water, trash and recycling included. No application fee.')).toBeVisible();
  await page.getByRole('link', { name: 'Ask for a viewing' }).first().click();

  const form = page.getByRole('dialog', { name: 'Ask for a viewing' });
  await expect(form.getByRole('textbox', { name: /^Home/ })).toHaveValue(home.code);
  const name = `Visitor ${isMobile ? 'phone' : 'desk'} ${Date.now()}`;
  await form.getByRole('textbox', { name: /^Your name/ }).fill(name);
  await form.getByRole('textbox', { name: /^Email/ }).fill('visitor@example.test');
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  await form.getByRole('textbox', { name: /^Day you would like to visit/ }).fill(day);
  await form.getByRole('button', { name: 'Ask for a viewing' }).click();
  await expect(page.getByText('Viewing requested')).toBeVisible();

  const asked = lintel.rows<{ unit_id: number; reference: string; status: string }>(
    `SELECT unit_id, reference, status FROM viewing WHERE name = ?`,
    name,
  );
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ unit_id: home.id, status: 'requested' });
  expect(asked[0].reference).toMatch(/^VW-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  if (isMobile) await fitsTheWidth(page);
});
