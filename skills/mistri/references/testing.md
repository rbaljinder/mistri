# Testing an App, in five layers

Tests import `@mistriwork/mistri/testing` and nothing from mistri's `src/`. Start
with `npx @mistriwork/mistri test init .`: it writes `tests/` (a journey per role and a
permissions matrix from `authority.lock`, run with `node --test 'tests/*.test.ts'`)
on the kit's helpers, so no test hand-writes a request. `host.as(role)` signs a
role in; on the signed-in client, `.update(table, key, values)`,
`.command(name, key, input)` and `.act(table, action)` return a result, never
throw: `{ ok: true, value }` or `{ ok: false, status, code, message }`, and
`assertPermissions` checks a role × resource and command table. `host.seed(table, rows)`
arranges rows as setup (past grants, ids returned), `host.runJob(name)` runs a job at
times now, `startTestApp({ assistant })` scripts the in-App assistant, and `startTestApp({ decisions })` the model a decision asks. Then add what the
App's own journeys need; Lintel's `tests/` (`../../../examples/apps/lintel/tests/`, shipped beside it) is
the worked example, with a file for each layer below; `mistri docs test-workflow` has the commands, CI
recipes and the optional security scan, `mistri docs testing-apps` the helpers.

The tests need Node's types: `npm install --save-dev @types/node` and
`"types": ["node"]` in `tsconfig.json` (the scaffold and `test init` write
the second; TypeScript 7 loads no `@types` package unnamed). `host.as(role)` is
`<role>@example.test`; under a row policy that finds a person's row by email
(`auth.me`), seed that row with that email before the role reads anything.

| Layer | Use | Proves |
| --- | --- | --- |
| Unit | `node:test`, `createTestClock`, `validateTestApp` | Pure rules and mappings; the App loads and matches `authority.lock` |
| API | `startTestApp` (or `startTestSuite`), one `host.client()` per person | Commands, refusals, stale submissions, receipts, over HTTP |
| External service | `startService(defineService(...))`, its URL in `environment` | Calls out and signed callbacks in, without a real host |
| Browser | Playwright, desk and phone projects, `retries: 0`, traces kept | Forms, sign-in, layout; never authorization |
| Authorization | `assertAuthorizationMatrix` | Every role, signed out, wrong App, wrong tenant; refused rows changed nothing |

## Rules

- Each test owns its workspace, database, host and services; register
  `close` immediately. Never point a test at an existing database.
- Pass every variable in `environment`; a test secret is a literal made up for
  the test. A call to any non-loopback host fails the test: fake it.
- Make accounts as the App does (its accounts API as an administrator, or
  `host.account` and `host.grant` in a suite), never by writing the auth store.
- Readiness is something visible (a heading, a row), never a sleep.
- Prove the suite can fail: one deliberately wrong matrix row under
  `assert.rejects`, and a broken copy of the App (a role granted too much, a
  callback keyed wrongly) that turns the owning test red.
- A failure is evidence: keep its trace, do not retry it until it passes.
- A security scanner's pass proves nothing beyond the patterns it checks;
  report it as a scan, never as "secure".

## Report

The command and exit status of each layer, the counts (pass, fail, skipped),
what was not tested and why (a PostgreSQL-only suite without
`TABLEWALK_TEST_PG` is skipped, not passed).
