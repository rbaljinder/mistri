/**
 * A sandbox's dev clock: how far ahead of real time a sandbox
 * reads, so its machine timers can be watched to the end in minutes rather
 * than days. Set by the operator (`mistri tenant clock`), kept on the
 * sandbox's own row (tenantSandboxStore.ts), and read only where the timer
 * sweep asks which sandboxes run ahead (tenantJobs.ts).
 *
 * It exists only on a sandbox. A live tenant has no row in the sandbox store,
 * so there is nothing to set and nothing the sweep can read for it, and the
 * deployment's own clock (tenantRuntimeClock.ts), which every lease and fence
 * reads, is never this one: a sandbox's skew moves which of its own records
 * are due, and nothing else.
 */
import type { SandboxClock } from './tenantSandboxStore.js';

/** The furthest a sandbox may read ahead: ten years. */
const SANDBOX_SKEW_MOST = 10 * 366 * 24 * 60 * 60 * 1000;
/** The fastest a sandbox's clock may run: an hour a second. */
const SANDBOX_RATE_MOST = 3600;

/** A clock as asked for, refused unless it is whole, ahead or level, and within bounds; `setAt` is now. */
export function captureSandboxClock(input: Readonly<{ skewMs: unknown; rate: unknown }>, now: number): SandboxClock {
  const { skewMs, rate } = input;
  if (typeof skewMs !== 'number' || !Number.isSafeInteger(skewMs) || skewMs < 0 || skewMs > SANDBOX_SKEW_MOST)
    throw new RangeError(`A sandbox clock reads ahead by 0 to ${SANDBOX_SKEW_MOST} whole milliseconds, never behind.`);
  if (typeof rate !== 'number' || !Number.isSafeInteger(rate) || rate < 1 || rate > SANDBOX_RATE_MOST)
    throw new RangeError(`A sandbox clock runs 1 to ${SANDBOX_RATE_MOST} times as fast as real time, in whole steps.`);
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('The clock is set at a real instant.');
  return Object.freeze({ skewMs, rate, setAt: now });
}

/** How far ahead of `realMs` the sandbox reads: its skew, plus what its rate has gained since it was set. */
export function sandboxSkew(clock: SandboxClock, realMs: number): number {
  const gained = Math.max(0, realMs - clock.setAt) * (clock.rate - 1);
  return Math.min(SANDBOX_SKEW_MOST, clock.skewMs + gained);
}
