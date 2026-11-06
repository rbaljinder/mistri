# The import boundary

The repository is the App framework (`mistri`) and the layers it stands on,
which the database browser (`tablewalk`) stands on too, from its own
repository ([rbaljinder/tablewalk](https://github.com/rbaljinder/tablewalk)).
The line between them was drawn in one tree before the browser was cut out,
and `scripts/check-boundary.mjs` still holds it on every `npm run test:static`.

## Five layers

| layer        | what it is                                                                                                                                                                                                                                                                                                                                                                                                                                  | becomes                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `engine`     | the adapters, the server's data paths, the HTTP kit, and the shared rules (filter, schema, query language, view, row scopes, and the looks: the built-in looks, their tokens and which one a page wears, which the server reads to send a first page already in its look, with the looks' published types, `packages/engine/schema/theme.d.ts`). `migrate` and `seed` are engine. No React.                                                 | `@mistriwork/engine`     |
| `ui`         | the standalone primitives: Modal, DropMenu, Dropdown, Typeahead, Button, Field, Icon and DateField over Base UI, the tokens and the stylesheet they are drawn with, the anchor their popups are placed by and the zoom-aware ruler it measures with (`packages/ui/src`). A primitive reads no walk, address, transport, resource request or copy catalog: its words, icons and answers are props. Each renders under Vitest with no server. | `@mistriwork/ui`         |
| `kit`        | the shared React client: the walk, the address, Grid, Value, the record page, lists, filters, the menus that read the walk (OverflowMenu, ThMenu), the date field, charts, the client's UI tokens and stylesheets, and the client that applies a look                                                                                                                                                                                       | `@mistriwork/kit`        |
| `mistri`     | the App framework: every App directory under `src/server`, the tenant shell, auth, the API, commands, jobs, workflows, the App stores, the public surface, `@mistriwork/mistri/ui`, `src/embed`, and the rest of `schema/`                                                                                                                                                                                                                  | `mistri`                 |
| `cloudflare` | the Worker glue `mistri deploy init cloudflare` writes against; it imports nothing of the repository                                                                                                                                                                                                                                                                                                                                        | `@mistriwork/cloudflare` |

The database browser's own rooms (the query and SQL panes, the connection
manager, the database MCP, lint, diff, impact) are its repository's, built
over the published engine, kit and ui.

The kit is a layer of its own because the database browser's record view _is_
the App record page: the two products share most of the client, and that client needs
React, which a server-only consumer of the engine must not have to install.

## The rule

```
engine  <-  kit  <-  mistri
ui      <-
```

- `engine` imports only `engine`, and `ui` only `ui`.
- `kit` imports `kit`, `ui` and `engine`.
- `mistri` imports itself, `kit`, `ui` and `engine`.
- `cloudflare` imports only itself.

Every import counts: `import`, `export … from`, `import x = require()`, and an
`import()` or `require()` with a literal name. A type-only import counts too,
because a package has to resolve its types, but it is reported as type-only:
moving a type down is the cheap fix. The existing rule that the client never
imports the server (`test/repo/structure.test.ts`) still stands beside this
one.

## Placing a new file

A module's layer is the package it sits in (`scripts/boundary/entries.json`
`packages`), so there is no list of owners: placing a file is choosing its
package, and a file under `packages/kit/` is the kit's however it is named.

To place a file, ask who would install it. If only the database browser needs
it, it belongs in the browser's repository; only an App, `mistri`; the client
both products draw with, `kit`; a primitive that draws with no walk, address,
transport or catalog behind it, `ui`; both servers, or a rule both read, `engine`. If the answer is "both, but
it imports one side", the import is what should move, not the file.

Each package's `schema/` is its published types and is the package's like
its sources: `packages/mistri/schema/` is what an App imports, and
`packages/engine/schema/theme.d.ts` is the engine's, because the built-in
looks and the tokens are written in its types; `packages/mistri/schema/app.d.ts`
re-exports it as a mistri module may import the engine.

A rule the engine writes back in a product's spelling reads that spelling
through a seam, never by importing it. The page rules (`packages/engine/src/shared/page.ts`)
write a page back as a pages/ file holds it, and type it with
`AuthoredSection` and `AuthoredPage` from the engine's `packages/engine/schema/model.d.ts`,
which `packages/mistri/schema/app.d.ts` fills in (`AuthoredPageShapes`) with the App's
authored types: a section those types refuse still fails to compile. The
kit reaches the App framework's parts the same way at run time, through the
shell's answers (`packages/kit/src/client/shellMode.ts`, `slots` and `rooms`).

## The mains

Each product is a binary of its own: `mistri`
(`packages/mistri/src/server/index.ts`) runs the App framework's main,
`cli/mistriMain.ts`, and `tablewalk` runs the database browser's, in its own
repository. Neither names the other product: a start that is the other's is
refused with the other's command (`npx tablewalk <db>`, and from the browser
`npx @mistriwork/mistri --app <dir>`), never handed across, so installing one
never loads or installs the other. Both entries are the engine's `runBin`
(`cli/bin.ts`) with their own main.

The page names neither product either. Its entry, `packages/kit/src/client/shellStart.js`, wears the
kit's look and starts `virtual:mistri/shell-main`, a name no file of the kit's answers: each product's build
answers it with its own main through the kit's Vite preset (`@mistriwork/kit/vite`, `shellMain`) — here the
App framework's `appShell.js` (`config/vite.mistri.config.ts`) — so a product's bundle holds only its own
main and builds over the published kit. The main hands the kit's shell (`app.js`) its chrome through the
shell API in `shells.ts`; the kit imports no product. The repository's own `vite.config.ts` answers the name
when the server runs from source. That module is the server's configuration, not a module of any package,
and the check holds every module to its layer with no exception.

## Entries

`scripts/boundary/entries.json` names what each package will be imported
by: every `mistri/*` entry, `@mistriwork/engine` (`packages/engine/src/engine.ts`: connect, the
catalog, the query language, keyset pages), `@mistriwork/engine/host`
(`packages/engine/src/host.ts`: what a host opens a database through, below), `@mistriwork/ui`
(`packages/ui/src/index.ts`: the primitives), `@mistriwork/kit`
(`packages/kit/src/client/kit.ts`: the shell API and the UI tokens), and
`@mistriwork/cloudflare`. Each entry gives its layer, its `source` and its
`types`. The database browser publishes none of the App framework's names: an App
imports `mistri/*`, and `mistri check` refuses a `tablewalk/*` import with
the `mistri/*` name it means.

Each package is a private npm workspace under `packages/`, so its names
import in a checkout now — from a test, a consumer fixture, an App run on
Node's type stripping, which reads no tsconfig `paths`. Node refuses an
`exports` target outside a package, so each entry is a two-line stub inside
it re-exporting the entry's module. The stubs and each `package.json` are
generated (`node scripts/boundary/entries.mjs --write`), never edited, and
`npm pack` ships none of them.

`node scripts/check-boundary.mjs --entries` (what `npm run test:static`
runs) checks, beside everything above:

- each entry's source and types are owned by its layer;
- everything the entry reaches — static, `import()` and type imports — is
  in a layer its layer may import, or it prints the path to the module that
  is not (`--report` lists what each reaches);
- every other name a package exports is one of its modules by its path
  (`@mistriwork/engine/shared/schema.js` from `src/shared/schema.ts`, built to
  `dist/shared/schema.js`), and no package exports a
  pattern (`./*`) but `@mistriwork/mistri/schema/*`'s shipped schemas: each names every module another package imports;
- the stubs and workspaces are the ones the table generates.

Without `--entries`, the check refuses any import of a workspace package's
name its `exports` does not answer — a deep import into the engine, the kit
or ui that is not one of its exports — with no allowlist for it. Reaching one
more of their modules is a line in that package's `exports`, seen in review.
The engine's and the kit's exports are plumbing for `mistri` and `tablewalk`,
with no semver promise to an App's author (their READMEs say so); ui's are its
public API.

`test/repo/entries.test.ts` imports every server `mistri/*` name through its
workspace link, and `test/fixtures/entries/consumer.ts` imports the client
ones under `tsc`. A new `mistri/*` export is a new entry, a stub
(`--write`), and a line in that fixture.

## The host list

The database browser builds from the published engine, kit and ui, in its
own repository. What it imports of them is the host list, `host` in
`scripts/boundary/entries.json`: `exports` are the names, by package, each
reviewed. Its imports are read in its own repository, so here the list is
data: an `importers` table (where a host's imports are read from) is read
only when those paths are in this tree, and nothing comes off the list for
want of an importer here.

The kit's client modules are for a bundler, not for Node: they import their
stylesheets. The build writes them one by one, with their declarations,
stylesheets, fonts and `index.html` (`config/tsconfig.kit-client.json`), into
the kit's `dist/client`, and a product bundles them with the kit's Vite
preset (`@mistriwork/kit/vite`), which declares what the client needs —
React, TanStack, Base UI, tiptap, Vite — as optional peers. An install of the
kit names only the client modules on the host list
(`scripts/pack-manifest.mjs`, `BUNDLER_ONLY`); the others are in the tarball
for the listed ones to import, never by name. Its server modules and the
preset are exported as before.

`node scripts/check-boundary.mjs` refuses a name on the list that the package
as published does not export (and, where an importer is in the tree, an
imported name that is not on the list, or a listed one nothing imports).
`scripts/audit-exports.mjs` counts every name a listed module exports as used:
the host's files are not always here to mention it. Adding a name is a line
in review; removing one breaks the host, so it waits for a release that says
so in `CHANGELOG.md`.

A host dresses its own screens through three seams, all on the list. It
declares its looks once from its main, before the kit's shell boots:
`registerHostLooks([{ id, label, sheet, swatches? }])` from
`@mistriwork/kit/client/visualTheme.js`, where `sheet` is an address or a
module that loads the stylesheet. Preferences offers them beside the
native default and the built-in looks; a pick is kept where the Workbench's
other picks are (`mistri.workbench-visual-theme`, which the startup veil's
cached colors are keyed by), the page is held until the sheet is in, and
while one is worn the root carries `data-host-look="<id>"` and no kit look's
attributes, so every rule in its sheet keys on that. A look may set
`--data-face` on the root to set the data — the grid's short values
included — in another face; the reader's explicit Typography (Mono or Sans)
wins over it. And `@mistriwork/kit/client/fonts/faces.css` declares the
kit's own faces (Barlow, Barlow Semi Condensed, IBM Plex Mono, Inter, each
under the SIL Open Font License, its text beside it), with each `.woff2` a
subpath of its own, so a host's look can name them.

### The host entry

`@mistriwork/engine/host` (`packages/engine/src/host.ts`) is the one entry
the browser is to open a database through: exactly the names its server
modules take from the engine to connect (and keep a `Registry` of configured
connections), read the catalog, answer reads (records, a view, a count, a
breakdown, the query language and its explainer), make the recorded writes
with what a delete reaches and why a write failed, keep the write journal
behind Undo and provision its store, and give the agent tools cancellation
and the nearest name. It is on the host list as `./host`. It is Preview, as
the rest of the engine is, and is promoted once the browser has moved onto
it; a name is added when the browser needs one, never ahead of it.
`test/engine-host-contract.test.ts` imports this entry alone, holds its
names to that list, and does with it what the browser does. The serving, the
CLI and the HTTP plumbing stay on the host list's deeper paths.

A writable connection keeps its write journal in its database when the
database holds the `undo-journal` store (`provisionSqliteWriteJournal`,
`provisionPostgresWriteJournal`, or `provisionStores({ only: ['undo-journal'] })`):
fifty writes a connection, for a week, read back when it opens. Without the
store the journal is the process's alone, as it always was: opening a
connection creates nothing, and says once, with the step that provisions the
store, that a restart will forget it.

The proof that the browser builds and serves from the tarballs runs in its
repository, against the packages this one publishes; the kit's and the
engine's exported names it uses that nothing here imports carry an `@public`
tag in their JSDoc, so `knip` keeps them.

## The allowlist is empty

`scripts/boundary/allow.json` held every crossing the tree had when the
check was written, as `"from -> to": "fix"`, with the cut that would remove
it. It shipped in 0.9.6 at 69 crossings; 0.9.8 made the last cuts:

| fix               | the cut                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store-host`      | the App stores leave the dialect adapters for a `StoreHost` seam                                                                                              |
| `config-sections` | the engine reads `connections`; mistri registers its own sections of `mistri.json`                                                                            |
| `app-targets`     | migrate and seed take an App's databases and stores from a registry                                                                                           |
| `rules-down`      | the page, list and view rules, and the shared rules the kit reads, move into the engine; a section kind is a closed union with a traits table, not a registry |
| `mode-seam`       | the kit asks a shell-mode seam for the visitor, tenant and account state                                                                                      |
| `slots`           | kit components reach App features through a renderer registry or a record-page slot                                                                           |
| `dispatcher`      | an engine router with gate hooks; each product mounts its own dispatcher                                                                                      |
| `two-mains`       | two binaries, each with its own main, importing only its own layer                                                                                            |
| `two-shells`      | a kit shell, and a shell per product                                                                                                                          |
| `move`            | a small move: the shared piece moves down, or is read through a seam                                                                                          |

It is `{}` now, and `test/check-boundary.test.ts` holds it so. The check
fails on any crossing, naming the fix its kind takes: a crossing is fixed,
or its file placed differently, never listed. The machinery stays for the
check's own fixtures: an allowance for a type-only crossing (`, type-only`)
fails once it imports a value, an entry the tree no longer has fails, and
`node scripts/check-boundary.mjs --write` removes those and never adds one.

`node scripts/check-boundary.mjs --report` prints the modules by layer and
folder, the crossings by layer pair and fix (none), and what each entry
reaches. The packages can be drawn.
