import { expect, test, type Page } from './support/harness';
import { COMMAND_APP_ID, startCommandApp } from './support/commandDeskServer';

// The fixture App's own record page over disposable data; never the user's preview.
test.describe('related-list layout stability', () => {
  test.setTimeout(60_000);
  let app: Awaited<ReturnType<typeof startCommandApp>>;
  test.beforeAll(async () => {
    // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
    test.setTimeout(120_000);
    app = await startCommandApp();
  });
  test.afterAll(async () => {
    await app?.stop();
  });

  const geometry = (page: Page) =>
    page.locator('.page-tabs').evaluate((element) => ({
      top: element.getBoundingClientRect().top,
      height: element.getBoundingClientRect().height,
      scroll: document.querySelector('.content')!.scrollTop,
    }));

  for (const [width, initial] of [
    [1440, 'Documents'],
    [1024, 'Documents'],
    [390, 'Documents'],
    [1440, 'Reviews'],
    [390, 'Reviews'],
  ] as const)
    test(`populated, shorter, loading and empty tabs keep their place at ${width}px from ${initial}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const account = app.accounts[0];
      const login = await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
        headers: { origin: app.origin },
        data: { email: account.email, password: account.password },
      });
      expect(login.ok()).toBe(true);
      await page.goto(`${app.origin}/@application${initial === 'Reviews' ? '!Reviews' : ''}~3`);
      const panel = page.locator('.page-tabpanel:not([hidden])');
      await expect(panel.locator('tbody tr')).toHaveCount(initial === 'Documents' ? 3 : 1);
      await expect(page.locator('.page-body .loading')).toHaveCount(0);
      await page.locator('.content').evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const before = await geometry(page);
      const stable = async () => {
        const after = await geometry(page);
        for (const key of ['top', 'height', 'scroll'] as const) expect(Math.abs(after[key] - before[key]), key).toBeLessThan(1);
      };

      await page.getByRole('tab', { name: 'Reviews', exact: true }).click();
      await expect(panel.locator('tbody tr')).toHaveCount(1);
      await stable();

      // Hold the unopened tab's response so loading is checked separately from
      // its empty result. Previously both could clamp scroll at the page bottom.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/api/view/run*', async (route) => {
        await gate;
        await route.continue();
      });
      try {
        await page.getByRole('tab', { name: 'Decisions', exact: true }).click();
        await expect(panel.locator('.loading')).toBeVisible();
        await stable();
      } finally {
        release();
      }
      await expect(panel).toContainText('No decisions yet.');
      // An empty list in an App is the empty sentence, with no header row over nothing.
      await expect(panel.locator('th')).toHaveCount(0);
      await stable();

      // Inactive panels retain geometry but cannot be read, focused or clicked.
      await expect(page.getByRole('tabpanel')).toHaveCount(1);
      for (const hidden of await page.locator('.page-tabpanel[hidden]').all()) {
        await expect(hidden).toBeHidden();
        await expect(hidden).toHaveAttribute('inert', '');
      }
      await page.getByRole('tab', { name: 'Decisions', exact: true }).press('ArrowLeft');
      await expect(page.getByRole('tab', { name: 'Reviews', exact: true })).toBeFocused();
      await stable();
      await page.getByRole('tab', { name: initial, exact: true }).click();
      await expect(panel.locator('tbody tr')).toHaveCount(initial === 'Documents' ? 3 : 1);
      await stable();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });

  /* A related list's tabs draw 22px tall to the look, and a finger lands on the hit area drawn round each on a touch
     screen (structure.css), the 40px grade asks of a phone (UI1); at a desk the tab keeps its own small box. */
  test('a tab takes a finger-sized hit area on a touch screen, and keeps its drawn size at a desk', async ({ browser }) => {
    for (const touch of [true, false]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: touch });
      const page = await context.newPage();
      try {
        const account = app.accounts[0];
        const login = await page.request.post(`${app.origin}/api/auth/sign-in/email`, {
          headers: { origin: app.origin },
          data: { email: account.email, password: account.password },
        });
        expect(login.ok()).toBe(true);
        await page.goto(`${app.origin}/@application~3`);
        const tabs = page.locator('.page-tab');
        await expect(tabs.first()).toBeVisible();
        const reach = await tabs.evaluateAll((list) =>
          list.map((tab) => {
            const drawn = getComputedStyle(tab, '::before');
            const area = drawn.content !== 'none' && drawn.position === 'absolute' ? parseFloat(drawn.height) || 0 : 0;
            return [tab.textContent, Math.max(tab.getBoundingClientRect().height, area)] as const;
          }),
        );
        expect(reach.length).toBeGreaterThan(1);
        if (touch) expect(reach.filter(([, height]) => height < 40)).toEqual([]);
        else expect(reach.every(([, height]) => height < 40)).toBe(true);
      } finally {
        await context.close();
      }
    }
  });
});
