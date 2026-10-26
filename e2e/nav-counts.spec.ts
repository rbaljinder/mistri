import { expect, test, type Page } from './support/harness';
import { startSample } from './support/sampleServer';
import { scalar } from './support/db';
import { SEEN_TOUR } from './support/fixtures';
import { NAV_COUNT_LIMIT } from '../packages/engine/src/shared/reads';

/**
 * The app menu's numbers are the lists' sizes now, not the catalog's
 * snapshot from when the page loaded.
 *
 * Thread over a fresh seed, with its side menu: Issues and Inbox are the
 * whole issue table, Triage stands on `status = backlog or status = ready`,
 * Projects, Cycles, Updates and People are whole tables. A row's number is
 * asked of the server in `/api/counts`, with `/api/count` and `/api/run` as
 * its fallback — and asked again when the window
 * comes back, every two minutes while it is visible, and at once after this
 * browser's own write.
 */
const TRIAGE = "SELECT count(*) FROM issue WHERE status IN ('backlog','ready')";
/* By text, not by role: a record modal makes the rest of the page inert,
   and the menu's numbers are read while one is open. */
const menuRow = (page: Page, label: string) => page.locator('.sidebar button[data-table]').filter({ hasText: new RegExp(`^${label}`) });
const countOf = (page: Page, label: string) => menuRow(page, label).locator('.rows');

/** The menu's count requests, as "path what", in the order they were sent. */
function recordCounts(page: Page): string[] {
  const asked: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (!['/api/count', '/api/run', '/api/counts'].includes(path)) return;
    const body = JSON.parse(request.postData() ?? '{}') as {
      table?: string;
      q?: string;
      limit?: number;
      items?: string[];
      countLimit?: number;
    };
    if (path === '/api/counts') {
      if (body.countLimit === NAV_COUNT_LIMIT)
        asked.push(...(body.items ?? []).map((item) => (item.includes(' ') ? `run ${item}` : `count ${item}`)));
      return;
    }
    if (path === '/api/count') asked.push(`count ${body.table}`);
    // The menu's condition counts are the one-row runs; the lists' own reads are pages.
    else if (body.limit === 1) asked.push(`run ${body.q}`);
  });
  return asked;
}

/** Enables the feature only in a test's served app; Thread itself keeps its default-off shell. */
async function enableSidebarCounts(page: Page): Promise<void> {
  await page.route(/\/api\/app(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as {
      app: { ui?: { shell?: Record<string, unknown> }; views?: Record<string, Record<string, unknown>> };
    };
    payload.app.ui ??= {};
    payload.app.ui.shell = { ...payload.app.ui.shell, counts: true };
    /* Every list says it is counted: this spec is of the counting, not of which lists are work
       (shared/menuCounts.ts, test/menu-counts.test.ts). */
    for (const view of Object.values(payload.app.views ?? {})) if (typeof view.table === 'string') view.count ??= true;
    await route.fulfill({ response, json: payload });
  });
}

// This spec authors menu counts by intercepting the App payload.
test.use({ carryFirstPaint: false });

test.describe('App menu counts', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.setTimeout(60_000);
  test.beforeEach(async () => {
    sample = await startSample('thread');
  });
  test.afterEach(async () => {
    await sample?.stop();
  });

  test("each count is its list's, follows another session's write on focus, and this browser's own insert at once", async ({
    page,
    browser,
  }) => {
    await page.setViewportSize({ width: 1440, height: 924 });
    await enableSidebarCounts(page);
    await page.goto(`${sample.origin}/`);
    const triage = Number(scalar(sample.db, TRIAGE));
    const issues = Number(scalar(sample.db, 'SELECT count(*) FROM issue'));
    await expect(countOf(page, 'Triage')).toHaveText(String(triage));
    await expect(countOf(page, 'Issues')).toHaveText(String(issues));
    await expect(countOf(page, 'Inbox')).toHaveText(String(issues));
    await expect(countOf(page, 'Projects')).toHaveText(String(scalar(sample.db, 'SELECT count(*) FROM project')));
    await expect(countOf(page, 'People')).toHaveText(String(scalar(sample.db, 'SELECT count(*) FROM member')));

    // The number beside Triage is the queue it opens; beside Issues, its All tab.
    await menuRow(page, 'Triage').click();
    await expect(page.getByRole('grid', { name: 'Triage' }).getByRole('row')).toHaveCount(triage);
    await menuRow(page, 'Issues').click();
    await expect(page.locator('.applist-title')).toHaveText('Issues');
    await expect(page.getByRole('tab', { name: /^All/ }).locator('.tab-count')).toHaveText(String(issues));

    // Another session files an issue — a second browser, its own cookies.
    const other = await browser.newContext({ storageState: SEEN_TOUR });
    try {
      const reply = await other.request.post(`${sample.origin}/api/insert`, {
        data: { app: 'thread', table: 'issue', values: { name: 'Filed from another session', status: 'backlog', priority: 'normal' } },
      });
      expect(reply.ok(), await reply.text()).toBe(true);
    } finally {
      await other.close();
    }
    expect(Number(scalar(sample.db, TRIAGE))).toBe(triage + 1);
    // Nothing here has asked again yet: the menu still says what it last heard.
    await expect(countOf(page, 'Triage')).toHaveText(String(triage));

    /* Coming back to the window asks again. Poll with a focus per try: a
       count younger than the client's stale time (5s) is served from cache,
       and the two-minute clock is too far away to be what moves it. */
    await expect
      .poll(
        async () => {
          await page.evaluate(() => window.dispatchEvent(new Event('focus')));
          return countOf(page, 'Triage').textContent();
        },
        { timeout: 15_000, intervals: [500] },
      )
      .toBe(String(triage + 1));
    await expect(countOf(page, 'Issues')).toHaveText(String(issues + 1));

    // This browser's own insert, from the list's New button: at once, no reload, no focus.
    await page.evaluate(() => {
      (window as unknown as { navCountsProbe: number }).navCountsProbe = 1;
    });
    await page.getByRole('button', { name: '+ New issue', exact: true }).click();
    const form = page.locator('.newpanel');
    await form.getByLabel('Name', { exact: true }).fill('Filed from this browser');
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('.record-modal').getByRole('heading', { level: 1 })).toContainText('Filed from this browser');
    await expect(countOf(page, 'Issues')).toHaveText(String(issues + 2));
    // Created as backlog, so the queue grew too.
    await expect(countOf(page, 'Triage')).toHaveText(String(triage + 2));
    expect(await page.evaluate(() => (window as unknown as { navCountsProbe?: number }).navCountsProbe)).toBe(1);
  });

  test('the menu asks once per thing it counts, and a folded menu asks nothing', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 924 });
    await enableSidebarCounts(page);
    const asked = recordCounts(page);
    await page.goto(`${sample.origin}/`);
    await expect(countOf(page, 'People')).toHaveText(/\d/);
    await expect(countOf(page, 'Triage')).toHaveText(/\d/);
    await expect(countOf(page, 'Board')).toHaveText(/\d/);
    // Issues and Inbox ask the same question of the same table: one request for both.
    // Planning asks its own, the issues still open.
    expect([...asked].sort()).toEqual([
      'count comment',
      'count cycle',
      'count issue',
      'count member',
      'count project',
      // The Board's segment rides as its name; the server writes it out.
      'run issue current_cycle',
      'run issue status != canceled and status != done',
      'run issue status = backlog or status = ready',
    ]);

    // Folded away, the rows are off screen: a reload and a return to the window ask nothing.
    await page.getByRole('button', { name: 'Hide the table list' }).click();
    await expect(page.locator('body')).toHaveClass(/sidebar-hidden/);
    await page.reload();
    await expect(page.locator('.board-card').first()).toBeVisible();
    asked.length = 0;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForLoadState('networkidle');
    expect(asked).toEqual([]);
    // Shown again, they are asked for.
    await page.getByRole('button', { name: 'Show the table list' }).click();
    await expect(countOf(page, 'Triage')).toHaveText(String(scalar(sample.db, TRIAGE)));
    expect(asked.length).toBeGreaterThan(0);
  });

  test('the default Thread sidebar does not request or render counts', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 924 });
    const asked = recordCounts(page);
    await page.goto(`${sample.origin}/`);
    await expect(page.locator('.board-card').first()).toBeVisible();
    await expect(menuRow(page, 'Issues').locator('.rows')).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForLoadState('networkidle');
    expect(asked).toEqual([]);
  });

  test('on a phone, even enabled counts do not query a menu that is not the sidebar', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await enableSidebarCounts(page);
    const asked = recordCounts(page);
    await page.goto(`${sample.origin}/`);
    await expect(page.locator('.board-card').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(asked).toEqual([]);
  });
});
