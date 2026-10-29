/**
 * Whether the live-engine blocks are allowed to skip.
 *
 * Every Postgres test in this suite is opt-in behind an environment
 * variable, which is the right trade locally — requiring a database server
 * to test a SQLite feature would make the suite something people stop
 * running. It was the wrong trade in CI, where nothing set those variables
 * and so the skip branch always fired, exited zero, and reported green.
 *
 * The tests that skipped are the load-bearing ones: the Postgres
 * `BEGIN READ ONLY` wrapper among them. "Green" meant the SQLite path worked.
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
  valkey: 'TABLEWALK_TEST_VALKEY',
  typesense: 'TABLEWALK_TEST_TYPESENSE',
} as const;

export function liveSkip(engine: keyof typeof VARIABLE, url: string | undefined, variable: string = VARIABLE[engine]): false | string {
  if (url) return false;
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
