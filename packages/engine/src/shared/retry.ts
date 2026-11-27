/**
 * Shared retry-storm primitives used by server and client alike:
 *
 *   - Error ownership (`x-mistri-error-claim: claimed | unclaimed`, following
 *     Uber's error-ownership protocol): only the immediate caller of the node
 *     that originated a failure retries it; an upstream hop returning a
 *     downstream failure unclaims it so retries do not compound across depth.
 *   - Retry attempt propagation (`x-mistri-retry-attempt`): lets server
 *     admission deprioritize or shed retries ahead of fresh first attempts
 *     under overload (Arolla / Cinnamon).
 *   - Downstream pushback (`Retry-After`): parsed once (delta-seconds or
 *     HTTP-date), clamped, and respected with additive jitter so clients never
 *     fire early and never return in lockstep.
 *   - Jittered exponential backoff (AWS equal/full jitter): breaks
 *     synchronized thundering herds across browsers, jobs, workflows, and
 *     outbound webhooks.
 *   - Per-destination token-bucket retry budgets (`RetryBudget`,
 *     `RetryBudgetRegistry`): caps aggregate retry load across concurrent
 *     requests to a struggling dependency while remembering `Retry-After`
 *     cooldowns.
 */

export const ERROR_CLAIM_HEADER = 'x-mistri-error-claim';
export const RETRY_ATTEMPT_HEADER = 'x-mistri-retry-attempt';

export type ErrorClaim = 'claimed' | 'unclaimed';

/** Upper bound on a Retry-After header a caller trusts (5 minutes). */
export const MAX_RETRY_AFTER_MS = 300_000;

/** Parse an error-claim header (`claimed` or `unclaimed`); anything else is absent. */
export function parseErrorClaim(value: string | string[] | null | undefined): ErrorClaim | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'claimed' || normalized === 'true') return 'claimed';
  if (normalized === 'unclaimed' || normalized === 'false') return 'unclaimed';
  return undefined;
}

/**
 * Uber's error-ownership decision: only an explicit `unclaimed` suppresses the
 * immediate caller's retry. A missing header (uncooperative peer) or `claimed`
 * allows the immediate caller to retry, after which it unclaims upward.
 */
export function shouldRetryErrorClaim(claim: ErrorClaim | undefined): boolean {
  return claim !== 'unclaimed';
}

/** Parse a `x-mistri-retry-attempt` header into a non-negative attempt count (0 = first try). */
export function parseRetryAttempt(value: string | string[] | null | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return 0;
  const trimmed = raw.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return 0;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Parse RFC 9110 `Retry-After` (delta-seconds or HTTP-date) into milliseconds,
 * clamped to `[0, maxMs]`. Returns undefined when absent or unparseable.
 */
export function parseRetryAfterMs(
  value: string | string[] | null | undefined,
  now: number = Date.now(),
  maxMs: number = MAX_RETRY_AFTER_MS,
): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.min(maxMs, Math.max(0, Math.round(seconds * 1_000)));
  }
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return undefined;
  return Math.min(maxMs, Math.max(0, Math.round(at - now)));
}

const unit = (random: () => number): number => {
  const value = random();
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
};

/**
 * AWS Equal Jitter: keeps half the nominal delay as a floor and spreads the
 * other half uniformly across `[0.5 * delay, delay]`, breaking synchronization
 * without creating 0 ms tight loops.
 */
export function equalJitter(delayMs: number, random: () => number = Math.random): number {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 0;
  const half = delayMs / 2;
  return Math.max(1, Math.round(half + unit(random) * half));
}

/**
 * Additive jitter on top of a server-specified `Retry-After`: never retries
 * earlier than the server requested, while spreading a crowd that received the
 * same header across `[retryAfterMs, retryAfterMs + spread]`.
 */
export function retryAfterWithJitter(
  retryAfterMs: number,
  maxSpreadMs = Math.min(5_000, Math.max(250, Math.round(retryAfterMs * 0.25))),
  random: () => number = Math.random,
): number {
  const base = Math.max(0, Math.round(retryAfterMs));
  const spread = Math.max(0, Math.round(maxSpreadMs));
  return base + Math.round(unit(random) * spread);
}

/**
 * Capped exponential backoff with equal jitter, honoring a `Retry-After` floor
 * when the downstream asked us to wait longer.
 */
export function jitteredBackoffMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  options: Readonly<{ minDelayMs?: number; random?: () => number }> = {},
): number {
  const random = options.random ?? Math.random;
  const nominal = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jittered = equalJitter(nominal, random);
  if (options.minDelayMs !== undefined && options.minDelayMs > jittered) {
    return retryAfterWithJitter(options.minDelayMs, Math.min(2_000, Math.max(100, Math.round(options.minDelayMs * 0.2))), random);
  }
  return jittered;
}

interface RetryBudgetOptions {
  /** Maximum tokens held by the bucket (bounds burst retries during a sudden blip). */
  readonly maxTokens?: number;
  /** Tokens spent per retry attempt. */
  readonly retryCost?: number;
  /** Tokens deposited per successful request (ratio = successCredit / retryCost, default 10%). */
  readonly successCredit?: number;
  /** Initial tokens available before any traffic is observed. */
  readonly initialTokens?: number;
  /** Minimum tokens passively regenerated per minute so a quiet destination can still probe. */
  readonly refillPerMinute?: number;
}

type RetryBudgetDecision = Readonly<{ allowed: true }> | Readonly<{ allowed: false; reason: 'cooldown' | 'budget'; waitMs: number }>;

/**
 * Per-destination token-bucket retry budget (AWS SDK / Envoy style) with
 * `Retry-After` cooldown memory. Normal 1–5% transient errors pass through
 * freely; sustained overload drains the bucket and suppresses retry storms.
 */
export class RetryBudget {
  private readonly maxTokens: number;
  private readonly retryCost: number;
  private readonly successCredit: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private lastRefillAt: number;
  private cooldownUntil = 0;
  private allowedCount = 0;
  private suppressedCount = 0;

  constructor(
    options: RetryBudgetOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.maxTokens = Math.max(1, options.maxTokens ?? 10);
    this.retryCost = Math.max(0.1, options.retryCost ?? 1);
    this.successCredit = Math.max(0, options.successCredit ?? 0.1);
    this.refillPerMs = Math.max(0, options.refillPerMinute ?? 3) / 60_000;
    this.tokens = Math.min(this.maxTokens, Math.max(0, options.initialTokens ?? this.maxTokens));
    this.lastRefillAt = this.now();
  }

  private refill(at: number): void {
    if (at <= this.lastRefillAt) return;
    if (this.refillPerMs > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + (at - this.lastRefillAt) * this.refillPerMs);
    }
    this.lastRefillAt = at;
  }

  /** Record a successful call, crediting the destination's retry budget. */
  recordSuccess(at: number = this.now()): void {
    this.refill(at);
    this.tokens = Math.min(this.maxTokens, this.tokens + this.successCredit);
    if (this.cooldownUntil <= at) this.cooldownUntil = 0;
  }

  /** Record a failed call, remembering any `Retry-After` pushback cooldown. */
  recordFailure(at: number = this.now(), retryAfterMs?: number): void {
    this.refill(at);
    if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      this.cooldownUntil = Math.max(this.cooldownUntil, at + Math.min(MAX_RETRY_AFTER_MS, retryAfterMs));
    }
  }

  /** Milliseconds remaining in an explicit `Retry-After` cooldown, or 0. */
  cooldownRemainingMs(at: number = this.now()): number {
    return this.cooldownUntil > at ? this.cooldownUntil - at : 0;
  }

  /** Attempt to spend budget for one retry; returns false when cooled down or budget is empty. */
  tryConsumeRetry(at: number = this.now()): RetryBudgetDecision {
    this.refill(at);
    if (this.cooldownUntil > at) {
      this.suppressedCount += 1;
      return Object.freeze({ allowed: false, reason: 'cooldown', waitMs: this.cooldownUntil - at });
    }
    if (this.tokens < this.retryCost) {
      this.suppressedCount += 1;
      const needed = this.retryCost - this.tokens;
      const waitMs = this.refillPerMs > 0 ? Math.ceil(needed / this.refillPerMs) : 1_000;
      return Object.freeze({ allowed: false, reason: 'budget', waitMs });
    }
    this.tokens -= this.retryCost;
    this.allowedCount += 1;
    return Object.freeze({ allowed: true });
  }

  /** Snapshot for tests and diagnostics. */
  snapshot(at: number = this.now()): Readonly<{
    tokens: number;
    cooldownRemainingMs: number;
    retriesAllowed: number;
    retriesSuppressed: number;
  }> {
    this.refill(at);
    return Object.freeze({
      tokens: this.tokens,
      cooldownRemainingMs: this.cooldownRemainingMs(at),
      retriesAllowed: this.allowedCount,
      retriesSuppressed: this.suppressedCount,
    });
  }
}

/** Bounded LRU registry of per-destination retry budgets, so dynamic destinations cannot leak memory. */
export class RetryBudgetRegistry {
  private readonly budgets = new Map<string, RetryBudget>();

  constructor(
    private readonly options: RetryBudgetOptions = {},
    private readonly maxDestinations = 512,
    private readonly now: () => number = Date.now,
  ) {}

  for(destination: string): RetryBudget {
    const existing = this.budgets.get(destination);
    if (existing) {
      this.budgets.delete(destination);
      this.budgets.set(destination, existing);
      return existing;
    }
    if (this.budgets.size >= this.maxDestinations) {
      const oldest = this.budgets.keys().next().value;
      if (oldest !== undefined) this.budgets.delete(oldest);
    }
    const created = new RetryBudget(this.options, this.now);
    this.budgets.set(destination, created);
    return created;
  }

  reset(): void {
    this.budgets.clear();
  }
}
