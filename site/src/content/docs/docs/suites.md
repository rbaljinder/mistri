---
title: Several Apps in one server
description: Serve several independently configured Apps from one process, each with its own connections and grants, optionally behind one sign-in.
---

Serve several independently configured Apps from one process, each with its own connections and grants, optionally behind one sign-in.

```json title="suite.json"
{
  "port": 4880,
  "apps": [
    { "id": "lender", "directory": "./lender", "config": "./lender-connections.json", "mount": "/",
      "environment": { "BETTER_AUTH_SECRET": "LENDER_AUTH_SECRET", "DATABASE_URL": "LENDER_DATABASE_URL" } },
    { "id": "dealer", "directory": "./dealer", "config": "./dealer-connections.json", "mount": "/dealer",
      "policy": "./dealer/policy.ts",
      "environment": { "BETTER_AUTH_SECRET": "DEALER_AUTH_SECRET", "DATABASE_URL": "DEALER_DATABASE_URL" } }
  ]
}
```

```sh
npx @mistriwork/mistri suite suite.json      # http://127.0.0.1:4880/
```

<!-- no picture: each App looks as it does alone; the suite adds an App chooser only with shared identity. -->

## What you'll see

- Each App at its `mount`, answering as it does alone: its own grants, row policy, commands, jobs and receipts.
- With a suite `identity`, one sign-in across Apps and a chooser at `/_mistri/apps` listing only the Apps the account is granted.
- After sign-in, the suite's address takes each account to its App ([below](#where-people-land)).
- A refusal at startup, naming the App and the reason, for anything a suite cannot serve safely.

## When to use it

- Use a suite for a family of Apps that share a host: a desk app, a partner portal, a public site.
- Use one server per App when each scales or deploys on its own ([build and deploy](/docs/build-and-deploy/#where-an-app-is-served)).
- Use `--app` twice on one server when the Apps share one config and neither signs people in.

## Options

| Key | Does | Default |
| --- | --- | --- |
| `apps[].id`, `directory` | The App, relative to the suite file; `id` must match the App's. A [build](/docs/build-and-deploy/) is served as built | required |
| `apps[].config` | A file holding only `connections`, in the [usual format](/docs/services/#connections) | required |
| `apps[].mount` | Where it is served; one App may take `/` | required |
| `apps[].environment` | This App's variable → the shell variable it is read from; captured at start | none |
| `apps[].commands` | Its commands module, as `serve --commands`; for a build, its own `server/commands.mjs` | `commands.ts` beside the App |
| `apps[].policy`, `jobs` | The row or tenant policy (required when `auth.rows` is `policy` or `tenant`), and a jobs module | none |
| `identity` | One account and sign-in across Apps (below) | each App signs in alone |
| `port`, `basePath` | The listener, on `127.0.0.1` | `4111`, none |

## One account across Apps

Add a top-level `identity`, and set `SUITE_AUTH_SECRET` before starting:

```json
"identity": {
  "id": "keystone", "name": "Keystone",
  "store": "./runtime/identity.db", "grants": "./runtime/app-grants.db",
  "environment": { "BETTER_AUTH_SECRET": "SUITE_AUTH_SECRET" }
}
```

To keep nothing on the suite's disk, make `store` and `grants` two separate `postgres://` databases (a `${NAME}` is read from the environment):

```json
"store": "${SUITE_IDENTITY_URL}", "grants": "${SUITE_GRANTS_URL}"
```

Provision the identity database once with `migratePostgresAuthStore(url)` from `@mistriwork/mistri/maintenance`; the grants database is set up at the first start. Every App in such a suite must use PostgreSQL connections too.

`identity` also takes `providers` (default `["email"]`), `signUp` (default `"open"`), `services`, the `oidc` and `saml` connections the providers name ([identity providers](/docs/identity-providers/)), and `landing`. An App's own `auth.providers` must be among the suite's.

A new account has **no App access**. Its account ID shows in the chooser; grant each App's first administrator from the command line, passing the current revision so an old command never overwrites a newer grant:

```sh
mistri suite grant suite.json --app lender --subject ACCOUNT_ID --roles admin --revision 0
mistri suite revoke suite.json --app lender --subject ACCOUNT_ID --revision 1
```

The subject is an account ID, never an email. A grant in one App gives nothing in another. After that, an App's administrator grants and invites within that App.

### Where people land

`landing` sends a signed-in account from the suite's address to the first App whose rule it meets: a role it holds there, or (`"member": true`) a membership in one of a tenant App's tenants. A rule with neither is the default, last.

```json
"landing": [
  { "app": "lender", "roles": ["underwriter", "funder"] },
  { "app": "leads", "member": true },
  { "app": "customer" }
]
```

An account's own saved default App comes first. With no rule met: the root App, if the account has it; the only App it has; else the chooser.

A link into an App survives sign-in at that App's door. A page of an App the account was not granted opens the chooser, naming that App. Only a suite App's page is followed, never another site, an API or the chooser. Signing out of any App signs out of all of them.

## Flags and Console

> **Preview.** The Console (targeting, rollouts, the Operations and Analytics rooms and Governance) and feature flags work as documented and may change in any 1.x release. See [status](/docs/status/).

With shared identity, add a flag control store and the Console:

```json
"flags": { "store": "postgres://localhost:5432/mistri_flags", "environment": "production",
  "deploymentId": "keystone-production" },
"console": { "enabled": true }
```

```sh
mistri flags provision --suite suite.json          # once, before serving
mistri migrate stores up --suite suite.json         # after an upgrade
mistri suite grant suite.json --app mistri-console --subject ACCOUNT_ID --roles admitted --revision 0
```

The control store is its own database; serving only attests it. Open `http://127.0.0.1:4880/_mistri/console`. `admitted` opens the shell only: the account also needs a role with scoped `flags` capabilities in the target App ([feature flags](/docs/dsl-flags/#feature-flags)). The Console reads, sets, kills and reverts flags, with a reason and the current revision on every change, and runs [experiments](/docs/experiments/). Edits are staged and reviewed as a list before they apply. ⌘K (Ctrl K) jumps to a flag, a job, an App or a room; j and k move through a list.

### Operations and Analytics rooms

The **Operations** and **Analytics** rooms answer App by App from that App's own `operations` grant, never from Console admission:

```ts
operator: { read: true, operations: ['jobs', 'deliveries', 'workflows', 'stores', 'analytics'] },
```

- `'jobs'` and `'deliveries'`: one list of work, opened on what needs attention; a row shows its attempts, and dead work can be redriven.
- `'workflows'`: instances and their steps, with cancel and retry.
- `'stores'`: each store's layout version and any upgrade pending. Databases are named, never addressed.
- `'analytics'`: events by day, simple breakdowns and the App's declared funnels. Read-only, counts only: no email, IP, field value or visitor id.

Every change records the signed-in account as its operator, and a grant revoked mid-session refuses the next change. Tenant Apps are not listed yet.

### Governance room

**Governance** opens for an account holding the App's own `admin` role, and changes nothing:

- **Audit log**: every command from the App's journal — who, when, which record (linked) and which fields changed, never their values — and every role change. Search by email or account id, command or resource, and dates.
- **Authority**: the App's authority.lock as sentences ("Role `agent` can update `incident.state`"), grouped by role, and what changed since the App last started with a different one.
- **Accounts**: who holds which role, and every change to it. Roles are changed on the suite's access page, which it links to.

A tenant App opens here for an account its own tenant `administration` grants, and only to **Accounts**: the tenants that grant names and the members whose roles it reaches. Members and **Support sessions** are changed in the App itself; the room links to both.

## What a suite refuses

| Refused at startup | Why |
| --- | --- |
| A tenant App at `/` with shared identity | It would answer the suite's sign-in and chooser routes |
| `api` with shared identity, `publicOrigin` or `hosts`, or on a tenant App | API tokens live in an App's own sign-in store, and a suite serves the API on loopback only |
| An App's own `oidc` or `saml` service, or a provider the suite does not list | The suite's sign-in is the only one |
| Two Apps naming different caches | One budget and one lockout per person |
| App analytics beside suite analytics, or on a tenant App | One analytics owner per App |
| Jobs on a row-policy App | Its row policy owns the App's commands |

## Common mistakes

- `environment variable LENDER_AUTH_SECRET is not set` → the right side of `environment` names a shell variable; export it before starting.
- A signed-in account sees no Apps → a new account has no access; grant it with `mistri suite grant`.
- A `landing` rule never matches → the account needs a current grant in that App; a rule's `roles` are that App's role names, checked at startup.
- `mistri suite grant` refuses a stale revision → pass the revision the last change printed.
- The suite refuses to start on a command journal or flag store → provision stores first; serving only attests them.

## Related

- [Build and deploy](/docs/build-and-deploy/): one App per server, behind a proxy.
- [Identity providers](/docs/identity-providers/): `oidc` and `saml` sign-in and roles from claims.
- [Experiment analytics](/docs/experiments/): evidence the Console reads.
- [Test an App](/docs/testing-apps/): `startTestSuite` for a disposable suite.
