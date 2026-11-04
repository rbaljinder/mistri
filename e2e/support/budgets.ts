/**
 * The only timeouts above a minute a spec may set (`scripts/e2e-lanes.mjs`
 * refuses a literal, and a `beforeAll` that sets one). A named constant says
 * what the time is for; a number says nothing about whether it is still true.
 *
 * Most specs need none: the runner's default is 20 s (40 s on CI), a test
 * that is only slow says `test.slow()` (three times that), and a fixture that
 * takes a while to start is a worker-scoped fixture (`fixture()` below, or
 * `support/ownServers.ts`) with its own `timeout`, which no test's budget pays.
 */

/** A server or fixture started once for a worker: a child process, a database seeded, a first request answered. */
export const FIXTURE_MS = 120_000;
/** A test that is slow for a reason it can name: a walk through several rooms, a long write storm, a built host. */
export const SLOW_MS = 90_000;
/** One that walks a whole App's rooms in a single test. */
export const LONG_MS = 120_000;
/** One that drives a child process it starts itself (a shot, a grade run). */
export const SHOT_MS = 150_000;
/** One that tours an App from sign-in to its last room. */
export const TOUR_MS = 180_000;
/** One that builds something first: `mistri build`, a bundled embed host. */
export const BUILD_MS = 240_000;
