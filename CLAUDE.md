# Working in this repo

This repository builds two products. tablewalk is a read-only-by-default
database browser (SQLite, Postgres, MySQL) that serves a web UI and speaks MCP
to coding agents. `npx tablewalk <db>` is the whole deployment of the database
browser — there is no build step for it. mistri is the App framework: an App
runs from its source directory the same way (`npx @mistriwork/mistri --app <dir>`,
`npx @mistriwork/mistri dev`); `mistri build` (`packages/mistri/src/server/build/`) is an
optional production step for one — typecheck, validation, a bundle pinned to
the mistri version that made it — and serving never requires it.

An App's own names are mistri's: `mistri.json` beside it, `.mistri/` for
`mistri dev`, `~/.config/mistri`, `mistri-schema.d.ts`, the `MISTRI_*`
variables, and `__mistri_*` runtime tables (there is no rename or upgrade path
before 1.0: a database from an earlier build is wiped and reseeded).
The browser keeps `tablewalk.json`, `~/.config/tablewalk` and `TABLEWALK_*`. A
variable both binaries read is read in the running one's name
(`packages/engine/src/server/product.ts`). The repository's own harness
variables (`TABLEWALK_TEST_PG`, `TABLEWALK_TEST_MYSQL`, `TABLEWALK_REQUIRE_LIVE`,
`MISTRI_BUILT_CLIENT`, …) keep their names.

## Active app-platform work: next-session reading order

The repository ships an engineer-first TypeScript DSL app framework beside the
browser; the standalone database browser must remain independently launchable.

Maintainer working notes (status, plans, backlog, review evidence) are not in
the repository, which is public. A maintainer may keep them in a local,
gitignored `.notes/` folder; when it is present, start with `.notes/README.md`,
which gives the reading order. When it is absent (a fresh clone), start from
`docs/architecture.md`, `docs/apps.md` and the site docs, and treat the code and
tests as the record. For a selected task, read the relevant
`examples/apps/lintel` authoring modules (or the fixtures under `test/fixtures/apps`); do not
infer working workflows from seeded UI states.

Never commit anything under `.notes/`, and never link public documents to it.
Commit messages keep the `Co-Authored-By` trailer but never a `Claude-Session:`
trailer, and pull request descriptions never include the claude.ai session link.
On a working branch, preserve the user's single-amended-commit branch policy
and check remote state before any leased force push; release tags go on `main`. Leave `.idea/` alone and
never stage/reseed `.demo/` or print its credentials. Run `npm test` and browser
suites sequentially because they share disposable `e2e/.tmp` fixtures.
The Node gate runs in two lanes (`scripts/test-node.mjs`): a parallel lane for
every file that owns whatever database it touches, and a serial lane for the
files that still work in the one database `TABLEWALK_TEST_PG` or
`TABLEWALK_TEST_MYSQL` names. The lane is read off the source, so a new file
reaching a shared engine runs serially by default; `node scripts/test-node.mjs
--lanes` prints the partition. Every test belongs to one package
(`scripts/test-owners.mjs`, read off what it reaches; one that holds both
products to one rule says `test-package: shared`), and `--package=<name>`
keeps either gate to that package's tests and the shared ones. The browser gate is two lanes on the same
principle (`scripts/test-e2e.mjs`, `scripts/e2e-lanes.mjs`): specs that start
their own server on a `listen(0)` port over a `mkdtemp` database run several at
once, and the ones that address the three servers `playwright.config.ts` starts
run one at a time, because a tablewalk process has one active connection. The
lane is read off the spec's source — a spec naming a shared port, navigating to
a `baseURL`-relative path, or importing a shared fixture database is serial by
default — and the parallel lane runs with no shared server at all, so a spec
that lands there wrongly fails on a refused connection rather than racing.
A spec that needs the explorer, Field Ops or Compass server can own a copy:
import `test` from `e2e/support/ownServers.ts` and name them with
`test.use({ servers: [...] })`; each worker starts its own over copies of the
fixture databases, so the spec runs in the parallel lane. Most specs do; the
few left serial need a shared screen, timing or geometry.
`npm run e2e -- --lanes` prints the partition. Vitest uses two workers. Do not
overlap these gates with browser/load suites.
For the edit loop, `npm run affected` names the suites a change could have
broken by walking the import graph backwards (`--since main`, `--run`, or a
list of files). It prints what it could not follow — an App loaded by path, a
stylesheet, the published schema — and selects everything when it meets one.
**Selection never gates a release**: the full gate is what a release runs.
`test/combinations.test.ts` is the fixture for defects that only appear where
two features meet; `node scripts/combination-proof.mjs` re-introduces known
defects one at a time and expects it to go red, which is how that fixture is
kept honest. It edits `src/` and restores with `git checkout --`, so it
refuses to run with a dirty tree.
Other frameworks are feature inspiration only; preserve this project's design.

## Architecture, in one paragraph

The repository is an npm workspace of six packages under `packages/`, one per
layer (`docs/boundary.md`) and `create-mistri`: `@mistriwork/engine` (adapters, the server's data
paths, the shared rules), `@mistriwork/ui` (the standalone primitives: Modal,
DropMenu, Dropdown, Typeahead, Button, Field, Icon and DateField, the tokens and
their stylesheet, and the zoom-aware ruler),
`@mistriwork/kit` (the shared React client), `@mistriwork/mistri` (the App framework and its
bin, `mistri`), `create-mistri` (`npm create mistri`, which runs `mistri new`) and `tablewalk` (the database browser and its bin, `tablewalk`,
which never depends on mistri). The root is private and
publishes nothing. Each package's `exports` answers from its `src/` in the
checkout and from its `dist/` under `--conditions=mistri-built`, which a pack
makes the only form (`scripts/pack-manifest.mjs`); a release publishes all
six at one version. The engine, the kit and ui export each module another
package imports by its path, never `./*`: importing one more is a line in that
package's `exports`, which `check-boundary` holds you to. The **server** is TypeScript, compiled into each
package's `dist/` by one `npm run build` (`scripts/build-packages.mjs`). The
**client** (`packages/*/src/client/`) is hand-written ES modules, and imports
the TypeScript under `src/shared/` directly — one rule for what a row is
called, how a record's columns group, where a condition ends, on both sides.
That is runnable because of `vite.config.ts`: `npm run build` bundles the
client once per product (`vite.tablewalk.config.ts`, `vite.mistri.config.ts`)
into that product's `dist/client`, each without the other's main, with a
first-paint budget per binary (`scripts/bundle-budget.mjs`) — minified, content-named and precompressed, with its source
maps shipped beside it. The entry (`boot.js`, `shellStart.js`) starts one
of two mains: the App framework's (`appShell.js`, in the entry's chunk) or the
database browser's (`workbenchShell.js`, its `workbench` chunk, where the page
carries the `mistri-shell` meta). A first page is the entry and its
surface's chunks (`surfaces` in `vite.config.ts`): `public` (a public form,
the landing, the sign-in screen); an App's the kit's shell (`shell`,
`app.js`) and the App's chrome (`chrome`, `appnav.js`); the Workbench's the
shell and its main, never the chrome. A tenant's flows (`tenantShell.js`)
load where they are used. The build writes a page per surface that preloads
its chunks and the server sends the one an address needs
(`packages/engine/src/server/clientSurface.ts`); the rest are parts loaded on demand
(`components/onDemand.tsx`). An App's icons arrive with its payload as path
data (`scripts/generate-icons.mjs`); the bundle holds the chrome's few. It was unminified on purpose once, for readable stack
traces, until 3.4 MB of script stood before an App's first paint; the maps
keep the traces readable. Under tsx — `npm run dev`, the
Vitest and Node suites, `npm run smoke` — the server serves `src/client`
through Vite's middleware (`packages/engine/src/server/devclient.ts`), so an edit is a reload
away and nothing has to be built first. `npm run e2e` is the exception: it runs
`vite build` once per product (skipped while both products' `dist/client` are newer than every
package's `src/client` and `src/shared`; `--no-build` skips it) and starts its servers with
`MISTRI_BUILT_CLIENT=1`, so each serves that build instead of owning a
Vite. A spec that imports a client module by its source name or rewrites one
on its way to the page says `e2e-client: source` and runs unbuilt. A person running `npx tablewalk` still has no build step.
`test/check-client-types.mjs` type-checks the client via JSDoc, and
`test/check-client-geometry.mjs` enforces the one zoom-aware ruler; `oxlint`
catches a name used and never imported. The five layers are held by
`scripts/check-boundary.mjs` (`docs/boundary.md`): `engine` and `ui` ← `kit` ←
`browser` / `mistri`, a module's layer being the package it sits in, each
package's entry points in `scripts/boundary/entries.json`, and an empty
allowlist that stays empty. The kit reaches App features through the
shell's answers (`shellMode.ts`: `slots`, `rooms`), never by import. `test/agreement.test.ts` holds what
is left of the old "mirrors" suite: the client readings of server rules that
are not copies (the chip splitter, the path walker, the export rewrite) and
still have to agree. **The client renders through React** (`packages/kit/src/client/components/` and each product's own,
TypeScript with JSX, TanStack Query; `docs/build-stack-assessment.md` is
the case and the log): the content pane is one tree (`components/Content.tsx`)
driven by the walk, every room fetches through Query, and each component
has a test under Vitest (`npm run test:components`, happy-dom). The `.js`
modules that remain are stores, models and behaviour — the walk in
`core.js`, the URL in `url.js`/`deeplink.js`, the query-bar completer,
the per-room stores — plus `boot.js`, which is boot, and `app.js`, the
shell it loads. A vanilla module that
still needs to draw crosses over through `components/mount.tsx`. Headless
behaviour comes from Base UI (`@base-ui/react`), dressed in the tool's own
classes: `Modal.tsx` (every dialog), `DropMenu.tsx`/`OverflowMenu.tsx`/
`ThMenu.tsx`/`TopNav.tsx` (every menu), `Dropdown.tsx` (the listbox) and
`Typeahead.tsx` (every box-with-a-list); the walk-free ones are `@mistriwork/ui`'s
(`packages/ui/src/`) and take their words as props. Popups are anchored through
`anchor.ts`, which measures on the zoom-aware ruler (`packages/ui/src/ruler.ts`) — Floating UI does not
know about the density zoom on the root — and are drawn inside the
enclosing dialog when there is one. The assessment's step 4 says what was
left by hand and why.

## Facts that are written in more than one place — keep them in sync

These are the things that went stale before. Each lives in the code **and** in
prose (each package's `README.md`, the site's `site/src/content/docs/docs/database-browser.md`, each
binary's `USAGE` in `packages/<bin>/src/server/cli/usage.ts`). When you change the code, change the prose in the same
commit. `test/prose.test.ts` and `test/prose-<bin>.test.ts` enforce the tool count, the USAGE↔README
flag list, and the dialect keywords on every `npm test` — it found five
missing flags and a missing dialect the day it was written. The manual
commands below remain the way to *see* the live values.

- **MCP tool count and names.** The database MCP is the browser's: stated in `packages/tablewalk/README.md` ("Twenty-three tools…")
  and the site's `site/src/content/docs/docs/database-browser.md` ("up to twenty-three tools"). The source of truth is
  `packages/tablewalk/src/server/mcp.ts`. A read-only connection lists only the reading tools; a
  `"writable": true` connection also lists the writing ones. Verify the full
  set:
  ```sh
  printf '%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
    | npx tsx packages/tablewalk/src/server/index.ts --mcp --config <a-writable-config>.json 2>/dev/null | tail -1 \
    | node -e 'const t=JSON.parse(require("fs").readFileSync(0)).result.tools; const r=t.filter(x=>x.annotations?.readOnlyHint); console.log(t.length,"tools:",r.length,"read,",t.length-r.length,"write")'
  ```
  If the number or a tool's name changes, update both prose files.

- **Deep-link URL format.** The app uses **path** routing (`pushState` +
  `popstate`), not hash routing. In the Workbench a record is
  `/{connection}/{table}/~{id}`, a page `/{connection}/@{page}~{id}`, and the
  query language stays in the path (`/demo/invoice%20total%20%3E%20500`). An
  App has one canonical address per thing (`packages/mistri/src/shared/appAddress.ts`, read by
  the client's `publicAddress.ts`, the server's `http/publicHead.ts` and
  `mistri check --routes`): a record is its id under the first view that
  shows its table which the person is served (`/leads/127`, a tab
  `/accounts/13/opportunities`, a split's pick `/inbox/2`; a resident's repair
  `/my-requests/12`, the office's `/repairs/12`, and a signed-in person given
  the other's is sent on to theirs), the New form `/leads/new`, a
  dashboard `/sales-dashboard?period=last-30-days` (a section with its own
  windows `?period.<its title as a slug>=last-7-days`), and a list's tab,
  search and refinements are parameters (`/leads?tab=working&search=stone`,
  `/vehicles?make=Toyota,Honda&price=..15000&sort=-price`,
  `packages/mistri/src/client/publicAddress.ts`), `q=` only for what those cannot say. A
  natural key (`/label/bug`) and a public slug
  (`/vehicles/1-2024-toyota-corolla-le`) are opt-in. The walk rides
  in `history.state`, never the path. A query-language or `@`/`~` address — an
  App's too — still opens and is rewritten to the canonical one. A `#/…` link
  is not read at all, so any `#/…` example in prose is stale. **Where an App is
  mounted** is one rule, `packages/engine/src/shared/mount.ts`: a server serving one App serves
  it at the root (the addresses above); several each keep `/{app}`
  (`/compass/leads/127`), one of them may be the main App at `/` (`--mount
  main=/`), and `--base-path /tools` puts the whole server under a reverse
  proxy's path. Inside, every address is still `/{app}/…`; the server reads a
  request through `inward` (http/server.ts) and writes every address it sends
  through `outward`, and the client does the same at its edges
  (`packages/kit/src/client/addressMount.js`: the address bar, links, fetches), from the
  `<meta name="mistri-mount">` the page carries. There are no aliases: the
  spelling that applies is the only one. The standalone database browser
  mounts nothing; a tenant App is mounted by the same rule.

- **Supported dialects.** SQLite (built in), Postgres (`pg`), MySQL/MariaDB
  (`mysql2`). Listed in the `README.md` Databases table, the site, and the
  `tablewalk` package's keywords (`packages/tablewalk/package.json`). Adding
  one is a new file under `packages/engine/src/adapters/` plus
  a case in `packages/engine/src/adapters/connect.ts`.

- **CLI flags.** Each binary's `USAGE` (`packages/tablewalk/src/server/cli/usage.ts`,
  `packages/mistri/src/server/cli/usage.ts`), the Options block of that package's README
  (`packages/<bin>/README.md`), and the site's CLI pages (`scripts/cli-reference.mjs`) must
  agree. `npx tsx packages/<bin>/src/server/index.ts --help` prints the live version.

- **The read-only / write-opt-in claim.** Browsing is read-only; editing is
  per-connection opt-in (`"writable": true`) and enforced on the server — in
  every route and tool that writes — not the UI. Every place that describes writes should say so.

- **Values that are not JavaScript numbers.** Ids past 2^53 come back from the
  adapters as **strings** and must never be run through `Number()` for display
  (that silently rounds them). Both display formatters — the grid's `Cell` in
  `packages/kit/src/client/components/Grid.tsx` and `sayValue` in
  `packages/kit/src/client/components/valueModel.ts`, which `Value.tsx` draws — guard this;
  keep any new value renderer consistent. Covered by `e2e/grid.spec.ts`.

## After any client edit

`npm run smoke` (~5s) walks every room in a real browser — explorer and
app mode — asserting each one paints and nothing throws. The client is
buildless, so nothing executes it until a browser does: a constructor-time
throw in a shared module (a dropdown, a grid helper) blanks whole views
while tsc, the check scripts and the unit suite all stay green. That
happened; the smoke run exists so it is a five-second test failure next
time. Every e2e test also fails on any uncaught page error now
(e2e/support/harness.ts) — mutations.spec is the one deliberate
exception, since injecting broken client code is its job.

`package.json` has no `overrides` block, and one should not come back to
quiet a peer warning. The last one pinned Better Auth's optional Vitest peer
to ours until 1.7.10 widened its range to Vitest 5: the image build's
`npm prune --omit=dev` removes our Vitest and then tries to satisfy every
remaining peer with a version of its own, which npm 11.17 refuses where the
range excludes what the lockfile has. Local `npm ci` cannot catch this — npm
11.12 accepts it and only the newer npm in `node:24-alpine` does not — so the
Docker job is the check; when a dependency's peer range lags ours, an
`overrides` entry naming `$<the dependency>` is the fix, and it goes when the
range widens.

## Before a release

- `npm test` (add live Postgres via `TABLEWALK_TEST_PG` +
  `TABLEWALK_REQUIRE_LIVE=1`, seeded by `npm run seed:live`; MySQL's live
  tests are paused — `PAUSED` in `test/live.ts` — and skip unless
  `TABLEWALK_TEST_MYSQL` is set) and `npm run e2e` must both be green. CI enforces both;
  the release workflow re-runs them on the tag.
- `npm run test:ci-parity` (seconds; after `npm run build` for the bundle
  margins) — what only CI used to catch: Dockerfile COPY sources and build
  inputs, stale CLI/DSL references, a bundle measure within 0.1% of its ceiling.
- `node scripts/visual-matrix.mjs` — every story and a set of real sample-App
  pages in all three looks, light and dark, desk and phone; App pages also in
  the App's own look, dark on a phone, and captured whole (the window made as
  tall as the room), with Compass served writable so its New form, a working
  lead's actions and a field in edit are seen. Tick and the Parcel fixture
  (an HTTP source) are always in it; Ignition only when `TABLEWALK_TEST_PG` names a PostgreSQL server (about
  1,000 captures, 10 minutes; Storybook must be running on :6006). Review
  `.visual/index.html`: changed images come first beside their baseline and a
  diff. Take a baseline (`--baseline`) before a change you expect to be
  invisible, such as a cascade or refactor, and compare after it. The baseline is
  local and never committed; compare on one machine. `--smoke` (CI's) takes
  no pictures: every App page in every look, light at a desk and dark on a
  phone, must load without a page error or a sideways scroll.
- `node scripts/surface-atlas.mjs --look lumen,mono,sage` — one capture of
  every kind of surface (shell, list, record, New drawer and page, command
  dialog, intake, review, dashboard, board, calendar, landing, sign-in, empty,
  refused, not found, settings) side by side in `.visual/atlas.html`, read from
  the matrix's captures and filling the rest; `--mode`, `--device`, `--width`.
  Read across a row for drift between kinds: label, field, button order, words.
- `npm run build` runs `scripts/bundle-budget.mjs` and `scripts/type-budget.mjs`: each surface's first
  paint (public, App, Workbench) has script and stylesheet ceilings, raw and
  in brotli, and
  `npm run test:built:browser` holds what a cold visit fetches for a real
  room. Raise a ceiling only where it is set, with the reason beside it.
- `npm run test:built:vitals` (after the build) — Web Vitals on the built
  client: CLS with the nodes that moved, LCP with its element, and INP with
  the CPU slowed to a quarter of the reference machine's (scaled to the
  machine it runs on), for every surface's first paint cold and warm, the
  rooms, and a list's everyday interactions, on Compass, Forecourt, the
  Workbench and, where `TABLEWALK_TEST_PG` names a server, Ignition; desk and
  phone, the median of three runs. The budgets (`BUDGET` in the file: CLS
  0.01, LCP 1.2 s, INP 100 ms, each tighter than Google's "good"; an
  interaction that starts a room over, which the navigation hold pictures, at
  Google's 200 ms) and any exception sit there with their reasons. `--report <file>` writes the
  tables; `--only`, `--width` and `--filter` narrow a run while fixing one.
- `npm run build`, then `npm pack --workspaces --dry-run` — read each file
  list. A pack builds nothing: each package's `prepack` refuses a missing
  `dist/`, rewrites the manifest so every export names `dist/`, and its
  `postpack` puts the checkout's back. Each package's `files` allowlist is what
  ships; nothing else. mistri's `schema/` is in its exports map, so it must
  stay, and `dist/docs` carries the shipped reference and its guide
  screenshots. The `mistri` package carries files that live elsewhere in the
  checkout (`CARRIED` in `scripts/pack-manifest.mjs`): the agent skill
  `mistri agent init` installs (`skills/mistri`), and the sample Apps'
  sources, so the skill's sample links (`../../../examples/apps/…`) and
  `mistri docs` resolve offline, at the installed version.
- The version in the root `package.json`, every package's and the `v*` tag
  must match, and the packages name each other at exactly it (the release
  workflow refuses a mismatch; `test/pack-manifest.test.ts` holds the packages
  to the root), and `CHANGELOG.md` carries the release's entry.
- A release renames the changelog's `## Unreleased` to its version. A release
  that ships renames carries its own upgrade note (0.9.0 has "Upgrading from 0.8
  to 0.9"), since that is where readers meet them. From 1.0.0 the public-surface inventory
  refuses a removed or renamed public name (`docs/compatibility.md`).
- If `site/**` changed, run `npm run build:site` and verify the generated
  `site/dist/` output. The Cloudflare Pages workflow builds/deploys on main when
  both secrets are set; manual feature-branch runs use preview deployments.
  Publishing is a separate authorized action; never upload the source directory.

## Pending before / after 1.0

The npm, Docker and desktop release pipelines are all proven (validated on the
throwaway 0.0.1–0.0.4). What is left:

- **Mac signing and notarization.** `desktop/package.json` is configured for it
  (`hardenedRuntime: true`, `notarize: true`, the entitlements) and
  `desktop-release.yml` signs and notarises with the repository's `CSC_LINK`,
  `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
  `APPLE_TEAM_ID` secrets. Confirm a signed build shipped from the current
  workflow before pointing the site's Download links at `/releases/latest`.

- **Windows code signing — post-launch.** Unsigned Windows is a mild
  SmartScreen "More info → Run anyway", so it does not gate the launch. The
  modern path is **Azure Trusted Signing** (~$10/month, CI-friendly);
  electron-builder supports it via `azureSignOptions`. OV/EV certs are the
  alternative but need a cloud HSM and, for individuals, a multi-year identity
  history.

- **Deploy the site with a signed release.** The replacement Markdown/Starlight
  site lives in `site/src/content/docs/`, builds to `site/dist/`, and is not
  deployed until explicitly requested. Its Download links point at `/releases` (the list,
  which shows pre-releases). Once a signed build ships as a full release,
  consider pointing them at `/releases/latest` again so the newest signed
  build is the default.

## Public Examples

When asked to build an App rather than change the framework, start with
[Build an App with a coding agent](site/src/content/docs/docs/build-with-an-agent.md).
It provides the task brief, source-checkout/package-resolution boundaries,
separate authored-App typecheck and catalog check, and browser acceptance gate.
Keep ordinary App work on public APIs; report missing platform capabilities
instead of importing private internals or expanding framework scope incidentally.

The user/LLM entry point is `examples/apps/README.md`: exactly Tick, Lintel and
Ladle. Author apps and pages with the TypeScript DSL and checked
schema types. Tick deliberately keeps its definition and inline types in one
`app.ts`; Lintel uses small, cohesive modules. Ladle is the general path: a
free-form page, and a host of its own (`host/`: a Node server with the handler
beside the host's own route, a React site embedding the App) — the one sample
whose host code is not mistri's, so it stays on public entry points too. Every App has a README.
Seed scripts and database setup belong under `examples/databases/<app>/`, not
inside the App authoring directory, including Tick.
Runtime connection JSON is configuration, not a second App definition.
Retired examples under `test/fixtures/apps` exist only to preserve regression
coverage: do not promote them as starters or add new public samples incidentally.

## Style

`docs/design.md` is the design system — tokens, motion doctrine, the
refusal list. UI work reads it first; when a change and the doc
disagree, fix one of them in the same commit.

Match the surrounding code. Comments explain **why**, not what. The commit
messages and code comments here carry a lot of the "why" — read the nearby
ones before changing a thing that looks odd; it is usually load-bearing.
