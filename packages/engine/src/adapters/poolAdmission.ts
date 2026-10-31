/**
 * The line a checkout waits in for one of a pool's connections, and whose turn
 * it is. One per role of a manager (postgresPool.ts): the readers, the writers.
 *
 * The line used to be the driver's own, first come first served, bounded only
 * in length (POOL_QUEUE_PER_CONNECTION) and wait (POOL_QUEUE_WAIT_MS). Under a
 * retry storm at `--read-pool 1` — a few accounts answering every 503 by
 * asking again at once, Retry-After unread — their requests filled it, every
 * other account's arrived to a full line and was refused, and what got in
 * waited behind the storm until its budget ran out: a live load test saw the
 * useful work done collapse. The driver made it worse: it cannot withdraw a
 * request it has queued, so each one that gave up still took its turn later,
 * and a connection went round the abandoned requests before reaching a live
 * one. Now the line is ours, the driver is asked for a connection only once
 * one is this checkout's, and a waiter that gives up leaves the line.
 *
 * Each waiting checkout is filed under the account it runs for (below: the
 * signed-in account, or a signed-out client's address), and three rules keep
 * one account from taking the line from the others:
 *
 *   - Turns go round the accounts: one checkout from each account waiting,
 *     then the next, so a quiet account's request is the next or nearly the
 *     next served however long a storming account's line is. Within an
 *     account, arrival order: one person's saves sent together still apply in
 *     the order they were sent.
 *   - An account may hold at most half the line's places. Past that its next
 *     request is refused at once, busy, with Retry-After, rather than queued
 *     to time out. Half, not a small fixed number: one person's own fan-out
 *     (a page's boot sends up to eight reads, a dashboard one per section) is
 *     waited for, not refused, on any pool, and the other half stays open to
 *     everyone else.
 *   - A full line turns away its longest account's newest waiter, not the
 *     newcomer, when the newcomer's account holds fewer places by more than
 *     one: two or three storming accounts cannot fill the line between them
 *     and refuse a fourth. The one turned away waited least and leaves its
 *     account the most still queued; nothing was leased for it, so it is a
 *     busy refusal like any other (a write's outcome `not_applied`).
 *
 * The bounds themselves are unchanged: the line's length is the pool's
 * connections times POOL_QUEUE_PER_CONNECTION, and a checkout that waits
 * POOL_QUEUE_WAIT_MS is refused.
 *
 * A checkout that runs for no request — a job's read, the stdio MCP server, a
 * process's start — is filed under no account. It takes its turn with the
 * accounts, as one of them, but is never refused for its share nor turned
 * away for another's: it is the server's own work, and it waited in one line
 * with everything else before.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { PoolBusy } from './poolMetrics.js';

/** Who a request's checkouts wait for: settled at arrival, refined in place once its session names the account. */
interface Admission {
  key: string;
}

const admissions = new AsyncLocalStorage<Admission>();

/**
 * Run a request's `work` with its checkouts filed under the client that sent
 * it: `address` as the server reads it, a forwarded one only from a trusted
 * proxy (trust.ts forwardedClient), so a signed-out storm cannot spread itself
 * over invented addresses.
 */
export function withAdmission<T>(address: string, work: () => T): T {
  return admissions.run({ key: `client:${address}` }, work);
}

/** The request's session names its account: its checkouts from here on wait as that account's. */
export function admitAs(account: string | undefined): void {
  const admission = admissions.getStore();
  if (admission && account) admission.key = `account:${account}`;
}

interface Waiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: PoolBusy) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** The waiters filed under no account: a key no request's can be, since every request's carries a prefix. */
const UNFILED = '';

export class PoolAdmission {
  private inUse = 0;
  private waiting = 0;
  /** Each account's waiters in arrival order; the Map's own order is the turn's, the first account's next. */
  private readonly lines = new Map<string, Waiter[]>();

  /**
   * @param size the pool's connections: how many checkouts hold one at once.
   * @param most how many may wait.
   */
  constructor(
    private readonly role: 'read' | 'write',
    private size: number,
    private readonly most: number,
  ) {}

  /**
   * How many places there are from now on. A pool held at the connections it
   * has (postgresPool.ts holdAtLimit) is resized to them, so the checkouts past
   * them wait here, in their turns, rather than in the driver's line, which
   * cannot withdraw a request nor take turns; and back again when the hold ends.
   */
  resize(size: number): void {
    this.size = size;
    this.serve();
  }

  /**
   * A place among the pool's connections, now or at this checkout's turn:
   * call the returned function to give it back. Refused with PoolBusy past
   * the line's bounds or once `waitMs` is spent.
   */
  enter(waitMs: number): Promise<() => void> {
    if (this.inUse < this.size && this.waiting === 0) {
      this.inUse += 1;
      return Promise.resolve(this.place());
    }
    const key = admissions.getStore()?.key ?? UNFILED;
    const held = this.lines.get(key)?.length ?? 0;
    const full = () => Promise.reject(new PoolBusy(this.role, 'queue_full'));
    if (key !== UNFILED && held >= Math.max(1, Math.floor(this.most / 2))) return full();
    if (this.waiting >= this.most && !this.turnAwayLongest(key, held)) return full();
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        this.leave(key, waiter);
        reject(new PoolBusy(this.role, 'queue_timeout'));
      }, waitMs);
      const line = this.lines.get(key);
      if (line) line.push(waiter);
      else this.lines.set(key, [waiter]);
      this.waiting += 1;
      this.serve();
    });
  }

  /** Give the place to whoever's turn it is, while places are free. */
  private serve(): void {
    while (this.inUse < this.size) {
      const next = this.lines.entries().next();
      if (next.done) return;
      const [key, line] = next.value;
      const waiter = line.shift()!;
      // To the back of the turn, behind every other account waiting.
      this.lines.delete(key);
      if (line.length) this.lines.set(key, line);
      this.waiting -= 1;
      this.inUse += 1;
      clearTimeout(waiter.timer);
      waiter.resolve(this.place());
    }
  }

  /** A held place, given back once. */
  private place(): () => void {
    let given = false;
    return () => {
      if (given) return;
      given = true;
      this.inUse -= 1;
      this.serve();
    };
  }

  private leave(key: string, waiter: Waiter): void {
    const line = this.lines.get(key);
    const at = line?.indexOf(waiter) ?? -1;
    if (!line || at < 0) return;
    line.splice(at, 1);
    this.waiting -= 1;
    if (!line.length) this.lines.delete(key);
  }

  /** At a full line, refuse the longest other account's newest waiter for a newcomer holding `held` places: whether one was. */
  private turnAwayLongest(key: string, held: number): boolean {
    if (key === UNFILED) return false;
    let longest: [string, Waiter[]] | undefined;
    for (const entry of this.lines) {
      if (entry[0] !== UNFILED && entry[0] !== key && entry[1].length > (longest?.[1].length ?? 0)) longest = entry;
    }
    if (!longest || longest[1].length <= held + 1) return false;
    const waiter = longest[1][longest[1].length - 1];
    clearTimeout(waiter.timer);
    this.leave(longest[0], waiter);
    waiter.reject(new PoolBusy(this.role, 'queue_full'));
    return true;
  }
}
