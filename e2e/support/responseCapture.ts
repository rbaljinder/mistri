import type { APIResponse, Page, Request } from '@playwright/test';

/**
 * A response whose body was read before the page could lose it.
 *
 * `page.waitForResponse` hands back a live handle: `status()`, `headers()` and
 * `request()` are recorded when the response event arrives, but `json()` asks
 * the browser for the body later, over the protocol. If the page has navigated
 * (a sign-in reload, a relogin, a tenant switch) or simply dropped the resource
 * by then, Chromium answers "No data found for resource with given identifier"
 * — which is how four invitation tests failed on two-core CI runners.
 *
 * Here the request is fetched by Playwright itself (`route.fetch`, which sends
 * the context's cookies), its body is read in full, and only then is the page
 * fulfilled with the same status, headers and bytes. Nothing the test later
 * reads depends on the page still holding anything. Status-only checks can
 * keep `waitForResponse`; anything that reads a body should come through here.
 *
 * `route.fulfill` replays headers into the page, so this is for endpoints whose
 * responses carry no Set-Cookie (the invitation API writes a fixed header set).
 * Only the first matching request is taken; later ones go to the network.
 */
export interface CapturedResponse {
  status(): number;
  headers(): Record<string, string>;
  request(): Request;
  text(): string;
  json(): Promise<any>;
}

/** Register the capture for `pathname` *before* the action that triggers it;
 * await the returned function after the action. */
export async function captureResponse(
  page: Page,
  pathname: string,
  options: { timeout?: number } = {},
): Promise<() => Promise<CapturedResponse>> {
  const timeout = options.timeout ?? 45_000;
  let resolve!: (value: CapturedResponse) => void, reject!: (error: unknown) => void;
  const captured = new Promise<CapturedResponse>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  // A test that fails before awaiting must not leave an unhandled rejection.
  captured.catch(() => {});
  await page.route(
    (url) => url.pathname === pathname,
    async (route) => {
      const request = route.request();
      let response: APIResponse;
      try {
        response = await route.fetch({ maxRetries: 0, timeout });
      } catch (error) {
        reject(error);
        await route.abort('failed').catch(() => {});
        return;
      }
      const body = await response.body();
      const status = response.status(),
        headers = response.headers();
      resolve({
        status: () => status,
        headers: () => ({ ...headers }),
        request: () => request,
        text: () => body.toString('utf8'),
        json: async () => JSON.parse(body.toString('utf8')),
      });
      try {
        await route.fulfill({ response, body });
      } catch (error) {
        // The page going away after its body was captured is the case this
        // helper exists for; any other interception failure is a real one.
        if (!/closed|cancel|disposed|Invalid InterceptionId/i.test(String(error))) throw error;
      }
    },
    { times: 1 },
  );
  return () =>
    new Promise<CapturedResponse>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`No response for ${pathname} within ${timeout}ms`)), timeout);
      captured.then(
        (value) => {
          clearTimeout(timer);
          ok(value);
        },
        (error) => {
          clearTimeout(timer);
          fail(error);
        },
      );
    });
}
