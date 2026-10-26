---
title: Test an App
description: Start your App on a disposable database in a test, sign in as several people, and assert who may read and do what.
---

Start your App on a disposable database in a test, sign in as several people,
and assert who may read and do what.

```ts title="examples/apps/lintel/tests/start.ts"
    const app = await workspace.copy(appSource, 'app');
    // …
    const host = await startTestApp({
      workspace,
      directory: app,
      config: `${database}.json`,
      // Named as production names them; a relative module is the App directory's.
      args: ['--jobs', 'jobs.ts', '--policy', 'policy.ts'],
```

See it in the sample (`examples/apps/lintel/tests/start.ts:44`): Lintel's suite copies the App into a disposable workspace, seeds a database and starts it with its jobs and row policy, as production does.

`npx @mistriwork/mistri test init .` writes a starting suite on these helpers: a
journey per role, each job at times run once, and a permissions matrix from
`authority.lock`. A row-policy App is served with the `policy.ts` and
`jobs.ts` beside its `app.ts`, and its matrix holds the reads and refusals,
since where a granted write lands is the policy's to say. The tests import
`node:test`, and TypeScript 7 reads no `@types` package the tsconfig does not
name: `test init` adds `"types": ["node"]` to a plain `tsconfig.json` (the
scaffold writes it there already) and says when `npm install --save-dev
@types/node` is still to do. A command step whose question only you can
answer (a pattern, say) is skipped and named; pass it with
`act(table, action, { input })`.

<!-- no picture: a test run prints pass and fail lines; there is nothing on screen. -->

## A first test

```ts title="tests/access.test.ts"
import { test } from 'node:test';
import { createTestWorkspace, startTestApp, assertAuthorizationMatrix } from '@mistriwork/mistri/testing';

test('the App starts on a disposable database', async t => {
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const app = await workspace.copy('./app', 'app');
  const database = await workspace.database('business.db', db => {
    db.exec('CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT)'); // your migrations and seed
  });
  const host = await startTestApp({ workspace, directory: app, database });
  // host.client() has its own cookie jar: signUp({ name, email, password }) for each person
  await assertAuthorizationMatrix([
    { name: 'ready', client: host.client(), path: '/readyz', status: 200 },
  ]);
});
```

```sh
node --import tsx --test tests/*.test.ts
```

## What you'll see

- A real mistri process per test, on an OS-chosen port and a temporary
  directory, stopped and deleted when the test ends.
- Every row of an authorization matrix run, with all failures reported
  together by case name.
- A test that fails when App code reaches a host other than loopback, even if
  the code catches the error.
- The host listens on loopback with the per-address sign-in limits lifted, so
  a suite can sign in as often as it likes; the per-account lockout stays.
  Pass `MISTRI_TEST_AUTH_LIMITS: 'on'` in `environment` to test the limits.

## When to use it

- Use `@mistriwork/mistri/testing` for anything that crosses the server: sign-in,
  grants, commands, row and tenant boundaries.
- Use [service virtualization](/docs/service-virtualization/) beside it when
  the App calls an HTTP provider.
- Use Playwright for what only a browser has: SameSite cookies, navigation,
  layout. `examples/testing` has a fixture that owns its host the same way.

## Options

| Helper | Does |
| --- | --- |
| `createTestWorkspace()` | A temporary directory that owns cleanup: `copy`, `write`, `database`, `own(close)`, `path` |
| `startTestApp({ workspace, directory, database, config?, args?, environment?, assistant? })` | Starts the production CLI on the App, with your config, policy, commands and jobs. A relative `--policy`, `--commands` or `--jobs` in `args` is the App directory's. A `database` without a `config` is writable when the App writes, and a SQLite file from outside the workspace is served as a copy. `assistant` is a script the in-App assistant answers from instead of a model: `{ turns: [{ when, steps: [{ text, tools }] }] }` |
| `host.seed(table, row \| rows)` | Inserts rows as a test's setup, past grants and the row policy, as a seed script would; the rows come back with their ids |
| `host.runJob(name)` | Runs a job at times now, as its service, and waits for its attempt: `{ state, code }` |
| `startTestSuite({ workspace, configuration, environment })` | The same for a [suite](/docs/suites/); `grant(...)` goes through the real grant path |
| `host.client()` | A client with its own cookies: `signUp({ name, email, password })`, `signIn`, `signOut`, `request(path, { method, json, headers })` |
| `workspace.copyConfig(file)` | A copy of a `mistri.json` and every SQLite file it names, for `config` |
| `host.as(role)` | A client signed in to an account holding that role, made through the App's accounts API. Its email is `<role>@example.test`: where a row policy or `auth.me` finds a person's row by email, seed that row first, `host.seed('vendor', { name: 'Probe Plumbing', email: 'vendor@example.test' })` |
| `client.update(table, key, values)`, `client.command(name, key, input)`, `client.act(table, action)` | The request the browser sends; a result, never a throw: `{ ok: true, value }` or `{ ok: false, status, code, message }`. `act` runs the action on a record it is offered on — a command's own `when` asked of the server — trying the next where its handler refuses one, and answers `no_record` where none is |
| `client.rows(table, { where })`, `client.open(view)`, `client.views()` | Rows as the query bar reads them; a page with its first reads; the role's home and menu |
| `assertPermissions(host, cases)` | Each case: `role`, `read`, `write` or `command` (`on` its table), and `allowed`. A refused read is answered as a table that is not there, so it does not say the table exists; a refused write or command, 403; signed out, 401 |
| `assertAuthorizationMatrix(rows)` | Each row: `name`, `client`, `path`, expected `status`, optional `request` and `inspect` |
| `validateTestApp(dir)` | Loads the App and checks `authority.lock`, without a database |
| `createTestClock(initial)` | `now`, `date`, `advance`, `reset` for your own business functions |
| `settled(page, { quietMs?, timeout? })` | In a Playwright test, waits until no request has been in flight for 400 ms. The live-sync stream and other event streams are not counted. Use it before a screenshot or an assertion on a whole page |

## Tenant Apps

A [tenant App](/docs/tenant-apps/) is tested through the same doors as its
people: `host.tenant(id, { roles })` is a member signed in and working in one
tenant, and `host.platform({ roles })` a platform member. Each makes a new
account and its membership as the operator would (the tenant made active when
it is not there), then holds a lease the way the browser does. Your test names
tenants and roles; the lease, its headers and the maintenance steps are the
kit's.

```ts title="tests/tenants.test.ts"
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestWorkspace, startTestApp } from '@mistriwork/mistri/testing';

test('each clinic sees its own appointments, and never another clinic', async t => {
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  // Your tables and rows in a database, its stores made by `mistri migrate stores up --app . --policy …`.
  const config = await workspace.write('mistri.json', { connections: [{ name: 'clinic-db', url: database, writable: true }] });
  const host = await startTestApp({
    workspace, directory: '.', config,
    args: ['--policy', 'server/tenant-policy.ts', '--commands', 'commands.ts'],
  });
  const north = await host.tenant('north', { roles: ['reception'] });
  const south = await host.tenant('south', { roles: ['reception'] });

  const rows = await north.rows('appointment');
  assert.ok(rows.ok && rows.value.length > 0);
  // Another tenant's record is not found, exactly as one that does not exist.
  const theirs = await north.record('appointment', { id: 'ap-south-1' });
  assert.equal(theirs.ok ? undefined : theirs.code, 'not_found');
  // Their command on it is refused before anything is written.
  assert.equal((await north.prepare('recordPayment', { id: 'ap-south-1' })).status, 403);
  // A membership is of one tenant.
  assert.equal((await north.enter('south')).status, 403);
  assert.ok((await south.rows('appointment')).ok);
});
```

| Helper | Does |
| --- | --- |
| `host.tenant(id, { roles, email?, name? })` | A new member of tenant `id` with those roles, signed in, working in its lease. The roles are held to the tenant realm, as an operator's grant is |
| `host.platform({ roles })` | A new member of the platform realm, working in it: the reads its policy's `resolvePlatformRows` allows and its platform commands |
| `member.record(table, key)` | Whether the member reaches one record: `ok`, or `not_found` for another tenant's and for none at all, never told apart |
| `member.enter(id)` | Asks for another tenant's lease (or `@platform`) under the same sign-in: what the server answers. The client keeps its own lease |
| `member.support(id, { role, reason })` | A platform member's [support visit](/docs/tenant-apps/) into one tenant, read-only in the role assumed: a client on the visit's lease, with `visit` and `exit()` |
| `member.account`, `member.lease` | The account made for the member (its email and password) and the lease the server granted |

Every other client helper (`rows`, `command`, `prepare`, `update`, `act`)
works on a member as it does on `host.as(role)`, under the member's lease.
`npx @mistriwork/mistri test init .` on a tenant App writes `tests/tenants.test.ts`:
for two tenants of its database (`MISTRI_TEST_TENANTS=<id>,<id>` picks
them), each resource a tenant owns, each command a tenant role runs, and each
platform role's reads. Run it with the `MISTRI_AUDIT_KEY` your stores were
made with when the policy has `support`.

## Common mistakes

- `Unexpected outbound connection in isolated App test` → the App reached a
  real host; start a virtual service, or pass `allowedHosts` for a
  deliberate contract test.
- Tests pass alone and fail together → a copied App still names an absolute
  database, auth or job path; point each at the workspace.
- Every matrix row passes, including the wrong ones → add one deliberate wrong
  expectation under `assert.rejects` to prove the matrix detects a defect.
- A tenant test passes for the wrong tenant → make members with
  `host.tenant(id, { roles })`; `host.as(role)` is an App grant, not a
  membership.

## Related

- [Testing workflow](/docs/test-workflow/): the layers, commands, CI recipes and an optional security scan.
- [Service virtualization](/docs/service-virtualization/): fake the HTTP providers an App calls.
- [mistri check](/docs/check-codes/): what to run before the tests.
- [Several Apps in one server](/docs/suites/): what `startTestSuite` starts.
- `examples/testing`: a Node test and Playwright fixtures for an App and a suite.
- Lintel's tests (`examples/apps/lintel/tests`): the full set on a real App, with every grant as a matrix, a test clock, a signed payment callback and browser journeys.
