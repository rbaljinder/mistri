import { expect, test } from './support/harness';
import { startSample } from './support/sampleServer';

/**
 * The startup outline's "Check that the server is running" (index.html's
 * startup script) is said only when the server is not answering: fifteen
 * seconds of a cold start under load, with the server up, keeps the outline.
 * The client's entry is held so the page stays starting, and the page's clock
 * is moved on rather than waited for. This spec's own server (listen(0)).
 */
test.describe('the startup notice', () => {
  test.setTimeout(120_000);
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    sample = await startSample('tick');
  });
  test.afterAll(async () => {
    await sample?.stop();
  });

  test('waits while the server answers, and speaks once it does not', async ({ page }) => {
    await page.clock.install();
    /* The entry never arrives: the page is a start that is taking its time. Every script is held, since the entry is
       boot.js from source but a content-named chunk from the build the browser gate serves. */
    await page.route('**/*', (route) => (route.request().resourceType() === 'script' ? undefined : route.fallback()));
    await page.goto(`${sample.origin}/`, { waitUntil: 'commit' });
    const status = page.locator('#startup-status');
    await expect(status).toBeAttached();
    const asked = page.waitForResponse((response) => new URL(response.url()).pathname === '/healthz');
    await page.clock.fastForward(16_000);
    expect((await asked).ok()).toBe(true);
    // The server answered: the outline stays, and nothing says the server is down.
    await page.waitForTimeout(300);
    await expect(status).not.toHaveAttribute('data-slow');
    await expect(status.locator('p')).toHaveText('Loading...');
    // Fifteen seconds on, the server stops answering: now the page says so.
    await page.route('**/healthz', (route) => route.abort());
    await page.clock.fastForward(15_000);
    await expect(status).toHaveAttribute('data-slow', 'true');
    await expect(status.locator('p')).toHaveText('Still loading. Check that the server is running.');
    await expect(status.getByRole('link', { name: 'Reload' })).toBeVisible();
  });
});
