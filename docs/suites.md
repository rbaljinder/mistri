# Suites: the detail behind the site page

The site's [Several Apps in one server](../site/src/content/docs/docs/suites.md)
(<https://mistriwork.dev/docs/suites/>) is the how-to. This file keeps the
contract it left out: the environment mapping, the grant and invitation
routes, and what each kind of App keeps when it is served in a suite. The code
is `packages/mistri/src/server/cli/suiteConfig.ts` and `packages/mistri/src/server/cli/suiteCommand.ts`.

## Environment

Each App's `environment` map names variables the operator has already set: the
left side is the name this App's runtime uses, the right side the name read
from the shell. Values are captured at startup; a missing one fails startup,
and no App changes the process environment. The map controls runtime
credentials; it does not let an App definition read the environment.

Without a suite `identity`, authentication needs an explicit `auth.store` or an
`XDG_CONFIG_HOME` mapping. SQL URL references and HTTP URL and header
references use the App's captured environment. The OS keychain, a credentials
file and database-driver defaults still use the machine's own configuration;
give explicit connection credentials when Apps use different accounts.

## Shared identity

The two SQLite paths (`store`, `grants`) are relative to the suite file and
must be separate from each other and from every business database, including
file aliases and SQLite sidecars. The suite provisions a new empty grants file
and refuses an unrecognized existing layout.

Or both are `postgres://` URLs, with `${NAME}` references read from the
operator's environment; one PostgreSQL and one SQLite is refused, naming both
settings. `store` is a PostgreSQL sign-in store, provisioned as an App's is
(`migratePostgresAuthStore`). `grants` is a database of its own that holds the
grants, preferences and authority history as the `mistri` schema's
`suite_grant*`, `suite_preference*` and `suite_authority*` tables (`packages/mistri/src/server/auth/suiteStoresPostgres.ts`); its flag
control may share it, nothing else may. An empty one is provisioned at start,
all three sets of tables or none, and a part of the set is refused. Both databases are
kept apart from each other and from every business connection, by URL and by
asking each server who it is, and a business database that holds one of the
suite's schemas is refused. Such a suite serves only Apps whose connections are
PostgreSQL: a SQLite business store fences its commands on a grant read in the
same turn, which a PostgreSQL read cannot be, so the start refuses rather than
denying each command later. Grants on PostgreSQL are read again before and
after each await, and a write fences at the last await before `COMMIT`, as an
App's PostgreSQL sessions do. Apps keep their own role
declarations, policies and tenant memberships, but use the suite identity
store instead of their own `auth.store`. There is no automatic conversion or
email-based linking of existing per-App accounts.

A provider's sign-in gives an account, never App access. An App whose roles
say `from` has its grant derived from the claims at each sign-in, recorded in
the grant audit as `provider:<name>`, and revoked when the claims no longer
give a role. A grant an administrator set by hand is the administrator's:
claims never widen or narrow it. Signing out ends the suite session; it does
not sign out at the identity provider. The callback is the suite's own,
`<basePath>/api/auth/callback/<name>`, whichever App's door the sign-in began
at.

Grants are read again on requests, and a revocation invalidates that App's
existing tenant contexts. A tenant App still requires its own membership after
the App grant. The audit record names the operator by the account's login name;
`--actor <name>` supplies one where the process has none (a container running
an arbitrary UID).

## Landing, deep links and sign-out

The bare suite address resolves, for a signed-in account: an explicit
`?app=<root>` (its grant only); a saved default App (revision above 0, `null`
meaning ask); `identity.landing`, first rule that holds; the root App if
granted; the only granted App; the chooser. A rule holds when the account's
current grant opens the App (the same strict check as every App: a malformed
grant opens nothing), it holds one of the rule's `roles`, and, for `member`,
the tenant App's own owner counts at least one active membership (the count the
Console's flag scopes read; no tenant data crosses). Startup refuses a rule
naming an App outside the suite, a role the App does not declare, `member` on
an App without tenants, or a default before the last rule.

A document navigation (GET or HEAD, `Sec-Fetch-Dest: document`, or `Accept`
naming `text/html` without it) to a private App's page, by a signed-in account
that App does not admit, is answered `302` to `<basePath>/_mistri/apps?next=`
and the request path. Private means no public read, public form, landing or
signed-out home. API, asset and `/_mistri` paths, password-reset returns
(`?reset`), signed-out visitors and public Apps are never redirected: the App
answers them as before. `next` is followed only when it is one path exactly as
a browser sends it (no scheme, `//`, backslash, control, `#`, dot segment or
encoded `/`, `\` or `.`), inside one deployed App's mount and not under a
server segment, and that App admits the account or is public; otherwise the
chooser names the App the account cannot open. Signed out, the chooser reloads
after sign-in so the server decides again.

Sign-out at any App's `api/auth/sign-out` ends the one native session, so every
App's projection and tenant context fails its next check. The chooser's sign-in
and sign-out write the same storage notice an App's do, so open App tabs lock.

## Grant and invitation routes

An App administrator can grant or revoke access only within their own App:
`POST <app-mount>/api/suite/grants` with the suite cookie, a same-origin
request and the `x-mistri-account` header. The body is
`{ "subjectId": "ACCOUNT_ID", "roles": ["reader"], "expectedRevision": 0 }`;
empty `roles` revokes. The target must already have a suite account. Grant and
audit row commit together, and a stale target or administrator revision
refuses the change. The route does not administer the suite's account store or
any other App.

To require the recipient's acceptance, `POST <app-mount>/api/suite/invitations/issue`
takes `subjectId`, `roles`, `expectedRevision` and `expiresAt` (epoch
milliseconds, at most seven days ahead) and returns a one-time token and an
`acceptUrl`. Only the bound account can accept, in the chooser. Issuing grants
nothing, and neither a matching email nor possession by another account does.
The token is stored as a hash and travels in the link's fragment. An invitation
refuses if expired, consumed or revoked, or if the target's or the issuer's
grant changed. Acceptance commits the grant, consumption and audit together.
`POST <app-mount>/api/suite/invitations/revoke` with `{ "id": … }` revokes a
pending one. A grant-management screen and email delivery are not provided.

`GET <basePath>/api/suite/apps` lists only currently granted Apps.

## Flags in the Console

Choose **App**, check the **environment**, then a **scope**. **Global** means
App-wide in that environment, not suite-wide; tenant scopes come through the
target App's membership owner. Every change needs a reason and the current
revision (compare-and-swap); revert writes a new audited revision. The shown
value is the control, not a per-person evaluation of targeting rules.

- **View only:** values and history, no mutation controls.
- **Manage only:** set and revert within the allowed type and variants; values,
  owner details and history stay private without `view`.
- **Kill only:** disable to the declared safe value; no history, no arbitrary
  value, no re-enable.

Console admission and another App's administrator role confer no flag powers;
tenant targets also need current membership in the tenant or platform realm.

## What each App keeps

Commands load from the App's `commands.ts`, `commands.mjs` or `commands.js`,
or the module `commands` names (as `serve --commands` does), with its authority lock and command journal; provision the journal first, since
startup attests it and does not migrate it. Each App keeps its own command
grants, row-policy checks and receipts, even when commands share a name.

A `directory` may be a `mistri build`'s output. It is served as built, as
`serve --app <build>` serves it: `commands`, `jobs` and `policy` must each name
the build's own entry (`server/commands.mjs` and so on), never the source's, and
an entry the build was made without is refused.

Jobs (`jobs` beside `config`) use that App's commands, service-principal grants
and captured environment; workers start only after every App is ready and the
suite listens, and shutdown drains accepted handlers before closing stores.

Tenant Apps need their tenant policy and provisioned tenant storage; sign-in,
membership selection and row contexts stay with the App's tenant runtime. Each
tenant command needs its policy's `resultReferences` extractor. Public intake
runs only under the App's enrolled `intake: { address }` policy, resolved on
every submission. Tenant administration, invitations and audited support use
the App's own policy and storage; map `MISTRI_AUDIT_KEY` in each supporting
App's environment. Tenant event-driven jobs keep the tenant job rules: active
anchors, service-principal grants, no scheduled tenant jobs, and no
event-emitting or lookup commands as handlers.

Public, keyed and saved forms keep their own keys (`MISTRI_FORM_KEY` from the
App's own `environment`), as do notifications, command events and effects,
machine timers, search and analytics. A cache named by any App holds every
App's public-form budgets and sign-in state, so instances of the suite share
them.

Definition changes require a restart; client source changes keep the shared
Vite development transport. Ctrl+C drains accepted requests and releases every
App's resources.
