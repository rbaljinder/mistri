/** A disposable native Console, independent of preview ports and shared seeds. */
import { test, expect } from './support/harness';
import { consoleHostFixture } from '../test/fixtures/consoleHost';

for (const width of [1280, 390])
  test(`Console targeting, rollout and history at ${width}px`, async ({ page, context }, info) => {
    const cleanups: (() => Promise<void>)[] = [];
    const fixture = await consoleHostFixture(
      {
        after: (cleanup) => {
          cleanups.push(cleanup);
        },
      },
      true,
    );
    try {
      fixture.consoleHost.start();
      fixture.grant('mistri-console', ['admitted']);
      fixture.grant('shop', ['reader', 'manager', 'killer']);
      fixture.state.overrides.feature = { value: true, rollout: 25, rules: [{ audiences: ['readers'], value: false }] };
      const cookie = fixture.cookie('alice'),
        at = cookie.indexOf('=');
      await context.addCookies([{ name: cookie.slice(0, at), value: cookie.slice(at + 1), url: fixture.origin }]);
      await page.setViewportSize({ width, height: 900 });
      // The App has one scope, so the room opens it without asking.
      await page.goto(`${fixture.base}/`);
      await expect(page.getByRole('button', { name: 'feature', exact: true })).toBeVisible();
      // The flag rolls out to a quarter, so the Rolling out view holds it; a manager's row carries its switch.
      // A phone has no width for five views: there they are one menu.
      const view = async (name: RegExp) => {
        if (width > 760) await page.getByRole('radiogroup', { name: 'Show flags' }).getByRole('radio', { name }).click();
        else {
          await page.getByRole('button', { name: 'Show flags' }).click();
          await page.getByRole('option', { name }).click();
        }
      };
      await view(/^Rolling out/);
      await expect(page.getByRole('row', { name: /^feature/ })).toContainText('25%');
      await view(/^All/);
      await expect(page.getByRole('switch', { name: 'Turn feature off' })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`console-overview-${width}.png`), fullPage: true });
      // ⌘K (Ctrl K) finds the flag from anywhere in the room; Enter opens its sheet.
      await page.keyboard.press('ControlOrMeta+k');
      await page.getByRole('combobox', { name: 'Jump to anything in the Console' }).fill('feat');
      await page.keyboard.press('Enter');
      const sheet =
        width < 760 ? page.getByRole('dialog', { name: 'Flag details' }) : page.getByRole('complementary', { name: 'Flag details' });
      await expect(sheet.getByText('Serving', { exact: true })).toBeVisible();
      await expect(sheet.getByText(/to 25% of everyone else/)).toBeVisible();
      await page.screenshot({ path: info.outputPath(`console-detail-${width}.png`), fullPage: true });
      await expect(sheet.getByLabel('Rollout percentage')).toHaveValue('25');
      await sheet.getByLabel('Rollout percentage').fill('50');
      await sheet.getByRole('button', { name: 'Edit rule 1' }).click();
      await sheet.getByRole('checkbox', { name: 'managers' }).check();
      await expect(sheet.getByRole('region', { name: 'Staged changes' })).toContainText('2 changes staged');
      await page.screenshot({ path: info.outputPath(`console-editor-${width}.png`), fullPage: true });
      await sheet.getByRole('button', { name: 'Review changes' }).click();
      await expect(sheet.getByRole('list', { name: 'Changes' }).getByRole('listitem')).toHaveCount(2);
      await sheet.getByLabel('Reason', { exact: true }).fill('Reviewed second rollout cohort');
      await sheet.getByRole('button', { name: 'Apply change', exact: true }).click();
      await expect(sheet.getByText(/Change applied at revision 1/)).toBeVisible();
      expect(fixture.state.overrides.feature).toEqual({
        value: true,
        rollout: 50,
        rules: [{ audiences: ['readers', 'managers'], value: false }],
      });
      // The sheet reads the flag again after an applied change: the sentence says what is served now.
      await expect(sheet.getByText(/to 50% of everyone else/)).toBeVisible();
      await sheet.getByRole('tab', { name: 'History', exact: true }).click();
      await expect(sheet.getByText('Reviewed second rollout cohort')).toBeVisible();
      await page.screenshot({ path: info.outputPath(`console-history-${width}.png`), fullPage: true });
      await sheet.getByRole('button', { name: 'Restore revision 1' }).click();
      await expect(sheet.getByLabel('Revision to restore')).toHaveValue('1');
      expect(fixture.state.revision).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  });
