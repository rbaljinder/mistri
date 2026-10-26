/**
 * A password sign-in's lockout per account, beside Better Auth's budget per
 * client address.
 *
 * The address budget alone does not stop guessing one account's password: a
 * botnet has as many addresses as it needs, and behind a proxy nobody named
 * every visitor is one address. So the address that is guessed at is counted
 * too. Each attempt is counted before it is judged — guesses sent together
 * all read the count as it was otherwise (forms/statusCheck.ts says the same)
 * — and past `ATTEMPTS` in a window the address is closed for a while that
 * doubles with each lock, up to `LOCK_MAX_MS`. A sign-in that succeeds takes
 * the count, the lock and its doubling away.
 *
 * An address no account has is counted and locked exactly as one that has
 * an account is, and the refusal is one sentence for both: the lockout must
 * not become the way to learn who has an account. Kept in the deployment's
 * sign-in state (signInState.ts), so a lock earned on one instance holds on
 * the next.
 */
import { createHash } from 'node:crypto';
import { signInState } from './signInState.js';

/** Attempts an address may take in `WINDOW_MS` before it is locked. */
export const ATTEMPTS = 5;
const WINDOW_MS = 15 * 60_000;
/** The first lock; each further lock within a day doubles it. */
const LOCK_FIRST_MS = 30_000;
const LOCK_MAX_MS = 15 * 60_000;
const STRIKES_MS = 24 * 3_600_000;

/** What a locked address hears, whether or not an account has it. */
export const LOCKED_MESSAGE = 'Too many sign-in attempts. Wait a few minutes and try again.';

interface HookCtx {
  path?: string;
  body?: { email?: unknown };
  context: { returned?: unknown };
}

type ApiErrorClass = new (status: string, body: { code: string; message: string }) => Error;

/** The Better Auth plugin: a before hook that counts and refuses, an after hook that clears on success. */
export function signInLockoutPlugin(options: {
  appId: string;
  createAuthMiddleware: (handler: (ctx: HookCtx) => Promise<void>) => unknown;
  APIError: ApiErrorClass;
  now?: () => number;
}) {
  const { appId, createAuthMiddleware, APIError } = options;
  const now = options.now ?? Date.now;
  const keyOf = (ctx: HookCtx): string | undefined => {
    const email = ctx.body?.email;
    if (typeof email !== 'string' || !email.trim()) return undefined;
    return createHash('sha256').update(`${appId}\u0000${email.trim().toLowerCase()}`).digest('hex');
  };
  const matcher = (ctx: HookCtx) => ctx.path === '/sign-in/email';
  const refuse = (): never => {
    throw new APIError('TOO_MANY_REQUESTS', { code: 'TOO_MANY_ATTEMPTS', message: LOCKED_MESSAGE });
  };
  return {
    id: 'mistri-sign-in-lockout',
    hooks: {
      before: [
        {
          matcher,
          handler: createAuthMiddleware(async (ctx) => {
            const key = keyOf(ctx);
            if (!key) return;
            const lock = await signInState.read<{ until?: unknown }>('signin-lock', key);
            if (typeof lock?.until === 'number' && lock.until > now()) refuse();
            const attempt = await signInState.fail(`signin:${key}`, WINDOW_MS);
            if (attempt <= ATTEMPTS) return;
            const strikes = await signInState.fail(`signin-strike:${key}`, STRIKES_MS);
            const at = now();
            const until = at + Math.min(LOCK_MAX_MS, LOCK_FIRST_MS * 2 ** Math.min(strikes - 1, 20));
            await signInState.put('signin-lock', key, { until }, until, at);
            // The next window starts after the lock, with the attempts it allows.
            await signInState.clearFailures(`signin:${key}`);
            refuse();
          }),
        },
      ],
      after: [
        {
          matcher,
          handler: createAuthMiddleware(async (ctx) => {
            const key = keyOf(ctx);
            const returned = ctx.context.returned;
            if (!key || returned === undefined || returned instanceof Error) return;
            await signInState.clearFailures(`signin:${key}`);
            await signInState.clearFailures(`signin-strike:${key}`);
            await signInState.remove('signin-lock', key);
          }),
        },
      ],
    },
  };
}
