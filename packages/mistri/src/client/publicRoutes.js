/**
 * The addresses that are not the App itself: a public form, the landing,
 * the staff door. Read by the first module (boot.js) before anything else
 * loads, because the answer decides which part of the client this page
 * needs — a public form never loads the shell, and never asks who is signed in.
 */

/**
 * `/{app}/form/{id}`: the id is the form's view key, the app segment the
 * App's id; a saved form's status check and account screen are under it
 * (`/status`, `/claim`). Anything else is not a public form's address.
 * @param {string} pathname
 * @returns {{ app: string; id: string; page?: 'status' | 'claim' } | undefined}
 */
export function publicFormRoute(pathname) {
  const match = /^\/([^/@~]+)\/form\/([a-z0-9][a-z0-9-]{0,63})(?:\/(status|claim))?\/?$/.exec(pathname);
  if (!match) return undefined;
  let app;
  try {
    app = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  return { app, id: match[2], ...(match[3] ? { page: /** @type {'status' | 'claim'} */ (match[3]) } : {}) };
}

/**
 * `/` and `/{app}` are the root, `/{app}/welcome` the landing for anyone,
 * `/{app}/sign-in` the staff door. Anything else is not the landing's.
 * @param {string} pathname
 * @returns {{ kind: 'root' | 'welcome' | 'sign-in'; app?: string } | undefined}
 */
export function landingRoute(pathname) {
  if (pathname === '/' || pathname === '') return { kind: 'root' };
  const match = /^\/([^/@~]+)(?:\/(welcome|sign-in))?\/?$/.exec(pathname);
  if (!match) return undefined;
  let app;
  try {
    app = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  return { kind: /** @type {'root' | 'welcome' | 'sign-in'} */ (match[2] ?? 'root'), app };
}
