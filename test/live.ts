/**
 * Whether the live-engine blocks are allowed to skip.
 *
 * Every Postgres and MySQL test in this suite is opt-in behind an environment
 * variable, which is the right trade locally — requiring two database servers
 * to test a SQLite feature would make the suite something people stop
 * running. It was the wrong trade in CI, where nothing set those variables
 * and so the skip branch always fired, exited zero, and reported green.
 *
 * The tests that skipped are the load-bearing ones: the MySQL two-step
 * read-only escape, written up as observed rather than theorised, and the
 * Postgres `BEGIN READ ONLY` wrapper. "Green" meant the SQLite path worked.
 *
 * So skipping is now a decision the environment makes explicitly.
 * `TABLEWALK_REQUIRE_LIVE=1` — which CI sets — turns a missing engine into a
 * failure instead of a skip, and the message says which variable is missing
 * rather than leaving someone to work out why a job that passes locally does
 * not pass here.
 */
/* The variable each engine is actually read from. Postgres's is `PG`, not
   `POSTGRES` — spelling it out from the engine name produced a message naming
   a variable that does nothing, which is a worse failure than no message. */
const VARIABLE = {
  postgres: 'TABLEWALK_TEST_PG',
  mysql: 'TABLEWALK_TEST_MYSQL',
  valkey: 'TABLEWALK_TEST_VALKEY',
  typesense: 'TABLEWALK_TEST_TYPESENSE',
} as const;

/* Engines whose live tests are paused: they still run where their variable is
   set, and skip by name elsewhere, even under TABLEWALK_REQUIRE_LIVE. MySQL was
   paused in 0.9.2 to keep the gate on Postgres, the engine Apps target; the
   adapter is still supported and its SQLite-shared paths still run. */
const PAUSED: ReadonlySet<keyof typeof VARIABLE> = new Set(['mysql']);

export function liveSkip(engine: keyof typeof VARIABLE, url: string | undefined, variable: string = VARIABLE[engine]): false | string {
  if (url) return false;
  if (PAUSED.has(engine)) return `${engine} live tests are paused (test/live.ts); set ${variable}=… to run them`;

  if (process.env.TABLEWALK_REQUIRE_LIVE === '1') {
    /* Thrown rather than returned. A skip reason is not a failure however it
       is worded, and the whole point here is that this run must not pass. */
    throw new Error(
      `${variable} is not set, and TABLEWALK_REQUIRE_LIVE=1 says these tests must run. ` +
        `Start a ${engine} server and point ${variable} at it.`,
    );
  }
  return `set ${variable}=… to run these`;
}
