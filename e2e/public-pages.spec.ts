import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from './support/harness';
import { startSample } from './support/sampleServer';
import { rows } from './support/db';

/**
 * Forecourt's public pages as a crawler and a first visit see them
 * (server/publicRender.ts, http/publicPage.ts, http/sitemap.ts): the list
 * and the car arrive drawn in the HTML, the App takes them over without a
 * layout shift, a public form is taken over in place, and the sitemap names
 * exactly the public addresses the route table says, on whichever host was
 * asked. Each server is this spec's own (listen(0), a fresh database); one
 * draws nothing on the server, which is the "before" the shift is compared
 * with.
 */

const WHITE_LABEL = 'cars.example.test';

/* The page's cumulative layout shift, as Core Web Vitals sums it (no input). */
async function watchShifts(page: Page) {
  await page.addInitScript(() => {
    const seen = { cls: 0 };
    (window as unknown as { seen: typeof seen }).seen = seen;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>)
        if (!entry.hadRecentInput) seen.cls += entry.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
}
const shift = (page: Page) => page.evaluate(() => (window as unknown as { seen: { cls: number } }).seen.cls);

/* The first thing the server drew in the pane, kept, so the test can ask whether the client took that very node over. */
async function keepDrawn(page: Page) {
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const pane = document.getElementById('content');
      if (pane?.dataset.ssr && pane.firstElementChild) {
        (window as unknown as { drawn: Element }).drawn = pane.firstElementChild;
        observer.disconnect();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  });
}

/* A list and a car, opened cold; the App's own room drawn, the server's document gone, the pictures in. */
async function measure(page: Page, origin: string, car: { path: string; title: string }) {
  await watchShifts(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/vehicles`);
  await expect(page.getByRole('list', { name: 'Cars for sale' }).getByRole('listitem').first()).toBeVisible();
  await expect(page.locator('.public-document')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  const list = await shift(page);
  await page.goto(`${origin}${car.path}`);
  await expect(page.getByRole('heading', { name: car.title, level: 1 })).toBeVisible();
  await expect(page.locator('.public-document')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  return { list, record: await shift(page) };
}

test.describe('Forecourt public pages', () => {
  test.setTimeout(150_000);
  let drawn: Awaited<ReturnType<typeof startSample>>;
  let plain: Awaited<ReturnType<typeof startSample>>;
  test.beforeAll(async () => {
    test.setTimeout(150_000);
    drawn = await startSample('forecourt-market', { env: { MISTRI_ALLOWED_HOSTS: WHITE_LABEL } });
    // Drawing nothing on the server, and a sitemap of parts forty addresses long.
    plain = await startSample('forecourt-market', { env: { MISTRI_SSR: '0', MISTRI_SITEMAP_URLS: '40' } });
  });
  test.afterAll(async () => {
    await drawn?.stop();
    await plain?.stop();
  });

  const forSale = () =>
    rows(drawn.db, "SELECT id, title FROM vehicle WHERE status != 'sold' ORDER BY id") as Array<{ id: number; title: string }>;

  test('the list and the car are in the HTML, and the App takes them over without a shift', async ({ page, request }) => {
    const cars = forSale();
    const sold = rows(drawn.db, "SELECT title FROM vehicle WHERE status = 'sold' ORDER BY id LIMIT 1") as Array<{ title: string }>;
    const listing = await (await request.get(`${drawn.origin}/vehicles`)).text();
    expect(listing).toContain('data-ssr="room"');
    expect(listing).toContain('<h1>Cars for sale</h1>');
    // Its first screen of cards, each linking the car's canonical address; never a sold one.
    expect(listing).toContain(cars[0].title);
    expect(listing).toMatch(new RegExp(`href="/vehicles/${cars[0].id}-[a-z0-9-]+"`));
    expect(listing).not.toContain(`<h2>${sold[0].title}</h2>`);
    expect(listing).toContain('<link rel="canonical" href="/vehicles">');
    // Its preview picture is its share card, drawn from its words in Forecourt's look (shareCard.ts).
    const card = listing.match(/<meta property="og:image" content="http:\/\/127\.0\.0\.1:\d+(\/api\/og\?path=[^"&]+&amp;v=[0-9a-f]{32})">/);
    expect(card).toBeTruthy();
    const drawnCard = await request.get(`${drawn.origin}${card![1].replace(/&amp;/g, '&')}`);
    expect(drawnCard.status()).toBe(200);
    expect(drawnCard.headers()['content-type']).toBe('image/png');
    expect(drawnCard.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
    // A buyer's inquiries are no part of any public page.
    const inquiry = rows(drawn.db, 'SELECT email FROM inquiry LIMIT 1') as Array<{ email: string }>;
    if (inquiry.length) expect(listing).not.toContain(inquiry[0].email);

    const slug = listing.match(new RegExp(`href="(/vehicles/${cars[0].id}-[a-z0-9-]+)"`))![1];
    const detail = await (await request.get(`${drawn.origin}${slug}`)).text();
    expect(detail).toContain('data-ssr="room"');
    expect(detail).toContain(`<h1>${cars[0].title}</h1>`);
    expect(detail).toContain('<nav aria-label="Up"><a href="/vehicles">Cars for sale</a></nav>');
    expect(detail).toMatch(/<dt>Price<\/dt><dd>\$[\d,]+<\/dd>/);
    expect(detail).toContain('<meta property="og:type" content="article">');
    expect(detail).toContain(`<meta property="og:title" content="${cars[0].title}">`);
    expect(detail).toContain('<meta name="twitter:card" content="summary_large_image">');
    // The <img>'s set names its format (`f=fallback`), so a CDN keeps one copy per address; AVIF and WebP are <source>s.
    expect(detail).toMatch(/srcSet="[^"]*&amp;w=320&amp;f=fallback 320w/);

    const car = { path: slug, title: cars[0].title };
    const after = await measure(page, drawn.origin, car);
    const fresh = await page.context().browser()!.newPage();
    const before = await measure(fresh, plain.origin, car);
    await fresh.close();
    test.info().annotations.push({ type: 'cls', description: JSON.stringify({ before, after }) });
    console.log(`CLS before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    // Drawn on the server, nothing moves more than it did, and nothing moves enough to count.
    expect(after.list).toBeLessThanOrEqual(before.list + 0.01);
    expect(after.record).toBeLessThanOrEqual(before.record + 0.01);
    expect(after.list).toBeLessThan(0.1);
    expect(after.record).toBeLessThan(0.1);
  });

  test('without scripts the drawn page is the page', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(`${drawn.origin}/vehicles`);
    await expect(page.getByRole('heading', { name: 'Cars for sale', level: 1 })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Cars for sale' }).getByRole('link').first()).toBeVisible();
    await context.close();
  });

  test('a public form is taken over in place: the node the server drew is the one the visitor types in', async ({ page }) => {
    await keepDrawn(page);
    await page.goto(`${drawn.origin}/form/inquire`);
    const name = page.getByRole('textbox', { name: 'Your name (required)' });
    await expect(name).toBeVisible();
    await expect(page.locator('#content[data-ssr]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { drawn?: Element }).drawn?.isConnected)).toBe(true);
    await name.fill('Ada Visitor');
    await expect(name).toHaveValue('Ada Visitor');
  });

  test('the sitemap names the public addresses the route table says, on the host it was asked on', async ({ request }) => {
    const sitemap = await request.get(`${drawn.origin}/sitemap.xml`);
    expect(sitemap.headers()['content-type']).toBe('application/xml; charset=utf-8');
    const xml = await sitemap.text();
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1].replaceAll('&amp;', '&'));
    const paths = locs.map((loc) => new URL(loc).pathname);
    expect(locs.every((loc) => loc.startsWith(`${drawn.origin}/`))).toBe(true);
    // Every car for sale, and only those; every dealer; the lists and the front page.
    const cars = paths.filter((path) => path.startsWith('/vehicles/'));
    expect(cars.map((path) => Number(path.split('/')[2].split('-')[0]))).toEqual(forSale().map((car) => car.id));
    const dealers = rows(drawn.db, 'SELECT id FROM dealer ORDER BY id') as Array<{ id: number }>;
    expect(paths.filter((path) => path.startsWith('/dealers/'))).toEqual(dealers.map((dealer) => `/dealers/${dealer.id}`));
    expect(paths).toEqual(expect.arrayContaining(['/', '/vehicles', '/dealers', '/welcome']));
    expect(paths.some((path) => /^\/(inquiries|pipeline|desk|saved|my-inquiries|vehicle_photo|site_image)(\/|$)/.test(path))).toBe(false);

    // Each is an address `mistri check --routes` prints, a pattern's blanks filled in.
    const printed = execFileSync(
      process.execPath,
      [
        ...[
          '--import',
          'tsx',
          'packages/mistri/src/server/index.ts',
          'check',
          '--app',
          'test/fixtures/apps/forecourt-market',
          '--config',
          `${drawn.db}.json`,
        ],
        ...[
          '--commands',
          'test/fixtures/apps/forecourt-market/commands.ts',
          '--policy',
          'test/fixtures/apps/forecourt-market/policy.ts',
          '--routes',
        ],
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
    const patterns = [...printed.matchAll(/^\s+(\/\S*)\s{2,}/gm)].map((match) => match[1]);
    const said = patterns.map(
      (pattern) =>
        new RegExp(
          `^${pattern
            .replace(/[.*+?^$()|\\]/g, '\\$&')
            .replace(/\{[^}]+\}\[-slug\]/g, '\\d+(-[a-z0-9-]+)?')
            .replace(/\{[^}]+\}/g, '[^/]+')}$`,
        ),
    );
    for (const path of paths.filter((path) => path !== '/welcome'))
      expect(
        said.some((pattern) => pattern.test(path)),
        path,
      ).toBe(true);
    // And opens as itself: its canonical address, not a redirect.
    for (const path of [cars[0], cars[cars.length - 1], '/dealers']) {
      const answer = await request.get(`${drawn.origin}${path}`, { maxRedirects: 0 });
      expect(answer.status(), path).toBe(200);
      expect(await answer.text()).toContain(`<link rel="canonical" href="${path}">`);
    }

    // A white-label host is told its own addresses, and robots.txt points there.
    const branded = await (await request.get(`${drawn.origin}/sitemap.xml`, { headers: { host: WHITE_LABEL } })).text();
    expect(branded).toContain(`<loc>http://${WHITE_LABEL}/vehicles</loc>`);
    expect(branded).not.toContain('127.0.0.1');
    const robots = await (await request.get(`${drawn.origin}/robots.txt`, { headers: { host: WHITE_LABEL } })).text();
    expect(robots).toBe(
      `User-agent: *\nDisallow: /api/\nAllow: /api/file\nAllow: /api/og\nDisallow: /_mistri/\n\nSitemap: http://${WHITE_LABEL}/sitemap.xml\n`,
    );
  });

  test("past a part's size the sitemap is an index of key ranges that together name every address once", async ({ request }) => {
    const index = await (await request.get(`${plain.origin}/sitemap.xml`)).text();
    expect(index).toContain('<sitemapindex');
    const parts = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1].replaceAll('&amp;', '&'));
    expect(parts[0]).toBe(`${plain.origin}/sitemap.xml?part=pages`);
    const all: string[] = [];
    for (const part of parts) {
      const xml = await (await request.get(part)).text();
      expect(xml).toContain('<urlset');
      const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
      expect(locs.length).toBeLessThanOrEqual(40);
      all.push(...locs);
    }
    expect(new Set(all).size).toBe(all.length);
    const cars = all.filter((loc) => loc.includes('/vehicles/'));
    expect(cars).toHaveLength(forSale().length);
    expect((await request.get(`${plain.origin}/sitemap.xml?part=nothing`)).status()).toBe(404);
  });

  test('a picture is made at the widths a srcset names, in the format the browser takes', async ({ request }) => {
    const key = encodeURIComponent(JSON.stringify({ id: 1 }));
    const at = (w: string) => `${drawn.origin}/api/file?table=vehicle_photo&key=${key}&inline=1&w=${w}`;
    const original = await request.get(`${drawn.origin}/api/file?table=vehicle_photo&key=${key}&inline=1`);
    const avif = await request.get(at('320'), { headers: { accept: 'image/avif,image/webp,*/*' } });
    expect(avif.status()).toBe(200);
    expect(avif.headers()['content-type']).toBe('image/avif');
    expect(avif.headers().vary).toContain('Accept');
    expect((await avif.body()).length).toBeLessThan((await original.body()).length);
    const webp = await request.get(at('640'), { headers: { accept: 'image/webp' } });
    expect(webp.headers()['content-type']).toBe('image/webp');
    const again = await request.get(at('320'), { headers: { accept: 'image/avif', 'if-none-match': avif.headers().etag } });
    expect(again.status()).toBe(304);
    const refused = await request.get(at('333'));
    expect(refused.status()).toBe(400);
    expect(await refused.text()).toContain('w must be one of 160, 320, 480, 640, 960, 1280, 1920');
    // Never a table the public may not read, at any width.
    const inquiry = await request.get(`${drawn.origin}/api/file?table=inquiry&key=${key}&inline=1&w=320`);
    expect(inquiry.status()).toBeGreaterThanOrEqual(400);
    expect(inquiry.headers()['content-type'] ?? '').not.toMatch(/^image\//);
  });
});
