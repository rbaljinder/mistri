/**
 * A sign-in that answers 500 left nothing in the server's log: Better Auth's
 * own error logging is off (its `logger` is a console it keeps quiet in
 * production) and a person saw only "Sign-in failed (500)". This is the one
 * line that says which auth route failed, with what, in which App.
 *
 * It is written once per failed request, to stderr, and holds only what is
 * safe to keep: the method, the route with every segment that is not a plain
 * word replaced (a reset token, a provider's id), the error's name and its
 * message stripped of anything shaped like an address, and the App's id. The
 * query string, the body, the headers and the cookies are never read here.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MESSAGE_LIMIT = 200;

/** A route's words are lowercase and hyphenated; anything else in the path (a token, an id) is a parameter. */
function authRouteOf(pathname: string, under: string): string {
  const rest = pathname.startsWith(under) ? pathname.slice(under.length) : pathname;
  return rest
    .split('/')
    .map((segment) => (segment === '' || /^[a-z][a-z-]{0,39}$/.test(segment) ? segment : ':param'))
    .join('/');
}

/** What an error may say in a log: its name, and its message without addresses or runs that could be secrets. */
function describeAuthError(error: unknown): { name: string; message: string } {
  const name =
    error && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string' ? (error as Error).name : typeof error;
  const raw =
    error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string' ? (error as Error).message : '';
  const message = raw
    .replace(/[^\s@]+@[^\s@]+/g, '<address>')
    .replace(/[A-Za-z0-9_\-+/=.]{32,}/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  return { name, message: message.length > MESSAGE_LIMIT ? `${message.slice(0, MESSAGE_LIMIT)}…` : message };
}

interface Slot {
  error?: { name: string; message: string };
}

/**
 * `onError` is Better Auth's `onAPIError.onError` — it hands over the error
 * but not the request, so the request's slot is found through the async
 * context `watch` opens. `watch` answers once the response is written and
 * logs when its status is a 5xx or the handler threw.
 */
export function authFailureLog(appId: string, under: string, write: (line: string) => void = (line) => console.error(line)) {
  const slots = new AsyncLocalStorage<Slot>();
  return {
    onError(error: unknown): void {
      const slot = slots.getStore();
      if (slot) slot.error = describeAuthError(error);
    },
    async watch(req: IncomingMessage, res: ServerResponse, run: () => Promise<void>): Promise<void> {
      const slot: Slot = {};
      let thrown = false;
      try {
        await slots.run(slot, run);
      } catch (error) {
        thrown = true;
        slot.error ??= describeAuthError(error);
        throw error;
      } finally {
        if (thrown || res.statusCode >= 500) {
          let route = 'unknown';
          try {
            route = authRouteOf(new URL(req.url ?? '', 'http://localhost').pathname, under);
          } catch {
            /* a malformed address is still a failure worth a line */
          }
          const said = slot.error ? `${slot.error.name}: ${slot.error.message}` : 'no error was raised';
          write(`mistri: auth ${req.method ?? 'GET'} ${route} answered ${thrown ? 500 : res.statusCode} for App "${appId}": ${said}`);
        }
      }
    },
  };
}
