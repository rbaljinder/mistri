import { COMPASS, expect, type Page, test } from './support/ownServers';

// This worker's own Compass (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });
test.describe.configure({ timeout: 60_000 });

/*
 * A record page is one request (shared/recordReads.ts): the server plans the
 * page and answers every read its open sections will ask, and the sections
 * find their answers waiting. A section that built its request differently
 * from the server would ask again, and show up here as a second request.
 */

/** Every API request from here on, by path. */
function requests(page: Page) {
  const asked: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes('/api/')) asked.push(url.pathname.replace(/^.*\/api\//, '/api/'));
  });
  return asked;
}

const rowsOf = (page: Page) => page.locator('#content tbody tr.clickable, #content .record-summary-title').locator('visible=true');

for (const size of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`list → record → related record → Back asks one request per record page (${size.width}px)`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto(`${COMPASS}/accounts?tab=all`);
    const rows = rowsOf(page);
    await expect(rows.nth(5)).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(500);
    const row = rows.nth(4);
    const name = (size.width > 600 ? await row.locator('td').first().innerText() : await row.innerText()).split('\n')[0]!.trim();

    let asked = requests(page);
    await row.click();
    await expect(page.locator('.page-head .root-current')).toHaveText(name);
    await expect(page.locator('#content > .nav-held')).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(asked, 'list → record').toEqual(['/api/pages/compose']);

    // A related record on a page of its own: its suggested page, then its compose.
    page.removeAllListeners('request');
    asked = requests(page);
    const owner = page.locator('#content .page-head .ref-jump').filter({ hasText: /\w/ }).last();
    const person = (await owner.innerText()).trim();
    await owner.click();
    await expect(page.locator('.page-head .root-current')).toHaveText(person);
    await expect(page.locator('#content > .nav-held')).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(
      asked.filter((path) => path !== '/api/pages/suggested'),
      'record → related record',
    ).toEqual(['/api/pages/compose']);

    page.removeAllListeners('request');
    // Off the page's links: a reference the pointer rests on asks for its own hover card, which is not the page.
    await page.mouse.move(0, 0);
    asked = requests(page);
    await page.goBack();
    await expect(page.locator('.page-head .root-current')).toHaveText(name);
    await expect(page.locator('#content > .nav-held')).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(asked, 'Back to the record').toEqual(['/api/pages/compose']);
  });
}

test('a press on a row starts its record page before the click is over', async ({ page }) => {
  await page.goto(`${COMPASS}/accounts?tab=all`);
  const rows = rowsOf(page);
  await expect(rows.nth(5)).toBeVisible({ timeout: 30_000 });
  const box = (await rows.nth(3).boundingBox())!;
  const asked = requests(page);
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  // A pointer passing over the list asks nothing.
  await page.waitForTimeout(200);
  expect(asked).toEqual([]);
  await page.mouse.down();
  await expect.poll(() => asked).toEqual(['/api/pages/compose']);
  await page.mouse.up();
  await expect(page.locator('#content > .nav-held')).toHaveCount(0);
  await expect(page.locator('.page-head .root-current')).not.toHaveText('');
  await page.waitForTimeout(500);
  // The room takes the request the press began: nothing is asked twice.
  expect(asked).toEqual(['/api/pages/compose']);
});
