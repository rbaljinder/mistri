/** What each role is offered on the pages it shares: a work list for the technician, a verb only the desk holds, a resident's own page. */
import { expect, open, signIn, test } from './browser.ts';
import { emailOf } from './start.ts';

test('Today greets the manager by name', async ({ page, lintel }) => {
  await signIn(page, lintel, 'manager');
  const name = lintel.rows<{ name: string }>(`SELECT name FROM staff WHERE role = 'manager' LIMIT 1`)[0].name;
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(`^Good (morning|afternoon|evening), ${name}$`) })).toBeVisible();
});

test('a technician’s visits open on what is still to come, soonest first', async ({ page, lintel, isMobile }) => {
  test.skip(isMobile, 'the tab strip is the same on a phone; the order is read once');
  await signIn(page, lintel, 'technician');
  await open(page, lintel, '/my-repairs');
  await expect(page.getByText(/^Coming/).first()).toBeVisible();
  await expect(page.getByText(/^Past due/).first()).toBeVisible();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
  const coming = lintel.rows<{ title: string; scheduled_on: string }>(
    `SELECT m.title AS title, m.scheduled_on AS scheduled_on FROM maintenance_request m JOIN staff s ON s.id = m.assigned_to
      WHERE s.email = '${emailOf('technician')}' AND m.status IN ('scheduled', 'in_progress', 'on_hold') AND m.scheduled_on >= ?
      ORDER BY m.scheduled_on`,
    today,
  );
  expect(coming.length, 'the seed leaves the technician a visit still to come').toBeGreaterThan(0);
  // Said by where each title stands down the page: the list is drawn in the order it was asked for.
  const tops: number[] = [];
  for (const visit of coming) {
    const box = await page.getByText(visit.title).filter({ visible: true }).first().boundingBox();
    expect(box, `${visit.title} is listed`).not.toBeNull();
    tops.push(box!.y);
  }
  expect(tops).toEqual([...tops].sort((x, y) => x - y));
});

test('Cancel request is the desk’s: a technician is not offered it', async ({ page, lintel, isMobile }) => {
  test.skip(isMobile, 'the repair menu is the same on a phone');
  const repair = lintel.rows<{ id: number }>(
    `SELECT m.id AS id FROM maintenance_request m JOIN staff s ON s.id = m.assigned_to
      WHERE s.email = '${emailOf('technician')}' AND m.status = 'scheduled' ORDER BY m.id LIMIT 1`,
  )[0];
  await signIn(page, lintel, 'technician');
  await open(page, lintel, `/repairs/${repair.id}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Start work' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Cancel request' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.context().clearCookies();

  await signIn(page, lintel, 'manager');
  await open(page, lintel, `/repairs/${repair.id}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Cancel request' })).toBeVisible();
});

test('a resident reads their repair without a card about themselves or a history, and no building list', async ({
  page,
  lintel,
  isMobile,
}) => {
  const repair = lintel.rows<{ id: number }>(
    `SELECT id FROM maintenance_request WHERE resident_id = ? ORDER BY id DESC LIMIT 1`,
    lintel.resident.id,
  )[0];
  await signIn(page, lintel, 'resident');
  await open(page, lintel, `/my-requests/${repair.id}`);
  await expect(page.getByText('Conversation').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'History' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Resident', exact: true })).toHaveCount(0);
  await expect(page.getByText('View resident')).toHaveCount(0);
  // The sidebar's identity names the company, not the buildings a resident has no use for.
  // The sidebar is folded away on a phone.
  if (!isMobile) await expect(page.getByText('Lintel Property Co.').first()).toBeVisible();
  await expect(page.getByText(/Birchwood Lofts ·/)).toHaveCount(0);
});

test('a studio is said as a studio, not as 0 bd', async ({ page, lintel }) => {
  const studio = lintel.rows<{ id: number }>(`SELECT id FROM unit WHERE bedrooms = 0 ORDER BY id LIMIT 1`)[0];
  await signIn(page, lintel, 'manager');
  await open(page, lintel, `/units/${studio.id}`);
  await expect(page.getByText('Studio').first()).toBeVisible();
  await expect(page.getByText('0 bd')).toHaveCount(0);
});
