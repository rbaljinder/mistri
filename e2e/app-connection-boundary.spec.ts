import { COMPASS, expect, type Page, test } from './support/ownServers';

// This spec controls API responses; exercise boot through its fetch fallback.
test.use({ carryFirstPaint: false });

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

const CRM = COMPASS;

async function noConnectionControls(page: Page) {
  await expect(page.locator('#conn-picker')).toBeHidden();
  await expect(page.locator('#db-label')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Manage connections', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Connections', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Connection URL or file path')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect a database', exact: true })).toHaveCount(0);
}

test('an app has no Workbench, connection management or database-switch commands', async ({ page }) => {
  const managementRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/connections')) managementRequests.push(request.url());
  });
  await page.route('**/api/runtime', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    expect(data.appConfigured).toBe(true);
    expect(data).not.toHaveProperty('connections');
    expect(data).not.toHaveProperty('sources');
    expect(data.active).toBe('compass');
    for (const app of data.apps) expect(Object.keys(app).sort()).toEqual(['id', 'name', 'writable']);
    await route.fulfill({ response });
  });
  await page.route(/\/api\/app(?:\?|$)/, async (route) => {
    expect(new URL(route.request().url()).searchParams.get('app')).toBe('compass');
    expect(new URL(route.request().url()).searchParams.has('conn')).toBe(false);
    const response = await route.fetch();
    const data = await response.json();
    expect(data.appId).toBe('compass');
    expect(data).not.toHaveProperty('connection');
    await route.fulfill({ response, json: data });
  });
  await page.goto(`${CRM}/opportunity`);
  await expect(page.locator('html')).not.toHaveAttribute('data-starting');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await noConnectionControls(page);
    // An App has no Workbench to press w into: it stays the App.
    await page.keyboard.press('w');
    await expect(page.locator('body')).toHaveClass(/app-mode/);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /^Connections/ })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: /^SQL/ })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: /^Agent console/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+k');
    const search = page.getByRole('combobox', { name: 'Search', exact: true });
    await search.fill('Connections');
    // A grouped row is named by its name alone, its kind said in its line (Palette.tsx).
    await expect(page.getByRole('option', { name: 'Connections', exact: true })).toHaveCount(0);
    await search.fill('Other database');
    await expect(page.locator('[role="option"] .palette-detail', { hasText: /^Database\b/ })).toHaveCount(0);
    await search.fill('Workbench');
    await expect(page.getByRole('option', { name: /Workbench/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
  }
  expect(managementRequests).toEqual([]);
  const denied = await page.request.get(`${new URL(CRM).origin}/api/connections`);
  expect(denied.status()).toBe(403);
  expect(await denied.json()).not.toHaveProperty('connections');
});

/* An address naming no App is a wrong address, not a database failure: the
   screen says so and links the Apps served. */
test('an address naming no App lists the Apps served instead of blaming the database', async ({ page }) => {
  /* The server answers for another App than the one its page names (its root's, `compass`). */
  await page.route('**/api/runtime', (route) =>
    route.fulfill({ json: { active: 'example', apps: [{ id: 'example', name: 'Example app', writable: false }], appConfigured: true } }),
  );
  await page.goto(CRM);
  await expect(page.getByRole('heading', { name: 'No App named "compass" here', exact: true })).toBeVisible();
  await expect(page.getByText('could not connect to its database')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Example app', exact: true })).toHaveAttribute('href', '/example');
  await noConnectionControls(page);
});

for (const metadata of ['app', 'unavailable'])
  test(`cold database failure: ${metadata} metadata chooses the correct recovery screen`, async ({ page }) => {
    await page.route(/\/api\/schema(?:\?|$)/, (route) => route.fulfill({ status: 409, json: { error: 'No connection is open.' } }));
    await page.route('**/api/runtime', (route) =>
      metadata === 'unavailable'
        ? route.fulfill({ status: 503, json: { error: 'Metadata unavailable' } })
        : route.fulfill({
            json: { active: 'compass', apps: [{ id: 'compass', name: 'Compass', writable: false }], appConfigured: true },
          }),
    );
    await page.route('**/api/connections', (route) => route.fulfill({ json: { active: null, connections: [] } }));
    await page.goto(CRM);
    await expect(page.locator('html')).not.toHaveAttribute('data-starting');
    /* Under the App's name where its payload arrived before the schema's refusal, the generic word where not. */
    await expect(page.getByRole('heading', { name: /^(?:Compass|Application) is unavailable$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await noConnectionControls(page);
    await expect(page.getByRole('button', { name: 'Open the sample database', exact: true })).toHaveCount(0);
  });
