# Sample Apps: start here

Public TypeScript DSL example projects show Tablewalk over synthetic
business data. Start with the smallest one that fits your task.

| Sample | What to learn | Entry point |
| --- | --- | --- |
| Tick | A checklist, quick add, a New form and inline schema types in one file. | [README](tick/README.md), [app.ts](tick/app.ts) |
| Ladle | The general path: a cooking school's own React site and Node server with the staff App embedded under its header, the school's own JSON route beside the handler, and a check-in page drawn whole by the App's own code. SQLite. | [README](ladle/README.md), [check-in page](ladle/pages/check-in.page.tsx), [host](ladle/host/) |
| Lintel | Property operations in Lumen, the flagship: a staff desk and a resident portal in one App under a row policy, roles that extend roles, leases, a rent ledger posted by a job, a late-fee workflow, repairs whose parts come off a storeroom shelf, email to a resident without an account, a signed payment callback, and its own test suite. PostgreSQL or SQLite. | [README](lintel/README.md), [app.ts](lintel/app.ts), [tests](lintel/tests/) |

Each project's README has its setup and launch recipe. Database seeds live
under [`examples/databases/`](../databases/README.md); mutable databases,
credentials and runtime configuration belong outside watched app directories.
Seeds refuse existing databases. Never reseed a running preview.

## Where to read a capability

| Capability | Source |
| --- | --- |
| One-file authoring, quick add and blur autosave | [Tick](tick/app.ts) |
| One App for staff and residents under a row policy, roles that extend roles | [Lintel app](lintel/app.ts), [policy](lintel/policy.ts) |
| State machines with groups, and fixed moves | [Lintel resources](lintel/resources.ts) |
| Boards, queues, a gantt, a calendar and cards refined from a rail | [Lintel views](lintel/views.ts) |
| Dashboard windows, comparisons, steps and charts | [Lintel dashboards](lintel/dashboards.ts) |
| Record pages: a conversation timeline with a reply and note composer, a gallery and a price headline | [Lintel pages](lintel/pages/) |
| A landing page, a public listing and a public form for a visitor | [Lintel landing](lintel/landing.ts), [views](lintel/views.ts), [viewing command](lintel/commands/viewing.ts) |
| Commands across several tables in one transaction, and refusals | [Lintel commands](lintel/commands/) |
| A monthly job run as a policy service, an event and the workflow it starts | [Lintel jobs](lintel/jobs.ts), [late fees](lintel/late-fees.ts), [rent posting](lintel/commands/ledger.ts) |
| Stock a line consumes and a delivery restocks, validation through a reference, email to an address a record holds | [Lintel resources](lintel/resources.ts) |
| A signed callback from another system | [Lintel jobs](lintel/jobs.ts), [settleCharge](lintel/commands/ledger.ts) |
| A free-form page: declared reads and a command, the platform's blocks beside the page's own React, its place in the address | [Ladle check-in](ladle/pages/check-in.page.tsx) |
| The handler in a server of your own, beside a route that is not a command | [Ladle host server](ladle/host/server.ts), [schedule route](ladle/host/schedule.ts) |
| The App embedded in a React app with its own design | [Ladle site](ladle/host/main.tsx), [its stylesheet](ladle/host/site.css) |
| An App's own suite on `@mistriwork/mistri/testing`: the lock's matrix, the API, a workflow clock, a signed callback, the browser | [Lintel tests](lintel/tests/) |

Anything this table does not name (a CRM pipeline, a theme of your own,
tenancy, a forum, a warehouse) is a pattern in the agent skill's
[recipes](../../skills/mistri/references/recipes.md) or a guide at
`mistri docs choose`, not a sample App. The Apps that were samples until
0.9.2 are regression fixtures under [`test/fixtures/apps/`](../../test/fixtures/apps/README.md)
and do not ship.

## Build from a sample

Read [Build an App with a coding agent](../../site/src/content/docs/docs/build-with-an-agent.md)
for the source-checkout and installed-package recipes and acceptance checks.
The agent skill's [first-shot recipes](../../skills/mistri/references/recipes.md)
say what makes a CRM, a service desk, a warehouse, a forum, a marketplace or an
admin tool look finished, with Lintel's lines where it does the same.
Read a sample's README, `app.ts`, imported modules, then generated schema and
command declarations.

- Author with `@mistriwork/mistri/app` and `satisfies App`. Split resources, views and
  pages when it makes the app easier to read; Tick stays in one file.
- Define commands once in server-only `@mistriwork/mistri/commands` modules. Public
  manifests name them by string. `mistri check` generates their types.
- Put physical connections and credentials in runtime configuration. An app
  definition neither creates nor migrates its business database.
- Enforce access on the server. Hidden fields, filtered queues and action
  conditions do not replace policies or command checks.

For Tick in a container, use [`examples/docker/`](../docker/README.md).
Lintel has its own PostgreSQL or SQLite setup in its README.

Continue with the [authoring guide](../../docs/authoring.md),
[theme contract](../../docs/theming.md) and [App guide](../../docs/apps.md).
