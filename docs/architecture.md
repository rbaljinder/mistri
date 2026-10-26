# Architecture, in one page

What runs where, and why the shape is the way it is. For the decisions behind
the client stack read [the build-stack assessment](build-stack-assessment.md);
for the App layer's rules read [Apps on mistri](apps.md).

## The promise that shapes everything

`npx tablewalk <db>` is the whole deployment. A person running it has no
build step, no config to write first and no schema to declare — the server
reads the catalog on connect. Everything below is arranged so that promise
stays true while the repository itself does get compiled. An App is served
from its source the same way; `mistri build` is an optional production
step for one, never a requirement.

## Packages

The repository is an npm workspace: six packages under `packages/`, five of them one per
layer of [the import boundary](boundary.md) (the sixth is `create-mistri`), each with its own `src/`,
`dist/`, `files` and `exports`. The root is private and publishes nothing.

| package | directory | what it is |
|---|---|---|
| `@mistriwork/engine` | `packages/engine` | the adapters, the server's data paths, the HTTP kit, the shared rules; no React |
| `@mistriwork/ui` | `packages/ui` | the standalone primitives (Modal, DropMenu, Dropdown, Typeahead, Button, Field, Icon, DateField), the tokens and the primitives' stylesheet, and the zoom-aware ruler; words and icons as props, no server |
| `@mistriwork/kit` | `packages/kit` | the shared React client both shells are drawn with: the page, the boot and the shell each product builds its client from |
| `@mistriwork/mistri` | `packages/mistri` | the App framework and its bin, `mistri`; its published types and JSON schemas (`schema/`), `@mistriwork/mistri/ui`, `@mistriwork/mistri/react` |
| `create-mistri` | `packages/create-mistri` | `npm create mistri`: a bin that runs `mistri new` from the `@mistriwork/mistri` it depends on, at the same version |
| `tablewalk` | `packages/tablewalk` | the database browser and its bin, `tablewalk`; depends on the engine, ui and the kit, never on mistri |

In the checkout a package's `exports` answer from its `src/`, so the packages
import each other's sources under tsx and Vite; under `--conditions=mistri-built`
they answer from `dist/`, which is how anything here runs a build. A pack
(`scripts/pack-manifest.mjs`) rewrites each manifest so `dist/` is the only
form, and a release publishes all six at one version, the packages naming
each other at exactly it. The engine, the kit and ui name every module they
export by its path, with no `./*` pattern, and `check-boundary` refuses an
import of one they do not export (docs/boundary.md, Entries); the engine and
the kit are plumbing for the two products, ui's exports its public API.

## Server

TypeScript under each package's `src/server/`, compiled into its `dist/` by
`npm run build`: one tsc program over every package (`tsconfig.build.json`),
since a declaration graph crosses packages, split back into each package's
`dist/` by `scripts/build-packages.mjs`.
It serves the web UI, answers the HTTP API, and speaks MCP on stdio when
started with `--mcp` — the database MCP runs the same tools behind the same
code path as the HTTP API.

Two bins, one per product. `packages/tablewalk/src/server/index.ts` and
`packages/mistri/src/server/index.ts` are only entries: each calls the engine's
`runBin` (`cli/bin.ts`), which runs that product's main when the entry is the
invoked script — the database browser's (`cli/browserMain.ts`) or the App
framework's (`cli/mistriMain.ts`). Neither hands a start to the other: each
refuses the other's starts by the other's name (`tablewalk --app` names `npx
mistri`, `mistri --db` names `npx tablewalk`), so installing one never loads or
installs the other. Each main has a table of its commands
(`cli/browserCommands.ts`, `cli/mistriCommands.ts`), run one way (the engine's
`cli/subcommand.ts`), and its own `cli/usage.ts`, that bin's words; what they
share about words and starting is the engine's (`cli/usage.ts`, `cli/startup.ts`). The
pieces live beside them: `cli/` (the flag parser, the config and apps at startup, and each
mode: the HTTP server, MCP, tenant serving, commands and jobs, `--reindex`,
and the print-and-exit modes), `http/trust.ts` (the Host, Origin and
proxy-identity checks every transport runs — the tenant servers import from
here), `http/reply.ts` (JSON replies, the bounded body read, `HttpError`),
`http/door.ts` (the one door every dispatcher holds a request to: the Host,
the proxy's identity, then a write's Origin and body) and `http/serverCore.ts`
(what both servers share). Each product has its own dispatcher and server:
the database browser's `http/browserHandler.ts` and `http/browserServer.ts`,
which load none of sign-in, the App runtime or the embed door, so an
App-only address asked of it is a plain `404`; and the App framework's
`http/handler.ts` (`handle` and `handlePost`: the ordered dispatch skeleton
and the row-policy wrapper around it) and `http/server.ts` (`createApp`, the
wired-but-not-listening server the tests stand up; `test/support/createApp.ts`
picks either). The App framework's routes are the modules beside its
handler, each an `async (ctx) => boolean` that answers `true` when it
replied, tried in this fixed order:
`http/context.ts` is the `RequestContext` every route reads (the request,
the config, what the gate established) and the `PostContext` a body route
reads; `http/gate.ts` is the App framework's admission behind the door — the
hosting precondition and the Better Auth session gate — and returns
`undefined` when it already answered; `http/scopedWrites.ts`
answers update/insert/delete/revert inside a row-policy context;
`http/operationsRoutes.ts` is the operator's readiness and support reads;
`http/commandRoutes.ts` dispatches business commands; `http/connectionRoutes.ts`
is `/api/runtime`, `/api/whoami` and the session-only connection edits;
`http/source.ts` resolves which connection or App entry point answers and
stamps the reply with it; `http/readRoutes.ts` is the GET reads that need
that source (views, schema, saved SQL, DDL) and calls `http/appProjection.ts`
(the App, pages, relations, layouts, saved pages and filters, the agent's
tool list) between them; for a POST, `handlePost` tries
`http/authoringRoutes.ts` (layouts, saved pages and filters, the agent
console's call, view compile, page plans, references), then the resource
reads, then `http/dataWriteRoutes.ts` (update, insert, SQL, revert, delete).

- **Adapters** (`src/adapters/`): one file per dialect — SQLite (built in,
  `node:sqlite`), PostgreSQL (`pg`), MySQL/MariaDB (`mysql2`) — plus
  `connect.ts`, which picks one. Reads run on a read-only handle for the
  life of the process; a write opens a second handle, only for a connection
  marked `"writable": true`. Read-only is enforced here, not in the UI.
- **The query language** compiles to a `Filter` structure, never to SQL
  text; the adapters turn that into a parameterised statement. Every read
  goes through `clampLimit`. Identifiers are checked against the catalog
  before they are quoted.
- **Shared rules** (`src/shared/`): what a row is called, how a record's
  columns group, where a condition ends. Both sides import them, so there is
  one of each.
- **Apps** (`packages/mistri/src/server/app/apps.ts`): a directory of config is loaded in a
  fresh worker, validated at startup with every problem named, and
  hot-reloaded on save. A page open on a watched App follows the save over
  an event stream (`packages/mistri/src/server/app/appLive.ts`, `/api/app/live`), and a save
  that does not load is placed in its file for the page's overlay. The App
  layer composes the core through a countable set of seams and never grows
  into it.
- **Live sync** (`src/server/live/`, `packages/mistri/src/client/liveSync.ts`): on an App that asks (`live: true`; a resource
  leaves with `live: false`), every write records the tables and keys it changed in a reserved store, and `GET /api/live` streams them, filtered by the reader's grants and never with a
  value. The page reads the stream with `fetch` (a tenant's lease and an embed's bearer are headers), merges events for
  150 ms and asks again the queries a change touches (`liveInvalidate.ts`), narrowed by the `mistri-reads` header
  each read answered with (`liveReads.ts`). It never reloads and never patches a row. A list its reader works in is
  held behind a pill (`liveEngagement.ts`), and a record with a draft is never read over it. The Workbench has none.
- **App builds** (`src/server/build/`, read back by `packages/mistri/src/server/app/appBuild.ts`):
  `mistri build` typechecks an App, validates it through the same loader,
  bundles its definition and server entries (Rolldown, an optional peer, or
  per-file type stripping without it) and writes the compiled App. `loadApp`
  reads a build without evaluating a module; a build is pinned to the
  tablewalk version that made it, hash-checked, and never watched.
- **Tenant Apps** (`src/server/tenant/`): an `auth.rows: 'tenant'` App is
  served by its own host over one SQLite or PostgreSQL source, never through
  the ordinary registry adapter. Enrollment attests the tenant store and binds
  one owner per realm. A tenant's context reads under its membership and the
  policy's row scopes, with the ownership column injected and hidden. Catalog
  snapshots detached, validated and deeply frozen by the framework can reuse
  their captured data and authority fingerprints. External catalogs still pass
  full validation; fresh database attestation and session/membership checks
  remain request-bound. The
  optional platform realm (`auth.tenancy.platform`) is the second context: its
  members read across tenants under `resolvePlatformRows` and write only
  through `realm: 'platform'` commands, which update a tenant's rows by key and
  never place, reassign or remove one. Two layers hide platform tables from a
  tenant, a false row scope and absence from its schema, and neither relies on
  the other. A browser tab holds one lease in either realm (`?realm=platform`,
  never beside `?tenant=`), and each lease is offered only its own realm's
  commands. A page lets its lease go as it leaves (`/api/tenant/context/release`
  on pagehide), and the same tab's next page resumes it for the same tenant
  (`/api/tenant/context/resume`, once, within 15 seconds), so reloads never
  pile contexts up against an account's 32. The tenant store (version 2) and command journal (version 4) keep
  the realm as data on both engines. [Tenant App startup](tenant-apps.md) is
  the contract.
- **Retention** (`retention` in the App, `shared/appRetention.ts`; the pruner in `adapters/retention/pruner.ts`, the
  job in `server/retention.ts`): the runtime forgets what it wrote about an App once it is older than three windows,
  `history` (record history), `commands` (the command journal) and `attempts` (finished job and webhook-delivery
  tries), each a duration or `'forever'`, defaulting to 730, 730 and 30 days. A store registers one rule with the
  pruner (`registerPrune`: table, the column that dates a row, the window, an extra predicate); a daily built-in job,
  held by one runner through the job host's slot lease, runs them in batches of 5,000 rows, each its own
  transaction, with a pause between. A try that is pending, leased or waiting for a redrive is never forgotten.
  Record history also keeps no row for a write that moved only the table's version column. A tenant App runs the same job
  once a day on the platform, sweeping its job store's database and the tenant source one after the other, and MySQL
  record history is pruned by the same job through its own connection (`DELETE ... ORDER BY ... LIMIT`). History in one
  database shared by several Apps is not scoped by App, so the shortest window among them applies to the shared rows.
- **A save is a fixed number of database round trips.** A PostgreSQL writer pipelines (`pipeline: true`), so statements
  asked together leave in one flight, and the count does not grow with the statements a save runs. Flight 1 is the
  BEGIN with what the save reads first sent behind it (the record's row lock and the record itself; a tenant App
  adds its membership fence and receipt lookup); then one flight per awaited dependent read or write; then a final flight
  that carries the COMMIT with the history rows, notices, channel messages and the command's one receipt row. Each
  statement sent ahead answers only the identical statement asked later, once, and anything that makes the plan wrong
  (a write, a savepoint, a failure) drops the rest and asks in its turn. Preparing a command (the read that fills its
  form) is BEGIN and COMMIT; a one-click command skips it, asking its revision when the pointer or focus reaches the
  button. Pipelining is only inside a transaction, which is what keeps it safe on one server connection behind a
  transaction-mode pooler such as PgBouncer. `test/write-flights.test.ts` holds one write of each sample App to its
  flight budget. The sizes and pooling are in [PostgreSQL connections](postgresql.md).
- **PostgreSQL pooling** is fixed and conservative; see
  [PostgreSQL connections](postgresql.md).

## Client

Each package's `src/client/` is served two ways from the same source. `npm run build` bundles
it with Vite once per product (`vite.tablewalk.config.ts`, `vite.mistri.config.ts`, both
`clientConfig` in `vite.config.ts`) into that product's `dist/client`: the browser's pages
are the index and the Workbench, mistri's the index, the public pages, the App shell and
a tenant's; neither bundle holds the other product's main. Minified, with source maps (sources inside)
shipped beside it so a stack trace still maps to the line; content-named under
`assets/` so the server can let a browser keep each file for a year; and with a
`.br` and `.gz` beside every text file, which the server picks by
Accept-Encoding (`packages/engine/src/server/clientHttp.ts`). The Workbench's tools, the
builders, boards, charts and the tenancy dialogs load on demand
(`components/onDemand.tsx`), so an App's first page does not wait for them;
an App never loads the Workbench's at all.
Under `tsx` —
`npm run dev` and every test suite — the server serves `src/client` through
Vite's middleware (`packages/engine/src/server/devclient.ts`), so an edit is a reload away and
nothing has to be built first. The build is the maintainer's, never the user's.

- **Rendering is React** (`src/client/components/`, TypeScript with JSX,
  TanStack Query). The content pane is one tree (`Content.tsx`) driven by the
  walk; every room fetches through Query; each component has a Vitest test in
  happy-dom. A paint that starts a room over keeps a picture of the screen it
  leaves until the new room has had its answers (`navigationHold.ts`, fed by
  `pendingWork.ts`, which counts every `api()` request and on-demand part in
  flight): a navigation swaps finished screens (docs/design.md, motion rule 9).
  A record page is one request (`/api/pages/compose`, `packages/engine/src/server/http/recordCompose.ts`
  and the tenant host's `tenantCompose.ts`): the server plans the page and asks
  every read its open sections will send, each through the route that section's
  own request reaches, and the client keeps the answers for the requests they
  answer (`composedReads.ts`). Server and sections build each request with the
  same builders (`packages/engine/src/shared/recordReads.ts`), so a request built differently
  is only asked again, never answered wrongly. A press on a row or link that
  opens a record starts it (`recordPress.ts`, rows say `data-opens`).
  A first page arrives with its data (`packages/engine/src/server/http/firstPaint.ts`): when
  the shell is served for an address, the server asks itself what the page
  will ask first — who-am-I, the runtime, the App, its schema, pages and saved
  views, then the first room's reads (a list's rows and tab counts, a record's
  compose and crumb, a dashboard's sections, the menu's counts:
  `firstPaintRooms.ts`) — through the whole dispatcher with the page's own
  headers, and writes each answer into a `<script type="application/json">`
  block under the request it answers (`packages/engine/src/shared/firstPaint.ts`). The client
  takes an answer from it once, in `api()` or, for a batch's items, in
  `breakdownBatch.ts` and `navCounts.ts` (`packages/kit/src/client/firstPaint.ts`), so a
  supported first room can paint without API requests when its answers fit
  within the size and time budgets. Rooms build those requests with the
  builders the server plans with (`packages/engine/src/shared/listQuestion.ts`,
  `dashboardAsks.ts`); a room it does not plan, or a request built another way,
  is asked as ever. The block is limited to 1 MiB of escaped UTF-8 JSON
  and a 1,500 ms wait; expiry cancels outstanding reads and leaves missing
  answers for the client to fetch. The block is never run (the policy's hashes skip
  it), and a page carrying it is `private` and never kept. A tenant App's page
  carries none: its reader chooses the tenant first.
- **Stores and behaviour** stay as `.js` modules: the walk (`core.js`), the
  URL (`url.js`, `deeplink.js`), the query-bar completer and the per-room
  stores. A vanilla module that still needs to draw crosses over through
  `components/mount.tsx`.
- **Two mains over one kit shell.** `boot.js` runs `shellStart.js`, which
  wears the look and starts the main of the product that sent the page:
  `appShell.js` (an App's public pages, sign-in, then the shell with the App's
  chrome, `appnav.js`) or `workbenchShell.js` (the shell with the Workbench's
  tools, `workbench.js`). Each hands the kit's shell (`app.js`) its chrome
  through `shells.ts`, and answers the kit's questions — the visitor, the
  tenant, an App's parts in a list or a record page (`slots`, `rooms`) —
  through `shellMode.ts`, so no kit component imports either product. Each
  page preloads its chunks (`vite.config.ts` `surfaces`): an App's the shell
  and the chrome, the Workbench's the shell and its main.
- **Headless controls** come from Base UI, dressed in the tool's own classes:
  `Modal.tsx` for every dialog, `DropMenu.tsx`/`OverflowMenu.tsx`/`ThMenu.tsx`/
  `TopNav.tsx` for every menu, `Dropdown.tsx` for the listbox, `Typeahead.tsx`
  for every box-with-a-list. The ones that read no walk, address or catalog
  are `@mistriwork/ui`'s (`packages/ui/src/`): they take their words as props, and
  the kit supplies its catalog's where a caller names none (the kit's
  `Dropdown.tsx`). OverflowMenu, ThMenu and TopNav read the walk and stay with
  the shells. Popups are anchored through `anchor.ts`, which
  measures on the zoom-aware ruler (`packages/ui/src/ruler.ts`, which core.js
  re-exports) because Floating UI does not know about the
  density zoom on the root.
- **A part that throws stays in its place.** Every page section, dashboard
  section and room, and every root `mount` draws, stands behind an error
  boundary (`components/ErrorBoundary.tsx`) that draws the shared problem note
  (`components/Notes.tsx`) where the part stood and marks it
  `data-section-error`. A caught error never reaches the browser as an
  uncaught one, so the browser suites (`e2e/support/harness.ts`, and with it
  `npm run smoke`) fail on the mark and on the boundary's console line.
- **The shell has a Content-Security-Policy** (`shellPolicy` in
  `packages/engine/src/server/clientHttp.ts`), sent with the page from source and from the
  build alike: scripts from this origin and the page's inline startup scripts
  by hash, requests to this origin alone (`connect-src 'self'`), images from
  this origin, `data:`, `blob:` and https. The browser suites fail on any
  violation the browser reports.
- **An App's own components** are React modules in its directory, declared by
  path (`component()`, `packages/engine/src/shared/appComponents.ts`) and placed through a
  `custom()` section or a value renderer. The server compiles each with
  Rolldown at load (`packages/mistri/src/server/app/appComponents.ts`; `mistri build`
  writes them as a `components/` graph) and serves it at
  `/_components/<id>-<hash>.js`. Their bare `react` and `@mistriwork/mistri/ui`
  imports are written, as each file is served, as absolute paths (under the
  base path) to small modules over the page's own copies — no import map, so
  a host page that mounts an App needs none (`packages/mistri/src/server/app/componentSdk.ts`,
  `components/sdk/host.tsx`), so there is one React and one query cache. The
  SDK (`components/sdk/`) reaches the page only through a host interface —
  the page's over the session endpoints, a test's over fixtures — never the
  walk's globals; `Value`'s drawing rules moved to `components/Dressed.tsx`
  so the kit can share them. A section's declared reads are planned like a
  related list's (`customReadView` in `packages/engine/src/shared/pagePaths.ts`).
- **Routing is by path**, not hash. The Workbench writes the whole walk in
  the query language: a record is `/{connection}/{table}/~{id}`, a page
  `/{connection}/@{page}~{id}`. An App has one canonical address per thing,
  from one book (`packages/mistri/src/shared/appAddress.ts`) that the client
  (`publicAddress.ts`), the server's public-page head and redirect
  (`http/publicHead.ts`) and `mistri check --routes` all read: a record
  under the first view showing its table that the person is served
  (`/leads/127`; one served other views is sent on to theirs), a list's
  question as parameters (`/leads?tab=working`, `publicAddress.ts`),
  and the walk in `history.state`. Every older address still opens and is
  rewritten. A `#/…` link is not read.

## What holds it together

- `test/prose.test.ts` fails when the README, the site or `USAGE` disagree
  with the code about tool counts, flags or dialects.
- `test/check-client-types.mjs` type-checks the client through JSDoc;
  `test/check-client-geometry.mjs` enforces the one zoom-aware ruler;
  `test/check-client-host.mjs` keeps the page around the shell — history,
  title, `<html>`, `<body>`, id lookups, window and document listeners —
  behind `packages/kit/src/client/shellHost.ts`;
  `test/check-client-shape.mjs` keeps every corner and lift on the look's
  shape tokens; `oxlint` catches a name used and never imported.
- `test/repo/structure.test.ts` pins the repository's shape: the module size
  ceiling, a header on every module, the import layers, and where tests live.
  `scripts/audit-exports.mjs` fails on an export no other file mentions. Both
  start from allowlists of today's exceptions, which may only shrink.
  `knip` (`knip.json` names the entries: the package's `exports`, the client
  surfaces, scripts, tests, examples) fails on a file, export or dependency
  that nothing reaches; what it cannot see — a module loaded by path, a name
  reached through a namespace — is an entry or an `ignoreIssues` line there.
- `scripts/check-boundary.mjs` gives every module the layer of the package it
  sits in — `engine`, `ui`, `kit`, `browser`, `mistri` — and fails on an
  import that goes the wrong way (engine and ui ← kit ← browser, mistri). There are none: the allowlist is empty and stays so, and
  `--entries` holds each package's entry points (`scripts/boundary/entries.json`)
  to their layers. [The import boundary](boundary.md) has the layers, the rule
  and how to place a new file.
- `test/agreement.test.ts` holds the client readings of server rules that are
  not copies (the chip splitter, the path walker, the export rewrite) and
  still have to agree.
- `npm run smoke` walks every room in a real browser after any client edit,
  one walk per binary (`e2e/smoke-tablewalk.spec.ts`, `e2e/smoke-mistri.spec.ts`),
  because a constructor-time throw in a shared module blanks whole views while
  every static check stays green.
- Every test belongs to one package (`scripts/test-owners.mjs`, read off what it
  reaches), and each package runs its own: `--package=<name>` on
  `scripts/test-node.mjs` and `npm run e2e`, `TABLEWALK_TEST_PACKAGE` for
  `npm run test:components`. A test that holds both products to one rule says
  `test-package: shared` and runs with each.

## What ships

mistri's `dist/ui` is `@mistriwork/mistri/ui` and `@mistriwork/mistri/ui/testing` built for a component's
own tests (`vite.ui.config.ts`); the page never loads it. mistri's `dist/embed` is
`@mistriwork/mistri/react` (`vite.embed.config.ts`, `packages/mistri/src/embed/`): the same client
built once more for a host's React app, with `shellHost.ts`, `addressMount.js`
and `transport.ts` swapped for their twins in `src/embed/seams/` (which answer
from the element the shell is drawn in and the host's router) and every
stylesheet scoped to that element in one `@layer tablewalk`
(`scripts/embed-css.mjs`); the served client's bytes do not change. Each
package ships its `dist` and what its `files` allowlist names; a pack builds
nothing and refuses a package without a `dist/`. mistri's `schema/` carries
the App DSL's types and JSON Schemas and is in its exports map, so it must
stay; the `tablewalk` package carries the JSON schemas, the agent skill and
the sample Apps in from elsewhere in the checkout (`CARRIED` in
`scripts/pack-manifest.mjs`). The Docker image and the desktop app install
the same packages the way `npm install tablewalk` lays them out
(`scripts/install-packages.mjs`) and run `tablewalk`'s `dist/server`.
