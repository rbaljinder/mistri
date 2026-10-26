import { COMPASS, expect, type Page, test } from './support/ownServers';

// This worker's own Compass (support/ownServers.ts), the App at the root.
test.use({ servers: ['crm'] });

/**
 * A first page is complete in the one request that brought it
 * (server/http/firstPaint.ts): the page carries the answers to everything its
 * first paint asks — who is here, the App, its schema and pages, then the
 * room's own reads — and the client takes each from it. So a list, a record
 * and the home dashboard open without a single API request, and nothing asks
 * again once they are drawn: an answer taken from the page is the room's
 * first, as a fetched one would have been. A second visit to the same room
 * in the same page asks as ever.
 */
async function opened(page: Page, path: string): Promise<string[]> {
  const asked: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    /* The two streams every App page opens (live sync's, and the source watch's on a server that follows saves) ask
       for no answer the page should have carried: they are not counted, so the allowance below stays the room's. */
    if (url.pathname === '/api/live' || url.pathname === '/api/app/live') return;
    if (url.pathname.startsWith('/api/')) asked.push(`${request.method()} ${url.pathname}`);
  });
  /* Compass does not ask for live sync, so a dashboard's tiles are read again on the wall-clock minute
     (Dashboard.tsx `minuteTick`), but not an answer younger than the tick's floor: a page opened in a minute's last
     seconds keeps its first paint's answers through :00 (CI once saw three tile reads at 13:07:00.0). So the page is
     opened whenever the test reaches it, the minute's last seconds included. */
  await page.goto(`${COMPASS}${path}`);
  await expect(page.locator('html')).not.toHaveAttribute('data-starting', '');
  // A moment after: nothing drawn asks again once it has its answer.
  await page.waitForTimeout(1500);
  return asked;
}

for (const [room, path, shows] of [
  ['a list', '/leads', 'Margot Fontaine'],
  ['a list on one of its tabs', '/leads?tab=working', 'Leads'],
  ['a record', '/leads/11', 'Marco Rahman'],
  ['the home dashboard', '/', 'Open pipeline'],
] as const) {
  test(`${room} opens complete with no API request`, async ({ page }) => {
    const asked = await opened(page, path);
    await expect(page.locator('#content')).toContainText(shows);
    /* The boot's own reads are always carried; a room's may be left for the
       client past the server's budget (http/firstPaint.ts), which a loaded
       machine can reach, so only the boot's are held to none. */
    expect(asked.filter((one) => /\/api\/(whoami|runtime|app|schema|pages|filters)$/.test(one))).toEqual([]);
    expect(asked.length).toBeLessThanOrEqual(2);
    // The block is read once and gone: nothing left in the page to read twice.
    expect(await page.locator('#mistri-first-paint').count()).toBe(0);
  });
}

test("an answer is the page's once: the same list asked again in the same page is asked of the server", async ({ page }) => {
  await opened(page, '/leads');
  const asked: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/run') asked.push(url.pathname);
  });
  await page.locator('#content .tab', { hasText: 'Working' }).first().click();
  await expect(page).toHaveURL(/tab=working/);
  await page.locator('#content .tab', { hasText: 'New' }).first().click();
  await expect(page).not.toHaveURL(/tab=/);
  await expect(page.locator('#content')).toContainText('Margot Fontaine');
  expect(asked.length).toBeGreaterThanOrEqual(2);
});
