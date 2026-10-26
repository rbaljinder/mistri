# Ignition · Tenant proof

Private checked TypeScript DSL fixture for the cross-App tenant proof. This is
not a public starter or a replacement for the ordinary Ignition sample.

`app.ts` is the genuine `loadApp` entry point. `schema.ts` records the exact
logical row types and checked one-hop paths; `resources.ts` binds each
logical resource to its physical table and declares the App ceiling, the New
form and the public command reference; `views.ts` authors the overview and
lists, which `navigation.ts` arranges; `pages.ts` authors the related-record
chain. Record page IDs are `location`, `lead`, `follow_up` and `activity`.

The only source is `business`, the default, using connection `tenant-proof`.
Each logical resource maps to `physical_` plus its logical name:

- `location(id, tenant_id, business_id, name)`
- `lead(id, tenant_id, location_id, business_id, name, status)`
- `follow_up(id, tenant_id, location_id, lead_id, business_id, name, status, version)`
- `activity(id, tenant_id, location_id, follow_up_id, name, body, created_at)`

All columns are text, including IDs and `created_at`, except integer `version`.
Every `location_id` references `location.id`, `lead_id` references
`lead.id`, and `follow_up_id` references `follow_up.id`.
Record keys are opaque and globally unique; local `business_id` values may
repeat across tenants. No private owner field appears in authored surfaces.

Members and managers read all four resources, create/update only `lead` through
generic writes, and receive `recordFollowUp`. Viewers only read. The App write
ceiling also includes `follow_up` and `activity` for command effects;
`location` stays read-only. No field access rules are declared because command
footprints include parent resources and currently reject field rules. Location
or project entitlements come from host-owned evidence, never from these roles.
The existing dependency guard withholds generic Delete on `lead`, even for a
record without current follow-ups; the table has an incoming foreign key.

The New lead form asks for `business_id`, `name`, `location_id` and
`status`, defaulting status to `open`. Related creation on a location binds
its parent automatically. The related chain is
`location → lead → follow_up → activity`.

“Record follow-up” is visible when `status = open`. It references
`recordFollowUp` v1 on `follow_up` and
required textarea input `body` (label “Body”, at most 500 characters). Visibility
is not authorization: the host's
guarded handler must check current authority and version, atomically mark status
`done`, increment version and insert one `activity`. Its success message is
“Update recorded.”

The [shared disposable fixture](../../../support/tenantProofFixture.ts) owns database creation/seeds, tenant memberships,
scope/entitlement policy, command handlers/journal and runtime bindings. After
genuine `loadApp`, it substitutes an isolated native-auth store for the authored
`auth` (`signUp: 'open'`, `defaultRole: 'member'`, `rows: 'tenant'` and the three roles). Importing this App provisions
nothing. The host must validate the loaded App against its actual catalog.
Existing previews and stores are outside this fixture's scope.

Focused authoring check from the repository root:

```sh
npx tsc -p test/fixtures/apps/tenant-ignition/tsconfig.json
```

This authoring fixture alone makes no isolation or browser-verification claim.
The shared host tests supply that evidence; broader workflows, administration
and durable generic CRUD recovery remain separate work.
