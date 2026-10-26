# Ignition · Tenant assignments

Opt-in private checked TypeScript DSL fixture, App ID
`tenant-ignition-assignment`. Load this directory through genuine `loadApp`.
The parent four-resource tenant proof remains its own entry point.

`app.ts` composes the App using `defineApp` and `TypedAppConfig<Tables>`.
`schema.ts` extends the parent's exact rows, table columns and checked one-hop
paths. `resources.ts`, `views.ts` and `navigation.ts` extend the parent's
resources, overview/lists and sidebar with Applications, Review staff and
Assignment history. `pages.ts` preserves the existing
`location → lead → follow_up → activity` chain and adds
`lead → loan_application → assignment_history`, plus staff relationships.
New page IDs are `loan_application`, `review_staff` and
`assignment_history`; inherited page IDs remain unchanged.

The default source `business` uses connection `tenant-proof`. All seven logical
resources map to `physical_` plus their names: `location`, `lead`, `follow_up`,
`activity`, `review_staff`, `loan_application` and `assignment_history`.
The three additional schemas are:

- `review_staff(id, tenant_id, location_id, business_id, name, role, active)`
- `loan_application(id, tenant_id, location_id, lead_id, business_id, name, status, reviewer_id, version)`
- `assignment_history(id, tenant_id, location_id, application_id, assigned_to, assigned_by, name, reason, assigned_on)`

Columns are text except integer `active` (0/1) and `version`; `reviewer_id` is
nullable. Every location/lead/application/staff relationship references its
resource's opaque `id`. History IDs are generated opaque text. Staff/application
business IDs have tenant-scoped uniqueness in the host-owned database.
Private owner fields are absent from authored UI. Related `show` lists omit
record IDs intentionally: the framework supplies authorized navigation keys.
Detail fields use direct foreign-key paths shown by name, preserving
clickable references with readable labels. A dotted `.name` projection is a
scalar label, useful in list columns but not a substitute for a reference field.

All roles read all seven resources. Members and managers have generic write
access only to `lead` and receive `recordFollowUp`; only managers receive
`assignReviewer`. Viewers have no writes or commands. The root write ceiling
also includes `follow_up`, `activity`, `loan_application` and
`assignment_history` for command effects. No field rules are authored because
registered command footprints include parent resources.

“Assign reviewer” references `assignReviewer` version 1 on `loan_application`
with its `version` column as the revision. It is visible when
`status = submitted and reviewer_id is empty`. Required input `reviewer` uses
`review_staff` with value `id`, label `name` and candidate query
`active = 1 and role = reviewer`. Required `reason` is a textarea capped at
500 characters. The server must trim the reason, reject blank input and enforce
current manager/reviewer activity, role, location authority and target version.
Visibility and picker metadata do not authorize the operation.

The shared disposable host owns database creation/seeds, foreign keys,
tenant-scoped uniqueness, private native-account-to-staff bindings, membership
grants, inactive-staff row policy, separate staff/work location entitlements,
command handlers, audit and receipts. It substitutes an isolated auth store
after loading the App, as for the parent proof. Command input carries no actor
or tenant IDs. Importing this DSL provisions nothing; there are no server
handlers or database setup modules here.

Focused authoring check from the repository root:

```sh
npx tsc -p test/fixtures/apps/tenant-ignition/assignment/tsconfig.json
```

The host must validate the loaded App against its actual scoped catalog.
This fixture alone makes no command execution, isolation or browser-verification
claim; existing previews and stores remain outside its scope.
