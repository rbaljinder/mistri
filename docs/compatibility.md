# Compatibility policy

Takes effect at 1.0.0. Until then mistri keeps no compatibility: a 0.x
release may rename or remove anything, and the changelog says what moved.
From 1.0.0 the promise below holds through every 1.x release: an App written
against 1.0 keeps working, unchanged, until 2.0.

## What is covered

A change to any of these is **breaking**:

- **The App DSL.** Every non-preview key, helper and accepted value in
  `test/fixtures/public-surface.json`. A key may be added; its meaning, its
  accepted values and its default may not change.
- **The public package surface.** The `@mistriwork/mistri/*` exports (`app`,
  `commands`, `policy`, `maintenance`, `ui`, `page`, `handler`, `react` and
  its router adapters, the schema files) and their documented types.
- **CLI commands, flags and exit codes.** A command, a flag, its meaning and
  the exit codes `mistri check` and the other commands document.
- **The HTTP and App API.** Routes, request and response shapes, error codes,
  and the contract of a command (`authority.lock`) and its receipts.
- **MCP tools.** A tool's name, arguments, result shape and read-only or
  writing annotation, for the database browser's server and an App's.
- **The address format.** Canonical App addresses (`packages/mistri/src/shared/appAddress.ts`).
  An older address that still opens is rewritten to the canonical one; the
  canonical form does not change.
- **Schema JSON.** `schema/*.json`, the published schemas, including
  `check.schema.json` and the `check` codes it carries.
- **Store layouts.** The tables of mistri's own stores (sign-in, API
  tokens, history, the command journal and its events and deliveries, jobs,
  workflows, flags, the tenant store and its neighbours). A new layout is a
  new version that `mistri migrate stores up` moves forward; serving never
  migrates, and an old reader refuses a newer layout by name. A tenant App's
  stores move the same way (`up --app <dir>` upgrades them, never creates
  them), the sandbox store among them. There is no upgrade from a
  tablewalk 0.9 App database: reset and reseed it.
  `__mistri_schema_snapshot` (what `mistri migrate` records) and
  `mistri.schema_epoch` (PostgreSQL's catalog cache) are rebuildable
  caches, not stores: they carry no layout version and are outside this
  promise. Drop either and it is made again.

Adding a key, a command, a flag, a tool, a route or an optional field is not
breaking.

## Deprecation

A feature leaves in two steps. A minor release marks it deprecated: it keeps
working, and `mistri check` and startup print a `deprecated` warning for
each place an App writes it, naming its replacement. It is removed no sooner
than the next major version. A security fix may be the exception, and the
changelog says so.

A DSL key is deprecated by an entry in `DEPRECATIONS`
(`packages/mistri/src/shared/deprecations.ts`): its name as the inventory spells it, the minor
release that deprecated it and what to write instead. The key stays in the
schemas and in the inventory until the major that removes it.

A spelling renamed before 1.0 was never promised, so it is refused, not
warned about: a section's `path`, `of`, `paths` or `orderBy` says the word
that replaced it (`whose`, `about`, `show`, `sort`) and the App does not load.
These refusals stay.

## Preview

A feature marked preview works as documented and is enforced on the server,
but its shape may change, or it may go, in any release; the changelog says
so. It is outside the promise until a release promotes it, and promotion is
one-way. Preview is visible in three places: the Preview rows of the [status
page](../site/src/content/docs/docs/status.md), which are the list; the
`Preview` column of the generated DSL reference; and the `preview` status of its
entries in the inventory (and an `@preview` tag on the root keys and exports in
the types).

At 1.0 nothing is preview: the release promoted the last ones (mounting in a
host's server, sign-in from a host app, embedding in a React app, free-form
pages and read replicas). Everything the status page lists is covered, as is
the database browser and its MCP server. A feature added in a 1.x release may
ship as preview, and is then outside the promise until a release promotes it.

## Outside the promise

- **Preview**, above.
- **Internals.** Anything under `src/` that a package export does not name,
  including imports from `@mistriwork/mistri/src/...` or `dist/` paths, the client's
  modules, CSS class names and the DOM they draw.
- **Behavior no document states**, such as the order of unordered results,
  log and error message wording, the SQL a read issues and timing.
- **The assistant's default model.** Without `model`, an App's assistant uses
  the model its release recommends, and a minor release may move that default
  to a successor as the provider retires models. An App that must keep one
  model names it in `model`.
- **Tooling around mistri.** The desktop app has its own version; the
  sample Apps under `examples/` and `test/fixtures/` are not starters and may
  change with the DSL.

## Checking it

The inventory (`test/fixtures/public-surface.json`, generated by
`scripts/public-surface.mjs`) lists every public name: the DSL keys and
values, the icons, the package exports, the CLI commands and flags, the MCP
tools and the `check` codes, each `public` or `preview`.
`test/public-surface.test.ts` fails on any difference between it and the code.

- **Adding a name** is one command, `node scripts/public-surface.mjs --write`,
  and the regenerated file goes in the same commit, so the review sees what
  was added and whether it is public or preview. A new preview key is also
  added to `PREVIEW` (or `PREVIEW_CLI`, or a JSDoc `@preview` on an export) in
  that script, beside its Preview row on the status page.
- **Removing, renaming or demoting a public name** is a break. From 1.0.0
  (read off `package.json`'s version) the test says so, and `--write` refuses
  to regenerate it away; deprecate the name instead. A major release
  regenerates with `--write --major`.
- **Promoting a preview name** moves its status page row to Stable, drops its
  rule from `PREVIEW`, and regenerates the inventory.

Store layouts are held by `test/fixtures/store-layouts/`, each store's DDL
(`scripts/store-layouts.mjs`), walked by `test/store-upgrades.test.ts`. Before
1.0 every store is at layout version 1 and there is no upgrade path: a database
from an earlier build is wiped and reseeded. From 1.0 a changed layout is a
new version with an upgrade step in
`packages/mistri/src/server/storeLayouts.ts`, and the old fixture stays.
