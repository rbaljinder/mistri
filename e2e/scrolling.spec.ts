import { expect, test } from './support/harness';

test.use({ hasTouch: true, isMobile: true });
const CRM = `http://127.0.0.1:${process.env.TABLEWALK_E2E_CRM_PORT}/`;

for (const theme of ['lumen', 'mono'])
  test(`iPad record scrolling reaches the final section with ${theme} theme`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await page.addInitScript((value) => localStorage.setItem('mistri.visual-theme', value), theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${CRM}/@opportunity~19`);
    // The deal's tabs and its aside are drawn: the record is taller than an iPad's window.
    await expect(page.getByRole('tab', { name: 'Quote lines' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Record context' })).toBeVisible();
    await expect(page.locator('.skeleton')).toHaveCount(0);
    const content = page.locator('.content');
    const cdp = await page.context().newCDPSession(page);
    for (const viewport of [
      { width: 1024, height: 1366 },
      { width: 1366, height: 1024 },
    ]) {
      await page.setViewportSize(viewport);
      const bottom = async () => {
        const frame = await content.boundingBox();
        expect(frame!.y + frame!.height).toBeLessThanOrEqual(viewport.height + 1);
        // The page's main column and its aside each end in a section of their own: both are reached.
        const tails = await page.locator('.page-body > :last-child').all();
        expect(tails.length).toBeGreaterThan(0);
        for (const tail of tails) {
          const box = await tail.boundingBox();
          expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
        }
      };
      await content.evaluate((node) => {
        node.scrollTop = 0;
      });
      // Scrolling must have somewhere to go, or reaching the end proves nothing. Lumen's flat record can fit an
      // iPad, and then its last sections are already in view; where it is a little taller than the window (a
      // portrait iPad, whose related rows stand 44px tall under a finger since 7c2082f5d), the short scroll is
      // still scrolled and its end reached. Mono's taller record scrolls far.
      const room = await content.evaluate((node) => node.scrollHeight - node.clientHeight);
      if (room < 2 && theme === 'lumen') {
        await bottom();
        continue;
      }
      expect(room).toBeGreaterThan(theme === 'lumen' ? 0 : 100);
      await page.mouse.move(viewport.width / 2, viewport.height / 2);
      await page.mouse.wheel(0, 10_000);
      await expect.poll(() => content.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
      await bottom();

      await content.evaluate((node) => {
        node.scrollTop = 0;
      });
      // Real browser touch input, not scrollIntoView or a synthetic DOM event.
      for (let gesture = 0; gesture < 5; gesture++) {
        const x = viewport.width / 2;
        const start = viewport.height - 100;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] });
        for (let y = start - 60; y > 150; y -= 80) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
          await page.waitForTimeout(20);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(100);
      }
      await expect.poll(() => content.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
      await bottom();
      await page.screenshot({ path: testInfo.outputPath(`ipad-bottom-${viewport.width}.png`) });
    }
  });
