/**
 * A fixed-window limiter per client, for the one surface a signed-out person
 * may write to: a public form. In memory by default, so a restart forgets
 * and a second process does not share; when the config names a cache
 * (`"kind": "cache"`), the same windows are counted there instead, so every
 * instance of a deployment spends one budget (`SharedWindowLimiter`). The
 * limits are deployment-owned defaults and not configurable. The address is
 * the one `forwardedClient` resolves: a forwarded header only when the socket
 * peer is a trusted proxy — on this machine, or named by `--trust-proxy` —
 * else the peer itself, so a proxy on another host that nobody named still
 * collapses its clients to one address, which the docs say.
 *
 * Bounded, because the clients are whoever the network sends. The review
 * that asked for this measured the first version: past its cap it scanned
 * every tracked address on each new one and dropped only the fully expired,
 * which under the one-hour window was none — 40,000 addresses held the event
 * loop for 21 seconds, and every address in one IPv6 /64 had its own budget.
 * Now: a hard cap on tracked clients, a Map kept in least-recently-seen
 * order (a touch re-inserts, the front is the stalest) so expiry is a sweep
 * from the front that stops at the first live entry — O(1) amortised, no
 * scan and no timer — and an IPv6 client is its /64.
 */
import type { IncomingMessage } from 'node:http';
import { CacheUnavailable, scopedCache, type CacheStore } from '../../adapters/cache/cacheStore.js';
import { forwardedClient, ipv6Groups, type ProxyRange } from './trust.js';

interface RateWindow {
  limit: number;
  ms: number;
}
/** `scope` says whose budget ran out: this client's, or the one every client shares. */
type RateDecision = { ok: true; remaining: number } | { ok: false; retryAfterSeconds: number; scope: 'client' | 'all' };

/**
 * Which budgets a take spends: the client's and the shared ceiling together (`'both'`, the default), or one of
 * them. A door that proves its caller (a ticket, a human check) spends the client's first and the ceiling only
 * once the proof passes, so a flood that cannot prove anything spends its own addresses' budgets, never the one
 * every visitor shares.
 */
export type RatePart = 'both' | 'client' | 'all';

/** A limiter that decides now (in memory) or once the shared cache has counted. */
interface WindowLimiter {
  take(address: string, part?: RatePart): RateDecision | Promise<RateDecision>;
  /** Forget this process's own counts; tests and a policy reload use it. A shared cache's windows expire on their own. */
  reset(): void;
}

interface LimiterOptions {
  /** The most clients tracked at once. */
  maxClients?: number;
  /**
   * A new client, when every slot holds a budget still in force: `refuse` it
   * until the stalest slot expires, or `evict` the stalest and admit it.
   */
  whenFull?: 'refuse' | 'evict';
  /** Windows over every client together: what rotating addresses cannot exceed. */
  total?: readonly RateWindow[];
}

const MAX_CLIENTS = 10_000;

function assertWindows(windows: readonly RateWindow[]): void {
  if (!windows.length || windows.some((w) => !Number.isSafeInteger(w.limit) || w.limit < 1 || !Number.isFinite(w.ms) || w.ms <= 0)) {
    throw new Error('A rate limiter needs at least one window of a positive limit over a positive span.');
  }
}

/** One budget over a set of windows: where each window started and what it has counted. */
class Budget {
  readonly starts: number[];
  readonly counts: number[];
  seen: number;
  constructor(windows: readonly RateWindow[], now: number) {
    this.starts = windows.map(() => now);
    this.counts = windows.map(() => 0);
    this.seen = now;
  }

  /** Roll over the windows that have elapsed; the seconds until the longest exceeded one reopens, or 0. */
  wait(windows: readonly RateWindow[], now: number): number {
    let wait = 0;
    windows.forEach((window, i) => {
      if (now - this.starts[i] >= window.ms) {
        this.starts[i] = now;
        this.counts[i] = 0;
      }
      if (this.counts[i] >= window.limit) wait = Math.max(wait, Math.ceil((this.starts[i] + window.ms - now) / 1000), 1);
    });
    return wait;
  }

  /** Count one request; what is left in the tightest window. */
  count(windows: readonly RateWindow[]): number {
    let remaining = Infinity;
    windows.forEach((window, i) => {
      this.counts[i]++;
      remaining = Math.min(remaining, window.limit - this.counts[i]);
    });
    return remaining;
  }
}

/**
 * The key a client's budget is kept under. IPv4 as it is; an IPv4-mapped
 * IPv6 address (`::ffff:192.0.2.1`, how a dual-stack socket reports an IPv4
 * peer) as that IPv4 address; any other IPv6 address as its /64, the
 * smallest network one subscriber is routinely given — one host can
 * otherwise draw a fresh budget from each of its 2^64 addresses. Anything
 * that is not an address (`unknown`) is its own key.
 */
export function limitKey(address: string): string {
  if (!address.includes(':')) return address;
  const groups = ipv6Groups(address);
  if (!groups) return address;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

export class FixedWindowLimiter implements WindowLimiter {
  /* Least recently seen first. Named `hits` still: the review's probe reads its size. */
  private readonly hits = new Map<string, Budget>();
  private readonly longest: number;
  private readonly maxClients: number;
  private readonly whenFull: 'refuse' | 'evict';
  private readonly totalWindows: readonly RateWindow[] | undefined;
  private total: Budget | undefined;

  constructor(
    private readonly windows: readonly RateWindow[],
    private readonly now: () => number = Date.now,
    options: LimiterOptions = {},
  ) {
    assertWindows(windows);
    if (options.total) assertWindows(options.total);
    const maxClients = options.maxClients ?? MAX_CLIENTS;
    if (!Number.isSafeInteger(maxClients) || maxClients < 1) throw new Error('A rate limiter tracks at least one client.');
    this.longest = Math.max(...windows.map((window) => window.ms));
    this.maxClients = maxClients;
    this.whenFull = options.whenFull ?? 'refuse';
    this.totalWindows = options.total;
  }

  /** Count one request for the client, or say how long it waits. */
  take(address: string, part: RatePart = 'both'): RateDecision {
    const now = this.now();
    this.expire(now);
    if (part === 'all') return this.takeShared(now) ?? { ok: true, remaining: Infinity };
    const key = limitKey(address);
    const entry = this.hits.get(key);
    if (entry) {
      // Seen again, refused or not: a client still knocking keeps what it spent.
      this.hits.delete(key);
      this.hits.set(key, entry);
      entry.seen = now;
      const wait = entry.wait(this.windows, now);
      if (wait > 0) return { ok: false, retryAfterSeconds: wait, scope: 'client' };
    }
    const shared = part === 'both' && this.totalWindows ? (this.total ??= new Budget(this.totalWindows, now)) : undefined;
    const sharedWait = shared ? shared.wait(this.totalWindows!, now) : 0;
    if (sharedWait > 0) return { ok: false, retryAfterSeconds: sharedWait, scope: 'all' };
    let budget = entry;
    if (!budget) {
      if (this.hits.size >= this.maxClients) {
        const [stalest, oldest] = this.hits.entries().next().value!;
        /* Every slot holds a budget still in force. Evicting one forgets
           what that client spent, so a client rotating addresses past the
           cap would come back to a fresh budget — the one thing a limiter
           exists to withhold. `refuse` keeps every budget and turns the
           newcomer away until the stalest slot expires on its own (at most
           the longest window): the fail-safe direction, and the submit
           limiter's. It refuses no one a flood would not already have
           refused, since reaching the cap there needs more admitted
           submissions than the shared ceiling allows in a window. `evict`
           is for reads, where a forgotten budget costs a page of
           presentation and a refusal would let a flood of addresses blank
           the form for everyone arriving after it. */
        if (this.whenFull === 'refuse') {
          return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest.seen + this.longest - now) / 1000)), scope: 'all' };
        }
        this.hits.delete(stalest);
      }
      budget = new Budget(this.windows, now);
      this.hits.set(key, budget);
    }
    const remaining = budget.count(this.windows);
    shared?.count(this.totalWindows!);
    return { ok: true, remaining };
  }

  /* The shared ceiling alone: a refusal, or undefined once counted (or where there is none). */
  private takeShared(now: number): RateDecision | undefined {
    if (!this.totalWindows) return undefined;
    const shared = (this.total ??= new Budget(this.totalWindows, now));
    const wait = shared.wait(this.totalWindows, now);
    if (wait > 0) return { ok: false, retryAfterSeconds: wait, scope: 'all' };
    shared.count(this.totalWindows);
    return undefined;
  }

  /** How many clients are tracked; tests read it. */
  get size(): number {
    return this.hits.size;
  }

  /** Forget every client and the shared count; tests and a policy reload use it. */
  reset(): void {
    this.hits.clear();
    this.total = undefined;
  }

  /* A budget last seen a longest-window ago has nothing left in force:
     each take rolls over what elapsed, so every window then began after
     `seen - longest`. The Map is in seen order, so the sweep stops at the
     first entry still live. */
  private expire(now: number): void {
    for (const [key, entry] of this.hits) {
      if (entry.seen + this.longest > now) break;
      this.hits.delete(key);
    }
  }
}

/**
 * The same windows, counted in the deployment's cache so every instance
 * spends one budget. Each window is a key per client (and one for everyone)
 * counted by the cache's atomic windowed count, which starts the window on
 * the first request; a refused request is counted too, which only keeps an
 * exceeded window exceeded until it ends on its own. There is no cap on
 * tracked clients to keep: every key expires with its window.
 *
 * When the cache cannot count, the process's own limiter decides — the
 * budget degrades to one instance's, never to none.
 */
export class SharedWindowLimiter implements WindowLimiter {
  constructor(
    private readonly name: string,
    private readonly windows: readonly RateWindow[],
    private readonly cache: CacheStore,
    private readonly fallback: FixedWindowLimiter,
    private readonly totalWindows?: readonly RateWindow[],
  ) {
    assertWindows(windows);
    if (totalWindows) assertWindows(totalWindows);
  }

  async take(address: string, part: RatePart = 'both'): Promise<RateDecision> {
    try {
      let remaining = Infinity;
      if (part !== 'all') {
        const client = await this.count(this.windows, `${this.name}:${limitKey(address)}`);
        if (client.wait > 0) return { ok: false, retryAfterSeconds: client.wait, scope: 'client' };
        remaining = client.remaining;
      }
      if (part !== 'client' && this.totalWindows) {
        const all = await this.count(this.totalWindows, `${this.name}:*`);
        if (all.wait > 0) return { ok: false, retryAfterSeconds: all.wait, scope: 'all' };
      }
      return { ok: true, remaining };
    } catch (error) {
      if (!(error instanceof CacheUnavailable)) throw error;
      return this.fallback.take(address, part);
    }
  }

  reset(): void {
    this.fallback.reset();
  }

  private async count(windows: readonly RateWindow[], key: string): Promise<{ wait: number; remaining: number }> {
    let wait = 0;
    let remaining = Infinity;
    for (const [i, window] of windows.entries()) {
      const { count, ttlMs } = await this.cache.incr(`${key}:${i}`, window.ms);
      if (count > window.limit) wait = Math.max(wait, Math.max(1, Math.ceil(ttlMs / 1000)));
      else remaining = Math.min(remaining, window.limit - count);
    }
    return { wait, remaining };
  }
}

/** The client a limit counts against; a forwarded header only from a trusted peer (loopback, or `--trust-proxy`). */
export function clientAddress(req: Pick<IncomingMessage, 'socket' | 'headers'>, trusted: readonly ProxyRange[] = []): string {
  return forwardedClient(req, trusted);
}

/* The public forms' defaults, across every public form of the App: five
   submissions a minute and thirty an hour per client, three hundred an hour
   across every client, sixty reads a minute per client. One instance per
   process, shared by every request; `resetPublicFormLimits` is for tests
   that run several servers in one. */
export const PUBLIC_FORM_SUBMIT_WINDOWS: readonly RateWindow[] = Object.freeze([
  { limit: 5, ms: 60_000 },
  { limit: 30, ms: 3_600_000 },
]);
export const PUBLIC_FORM_SUBMIT_TOTAL: readonly RateWindow[] = Object.freeze([{ limit: 300, ms: 3_600_000 }]);
export const PUBLIC_FORM_READ_WINDOWS: readonly RateWindow[] = Object.freeze([{ limit: 60, ms: 60_000 }]);
/* An account-creating invitation's claim is shaped like a submission — the
   same per-client windows and ceiling, the same refusal — but counted in a
   budget of its own: a busy public form must not use up the claims a dealer's
   new staff can make, nor the other way about. */
export const INVITATION_CLAIM_WINDOWS: readonly RateWindow[] = PUBLIC_FORM_SUBMIT_WINDOWS;
export const INVITATION_CLAIM_TOTAL: readonly RateWindow[] = PUBLIC_FORM_SUBMIT_TOTAL;

/* A form saved on every step opens a draft in the App's real tables on its
   first step, so the drafts one client may open are capped apart from its
   submissions: ten an hour — an applicant who starts over a few times is never
   near it, and a script cannot fill the root table with abandoned drafts. A
   status check is a guess at a receipt and its confirmations, so it is
   counted tighter still, per client here and per receipt in its own lockout
   (forms/statusCheck.ts). */
const SAVED_FORM_START_WINDOWS: readonly RateWindow[] = Object.freeze([{ limit: 10, ms: 3_600_000 }]);
const SAVED_FORM_START_TOTAL: readonly RateWindow[] = Object.freeze([{ limit: 500, ms: 3_600_000 }]);
const STATUS_CHECK_WINDOWS: readonly RateWindow[] = Object.freeze([
  { limit: 5, ms: 60_000 },
  { limit: 20, ms: 3_600_000 },
]);
const STATUS_CHECK_TOTAL: readonly RateWindow[] = Object.freeze([{ limit: 600, ms: 3_600_000 }]);
/* Adding an application to an account — spending the browser's claim, or
   linking after a status check — is counted on its own too: a person links
   the one application they made, so a handful a minute is already generous. */
const LINK_WINDOWS: readonly RateWindow[] = Object.freeze([
  { limit: 5, ms: 60_000 },
  { limit: 20, ms: 3_600_000 },
]);
const LINK_TOTAL: readonly RateWindow[] = Object.freeze([{ limit: 300, ms: 3_600_000 }]);
/* A request that makes the server send an email — a code to prove an
   address — is counted apart and tightest: a person asks for one or two. */
const CODE_WINDOWS: readonly RateWindow[] = Object.freeze([
  { limit: 3, ms: 60_000 },
  { limit: 10, ms: 3_600_000 },
]);
const CODE_TOTAL: readonly RateWindow[] = Object.freeze([{ limit: 300, ms: 3_600_000 }]);

/* A step's check: a form's own pages asking the server's word as someone goes on, so a page's worth a minute from one
   client, and never counted against what that client may submit. */
const CHECK_WINDOWS: readonly RateWindow[] = Object.freeze([{ limit: 60, ms: 60_000 }]);
const CHECK_TOTAL: readonly RateWindow[] = Object.freeze([{ limit: 6_000, ms: 60_000 }]);

const check = new FixedWindowLimiter(CHECK_WINDOWS, Date.now, { total: CHECK_TOTAL, whenFull: 'evict' });
const submit = new FixedWindowLimiter(PUBLIC_FORM_SUBMIT_WINDOWS, Date.now, { total: PUBLIC_FORM_SUBMIT_TOTAL, whenFull: 'refuse' });
const read = new FixedWindowLimiter(PUBLIC_FORM_READ_WINDOWS, Date.now, { whenFull: 'evict' });
const claim = new FixedWindowLimiter(INVITATION_CLAIM_WINDOWS, Date.now, { total: INVITATION_CLAIM_TOTAL, whenFull: 'refuse' });
const start = new FixedWindowLimiter(SAVED_FORM_START_WINDOWS, Date.now, { total: SAVED_FORM_START_TOTAL, whenFull: 'refuse' });
const status = new FixedWindowLimiter(STATUS_CHECK_WINDOWS, Date.now, { total: STATUS_CHECK_TOTAL, whenFull: 'refuse' });
const link = new FixedWindowLimiter(LINK_WINDOWS, Date.now, { total: LINK_TOTAL, whenFull: 'refuse' });
const code = new FixedWindowLimiter(CODE_WINDOWS, Date.now, { total: CODE_TOTAL, whenFull: 'refuse' });
let shared:
  | {
      submit: SharedWindowLimiter;
      read: SharedWindowLimiter;
      claim: SharedWindowLimiter;
      start: SharedWindowLimiter;
      status: SharedWindowLimiter;
      link: SharedWindowLimiter;
      code: SharedWindowLimiter;
      check: SharedWindowLimiter;
    }
  | undefined;

export function publicFormLimiter(
  kind: 'submit' | 'read' | 'start' | 'status' | 'link' | 'code' | 'check',
): FixedWindowLimiter | SharedWindowLimiter {
  if (shared) return shared[kind];
  if (kind === 'check') return check;
  return kind === 'submit'
    ? submit
    : kind === 'read'
      ? read
      : kind === 'start'
        ? start
        : kind === 'link'
          ? link
          : kind === 'code'
            ? code
            : status;
}

/** The invitation claims' own budget (tenantInvitationHttp.ts), never the forms'. */
export function invitationClaimLimiter(): FixedWindowLimiter | SharedWindowLimiter {
  return shared ? shared.claim : claim;
}

/**
 * Count the public forms' windows in the deployment's cache, under the
 * deployment's namespace (`tw:<app>:form:`), or — with no cache, or the
 * process's own — in this process, as before.
 */
export function configurePublicFormLimits(cache: CacheStore | undefined, namespace: string): void {
  if (!cache || cache.kind === 'memory') {
    shared = undefined;
    return;
  }
  const scoped = scopedCache(cache, `tw:${namespace}:form:`);
  shared = {
    submit: new SharedWindowLimiter('submit', PUBLIC_FORM_SUBMIT_WINDOWS, scoped, submit, PUBLIC_FORM_SUBMIT_TOTAL),
    read: new SharedWindowLimiter('read', PUBLIC_FORM_READ_WINDOWS, scoped, read),
    // Its own key prefix, so the claims' windows are counted apart from the forms'.
    claim: new SharedWindowLimiter('claim', INVITATION_CLAIM_WINDOWS, scoped, claim, INVITATION_CLAIM_TOTAL),
    start: new SharedWindowLimiter('start', SAVED_FORM_START_WINDOWS, scoped, start, SAVED_FORM_START_TOTAL),
    status: new SharedWindowLimiter('status', STATUS_CHECK_WINDOWS, scoped, status, STATUS_CHECK_TOTAL),
    link: new SharedWindowLimiter('link', LINK_WINDOWS, scoped, link, LINK_TOTAL),
    code: new SharedWindowLimiter('code', CODE_WINDOWS, scoped, code, CODE_TOTAL),
    check: new SharedWindowLimiter('check', CHECK_WINDOWS, scoped, check, CHECK_TOTAL),
  };
}

/** Forgets the forms' budgets and the claims'; tests and a policy reload use it. */
export function resetPublicFormLimits(): void {
  submit.reset();
  read.reset();
  claim.reset();
  start.reset();
  status.reset();
  link.reset();
  code.reset();
  check.reset();
}
