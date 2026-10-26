// e2e-client: source
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from './support/harness';
import { startDeskBlocks } from './support/deskBlocksServer';
import { startSample, PAYDAY_ADMIN } from './support/sampleServer';

/**
 * The ends of a record page and of the side menu, each on a server of its own (the parallel lane).
 * A record's pane ends with its own padding, not a window of empty ground after the last section
 * (the rail, a column of the shell's height, then runs to the bottom of the document); a conversation's
 * box hands the wheel to the page when it has nothing left to scroll; and the side menu's fade covers
 * a list's last entry only while the list scrolls.
 */
test.describe('the ends of a page', () => {
  test.setTimeout(120_000);

  async function signIn(page: Page, origin: string, data: { email: string; password: string }) {
    const response = await page.request.post(`${origin}/api/auth/sign-in/email`, { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
  }

  /** What is left to scroll past the lowest thing drawn in the pane, and whether the document itself scrolls. */
  const tail = (page: Page) =>
    page.evaluate(() => {
      const pane = document.querySelector('.content') as HTMLElement;
      const box = pane.getBoundingClientRect();
      const scale = box.height / pane.clientHeight;
      let bottom = 0;
      for (const element of pane.querySelectorAll('*')) {
        if (getComputedStyle(element).position === 'fixed') continue;
        const rect = element.getBoundingClientRect();
        if (rect.height > 0) bottom = Math.max(bottom, rect.bottom);
      }
      const scroller = document.scrollingElement as HTMLElement;
      const side = document.querySelector('.sidebar')?.getBoundingClientRect();
      return {
        past: pane.scrollHeight - Math.max(0, (bottom - box.top) / scale),
        paneRoom: pane.scrollHeight - pane.clientHeight,
        documentRoom: scroller.scrollHeight - innerHeight,
        sideBottom: side ? Math.round(side.bottom) : null,
        shellBottom: Math.round(box.bottom),
      };
    });

  for (const [width, height] of [
    [1440, 900],
    [1000, 1100],
    [390, 800],
  ] as const)
    test(`a record page ends with its padding at ${width}x${height}`, async ({ page }) => {
      const sample = await startSample('payday');
      try {
        await signIn(page, sample.origin, PAYDAY_ADMIN);
        await page.setViewportSize({ width, height });
        for (const path of ['/benefit-plans/~1', '/departments/~1']) {
          await page.goto(`${sample.origin}${path}`);
          await expect(page.locator('.page-section').first()).toBeVisible();
          await page.waitForTimeout(1500);
          const found = await tail(page);
          // The page's bottom padding is 16px; a window of empty ground after the last section is the defect.
          expect(found.past, path).toBeLessThanOrEqual(40);
          expect(found.documentRoom, path).toBeLessThanOrEqual(1);
          if (width > 760) expect(found.sideBottom, path).toBe(found.shellBottom);
        }
      } finally {
        await sample.stop();
      }
    });

  test('the side menu fades only a list that scrolls, and the workspace name wraps to two lines', async ({ page }) => {
    const sample = await startSample('payday');
    try {
      await signIn(page, sample.origin, PAYDAY_ADMIN);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${sample.origin}/`);
      const list = page.locator('#table-list');
      await expect(list.getByRole('button', { name: 'Reports', exact: true })).toBeVisible();
      for (const height of [1100, 900, 700]) {
        await page.setViewportSize({ width: 1440, height });
        await page.waitForTimeout(400);
        const state = await page.evaluate(() => {
          const el = document.querySelector('#table-list') as HTMLElement;
          const last = [...el.querySelectorAll('li')].at(-1)!.getBoundingClientRect();
          const fade = getComputedStyle(el, '::after');
          return {
            scrolls: el.scrollHeight > el.clientHeight + 1,
            opacity: Number(fade.opacity),
            atEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
            lastBottom: last.bottom,
            listBottom: el.getBoundingClientRect().bottom,
          };
        });
        if (!state.scrolls) {
          // Room to spare: nothing is faded, and the last entry stands whole above the footer.
          expect(state.opacity, `${height}`).toBe(0);
          expect(state.lastBottom, `${height}`).toBeLessThanOrEqual(state.listBottom);
        } else {
          expect(state.opacity, `${height}`).toBeGreaterThan(0);
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      const name = page.locator('.sidebar-identity-copy strong');
      await expect(name).toHaveText('Payday demo workspace');
      expect(await name.evaluate((n) => n.scrollWidth <= n.clientWidth + 1 && n.scrollHeight <= n.clientHeight + 1)).toBe(true);
      expect(
        await name.evaluate((n) => Math.round(n.getBoundingClientRect().height / parseFloat(getComputedStyle(n).lineHeight) / 1.0)),
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await sample.stop();
    }
  });

  test('the wheel over a conversation reaches the page once the box is at its end, or has no overflow', async ({ page }) => {
    const app = await startDeskBlocks();
    try {
      await signIn(page, app.origin, app.account);
      await page.setViewportSize({ width: 1100, height: 520 });
      await page.goto(`${app.origin}/all/1`);
      const box = page.locator('.timeline-scroll');
      await expect(box.locator('[data-timeline-row]').first()).toBeVisible();
      await page.waitForTimeout(800);
      const log = async (label: string) => {
        const at = await page.evaluate(() => {
          const pane = document.querySelector('.content') as HTMLElement;
          const own = document.querySelector('.timeline-scroll') as HTMLElement;
          return {
            page: Math.round(pane.scrollTop),
            pageRoom: Math.round(pane.scrollHeight - pane.clientHeight),
            box: Math.round(own.scrollTop),
            boxRoom: own.scrollHeight - own.clientHeight,
          };
        });
        console.log(`wheel ${label}: ${JSON.stringify(at)}`);
        return at;
      };
      // Bring the box to the middle of the window, then spin the wheel over it.
      await box.evaluate((n) => n.scrollIntoView({ block: 'center' }));
      const rect = (await box.boundingBox())!;
      await page.mouse.move(rect.x + rect.width / 2, rect.y + Math.min(rect.height / 2, 80));
      await box.evaluate((n) => (n.scrollTop = n.scrollHeight));
      const before = await log('box at its end');
      const start = before.page;
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(400);
      const after = await log('after 400 down');
      const under = await page.evaluate(
        ([x, y]) => {
          const e = document.elementFromPoint(x!, y!);
          return e ? e.tagName + '.' + String(e.className) : null;
        },
        [rect.x + rect.width / 2, rect.y + Math.min(rect.height / 2, 80)],
      );
      console.log('under pointer', under);
      // Down at the end of the box, the page moves on (when it has room); or, with no overflow, always.
      if (before.pageRoom - before.page > 0) expect(after.page).toBeGreaterThan(start);
      // Up from the top of the box, likewise.
      await box.evaluate((n) => (n.scrollTop = 0));
      const mid = await log('box at its top');
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(400);
      const up = await log('after 400 up');
      if (mid.page > 0) expect(up.page).toBeLessThan(mid.page);
    } finally {
      await app.stop();
    }
  });
});
