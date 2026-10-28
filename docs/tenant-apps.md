# Tenant App startup

mistri supports explicitly enrolled tenant Apps on one existing SQLite
database or one existing PostgreSQL database. Tenant Apps are stable since
1.0, inside the compatibility promise (`compatibility.md`). What is public:

| Part | State |
| --- | --- |
| `--policy` tenant startup and `mistri check` | Stable |
| Tenant administration (operator policy, **Account → Manage tenants**) | Stable |
| Provisioning the SQLite tenant store, administration journal, invitation storage and event store | Stable: maintenance steps in `@mistriwork/mistri/maintenance` ([provisioning](#provisioning)) |
| Tenant Apps on PostgreSQL: startup, reads, writes, commands, administration, invitations, events and their maintenance steps | Stable ([below](#tenant-apps-on-postgresql)) |
| Account-bound invitations (SQLite or PostgreSQL) | Stable ([invitations](#account-bound-invitations)) |
| Tenant command events: a registry that declares events (SQLite or PostgreSQL) | Stable ([events](#tenant-command-events)); `--jobs` runs beside `--policy`, and effects are delivered per tenant |
| Public intake: a tenant App's public forms, placed by an intake address the server resolves | Stable ([below](#public-intake)) |
| Public reads: a visitor browses one tenant's public rows by its public address or mapped host | Stable ([below](#public-reads)) |

What a tenant App still refuses is listed on the status page ("Still
refused"). The ordinary database browser and non-tenant Apps remain
independently launchable.

## Authoring and running

Keep the App and pages in the TypeScript DSL. Set `auth.rows: 'tenant'`, with
native `auth`, one named `sources` entry for its own data (further entries may
declare the platform realm, and only the platform context reads those),
resource `access` and `fields` ceilings, and role grants in `auth.roles`:

```ts
sources: { business: { connection: 'business-db' } },
resources: { dealer: {}, lead: { access: 'write' } },
auth: {
  rows: 'tenant',
  roles: { reviewer: { read: true, write: ['lead'] }, viewer: { read: true } },
},
```

Tenant membership roles choose which of those grants apply; global account
roles do not. `auth.rows` is one word, so a tenant App is never also a
row-policy App. A server-only `defineAppTenantPolicy` from `@mistriwork/mistri/policy` declares
the matching App/store identity, complete logical-resource ownership and row scopes.
Its callbacks cannot replace native authentication or the membership store.
The site's Tenant Apps page carries a whole policy with every part, and a
reference of each key's type, default and limit, which
`test/tenant-policy-reference.test.ts` holds to this validator.

With opaque record keys, the non-key ownership column is managed privately:
omit it from forms, displayed fields and queries. The framework injects it on
creation and excludes it from public read/write responses, even with broad field
grants. Ordinary required columns still need authored inputs or real database
defaults. Existing composite keys that include ownership must remain fully
readable and non-writable; hiding a PK component is not supported and does not
turn the remaining columns into a new key.

A composite foreign key that carries the ownership column —
`FOREIGN KEY (tenant_id, team_id) REFERENCES team (tenant_id, id)`, the shape
that makes "a ticket's team is its own tenant's" a constraint — is a link in the
tenant realm all the same. The tenant's catalog has no `tenant_id`, so the
composite key leaves it; its other leg stays a reference (`team_id` → `team`)
when the target column is unique alone, the other legs are `NOT NULL`, and the
column has no reference of its own. The leg is named by what it joins, never by
the constraint, whose name usually spells the ownership column. A reader that
sees `tenant_id` (the platform realm) keeps the whole composite key. A reference
into another tenant's row is refused by every door — a generic write, an
import, a command, an API token and a public form — first by the database's own
constraint and then by the scoped writer's parent check under the tenant's
guards.

```sh
mistri check --config server.json --app ./app --policy ./tenant-policy.ts
mistri --config server.json --app ./app --policy ./tenant-policy.ts
```

The config must contain exactly one connection matching the named source, with
rows enabled. Use an existing SQLite file (a path, `sqlite:<path>`, or the existing
environment-reference connection syntax), or a `postgres://` URL
([PostgreSQL](#tenant-apps-on-postgresql)). Writes/commands additionally require
`"writable": true` on that connection. There is no positional database, demo,
proxy-identity, multi-App, global config pages/views/queries/layouts or MCP/export
mode for this host. The public ordinary HTTP factory still refuses tenant Apps.

The database must already contain the matching tenant store and eligible business
schema. Optional `--commands ./commands.ts` also requires an existing v4 command
journal and complete policy result-reference declarations. Startup never creates
or seeds the business database, adds membership, migrates tenant tables or upgrades
old journals; [provisioning](#provisioning) is a separate, explicit maintenance
step. A tenant sample walkthrough remains a follow-up. Do not point a single-tenant
sample at this mode without explicitly authoring and provisioning it for tenants.

`mistri check` validates the authored catalog/pages and actual enrollment, then
drains/closes it without opening an auth store or invoking membership/row/command
callbacks. Normal serving opens the independently configured native auth store
only after this validation. Auth data and SQLite sidecars must not alias business
data or its sidecars, including symlink/hard-link paths. A PostgreSQL business
database is not a file. The auth store may be PostgreSQL too
([authentication](#authentication-on-postgresql)).

## Runtime and remaining limits

Native sign-in grants no tenant membership. Own-membership discovery feeds an
explicit chooser; selection is per tab and bound to the exact native login,
membership revision/roles, tenant revision, App and deployment. Reads and writes
use the existing tenant-owned runtime, not an ordinary registry adapter. Global
resources remain read-only. CRUD and commands have separate membership grants.
Pending/unknown mutations guard voluntary navigation; they are not automatically
replayed. Tenant Undo UI remains independently withheld.

Strong tenant authentication refuses native impersonation sessions: a deployment
administrator's delegated login is not the target user's own tenant authority.
The dedicated tenant host also refuses native `/api/auth/admin/*` routes,
including global user listing, role changes and impersonation. Ordinary native
sign-in, profile and sign-out remain available; ordinary non-tenant hosting is
unchanged. Tenant administration uses separate explicit operator/target/role
grants, not implicit native admin permissions. Omission of the server-only
administration policy leaves management disabled; these safeguards do not enable it.

Access windows expire after **at most five minutes**, possibly earlier if
membership or native authentication expires. The browser renews unchanged
authority without replacing drafts or uncertain submissions. Offline/expired
access pauses behind a recovery cover; forms remain mounted. Exact continuity
can resume for up to 30 minutes after the last window, capped by native expiry,
only after fresh authentication and unchanged membership/roles. Renewal never
extends a write already in flight or retries an unconfirmed Save. Revocation,
changed authority and restart still require fresh selection.

Context admission is bounded to at most 32 tabs per account and 1,024 per
deployment. An account's native sessions and tenant/platform realms share that
budget, including contexts retained for offline recovery. At the account's 32,
a new page takes the place of the account's oldest context with no request in
flight (a released one first), which ends that context; the account is refused
(429, `too_many_contexts`, logged) only when every one of its contexts is busy. Capacity is reserved
only after the first session proof is verified; later session and membership
checks still apply. These are context limits, not a rate limiter for incoming
authentication requests. A page that is going (not into the back-forward cache)
releases its context (`/api/tenant/context/release`, sent with `keepalive` on
pagehide): it serves that page's last requests for 15 seconds and nothing after,
and stops counting. The same browser tab's next page, when the reader chooses the
same tenant again, resumes it (`/api/tenant/context/resume`) after a fresh session
proof and membership admission, and only a released context resumes, once, so a
context another page holds is never shared. A reader who reloads all morning
holds one context, not one per load.

A record page is one request (`/api/pages/compose`): the host plans the page and
asks each of its reads through its own read route on the one context the
request holds — one admission, each read in its own operation's snapshot under
the context's grants and row scope — and its verbs' availability as
`/api/commands/availability` does. On a support lease it answers 404, and the
page asks the plan and each read alone, each ledgered as the one read it is.

A first page is one request past the lease (`/api/boot`,
`packages/mistri/src/shared/tenantBoot.ts`). An ordinary App's page arrives
with its first answers in it; a tenant App's cannot, because its reads need the
lease the page opens. So once the lease is open the shell asks for the page in
one read on it: the host answers the runtime, the App, its pages, its schema
and the bell's count, plans the room the address opens as an ordinary App's
first page plans it (a natural key's record found by its key first), and asks
each of the room's reads through its own route on the one context. Each answer
is keyed by the request it answers, and the shell's requests take them once;
anything the boot did not carry, or a refusal in a read's own words, the page
asks itself. A boot that fails fences nothing, and a support lease is answered
404, as for a composed record. The projected App and pages are kept per
everything the projection reads (the App, the lease's catalog and grants, its
roles in order, realm, zone and locale) and handed to whoever reads the same.

A write — a record's save, New, Delete or Undo, a command's prepare or
execute — is proven by the writer's fence alone. It reads no membership in a
snapshot of its own before its transaction or after it: the fence locks the
tenant and membership rows before the write's callback runs and holds them to
COMMIT (on SQLite, `BEGIN IMMEDIATE` and the membership read on the writer), so
the membership is proven from BEGIN to COMMIT and nothing the write does — a
lookup, an external call, an event or a job — happens before the fence passes.
A revocation or suspension that begins while the write runs waits for its
COMMIT, and a revocation that commits after it does not change the committed
write's answer: the write is answered as applied, and the member's next request
is refused. A revoked or suspended member's write is refused before anything
runs, with the membership's refusal: 403, and for a command `forbidden` with
outcome `unknown`, as every execute refused before its receipt is read, since an
earlier attempt with the same key may have committed. An answer no committed
transaction carried — a refusal met before the fence, advice, a lookup read
outside the transaction — still meets the release fence before it leaves.

A record page whose key no read in the context admits — a missing record, or
another tenant's, pasted or followed — answers 404 `not_found`, the same for
both, and the page draws its ordinary not-found. A read the client asked
wrongly (a column the table does not have) answers 400 `invalid_read`. Neither
says anything about the context, which is revalidated before either is
answered, so neither ends the session: only `tenant_context_unavailable` does.

A command reaches a little past its reader's rows, and never past its tenant.
Its *bound* is the member's tenant within the command's footprint (`read`
and `write`), the row policy left out. An insert may land a row the reader
will not read once it is there — a lead routed to someone else — and the
command is told its key and what it wrote, not the row. A delete of a row
others reference is allowed once nothing references it, and only where the
reader reads every row of each referencing table the bound holds; otherwise
a row it cannot see might be the one a cascade reaches, and it is refused.
The references are counted on the writer across every tenant, after the row
is locked, so another tenant's row pointing at it refuses the delete too.
An ordinary (non-command) write, the platform realm and support sessions keep
the stricter rule: a row is written only where it is read.

App source changes under its directory, and changes to the selected config,
policy or command entry files, retire the host and require restart. Auth/database
file writes do not count as authoring changes. Imported policy/command dependencies
outside the watched App directory require an explicit operator restart. Shutdown
drains accepted tenant/auth work before closing owned resources. A busy port fails
instead of silently moving cookies/auth origins to another port.

A tenant App keeps the App features an ordinary one does, each inside the
tenant whose rows they are, on the deployment's own writer:

- **Record history** (`history()`). Captured beneath every scoped write, in its
  transaction, as on the ordinary host. A tenant-owned record's history is kept
  under its key *and its owner*, read off the row inside the write, so the store
  says whose each entry is; it is read only after the reader reads the record in
  their own context, under the owner that context is (a member's tenant; the row
  the platform realm read). The same key in another tenant is another record's
  history. Provision it with `provisionStores(<the database>, { app: { definition, pages } })`
  on the App's database (it makes every store the App declares; `only: ['record-history']`
  names this one and is refused for an App with no history); startup refuses without it.
- **Activity feeds** (`activity()`). A dashboard's feed is read on the reader's
  lease: a member's feed holds the changes stored under its own tenant's owner
  for tenant-owned resources, filtered in the store before its limit (a busy
  tenant never crowds another's feed out, and never fills it), and the
  platform's own resources' changes; each entry is shown only while its record
  is readable in that context. The platform realm's feed names no owner. A feed
  draws no email and no mention.
- **Workflows.** An instance is always one tenant's: the store keys it by the
  workflow's name *and* the tenant (`<name>~<tenant>`), so starting, signaling,
  waking and retrying an instance are each one tenant's, and tenant B's event
  never wakes tenant A's instance of the same key. Each step runs a tenant
  command as the workflow's principal, which holds tenant-realm roles only,
  fenced on that tenant and `@platform` as a job's command is. A step's command
  that declares events, looks up or is public is refused.
- **Flows from rows** (`flows`, `flowRunner`). A run is one tenant's. The job
  host tails the deployment's record history across tenants, and each change's
  tenant is the owner its stored key holds, which the writer read off the row
  inside the write; no request, flow row or payload names it. The change is
  dispatched as that tenant's service principal (`runAs`), admitted and fenced
  on that tenant and `@platform` as a workflow's step is, so the match reads
  that tenant's flows alone and the run lives in that tenant's partition
  (`<runner>~<tenant>`, keyed `<record's stored key>|<flow>`, the stored key
  holding the owner). An event resumes only its own tenant's runs. The record
  and both tables of rows must be tenant-owned (startup refuses otherwise: a
  flow table shared by every tenant would be one tenant's process edited by
  another, and a record with no owner names no tenant to run in). A step kind's
  command is held to the workflow step rules above. `flows()` and
  `/api/record-flows` read a record's runs after reading the record in the
  reader's own context; a manual start (`/api/record-flows/start`) is a
  member's, in their own tenant, with a role granted `operations: ['workflows']`
  — never the platform realm's or a support operator's. A flow or step row is
  judged on the tenant write path like any App rule.
- **Timers** (a state's `after`, a resource's `at`) run through `--jobs`, each in the tenant
  its row's owner names: the job host reads the due records across the active
  tenants, the owner read off each row by the server, and runs the timer's
  command there as the jobs module's service principal ([Tenant
  jobs](#machine-timers-in-a-tenant-app)). A machine's `by` moves apply to a
  tenant command running as a service principal holding the role.
- **Signed-in forms.** A form's command names no record (`targets: 'none'`);
  the row it creates is placed in the member's tenant (the owner is filled in,
  never read from the form) and must be readable there after the insert, or the
  submission is refused whole. A row-policy App's forms work the same way
  under its policy. The command is in the payload's `grantedCommands` for a
  member granted it, so a component's `useCommand` reaches it through its
  form, and its empty key travels the tenant transport as any key does.
- **Natural keys within a tenant.** A tenant-owned resource's `address` may be
  a column unique together with the tenant column (`UNIQUE (tenant_id,
  number)`): each customer has its own ticket 1, and `/tickets/1` opens the
  session's tenant's, as every read is the tenant's. Startup already refuses a
  unique index on a tenant-owned table that leaves the tenant column out.
- **One tenant App per database.** A database's tenant store belongs to one
  App. Provisioning or starting a second App on it is refused
  (`TenantStoreOfAnotherApp`): its tenants, their memberships and the platform
  row are that App's, and a second App would admit the same people to the same
  tenants under its own roles. Give each tenant App its own database.
- **Notifications** (`notify`). A notice about a tenant's record is kept in that
  tenant's inbox, named by the owner read off the record; one about a platform
  record in the platform realm's. An inbox is read and marked on a lease, as the
  lease's account, in the lease's own inbox, and a notice is shown only while its
  record is readable there. A rule's recipient and words are read from its own
  side of the realm boundary. A support session reads no inbox. A rule with
  `email: true` queues its mail in the same inbox, in the same transaction;
  the host sends it after the commit (`tenantNoticeMail.ts`), reading each
  message as a request of the recipient's own: the runtime admits their
  membership of that inbox's tenant at send time, and the record must be one
  their grants there read, or the row is dropped unsent. Nothing is read as the
  platform. The link carries `?tenant=` (or `?realm=platform`), a hint the
  chooser checks, and the email switch is per inbox, on the lease.
- **CSV import.** `POST /api/import` on a member's lease: every read the import
  makes is a read in that context, and its rows are written in one transaction
  of it, the owner injected; a command import runs the command per row there.
  It leaves no Undo as one.
- **Custom components.** Their files are served to a verified session only, and
  every read a component declares is an ordinary read in the member's tenant.

Not included: tenant Apps on MySQL; cross-source transactions, invitation delivery,
durable generic CRUD recovery,
tenant quotas/support access, or remote erasure of data
previously released to an authorized browser. A production deployment is
[below](#deploying-a-tenant-app).

## Provisioning

Provision once, on the stopped business file, before the first start, from the
deployment's own maintenance script, the same way the command journal is migrated:

```ts
import { migrateSqliteCommandJournal, provisionStores, type TenantStoreBinding } from '@mistriwork/mistri/maintenance';

const file = './business.db';
const binding: TenantStoreBinding = {
  appId: 'dealer-desk',                                   // the App's id
  source: { id: 'business', connection: 'business-db' }, // the named source and its connection id
  storeId: 'dealer-desk-tenants',                         // the tenant policy's storeId
};
// The store, then (with `administration` or `invitations`) the journal, then (with `invitations`) the
// invitations, then (with support access) `tenant-support-audit`: made in that order whatever order `only` lists.
// { stores: { 'tenant-store': { version: 2, provisioned: true }, … }, destinations: [] }
await provisionStores({ sqlite: file }, { app: { tenant: binding }, only: ['tenant-store', 'tenant-administration', 'tenant-invitations'] });
migrateSqliteCommandJournal(file);                         // only with --commands
await provisionStores({ sqlite: file }, { app: { tenant: binding } }); // only when a command declares events, after the command journal
```

Each step is idempotent (`provisioned: false` once the exact layout is there)
and adds only reserved `__mistri_*` tables (on PostgreSQL, the `mistri` schema); business tables and rows are
untouched. The store records the App,
source and store IDs; the connection ID is a transient alias and may be renamed.
A missing file (it is never created), a directory, another binding, a partial or
foreign reserved layout, or the journal before its store refuses with the tenant
runtime's one opaque error and writes nothing. The store starts empty: create
tenants and grant memberships through tenant administration, by an operator the
policy names, not by editing the reserved tables. A PostgreSQL source is
provisioned with the migrations [below](#tenant-apps-on-postgresql).

### Upgrading a tenant App's stores

A new mistri may keep a store in a newer layout. Startup never migrates: it
refuses a store behind its layout by name and prints the command that brings it
forward. A tenant App's stores (the tenant store, its invitations,
administration journal and support audit, the sandbox store, and the stores
beside them: command journal, events, jobs, inbox, history, branding) move in
place, all tenants at once, because the runtime attests one exact layout and
cannot serve two.

```sh
# stop the server, then back up the business database (pg_dump -n public for the App's data and
# pg_dump -n mistri for the runtime state, or sqlite3 .backup)
mistri migrate stores status --app ./app --config server.json
mistri migrate stores up     --app ./app --config server.json
# start the new version
```

`--app` upgrades what the database holds. With `--policy`, it also makes what
the start attests and the database lacks: the tenant store and the journals the
policy declares, the command journal, the event, effect and job stores, the
sandbox store and the record history. A start or `mistri check` that finds
one absent names it and prints that command. Each store's
step runs in one transaction, so a failed step leaves that store at the version
it had, and the server then refuses to start, naming it. There are no down
steps: to go back, restore the backup and run the previous mistri, which
refuses a newer layout by name. On PostgreSQL a step on a tenant store takes the
server-wide maintenance lock that provisioning and `mistri tenant` take, so
they wait for each other, and a step that alters the memberships table holds
`ACCESS EXCLUSIVE` on it for its length, which is short, as memberships are per
account.

## Deploying a tenant App

A tenant App deploys as any App does
([Build and deploy](../site/src/content/docs/docs/build-and-deploy.md), and
[deploy-targets.md](deploy-targets.md) for the hosts), with five things of its
own. In order, from CI or a one-off task, over the database's direct port:

```sh
# 1. The build carries the policy, and the image it writes starts with it.
mistri build --app ./app --commands ./app/commands.ts --policy ./app/policy.ts --dockerfile Dockerfile
# 2. The sign-in store: a PostgreSQL database of its own, never the business database.
node -e "import('@mistriwork/mistri/commands').then((m) => m.migratePostgresAuthStore(process.env.MISTRI_AUTH_STORE))"
# 3. The tenant store, the journals the policy declares, and every store beside them.
mistri migrate stores up --config mistri.json --app ./build/app --policy ./build/app/server/policy.mjs
# 4. The first boot: the platform realm, the first tenants, the first operator. Each runs again safely.
mistri tenant init north south --config mistri.json --app ./build/app --policy ./build/app/server/policy.mjs
MISTRI_ACCOUNT_PASSWORD=… mistri tenant grant ops@lender.example --roles manager \
  --config mistri.json --app ./build/app --policy ./build/app/server/policy.mjs
# 5. Then the rollout: every instance starts with --policy, as the generated Dockerfile does.
```

- **`--policy` everywhere.** A tenant App has no start, check or store step
  without its policy: the build bundles it as `server/policy.mjs`, and
  `migrate stores up`, `mistri tenant` and every instance name that file.
- **The sign-in store in its own database.** `auth.store` is a `postgres://`
  URL with its password, or the whole URL, as a `${NAME}` reference
  (`"${MISTRI_AUTH_STORE}"`). Startup refuses the business database as the
  store, and refuses a business role that can reach the store's schema
  ([Authentication on PostgreSQL](#authentication-on-postgresql)).
  `migratePostgresAuthStore` makes its schema once; a start only attests it.
  The default store, a SQLite file in the config directory, is lost with the
  container, and `mistri check --deploy` refuses it.
- **`MISTRI_AUDIT_KEY`, kept for good.** With support access, the support
  audit is sealed with this key (32 bytes or more, apart from
  `BETTER_AUTH_SECRET`), and provisioning and every start need it. Keep it in
  the platform's secret store beside the database's backups: a lost key leaves
  the audit's past unverifiable, and revoking a membership refuses until the
  key it was provisioned with is set again.
- **The first boot.** A new store has no platform row, no tenant and no
  membership, so nobody can sign in to anything. `mistri tenant init` opens
  the platform realm and puts the named tenants; `mistri tenant grant`
  makes the first operator's account in the App's auth store (its password
  from `MISTRI_ACCOUNT_PASSWORD`) and grants a platform membership, or a
  tenant's with `--tenant`. From then on tenants and members are managed in
  the App ([Tenant administration](#tenant-administration)) and platform staff
  with `mistri tenant grant` or the steps of
  [Tenant maintenance](#tenant-maintenance).
- **Migrations before the rollout.** Every instance attests the stores and
  creates none; an upgrade is step 3 again with the server stopped
  ([above](#upgrading-a-tenant-apps-stores)).

## Tenant administration

Administration has a separate operator policy, six bounded metadata operations
and a same-file receipt/audit journal. Startup, owned HTTP transport, authorized
listings and management UI are implemented and verified in 0.3.0.
Operators are explicit native account IDs with tenant, operation and
role ceilings; native or global roles are not substitutes. A tenant may also
administer itself: `delegates` names a tenant role whose active members hold
listed operations inside their own tenant, within the same ceilings, never on
their own membership. No business membership is silently created for an
operator.

Put the optional `administration` declaration inside the existing server-only
`defineAppTenantPolicy(...)`, not in the serializable App. For example, this
fragment permits one operator to create a named tenant or change its status and separately
manage only its reviewer memberships:

```ts
import type { AppTenantPolicy } from '@mistriwork/mistri/policy';

const administration = {
  id: 'dealership-management',
  version: '1',
  maxMembershipLifetimeMs: 24 * 60 * 60 * 1000,
  operators: [
    {
      accountId: 'existing-native-operator-id',
      tenants: ['demo-dealer'],
      operations: ['createTenant', 'setTenantStatus'],
      roles: [],
    },
    {
      accountId: 'existing-native-operator-id',
      tenants: ['demo-dealer'],
      operations: ['grantMembership', 'replaceMembership', 'revokeMembership'],
      roles: ['reviewer'],
    },
  ],
} satisfies NonNullable<AppTenantPolicy['administration']>;
```

This is a policy fragment, not a runnable tenant App. Replace the placeholder
with an existing native account ID, declare `reviewer` in the App's `auth.roles`,
and explicitly provision the matching existing tenant store and administration
journal ([provisioning](#provisioning)). Connection `"writable": true`
is required even when ordinary business grants remain read-only. Startup and
`mistri check` attest the journal; neither creates it. Changes require a restart.
Each account/tenant/operation must have one unambiguous role ceiling. Separate
rules cannot overlap that triple or combine into broader membership access.

An authorized operator sees **Account → Manage tenants**, including before
choosing a business tenant and when they have no business memberships. Whether
the item is offered is asked when the account menu is first reached for, not
when the shell is drawn: each answer is a writer transaction, and entering a
context no longer waits behind it (invitations likewise). The list
contains only explicit authorized targets; a not-yet-created target can be
created there. Membership lists are filtered by the chosen operation's role
ceiling before pagination. There is no global user directory: a grant requires
the exact existing native account ID. The status operation can suspend,
reactivate or permanently close a tenant; it is not limited to suspension.

Management uses its own short-lived login-bound context, not a selected tenant's
business context. The client keeps one admitted context across business selection
changes in the same native account session; expired access can be explicitly
refreshed and failed initial admission can be retried from the account menu.
Permanent business-context denial closes the business surface without discarding
independently admitted administration. Finish checking any unconfirmed attempt,
then reload and choose a tenant again. Actual native logout or account replacement
still retires all private UI; browser recovery is not durable across reload.
Requests use the owned
`/api/tenant/administration/{open,tenants,memberships,execute,status,assistant-usage}` routes, with
App/account assertions and `x-mistri-administration-context` after opening.
This is the bundled client's owned protocol, not a new bearer-token API.

Operations create tenants, change status, grant memberships, replace active
membership roles/expiry, revoke memberships and set a tenant's assistant
([the assistant](#the-assistant)). Updates require expected tenant
revisions, plus expected membership revisions for existing memberships. Closure
and revocation remain terminal; role replacement cannot accept an invitation.
Role ceilings apply to both the prior and proposed membership, so a limited
operator cannot revoke or overwrite higher access.

Metadata, operation receipt and before/after audit commit in one transaction on
the business database, SQLite or PostgreSQL. Exact-intent recovery reports the historical change after current
operator authorization, including after tenant closure; it does not claim the
historical membership is still active. Unknown acknowledgements are not retried
automatically. Native target-account checks use the separate authentication
store, so this is not a distributed auth/business transaction. Provisioning is
explicit existing-file maintenance, never a startup side effect.

A final synchronous observation of the already-verified native session refuses
detected revocation before commit; a failure detected after commit remains
unknown. On a PostgreSQL auth store that observation is asynchronous, at the
last await before commit ([authentication](#authentication-on-postgresql)).
Browser journeys cover desktop/phone management before business
selection, exact lost-reply recovery, held selection and self-suspension.
Invitation delivery and broader lifecycle tooling (store migrations, export,
deletion) remain queued.

## The assistant

An App that declares `assistant` offers it in a tenant App too, one tenant at a
time (docs/assistant.md, "In a tenant App"). What leaves the platform is the
person's messages and the rows their own reads return, sent to Anthropic with
the server's `ANTHROPIC_API_KEY`.

Each tenant has a switch, off until the platform owner turns it on. It is the
sixth administration operation, `setTenantAssistant`, in **Account → Manage
tenants**: an operator granted it may turn a tenant's assistant on or off, and
turning it on names a free-text consent reference (a contract or DPA id, at
most 500 characters). A delegate granted it (`delegates`, with `roles: []`)
may turn its own tenant's assistant off, never on. The switch is offered only
where the App declares an assistant. Every change is journaled like any other
operation, with the before and after switch and the reference. It expects the
tenant's version but does not bump it, so turning it off does not end the
tenant's open leases; it is read on every assistant request and before every
model call instead. Off, `/api/app` carries no `assistant`, so the panel is not
drawn, and the routes answer 403. A support session and the platform realm
never get one.

The switch is a row (feature `assistant`) in the tenant switch store
(`__mistri_switch_tenant`; on PostgreSQL `mistri.switch_tenant`), which the decision switches share and the assistant
store provisions beside its own; the tenant store is unchanged.
Caps and retention are the tenant policy's, beside `administration`:

```ts
assistant: { tokensPerTenantPerDay: 2_000_000, retentionDays: 90 },
```

`tokensPerTenantPerDay` is checked before the model is asked, after the App's
per-person and per-turn limits. Conversations untouched for `retentionDays`
(default 90) are purged at start and every six hours. Closing a tenant deletes
its conversations and switch in the same transaction; its token counts stay.
An operator who may set the switch sees an **Assistant usage** tab in Manage
tenants: tokens by tenant, by day or by month, for the tenants they are granted,
with a CSV download.

## The platform realm

A tenant App can declare a second realm for the business above its tenants,
such as a lender above its dealers:

```ts
auth: {
  rows: 'tenant',
  tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
  roles: {
    staff: { realm: 'tenant', read: true, write: ['lead'] },
    underwriter: { realm: 'platform', read: true, commands: ['approve-lead'] },
  },
},
resources: {
  dealer: { owner: 'platform' },
  lead: { access: 'write', owner: 'tenant' },
  vehicle_model: { owner: 'global' },
},
```

- **`auth.tenancy.platform: { label }`** declares the realm; the label names it
  in the chooser. The server-only policy then declares
  `resolvePlatformRows(evidence)`, and startup refuses one without the other.
- **`resources.X.owner`** is required on every resource: `'tenant'` rows belong
  to one tenant by the policy's ownership column, `'global'` rows are read by
  every tenant and owned by none (read, never written), and `'platform'` rows are
  the platform's own. The DSL's owners and the policy's ownership kinds must
  agree exactly.
- **`auth.tenancy.profile`** names the platform table with one row per tenant.
  A tenant's row may point at it, only through its ownership column; no other
  tenant or global row points at a platform table.
- **`realm`** is required on every role and every root nav group once the
  platform is declared, and on a list or dashboard view, page, home rule,
  signed-in form or command reference that serves the platform. A page over a
  platform table must say it, including pages from the App loader. Each
  membership admits its own realm's roles only.

**Authoring is judged realm by realm.** A two-realm App is two authored
surfaces over two catalogs, so `mistri check` and startup check each declaration
in the realm it names: a `realm: 'platform'` view, page, nav entry, home rule,
signed-in form or command reference against the platform-visible catalog —
every table, with the ownership column the platform reads — and everything else
against the tenant-visible one, exactly as a single-realm App is checked. A
resource block is judged in its owner's realm, because that is which catalog
holds its table. The same projection decides what each lease is *served*: a
context is offered its own realm's views, menu, home and pages and none of the
other's. That is deliberately not the same as narrowing by which tables the
context has — the lender's list over a dealership's own table resolves in a
dealership's catalog perfectly well, and is still the lender's screen. So a
tenant-realm declaration that names a platform-owned
table still finds no such table and is refused in the same words, and a tenant
form or view that names the ownership column is still refused. An API token is
one tenant membership's, so only the tenant realm's authoring is its own.

A tenant's context never reads a platform row, and two independent layers keep
it that way. Its row scope holds every platform table false before either
policy resolver runs, and the tables are left out of its visible resources and
schema. A tenant role's `read: true` stops at the platform's tables. The
platform context reads only what `resolvePlatformRows` names, across tenants
and with no tenant predicate; a table it does not name is denied, global or
not. It sees a tenant row's ownership column and never writes it.

**The platform edits its own rows generically.** A platform role may name, in
`write`, `create` and `fields`, the platform's own resources declared
`access: 'write'`, and the platform lease then offers Save, New and Delete
over them as a tenant's lease does over a tenant's:

```ts
underwriter: { realm: 'platform', read: true, write: ['dealer', 'rate_card'], commands: ['approve-lead'] },
```

Startup refuses `write: true` on a platform role, and a `write`, `create` or
`fields` grant naming a tenant-owned or global resource, a platform-only
source, a resource that is not `access: 'write'`, or the profile under
`create`. The profile's row is the tenant's anchor: it is edited, never made
by New and never removed. Its key, every column a key elsewhere names on it,
and the columns `intake.address` and `public.address` name are held — read,
never written by Save — because each places a tenant's rows or visitors;
changing one is a command's job. Delete is offered only on a platform table no
key anywhere refers to, so removing a row can never cascade into a tenant's.
The writer holds the same line on its own, beneath what the browser is
offered: a generic platform write runs in a transaction that refuses any
non-platform table, an insert or remove on the profile and an update that
touches a key column, fenced on the platform membership and `@platform` as a
command is, and it is refused while an account is inside a tenant on a
support session. Every edit lands in record history under the member's name.
Import, Revert and file upload stay refused (403) on the platform lease.

A tenant's rows change through commands registered with
`defineCommand({ realm: 'platform', ... })`, whose App references say
`realm: 'platform'` too; startup pins them. A platform command may insert,
update and remove platform rows and update a tenant's rows by key. It never
inserts or removes a tenant's row, sets an ownership column or writes a global
table, and it is never public and declares no events. A `targets: 'many'`
command may span tenants, all or nothing; the tenant HTTP host takes one key.

**A platform command may act in one named tenant.** It says which input field
names the tenant, and nothing else of any tenant is in its scope:

```ts
seedDesk: defineCommand({
  realm: 'platform',
  tenant: 'customer_id',
  source: 'business',
  target: 'desk_setting',
  targets: 'none',
  write: ['customer'], // also read: desk_setting.tenant_id references it
  input: { customer_id: { label: 'Customer', type: 'reference', from: 'customer', by: 'id', labelColumn: 'name' } },
  async handle({ db }, input) {
    await db.desk_setting.insert({ id: 'default', timezone: 'UTC' }); // no owner: it is the customer's
    await db.customer.update(await db.customer.get(input.customer_id), { status: 'live' });
  },
}),
```

The field is a required text or reference field at the top of the input, never
`keyed` and never asked `when`. On every run the runtime reads it by the field's
own rule — the value the handler is given — and reads that tenant's row: an
unknown or suspended tenant is refused, and `@platform` is not a tenant
(`invalid_input` on the field). The writer's transaction is then fenced on that
tenant's row at the version read, on `@platform` and on the platform membership,
so a suspension or a revocation that lands in between refuses the write. Its
scope is the platform policy's rows with every tenant table narrowed to that
tenant, ANDed onto the policy's own conditions and never in place of them: the
handler inserts, updates and removes that tenant's rows as a member's command
would, with the owner placed for it and held on every key, beside the
platform's own rows. Another tenant's row, an owner set by hand or a row moved
to another tenant is refused, and nothing it tried stays. The receipt is the
platform member's, in the platform realm; every audit row names the tenant (or
the platform, for a platform row), and a command that creates its rows names
the tenant on its audit row, so the tenant's own audit reads what the platform
did there. Opening the tenant itself is still store maintenance, before the
command runs. A job's command never names its tenant this way — a job runs
where its event or its time puts it — and startup refuses one that does. A
platform form's command (`targets: 'none'`) names no record, as a tenant's
does.
Each realm's roles grant only that realm's commands, each realm refuses the
other's, and the browser offers a platform command's action only on the
platform lease, to a member whose role grants it. The command runs in a writer
transaction fenced on the platform membership and the reserved `@platform` row,
so a concurrent revocation waits for it or refuses it; on PostgreSQL the fence
locks `@platform` FOR SHARE against administration's FOR UPDATE.

The browser selects the realm with `?realm=platform`, never beside `?tenant=`.
The context reply says `realm: 'platform'` with `tenantId: '@platform'`, every
owned response carries `x-mistri-realm: platform`, a request asserting the
realm by header is refused, and `?tenant=@platform` is refused. Bootstrap says
`platform: true` for a platform member, and names each membership (`name`): its
profile row (`auth.tenancy.profile`) said as the App names that resource's
records, where the name is the profile's own columns. Support status names its
choices the same way, and the administration and invitation consoles' target
pages name each target (`name`) through the same read. A name is words for the
chooser, the bar, the support banner and those consoles; every link and request
still names the id. Roles have no label of their own, so wherever a person
reads one it is its id made words (`branch_viewer`, "Branch viewer").

The realm is data. Tenant store **version 2** (SQLite and PostgreSQL) adds a
tenant row's kind and the reserved `@platform` row, which anchors platform
memberships with a tenant's revisions, terminal states and fence; suspending it
stops the realm. Platform memberships are store maintenance:
`grantPlatformMembership` and `revokePlatformMembership` in
`@mistriwork/mistri/maintenance`, with no administration operation or HTTP surface. Command journal
**version 4** keeps the realm in each receipt's idempotency namespace and the
owning tenant on each audit row, read from the stored target row in the same
transaction, or empty for a platform row. A store at version 1 or a journal at
version 3 is refused unchanged: provision fresh ones.

### What authoring checks, and what it refuses

**A view's realm is where the menu puts it.** A root nav group's `realm`
reaches every entry beneath it, so a view in a `platform` group serves the
platform without saying so itself. Off the menu, or where the group says
nothing, the view's own `realm` decides; absent that it is the App's own realm,
`tenant`. A page, a home rule, a signed-in form and a command reference each
say their own. A resource block's realm is whose rows it holds — its `owner` —
because that is which catalog its table is in at all.

**The refusals that remain, in the words the author sees.** A tenant-realm view
over a platform-owned table does not load:

> views "leads" is in the tenant realm and reads "dealer", a platform-owned
> resource. Place it in a "platform" group, or give it "realm": "platform".

A page whose base is platform-owned says so or does not load: `pages "file" has
the platform-owned base "dealer", so it says "realm": "platform".` A tenant
role that names one is refused too: `"auth", role "staff" is a tenant role and
names "dealer", a platform-owned resource: a tenant's context never reads the
platform realm's rows.` The managed ownership column is not in the tenant
catalog at all, so a tenant-realm view's `show`, a form or a `display` rule
that names it fails `mistri check` as a column that is not there; the platform
realm's own views may show it, because the platform reads whose row each is.

**How an action is judged, and two limits to author around.**

- **An action is judged in its command's realm, not its resource's.** A
  `realm: 'platform'` action on a **tenant-owned** resource has its inputs
  resolved against the platform-visible catalog, so a lender's reviewer picker
  may reference the platform's own staff table while the rows that command
  writes stay the tenant's. A command reference that says nothing, and a fixed
  `set` update, run where the resource's rows do — so a tenant-realm action
  naming a platform-owned table still finds no such table. This is also why, in
  a platform check, a tenant-owned resource appears carrying only its binding
  and that one action: a form, transitions, display rules and a search are
  judged where the rows live, and carrying them across would report that no
  action sets a transition column when the setter simply belongs to the other
  realm.
- Per-column `display` rules belong to a resource, so a platform-realm view
  over a tenant-owned table cannot carry display rules of its own; the tenant
  resource's rules are what both realms draw.
- `bulk: true` is not available on a tenant App. A tenant command takes exactly
  one key, whatever `targets: 'many'` permits elsewhere, and a request naming
  several keys is refused before authorization.

**A startup refusal says what failed, not only where.** It names the stage — the
authored resource ceilings and role grants, the attested ownership of the
authored resources, or the authored resource and page definitions — and, where
the check has something specific to say, the problems themselves: the authoring
check lists each one with the realm whose catalog found it, and the command
preflight names the command ids an action or a role asked for and what the
`--commands` registry actually declares. All of that is the terminal of the
operator who started the deployment. A request is still answered with the one
sanitized sentence, and the underlying failure travels as the refusal's `cause`,
which nothing prints or serializes and only the trusted owner can read. There is
no debug environment variable to set.

## Public intake

A tenant App may take one write from someone who is not signed in: a public
form (`commandForm(…, { public: true })`, served at `/{app}/form/{key}`). The
submission must land in exactly one tenant, and nothing the visitor types may
choose which: a typed dealer code is guessable, so trusting it would let
anyone place rows in any tenant, and refusing an unknown one would tell them
which tenants exist. So the server places it, by an address the visitor only
carries:

```ts
// the server-only tenant policy
intake: { address: 'intake_address' },
```

- **The address** is a text column of the platform's profile table
  (`auth.tenancy.profile`, one row per tenant). The platform writes each
  tenant's value through its own commands, generated at random (at least 22
  characters of `A–Z a–z 0–9 _ -`, 128 bits), and the tenant publishes its form
  as `/{app}/form/{key}?via=<address>`. It is a routing address, not a secret
  or a credential: all it lets anyone do is submit to that tenant, which is
  what the tenant published it for. Rotate it by writing a new value.
- **Resolution** is one read snapshot on the server. The platform's own
  `@platform` row must be active, or every submission is refused alike
  (`503 temporarily_unavailable`). Then the one profile row whose column holds
  the address, byte for byte, names the tenant, which must be active. Anything
  else — no address, a malformed or unknown one, one that two rows share, a
  profile row with no tenant, a suspended or closed tenant — places the
  submission with the platform, for its triage.
- **The handler** is told where it lands: `context.intake` is `'tenant'` or
  `'platform'`. Placed with a tenant it inserts that tenant's rows with the
  ownership column injected (a supplied owner is refused), and may update
  that tenant's rows of the tables its command declares (`write`) — a routing
  rule's tally, a counter — under the tenant's scope, never another tenant's
  and never the ownership column. Triage only inserts the platform's own rows.
  A removal, triage's update, or a row in the other place is `forbidden` and
  nothing stays; the server log names the write it refused, and the visitor's
  answer does not. Answer both places alike; the visitor must not be able to
  tell them apart. A form saved on every step is the one exception, below.
- **The fence.** There is no membership. Before the handler runs, the writer
  checks everything resolution read: the tenant's store row and the platform's
  `@platform` row at the versions it read, and the profile row that still holds
  exactly that address — inside `BEGIN IMMEDIATE` on SQLite, each locked
  `FOR SHARE` to COMMIT on PostgreSQL, so a suspension or an address rotation
  in flight waits for the submission. One that committed first sends it back
  to be resolved once more, with nothing applied: a rotated address or a
  suspended tenant then lands it with the platform, and a suspended platform
  refuses it as it refuses every submission. It never reaches a tenant that no
  longer holds the address.
- **Receipts** sit in the tenant's namespace or the platform's. The actor is
  the public principal `public:<form>`, recorded in the membership's place at
  revision `0` with no role; the audit keeps column names and redacts values,
  as for any public command. The submission key replays within its place.

The dedicated tenant host serves `GET /api/forms`, `GET /api/forms/<key>`,
`POST /api/forms/<key>` and `GET /api/landing` with the ordinary host's bodies
and limits (five submissions a minute and thirty an hour per client, three
hundred an hour in all). The list of forms takes no parameter; a form's read, a
submission and a saved step take `?via=` once and nothing else. On the App's
mapped host they take none (`?via=` is `400`), and are placed by the address
the host's tenant holds (`addresses(tenant).intake`), so the read, the
submission and every step land where the host says, through the same
resolution and fence; a tenant that holds no address places nothing, and the
submission goes to triage. A tenant ownership header or any other parameter is
`400`, another origin `403`, all before anything is counted or read. Every
placement answers `200` with `{ reference, receipt: { id, status } }` and the
same header names, and no `x-mistri-*` header. Signed out, who-am-I names
the App's public home, so the page draws the landing or the form. The page
copies `?via=` from its own address onto the submission.

Startup refuses a public form without `intake`, `intake` without a public form
or without the platform realm, and an address column that is the profile's
key, any key, missing or not text. The form's command is `public: true` with
no realm, lookup, events or effects, writes only tenant- or platform-owned
tables, and its `resultReferences` entry must return `[]`: a public result
names no record.

### A form saved on every step

A public form saved on every step (its steps each run a command) runs each step and its submit as its
own submission, resolved from its `?via=` address every time. Its draft lives
where its first step landed: the first step's written tables that keep the
resume columns, and there must be one in each place — a tenant-owned root
and a platform-owned one — or startup refuses, since a step placed where no
root exists would answer differently from one that saved. A later step may
update and remove rows, and only its own draft's: the executor finds the root
by the applicant's token inside the step's transaction, in that place, and
fences the handler to the root by its key and the tables that reference it
(`forms/savedForms.ts`). The token is bound to the place as well as to the
root: the root keeps the hash of the token taken with the App, the form and
the tenant it was issued in, so the same cookie under another tenant's
address, under a rotated one or under none finds no draft and is answered as
a forged one is, with nothing written. The resume reads the same way. The
host serves `POST /api/forms/<key>/steps/<step>` and `/resume` beside the
submit, each taking `?via=`. `statusCheck` and `link` are refused by name on a
tenant App: they read and write an application outside any step's command.

What this does not do. It is not constant time: a placed submission and a
triaged one insert into different tables, and one the writer sends back is
resolved twice — differences far below network jitter and bounded by the
rate limit. A second change between that second resolution and its write is
answered `503 temporarily_unavailable`, as every submission is while the
server is busy. The fence holds the profile row that holds the address, not
the column's other rows: copying the same address onto a second tenant's row
while a submission is in flight does not stop that one submission. The
platform realm never inserts a tenant's row, so a triaged submission is not
moved into a tenant: triage is the platform's own queue. There is no
applicant identity, status lookup or upload.

## Public reads

A tenant App may open resources to visitors who are not signed in
(`auth.public: { read, fields? }`, as in any App). A visitor has no
membership, so something else must say whose rows it reads, and nothing it
types may choose: the server places it with one tenant by an address it
carries, as public intake does.

```ts
// the server-only tenant policy
public: { address: 'public_address' },
resolvePublicRows: (visitor) => ({
  vehicle: { groups: [[{ column: 'listed', op: '=', value: true }]] },
  make: true,
}),
```

- **The address** is a text column of the profile table, held to intake's
  rules (at least 22 random characters of `A–Z a–z 0–9 _ -`; not a key). It
  may be the intake column. A tenant publishes its pages as
  `/{app}/…?via=<address>`, and the page keeps `via` on every address it writes
  and every read it makes. On a mapped host (`hosts` in the suite config) the
  host names the tenant and `?via=` there is `400`.
- **The rows.** `resolvePublicRows(visitor)` is the twin of
  `resolvePlatformRows`: given the placed tenant (`visitor.tenantId`), it
  returns a row scope; a table it does not name is denied. The runtime ANDs
  the tenant onto every group of a tenant-owned table — the callback cannot
  widen past its tenant with an `or` — passes a global table's scope through,
  and denies every platform-owned table whatever the callback says.
  `auth.public.read` may name tenant-owned and global resources only; startup
  refuses a platform-owned one, `auth.public` without `public` and
  `resolvePublicRows` in the policy, and either of those without the other.
- **Columns.** A visitor reads `auth.public.fields` where it narrows, and never
  the ownership column; the address column is the profile's, which no
  visitor reads.
- **The fence.** Every read resolves the address in its own snapshot and
  checks it again before each statement: the tenant and `@platform` active at
  the versions it was placed at, and the address still that tenant's. A
  rotation or a suspension committed while a read is in flight yields no rows.
- **What it answers.** The visitor's reads are the ordinary visitor's routes
  (`GET /api/app`, `/api/schema`, `/api/pages`, `/api/runtime`; `POST
  /api/query`, `count`, `counts`, `run`, `view/run`, `breakdown(s)`,
  `references`, `pages/plan`, `pages/compose`, `pages/load` for a `public:
  true` page, and `/api/file/read`). An unknown, malformed or doubled address,
  a suspended or closed tenant, a suspended platform, another tenant's record
  and a resource the grant does not name all answer one `404 not_found`. Each
  answer is `no-store`, `referrer-policy: no-referrer` and `x-robots-tag:
  noindex`, with no `x-mistri-*` header. Signed out or not, who-am-I with
  `?via=` answers the visitor (`public: true`): a member's cookie is ignored
  there, and a member reads as a member at the App's own address.
- **Refused.** `?via=` beside a tenant header, `?tenant=` or `?realm=` is
  `400`, beside a bearer `403`; on any route but a read (a write, a command,
  an export) `403`. The tenant's published look (`private: false`) dresses
  the App; record pages are not drawn on the server and the tenant shell has
  no sitemap, since an address is not a page to index.

What this does not do: a picture in a list (`GET /api/file`) does not yet
carry the address, and a visitor's custom components are not served.

### A tenant's own addresses

A tenant hands out its links itself. On its own lease, `GET /api/app` carries
`addresses: { intake?, public? }`: the profile row's values for the columns
the policy names, read by the tenant's own key. An address is served only when
it has the address shape and resolves back to this tenant alone, so a
malformed value or one two tenants share is left out, and a rotation shows on
the next read. The platform and support leases and bootstrap never carry one.
A custom component builds the link with `useNavigate().publicLink(view)`: a
list view by the public address (`/{app}/{view}?via=…`), any other key as a
public form by the intake address (`/{app}/form/{key}?via=…`), and `undefined`
where the address it needs is absent.

## Tenant Apps on PostgreSQL

A tenant App starts on one existing PostgreSQL database through the same
`auth.rows: 'tenant'` + `--policy` path, with the same membership admission,
per-tab contexts, ownership injection, record history, command receipts and
administration as on SQLite. Point the configured connection at a
`postgres://` URL. A unique table name is found without help, so
`public.dealer` is the resource `dealer`; declare every table, as the
database-of-its-own rule below requires, and give a block `physical:
'public.dealer'` only when the bare name is ambiguous:

```ts
sources: { business: { connection: 'business-db' } },
resources: { dealer: {}, lead: { access: 'write' } },
```

Provision once, before the first start, with the explicit maintenance steps
from `@mistriwork/mistri/maintenance`. Each runs under a server-wide advisory lock, is
idempotent on the exact layout, and refuses anything else unchanged:

```ts
import {
  migratePostgresCommandJournal, migratePostgresTenantAdministrationJournal, migratePostgresTenantInvitations,
  migratePostgresTenantStore, provisionStores, type TenantStoreBinding,
} from '@mistriwork/mistri/maintenance';

const url = process.env.BUSINESS_DATABASE_URL!;
const binding: TenantStoreBinding = {
  appId: 'dealer-desk', source: { id: 'business', connection: 'business-db' }, storeId: 'dealer-desk-tenants',
};
await migratePostgresTenantStore(url, binding);                // { version: 2, migrated: true }
await migratePostgresTenantAdministrationJournal(url, binding); // with `administration` or `invitations`
await migratePostgresTenantInvitations(url, binding);          // only with `invitations`, after the journal
await migratePostgresCommandJournal(url);                      // only with --commands
await provisionStores({ postgres: url }, { app: { tenant: binding } }); // only when a command declares events
```

What differs from SQLite:

- **A database of its own.** Startup and every tenant read and write attest the
  whole catalog the connection sees, as SQLite attests the whole file. A read
  repeats the full comparison only when a digest of the catalog rows it reads
  has moved since that comparison last passed
  ([PostgreSQL guide](postgresql.md#tenant-apps)). Every
  visible table must be a declared resource or a reserved `__mistri_*` (or the PostgreSQL `mistri` schema)
  table, in every schema the role can use; a table the policy does not own
  refuses startup, and DDL anywhere in the database refuses the sources until
  restart. Another session's temporary tables do not count. The connection's
  `schemas` setting is refused.
- **Ownership columns** are `text` or `varchar` under a deterministic
  collation (every database default is). `character(n)` ignores trailing
  spaces and `citext` folds case, so both refuse ownership capture, and a
  nondeterministic ICU collation on an ownership column refuses the source.
- **Tenant-local uniqueness** is attested from `pg_index` by the SQLite rule:
  every unique index on a tenant-owned table includes the ownership column
  under a deterministic collation, except the primary key of a single opaque
  `text`, `varchar` or `uuid` identifier. Expression keys and exclusion
  constraints refuse.
- **The fence** is row locks held to COMMIT rather than a file-wide writer
  lock: a revocation waits for an in-flight business commit, and a business
  write waits for an in-flight revocation and then refuses. It is the write's
  only membership proof (see [what proves a write](#runtime-and-remaining-limits)). The
  [PostgreSQL guide](postgresql.md#tenant-apps) gives the lock order,
  and where each operation takes it.
- **Values.** `bigint` values, counts and integer sums arrive as exact decimal
  text, as everywhere on PostgreSQL.
- **Invitations and command events** start exactly as on SQLite, over storage
  the steps above provision and startup only attests. Each event batch commits
  beside its receipt inside the writer's fenced transaction, so a revoked
  membership writes none.
- **Effects:** a command's `post(...)` and `send(...)` are written
  beside its receipt in the tenant event store and delivered after commit,
  each delivery as the tenant it was written for. Their destinations are
  provisioned with the stores (`provisionStores` with the App's `commands`
  and its tenant binding) and only attested at
  startup; one that is not provisioned refuses, on either engine.

### Authentication on PostgreSQL

The tenant host's native auth store may be a SQLite file or a `postgres://`
store (`auth.store`, migrated beforehand with `migratePostgresAuthStore`),
beside a SQLite or a PostgreSQL business source. It must not be a business
database: startup compares the URLs, and native auth then asks each server who
it is and refuses a business role that can use the store's `mistri`
schema, as for any App ([PostgreSQL guide](postgresql.md#authentication-store)).

The strong session proof refuses the same things on either store — native
impersonation, a ban, an ended session and, for administration, a session
shortened after its context opened — but a PostgreSQL store cannot be read
synchronously inside a commit. It is read asynchronously at the owner's last
await before COMMIT instead: on every tenant request, again after a write's or
command's callback, and at each administration step, including target-account
checks. A revocation that commits after that read and before COMMIT is the one
window left: the write stands, and the next request is refused. Invitations on
a PostgreSQL business source work with either native auth store. On a SQLite
source they need the file-based store, because SQLite's final transaction
verifier is synchronous; startup refuses that pair and names it.

## Account-bound invitations

mistri implements local invitation issuance, reissue, revocation and
acceptance for **existing native accounts**, and for an **email address** that
becomes an account when the invitation is claimed, on SQLite or PostgreSQL. Public
`--policy` startup accepts an `invitations` declaration when the connection opts
into writes (`writable: true`), the invitation storage is provisioned, and every
role a grant names is one of the App's tenant-realm roles (a platform role in a
tenant membership could never be admitted, so startup refuses it). It sends no email, matches no mailbox, provisions no live
storage and enables no new registration mode; an invitation addressed to an
email creates that one account only when it is claimed with its one-time
token, and the address is not verified.

The server-only invitation policy is independent of `administration`. It names
exact native operator IDs, target tenants, allowed invitation operations and
role ceilings, plus maximum redemption/membership lifetimes and pending counts.
Ordinary business roles and native administrator status confer no invitation
authority. The reserved invitation namespace must be explicitly provisioned in
the same stopped, existing business database as the tenant store and
administration journal, with `provisionStores(…, { app: { tenant: binding }, only: ['tenant-invitations'] })`
from `@mistriwork/mistri/maintenance` (or `migratePostgresTenantInvitations`) ([provisioning](#provisioning)); acquisition attests rather than creates or
upgrades it.

The browser workflow is:

1. An authorized operator opens **Account → Manage invitations**, chooses an
   authorized tenant, enters an exact existing native recipient ID and reviews
   roles and separate redemption/membership expiry dates.
2. Issuance atomically creates a pending invitation, an `invited` membership
   reservation and a receipt/audit pair. Pending membership grants no business
   access. The issuer sees a one-time local handoff token; closing clears it.
3. The intended recipient signs in and opens **Account → Accept invitation**,
   enters the token, reviews the tenant/roles/expiry and explicitly accepts.
   Possession of a token does not substitute for the correct native account.
4. Acceptance activates the membership and consumes the invitation in the same
   transaction. The chooser refreshes, but the person must still explicitly
   select a tenant to acquire business access.

Reissue terminates the previous pending pair and creates fresh identities and a
new token. Revocation is terminal. Expiry does not silently release a pending
reservation; revoke or reissue it explicitly. Direct administrative revocation
of a linked invited membership also terminates its invitation. Issuer logout
alone does not revoke an invitation, but fresh acceptance rechecks the recorded
issuer's current eligibility, exact policy grant and the tenant revision.

These operations share the administration writer, not a second transaction
engine. Issuer and recipient contexts are separate, login-bound capabilities
that do not grant business access. Expected invitation, membership and tenant
versions protect existing transitions. A lost response retains the exact attempt
for **Check attempt status**, without automatic resubmission. A missing receipt
does not prove the operation failed. If issuance committed but its handoff was
lost, recover the receipt and explicitly reissue: status never regenerates the
original token. Recipient receipts omit issuer/policy/audit images.

Only a digest is durable. Raw tokens are excluded from receipts, audit, listings,
status, URLs and persistent browser storage; the intentional one-time local
handoff is the exception. Native account retirement clears private UI. Retained
browser attempts are memory-only, not recovery across reload. No distributed
transaction is claimed between the native auth store and business database.
On PostgreSQL, final storage attestation precedes the native session and account
observations. Those observations are sequential, not an atomic snapshot across
the auth and business databases.

For contributors, the browser proof uses
`e2e/support/tenant-invitation-fixture/playwright.config.ts` and fresh OS-temp
stores. `test/tenant-public-startup-cli.test.ts` starts the real CLI with
`--policy` on SQLite and on PostgreSQL and drives issue, preview, acceptance and
a command event over HTTP; `test/postgres-tenant-auth.test.ts` covers PostgreSQL
business storage with both native auth stores. There is no PostgreSQL browser
coverage yet.

## Tenant command events

A tenant App's `--commands` registry may declare `events`, as an ordinary App's
does. Each applied command
writes its batch beside its receipt and audit, inside the writer's transaction
that holds the tenant and membership fence to COMMIT: a revoked membership
writes none, a failed batch rolls back the whole command, and a replay or status
check never writes a second. Each envelope says `scope: 'tenant'`, its tenant,
its actor and the command's receipt. Provision the event store once, after the
command journal, with the same binding as the tenant store
(`provisionStores(<the database>, { app: { tenant: binding } })`
from `@mistriwork/mistri/maintenance`, [provisioning](#provisioning)); startup attests it
and never creates it.

Webhook `effects` are no longer refused on a tenant App: the host delivers
them per tenant, and an App's [integrations](../site/src/content/docs/docs/integrations.md)
keep each tenant's secrets and verify each tenant's webhooks at
`/api/inbound/<name>/<tenant>`, an inbound endpoint as a single App's
`defineInbound` is (jobs/inboundHost.ts). Nor is `--jobs` — a tenant App
runs jobs, each tenant's committed facts reaching a job that runs one of the
App's own commands fenced on that tenant ([tenant jobs](#tenant-jobs)).

<!-- Reserved for work in progress. Each block is one piece's own section:
     it writes only between its own markers, so pieces never edit each
     other's lines. Empty blocks render as nothing. -->

<!-- piece 1: platform-only sources -->
## Platform-only sources

Beside the App's own source, a tenant App with the platform realm may read
databases that belong to the platform alone, such as a lender's applicant
directory next to its dealers' business data. Each is a platform-only source:

```ts
sources: {
  business: { connection: 'business-db', default: true },
  applicants: { connection: 'applicants-db', realm: 'platform' },
},
resources: {
  'applicants.applicant': { owner: 'platform', fields: { read: ['id', 'name', 'status'] } },
},
```

- **What it declares, read only.** Every resource of the source says
  `owner: 'platform'` and no `access`. None of them takes `delete`,
  `favorite`, `validation`, `form`, `actions`, `transitions`, `file`, `tags` or
  `search`. Each is one ordinary table, found by its unique name or by its
  `physical` binding. Other tables in that database are tolerated and never
  read, and a key to or from one is dropped with it. The source is never the
  default, never the tenancy profile, never read signed out, and needs
  `auth.tenancy.platform`.
- **The platform realm reads it under `resolvePlatformRows`**, by qualified
  name (`'applicants.applicant': { groups: … }`). A declared table the policy
  does not name is denied. Queries, counts, views, breakdowns, references and
  page plans each go to the source that holds their table. No key crosses
  sources, so no join, path or reference does. Each read is one snapshot of
  that database, after revalidating the platform membership in the tenant
  store; the runtime checks the membership again before it releases the result.
- **Nothing else reaches it.** Tenant and member contexts, commands, intake and
  the tenant writer are built from the App without its platform-only sources:
  the tables are absent from their catalog and schema, and a tenant policy
  naming one is refused. At startup, a command that names the source, or looks
  it up, is refused in its own words. The App API serves the App's own data as
  usual — an App with a platform-only source may expose its own resources and
  views — but never that source: `api.resources` naming one of its resources,
  or `api.views` whose view reads one, is refused by name and by source when the
  App is read, and the checked tenant catalog refuses again anything an
  operation resolves to, so a filter, sort, standing question or reference hop
  cannot reach it either. The OpenAPI document and the MCP tool listing are
  rendered from that catalog, so neither can name one of its tables. A token
  acts through one tenant membership, so a `realm: 'platform'` view or command
  cannot be exposed either, even over one of the App's own tables — it is the
  business above the tenants looking across them; the platform realm keeps its
  views and commands, and only exposing them is refused.
- **Never written.** Its connection must not say `"writable": true`, and a
  generic write on the platform lease still answers 403.
- **Startup** takes one connection for the App's own source, one for each
  platform-only source, and no other. Each is an existing SQLite file or a
  `postgres://` URL, and never the App's own database or the authentication
  store under another name. A SQLite file is compared by canonical path, inode
  and sidecars. A PostgreSQL URL is compared by host, port and database before
  anything opens; enrollment then asks each server for its system identifier
  and database name, and a server that will not say is taken to be the same
  one. Startup and `mistri check` read each source's declared tables in one
  snapshot, and a missing one refuses.
- **DDL on a declared table refuses its reads until restart.** Every snapshot
  compares the declared tables' catalog and definitions with what the source
  opened with: the CREATE text on SQLite, and the `pg_catalog` description,
  under ACCESS SHARE locks, on PostgreSQL. DDL on a table it does not declare
  changes nothing.
- **`authority.lock`** records it as `source applicants realm platform read-only`.
<!-- end piece 1 -->

<!-- piece 2: tenant jobs and event delivery -->
## Tenant jobs

A tenant App runs `--jobs` beside `--policy` and `--commands`, with the same
`defineJobs` module an ordinary App uses (the site's *Events & durable jobs*
page describes jobs themselves):

```sh
mistri --config server.json --app ./app --policy ./tenant-policy.ts \
  --commands ./commands.ts --jobs ./jobs.ts
```

A job starts on a tenant command's event — any tenant's. Its delivery
destination takes every tenant's facts of the command it names (a route of
scope `tenants`), and the job carries the fact's tenant, read from the
verified envelope, never from its payload. It runs one command as a *service
principal*: the jobs module's name and roles, with no account and no
membership. Which realm it acts in is its command's:

| The job's command | Runs as | Fenced on | Reaches | Receipt namespace |
| --- | --- | --- | --- | --- |
| A tenant command | `service:<name>` in the fact's tenant; tenant-realm roles only | The tenant's row and `@platform`, at the versions read when the attempt started | That tenant's rows in the command's footprint | The tenant's |
| A platform command (`realm: 'platform'`) | `service:<name>` in the platform realm; platform roles only | `@platform`, at the version read when the attempt started | The platform's rows, and the fact's tenant's rows by key | The platform's (no tenant) |

- **Every attempt asks again.** The job must still be registered at its
  version, the App must grant the principal's roles the command, and the
  anchors that command fences must be active. `@platform` is one of them
  whatever the App declares: provisioning does not create it (the store's
  platform administration step does), and until it exists and is active no
  job runs. A tenant or platform suspended before an attempt fails it as
  `not_authorized`; redrive it once they are active again. A suspension that lands during an attempt refuses it with
  nothing applied (the writer holds the anchors to COMMIT: on PostgreSQL a
  suspension waits for an attempt that holds them, or commits first and is
  seen), and the next attempt asks again. Revoking the member whose command
  emitted the fact stops nothing.
- **One tenant, always.** The transaction's scope is the command's footprint
  within the fact's tenant, plus the platform's own rows in the platform
  realm, so a key naming another tenant's row is not found. A platform
  command's audit rows must name that tenant or the platform. The policy's
  row callbacks take a member's evidence and are not consulted for a service.
- **A service role is a job's.** A role marked `service: true` is held by a
  jobs module (or an integration) and by no person: provisioning, tenant
  maintenance and delegated administration refuse a membership that names
  one, in either realm, and startup refuses a policy whose role ceiling
  includes one.
- **Receipts** name `service:<name>` in the membership's place, at revision
  0, with its roles. The idempotency key comes from the job, its version and
  the event id, so a redelivered fact or a retried attempt lands on the
  receipt that exists.
- **Stores.** The tenant event store, one delivery destination per job and
  the job store are provisioned once, after the tenant store and the command
  journal. Startup and `mistri check` attest them in the enrollment snapshot
  and never create them:

  ```ts
  import { provisionStores, tenantJobPolicies } from '@mistriwork/mistri/maintenance';

  await provisionStores({ sqlite: file }, { app: { tenant: binding, commands, definition: app }, jobs }); // { postgres: url } on PostgreSQL
  const { store, destinations } = tenantJobPolicies(binding, { commands, jobs, app }); // for inspectJobs, redriveJobs, …
  ```

  `app` is the loaded App. Its machine timers run as jobs of the module, so
  provisioning wraps the module as startup does; a module of only mail or
  integrations then gets the job store its timers need.

- **One host.** The server opens one job host after enrollment, starts it
  once it listens and stops it first when it retires. `mistri check` prints
  one line per job.

A job at times (`every`) says which realm it runs in, and its command is of
that realm; one that says none is refused, since it would act for no one:

```ts
closeStale: defineJob({ every: '0 6 * * *', realm: 'tenant', runAs: 'clock', command: 'closeStale' }),        // once per active tenant
weeklyDigest: defineJob({ every: '0 7 * * 1', realm: 'platform', runAs: 'ops', command: 'weeklyDigest' }),  // once, platform rows only
```

A `'tenant'` job runs each slot once for every tenant active at that slot,
each run carrying its tenant and keyed by the slot and the tenant, so it runs
once per tenant however many processes see the slot; a suspended tenant is not
run. A `'platform'` job's run carries no tenant, and its scope holds no
tenant's row at all.

### Machine timers in a tenant App

A machine state's `after: { '3 days': 'expire' }` and a resource's
`at: { due_at: { command: 'breach', when: "status = 'open'" } }` are jobs of the
`--jobs` module, as on an App without tenants: a sweep a minute finds the
records in the state, or matching the `when`, whose time has come, and runs the timer's
command on each. On a tenant App the sweep reads every active tenant's due
records, and each run happens where its row is:

| The timer's resource | Its timer's command | Runs as | Reaches |
| --- | --- | --- | --- |
| Tenant-owned | A tenant command | `service:<name>` in the row's tenant, tenant-realm roles only | That tenant's rows in the command's footprint |
| Tenant-owned | A platform command | `service:<name>` in the platform realm | The platform's rows, and the row's tenant's rows by key |
| Platform-owned | A platform command | `service:<name>` in the platform realm, with no tenant | The platform's rows; no tenant's at all |

- **The tenant is the row's.** The sweep reads the owner column off each due
  row in the server; a run carries that tenant, and nothing a caller or a job's
  input says can change it. A job naming another tenant than its row's — a
  forged or redriven one — looks for the row inside that tenant, finds none,
  and changes nothing. A platform-owned record's run carries no tenant, and one
  that names a tenant is not admitted.
- **Fenced like every job.** Each run is admitted again on its tenant's row and
  `@platform`, and the writer holds both to COMMIT. A suspended tenant's records
  are not swept; they fire on the first sweep after it is active again. Each
  stay runs once — keyed by the timer, the tenant, the record and the moment it
  entered the state (or the instant an `at` column holds) — however many
  processes sweep.
- **No tenant starves another.** A sweep reads at most a hundred records a
  timer, and at most twenty of any one tenant, taken rank by rank across the
  tenants. A tenant with a thousand due records turns through them twenty a
  sweep while every other tenant's are taken alongside; a record whose timer
  left it in place (an `at` warning) is still reached on later sweeps; an `at`
  timer's records are read newest instant first, so one that just fell due is
  not behind every one that has fired already.
- **The principal is of the command's realm.** Each timer runs as the first
  principal granted its command whose every role is of that command's realm.

Startup and `mistri check` refuse, by name, rather than leave a timer unrun: a
timer on a global table (its rows are every tenant's and no one's); a tenant
command's timer on a platform-owned resource; a timer whose command only a
principal of the other realm is granted; and one no principal is granted.

#### A calendar-aware SLA clock

An SLA that counts business hours, skips holidays and pauses on hold needs
no clock primitive: the command that starts, pauses or resumes the clock works
out its instants with the App's own calendar code and stores them, and the
resource's `at` timers fire at those instants. A new instant re-arms the timer;
leaving the state its `when` names disarms it.

```ts
// resources.ts — the ticket keeps its warning and breach instants.
ticket: {
  owner: 'tenant',
  machine: machine('status', {
    open: { on: { hold: 'waiting', resolve: 'resolved', breach: 'breached' } },
    waiting: { on: { resume: 'open' } },
    resolved: { final: true },
    breached: { final: true },
  }),
  at: { warn_at: { command: 'warnSla', when: "status = 'open'" }, due_at: { command: 'breach', when: "status = 'open'" } },
},

// commands.ts — the calendar is the App's: addBusinessMinutes counts open hours in the desk's zone, skipping holidays.
resume: defineCommand({
  source: 'desk',
  target: 'ticket',
  async handle({ db, record, now }) {
    const left = Number(record.sla_minutes_left);
    await db.ticket.update(record, {
      status: 'open',
      warn_at: addBusinessMinutes(now(), left * 0.25, deskHours),
      due_at: addBusinessMinutes(now(), left, deskHours),
    });
  },
}),
```

`hold` stores the minutes left and moves the ticket to `waiting`, where no
timer runs; `resume` stores fresh instants, and the timers fire at them. The
warning command records the warning and leaves the ticket open; `breach` moves
it. Lists and the record page read `warn_at` and `due_at` as ordinary columns,
so a sweep a minute late never shows a wrong state. This replaces a job at
times that ticks every tenant every minute.

Still refused: a job whose
command declares events (no job starts another) or looks up; a principal
holding the other realm's roles; and `--jobs` with a row-policy App or
`--app-mcp`. The tenant host serves no readiness route, so the job host's
checks are read through maintenance inspection.
<!-- end piece 2 -->

<!-- piece 3: public maintenance (platform memberships, tenants, seed accounts) -->
## Sandboxes: clone, import and a dev clock

A tenant's owner can try a change on a copy of their tenant first, and bring
it back once it works. A resource opts in with one key:

```ts
resources: {
  pipeline_stage: { owner: 'tenant', clone: 'config' },  // copied, and imported back
  sla_rule: { owner: 'tenant', clone: 'config' },
  ticket: { owner: 'tenant', clone: 'sample' },           // copied when asked; never imported
}
```

`clone` is allowed only on a tenant-owned resource of a tenant App. Startup
judges the marks as a whole and refuses what a copy could not keep intact: a
key the database counts out (an identity column, a `nextval` default), a
configuration row whose required reference names a sample or an unmarked
table, and a cycle between tables. A key beside the tenant column is kept;
one opaque id is rewritten to a stable UUID derived from the new tenant, the
resource and the old id, and every reference to it follows. The profile row
is copied with its address and other unique columns cleared.

**Clone.** In Manage tenants, the owner of a tenant holding the delegated
`cloneTenant` operation makes a sandbox named after their own tenant
(`north-sandbox…`), optionally with samples, and becomes its member with the
roles they hold in the source. An operator's rule must name both tenants. The
copy reads only the source's rows and writes only the sandbox's, in one
transaction with its receipt. A sandbox is marked as one wherever its name is
said (a Sandbox chip beside it in the bar and the chooser), and it is never
cloned again.

**Import.** The source's owner reads the plan (what would be added, changed
and removed in the `config` resources, and each conflict) and approves it,
through their own membership in the live tenant; an operator's rule never
grants `importTenant`. Each copied row keeps the digest it had when copied,
so a row both sides changed, a row the live tenant removed and the sandbox
changed, a new row whose key the live tenant took, and a reference to a row
the live tenant does not have are each a conflict. Any conflict refuses the
whole import. An import writes only the sandbox's own source, and never
another tenant; samples stay in the sandbox.

**Dev clock.** `mistri tenant clock <sandbox> --ahead 3d [--rate 60]` sets
a sandbox's clock ahead of real time, and its machine timers fall due on it.
Only a sandbox has one: the step refuses a live tenant, and the timer sweep
reads clocks only from the sandbox store, where a live tenant has no row. The
deployment's own clock, which every lease and fence reads, is never moved.

The store is provisioned like the others, once:
`provisionStores(<the database>, { app: { definition } })` from
`@mistriwork/mistri/maintenance` (`only: ['tenant-sandboxes']` names it alone, and is refused
for an App that marks no `clone`); a start
whose App marks `clone` refuses without it. `mistri tenant clone|import|clock`
does the same steps from the operator's shell (`import` only prints the plan).

Not yet: an import's writes are not in record history, and a command's
`now()` in a sandbox still reads real time; only machine timers follow the
dev clock.

## Tenant maintenance

A deployment seeds and looks after its tenant store from its own scripts with
the tenant steps of `@mistriwork/mistri/maintenance`, or, for the first boot, with
`mistri tenant init` and `mistri tenant grant`, which make the same
steps from a shell ([Deploying a tenant App](#deploying-a-tenant-app)). They are the only way to manage
the platform realm's staff: platform memberships have no administration
operation and no HTTP surface.

```ts
import {
  createAppAccounts, grantPlatformMembership, grantTenantMembership, putTenant, revokePlatformMembership,
  revokeTenantMembership, setPlatformStatus,
} from '@mistriwork/mistri/maintenance';

const where = { postgres: process.env.BUSINESS_DATABASE_URL! };  // or { sqlite: './business.db' }
const app = './apps/lending';                                   // the App directory
const operator = 'ops-ada';                                      // who ran the step, for the receipts
const [lee, sam] = await createAppAccounts(app, [
  { email: 'lee@lender.example', name: 'Lee', password: leePassword },
  { email: 'sam@north.example', name: 'Sam', password: samPassword },
]);
await setPlatformStatus(where, binding, { status: 'active', expectedVersion: null, operator });
await putTenant(where, binding, { tenantId: 'north-motors', status: 'active', expectedVersion: null, operator });
const validUntil = Date.now() + 180 * 24 * 60 * 60 * 1000;
await grantPlatformMembership(where, binding, { app, accountId: lee, roles: ['manager'], validUntil, operator });
await grantTenantMembership(where, binding, { app, tenantId: 'north-motors', accountId: sam, roles: ['dealer_admin'], validUntil, operator });
```

- **`putTenant`** creates a tenant (`expectedVersion: null`, which starts it
  active) or changes its status at its current version: suspend, reactivate,
  or close it for good. **`setPlatformStatus`** does the same for the
  platform's reserved `@platform` row; suspending it stops the whole realm.
- **`grantPlatformMembership`** and **`grantTenantMembership`** grant one
  active membership to an existing account, returning `{ membershipId,
  version, receiptId }`. Their ceilings are the App at `app`, loaded as the
  server loads it, whose id must be the binding's: a platform grant takes the
  App's platform-realm roles only, a tenant grant its tenant-realm roles only,
  and `validUntil` is a future instant at most 366 days away. The anchor
  (`@platform`, or the tenant) must be active, and an account holds one live
  membership there: revoke one before granting another. The account must
  exist in the App's auth store, which is read before the transaction, not in
  it.
- **`revokePlatformMembership`** revokes one at its current version, for good.
  The support sessions opened under it (below) end in that same transaction,
  with end reason `parent_revoked`, and `supportRevoked` names the ones it
  ended. Ending access is never blockable: a session whose audit chain no
  longer verifies is revoked all the same, and `supportChainUnverified` names
  it rather than the step refusing — otherwise anyone able to edit an audit
  row could keep the access that row covers. A missing or wrong audit key does
  still refuse, because that is repairable: set the key the audit was
  provisioned with and revoke again.
- **`revokeTenantMembership`** revokes one active tenant membership,
  `{ tenantId, membershipId, expectedVersion, operator }`, at its current
  version and for good. It is idempotent: one already revoked is left as it is
  and answered with its version and `receiptId: null`. An invitation's pending
  membership is withdrawn with its invitation, through tenant administration.
  `mistri shot --as <role> --tenant <id>` grants its temporary account a
  membership with these steps (operator `mistri-shot`) and revokes it when
  the shot ends, on a failure or an interrupt too.
- **`createAppAccounts`** makes native accounts in the App's own auth store
  (a file store that does not exist yet is created, as a first start would),
  through its native user creation, with the store's default native role, and
  returns their ids in order. The App must sign in with email. If any address
  already has an account, none is made. Passwords are never logged, returned
  or repeated in a refusal.

Every store step is one transaction on the business database, SQLite or
PostgreSQL, on the same store capability and administration journal tenant
administration uses, so the administration journal must be provisioned. The
change and a receipt/audit pair commit together, under the actor
`maintenance:<operator>` and an operation name of its own, with the before
and after images. A stale version, a missing or closed row or a refused
ceiling throws `TenantMaintenanceRefusal` and writes nothing. Its `outcome` is
`unknown` only when the commit was sent and its answer lost: read the store
before retrying, since every call is its own attempt. On PostgreSQL the
anchor row is locked before the membership, the order the business fences
take, so a grant or revocation waits for an in-flight business commit.
<!-- end piece 3 -->

<!-- piece 5A: support opening, exit, status and lease -->
## Support sessions: enter as a dealer (5A)

*5A covers opening, exit, status and the support lease. It grants no business
access yet: every read and write under a support lease is refused with
"Support access is not available yet." until the audited business path lands
(5B).*

A platform member can enter one dealer for a short, audited session, holding
one of that dealer's roles. The tenant policy declares who may do so:

```ts
support: { id: 'lender-support', version: '1', grants: [
  { platformRole: 'reviewer', tenants: ['north', 'parkside'], dealerRoles: ['dealer_staff'] },
  { platformRole: 'lender_admin', tenants: 'all', dealerRoles: ['dealer_admin', 'dealer_staff'] },
] }
```

A grant is matched whole: the caller's live platform membership holds
`platformRole`, the dealer is named (`'all'` means every *active* dealer), and
the one requested role is in `dealerRoles`. Roles are never unioned, whether
from two grants or from the platform role itself. `platformRole` must be a
platform-realm role and every `dealerRoles` entry a tenant-realm role, or
startup refuses. One grant per platform role.

The timing is fixed in code, not in policy:

- Opening needs a native sign-in created no more than five minutes ago. An
  older login is asked to sign in again; that creates a new native session.
- A session lasts the least of thirty minutes, the native session's expiry and
  the parent platform membership's validity. Nothing renews it.
- Status and exit need the same native login, not a recent one. An expired
  session is not revived to be exited: the next `status` call is what closes
  it, revoking the row and appending `expired` to its chain. It already holds
  the locks and has read the row, so a session never outlives its thirty
  minutes waiting for a scheduler.

`POST /api/tenant/support/open`, `/exit` and `/status` take the native login's
cookie and `x-mistri-account`. They take no tenant, tab or lease header,
and never a bearer token. Opening runs in one administration transaction on
its own writer. It closes the account's previous session (end reason
`superseded`, whatever its dealer or login), inserts the support membership,
opens its audit chain and commits an `openSupport` receipt. Any failure rolls
all of it back. On PostgreSQL every support operation takes its receipt scope,
then `@platform`, the parent memberships, the dealers and the support rows
`FOR UPDATE`, in that order; platform-membership maintenance also takes
`@platform` first. So a revocation and an opening wait on each other rather
than deadlock.

A lost acknowledgement is recovered with `status` and the exact attempt
(`{ attempt: { idempotencyKey, intent } }`); retrying `open` with the same key
replays the receipt and never creates a second session. An attempt's receipt is
bound to the deployment it ran in. `status` with `{ resume: true }` returns the
live session of this very login and a new support lease. After a restart, only
the native session that opened it can resume it.

The support lease (`realm: 'support'`) is admitted through a fence on the
support row, its parent membership, `@platform`, the dealer and the audit
session of the same native login. In 5A it is good for status and exit only.
Under support, and while the account holds a live session, these are refused:
invitations, membership changes and every other administration route
(`tenant_support_active`), switching tenant or to the platform, renewal as an
ordinary lease, nested support, exports (the tenant host has none) and App API
tokens.

The platform realm's **commands** are refused for the whole account, not only
for the tab inside the dealer: while a session is live, the operator's other
platform tab may not act as the platform either, even though its own lease is
untouched and current (`tenant_support_active`). That tab's platform **reads**
still answer, so an operator can still see what they were reading before they
entered. Looking is not acting.

Revoking the operator's own platform membership ends every session opened under
it, in that one transaction and with end reason `parent_revoked`
(`revokePlatformMembership`, above). The dealer's rows are out of reach at once:
the lease's fence reads the parent, so it refuses as soon as the row is gone.

The session start and end go to the support audit store. Layout 2 records the
operator's display name and reason in the MAC-covered header; the email stays
platform-side, in the native auth store. A layout 1 store is refused: reseed
it. Provision the store once after the tenant store and administration journal:
`provisionStores({ sqlite: path }, { app: { tenant: binding }, only: ['tenant-support-audit'] })`
from `@mistriwork/mistri/maintenance` (or `migratePostgresSupportAudit(url, binding)`), with
`MISTRI_AUDIT_KEY` (at least 32 bytes, kept apart from
`BETTER_AUTH_SECRET`) set for provisioning and for every start. Startup
attests the store and refuses without the key, without `writable: true`,
without the platform realm, and on a SQLite source with a PostgreSQL
authentication store.

In the browser, a platform lease offers **Enter {tenancy label}** ("Enter
dealer" in Ignition, "Enter tenant" when `auth.tenancy.label` is unset). The
dialog asks for the tenant, the role and a one-line reason, plus a password
when the login is older than five minutes. While inside, a warn-toned banner names the tenant,
the role and the end time, with **Exit**. It announces the last two minutes,
and a cover returns the operator to the platform when the session ends.
<!-- end piece 5A -->

<!-- piece 5B: audited support path and dealer log -->
### What a support session records (in progress)

A resource says what the support write trail keeps of its rows:

```ts
resources: {
  application: { access: 'write', owner: 'tenant', audit: { redact: ['ssn', 'bank_account'] } },
  note: { access: 'write', owner: 'tenant', audit: { redact: 'values' } },
}
```

`redact: 'values'` marks every column; a list names this resource's own. A
marked column is recorded as a keyed hash instead of its value — in a change
and in a delete's before image alike — and every other column keeps its value.
So a dealer's log can say what an operator did without the audit becoming a
second copy of the data. The rule sits on the resource because it is a fact
about the rows, not about one writer.

#### Reading as a dealer

A support session may read the dealer it entered, and nothing else. The request
names its realm beside the dealer:

```
POST /api/query?app=<id>&realm=support&tenant=<dealer>
```

Addressed as the dealer's own lease (`?tenant=` alone) the same read is still
refused, because only a request that names the support realm is routed to the
family that can ledger it. The rows come back under the dealer's own row rules
— the same single policy rule a member of that dealer reads by, never a second
rule that could disagree — so a session can never see more than that dealer's
member would.

**Each read is ledgered before its answer is released.** The entry commits in a
short writer transaction of the support owner's own, after the body exists and
before a byte of it is sent. A read whose entry cannot be committed is refused
with `tenant_support_refused`; it is never truncated, and never quietly served
unrecorded. That ordering is the whole point of the ledger, so it is pinned by
a test that makes the append impossible and asserts the dealer's rows do not
appear in the refusal.

**A support session still acts on nothing.** Save, New, Delete, Undo and every
command are refused on a support lease — in its own realm as much as outside it
— and its context is presented with no writable resources and no commands, so
the UI never offers a button that would only ever be refused. The write trail
above is declared and its sink is built, but no path reaches it yet. A
half-built path that opened business writes while auditing unreliably would be
worse than the refusal.

#### The dealer's log

```
GET /api/tenant/support/log?app=<id>&tenant=<dealer>
```

A dealer's own view of support visits into it, on that dealer's tenant lease,
for a tenant role the App granted the `support` operation:

```ts
auth: { roles: { dealer_admin: { realm: 'tenant', read: true, operations: ['support'] } } }
```

It shows the operator's display name, the platform realm's label as the App
names it ("Lender"), the dealer role the session held, its reason, when it
opened and ended, how it ended, how many reads it made, and the changes it
made. It never shows the operator's email, the native session, a row version,
a MAC, a policy id or a receipt id — the email belongs to the lender's own
audit view, because the dealer is owed the fact of the visit and the person's
name, not a way to correlate the lender's staff.

A change shows only the columns the viewer's own grants let it read. The rest
are named in `withheld`, so the log says that something was changed without
showing what; columns the resource's `audit` block marks remain the keyed hash
the write trail stored, for a reader who holds the log but not the key.

In the browser, a member holding the grant is offered **Support visits** beside
the tenant control — the same place a lender is offered "Enter dealer", which
is the other side of the same feature. The entry appears on the App payload's
`supportLog`, a runtime answer beside `writableTables`: roles are per-tenant, so
nothing before a lease can know it, and a member without the grant is offered
nothing rather than a button that would be refused.

**A dealer sees, it does not gate.** There is deliberately no approve or block
route. Access is granted by the policy, and ending it is administration's; what
this adds is that the dealer can tell it happened.

Both views show the newest 100 visits, each with its reads and changes, and
say `more: true` when older ones exist; the browser says so under the list.
The audit keeps every visit — this bounds what one answer carries, not what is
recorded — and a dealer's visits are read by an index on the tenant and the
time a visit opened.

The tenant whose history is read is the one the lease admitted, never an id in
the request, and it is filtered again in SQL and once more in the projection.
One dealer seeing another's visits is the failure this view exists to prevent,
so each of those layers has its own test rather than resting on the next.

#### The lender's audit view

```
GET /api/tenant/support/sessions?app=<id>&realm=platform
```

Every dealer's sessions, on a platform lease, for a platform role granted
the same `support` operation:

```ts
auth: { roles: { lender_admin: { realm: 'platform', read: true, operations: ['support'] } } }
```

It carries everything a dealer's log does, plus the dealer each session
entered and **the operator's email**, which appears nowhere else. The address
is looked up when the view is read rather than recorded when the session
opened, so that the record a dealer reads cannot contain one at all.

The two views never cross: one word, `operations: ['support']`, reads the
half that belongs to the role's realm, so a tenant role cannot ask for every
dealer's history and a platform role has no dealer of its own to read. A
feature never grants it — who reads a dealer's history is the App's to say. A
dealer's tenant lease is not a way into every dealer's history, whatever
grants that dealer holds.

On the platform context, a platform role granted `support` finds **Support
sessions** beside the tenant switch: this view, read on its platform lease. The
browser UI has not been taught the support realm, so an operator inside a
dealer still sees nothing of it: the audited read path exists on the transport
ahead of the screen that will use it. The dealer's own log is drawn, because it
reads on an ordinary tenant lease and needs none of that.
<!-- end piece 5B -->

<!-- piece 6: delegated administration and account-creating invitations -->
## Delegated administration and account-creating invitations

**Delegates.** Beside `operators`, which name native account ids, the
`administration` and `invitations` policies may name `delegates`: a tenant's
own members administering it.

```ts
administration: {
  id: 'dealer-management', version: '1', maxMembershipLifetimeMs: 180 * 24 * 60 * 60 * 1000,
  operators: [],
  delegates: [{ role: 'dealer_admin', operations: ['grantMembership', 'replaceMembership', 'revokeMembership'],
    roles: ['dealer_admin', 'dealer_staff', 'dealer_viewer'] }],
},
invitations: {
  id: 'dealer-invitations', version: '1', maxMembershipLifetimeMs: 180 * 24 * 60 * 60 * 1000,
  maxRedemptionLifetimeMs: 7 * 24 * 60 * 60 * 1000, maxPendingPerTenant: 50,
  operators: [],
  delegates: [{ role: 'dealer_admin', operations: ['issueInvitation', 'revokeInvitation', 'reissueInvitation'],
    roles: ['dealer_staff', 'dealer_viewer'] }],
},
```

An account holding an active membership with `role` in a tenant may run the
rule's `operations` in that tenant only, within its `roles` ceiling. Delegates
never create a tenant or change its status. Operators stay as they were, and
where an operator grant and a delegate rule both cover a tenant and operation,
the operator grant decides. `operators` may then be empty. Each operation has
at most one delegate rule, so a member who holds two delegate roles never
combines their ceilings. Startup refuses a delegate role or ceiling that is
not one of the App's tenant-realm roles.

What makes a delegate a delegate is read, never asserted: the delegate's own
membership, from the tenant store, inside the same transaction as the change.
On SQLite that is the writer's `BEGIN IMMEDIATE`; on PostgreSQL the tenant row
and then the delegate's membership are locked `FOR UPDATE` until COMMIT. So a
delegate demoted or revoked at the same moment either waits for the change or
refuses it. Only an ordinary member row of an active tenant qualifies: never a
support membership, a platform membership or a pending invitation's
reservation. A delegate never replaces or revokes its own membership, and a
membership listing never offers it. Receipt recovery rechecks the delegate's
current membership, as it rechecks an operator's current grant. An invitation
a delegate issued is accepted only while the delegate still holds the role,
and the rule and ceiling still cover the invitation.

**Account-creating invitations.** An issuer may invite an email address
instead of an existing account id: `issueInvitation` with `email` in place of
`accountId`, when the App signs in with email. The reservation is held for the
address's principal, `email:<address>`, which no native account can be, so it
admits nobody. The one-time token shown to the issuer is the handoff, as for
any invitation. The address is not verified: whoever holds the token claims the
invitation.

The person claims it signed out, from the sign-in screen's **Have an
invitation?** form: token, name and a password typed twice. That form sends
`POST /api/tenant/invitations/claim?app=<id>` with `{ token, name, password }`.
The server checks the token first: pending, unexpired, the inviter still
authorized, the tenant active at the version the invitation was issued
against. It then creates the native account under the invitation's address
and accepts the invitation for it. The acceptance ends the placeholder pair,
as reissue ends one, and gives the new account an active membership on the
same terms. The answers are:

- `200` `{ outcome: 'applied', account: 'created', email, result }`: the
  person signs in and chooses the tenant.
- `403` `tenant_invitation_unavailable`: one identical answer for a token
  that is unknown, wrong, spent, revoked, expired or no longer authorized.
- `409` `account_exists`: the address already has an account. The person
  signs in and accepts through **Account → Accept invitation** with the same
  token, which works for an email invitation when the signed-in account's
  address is the invited one. Only a caller holding a valid token ever
  receives this answer.
- `400` `invalid_account`: the name or password was refused. This is checked
  before the token is.
- `503` `claim_incomplete`: the account was created and the acceptance was
  not confirmed.

Account creation and acceptance are two stores, the native auth store and the
business database, so a claim is not atomic. If acceptance fails after the
account exists, the invitation is still pending and the token still works:
sign in and accept it. The route takes the public forms' rate limits (five a
minute and thirty an hour per client, three hundred an hour in all, one budget
shared with the forms). It also takes their checks: its own origin only, no
`x-mistri-*` header, `?app=` alone.
<!-- end piece 6 -->
