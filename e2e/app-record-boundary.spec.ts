import { COMPASS, expect, type Page, test } from './support/ownServers';

// A worker-owned Compass process, database copy and config store. No preview
// service or data is used. Fetch fallback makes boot-page failures injectable.
test.use({ servers: ['crm'], carryFirstPaint: false });
test.describe.configure({ timeout: 60_000 });

const inspector = '.record-as-page, .record-layout, .record-heading';
const mounted = 'app-record-boundary.inspector-mounted';
const title = (page: Page) => page.locator('#content .page-head .root-current');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ selector, key }) => {
      // Observe additions AND removals: an inspector inserted and replaced in
      // one task must fail too. Keep the evidence through reload and Back.
      const check = (node: Node) => {
        if (node instanceof Element && (node.matches(selector) || node.querySelector(selector))) sessionStorage.setItem(key, 'yes');
      };
      new MutationObserver((records) => {
        for (const record of records) {
          record.addedNodes.forEach(check);
          record.removedNodes.forEach(check);
        }
      }).observe(document, { childList: true, subtree: true });
    },
    { selector: inspector, key: mounted },
  );
});

async function appOnly(page: Page) {
  await expect(page.locator('body')).toHaveClass(/app-mode/);
  await expect(page.locator(inspector)).toHaveCount(0);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), mounted), 'no transient Workbench record mount').toBeNull();
}

test('canonical and legacy deep links, list/related navigation, Back and reload stay on App pages', async ({ page }) => {
  await page.goto(`${COMPASS}/accounts/1`);
  await expect(title(page)).toHaveText(/\S/);
  await expect(title(page)).toBeVisible();
  const first = (await title(page).textContent())!.trim();
  await appOnly(page);

  await page.goto(`${COMPASS}/account/~1`);
  await expect(title(page)).toHaveText(first);
  await expect(page).toHaveURL(/\/accounts\/1(?:[/?#]|$)/);
  await page.reload();
  await expect(title(page)).toHaveText(first);
  await appOnly(page);

  await page.goto(`${COMPASS}/accounts?tab=all`);
  const row = page.locator('#content tbody tr.clickable').nth(3);
  await expect(row).toBeVisible();
  const name = (await row.locator('td').first().innerText()).split('\n')[0]!.trim();
  await row.click();
  await expect(title(page)).toHaveText(name);
  const recordURL = page.url();
  await appOnly(page);

  const related = page.locator('#content .page-head .ref-jump').filter({ hasText: /\w/ }).last();
  await expect(related).toBeVisible();
  await expect(related).toHaveText(/\S/);
  const person = (await related.textContent())!.trim();
  await related.click();
  await expect(title(page)).toHaveText(person);
  await appOnly(page);
  await page.goBack();
  await expect(title(page)).toHaveText(name);
  await expect(page).toHaveURL(recordURL);
  await page.reload();
  await expect(title(page)).toHaveText(name);
  await appOnly(page);
});

test('a failed page registry read offers retry without mounting the inspector', async ({ page }) => {
  let failing = true,
    failures = 0;
  await page.route(/\/api\/pages(?:\?|$)/, async (route) => {
    if (!failing) {
      await route.continue();
      return;
    }
    failures++;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Injected page registry outage' }) });
  });
  await page.goto(`${COMPASS}/accounts/1`);
  await expect(page.getByRole('alert').filter({ hasText: 'This record’s page could not be opened' })).toBeVisible();
  expect(failures).toBeGreaterThan(0);
  await appOnly(page);
  failing = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(title(page)).toHaveText(/\S/);
  await appOnly(page);
});

for (const stored of ['override', 'malformed'] as const) {
  test(`${stored} browser-saved page cannot override an authored App page`, async ({ page }) => {
    await page.addInitScript((kind) => {
      const value =
        kind === 'malformed'
          ? { bad: null }
          : {
              hijack: { id: 'saved:hijack', name: 'HIJACKED BROWSER PAGE', base: 'account', source: 'saved', sections: [] },
            };
      // Compass has anonymous identity, so its mirror uses the unscoped key.
      localStorage.setItem('mistri.pages.saved.compass', JSON.stringify(value));
    }, stored);
    await page.goto(`${COMPASS}/accounts/1`);
    await expect(title(page)).toHaveText(/\S/);
    // These are authored account-page sections; an empty saved layout cannot pass.
    await expect(page.locator('#content')).not.toContainText('HIJACKED BROWSER PAGE');
    await expect(page.locator('#content .page-head .ref-jump').first()).toBeVisible();
    const name = (await title(page).innerText()).trim();
    await page.reload();
    await expect(title(page)).toHaveText(name);
    await appOnly(page);
  });
}

test('a genuinely missing authored page uses the App suggested page', async ({ page }) => {
  let suggestions = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/pages/suggested') suggestions++;
  });
  await page.route(/\/api\/pages(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.pages = body.pages.filter((definition: { base: string }) => definition.base !== 'account');
    await route.fulfill({ response, json: body });
  });
  await page.goto(`${COMPASS}/accounts/1`);
  await expect(title(page)).toHaveText(/\S/);
  expect(suggestions).toBeGreaterThan(0);
  await appOnly(page);
});
