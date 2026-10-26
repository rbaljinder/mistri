import { setTimeout as delay } from 'node:timers/promises';

export function browserEvents() {
  return {
    requests: 0,
    finishedRequests: 0,
    failedRequests: 0,
    canceledRequests: 0,
    httpErrors: 0,
    pageErrors: 0,
    blockedExternalRequests: 0,
    errors: 0,
    samples: [],
  };
}

function eventError(events, kind, message) {
  events[kind]++;
  events.errors++;
  if (events.samples.length < 20) events.samples.push({ kind, message: String(message).slice(0, 1500) });
}

export async function createBrowserUser(browser, origin, options) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 924 },
    serviceWorkers: 'block',
    storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: 'mistri.tour.v1', value: 'done' }] }] },
  });
  const state = { context, page: null, events: browserEvents(), pending: new Set(), closing: false };
  // Browser routing disables the HTTP cache; report this explicitly. All
  // network requests must stay on the owned origin, including redirects.
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) await route.continue();
    else {
      eventError(state.events, 'blockedExternalRequests', `${url.origin}${url.pathname}`);
      await route.abort('blockedbyclient');
    }
  });
  const page = await context.newPage();
  state.page = page;
  page.setDefaultTimeout(options.uiTimeoutMs);
  page.setDefaultNavigationTimeout(options.uiTimeoutMs);
  const relevant = (req) => ['document', 'script', 'stylesheet', 'xhr', 'fetch'].includes(req.resourceType());
  page.on('request', (req) => {
    if (state.closing || !relevant(req)) return;
    state.events.requests++;
    state.pending.add(req);
  });
  page.on('requestfinished', (req) => {
    if (state.pending.delete(req)) state.events.finishedRequests++;
  });
  page.on('requestfailed', (req) => {
    state.pending.delete(req);
    if (state.closing || !relevant(req)) return;
    const failure = req.failure()?.errorText ?? 'Request failed';
    if (failure === 'net::ERR_ABORTED') {
      state.events.canceledRequests++;
      return;
    }
    eventError(state.events, 'failedRequests', `${req.method()} ${new URL(req.url()).pathname}: ${failure}`);
  });
  page.on('response', (response) => {
    if (!state.closing && relevant(response.request()) && response.status() >= 400) {
      eventError(state.events, 'httpErrors', `${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
  page.on('pageerror', (error) => {
    if (!state.closing) eventError(state.events, 'pageErrors', error.message);
  });
  return state;
}

async function painted(page) {
  await page.evaluate(() => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))));
}

async function listReady(page, title) {
  await page.getByRole('heading', { level: 1, name: 'Issues', exact: true }).waitFor({ state: 'visible' });
  await page.locator('tbody tr[data-row]').filter({ hasText: title }).first().waitFor({ state: 'visible' });
  await painted(page);
}

export async function journey(state, origin, fixture, options, signal) {
  const { page } = state;
  let timedOut = false,
    closePromise,
    failure,
    stage = 'open issue list';
  // Closing a timed-out page interrupts evaluate/paint as well as locator and
  // navigation waits. The caller retires this user after a failed journey.
  const deadline = setTimeout(() => {
    timedOut = true;
    state.closing = true;
    closePromise = page.close().catch(() => {});
  }, options.uiTimeoutMs);
  try {
    signal.throwIfAborted();
    await page.goto(`${origin}/issue`, { waitUntil: 'domcontentloaded' });
    await listReady(page, fixture.title);
    stage = 'open issue detail';
    await page.locator('tbody tr[data-row]').filter({ hasText: fixture.title }).first().click();
    const detail = page.locator('.record-modal');
    await detail.waitFor({ state: 'visible' });
    await page.getByRole('heading', { level: 1, name: fixture.title, exact: true }).waitFor({ state: 'visible' });
    await page.locator('.page-field-grid').first().waitFor({ state: 'visible' });
    await page.getByText(fixture.marker, { exact: true }).waitFor({ state: 'visible' });
    await painted(page);
    stage = 'return to issue list';
    // Thread opens issues in a modal, preserving its queue. Navigation behind
    // that modal is intentionally inert; return through its actual close control.
    await detail.getByRole('button', { name: 'Close', exact: true }).click();
    await detail.waitFor({ state: 'hidden' });
    await listReady(page, fixture.title);
    stage = 'select backlog';
    await page.getByRole('tab', { name: /^Backlog/ }).click();
    await page.locator('[role="tab"][aria-selected="true"]').filter({ hasText: 'Backlog' }).waitFor({ state: 'visible' });
    await listReady(page, fixture.backlogTitle);
    stage = 'restore active list';
    await page.getByRole('tab', { name: /^Active/ }).click();
    await listReady(page, fixture.title);
    stage = 'drain requests';
    // Drain actual finite document/data requests, excluding HMR WebSockets.
    // This also prevents previous-phase network activity entering measurement.
    while (state.pending.size) {
      signal.throwIfAborted();
      if (page.isClosed()) throw new Error('Page closed');
      await delay(10, undefined, { signal });
    }
    await painted(page);
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(deadline);
    if (closePromise) await closePromise;
  }
  if (timedOut) throw new Error(`Browser journey deadline exceeded (${options.uiTimeoutMs}ms) at ${stage}`);
  if (failure) throw failure;
}
