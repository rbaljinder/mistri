import { expect, test } from './support/harness';
import { FORECOURT_STAFF, startSample } from './support/sampleServer';
import { DatabaseSync } from 'node:sqlite';
import { scalar } from './support/db';

/**
 * Forecourt, the public site: a signed-out visitor's journey from the front
 * page's search to a car and an inquiry about it, and a member of staff
 * recording a reply and closing it, which the public never reads. The addresses say the
 * question in words and a car is its own address; the car's page offers the
 * price with a monthly estimate, the facts, features, specs and history in
 * the open, and a form that already names the car. Every figure is asked of
 * the seeded database rather than written down, so a reseed moves both.
 */
test.describe('Forecourt, browsed signed out', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  // The seed draws 210 studio photos before the server starts.
  test.setTimeout(120_000);
  test.beforeEach(async () => {
    sample = await startSample('forecourt');
  });
  test.afterEach(async () => {
    await sample?.stop();
  });

  for (const width of [1440, 390]) {
    test(`${width}px: public inquiry → staff reply → closure and history`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${sample.origin}/`);
      await expect(page.getByRole('heading', { level: 1, name: 'Find a car you will love driving' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();

      // The dealers' picks: an honest query, featured and not sold, at most six.
      const featured = Number(scalar(sample.db, "SELECT COUNT(*) FROM vehicle WHERE featured = 1 AND status != 'sold'"));
      await expect(page.getByRole('list', { name: 'Recommended by our dealers' }).getByRole('listitem')).toHaveCount(Math.min(6, featured));

      // The hero: its photo from the App's files, drawn in place, and the search inside it.
      await expect(page.getByRole('img', { name: /Three cars in the Forecourt studio/ })).toHaveAttribute('src', /\/api\/file\?.*inline=1/);
      const search = page.getByRole('search', { name: 'Search Vehicles' });
      await search.getByLabel('Make', { exact: true }).click();
      await page.getByRole('option', { name: 'Hyundai', exact: true }).click();
      await search.getByRole('button', { name: 'Show vehicles' }).click();
      // The address is the question in words: the list's key and its filter, no query language.
      await expect(page).toHaveURL(/\/vehicles\?make=Hyundai$/);
      const cards = page.getByRole('list', { name: 'Vehicles' });
      const hyundais = Number(scalar(sample.db, "SELECT COUNT(*) FROM vehicle WHERE make = 'Hyundai' AND status != 'sold'"));
      await expect(cards.getByRole('listitem')).toHaveCount(hyundais);
      // A reload keeps the search: the address is the result.
      await page.reload();
      await expect(page.getByRole('list', { name: 'Vehicles' }).getByRole('listitem')).toHaveCount(hyundais);

      // Sorted by price: the cheapest first, and the address keeps the order.
      await page.getByRole('button', { name: 'Sort', exact: true }).click();
      await page.getByRole('option', { name: 'Lowest price', exact: true }).click();
      await expect(page).toHaveURL(/\/vehicles\?make=Hyundai&sort=price$/);
      const cheapest = Number(scalar(sample.db, "SELECT MIN(price) FROM vehicle WHERE make = 'Hyundai' AND status != 'sold'"));
      const first = page.getByRole('list', { name: 'Vehicles' }).getByRole('listitem').first();
      await expect(first.locator('.cards-value')).toHaveText(`$${cheapest.toLocaleString('en-US')}`);

      // A card: its lead photo drawn in place, its facts in one line, who sells it.
      await expect(first.locator('img')).toHaveAttribute('src', /\/api\/file\?.*inline=1/);
      await expect(first.locator('.cards-summary')).toContainText(' mi');
      const title = (await first.getByRole('button').textContent())!.trim();
      // A trim is said once: "2019 Tesla Model 3 Long Range", never "Long Range Long Range".
      expect(/(\b\S+(?: \S+)?\b) \1$/.test(title)).toBe(false);
      const id = Number(scalar(sample.db, 'SELECT id FROM vehicle WHERE title = ? ORDER BY price LIMIT 1', title));
      const [reference, est, dealer] = [
        String(scalar(sample.db, 'SELECT stock_ref FROM vehicle WHERE id = ?', id)),
        Number(scalar(sample.db, 'SELECT est_monthly FROM vehicle WHERE id = ?', id)),
        Number(scalar(sample.db, 'SELECT dealer_id FROM vehicle WHERE id = ?', id)),
      ];
      await expect(first).toContainText(String(scalar(sample.db, 'SELECT name FROM dealer WHERE id = ?', dealer)));
      // The seed photographs each car once; two more frames give the gallery steps to take.
      const writer = new DatabaseSync(sample.db);
      writer
        .prepare(
          `INSERT INTO vehicle_photo (vehicle_id, position, caption, file_name, content_type, byte_size, data, thumbnail)
          SELECT vehicle_id, position + step, caption, file_name, content_type, byte_size, data, thumbnail
          FROM vehicle_photo, (SELECT 1 AS step UNION ALL SELECT 2) WHERE vehicle_id = ?`,
        )
        .run(id);
      writer.close();
      await first.getByRole('button').click();
      await expect(page.getByRole('heading', { name: title }).first()).toBeVisible();
      // A car's address is the car — its id and its name — whatever list it was opened from; the crumb says that list in words.
      await expect(page).toHaveURL(new RegExp(`/vehicles/${id}-[a-z0-9-]+$`));
      await expect(page.getByRole('navigation', { name: 'Trail' })).toContainText('Vehicles · Hyundai');

      // The offer: the price, the monthly estimate and its terms, and nothing internal. A page that leads with its
      // photos is drawn as a showcase, whose panel is named by what it offers (shared/pageLayouts.ts).
      const offer = page.getByRole('complementary', { name: 'Vehicle: Price' });
      await expect(offer).toContainText(`$${est.toLocaleString('en-US')}/mo`);
      await expect(offer).toContainText('7.9% APR');
      await expect(offer.getByText('Listed', { exact: true })).toHaveCount(0);
      await expect(offer.getByText(reference, { exact: true })).toHaveCount(0);

      // The facts in one line; the features listed and the history a sheet, nothing to unfold.
      // A public reader's page folds nothing, says no "VEHICLE" over the name,
      // and its trail ends at the list: the heading below names the car.
      await expect(page.getByRole('list', { name: 'Key facts' })).toContainText(' mi');
      await expect(page.locator('details.page-fold')).toHaveCount(0);
      await expect(page.locator('.page-head .page-title')).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Trail' }).getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Trail' })).not.toContainText(title);
      // Who sells it is a card: the dealer's name, where and how to reach them, and a way to them.
      const seller = page.locator('.page-card');
      await expect(seller.getByRole('heading', { name: 'Sold by' })).toBeVisible();
      await expect(seller.getByRole('button', { name: 'View dealer' })).toBeVisible();
      const feature = String(scalar(sample.db, 'SELECT features FROM vehicle WHERE id = ?', id)).split('\n')[0];
      await expect(page.locator('.value-items').getByText(feature, { exact: true })).toBeVisible();
      await expect(page.locator('.page-sheet').getByText(reference, { exact: true })).toBeVisible();

      // Cars like this one, not yet sold and never this one: the same body type, within 25% of
      // its price (whole dollars, the column's own kind), the closest price first, then by key.
      const price = Number(scalar(sample.db, 'SELECT price FROM vehicle WHERE id = ?', id));
      const alike = scalar(
        sample.db,
        `SELECT json_group_array(title) FROM (SELECT title FROM vehicle
        WHERE body_type = (SELECT body_type FROM vehicle WHERE id = ?) AND price BETWEEN ? AND ? AND id != ? AND status != 'sold'
        ORDER BY ABS(price - ?), id LIMIT 4)`,
        id,
        Math.ceil(price * 0.75),
        Math.floor(price * 1.25),
        id,
        price,
      );
      const expected = JSON.parse(String(alike)) as string[];
      expect(expected.length).toBeGreaterThan(0);
      const similar = page.getByRole('list', { name: 'Similar vehicles' });
      await expect(similar.getByRole('listitem').getByRole('button')).toHaveText(expected);

      // Hidden labels below the fold must not create a second window scroll.
      // Scrolling that outer range lifted the content pane and left blank space.
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(1);
      await page.evaluate(() => window.scrollTo(0, 200));
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await similar.getByRole('button').first().scrollIntoViewIfNeeded();
      await expect(similar.getByRole('button').first()).toBeInViewport();
      expect(await page.locator('.content').evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

      // The gallery steps on the lead, then the lightbox: the counter, the steps and the keys agree.
      const photos = Number(scalar(sample.db, 'SELECT COUNT(*) FROM vehicle_photo WHERE vehicle_id = ?', id));
      await page.getByRole('button', { name: 'Show the next photo' }).click();
      await expect(page.getByRole('button', { name: new RegExp(`^View photo 2 of ${photos} larger`) })).toBeVisible();
      await page.getByRole('button', { name: 'Show the previous photo' }).click();
      const lead = page.getByRole('button', { name: new RegExp(`^View photo 1 of ${photos} larger`) });
      await lead.click();
      const lightbox = page.getByRole('dialog');
      await expect(lightbox.getByText(`1 of ${photos}`, { exact: true })).toBeVisible();
      // Focus moves into the lightbox on opening, so the keys reach it rather than the page behind.
      await expect(lightbox.getByRole('button', { name: 'Close' })).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(lightbox.getByText(`2 of ${photos}`, { exact: true })).toBeVisible();
      await lightbox.getByRole('button', { name: 'Next photo' }).click();
      await expect(lightbox.getByText(`3 of ${photos}`, { exact: true })).toBeVisible();
      await lightbox.getByRole('button', { name: 'Previous photo' }).click();
      await expect(lightbox.getByText(`2 of ${photos}`, { exact: true })).toBeVisible();
      await expect(lightbox.getByRole('img')).toHaveAttribute('src', /inline=1/);
      await page.keyboard.press('Escape');
      await expect(lightbox).toBeHidden();
      // Focus is back on the lead, which now shows the photo last seen.
      await expect(page.getByRole('button', { name: new RegExp(`^View photo 2 of ${photos} larger`) })).toBeFocused();

      // Back returns to the sorted list, its address and its question as they were.
      await page.goBack();
      await expect(page).toHaveURL(/\/vehicles\?make=Hyundai&sort=price$/);
      await expect(page.getByRole('list', { name: 'Vehicles' }).getByRole('listitem')).toHaveCount(hyundais);
      await page.goForward();
      await expect(page).toHaveURL(new RegExp(`/vehicles/${id}-[a-z0-9-]+$`));

      // Schedule a test drive: the form opens over the car, which stays behind
      // it — the price and the photographs are why anyone is filling it in —
      // and it already names the car, which the visitor may still change. The
      // link keeps the form's own address, so a new tab still works.
      const ask = page.getByRole('link', { name: 'Schedule a test drive' });
      await expect(ask).toHaveAttribute('href', /\/form\/inquire\?stock_ref=FC-\d{4}&message=/);
      await ask.click();
      await expect(page).toHaveURL(new RegExp(`/vehicles/${id}-[a-z0-9-]+$`));
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByLabel('Stock number')).toHaveValue(reference);
      await expect(page.getByLabel('Your question')).toHaveValue(/schedule a test drive/);
      await page.getByLabel('Your name').fill('Sam Carter');
      await page.getByLabel('Email').fill('sam@example.test');
      await page.getByLabel('Your question').fill('I would like to schedule a test drive on Saturday morning.');
      await page.getByRole('button', { name: 'Send inquiry' }).click();
      await expect(page.getByText('Inquiry recorded')).toBeVisible();
      await expect(page.getByText(/INQ-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/)).toBeVisible();
      expect(
        Number(
          scalar(sample.db, "SELECT COUNT(*) FROM inquiry WHERE stock_ref = ? AND vehicle_id = ? AND name = 'Sam Carter'", reference, id),
        ),
      ).toBe(1);

      // Signed out, the inquiries are not there to read: the visitor is asked to sign in, as for a table that does not exist.
      for (const table of ['inquiry', 'inquiry_activity', 'no_such_table']) {
        const reply = await page.request.post(`${sample.origin}/api/run`, { data: { app: 'forecourt', q: table, limit: 1, offset: 0 } });
        expect(reply.status()).toBe(401);
        const refused = await reply.json();
        expect(refused.rows).toBeUndefined();
        expect(refused.error).toBe('Sign in to continue.');
      }

      // Staff sign in and start on the inquiries, the new one among them.
      await page.goto(`${sample.origin}/sign-in`);
      await page.getByLabel('Email').fill(FORECOURT_STAFF.email);
      await page.getByLabel('Password').fill(FORECOURT_STAFF.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      // The home shows it twice (the recent records and the Inquiries grid); either, as the width draws it.
      await expect(page.getByText('Sam Carter').filter({ visible: true }).first()).toBeVisible();
      const inquiryId = Number(scalar(sample.db, "SELECT id FROM inquiry WHERE name = 'Sam Carter' ORDER BY id DESC LIMIT 1"));
      await page.goto(`${sample.origin}/@inquiry~${inquiryId}`);
      await page.getByRole('button', { name: 'Record reply', exact: true }).click();
      const reply = page.getByRole('dialog', { name: 'Record reply' });
      await reply.getByLabel('Reply summary', { exact: false }).fill('Confirmed the test drive by phone.');
      await reply.getByRole('button', { name: 'Record reply', exact: true }).click();
      await expect(reply.getByRole('status')).toHaveAttribute('data-phase', 'success');
      await reply.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(page.locator('[data-timeline-row]').filter({ hasText: 'Confirmed the test drive by phone.' })).toBeVisible();
      expect(scalar(sample.db, 'SELECT status FROM inquiry WHERE id = ?', inquiryId)).toBe('replied');
      if (width === 390) {
        await page.getByRole('button', { name: 'More actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Close inquiry', exact: true }).click();
      } else await page.getByRole('button', { name: 'Close inquiry', exact: true }).click();
      const close = page.getByRole('dialog', { name: 'Close inquiry' });
      await close.getByLabel('Resolution', { exact: false }).fill('Test drive completed.');
      await close.getByRole('button', { name: 'Close inquiry', exact: true }).click();
      await expect(close.getByRole('status')).toHaveAttribute('data-phase', 'success');
      await close.getByRole('button', { name: 'Done', exact: true }).click();
      await page.reload();
      await expect(page.locator('[data-timeline-row]').filter({ hasText: 'Test drive completed.' })).toBeVisible();
      expect(scalar(sample.db, 'SELECT status FROM inquiry WHERE id = ?', inquiryId)).toBe('closed');
      await expect(page.getByRole('button', { name: 'Record reply', exact: true })).toHaveCount(0);
    });
  }
});
