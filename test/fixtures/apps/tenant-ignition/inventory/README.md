# Ignition · Tenant inventory

Opt-in private synthetic checked TypeScript DSL fixture, App ID
`tenant-ignition-inventory`. Load this directory through `loadApp`. It composes
the sibling `../assignment` variant's seven resources, navigation and pages;
the base and assignment variants remain independent entry points.

`app.ts` uses `defineApp` and `TypedAppConfig<Tables>`. `schema.ts` imports the
assignment types and extends exact rows, table columns and checked one-hop
paths. The default source `business` uses connection `tenant-proof`. All ten
resources map to `physical_` plus their logical names: `location`, `lead`,
`follow_up`, `activity`, `review_staff`, `loan_application`, `assignment_history`,
`vehicle`, `vehicle_reservation` and `availability_history`.

The added schemas follow the inventory contract the fixture was built for:

- `vehicle(id, tenant_id, location_id, stock_reference, name, status, version)`
- `vehicle_reservation(id, tenant_id, location_id, vehicle_id, lead_id, reserved_by, released_by, reference, name, status, version, reason, reserved_on, released_on)`
- `availability_history(id, tenant_id, location_id, vehicle_id, reservation_id, actor_id, name, from_status, to_status, reason, recorded_on)`

All columns are required text except integer `version` on vehicles and
reservations, and nullable text `released_by`/`released_on`. Vehicle status is
`available`, `reserved` or `unavailable`; reservation status is `active` or
`released`. All keys are opaque text. Location, vehicle, lead, reservation and
staff relationships are real foreign keys referencing `id`; `reserved_by`,
`released_by` and `actor_id` reference `review_staff`. The host generates opaque
reservation/history IDs and tenant-local reservation references.

The host owns tenant-local stock/reference uniqueness and the partial unique
index on `(tenant_id, vehicle_id)` where reservation status is `active`. That
invariant also covers active reservations outside current row visibility.
There are no triggers or global business uniqueness requirements. Database
creation, seeds, indexes, private native-account staff bindings, memberships,
tenant ownership, location authority, command handlers, audit and receipts
belong to the shared disposable host, outside App authoring. Importing this
fixture provisions nothing and installs no custom handlers or database setup.

All roles can read the ten resources subject to host tenant/row policy. Members
and managers have generic writes only to `lead`; both receive `recordFollowUp`.
Managers additionally receive `assignReviewer`, `reserveVehicle` and
`releaseReservation`. Viewers have no writes or commands. The root write ceiling
contains the assignment variant's five writable resources plus all three
inventory resources to admit command effects. Inventory state and history have
no generic editing or inverse command.

“Reserve vehicle” references `reserveVehicle` version 1, targets `vehicle`,
is visible when `status = available`.
Required `lead` input is a reference to `lead`, with value `id`, label `name`
and query `status = open`. Required `reason` is a textarea capped at 500
characters. “Release reservation” references `releaseReservation` version 1,
targets the exact `vehicle_reservation`,
requires the same bounded reason and is visible when `status = active`.
Visibility and picker metadata do not authorize commands: the admitted writer
must validate current manager activity/authority, coherent location, lead access,
versions and reservation state, and commit all effects atomically with receipts.

Navigation adds Vehicles, Reservations and Availability history. Pages preserve
the assignment relationships, add Vehicles under Location and Vehicle
reservations under Lead, and connect Vehicle to Reservations/Availability history
and Reservation to Availability history. New page IDs are `vehicle`,
`vehicle_reservation` and `availability_history`. Inventory detail
fields use direct foreign keys, which an App shows as clickable readable labels.
List projections intentionally omit `id`, exercising shared hidden navigation
keys; dotted `.name` projections are scalar labels. Private tenant ownership
fields stay outside authored UI.

Focused authoring check from the repository root:

```sh
npx tsc -p test/fixtures/apps/tenant-ignition/inventory/tsconfig.json
```

This is a private synthetic inventory/availability proof, not a public starter
or production inventory system. The host must validate the loaded App against
its actual scoped catalog. Typechecking and loading alone do not establish
command execution, concurrency, tenant isolation or browser behavior. There
are no jobs, automatic expiration, scheduling, background automation or Temporal.
Existing live stores and previews are outside this fixture's scope.
