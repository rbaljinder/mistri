/**
 * `settled(page)`: a Playwright page waited on until the App has stopped asking — every request answered and none
 * started for a moment — less the page's streams. A signed-in page on an App with live sync holds `/api/live` open
 * for as long as it is shown, and a watched App's page its reload stream (`/api/app/live`): a request that never ends
 * never goes idle, so Playwright's `networkidle` never comes on a `live: true` App. This is what `mistri grade` and
 * `mistri shot` wait on (build/shot.ts), and what an App's own browser tests are offered, so the two never disagree on
 * when a page is done.
 *
 * Only the network's requests count: a `blob:` or `data:` load is the page reading its own memory, and a stream (an
 * `EventSource`, a WebSocket, any `text/event-stream` answer) is taken as answered once its headers are in.
 *
 * Typed structurally, so the testing kit depends on no Playwright package: any `@playwright/test` or
 * `playwright-core` page is one.
 */

/** The part of a Playwright request this reads. */
interface WatchedRequest {
  url(): string;
  resourceType(): string;
}
/** The part of a Playwright response this reads. */
interface WatchedResponse {
  request(): WatchedRequest;
  headers(): Record<string, string>;
}
/** The events this listens to, on a page or its browser context. */
interface RequestSource {
  on(event: 'request' | 'requestfinished' | 'requestfailed', listener: (request: WatchedRequest) => void): unknown;
  on(event: 'response', listener: (response: WatchedResponse) => void): unknown;
}
/** The part of a Playwright page `settled` uses. */
export interface SettledPage extends RequestSource {
  context(): RequestSource;
  waitForTimeout(ms: number): Promise<void>;
  waitForLoadState(state: 'load'): Promise<void>;
  evaluate<R>(fn: () => R): Promise<R>;
}

export interface SettledOptions {
  /** How long nothing may be in flight before the page is settled, in milliseconds. 400 unless said. */
  quietMs?: number;
  /** When to stop waiting and take the page as it stands, in milliseconds. 30 seconds unless said. */
  timeout?: number;
}

const STREAM_PATH = /\/api\/(?:app\/)?live$/;
const STREAM_TYPES = new Set(['eventsource', 'websocket']);

const watched = new WeakMap<object, Set<WatchedRequest>>();

function counted(request: WatchedRequest): boolean {
  let url: URL;
  try {
    url = new URL(request.url());
  } catch {
    return false;
  }
  return /^https?:$/.test(url.protocol) && !STREAM_PATH.test(url.pathname) && !STREAM_TYPES.has(request.resourceType());
}

/**
 * Count the requests of a page or a browser context from now on. `settled` does this itself the first time it meets
 * a page; a caller that makes the context (as `mistri shot` does) watches it before the first page opens, so a request
 * made while the first document loads is counted too.
 */
export function watchRequests(source: RequestSource): void {
  if (watched.has(source)) return;
  const open = new Set<WatchedRequest>();
  source.on('request', (request) => {
    if (counted(request)) open.add(request);
  });
  source.on('requestfinished', (request) => open.delete(request));
  source.on('requestfailed', (request) => open.delete(request));
  // A stream's body never ends: its headers are its answer.
  source.on('response', (response) => {
    if (/^text\/event-stream\b/i.test(response.headers()['content-type'] ?? '')) open.delete(response.request());
  });
  watched.set(source, open);
}

function inFlight(page: SettledPage): Set<WatchedRequest> | undefined {
  return watched.get(page.context()) ?? watched.get(page);
}

/**
 * Wait until no request but the streams has been in flight for `quietMs` (400 ms). A page first met here is watched
 * from now on, and the browser's own count of finished loads (its resource timing) is read beside it, so a request
 * already under way when the wait began is still waited for. Gives up after `timeout` and takes the page as it stands.
 */
export async function settled(page: SettledPage, options: SettledOptions = {}): Promise<void> {
  const quietMs = options.quietMs ?? 400;
  const deadline = Date.now() + (options.timeout ?? 30_000);
  let open = inFlight(page);
  if (!open) {
    watchRequests(page);
    open = inFlight(page)!;
  }
  await page.waitForLoadState('load').catch(() => {});
  const loads = () =>
    page
      .evaluate(
        () =>
          (globalThis as unknown as { performance: { getEntriesByType(type: string): unknown[] } }).performance.getEntriesByType('resource')
            .length,
      )
      .catch(() => 0);
  let seen = await loads();
  let since = Date.now();
  while (Date.now() - since < quietMs && Date.now() < deadline) {
    await page.waitForTimeout(50);
    const now = await loads();
    if (open.size || now !== seen) since = Date.now();
    seen = now;
  }
}
