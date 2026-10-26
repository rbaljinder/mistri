# Service Atlas

A larger, fictional ITSM application authored through Tablewalk's TypeScript DSL.
Foundry supplies its visual theme; there is no ITSM-specific renderer or CSS.

## Source

- [app.ts](app.ts): composition root and theme.
- [resources.ts](resources.ts): server-enforced table write scope, shared status tones and
  money formatting, New forms and record actions.
- [views.ts](views.ts): every screen — modules with their filters and tabs, beside the
  dashboards and queues.
- [navigation.ts](navigation.ts): the top menu's arrangement of those views.
- [dashboards.ts](dashboards.ts): Operations and Service catalog screens.
- [queues.ts](queues.ts): incident triage, change and fulfillment workspaces.
- [pages/incident.ts](pages/incident.ts): an example record composed with `page`,
  `summary`, `workflow`, `timeline` and `related`; the other eight pages sit beside it.
- [mistri-schema.d.ts](mistri-schema.d.ts): generated database table/column types.
- [seed.mjs](seed.mjs): database schema and fictional demo data.
- [seed-postgres.mjs](seed-postgres.mjs): PostgreSQL loader using the same schema
  metadata and deterministic SQLite fixture rows.

These are executable TypeScript modules, not a JSON wrapper. Import and compose
ordinary functions and objects; the resulting definition remains data-only and
passes the same server validation as JSON apps. Node 24 runs the modules directly.
The app directory watcher reloads imported modules when they change.
No separate app build is required. The following command checks types without
emitting JavaScript; building Tablewalk itself is a separate concern.

```sh
npx tsc -p examples/apps/service-desk/tsconfig.json
```

The regular test suite also typechecks this app and checks its generated types
against the seeded schema. Table names and display keys are schema-typed; query
strings and relationship paths are checked by the platform's runtime validator,
not a TypeScript parser imitation.

## Run

```sh
node examples/apps/service-desk/seed.mjs .demo/service-desk.db
npm run start -- --config .demo/service-desk.db.json --app examples/apps/service-desk --port 4709
```

Open http://127.0.0.1:4709/service-desk. Seeding refuses existing database or
connection files. Choose a different database path to create another instance.

### PostgreSQL / PlanetScale

On Node 24 with the optional `pg` driver installed, provide the setup connection
URL through `PLANETSCALE_DATABASE_URL`, then run:

```sh
node examples/apps/service-desk/seed-postgres.mjs
```

The target must have an existing, empty `public` schema. The loader refuses
existing tables, views, sequences, functions or types there; it never truncates,
replaces or merges data. Other schemas, including PlanetScale extension schemas,
are untouched. Schema creation and all 772 fixture rows run in one transaction,
with native booleans, identity keys, CHECK/UNIQUE constraints, 53 foreign keys and
their child indexes. Identity sequences are advanced after the explicit seed IDs.
The loader validates all table row counts and the foreign-key count before commit.

Only metadata and rows from a freshly generated temporary SQLite fixture are read;
existing local preview databases are not accessed. Unsupported types, defaults or
schema shapes fail rather than being rewritten heuristically. PostgreSQL 13 or
later supplies the `gen_random_uuid()` reference defaults. Re-running after a
successful load is refused. Connection details are not printed; successful output
contains only table, relationship and row counts.

Use a separately provisioned application role for preview access after setup;
the seed creates no users or grants and does not write a connection file.

For a separate preview, configure `.demo/planetscale-atlas.json`:

```json
{
  "connections": [{
    "name": "service-desk",
    "url": "${PLANETSCALE_DATABASE_URL}",
    "schemas": ["public"],
    "writable": true
  }]
}
```

Store the application URL in an ignored, owner-readable environment file, not in
the app source. Require TLS certificate verification (`sslmode=verify-full`).
Grant the application role `USAGE` on `public`, record CRUD on the Atlas tables,
and `USAGE, SELECT` on their identity sequences; it does not need schema creation
privileges. The app's authored write policy further limits editable tables.

```sh
node --env-file=.demo/planetscale-preview.env --import tsx packages/mistri/src/server/index.ts \
  --config .demo/planetscale-atlas.json --app examples/apps/service-desk --port 4710
```

Open http://127.0.0.1:4710/service-desk; the SQLite preview can remain on 4709.
The September 6 preview credentials expire September 9, 2026 at 16:20 UTC;
renew them before restarting after expiry. Do not rerun the seed to reconnect.
This arrangement measures a local app server talking to a remote database, not
browser latency to a remotely hosted app server. Compare equivalent routes and
distinguish initial loading from warm navigation; the two demo datasets can diverge
as records are edited independently.

## Explore

- Operations: incident trends, priority distribution, team workload, priority response,
  service health, change windows and fulfillment queues.
- Incidents: caller, service, asset, problem, SLA policy, work notes and related knowledge.
- Incident triage (Operate): active incident status board, with critical response
  ordered by due date. Cards open the authored incident page.
- Changes: risk, maintenance window, implementation/rollback/validation plans, manual reviews and tasks.
- Change queue (Change): active change status board, pending reviews and outstanding
  tasks. Cards open the authored change page; closed/canceled changes are excluded.
- Service catalog: four categories and twelve offerings. Open an offering and use
  **Add to request** to attach it to an existing request. This is not a checkout.
- Requests: requested items, budget reviews, fulfillment and purchase-order lines.
- Orders: vendor, buyer, shipping location, quantities and partial receipt tracking.
- Fulfillment queue (Fulfill): active request status board, outstanding tasks and
  issued/part-received orders. Request cards open the authored request page.
- Estate: services, assets and dependencies, problems and knowledge articles.
- Directory: people, departments, locations, support teams, vendors and SLA policies.

The seed has 26 tables and 53 foreign keys, including 84 incidents, 30 changes,
24 requests, 12 orders and 48 assets. Child references are indexed. All data is
fictional; dates are a fixed demonstration snapshot, not a simulation clock.

## Shared Blocks

Charts are authored alongside metrics and lists in [dashboards.ts](dashboards.ts):

```ts
chart('Incidents opened by day (all time)', 'incident', 'day opened_at as opened_day', {
  width: 'half',
}),
chart('Active incidents by priority', 'incident', 'priority', {
  shape: 'donut',
  query: 'status != resolved and status != closed',
  width: 'half',
}),
breakdown('Active incidents by support team', 'incident', 'team_id.name', {
  query: 'status != resolved and status != closed',
  width: 'half',
}),
```

These use the default count measure. Date buckets produce a line chart;
categorical values can use a donut or horizontal breakdown. Line points expose
date/count values; donut legend entries and breakdown rows open their underlying records. The trend
includes all seeded dates rather than aging out of a rolling time window.

The workspaces in [queues.ts](queues.ts) use the same board helper as smaller
examples, composed with contextual lists:

```ts
board('Active incidents by status', 'incident', 'status', {
  lanes: ['new', 'triage', 'in_progress', 'pending'],
  query: 'status != resolved and status != closed',
  primary: 'name', lines: ['reference', 'priority', 'assignee_id.name'],
  sort: 'due_at',
  limit: 4,
})
```

Boards are read-only navigation, not drag-and-drop workflow engines. `limit` is
per lane; lane overflow opens the filtered list. `lanes` selects the visible
values in their exact authored order. Empty selected lanes remain visible, such
as Draft in the change queue; unselected terminal states are absent. Counts,
cards and full-list navigation share that lane scope, intersected with `query`.
Without `lanes`, boards retain their schema/observed-value behavior, including
empty schema-declared lanes. Lane selection grants no write permission and does
not enforce transitions between states.
Child queues filter their own pending/unfinished state and show parent status.
Closing a parent does not complete or hide its remaining tasks/reviews; filtering
by relationship fields is rejected by the dashboard standing-query validator.
Dates order the demo work; these queues do not infer overdue SLA status.

## Consolidation Scope

Service Atlas now demonstrates Thread's status-board/detail pattern and Relay's
operational queue with related reviews and tasks. Both smaller apps remain
available; this is not a migration of their data models or a retirement.

Patterns still unique to those examples, proposed for a later decision:

- Thread: engineering issues organized by projects and timeboxed cycles, including
  cycle goals and a sidebar-first planning workspace.
- Relay: release runs linked to deployment environments, repository/version health
  and release-specific approvals. Atlas change reviews do not execute deployments.

Adding those domains would require explicit schema and workflow design, not
renaming incidents to issues or changes to releases.

`fields([...], { presentation: 'summary' })` provides compact record properties,
including the current stored status, using ordinary page data and theme tokens.

`related('Work notes', 'incident_note', 'incident_id', { create: 'Add note' })`
opens the existing New Record drawer with the parent foreign key
bound and hidden. Successful creation stays on the parent, refreshes related data
and preserves its field draft. Used for notes, change reviewers/tasks, requested
items and order lines. Thread uses the same block for discussion updates.

## Boundaries

This is an application-framework example, not ServiceNow feature parity or a
production ITSM deployment. The table-level write scope is enforced server-side;
inventory, catalog definitions, directory and SLA policies are read-only here.

Approval rows are manually recorded decisions. They do not authorize execution,
identify an authenticated reviewer, schedule changes or automatically transition
requests. Action `when` conditions control visibility, not authorization. State
choices have database constraints, but permitted transitions are not enforced.

SLA records describe targets; there is no business-calendar engine, pause/resume
clock, automatic breach detection or escalation. Order receipts do not invoke a
vendor, allocate assets or automatically complete fulfillment. No attachments,
notifications, immutable audit feed, CMDB discovery, realtime collaboration,
field-level permissions or external integrations are implied.

Next steps are tracked by the maintainers.
