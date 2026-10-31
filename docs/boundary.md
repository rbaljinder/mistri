# The import boundary

The repository is one tree today, and it is to be cut into separate packages:
the database browser (`tablewalk`), the App framework (`mistri`), and the two
layers both of them stand on. A cut like that can be made only once, and only
after the tree stops growing new imports across the line. So the line is
drawn now, in the tree, and `scripts/check-boundary.mjs` holds it on every
`npm run test:static`.

## Five layers

| layer | what it is | becomes |
|---|---|---|
| `engine` | the adapters, the server's data paths, the HTTP kit, and the shared rules (filter, schema, query language, view, row scopes, and the looks: the built-in looks, their tokens and which one a page wears, which the server reads to send a first page already in its look, with the looks' published types, `packages/engine/schema/theme.d.ts`). `migrate` and `seed` are engine. No React. | `@mistriwork/engine` |
| `ui` | the standalone primitives: Modal, DropMenu, Dropdown, Typeahead, Button, Field, Icon and DateField over Base UI, the tokens and the stylesheet they are drawn with, the anchor their popups are placed by and the zoom-aware ruler it measures with (`packages/ui/src`). A primitive reads no walk, address, transport, resource request or copy catalog: its words, icons and answers are props. Each renders under Vitest with no server. | `@mistriwork/ui` |
| `kit` | the shared React client: the walk, the address, Grid, Value, the record page, lists, filters, the menus that read the walk (OverflowMenu, ThMenu), the date field, charts, the client's UI tokens and stylesheets, and the client that applies a look | `@mistriwork/kit` |
| `browser` | the database browser: the Workbench's own rooms (query and SQL panes, the connection manager, Peek, Ask, FindValue, ShapeCheck, the agent console, Welcome), the database MCP, lint, diff, impact | `tablewalk` |
| `mistri` | the App framework: every App directory under `src/server`, the tenant shell, auth, the API, commands, jobs, workflows, the App stores, the public surface, `@mistriwork/mistri/ui`, `src/embed`, and the rest of `schema/` | `mistri` |

The kit is a layer of its own because the Workbench's record view *is* the App
record page: the two shells share most of the client, and that client needs
React, which a server-only consumer of the engine must not have to install.

## The rule

```
engine  <-  kit  <-  browser
ui      <-       <-  mistri
```

- `engine` imports only `engine`, and `ui` only `ui`.
- `kit` imports `kit`, `ui` and `engine`.
- `browser` and `mistri` each import themselves, `kit`, `ui` and `engine`, and
  never each other.

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
it, it is `browser`; only an App, `mistri`; both shells' client, `kit`; a
primitive that draws with no walk, address, transport or catalog behind it,
`ui`; both servers, or a rule both read, `engine`. If the answer is "both, but
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

## The bins

Each product is a binary of its own. `tablewalk`
(`packages/tablewalk/src/server/index.ts`) runs the database browser's main,
`cli/browserMain.ts`, and nothing else; `mistri`
(`packages/mistri/src/server/index.ts`) runs the App framework's,
`cli/mistriMain.ts`. Neither names the other product: a start that is the
other's is refused with the other's command (`npx @mistriwork/mistri --app <dir>`,
`npx tablewalk <db>`), never handed across, so installing one never loads
or installs the other. Both entries are the engine's `runBin`
(`cli/bin.ts`) with their own main.

One module still names both products, because one client source serves
either: the page's entry, `packages/kit/src/client/shellStart.js`, wears the
kit's look and starts the main of the product that sent the page — the
database browser's (`workbenchShell.js`) where the page carries the
`mistri-shell` meta, the App framework's (`appShell.js`) otherwise. Each
product's build (`config/vite.tablewalk.config.ts`, `config/vite.mistri.config.ts`) puts the
other's main out of its bundle; from source, Vite serves both. Each main hands
the kit's shell (`app.js`) its chrome, and the Workbench its tools, through the
shell API in `shells.ts`; neither the kit nor one product imports the other.
`scripts/boundary/bins.json` declares that bin — the file, its mains and the
reason — and that declaration is the whole exception:

- the bin's `import()` of a main it declares is not a crossing;
- a static import of one fails, because a build without that product
  could no longer start;
- a declared main the bin no longer imports fails, so the list stays true;
- anything else the bin imports across the line is a crossing like any
  other.

## Entries

`scripts/boundary/entries.json` names what each package will be imported
by: every `mistri/*` entry, `@mistriwork/engine` (`packages/engine/src/engine.ts`: connect, the
catalog, the query language, keyset pages), `@mistriwork/ui`
(`packages/ui/src/index.ts`: the primitives), `@mistriwork/kit`
(`packages/kit/src/client/kit.ts`: the shell API and the UI tokens), and `tablewalk`, the
database browser's bin. Each entry gives its layer, its `source` and its
`types`. The browser publishes none of the App framework's names: an App
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
  pattern (`./*`) but `@mistriwork/mistri/schema/*`'s shipped schemas: each names every module another package imports
  (the two products' mains, `client/appShell.js` and `client/workbenchShell.js`, are named for the kit's page entry and
  left out of an install's manifest);
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

## The allowlist is empty

`scripts/boundary/allow.json` held every crossing the tree had when the
check was written, as `"from -> to": "fix"`, with the cut that would remove
it. It shipped in 0.9.6 at 69 crossings; 0.9.8 made the last cuts:

| fix | the cut |
|---|---|
| `store-host` | the App stores leave the dialect adapters for a `StoreHost` seam |
| `config-sections` | the engine reads `connections`; mistri registers its own sections of `mistri.json` |
| `app-targets` | migrate and seed take an App's databases and stores from a registry |
| `rules-down` | the page, list and view rules, and the shared rules the kit reads, move into the engine; a section kind is a closed union with a traits table, not a registry |
| `mode-seam` | the kit asks a shell-mode seam for the visitor, tenant and account state |
| `slots` | kit components reach App features through a renderer registry or a record-page slot |
| `dispatcher` | an engine router with gate hooks; each product mounts its own dispatcher |
| `two-mains` | two binaries, each with its own main, importing only its own layer |
| `two-shells` | a kit shell, and a shell per product |
| `move` | a small move: the shared piece moves down, or is read through a seam |

It is `{}` now, and `test/check-boundary.test.ts` holds it so. The check
fails on any crossing, naming the fix its kind takes: a crossing is fixed,
or its file placed differently, never listed. The machinery stays for the
check's own fixtures: an allowance for a type-only crossing (`, type-only`)
fails once it imports a value, an entry the tree no longer has fails, and
`node scripts/check-boundary.mjs --write` removes those and never adds one.

`node scripts/check-boundary.mjs --report` prints the modules by layer and
folder, the crossings by layer pair and fix (none), and what each entry
reaches. The packages can be drawn.
