/**
 * One request to Better Auth's own routes under /api/auth, as the sign-in
 * screen and the account menu both make it: plain fetch, a JSON body in, a
 * session cookie out, a sentence on failure — the client carries no auth
 * library. Its own module because the two are loaded apart: the sign-in
 * screen with the public pages, the account menu with the shell (app.js).
 */
import { announceSessionChange } from '@mistriwork/kit/client/sessionLifecycle.js';
import { say } from '../copy/public/components/authRequest.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';

/** A refusal from an auth route: its sentence, and Better Auth's code when it gave one. */
export class AuthRefusal extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** One request to an auth route: JSON in, JSON out, a sentence on failure. */
export async function post(path: string, body: unknown, expectedAccount?: string): Promise<Record<string, unknown>> {
  const res = await fetchServer(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(expectedAccount ? { 'x-mistri-account': expectedAccount } : {}) },
    signal: AbortSignal.timeout(15_000),
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    /* an empty answer is fine */
  }
  if (!res.ok) {
    throw new AuthRefusal(
      String(data.message || data.error || say('signInFailed', { status: res.status })),
      typeof data.code === 'string' ? data.code : undefined,
    );
  }
  return data;
}

/** What the page does once a session exists: start over with the cookie. */
export function reload(): void {
  announceSessionChange();
  window.location.reload();
}
