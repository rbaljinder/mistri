/**
 * A sign-in handed from the deployment's own host to a tenant's (http/tenantHosts.ts). A tenant's host is another
 * site, so the session cookie the staff host set never reaches it, and a cookie scoped wider than one host would
 * reach every tenant's. So the person signs in where sign-in lives, and the staff host hands the tenant's host a
 * code, once, for a session of that host's own: a session pinned to the host, the App and the tenant it was made
 * for, which counts nowhere else (auth.ts `sessionInstance`).
 *
 * Both halves are rows of Better Auth's own `verification` table, as embed/ledger.ts keeps its spent assertions, so
 * every instance that shares the auth store reads the same ones and the store's layout is unchanged:
 *
 * - The code: 32 random bytes, kept only as a domain-separated digest, for 60 seconds, bound to the account, the
 *   host, the App, the tenant, the staff session that asked, and the digest of a verifier the tenant's host set as
 *   a cookie of its own before sending the person away. Spending it is a conditional delete whose count says who
 *   spent it, so two redemptions racing on two instances leave one session, and a code met with the wrong verifier,
 *   or on another host, is spent all the same.
 * - The pin: one row per session made this way, keyed by its digest, alive as long as the session, naming the staff
 *   session it came from so signing out everywhere on the tenant's host ends what that sign-in handed out and
 *   nothing else of the account's.
 *
 * Each kind of row is swept by its own identifier, never another's.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appHome, type AddressMount } from '@mistriwork/engine/shared/mount.js';
import type { LedgerAdapter } from '../embed/ledger.js';
import type { VerifiedSessionInstance } from './auth.js';

/** The rows this file owns in `verification`, and the only ones it sweeps. */
export const HOST_PIN = 'mistri-host-pin';
export const HOST_HANDOFF = 'mistri-host-handoff';
const HANDOFF_TTL_MS = 60_000;
const SWEEP_EVERY_MS = 60_000;
/** A code or a verifier: 32 random bytes, base64url. Anything else is not one of ours and is never looked up. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface HostPin {
  readonly app: string;
  readonly tenant: string;
  readonly host: string;
  readonly staffSessionId: string;
}
export interface HostPlace {
  readonly app: string;
  readonly tenant: string;
  readonly host: string;
}

/** The part of the adapter this file adds to the ledger's: listing a staff session's pins. */
export interface HostAdapter extends LedgerAdapter {
  findMany<T>(input: { model: string; where: { field: string; value: unknown; operator?: string }[] }): Promise<T[]>;
}

const digest = (label: string, value: string) => createHash('sha256').update(`${label}\0${value}`).digest('base64url');
const time = (value: unknown) => (value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value)));
const pinId = (sessionId: string) => `host-pin-${digest(HOST_PIN, sessionId)}`;
const codeId = (code: string) => `host-handoff-${digest(HOST_HANDOFF, code)}`;
/** What the tenant's host sends along (`v=`): the verifier's digest. The verifier itself stays in its cookie. */
export const verifierHashOf = (verifier: string) => digest('mistri-host-verifier', verifier);
export const newHostToken = () => randomBytes(32).toString('base64url');
export const isHostToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value);

/** Where a handoff sends the person on the tenant's host: a path on that host, else its home. Never another origin,
 * whether by `//host`, a backslash a browser reads as a slash, or a scheme. */
export function safeReturnPath(to: unknown, home = '/'): string {
  if (typeof to !== 'string' || to.length > 2048 || !to.startsWith('/') || to.startsWith('//')) return home;
  // eslint-disable-next-line no-control-regex -- A return path must exclude ASCII controls a browser strips before reading.
  if (/[\\\u0000-\u001f\u007f]/.test(to)) return home;
  /* Encoded here, when the code is minted: the path becomes a `Location` header at the handoff, which takes only
     latin-1, and a header that threw there would do so after the code is spent. A lone surrogate encodes to nothing. */
  let encoded: string;
  try {
    encoded = to.replace(/[^ -~]+/g, (run) => encodeURIComponent(run));
  } catch {
    return home;
  }
  return encoded.length > 2048 ? home : encoded;
}

/** A host sign-in's addresses on a tenant's host, which serves only under its App's home: the one spelling the suite
 * routes (http/suite.ts) and the App writes (tenant/tenantAuthenticatedHttp.ts). */
export function hostSignInPath(mount: AddressMount, app: string, leg: 'sign-in' | 'handoff' | 'sign-out'): string {
  return `${appHome(mount, app).replace(/\/$/, '')}/_mistri/${leg}`;
}
/** The staff leg, on the deployment's own host beside its sign-in (suiteLanding.ts carries it as `next`). */
export const hostSignInStaffPath = (suiteBase: string): string => `${suiteBase}/_mistri/host-sign-in`;

/** The staff leg's question for a custom domain: a host the deployment does not name itself, so a link alone never
 * signs anyone in to it. Continue posts back to the same address, which is what mints; Cancel goes to `cancel`. Style
 * inline under the nonce in the suite sign-in page's tokens (suiteChooser.ts); no script at all. */
export function hostSignInConfirmPage(input: { host: string; who: string; action: string; cancel: string; nonce: string }): string {
  const escape = (value: string) =>
    value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  const host = escape(input.host);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>Continue to ${host}</title><style nonce="${input.nonce}">
:root{--ground:#f7f7f5;--surface:#fff;--line-control:#c9c9c3;--ink:#1d1d1b;--ink-muted:#5f5f5a;--accent:#2b5bd7;--link:#2b5bd7;--radius:0;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--ground:#141413;--surface:#1c1c1a;--line-control:#45453f;--ink:#ececea;--ink-muted:#a3a39d;--accent:#7ea2ff;--link:#7ea2ff}}
*{box-sizing:border-box}body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:0 16px;color:var(--ink);background:var(--ground)}
main{max-width:560px;margin:8vh auto 48px}h1{margin:0 0 20px;font-size:26px;line-height:1.2;letter-spacing:-.012em;overflow-wrap:anywhere}p{overflow-wrap:anywhere;color:var(--ink-muted)}
button{font:inherit;font-weight:600;cursor:pointer;margin:8px 16px 8px 0;padding:7px 14px;color:#fff;background:var(--accent);border:1px solid var(--accent);border-radius:var(--radius)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}a{color:var(--link)}
</style></head><body><main><h1>Continue to ${host}?</h1>
<p>You are signed in as ${escape(input.who)}. Continue only if you meant to sign in to ${host}.</p>
<form method="post" action="${escape(input.action)}"><button type="submit">Continue</button><a href="${escape(input.cancel)}">Cancel</a></form>
</main></body></html>`;
}

const place = (value: Record<string, unknown>): HostPlace | null =>
  typeof value.app === 'string' && typeof value.tenant === 'string' && typeof value.host === 'string'
    ? { app: value.app, tenant: value.tenant, host: value.host }
    : null;
const same = (a: HostPlace, b: HostPlace) => a.app === b.app && a.tenant === b.tenant && a.host === b.host;

function sweeper(identifier: string, now: () => number) {
  let swept = 0;
  return (db: LedgerAdapter) => {
    if (now() - swept < SWEEP_EVERY_MS) return;
    swept = now();
    void db
      .deleteMany({
        model: 'verification',
        where: [
          { field: 'identifier', value: identifier },
          { field: 'expiresAt', value: new Date(now()), operator: 'lt' },
        ],
      })
      .catch(() => {});
  };
}

export function hostPins(adapter: () => Promise<HostAdapter>, now: () => number = Date.now) {
  const sweep = sweeper(HOST_PIN, now);
  const parse = (sessionId: string, row: { value: string } | null): HostPin | null => {
    if (!row) return null;
    const json = JSON.parse(row.value.slice(row.value.indexOf('|') + 1)) as Record<string, unknown>;
    const at = place(json);
    if (!at || json.session !== sessionId || typeof json.staffSessionId !== 'string') throw new Error('A host pin row is malformed.');
    return Object.freeze({ ...at, staffSessionId: json.staffSessionId });
  };
  return {
    async pin(sessionId: string, pin: HostPin, expiresAt: number): Promise<void> {
      const db = await adapter();
      sweep(db);
      await db.create({
        model: 'verification',
        forceAllowId: true,
        data: {
          id: pinId(sessionId),
          identifier: HOST_PIN,
          /* Led by the staff session's digest, so its pins are found by a prefix and read back whole. */
          value: `${digest('mistri-host-staff', pin.staffSessionId)}|${JSON.stringify({ session: sessionId, ...pin })}`,
          expiresAt: new Date(expiresAt),
          createdAt: new Date(now()),
          updatedAt: new Date(now()),
        },
      });
    },
    /** The session's pin, or null for a session that has none. A malformed row throws: it is refused, not ignored. */
    async read(sessionId: string): Promise<HostPin | null> {
      const db = await adapter();
      const row = await db.findOne<{ value: string; identifier: string }>({
        model: 'verification',
        where: [{ field: 'id', value: pinId(sessionId) }],
      });
      if (row && row.identifier !== HOST_PIN) throw new Error('A host pin row is malformed.');
      return parse(sessionId, row);
    },
    /** The sessions the staff session handed out, each read back and checked against it. */
    async from(staffSessionId: string): Promise<string[]> {
      const db = await adapter();
      const rows = await db.findMany<{ value: string }>({
        model: 'verification',
        where: [
          { field: 'identifier', value: HOST_PIN },
          { field: 'value', value: `${digest('mistri-host-staff', staffSessionId)}|`, operator: 'starts_with' },
        ],
      });
      const sessions: string[] = [];
      for (const row of rows) {
        const json = JSON.parse(row.value.slice(row.value.indexOf('|') + 1)) as Record<string, unknown>;
        if (json.staffSessionId === staffSessionId && typeof json.session === 'string') sessions.push(json.session);
      }
      return sessions;
    },
    async drop(sessionId: string): Promise<void> {
      const db = await adapter();
      await db.deleteMany({
        model: 'verification',
        where: [
          { field: 'id', value: pinId(sessionId) },
          { field: 'identifier', value: HOST_PIN },
        ],
      });
    },
  };
}

interface HostHandoff extends HostPlace {
  readonly userId: string;
  readonly staffSessionId: string;
  /** Where on the tenant's host the person lands: kept with the code, so the address that carries the code carries
   * nothing else a link could change. */
  readonly to: string;
}

export function hostHandoffCodes(adapter: () => Promise<LedgerAdapter>, now: () => number = Date.now) {
  const sweep = sweeper(HOST_HANDOFF, now);
  return {
    /** A code for one handoff. Only its digest is kept, so the store holds nothing that redeems. */
    async mint(handoff: HostHandoff, verifierHash: string): Promise<string> {
      const db = await adapter();
      sweep(db);
      const code = newHostToken();
      await db.create({
        model: 'verification',
        forceAllowId: true,
        data: {
          id: codeId(code),
          identifier: HOST_HANDOFF,
          value: JSON.stringify({ ...handoff, verifierHash }),
          expiresAt: new Date(now() + HANDOFF_TTL_MS),
          createdAt: new Date(now()),
          updatedAt: new Date(now()),
        },
      });
      return code;
    },
    /**
     * The handoff a code was minted for, spent: null for a code that is unknown, expired, already spent, met with
     * another verifier, or presented on another host, App or tenant. The delete is the spend, and its count is the
     * answer to who spent it; the row is read before it only to learn what it held.
     */
    async redeem(code: unknown, verifier: unknown, at: HostPlace): Promise<Omit<HostHandoff, keyof HostPlace> | null> {
      if (!isHostToken(code) || !isHostToken(verifier)) return null;
      const db = await adapter();
      const id = codeId(code);
      const row = await db.findOne<{ value: string; identifier: string }>({ model: 'verification', where: [{ field: 'id', value: id }] });
      if (!row || row.identifier !== HOST_HANDOFF) return null;
      const spent = await db.deleteMany({
        model: 'verification',
        where: [
          { field: 'id', value: id },
          { field: 'identifier', value: HOST_HANDOFF },
          { field: 'expiresAt', value: new Date(now()), operator: 'gt' },
        ],
      });
      if (spent !== 1) return null;
      const json = JSON.parse(row.value) as Record<string, unknown>;
      const minted = place(json);
      if (typeof json.verifierHash !== 'string' || typeof json.userId !== 'string' || typeof json.staffSessionId !== 'string') return null;
      const expected = Buffer.from(json.verifierHash),
        presented = Buffer.from(verifierHashOf(verifier));
      if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null;
      if (!minted || !same(minted, at)) return null;
      return { userId: json.userId, staffSessionId: json.staffSessionId, to: safeReturnPath(json.to) };
    },
  };
}

interface Ctx {
  body: unknown;
  json(value: unknown): unknown;
  context: {
    adapter: { findOne(a: { model: string; where: Array<{ field: string; value: unknown }> }): Promise<Record<string, unknown> | null> };
    internalAdapter: {
      findUserById(id: string): Promise<Record<string, unknown> | null>;
      createSession(userId: string): Promise<Record<string, unknown>>;
      deleteSession(token: string): Promise<unknown>;
    };
  };
}
type Endpoint = (options: Record<string, unknown>, handler: (ctx: Ctx) => Promise<unknown>) => unknown;

/** The slice of `auth.api` the handoff calls. */
export interface HostApi {
  mistriHostSignIn(a: {
    body: { userId: string };
    headers: Headers;
    returnHeaders: true;
  }): Promise<{ headers: Headers; response: { sessionId: string; expiresAt: number } | { refused: true } }>;
  mistriHostEnd(a: { body: { sessionIds: string[] } }): Promise<unknown>;
}

/**
 * The Better Auth side: two endpoints only trusted server code calls (`auth.api.*`), never on the HTTP router. The
 * session is made as any sign-in makes one, through Better Auth's adapter and hooks (a banned account's refusal
 * among them), with its own cookie; ending one goes through the same adapter by the session's id, so a token is
 * never handed around to do it.
 */
export async function hostSignInPlugin(load: (name: string) => Promise<Record<string, unknown>>) {
  const { createAuthEndpoint } = (await load('better-auth/api')) as unknown as { createAuthEndpoint: { serverOnly: Endpoint } };
  const { setSessionCookie } = (await load('better-auth/cookies')) as unknown as {
    setSessionCookie(ctx: Ctx, session: { session: Record<string, unknown>; user: Record<string, unknown> }): Promise<void>;
  };
  return {
    id: 'mistri-host',
    endpoints: {
      mistriHostSignIn: createAuthEndpoint.serverOnly({ method: 'POST' }, async (ctx) => {
        const { userId } = ctx.body as { userId: string };
        const user = await ctx.context.internalAdapter.findUserById(userId);
        if (!user) return ctx.json({ refused: true });
        /* Refused here as well as by the admin plugin's session hook, which only a deployment with that plugin has: a
           banned account is handed no session on any host. A ban past its `banExpires` is lifted, as the plugin reads it. */
        const banned = user.banned === true || user.banned === 1;
        const until = user.banExpires == null ? undefined : time(user.banExpires);
        if (banned && (until === undefined || !(until <= Date.now()))) return ctx.json({ refused: true });
        const session = await ctx.context.internalAdapter.createSession(String(user.id));
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ sessionId: String(session.id), expiresAt: new Date(session.expiresAt as Date).getTime() });
      }),
      mistriHostEnd: createAuthEndpoint.serverOnly({ method: 'POST' }, async (ctx) => {
        for (const id of (ctx.body as { sessionIds: string[] }).sessionIds) {
          const row = await ctx.context.adapter.findOne({ model: 'session', where: [{ field: 'id', value: id }] });
          if (typeof row?.token === 'string') await ctx.context.internalAdapter.deleteSession(row.token);
        }
        return ctx.json({ ended: true });
      }),
    },
  };
}

/** Whether a staff session is still there, unexpired and the same person's: a code it minted is redeemed only while it is. */
export async function sessionLive(adapter: LedgerAdapter, sessionId: string, now: number, userId: string): Promise<boolean> {
  const row = await adapter.findOne<{ expiresAt: unknown; userId: unknown }>({
    model: 'session',
    where: [{ field: 'id', value: sessionId }],
  });
  return Boolean(row) && row!.userId === userId && time(row!.expiresAt) > now;
}

interface SessionCookieOptions {
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}
/** A sign-in handed to a tenant's own host (hostHandoff.ts). */
export interface HostSignIn {
  /** Where the session a proof stands for is pinned; null for a session of the deployment's own host. */
  pinned(proof: VerifiedSessionInstance): HostPin | null;
  /** A code for the tenant's host, from a session of the deployment's own host that is signed in to `at`'s tenant,
   * landing at `to` there. */
  mint(proof: VerifiedSessionInstance, at: HostPlace, verifierHash: string, to: string): Promise<string>;
  /** The code spent for a session pinned to `at`: its Set-Cookie lines and the path it was minted to land at, or null
   * for a code that is not one. */
  redeem(code: unknown, verifier: unknown, at: HostPlace, userAgent: string): Promise<{ cookies: string[]; to: string } | null>;
  /** Ends the pinned session, and with `everywhere` the session that handed it out and every other it handed out.
   * `ending` hears every session id it is about to end, before any ends. */
  signOut(proof: VerifiedSessionInstance, everywhere: boolean, ending?: (sessionIds: readonly string[]) => void): Promise<void>;
  /** The Set-Cookie lines that clear this host's session cookies: the session's own, and the session cache's, chunks
   * included, where the request carries them. Asked before the sign-out, so a failed one still clears the browser. */
  clearing(cookieHeader: string | undefined): Promise<string[]>;
}

export type SessionCookies = Record<
  'sessionToken' | 'sessionData' | 'dontRememberToken',
  { name: string; attributes: SessionCookieOptions }
>;

/** The Set-Cookie lines that end a session in the browser. Each is cleared with the attributes it was set with (a
 * `__Secure-` name needs Secure to be overwritten at all). The session cache, where it is on, may be chunked as
 * `<name>.0`, `<name>.1`…: whichever of those the request carries go too, as Better Auth's own sign-out clears them. */
export function clearingCookies(cookies: SessionCookies, cookieHeader: string | undefined): string[] {
  const line = (name: string, options: SessionCookieOptions) => {
    const sameSite =
      typeof options.sameSite === 'string'
        ? `; SameSite=${options.sameSite[0]!.toUpperCase()}${options.sameSite.slice(1).toLowerCase()}`
        : '';
    return `${name}=; Max-Age=0; Path=${options.path ?? '/'}${options.httpOnly === false ? '' : '; HttpOnly'}${sameSite}${options.secure ? '; Secure' : ''}`;
  };
  const sent = new Set(
    (cookieHeader ?? '')
      .split(';')
      .map((part) => part.split('=')[0]!.trim())
      .filter(Boolean),
  );
  const data = cookies.sessionData;
  const cached = [...sent].filter(
    (name) => name === data.name || (name.startsWith(`${data.name}.`) && /^\d+$/.test(name.slice(data.name.length + 1))),
  );
  return [
    line(cookies.sessionToken.name, cookies.sessionToken.attributes),
    ...cached.map((name) => line(name, data.attributes)),
    ...(sent.has(cookies.dontRememberToken.name) ? [line(cookies.dontRememberToken.name, cookies.dontRememberToken.attributes)] : []),
  ];
}
