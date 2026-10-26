---
title: Testing workflow
description: Run an App's tests from the edit loop to a release, in five layers, locally and in CI, keeping every failure's evidence.
---

Run an App's tests from the edit loop to a release, in five layers, locally
and in CI, keeping every failure's evidence.

```sh
node --import tsx --test 'tests/**/*.test.ts'                # unit, API, services, authorization
npx playwright test --config tests/playwright.config.ts      # browser, desk and phone
```

<!-- no picture: a test run prints pass and fail lines. -->

## Start from the scaffold

Copy `examples/testing`
into the App's repository as `tests/`, install `@mistriwork/mistri`, `tsx` and
`@playwright/test`, and point it at your App. Lintel's suite (`examples/apps/lintel/tests`)
is a complete one to read. Every file imports
only the package's public exports, Node, Playwright and `pg`.

| Layer | What it proves | In the scaffold |
| --- | --- | --- |
| Unit | Your pure functions and the App's load, with `createTestClock` and `validateTestApp` | `lintel/tests/ledger.test.ts` |
| API | Commands and reads over HTTP, one `host.client()` per person | `lintel/tests/maintenance.test.ts` |
| External service | Calls in and out against a [virtual service](/docs/service-virtualization/) | `lintel/tests/integrations.test.ts` |
| Browser | Forms, sign-in, a phone layout, a [suite](/docs/suites/) journey | `lintel/tests/portal.spec.ts`, `examples/testing/suite.spec.ts` |
| Authorization | Every role, signed out, wrong App, with `assertAuthorizationMatrix` | `lintel/tests/permissions.test.ts` |

## Fixtures

Each test owns a workspace: a temporary directory, its databases, its server on
a port the system picks, and its virtual services. Register `close` the line
after creating it (`t.after`, or the `finally` of a Playwright fixture), and hand
each service to `workspace.own`; cleanup runs in reverse. Nothing is shared
between tests, so files run in parallel.

## Secrets and environment

The App process inherits nothing but `PATH`: pass each variable in
`environment`. A test secret is a literal written for the test, and the session
secret is random per host. Real provider keys never belong in a test; a call to
any host but loopback fails it unless `allowedHosts` names that host.

## Choosing what to run

| While editing | Before a release |
| --- | --- |
| One file: `node --import tsx --test tests/orders.test.ts` | Every test file |
| One test: `--test-name-pattern 'viewer'`, or Playwright `-g 'checkout'` | Both Playwright projects |
| One project: `--project=desktop` | the PostgreSQL suite |

## CI

On SQLite alone:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: node --import tsx --test 'tests/**/*.test.ts'
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test --config tests/playwright.config.ts
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: traces, path: test-results/, retention-days: 7 }
```

With PostgreSQL, add a service; each test creates a database of its own from
the administrator URL and drops it at close:

```yaml
    services:
      postgres:
        image: postgres:17
        env: { POSTGRES_PASSWORD: postgres }
        ports: ['5432:5432']
        options: --health-cmd pg_isready --health-interval 5s --health-retries 20
    env:
      MISTRI_TEST_PG: postgres://postgres:postgres@127.0.0.1:5432/postgres
```

## Durations and failures

Node prints each test's time and the run's `duration_ms`; add
`--test-reporter=junit --test-reporter-destination=junit.xml` for CI. Playwright's
list reporter prints each test's time and names the slowest files.

The scaffold sets `retries: 0`. A failed browser test keeps its trace and
screenshot under `test-results/` (open one with `npx playwright show-trace`), and
CI uploads them. A matrix reports every failing row by name, not the first. A
test that fails only sometimes is a bug to find with `--repeat-each=20`, never a
retry to hide.

## Related

- [Test an App](/docs/testing-apps/): the helpers this page runs.
- [Fake external services](/docs/service-virtualization/): virtual providers and callbacks.
- [Build an App with a coding agent](/docs/build-with-an-agent/): the evidence a finished App reports.
