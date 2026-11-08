/** The staff desk: the manager's Today, the rent roll, and a repair worked from its page. */
import { expect, fitsTheWidth, open, signIn, test } from './browser.ts';

test('the manager starts on Today and reads the buildings at a glance', async ({ page, lintel, isMobile }) => {
  await signIn(page, lintel, 'manager');
  // Today greets the person by the hour.
  await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ })).toBeVisible();
  await expect(page.getByText('Occupied homes').first()).toBeVisible();
  await expect(page.getByText('Repairs by state').first()).toBeVisible();
  if (isMobile) await fitsTheWidth(page);
});

test('a repair page holds the conversation, and its internal notes are the office’s', async ({ page, lintel }) => {
  await signIn(page, lintel, 'manager');
  const repair = lintel.rows<{ id: number; title: string }>(
    `SELECT m.id AS id, m.title AS title FROM maintenance_request m
      WHERE EXISTS (SELECT 1 FROM request_note n WHERE n.request_id = m.id AND n.kind = 'internal') ORDER BY m.id LIMIT 1`,
  )[0];
  const internal = lintel.rows<{ body: string }>(
    `SELECT body FROM request_note WHERE request_id = ? AND kind = 'internal' LIMIT 1`,
    repair.id,
  )[0];
  /* Followed from a link a resident shares — the repair at their address, My repairs — the office lands on the same
     repair at its own, the Repairs list's. */
  await open(page, lintel, `/my-requests/${repair.id}`);
  await expect(page).toHaveURL(new RegExp(`/repairs/${repair.id}$`));
  await expect(page.getByRole('heading', { name: repair.title })).toBeVisible();
  await expect(page.getByText('Conversation').first()).toBeVisible();
  await expect(page.getByText(internal.body)).toBeVisible();
});

test('the rent roll lists every home with its asking rent', async ({ page, lintel }) => {
  await signIn(page, lintel, 'manager');
  await open(page, lintel, '/units');
  const first = lintel.rows<{ code: string }>(`SELECT code FROM unit ORDER BY property_id, number LIMIT 1`)[0];
  await expect(page.getByText(first.code).filter({ visible: true }).first()).toBeVisible();
});

test('the desk’s New work order asks for the kind of problem as one row of choices', async ({ page, lintel, isMobile }) => {
  await signIn(page, lintel, 'manager');
  await open(page, lintel, '/repairs/new');
  // Five words with no description each: a row of inline choices, not a stack of cards (design.md, forms).
  const cards = page.locator('.choice-row');
  await expect(cards).toBeVisible();
  await expect(cards.getByRole('radio')).toHaveCount(5);
  await cards.getByRole('radio', { name: 'Plumbing' }).check({ force: true });
  await expect(cards.getByRole('radio', { name: 'Plumbing' })).toBeChecked();
  if (isMobile) await fitsTheWidth(page);
});

test('Add a charge asks for a lease, then a step at a time, and nothing it asks is refused', async ({ page, lintel }) => {
  await signIn(page, lintel, 'manager');
  // Every request the page makes is answered, the step check Continue asks included: Lintel's row policy once
  // refused that check outright, a console error on every step.
  const refused: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) refused.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  });
  await open(page, lintel, '/add-charge');
  await expect(page.getByText('Choose a lease').first()).toBeVisible();
  await page.locator('.kit-param').getByRole('button', { name: 'Lease' }).click();
  await page.getByRole('option').first().click();
  await expect(page.getByRole('heading', { level: 2, name: 'What is the charge for?' })).toBeVisible();
  await page.getByRole('radio', { name: 'Repair' }).check({ force: true });
  await page.getByLabel(/^Description/).fill('Replaced a cracked window');
  // Continue checks the first step on the server too.
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'How much, and when is it due?' })).toBeVisible();
  expect(refused).toEqual([]);
});
