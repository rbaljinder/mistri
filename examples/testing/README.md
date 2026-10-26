# Authored App testing scaffold

Copy these files into an App repository using Node 24+. Install `@mistriwork/mistri`,
`tsx`, and `@playwright/test`, then run:

```sh
node --import tsx --test app.test.ts
npx playwright install chromium
npx playwright test --config playwright.config.ts
```

Every file uses only the package's public exports (`test/example-tests-public.test.ts`
holds that). Each test owns a temporary SQLite file, App directory, independent
host and cleanup. The browser scaffold runs every spec on a desk and a phone,
keeps a trace and a screenshot of a failure, and never retries one. The
[testing workflow](https://mistriwork.dev/docs/test-workflow/) page covers test
selection, CI and an optional security scan.

| File | Shows |
| --- | --- |
| `app.test.ts`, `app.spec.ts` | The smallest App, started for an API test and a page |
| `suite.spec.ts` | Shared suite login: `identity.landing` rules, the chooser, one sign-in across two Apps, signing out of both |
| `playwright.config.ts` | Desk and phone projects, a trace and a screenshot kept on failure, no retries |

Replace the sample App with a copy of your own. Run your migration and seed
functions inside `workspace.database`, inject virtual service URLs through
`startTestApp({ environment })`, and register each service's `close` with
`workspace.own` immediately after starting it. Do not copy an active database
or point test configuration at production storage.

A started host also arranges what a test needs without a person's grant:
`host.seed(table, rows)` inserts setup rows in one transaction and returns them
with their ids, and `host.runJob(id)` runs a job at times once now, as its next
slot would, resolving with how it ended. Assert through `host.as(role)`, which
asks what that person is allowed. `startTestApp({ assistant })` gives the in-App
assistant a script of turns (its text and tool calls) in place of a model, so a
test of it never reaches the network.

For suites use `startTestSuite({ workspace, configuration, environment })` with
explicit test-owned identity/grant/auth/database paths. Create accounts with
`host.account`, give them App roles through `host.grant`, and test shared
sign-in, cross-App navigation and grant revocation. Tenant memberships must be
seeded by the App's own supported maintenance code; App roles do not imply
tenant membership.

## A full suite: Lintel's

[`examples/apps/lintel/tests/`](../apps/lintel/tests/) is the layered reference
for an App of real size, and it ships with the package. It is written on
`@mistriwork/mistri/testing` alone, one file to a layer:

| File | Layer and what it proves |
| --- | --- |
| `permissions.test.ts` | Authorization: every role by resource and command as `authority.lock` says, and a resident's household and nothing else |
| `ledger.test.ts` | API and workflow: rent posted once however often asked, a payment, the late-fee workflow on a test clock |
| `maintenance.test.ts` | API: a repair's visit, parts off the shelf, the resident mailed or not by their consent |
| `portal.test.ts` | API: a resident's home, a problem reported, a neighbor's repair refused |
| `integrations.test.ts` | Virtual service: the processor's signed callback applied once, replayed, forged and wrong ones refused |
| `*.spec.ts` | Browser: the public listings and viewing request, the staff desk, the resident portal on a phone |

`start.ts` is its fixture: it copies the App, seeds a fresh database with the
App's own seed, serves it with its `--policy`, `--commands` and `--jobs`
modules, and makes an account per role through the App's accounts API. In your
repository, point it at your App and its seed.
