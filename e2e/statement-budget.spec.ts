import { expect, test, type Page } from './support/harness';
import type { Request } from '@playwright/test';
import { startSample, PAYDAY_ADMIN } from './support/sampleServer';
import { ROOM_BUDGETS } from '../scripts/statement-budgets.mjs';
import { statementShape } from '../packages/engine/src/adapters/telemetry/statement.js';

/* What a room asks the server and the database, held to its budget
   (scripts/statement-budgets.mjs), counted by the dev observer's own
   detectors: every request the browser makes opening the room, its
   statements, the catalog reads among them and the N+1 patterns the observer
   flags. Payday, because it has a dashboard, lists, record pages and commands
   on one SQLite file; Thread, whose home is the busiest dashboard of the
   samples. Each on its own server, over a fresh seed. */
test.describe('statement budgets', () => {
  test.setTimeout(240_000);

  const CATALOG =
    /\b(pg_catalog|pg_class|pg_attribute|pg_trigger|pg_collation|pg_namespace|information_schema|sqlite_master|sqlite_schema|pragma_\w+|PRAGMA)\b/i;
  const EPOCH = /__mistri_schema_epoch|pragma_schema_version/;

  type Trace = { traceId: string; path?: string; route?: string };
  /* The dev server's own module requests: a built client has none of them. */
  const DEV_ONLY = /^\/(@vite|@react-refresh|@fs|@id|src\/|node_modules\/)/;
  type Span = { attributes: Record<string, unknown>; detail?: { sql?: string }; flags?: { nPlusOne?: number } };

  /** Open a room and count what every request it made asked, once nothing more arrives. */
  async function room(page: Page, origin: string, open: () => Promise<unknown>) {
    const observe = async <T>(path: string): Promise<T> =>
      (await page.request.get(`${origin}/_mistri/observe/api${path}`)).json() as Promise<T>;
    /* Settled: the browser has no request in flight (its modules included,
       which the observer does not trace and a loaded machine takes seconds
       over; a stream that stays open aside), and the observer's cursor has not
       moved for a second. Before the room opens, so what the last room still
       asked is not counted as this one's, and after. */
    const inFlight = new Set<Request>();
    // The observer's own badge waits on the observer for as long as the page is open.
    const began = (request: Request) => {
      if (!['eventsource', 'websocket'].includes(request.resourceType()) && !new URL(request.url()).pathname.startsWith('/_mistri/'))
        inFlight.add(request);
    };
    const ended = (request: Request) => inFlight.delete(request);
    page.on('request', began);
    page.on('requestfinished', ended);
    page.on('requestfailed', ended);
    const settled = async () => {
      let last = -1,
        now = -1;
      await expect
        .poll(
          async () => {
            now = (await observe<{ cursor: number }>('/status')).cursor;
            const still = now === last && inFlight.size === 0;
            last = now;
            return still;
          },
          { intervals: [1000], timeout: 60_000 },
        )
        .toBe(true);
      return now;
    };
    let cursor: number;
    try {
      cursor = await settled();
      await open();
      await settled();
    } finally {
      page.off('request', began);
      page.off('requestfinished', ended);
      page.off('requestfailed', ended);
    }
    const listed = await observe<{ traces: Trace[] }>(`/traces?since=${cursor}&limit=200`);
    let requests = 0,
      statements = 0,
      catalog = 0,
      nPlusOne = 0;
    const repeated: Array<{ path: string | undefined; sql: string; count: number }> = [];
    for (const trace of listed.traces) {
      if ((trace.path ?? '').startsWith('/_mistri') || DEV_ONLY.test(trace.path ?? '')) continue;
      requests++;
      const full = await observe<{ spans: Span[] }>(`/traces/${trace.traceId}?full=1`);
      const repeatedShapes = new Set<string>();
      for (const span of full.spans) {
        const sql = span.detail?.sql;
        if (!span.attributes['db.system.name'] || typeof sql !== 'string') continue;
        // The room budget excludes Better Auth's session/user lookups from
        // statements. First Paint puts them in the room's trace, so apply
        // that same boundary to its N+1 count as well.
        if (/as "primary"/.test(sql)) continue;
        if (span.flags?.nPlusOne && !repeated.some((entry) => entry.path === trace.path && entry.sql === sql)) {
          repeated.push({ path: trace.path, sql, count: span.flags.nPlusOne });
        }
        if (span.flags?.nPlusOne) repeatedShapes.add(statementShape(sql));
        statements++;
        if (CATALOG.test(sql) && !EPOCH.test(sql)) catalog++;
      }
      nPlusOne += repeatedShapes.size;
    }
    return { requests, statements, catalog, nPlusOne, repeated };
  }

  type Measured = Awaited<ReturnType<typeof room>>;
  const within = (name: keyof typeof ROOM_BUDGETS, measured: Measured) => {
    const budget: { requests: number; statements: number; nPlusOne?: number } = ROOM_BUDGETS[name];
    expect(measured.catalog, `${name}: catalog reads`).toBe(0);
    expect(measured.nPlusOne, `${name}: N+1 patterns the observer flags: ${JSON.stringify(measured.repeated)}`).toBeLessThanOrEqual(
      budget.nPlusOne ?? 0,
    );
    expect(measured.requests, `${name}: requests, budget ${budget.requests}`).toBeLessThanOrEqual(budget.requests);
    expect(measured.statements, `${name}: statements, budget ${budget.statements}`).toBeLessThanOrEqual(budget.statements);
  };

  test("Payday's home, a list and a record read within their statement budgets, with no catalog read and no N+1", async ({ page }) => {
    const sample = await startSample('payday', { dev: true });
    try {
      const login = await page.request.post(`${sample.origin}/api/auth/sign-in/email`, {
        headers: { origin: sample.origin },
        data: PAYDAY_ADMIN,
      });
      expect(login.ok()).toBe(true);
      // Warm: the first visit compiles the client and fills the caches; the budgets are for the second.
      await page.goto(`${sample.origin}/`);
      await expect(page.locator('#content')).not.toBeEmpty({ timeout: 30_000 });
      within('payday home', await room(page, sample.origin, () => page.goto(`${sample.origin}/`)));
      await page.goto(`${sample.origin}/timeoff`);
      await expect(page.locator('#content tbody tr').first()).toBeVisible({ timeout: 30_000 });
      within('payday list', await room(page, sample.origin, () => page.goto(`${sample.origin}/timeoff`)));
      // A record page, warm too: its command's availability is the first transaction to read the catalog.
      await page.locator('#content tbody tr').first().click();
      await expect(page.locator('#content .page-body .page-section').first()).toBeVisible({ timeout: 30_000 });
      await page.goBack();
      await expect(page.locator('#content tbody tr').first()).toBeVisible({ timeout: 30_000 });
      within('payday record', await room(page, sample.origin, () => page.locator('#content tbody tr').first().click()));
      // A room opened from the App's own menu, as a reader moves: the shell is not asked for again.
      await page.goto(`${sample.origin}/`);
      await expect(page.locator('#content')).not.toBeEmpty({ timeout: 30_000 });
      within(
        'payday list, from the menu',
        await room(page, sample.origin, () =>
          page.getByRole('navigation', { name: 'App menu' }).getByRole('button', { name: 'Requests', exact: true }).click(),
        ),
      );
    } finally {
      await sample.stop();
    }
  });

  test("Thread's home and a list read within their request and statement budgets", async ({ page }) => {
    const sample = await startSample('thread', { dev: true });
    try {
      await page.goto(`${sample.origin}/`);
      // The First Paint shell can appear before the board's warm-up request.
      // Wait for its data so that request cannot enter the measured visit.
      await expect(page.locator('.board-card').first()).toBeVisible({ timeout: 30_000 });
      within(
        'thread home',
        await room(page, sample.origin, async () => {
          await page.goto(`${sample.origin}/`);
          await expect(page.locator('.board-card').first()).toBeVisible({ timeout: 30_000 });
        }),
      );
      within(
        'thread list',
        await room(page, sample.origin, async () => {
          await page.goto(`${sample.origin}/issues`);
          // A loaded document can still be booting from carried First Paint data.
          // Start the final settle only once the list has rendered its records.
          await expect(page.locator('#content tbody tr').first()).toBeVisible({ timeout: 30_000 });
        }),
      );
      // Preserve the crash check before closing the page and its server.
      await expect(page.locator('[data-section-error]')).toHaveCount(0);
      await page.close();
    } finally {
      await sample.stop();
    }
  });
});
