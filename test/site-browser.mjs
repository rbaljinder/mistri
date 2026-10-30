/** Standalone site verification: no App servers or shared e2e fixture writes. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const output = resolve(fileURLToPath(new URL('../site/dist/', import.meta.url)));
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.wasm': 'application/wasm',
};
/* Starlight's Search button can take a click before its element has wired the dialog, which a slow runner shows as a
   dialog that never opens: click again until it does, then wait for Pagefind's input. */
async function openSearch(page) {
  const dialog = page.locator('dialog[open]');
  for (let attempt = 0; attempt < 5 && !(await dialog.isVisible()); attempt++) {
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await dialog.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  }
  await page.locator('dialog input.pagefind-ui__search-input').waitFor({ state: 'visible' });
}

/* Starlight draws Pagefind's input from a requestIdleCallback with no deadline, which a busy CI runner can starve for
   longer than any wait (the search on the second page never appeared in 60 s): give the page's idle callbacks one. */
const IDLE_DEADLINE = `{ const idle = window.requestIdleCallback; if (idle) window.requestIdleCallback = (callback, options) => idle.call(window, callback, { timeout: 2000, ...options }); }`;

async function files(directory) {
  return (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map(async (entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? files(path) : [path];
      }),
    )
  ).flat();
}
/* The component library at /components/ is Storybook's own application: its
   pages are checked below as the library, not as documentation pages. */
const library = join(output, 'components');
const html = (await files(output)).filter(
  (path) => path.endsWith('.html') && !path.endsWith('/404.html') && !path.startsWith(library + '/'),
);
assert.ok(html.length >= 9, 'Build the documentation site before browser verification.');
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    let path = resolve(output, '.' + decodeURIComponent(url.pathname));
    if (path !== output && !path.startsWith(output + '/')) throw new Error('Outside output');
    let metadata = await stat(path).catch(() => null);
    if (metadata?.isDirectory()) path = join(path, 'index.html');
    else if (!metadata) path += '.html';
    const body = await readFile(path);
    response.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    response.end(await readFile(join(output, '404.html')));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let checks = 0;
try {
  browser = await chromium.launch();
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(IDLE_DEADLINE);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const path of html) {
      const route = '/' + relative(output, path).replace(/index\.html$/, '');
      const response = await page.goto(origin + route);
      assert.equal(response.status(), 200, route);
      await page.locator('h1').waitFor({ state: 'visible' });
      await page.evaluate(() => globalThis.document.fonts.ready);
      assert.ok(await page.locator('main').isVisible(), route);
      assert.ok(
        await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth + 1),
        `Horizontal page overflow at ${width}px: ${route}`,
      );
      assert.deepEqual(errors, [], `Uncaught page error: ${route}`);
      checks++;
    }
    /* Every screenshot opens whole: a button named by its alt text, Enter
       opens it at the file as captured, Escape closes it and focus comes back;
       a tap beside the picture closes it too. */
    await page.goto(origin + '/docs/looks/');
    const images = page.locator('main .sl-markdown-content img');
    assert.equal(
      await page.locator('main button.tw-zoom > img').count(),
      await images.count(),
      'Every content image opens in the lightbox',
    );
    const zoom = page.locator('main button.tw-zoom').first();
    assert.match(await zoom.evaluate((button) => button.innerText + (button.querySelector('img')?.alt ?? '')), /Lumen/);
    await zoom.focus();
    await page.keyboard.press('Enter');
    const lightbox = page.locator('dialog.tw-lightbox');
    await lightbox.waitFor({ state: 'visible' });
    const shown = lightbox.locator('img');
    assert.equal(await shown.getAttribute('alt'), await images.first().getAttribute('alt'));
    await shown.evaluate((image) => image.decode());
    assert.ok(
      await shown.evaluate((image) => image.complete && image.naturalWidth >= 2 * 1280),
      'The lightbox shows the file as captured, at twice its CSS size',
    );
    assert.ok(await lightbox.getByRole('button', { name: 'Close' }).evaluate((button) => button === globalThis.document.activeElement));
    await page.keyboard.press('Escape');
    await lightbox.waitFor({ state: 'hidden' });
    assert.ok(await zoom.evaluate((button) => button === globalThis.document.activeElement), 'Closing hands focus back to the image');
    await zoom.click();
    await lightbox.waitFor({ state: 'visible' });
    await page.mouse.click(4, width === 390 ? 880 : 890);
    await lightbox.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    checks++;
    await page.goto(origin + '/docs/commands/');
    const menu = page.locator('button[popovertarget="starlight__sidebar"]');
    if (await menu.isVisible()) {
      await menu.click();
      assert.ok(await page.locator('#starlight__sidebar').isVisible());
      await menu.click();
      checks++;
    }
    await openSearch(page);
    const search = page.locator('dialog input.pagefind-ui__search-input');
    await search.fill('receipt');
    const result = page.locator('dialog a[href*="/docs/commands/"]').first();
    await result.waitFor({ state: 'visible' });
    await result.click();
    assert.ok(new URL(page.url()).pathname.startsWith('/docs/commands/'));
    assert.deepEqual(errors, []);
    checks++;
    await page.goto(origin + '/docs/build-with-an-agent/');
    assert.ok(
      (await page.locator('main pre').allTextContents()).some(
        (text) => /Build a mistri App/i.test(text) && text.includes('Do not deploy or publish'),
      ),
      'Agent guide must retain the copyable implementation/verification brief',
    );
    await openSearch(page);
    await page.locator('dialog input.pagefind-ui__search-input').fill('agent brief');
    const agentGuide = page.locator('dialog a[href*="/docs/build-with-an-agent/"]').first();
    await agentGuide.waitFor({ state: 'visible' });
    await agentGuide.click();
    assert.ok(new URL(page.url()).pathname.startsWith('/docs/build-with-an-agent/'));
    assert.deepEqual(errors, []);
    checks++;
    await context.close();
  }
  /* The library opens from its sub-path, draws a story in the default look and
     another look, and neither the manager nor the preview throws. */
  if (await stat(join(library, 'index.html')).catch(() => null)) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(IDLE_DEADLINE);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(origin + '/components/?path=/story/rooms-list--room');
    const preview = page.frameLocator('#storybook-preview-iframe');
    await preview.locator('#storybook-root table').first().waitFor({ state: 'visible' });
    assert.equal(
      await preview.locator('html').getAttribute('data-visual-theme'),
      'workshop',
      'The library opens in Workshop, the default look',
    );
    await page.goto(origin + '/components/?path=/story/dashboards-stat-cards--trends-and-marks&globals=look:sage');
    await preview.locator('#storybook-root .home-cards').waitFor({ state: 'visible' });
    assert.equal(await preview.locator('html').getAttribute('data-visual-theme'), 'sage');
    await page.goto(origin + '/docs/components/');
    assert.ok((await page.locator('main a[href^="/components/?path=/story/"]').count()) >= 20, 'The component tour links into the library');
    assert.deepEqual(errors, [], 'The component library threw');
    checks += 3;
    await context.close();
  }
  const noScript = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 900 } });
  const page = await noScript.newPage();
  await page.goto(origin + '/docs/commands/');
  assert.ok(await page.locator('h1').isVisible());
  assert.ok((await page.locator('main pre').count()) > 0, 'Code examples must not depend on JavaScript');
  await page.goto(origin + '/docs/build-with-an-agent/');
  assert.ok(
    (await page.locator('main pre').allTextContents()).some((text) => text.includes('npx @mistriwork/mistri check --app')),
    'Agent authoring recipe must be readable without JavaScript',
  );
  checks++;
  await page.goto(origin + '/');
  assert.ok((await page.locator('main a[href^="/docs/"]').count()) >= 8, 'Markdown must retain a navigable no-JS index');
  assert.equal((await page.goto(origin + '/missing-documentation-route')).status(), 404);
  checks += 3;
  await noScript.close();
  console.log(`Documentation browser checks: ${checks} passed (desktop, mobile, search, navigation, no-JS and 404).`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
