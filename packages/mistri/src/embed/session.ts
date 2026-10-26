/**
 * The embedded shell's sign-in: the host's own session, exchanged for one of
 * mistri's, so a person signed in to the host is signed in to the App with
 * no second login, and every grant is still decided by the mistri server.
 *
 * The host mints a short-lived signed assertion on its server
 * (`mintEmbedAssertion`, `@mistriwork/mistri/handler`) and hands it over through
 * `auth.assertion`. The Provider posts it to the App's exchange
 * (`/api/auth/embed/exchange`, server/embed/exchange.ts), which verifies it
 * and either sets the ordinary session cookie (the endpoint is this page's
 * origin: the handler mounted in the host, or a rewrite to it) or answers
 * `{ token, expiresAt }` (another origin), kept in memory only and sent as a
 * bearer. Before the session lapses the Provider exchanges again with a fresh
 * assertion — the host's next assertion is the refresh, and nothing else
 * renews a session; when the host says its person is gone (`assertion`
 * rejects with a 401) it ends the mistri session too
 * (`/api/auth/embed/sign-out`) and tells the host.
 *
 * `auth: 'cookie'` exchanges nothing: the page already carries a mistri
 * cookie (shared sign-in, or the App's own sign-in screen drawn in place).
 */
export type Auth =
  | 'cookie'
  | {
      /** A fresh assertion from the host's server, each time it is called. */
      assertion: () => Promise<string>;
      /** The host's person is gone, or the exchange was refused. */
      onUnauthenticated?: () => void;
    };

export const EXCHANGE_PATH = '/api/auth/embed/exchange';
export const SIGN_OUT_PATH = '/api/auth/embed/sign-out';

/** Ask again this long before the session would lapse; never sooner than the floor. */
const EARLY_MS = 60_000;
const FLOOR_MS = 5_000;

export interface EmbedSession {
  /** Settles once the exchange is done (at once for the cookie); rejects with a sentence. */
  ready: Promise<void>;
  /** The bearer a cross-origin request carries, or undefined for the cookie. */
  authorization(): string | undefined;
  /** Stop refreshing (the Provider unmounted). */
  close(): void;
}

/** Whether the endpoint is another origin than this page's. */
export function crossOrigin(endpoint: string): boolean {
  if (typeof window === 'undefined') return false;
  return new URL(endpoint, window.location.href).origin !== window.location.origin;
}

const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};

/** Begin the session the Provider's `auth` asks for. */
export function startSession(endpoint: string, auth: Auth | undefined, fetcher: typeof fetch = fetch): EmbedSession {
  if (!auth || auth === 'cookie') return { ready: Promise.resolve(), authorization: () => undefined, close: () => {} };
  const remote = crossOrigin(endpoint);
  let token: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const signOut = async () => {
    /* Another origin's session is the bearer it was given: the server ends the one it is shown, and no other. */
    const ending = token;
    token = undefined;
    try {
      await fetcher(endpoint + SIGN_OUT_PATH, {
        method: 'POST',
        credentials: remote ? 'omit' : 'same-origin',
        headers: { 'content-type': 'application/json', ...(remote && ending ? { authorization: `Bearer ${ending}` } : {}) },
        body: '{}',
      });
    } catch {
      /* The session lapses on its own; the host has already been told. */
    }
    auth.onUnauthenticated?.();
  };

  const exchange = async (): Promise<void> => {
    let assertion: string;
    try {
      assertion = await auth.assertion();
    } catch (error) {
      if (statusOf(error) === 401) {
        await signOut();
        throw new Error('The host says no one is signed in, so mistri has signed out too.');
      }
      throw error;
    }
    const reply = await fetcher(endpoint + EXCHANGE_PATH, {
      method: 'POST',
      /* Same origin: the reply sets the session cookie. Another origin: no cookie either way, and the assertion is the whole proof. */
      credentials: remote ? 'omit' : 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assertion }),
    });
    const body = (await reply.json().catch(() => ({}))) as { token?: unknown; expiresAt?: unknown; error?: unknown };
    if (!reply.ok) {
      if (reply.status === 401 || reply.status === 403) auth.onUnauthenticated?.();
      throw new Error(typeof body.error === 'string' ? body.error : `mistri refused the host's sign-in (${reply.status}).`);
    }
    if (remote) {
      if (typeof body.token !== 'string') throw new Error('mistri answered the sign-in exchange without a session for this origin.');
      token = body.token;
    }
    const expires = typeof body.expiresAt === 'string' || typeof body.expiresAt === 'number' ? new Date(body.expiresAt).getTime() : NaN;
    if (!closed && Number.isFinite(expires)) {
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          void exchange().catch((error: unknown) => console.error('mistri: the embed session could not be renewed.', error));
        },
        Math.max(FLOOR_MS, expires - Date.now() - EARLY_MS),
      );
    }
  };

  return {
    ready: exchange(),
    authorization: () => (token ? `Bearer ${token}` : undefined),
    close() {
      closed = true;
      clearTimeout(timer);
    },
  };
}
