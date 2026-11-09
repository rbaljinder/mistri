/**
 * A surface token: the short-lived bearer a server component of a headless front end (`tokenFor`, embed/handler.ts)
 * holds in place of the browser session it does not have. It says one person, in one session, of one App, for one
 * surface, until a time — and nothing else: it is a different kind of credential from an API token (which is stored,
 * listed and revocable) and from the session cookie, and none of the three is read as another.
 *
 * Nothing is stored: a token is checked by its signature and its expiry, and then its session is read live
 * (auth.ts `surfaceTokens`), so signing out, a banned account and a role taken away end it at once, within its TTL. The
 * key is derived from `BETTER_AUTH_SECRET`, the secret the App's sessions are signed with, so every process of a
 * deployment checks every other's tokens, and the derivation (HKDF with this kind's name) means the secret itself
 * never signs this. The kind and the App are inside what is signed, so another kind of token, or another App's
 * surface token, is not this one.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/** What a surface token starts with, which is how a request's bearer is told from an API token (`mst_…`) before anything is read. */
export const SURFACE_TOKEN_PREFIX = 'mstsf1.';
const SURFACE_TOKEN_DEFAULT_TTL_SECONDS = 60;
/** A token a server component asks for lives for a render: longer is a credential, which is what the session and API tokens are. */
export const SURFACE_TOKEN_MAX_TTL_SECONDS = 300;

const KIND = 'surface';
const MAX_LENGTH = 1024;

/** Why a token was not given: `no_session`, `unknown_surface` or `bad_ttl`. A caller tells them apart by `code`, never by the message. */
export class SurfaceTokenRefused extends Error {
  constructor(
    readonly code: 'no_session' | 'unknown_surface' | 'bad_ttl' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'SurfaceTokenRefused';
  }
}

interface SurfaceClaims {
  readonly app: string;
  readonly person: string;
  readonly session: string;
  readonly surface: string;
  /** Epoch milliseconds. */
  readonly expires: number;
}

const keyFor = (secret: string): Buffer => Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), 'mistri.surface-token', 'v1', 32));

const mac = (key: Buffer, body: string) => createHmac('sha256', key).update(`${KIND}.${body}`).digest();

/** The token for these claims. Whether a person may be given one is the caller's to judge (auth.ts); this only signs. */
export function issueSurfaceToken(secret: string, claims: SurfaceClaims): string {
  const body = Buffer.from(
    JSON.stringify([1, KIND, claims.app, claims.person, claims.session, claims.surface, Math.floor(claims.expires / 1000)]),
  ).toString('base64url');
  return `${SURFACE_TOKEN_PREFIX}${body}.${mac(keyFor(secret), body).toString('base64url')}`;
}

/** Whether a bearer credential is one of these, by its spelling alone. */
export const isSurfaceToken = (credential: string): boolean => credential.startsWith(SURFACE_TOKEN_PREFIX);

/**
 * The claims of a token this App's secret signed and that has not expired, or `undefined` for anything else — a
 * tampered, expired, other-App or wrong-kind token is one answer, so the refusal says nothing about which it was.
 */
export function readSurfaceToken(secret: string, app: string, credential: string, now = Date.now()): SurfaceClaims | undefined {
  if (credential.length > MAX_LENGTH || !isSurfaceToken(credential)) return undefined;
  const [body, signature, ...rest] = credential.slice(SURFACE_TOKEN_PREFIX.length).split('.');
  if (!body || !signature || rest.length) return undefined;
  const expected = mac(keyFor(secret), body);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 7 || parsed[0] !== 1 || parsed[1] !== KIND) return undefined;
  const [, , tokenApp, person, session, surface, seconds] = parsed as unknown[];
  if (
    tokenApp !== app ||
    typeof person !== 'string' ||
    typeof session !== 'string' ||
    typeof surface !== 'string' ||
    typeof seconds !== 'number' ||
    !Number.isFinite(seconds) ||
    seconds * 1000 <= now
  )
    return undefined;
  return { app: tokenApp, person, session, surface, expires: seconds * 1000 };
}

/** The lifetime asked for, in seconds, or a refusal saying what is allowed. */
export function surfaceTokenTtl(ttl: unknown): number {
  if (ttl === undefined) return SURFACE_TOKEN_DEFAULT_TTL_SECONDS;
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
    throw new SurfaceTokenRefused('bad_ttl', 'tokenFor: ttl is a number of seconds above zero.');
  }
  if (ttl > SURFACE_TOKEN_MAX_TTL_SECONDS) {
    throw new SurfaceTokenRefused(
      'bad_ttl',
      `tokenFor: ttl is at most ${SURFACE_TOKEN_MAX_TTL_SECONDS} seconds; a token is for one render, and a longer one would be a session of its own.`,
    );
  }
  return ttl;
}
