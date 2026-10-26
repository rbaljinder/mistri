import { expect, test, type Page } from './support/harness';
import { FORECOURT_STAFF, startSample } from './support/sampleServer';
import { rows, scalar } from './support/db';

/**
 * Forecourt, the marketplace sample (test/fixtures/apps/forecourt-market): a buyer finds a
 * car from the front page, narrows the list in the address, reads the car and
 * asks about it signed out; the desk answers from the inquiry's conversation.
 * Every count and every write is read back from the database.
 */
async function signIn(page: Page, origin: string) {
  const answer = await page.request.post(`${origin}/api/auth/sign-in/email`, { headers: { origin }, data: FORECOURT_STAFF });
  expect(answer.ok(), await answer.text()).toBe(true);
}

test.describe('Forecourt marketplace', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.setTimeout(120_000);
  test.beforeEach(async () => {
    sample = await startSample('forecourt-market');
  });
  test.afterEach(async () => {
    await sample?.stop();
  });

  test('a buyer searches, refines in the address, reads a car and asks about it; the desk replies', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${sample.origin}/`);
    await expect(page.getByRole('heading', { name: 'Find the car that fits your life' })).toBeVisible();
    const featured = Number(scalar(sample.db, "SELECT COUNT(*) FROM vehicle WHERE featured = 1 AND status != 'sold'"));
    await expect(page.getByRole('heading', { name: 'Featured this week' })).toBeVisible();
    expect(featured).toBeGreaterThan(0);

    // One box to search: the car's name, suggesting the makes and models on the lot as one types.
    const search = page.getByRole('search', { name: 'Search Cars for sale' });
    const box = search.getByRole('combobox', { name: 'Car' });
    await box.pressSequentially('toy');
    await page.getByRole('option', { name: 'Toyota', exact: true }).click();
    await expect(box).toHaveValue('Toyota');
    await search.getByRole('button', { name: 'Search cars' }).click();
    await expect(page).toHaveURL(/\/vehicles\?.*Toyota/);
    const toyotas = Number(scalar(sample.db, "SELECT COUNT(*) FROM vehicle WHERE title LIKE '%Toyota%' AND status != 'sold'"));
    await expect(page.getByRole('list', { name: 'Cars for sale' }).getByRole('listitem')).toHaveCount(toyotas);
    // The rail's name box suggests too, and a pick is the search.
    const rail = page.locator('.facet[data-column="title"]').getByRole('combobox');
    await rail.fill('');
    await rail.pressSequentially('rav');
    await page.getByRole('option', { name: 'RAV4', exact: true }).click();
    await expect(page).toHaveURL(/\/vehicles\?.*RAV4/);
    const rav4s = Number(scalar(sample.db, "SELECT COUNT(*) FROM vehicle WHERE title LIKE '%RAV4%' AND status != 'sold'"));
    await expect(page.getByRole('list', { name: 'Cars for sale' }).getByRole('listitem')).toHaveCount(rav4s);

    // The refinements are the address: a body and a ceiling, and the cheapest first.
    await page.goto(`${sample.origin}/vehicles?body_type=SUV&price=..30000&sort=price`);
    const suvs = Number(scalar(sample.db, "SELECT COUNT(*) FROM vehicle WHERE body_type = 'SUV' AND price <= 30000 AND status != 'sold'"));
    const cards = page.getByRole('list', { name: 'Cars for sale' }).getByRole('listitem');
    await expect(cards).toHaveCount(suvs);
    const cheapest = Number(
      scalar(sample.db, "SELECT MIN(price) FROM vehicle WHERE body_type = 'SUV' AND price <= 30000 AND status != 'sold'"),
    );
    await expect(cards.first().locator('.cards-value')).toHaveText(`$${cheapest.toLocaleString('en-US')}`);
    await page.reload();
    await expect(cards).toHaveCount(suvs);

    // The car: its gallery, its price with the monthly estimate, and the way to ask.
    const title = (await cards.first().getByRole('button').textContent())!.trim();
    const car = Number(scalar(sample.db, "SELECT id FROM vehicle WHERE title = ? AND status != 'sold' ORDER BY price LIMIT 1", title));
    const [stock, monthly] = [
      String(scalar(sample.db, 'SELECT stock_ref FROM vehicle WHERE id = ?', car)),
      Number(scalar(sample.db, 'SELECT est_monthly FROM vehicle WHERE id = ?', car)),
    ];
    await cards.first().getByRole('button').click();
    await expect(page.getByRole('heading', { name: title }).first()).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/vehicles/${car}-[a-z0-9-]+`));
    await expect(page.getByText(`$${monthly.toLocaleString('en-US')}/mo`).first()).toBeVisible();
    // The photos for everyone, without the desk's Add photo; the desk's inquiries are not drawn for a visitor.
    await expect(page.getByRole('heading', { name: 'Photos' })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ Add photo' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Inquiries' })).toHaveCount(0);

    // Book a test drive: the form opens over the car with its stock number and topic filled in.
    await page.getByRole('link', { name: 'Book a test drive' }).click();
    const form = page.getByRole('dialog');
    await expect(form.getByLabel('Stock number', { exact: false })).toHaveValue(stock);
    await form.getByLabel('Your name', { exact: false }).fill('Jamie Rivera');
    await form.getByLabel('Email', { exact: false }).fill('jamie@example.test');
    await form.getByRole('button', { name: 'Send inquiry' }).click();
    await expect(form.getByText('Inquiry sent')).toBeVisible();
    const inquiry = Number(scalar(sample.db, "SELECT id FROM inquiry WHERE email = 'jamie@example.test'"));
    expect(scalar(sample.db, "SELECT stage || '/' || topic || '/' || vehicle_id FROM inquiry WHERE id = ?", inquiry)).toBe(
      `new/test_drive/${car}`,
    );
    expect(scalar(sample.db, "SELECT COUNT(*) FROM inquiry_message WHERE inquiry_id = ? AND kind = 'buyer'", inquiry)).toBe(1);

    // The desk answers from the conversation: the reply is a line of it, and the first answer moves it on.
    await signIn(page, sample.origin);
    await page.goto(`${sample.origin}/inquiries/${inquiry}`);
    const rows = page.locator('[data-timeline-row]');
    await expect(rows.filter({ hasText: 'I would like to test drive this car.' })).toHaveCount(1);
    const composer = page.locator('.timeline-composer');
    await composer.getByRole('textbox').fill('Saturday at ten works. We will have it washed and ready.');
    await composer.locator('button[type="submit"]').click();
    await expect(rows.filter({ hasText: 'Saturday at ten works.' })).toHaveCount(1);
    await expect.poll(() => scalar(sample.db, 'SELECT stage FROM inquiry WHERE id = ?', inquiry)).toBe('contacted');
    expect(scalar(sample.db, "SELECT COUNT(*) FROM inquiry_message WHERE inquiry_id = ? AND kind = 'reply'", inquiry)).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('the price it was, a shortlist as cards, and the desk’s week', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // A car whose price came down: the old price struck through beside the new, said to a screen reader too.
    const [car] = rows<{ id: number; price: number; was_price: number; title: string }>(
      sample.db,
      "SELECT id, price, was_price, title FROM vehicle WHERE was_price > price AND status != 'sold' ORDER BY id LIMIT 1",
    );
    const dollars = (n: number) => `$${n.toLocaleString('en-US')}`;
    await page.goto(`${sample.origin}/vehicles/${car.id}`);
    const was = page.locator('.page-headline-figure s.page-headline-was');
    await expect(was).toHaveText(`Was: ${dollars(car.was_price)}`);
    await expect(was.locator('.visually-hidden')).toHaveText('Was:');
    // A car whose price never moved draws the price alone, and no empty "Was —".
    const steady = Number(scalar(sample.db, "SELECT id FROM vehicle WHERE was_price IS NULL AND status != 'sold' ORDER BY id LIMIT 1"));
    await page.goto(`${sample.origin}/vehicles/${steady}`);
    await expect(page.locator('.page-headline-figure')).toBeVisible();
    await expect(page.locator('.page-headline-was')).toHaveCount(0);
    await expect(page.locator('.page-headline dt', { hasText: 'Was' })).toHaveCount(0);

    // A buyer saves the car; Saved cars draws it as the catalog does, read through the saved row.
    const shopper = 'shopper@forecourt.example.test';
    const up = await page.request.post(`${sample.origin}/api/auth/sign-up/email`, {
      headers: { origin: sample.origin },
      data: { name: 'Sam Buyer', email: shopper, password: 'disposable-forecourt-buyer-password' },
    });
    expect(up.ok(), await up.text()).toBe(true);
    await page.goto(`${sample.origin}/vehicles/${car.id}`);
    await expect(page.getByRole('heading', { name: 'Photos' })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ Add photo' })).toHaveCount(0);
    // Save asks nothing, so it runs on one click with no dialog (df773272), and its notice says so.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#toast')).toContainText('Saved.');
    await expect(page.getByRole('dialog', { name: 'Save' })).toHaveCount(0);
    await expect.poll(() => scalar(sample.db, 'SELECT COUNT(*) FROM saved_vehicle WHERE vehicle_id = ? AND active = 1', car.id)).toBe(1);
    await page.goto(`${sample.origin}/saved`);
    const saved = page.getByRole('list', { name: 'Saved cars' }).getByRole('listitem');
    await expect(saved).toHaveCount(1);
    await expect(saved.first()).toContainText(car.title);
    await expect(saved.first().locator('.cards-value')).toHaveText(dollars(car.price));
    await expect(saved.first().locator('img')).toHaveAttribute('src', /\/api\/file\?.*table=vehicle_photo/);
    // A buyer reads inquiries and cars too, so only the dashboard's roles keep the desk out of their menu.
    const menu = page.getByRole('navigation', { name: 'App menu' });
    await expect(menu.getByRole('button', { name: 'Saved cars' })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Desk', exact: true })).toHaveCount(0);

    // The desk adds a photo to the car: an upload the row policy judges as it judges any insert.
    await signIn(page, sample.origin);
    await page.goto(`${sample.origin}/vehicles/${car.id}`);
    await expect(page.getByRole('button', { name: '+ Add photo' })).toBeVisible();
    const photos = () => Number(scalar(sample.db, 'SELECT COUNT(*) FROM vehicle_photo WHERE vehicle_id = ?', car.id));
    const before = photos();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    await page.getByLabel('Add photo', { exact: true }).setInputFiles({ name: 'desk.png', mimeType: 'image/png', buffer: png });
    await expect.poll(photos).toBe(before + 1);
    expect(
      scalar(
        sample.db,
        "SELECT position || ' ' || content_type || ' ' || byte_size FROM vehicle_photo WHERE vehicle_id = ? AND file_name = 'desk.png'",
        car.id,
      ),
    ).toBe(`99 image/png ${png.length}`);

    // The desk reads inquiries week by week.
    await page.goto(`${sample.origin}/desk`);
    const weekly = page
      .locator('section, article, .dash-section')
      .filter({ has: page.getByRole('heading', { name: 'Inquiries by week' }) })
      .last();
    await expect(weekly).toBeVisible();
    const ticks = await weekly.locator('.chart-stacked-label').allTextContents();
    expect(ticks.length).toBeGreaterThan(1);
    // Each tick is a week's first day: "Sep 28, 2026", then "Oct 5" — a day of the month, never a month alone.
    for (const tick of ticks) expect(tick).toMatch(/^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/);
  });
});
