/** Independent HTTP sessions and named authorization assertions. */
import assert from 'node:assert/strict';
import { appRequests } from './appRequests.js';

export interface TestRequest extends Omit<RequestInit, 'body'> {
  json?: unknown;
  body?: BodyInit | null;
}
/** A separate client is a separate browser session. Redirects stay explicit. `app` names the App on a server that
    serves several (a suite); `base` is where it is mounted there. */
export function createTestClient(origin: string, options: { app?: string; base?: string } = {}) {
  const base = new URL(origin);
  const cookies = new Map<
    string,
    {
      name: string;
      value: string;
      path: string;
      secure: boolean;
      expires: number;
    }
  >();
  async function request(path: string, options: TestRequest = {}) {
    const url = new URL(path, base);
    if (url.origin !== base.origin) throw new Error('Test client refuses to send session credentials to another origin.');
    const { json, ...init } = options;
    const headers = new Headers(init.headers);
    headers.set('origin', base.origin);
    const selected = [...cookies.values()]
      .filter(
        (cookie) =>
          cookie.expires > Date.now() &&
          (!cookie.secure || url.protocol === 'https:') &&
          (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)),
      )
      .sort((a, b) => b.path.length - a.path.length);
    if (selected.length) headers.set('cookie', selected.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '));
    if (json !== undefined) headers.set('content-type', 'application/json');
    const response = await fetch(url, {
      ...init,
      headers,
      redirect: 'manual',
      body: json === undefined ? init.body : JSON.stringify(json),
      signal: init.signal ?? AbortSignal.timeout(10000),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0],
        index = pair.indexOf('=');
      const name = pair.slice(0, index),
        value = pair.slice(index + 1);
      const domain = /;\s*domain=([^;]+)/i.exec(cookie)?.[1]?.replace(/^\./, '');
      if (domain && domain !== url.hostname) continue;
      const path = /;\s*path=([^;]+)/i.exec(cookie)?.[1] ?? (url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/');
      const age = /;\s*max-age=(-?\d+)/i.exec(cookie)?.[1];
      const expiration = /;\s*expires=([^;]+)/i.exec(cookie)?.[1];
      const expires = age !== undefined ? Date.now() + Number(age) * 1000 : expiration ? Date.parse(expiration) : Infinity;
      const key = `${name}:${path}`;
      if (expires <= Date.now() || !value) cookies.delete(key);
      else
        cookies.set(key, {
          name,
          value,
          path,
          secure: /;\s*secure(?:;|$)/i.test(cookie),
          expires,
        });
    }
    return response;
  }
  const app = appRequests((path, init) => request(path, init), options);
  return {
    request,
    ...app,
    clearSession: () => {
      cookies.clear();
      app.reset();
    },
    async signIn(email: string, password: string, path = '/api/auth/sign-in/email') {
      const response = await request(path, {
        method: 'POST',
        json: { email, password },
      });
      assert.equal(response.status, 200, `Sign-in failed: ${await response.clone().text()}`);
      app.reset();
      return response;
    },
    async signUp(input: { email: string; password: string; name: string }, path = '/api/auth/sign-up/email') {
      const response = await request(path, { method: 'POST', json: input });
      assert.equal(response.status, 200, `Sign-up failed: ${await response.clone().text()}`);
      // A sign-up signs in where the App allows it: what this session is served starts over, as on sign-in.
      app.reset();
      return response;
    },
    async signOut(path = '/api/auth/sign-out') {
      const response = await request(path, { method: 'POST', json: {} });
      assert.equal(response.status, 200, `Sign-out failed: ${await response.clone().text()}`);
      cookies.clear();
      app.reset();
      return response;
    },
  };
}
export type TestClient = ReturnType<typeof createTestClient>;
export interface AuthorizationCase {
  name: string;
  client: TestClient;
  path: string;
  request?: TestRequest;
  status: number | readonly number[];
  /** The refusal's `code` in the JSON body (`forbidden` for a refused write or command), checked when given. */
  code?: string;
  /** Assert hidden fields, tenant-scoped rows or command refusal details. */
  inspect?: (response: Response) => unknown | Promise<unknown>;
}
/** Executes every row and reports all failures, including negative policy cases. */
export async function assertAuthorizationMatrix(cases: readonly AuthorizationCase[]): Promise<void> {
  if (!cases.length) throw new Error('An authorization matrix needs at least one case.');
  const failures: Error[] = [];
  for (const row of cases)
    try {
      const response = await row.client.request(row.path, row.request);
      const expected = typeof row.status === 'number' ? [row.status] : row.status;
      assert.ok(
        expected.includes(response.status),
        `${row.name}: expected ${expected.join('/')} but received ${response.status}: ${(await response.clone().text()).slice(0, 1000)}`,
      );
      if (row.code !== undefined) {
        const body = (await response
          .clone()
          .json()
          .catch(() => undefined)) as { code?: unknown } | undefined;
        assert.equal(body?.code, row.code, `${row.name}: expected code ${row.code} but received ${String(body?.code)}`);
      }
      await row.inspect?.(response);
    } catch (cause) {
      failures.push(new Error(`Authorization case "${row.name}" failed.`, { cause }));
    }
  if (failures.length)
    throw new AggregateError(
      failures,
      `${failures.length} authorization matrix case(s) failed: ${failures.map((error) => error.message).join(' ')}`,
    );
}
