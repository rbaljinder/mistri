/** The Console's Operations and Analytics rooms on a disposable native
 * Console with its own stores: both rooms open, and a dead job is redriven. */
import { mkdirSync } from 'node:fs';
import { test, expect } from './support/harness';
import { consoleHostFixture } from '../test/fixtures/consoleHost';
import { consoleOperations } from '../test/fixtures/consoleOperations';

const SHOTS = process.env.TW_CONSOLE_SHOTS;
test.use({ deviceScaleFactor: 2 });

for (const width of [1280, 390])
  test(`Console Operations and Analytics at ${width}px`, async ({ page, context }, info) => {
    // A fresh Console compiles its client cold through Vite, and walks two rooms.
    test.setTimeout(90_000);
    const cleanups: (() => Promise<void>)[] = [];
    const operations = consoleOperations();
    cleanups.push(() => operations.close());
    const fixture = await consoleHostFixture(
      {
        after: (cleanup) => {
          cleanups.push(cleanup);
        },
      },
      false,
      0,
      operations.build,
    );
    const shot = (name: string) => {
      const path = SHOTS ? `${SHOTS}/console-${name}-${width}.png` : info.outputPath(`console-${name}-${width}.png`);
      if (SHOTS) mkdirSync(SHOTS, { recursive: true });
      return page.screenshot({ path, fullPage: true });
    };
    try {
      fixture.consoleHost.start();
      fixture.grant('mistri-console', ['admitted']);
      fixture.grant('depot', ['operator']);
      fixture.grant('ledger', ['clerk']);
      const cookie = fixture.cookie('alice'),
        at = cookie.indexOf('=');
      await context.addCookies([{ name: cookie.slice(0, at), value: cookie.slice(at + 1), url: fixture.origin }]);
      await page.setViewportSize({ width, height: 900 });

      await page.goto(`${fixture.base}/operations`);
      await expect(page.getByRole('tab', { name: /^Work(?!flows)/ })).toHaveAttribute('aria-selected', 'true', { timeout: 45_000 });
      // The stream opens on what needs attention: the dead job and the dead delivery, under four figures.
      // A phone has no width for the four facets: there they are one menu, saying the same.
      if (width > 760) await expect(page.getByRole('radio', { name: /^Needs attention/ })).toHaveAttribute('aria-checked', 'true');
      else await expect(page.getByRole('button', { name: 'Show' })).toContainText('Needs attention');
      await expect(page.getByRole('region', { name: 'Health' }).getByText('Needs attention')).toBeVisible();
      await expect(page.getByRole('button', { name: 'restock', exact: true })).toBeVisible();
      await expect(page.getByText(/^Delivery to /).first()).toBeVisible();
      await expect(page.getByText('Dead', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('reconcile')).toHaveCount(0);
      await shot('operations');
      // The row's own Redrive, then the job opened beside the list names who redrove it.
      await page.getByRole('button', { name: 'Redrive restock' }).click();
      await expect(page.getByText('Redriven. It runs again with a fresh budget.')).toBeVisible();
      await expect(page.getByText('Retrying', { exact: true }).first()).toBeVisible();
      expect((await operations.state.jobs.depot.inspect({}, 10))[0]).toMatchObject({ state: 'retry', redrives: 1 });
      // The palette jumps to the job and opens its drawer.
      await page.keyboard.press('ControlOrMeta+k');
      await page.getByRole('combobox', { name: 'Jump to anything in the Console' }).fill('restock');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('region', { name: 'Attempts' }).getByText('alice')).toBeVisible();
      await expect(page.getByRole('region', { name: 'Payload' })).toBeVisible();
      // On a phone the opened job is a dialog over the room; it closes before the tabs are reached.
      if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
      await page.getByRole('tab', { name: /^Stores/ }).click();
      await expect(page.getByText('Up to date').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);

      await page.goto(`${fixture.base}/analytics`);
      await expect(page.getByText('Not attributed', { exact: true })).toBeVisible();
      await expect(page.getByText(/subject-a|visitor-z|secret-sku/)).toHaveCount(0);
      await shot('analytics');
      // A funnel is a view of its own, drawn as steps.
      await page.getByRole('tab', { name: 'Funnels' }).click();
      await expect(page.getByRole('region', { name: 'checkout' })).toBeVisible();
      await expect(page.getByText(/subject-a|visitor-z|secret-sku/)).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  });
