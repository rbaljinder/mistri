/**
 * A server or a database a spec starts once for its worker, as a worker-scoped
 * fixture with a timeout of its own (`FIXTURE_MS`). A `beforeAll` takes its
 * budget from the test and needs `test.setTimeout` inside it, which is how a
 * file came to hold a two-minute number for a fixture that starts in ten
 * seconds; this one is never paid out of a test's time.
 *
 *   const test = base.extend<object, { started: void }>({
 *     started: fixture(async () => { ...start... }, async () => { ...stop... }),
 *   });
 *
 * It is `auto`, so it runs for the worker's first test whether or not a test
 * names it, and stops when the worker does — as `beforeAll`/`afterAll` did.
 */
import { FIXTURE_MS } from './budgets';

export function fixture(start: () => Promise<void>, stop?: () => Promise<void>) {
  return [
    // Playwright reads the first parameter's destructuring to see which fixtures it asks for; there are none.
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use: () => Promise<void>) => {
      try {
        await start();
        await use();
      } finally {
        await stop?.();
      }
    },
    { scope: 'worker' as const, auto: true, timeout: FIXTURE_MS },
  ] as const;
}
