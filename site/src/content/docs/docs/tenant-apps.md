---
title: Tenant Apps
description: Serve several organizations from one App, each member seeing only their own organization's rows, with the platform that runs them above.
---

Serve several organizations from one App, each member seeing only their own
organization's rows, with the platform that runs them above.

```sh
mistri check --app ./leads --policy ./leads/server/tenant-policy.ts --commands ./leads/commands.ts
```

Each dealer is a tenant; the lender above them is the platform:

```ts
auth: {
  providers: ['email'],
  // A sign-in grants nothing until a membership does: the dealer's owner
  // invites its people, the platform's operators grant its own.
  rows: 'tenant',
  tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
  roles: {
    owner: { label: 'Owner', realm: 'tenant', read: dealerReads, commands: financing },
    // …
    automation: { label: 'Automation', realm: 'platform', read: ['loan_application', 'decision_alert'], commands: ['flagLateDecision'] },
  },
},
```

<!-- no sample: no shipped example is a tenant App. no picture: a tenant's pages look like any App's. -->

## What you'll see

- After sign-in, a chooser of the tenants the person is a member of; their roles come from that membership, not the account. A person with one membership goes straight in, unless the address names another tenant.
- Every list, record and form inside the chosen tenant: the server gives a new row the tenant's ownership column, and no reply carries it. The bar's bell holds that tenant's notices.
- Platform staff in a realm of their own, and a short, audited, read-only support visit into one tenant when the policy allows it.

## When to use it, and when not

- Use a tenant App when each customer is an organization with its own members, roles, invitations and administration, sharing one database and one App.
- Use a [row policy](/docs/row-access/) instead when one organization's people see different rows, without separate memberships.
- Use separate Apps, or a [suite](/docs/suites/), when the organizations share nothing at all.

## Options

| Part | What it does | Status |
| --- | --- | --- |
| `auth.rows: 'tenant'` | Scopes every row by tenant membership | Stable |
| `auth.tenancy` | `label` (what a tenant is called), `profile` (its one-row table), `platform` (the realm above) | Stable |
| A role's `realm` | `'tenant'` or `'platform'`; every role says one once a platform is declared | Stable |
| A resource's `owner` | `'tenant'` (each tenant's own), `'global'` (read by all, never written), `'platform'` (no tenant reads it) | Stable |
| `defineAppTenantPolicy` | The server-only policy: ownership columns, rows, administration, invitations, support, intake, public reads | Stable |

Tenant Apps run on SQLite and PostgreSQL. The server loads the policy with
`--policy`, and a database holds one tenant App:

```sh
mistri check --app ./leads --policy ./leads/server/tenant-policy.ts --commands ./leads/commands.ts
mistri --config tenant.json --app ./leads --policy ./leads/server/tenant-policy.ts --commands ./leads/commands.ts
```

### The policy and its store

`defineAppTenantPolicy` from `@mistriwork/mistri/policy` says which column owns each
table, which rows a member and the platform read, who may administer
memberships and issue invitations, and who may enter a tenant for support. Its
`ownership` must agree with each resource's `owner`, or the App does not start.
Open the first tenants and give the first operator a membership with
`mistri tenant init` and `mistri tenant grant`
([A tenant App in production](/docs/build-and-deploy/#a-tenant-app)), or from a
script with `putTenant` and `grantTenantMembership` from `@mistriwork/mistri/maintenance`.

A whole policy; each part past the first six is optional, and
`mistri check --policy` names a part that is wrong:

```ts
import { defineAppTenantPolicy } from '@mistriwork/mistri/policy';

const DAY = 24 * 60 * 60 * 1000;
const dealerRows = { lead: true, listing: true, rate_card: true } as const;
// The operator who creates and suspends dealers: an existing account, by id.
const operator = process.env.LENDER_OPERATOR_ID ?? 'operator-account-id';

export default defineAppTenantPolicy({
  kind: 'tenant',
  appId: 'leads', // the App's id
  storeId: 'leads-tenants',
  ownership: {
    dealer: { kind: 'platform' }, // the profile table: one row per tenant
    decision_alert: { kind: 'platform' },
    rate_card: { kind: 'global', access: 'read-only' },
    lead: { kind: 'tenant', column: 'dealer_id' },
    listing: { kind: 'tenant', column: 'dealer_id' },
  },
  // A member reads a row only where both answer for its table; the server adds the tenant to each.
  resolveMembershipRows: () => dealerRows,
  resolveRows: (member) => (member.roles.includes('owner') ? dealerRows : { ...dealerRows, rate_card: false }),
  resolvePlatformRows: () => ({ ...dealerRows, dealer: true, decision_alert: true }),
  // Without it, a member's Delete of a tenant row is refused.
  authorizeDeletedRecord: (member, image) => image.table === 'lead',
  // With --commands: one per registered command, naming the rows its result points at.
  resultReferences: { submitLead: (result) => [{ table: 'lead', key: { id: (result as { id: string }).id } }] },
  administration: {
    id: 'leads-administration',
    version: '1',
    maxMembershipLifetimeMs: 366 * DAY,
    operators: [
      { accountId: operator, tenants: ['north', 'south'], operations: ['createTenant', 'setTenantStatus'], roles: [] },
      { accountId: operator, tenants: ['north', 'south'], operations: ['grantMembership', 'revokeMembership'], roles: ['owner'] },
    ],
    // A tenant's owner manages its own staff and sandboxes, never an owner.
    delegates: [{ role: 'owner', operations: ['grantMembership', 'revokeMembership', 'cloneTenant', 'importTenant'], roles: ['staff'] }],
  },
  invitations: {
    id: 'leads-invitations',
    version: '1',
    maxMembershipLifetimeMs: 366 * DAY,
    maxRedemptionLifetimeMs: 7 * DAY,
    maxPendingPerTenant: 50,
    // The operator invites each dealer's first owner; the owner invites its staff.
    operators: [{ accountId: operator, tenants: ['north', 'south'], operations: ['issueInvitation'], roles: ['owner'] }],
    delegates: [{ role: 'owner', operations: ['issueInvitation', 'revokeInvitation', 'reissueInvitation'], roles: ['staff'] }],
  },
  support: { id: 'leads-support', version: '1', grants: [{ platformRole: 'automation', tenants: 'all', dealerRoles: ['staff'] }] },
  intake: { address: 'intake_address' },
  public: { address: 'public_address' },
  resolvePublicRows: () => ({ listing: { groups: [[{ column: 'status', op: '=', value: 'published' }]] } }),
  assistant: { tokensPerTenantPerDay: 200_000, retentionDays: 30 },
  decisions: { callsPerTenantPerDay: 2_000, retentionDays: 180 },
});
```

### Policy reference

| Key | Type | Default | Limit |
| --- | --- | --- | --- |
| `kind` | `'tenant'` | required | |
| `appId` | the App's `id` | required | 256 characters |
| `storeId` | text naming the tenant store | required | 256 characters |
| `ownership` | per table: `{ kind: 'tenant', column }`, `{ kind: 'global', access: 'read-only' }` or `{ kind: 'platform' }` | required | 1 to 256 tables, at least one `'tenant'` |
| `resolveMembershipRows` | `(member) => RowScope` | required | |
| `resolveRows` | `(member) => RowScope`, for the roles a request acts under | required | |
| `resolvePlatformRows` | `(member) => RowScope` | none | required once a table is `'platform'` |
| `authorizeDeletedRecord` | `(member, image) => boolean` | none: a member deletes no tenant row | |
| `resultReferences` | per command id, `(result) => [{ table, key }]` | none | one per command under `--commands`; 4096 |
| `administration.id`, `.version` | text | required | 256 characters |
| `administration.maxMembershipLifetimeMs` | milliseconds | required | 1 to 366 days |
| `administration.operators` | `[{ accountId, tenants, operations, roles }]` | required | 256 rules, each 1 to 256 tenants; empty only beside `delegates` |
| `administration.delegates` | `[{ role, operations, roles }]` | none | each operation in one rule |
| `invitations.id`, `.version` | text | required | 256 bytes |
| `invitations.maxMembershipLifetimeMs` | milliseconds | required | 1 to 366 days |
| `invitations.maxRedemptionLifetimeMs` | milliseconds | required | 1 to 7 days |
| `invitations.maxPendingPerTenant` | count | required | 1 to 10000 |
| `invitations.operators` | `[{ accountId, tenants, operations, roles }]` | required | 256 rules, each 1 to 256 tenants; empty only beside `delegates` |
| `invitations.delegates` | `[{ role, operations, roles }]` | none | each operation in one rule |
| `support.id`, `.version` | text | required | 256 bytes |
| `support.grants` | `[{ platformRole, tenants: 'all' or [ids], dealerRoles }]` | required | 1 to 256, one per platform role; 1024 tenants; 256 roles |
| `intake.address` | a text column of the profile table | none: no public form | needs a `'platform'` table |
| `public.address` | a text column of the profile table | none: no public reads | needs a `'platform'` table; comes with `resolvePublicRows` |
| `resolvePublicRows` | `(visitor) => RowScope` | none | comes with `public` |
| `assistant.tokensPerTenantPerDay` | tokens | the App's own caps | 1 to 1000000000 |
| `assistant.retentionDays` | days | 90 | 1 to 3650 |
| `decisions.callsPerTenantPerDay` | model calls | no cap | 1 to 100000000 |
| `decisions.retentionDays` | days | 365 | 1 to 3650 |

Administration operations: `createTenant`, `setTenantStatus`,
`grantMembership`, `replaceMembership`, `revokeMembership`,
`setTenantAssistant`, `cloneTenant` and `importTenant`; a delegate takes any
but the first two, and `importTenant` is a delegate's alone. Invitation
operations: `issueInvitation`, `revokeInvitation` and `reissueInvitation`.
A rule's `roles` is the ceiling of what it grants, and no two operator rules
grant one account the same operation on the same tenant.

A role's `write` on a tenant table gives it Save and New there; Delete needs
`authorizeDeletedRecord` as well; `mistri check` warns
(`tenant-delete-unauthorized`) where a role writes a tenant table and the policy
has none. A role's `commands` runs a record's command only where an action or
form offers it (`action('Record payment', { command: 'recordPayment' })` on the
resource), as in any App; `mistri check` warns (`command-unoffered`) of a
command that names a record and that nothing offers.

### Provision the stores

Startup never creates a tenant App's stores. With the server stopped, make them
with the flags you start it with:

```sh
mistri migrate stores up --app ./leads --policy ./leads/server/tenant-policy.ts --config tenant.json
```

This makes the tenant store, the administration, invitation and support audit
journals the policy declares, and the command journal, event store, sandbox
store and record history where the App uses them; one already there is left
alone. With `support`, set `MISTRI_AUDIT_KEY` first: the audit store is set up
under that key, and `mistri check` verifies it against the same key. When a
store is absent, check and a start name it and print this command. In code,
`provisionStores` from `@mistriwork/mistri/maintenance` does the same, one store at a time
(`only: ['tenant-store']` with `app: { tenant: binding }`).

`mistri dev ./leads --policy ./leads/server/tenant-policy.ts --commands ./leads/commands.ts`
prints a sign-in per role: each account is a member of the first two tenants of
the profile table, or of the platform realm for a platform role. In tests,
`host.tenant(id, { roles })` makes a member the same way
([Test an App](/docs/testing-apps/#tenant-apps)).

### Keys in a tenant App

Two rules hold for every tenant-owned table, and check refuses a table that
breaks one, naming the table and the fix:

- Its primary key includes the ownership column (`primary key (tenant_id, id)`),
  or it is a single opaque text id declared `id text not null primary key`
  (a `uuid` also serves on PostgreSQL). Write the `not null`: a nullable key is
  refused. An `integer` or `serial` id counts across every tenant, so it needs
  the first form.
- Every unique index includes the ownership column (`unique (tenant_id, code)`),
  so uniqueness holds within one tenant.

### Upgrading the stores

Startup never migrates a tenant App's stores: it refuses one behind its layout
and prints the command that moves it forward. Stop the server, [back up the
business database](/docs/build-and-deploy/#back-up-and-restore), then:

```sh
mistri migrate stores status --app ./app --config server.json
mistri migrate stores up     --app ./app --config server.json
```

`--app` upgrades the stores the database holds, all tenants at once, each
step in one transaction; it creates none unless `--policy` is given. There are
no down steps: to go back, restore the backup and run the previous mistri.

### The platform realm

A platform role reads what `resolvePlatformRows` grants. It edits the
platform's own `access: 'write'` resources with Save, New and Delete by naming
them in `write` (`write: ['dealer', 'rate_card']`), and changes a tenant's rows
only through commands registered with `realm: 'platform'`. The profile's key
and address columns are read-only, its rows are never made by New, and Delete
is offered only where no key refers to the table. Every root nav group and
platform view says its `realm`. The tenant chooser, the bar and the consoles
call each tenant by its `profile` row's record name.

A platform command writes the platform's rows and updates a tenant's. To insert
or remove a tenant's rows it names the one tenant it acts in, by an input field:

```ts
seedDesk: defineCommand({
  realm: 'platform',
  tenant: 'customer_id',
  source: 'business',
  target: 'desk_setting',
  targets: 'none',
  // desk_setting.tenant_id references customer: a write proves the rows it points at are readable.
  read: ['customer'],
  input: { customer_id: { label: 'Customer', type: 'text' } },
  async handle({ db }) {
    await db.desk_setting.insert({ id: 'default', timezone: 'UTC' });
  },
}),
```

The resource it writes says `access: 'write'`, a platform role grants it
(`commands: ['seedDesk']`), and a form runs it from the platform realm
(`commandForm('Seed a desk', 'seedDesk', { realm: 'platform' })`). Its
footprint reads every table the inserted row points at, the ownership column's
parent included; `mistri check` names one it is missing. That tenant must be
active. Rows are written as a member's command writes them, the owner placed
for it, and no other tenant's row is in reach. The receipt is the platform
member's; every audit row names the tenant.

### Who `me` is

`auth.me: { from: 'person', column: 'account_id' }` names the people table
and the column holding each person's **account id**. In a tenant, `me` is the
row in the current tenant whose column is their account: a person has one row
per membership, and entering another tenant makes `me` that tenant's row. It
is resolved on every request from the admitted session. A membership without a
row matches nothing (`assignee = me` is an empty list, not an error), and a
support visit is no one. Beside a text column, `me` is still the session's
email; `{me.name}` in a heading is the account's display name.
`team_id in (me.team_member.team_id)` reads that row's memberships in the same
tenant.

The platform's own staff are not a tenant's people. Name their table in
`auth.tenancy.platform.me`, in the same shape: `platform: { label: 'Provider',
me: { from: 'staff', column: 'account_id' } }`. On a platform lease `me` is
the staff row whose column is the account, so a provider's queue can offer
`mine: 'owner_id = me'` over a column that points at `staff`. The table must
be `owner: 'platform'`. Each realm resolves its own: on a tenant lease `me` is
never a staff row, on a platform lease never a tenant's person, and staff
without a row match nothing. Without the mapping, a platform lease's `me` is
the session's email, and a staff reference beside it is refused.

A notice rule's `to` that reaches the people table, and an @mention, name
people by that same account id. Each is told at their account's email in the
record's tenant inbox, and only while they hold an active membership of that
tenant, so a notice never crosses tenants. `mistri check` warns when the `me`
column looks like an email, since every such recipient would be dropped.

### Public intake

A tenant App's [public form](/docs/command-forms/#public-forms) lands in
exactly one tenant. The policy names the profile column holding each tenant's
intake address (`intake: { address: 'intake_address' }`), and the tenant
publishes `/form/<key>?via=<address>`. On the tenant's own mapped host the
form needs no address: the host places it with the address that tenant holds,
and an address there is refused (`400`). One rule places a form's read, its
submission and every saved step. An unknown address, no address on the shared
host, a tenant that holds no address, or a suspended tenant lands with the
platform for triage. Placed with a tenant, the form's
command inserts and may update that tenant's rows of the tables it declares
under `write`; it never removes one, and triage only inserts. A form saved on
every step keeps its draft in the tenant where its first step landed.

Where the App names a human check (`auth.challenge`), every tenant's public
forms ask it, on the shared host and on a mapped one, in the order an ordinary
App's do: the visitor's own budget, then the check, then the App-wide budget.
The check is the App's, one for every tenant; its secret stays in the server.
Behind a proxy, the tenant host believes the proxies `--trust-proxy` names on
these doors as on its sign-in and its API, so each visitor keeps a rate limit
of their own and the check is told the visitor's address; without it every
visitor shares the proxy's ([build and deploy](/docs/build-and-deploy/#a-tenant-app)).

A field that is a choice from a table (`field.choice({ from })`) offers the
rows of the tenant the request places, by the same rule as its submission.
The rows are read as
that tenant's visitor reads them, so the table must be opened under
`auth.public` and chosen by `resolvePublicRows`, and they arrive with the form.
An address that places nobody is offered none. Each tenant's rows are kept
apart until one of them changes, and a change in one tenant drops that
tenant's copy alone; a submission still reads its chosen key in the tenant it
lands in, so another tenant's key is refused at its field.

### Public reads

A visitor may browse one tenant's public rows (`auth.public`) by that tenant's
public address, `?via=<address>` on every page, or on the tenant's mapped host.
The policy names the profile column that holds it (`public: { address:
'public_address' }`) and chooses the rows (`resolvePublicRows(visitor)`); the
server adds the tenant, so a visitor reads that tenant's rows and global ones,
never another tenant's or the platform's. `auth.public.read` may not name a
platform-owned resource. An unknown address or a suspended tenant is the
ordinary not-found. Visitors run no command.

A tenant reads its own addresses from `/api/app` (`addresses: { intake, public
}`), and a custom component turns them into a link with
`useNavigate().publicLink(view)`.

### What a tenant keeps

Each feature works inside the tenant whose rows it touches: record history,
`activity()` feeds, notifications in that tenant's inbox, CSV import (the owner
injected; a file cannot name a tenant), custom components, signed-in forms,
jobs at times (`realm: 'tenant'` or `'platform'`), a machine's timers (each run
in its row's tenant; startup refuses one on a global table), workflows keyed
per tenant, and flows from rows (a change starts only its own tenant's flows).
The [App API](/docs/app-api/) binds each token to one membership. A tenant link
adds a hint after the App's own parameters (`/leads?tab=open&tenant=north`);
the hint is not authority, and `mistri check --routes` prints each realm's
addresses. A natural key may be unique within the tenant,
`UNIQUE (tenant_id, number)`; another tenant's record address opens the
ordinary not-found.

Refused in a tenant App: email and mentions, webhook effects, inbound
endpoints, the API's event feed and generic writes, and the database
browser's `--mcp`.

### Sandboxes

Mark a tenant-owned resource `clone: 'config'` (copied, and imported back) or
`clone: 'sample'` (copied when asked), and a tenant's owner can make a
sandbox of their tenant in Manage tenants, try changes there, and approve
importing them back. Any conflict refuses the whole import. A sandbox shows a
Sandbox chip beside its name, and
`mistri tenant clock <sandbox> --ahead 3d` runs its timers ahead of real
time; a live tenant has no such clock. Provision the store once with
`provisionStores(<the database>, { app: { definition } })` from `@mistriwork/mistri/maintenance`, which makes every store the App declares (`only: ['tenant-sandboxes']` names it alone, and is refused for an App that marks no `clone`).

## Common mistakes

- The App does not start: the policy's `ownership` and a resource's `owner` disagree → make them say the same column and kind.
- `[claim-in-tenant-app]`: a role has `claims` → grant the membership in the tenant store instead.
- `TenantStoreOfAnotherApp` → a database holds one tenant App; give the second App a database of its own.
- A role's `actions` grant is refused → grant the command the action runs, or `write` on the resource.

## Related

- [Row access](/docs/row-access/): rows scoped within one organization.
- [Roles and field access](/docs/roles/): the grants each membership's role carries.
- `docs/tenant-apps.md`: the full startup contract.
- [Sign in with your identity provider](/docs/identity-providers/): a tenant's own provider.
