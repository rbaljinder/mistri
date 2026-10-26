import { expect, test } from './support/harness';
import { startParcel } from './support/httpSourceServer';

/* The Parcel sample as its README runs it: its mock API behind a bearer
   token, and the App reading it through the committed description. Every
   surface here reads an API, so each is asserted to draw, not only to load.
   test-package: mistri — Parcel is an App, which the helper starts with mistri. */
test.describe('Parcel, an App over an API', () => {
  let parcel: Awaited<ReturnType<typeof startParcel>>;
  test.beforeAll(async () => {
    // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
    test.setTimeout(120_000);
    parcel = await startParcel();
  });
  test.afterAll(async () => {
    await parcel?.stop();
  });

  test("Shipments offers the API's own filters, and its tabs ask the API", async ({ page }) => {
    await page.goto(`${parcel.origin}/`);
    await expect(page.getByRole('heading', { name: 'Shipments', level: 1 })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'On the way' })).toHaveAttribute('aria-selected', 'true');
    for (const name of ['Filter by Carrier', 'Filter by To state', 'Filter by Status'])
      await expect(page.getByRole('button', { name })).toBeVisible();
    // Its name column is no filter the API documents, so there is no search box to offer.
    await expect(page.getByRole('searchbox', { name: 'Filter by Tracking number' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Filter by Tracking number' })).toHaveCount(0);

    await page.getByRole('tab', { name: 'Held' }).click();
    const statuses = page.getByRole('gridcell', { name: /^(Exception|In transit|Delivered|Out for delivery|Label created)$/ });
    await expect(statuses.first()).toHaveText('Exception');
    expect(new Set(await statuses.allInnerTexts())).toEqual(new Set(['Exception']));
  });

  test("a shipment page draws its sections from the API's item path", async ({ page }) => {
    await page.goto(`${parcel.origin}/`);
    const first = page.getByRole('row').nth(1);
    const tracking = (await first.getByRole('gridcell').first().innerText()).trim();
    await first.click();
    await expect(page.getByRole('heading', { name: tracking, level: 1 })).toBeVisible();
    await expect(page.getByText('Route', { exact: true })).toBeVisible();
    await expect(page.getByText(/cannot run views/)).toHaveCount(0);
    await expect(page.getByText(/could not be loaded/)).toHaveCount(0);
  });

  test('a question the API does not document says what it can ask', async ({ page }) => {
    await page.goto(`${parcel.origin}/shipments%20status%20!%3D%20delivered`);
    // In the App's words: its captions ("Carrier", "To state"), or the derived "Status", not the API's names.
    await expect(page.getByText('It can filter by Status =, Carrier = or in, To state =.')).toBeVisible();
  });

  test('a shipment names its carrier, and a carrier lists what it is moving', async ({ page }) => {
    await page.goto(`${parcel.origin}/`);
    // `carrier_id` references `carriers`: the list shows the name, read once per carrier from its item path.
    const carriers = /^(Bluebird Freight|Keystone Express|Prairie Parcel|Harbor Line Logistics|Summit Ground|Lone Star Courier)$/;
    // Visible ones only: the grid also renders a phone-layout summary card per row, hidden at this width.
    await expect(page.getByText(carriers).filter({ visible: true }).first()).toBeVisible();
    await page.goto(`${parcel.origin}/@carrier~car-01`);
    await expect(page.getByRole('heading', { name: 'Bluebird Freight', level: 1 })).toBeVisible();
    await expect(page.getByText('Shipments', { exact: true }).filter({ visible: true }).last()).toBeVisible();
    await expect(
      page
        .getByText(/^PX\d{10}$/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    await expect(page.getByText(/cannot run views|could not be loaded|follows one reference/)).toHaveCount(0);
  });

  test("Carriers lists the network, read through the API's cursor", async ({ page }) => {
    await page.goto(`${parcel.origin}/carriers`);
    await expect(page.getByRole('heading', { name: 'Carriers', level: 1 })).toBeVisible();
    // All six on one page: the cursor's first page holds them, and no second is asked for.
    for (const name of [
      'Bluebird Freight',
      'Keystone Express',
      'Prairie Parcel',
      'Harbor Line Logistics',
      'Summit Ground',
      'Lone Star Courier',
    ]) {
      await expect(page.getByRole('gridcell', { name })).toBeVisible();
    }
  });
});
