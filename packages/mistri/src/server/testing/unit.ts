/** Production App validation and injectable deterministic unit-test time. */
import { runTestMaintenance } from './worker.js';

/** Loads an authored App using the production loader and authority lock checks. */
export async function validateTestApp(
  directory: string,
  options: { environment?: Record<string, string>; allowedHosts?: readonly string[] } = {},
): Promise<{ id: string; name: string }> {
  return runTestMaintenance({ kind: 'validate', directory }, options.environment, options.allowedHosts);
}

/** A runner-independent fixture clock: inject now into your business functions. */
export function createTestClock(initial: string | number | Date = '2026-01-01T00:00:00.000Z') {
  const start = new Date(initial).getTime();
  if (!Number.isFinite(start)) throw new Error('Invalid test clock start.');
  let current = start;
  return {
    now: () => current,
    date: () => new Date(current),
    advance(milliseconds: number) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('Clock advance must be a finite nonnegative duration.');
      current += milliseconds;
      return current;
    },
    reset() {
      current = start;
    },
  };
}
