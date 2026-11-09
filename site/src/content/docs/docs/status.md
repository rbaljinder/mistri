---
title: Status & roadmap
description: The 1.0.0-rc.27 scope, stable and preview features, current limitations and planned work.
---

The scope of this release, stable and preview features, current limitations and planned work.

```sh
npx @mistriwork/mistri check --app .
#   preview: This App uses Preview features (…). They work as documented and may change in any 1.x release.
```

This site describes **mistri 1.0.0-rc.27**, a release candidate. Since rc.2, the first release under the mistri name,
the App framework is split out of tablewalk, which stays the standalone database browser. A save is a fixed number of
database round trips, the runtime forgets what it wrote about an App after the App's own retention windows, and on
PostgreSQL the runtime lives in one schema named `mistri`. There is no upgrade from a tablewalk 0.9 App database.
Each version's full list is in the changelog (`CHANGELOG.md`).

## Stable and preview

**Stable**: the documented shape holds; a change is named in the changelog.
Every feature below is stable unless marked **Preview**. A Preview feature is
enforced on the server as documented, but its shape may change in any 1.x release,
outside the compatibility promise; `mistri check` lists the Preview features
an App uses, as information. At 1.0 these stay Preview: feature flags,
audiences and `@mistriwork/mistri/openfeature`, experiments, the Suite Console, behavior
analytics, SCIM, the Gantt presentation, a resource's `search` (its packs ship
after 1.0), an App's installable PWA (`ui.pwa`, [installable PWAs](/docs/pwa/)), `@mistriwork/ui`, `mistri deploy` with `@mistriwork/cloudflare`, `roundTrips` in the testing entry, and the triggers a row-policy App names (`resources.<t>.triggers`). Also Preview, because they were added late and no more than one sample App uses them: reactions on a timeline, a value's `copy`, `timezone` and `whole`, the `address` format, a metric's `figure`, a list's `group`, a calendar's `span`, a reference's `tree`, the crumb bar's `home` and `top`, the command inputs `field.time`, `field.files`, `field.signature`, `as: 'rating'`, `'scan'` and `'color'`, the command aggregates (`count`, `sum`, `avg`, `min`, `max`, `period`), and the embed router adapters. The [compatibility promise](/docs/compatibility/) covers the rest. The kernel, tenant Apps, SAML,
flows and machines, the assistant, integrations and durable workflows are
stable.

### The App DSL

| Feature | Status |
| --- | --- |
| Resources, list and dashboard views, tabs, filters, `sort`, `order`, saved views, `favorite`, `rowActions`, `totals`, `density` | Stable |
| `home` rules, `nav`, nav groups, menu icons, the icon rail and a nav entry's `color` dot | Stable |
| Canonical addresses (`/leads/127`), `path`, natural keys (`address`), public slugs, `mistri check --routes` | Stable |
| Checklist, queue, board, split, calendar, cards and tree presentations; the filter rail (`filterBar: 'rail'`) and a text filter's suggestions (`suggest`) | Stable |
| Cards read through a reference (`vehicle_id.title`, an image's `about`); a calendar's shaded spans (`backdrop`); a conversation's other side (a timeline's `side`) | Stable |
| Board cards' `category` and `footer`, a board's lane `sum` and `folded` lanes | Stable |
| Pages, display rules, record names (`recordLabel` templates) | Stable |
| Display rules `format: 'duration'`, `'avatars'`, `'rating'`, `'color'`, `'time'`, `'month'`, `'year'`, `'json'`, `'qr'`; `icon`, `colors`, `ring`, `slider`; video and audio file previews; the JSON editor, code scanner (`scan`) and signature pad (`signature`) | Stable |
| Record history (`history()`), notifications (`notify`) and the inbox | Stable |
| Rollups (`rollup.count`, `sum`, `avg`, `min`, `max`, `latest`) | Stable |
| Editing, autosave, lists edited in place (`editable`) and **Set field…** | Stable |
| Files and attachments (`file`), tags (`tags`), CSV import (`import`) | Stable |
| A resource's `search` and `mistri --reindex`: they need a search pack, which ships after 1.0, so nothing can be plugged in before then; the packs are the SQLite FTS pack (`@mistriwork/search-sqlite`, no external engine), the Postgres tsvector pack (`@mistriwork/search-postgres`, in the deployment's own database) and the Typesense pack | Preview |
| An installable PWA (`ui.pwa`): the App's manifest, worker, painted icons and offline page for failed navigations — installable plus shell-offline, not offline data | Preview |
| Resource `validation`, transitions (`machine`) and an action's `reason` | Stable |
| A machine state's `after` and a resource's `at` timers, which run through the jobs, and a machine's service-only moves (`by`) | Stable |
| Dashboards: metrics, charts, breakdowns, `rows`, `activity()`, section `windows`, interactive `embed`, `firstRun()` | Stable |
| `funnel()`; chart shapes `stacked`, `scatter`, `heatmap`, `waterfall`, `treemap`; `target`; `find()`; `week`, `weekday`/`hour` groups | Stable |
| Dashboard `banner()`, `breakdown` `shape: 'steps'`, a donut's `total`, `curve: 'smooth'`, `windowControl: 'button'` | Stable |
| Gallery, `headline()` (and its earlier figure, `was`), `card()`, facts, sheet and property-rail sections, section `tab`, ordered workflow strip, related cards, `related(…, { same, near })` | Stable |
| The Gantt presentation (`gantt()`, `kind: 'gantt'` and its keys) | Preview |
| `roundTrips(response)` in `@mistriwork/mistri/testing`: the database flights a request made, for a test to hold a budget with | Preview |
| Triggers a row-policy App names (`resources.<t>.triggers`): their keyed effects proven inside the person's rows, approved in `authority.lock`, kept in record history and announced to live sync ([row access](/docs/row-access/#triggers-the-app-names)) | Preview |
| Reactions under a timeline's entries (`reactions: { from, kinds, command }`) | Preview |
| A value's copy button (`copy: true`), the zone a moment is said in (`timezone`), a whole amount without minor digits (`whole: true`), the `address` format, and a dashboard metric's `figure: 'compact'` | Preview |
| A list's `group`, a calendar's `span` (`'week'`, `'day'`), a form field's reference `tree`, and the crumb bar's `home` and `top` | Preview |
| Row-defined fields (`defined`) | Stable |
| Flows from rows (`flows`, `flowRunner`, the `flows()` and `diagram()` sections, `mistri flows start`) | Stable |
| Forms with groups and `when`; multi-step forms (`form.steps`) | Stable |
| Money in minor units (`minor`, `currency: { column }`), a form's `lines` and `live` values | Stable |
| Command forms (`form` views) and public forms: saved on every step, `statusCheck` and its page, `keyed` inputs, `link` to an account | Stable |
| A status check's emailed code (`statusCheck.stepUp`) and a link by verified email (`link.email`) | Stable |
| Landing pages, signed-out reads (`auth.public`), `ui.footer` | Stable |
| The header's New menu (`ui.shell.new`) | Stable |
| [Custom components](/docs/custom-components/): `component()`, sections, value renderers, inputs, `customList()`, `useCommand`, `ui.csp`, public surfaces | Stable |
| [Free-form pages](/docs/custom-components/#free-form-pages) (`definePage` from `@mistriwork/mistri/page`, `pages/*.page.tsx`), their loaders and blocks, and a role's `service` | Stable |
| [The assistant](/docs/assistant/) (`assistant()`): a panel that reads and proposes as the signed-in person, Claude via `ANTHROPIC_API_KEY`; on a tenant App, per customer once the platform owner turns it on, sending only the person's messages and the rows their own reads return | Stable |
| [The assistant's page](/docs/assistant/) (`placement: [..., 'page']`), full screen, `starters`, and verbs on its record cards and table rows | Stable |

### Looks

| Feature | Status |
| --- | --- |
| The five built-in looks: Workshop (the default, set in Barlow), Lumen (set in Inter), Mono, Sage and Ledger (figures in IBM Plex Mono); `defineTheme`, `ui.theme` and `customThemes`; the twelve palettes every look offers; the theme validator in `mistri check` | Stable |
| Tenant branding (`branding`, `brandingForm()`, the `branding` store) | Stable |

### Access, commands and data

| Feature | Status |
| --- | --- |
| Sign-in, role grants for resources, fields, commands and operations | Stable |
| Fixed actions granted without write (`auth.roles.<role>.actions`) | Stable |
| Account administration and settings records | Stable |
| Row policies (`auth.rows: 'policy'`), named sources | Stable |
| Tenant Apps (`auth.rows: 'tenant'`, the platform realm, invitations, public intake, delegated administration, support access), a form's `realm` | Stable |
| Commands: declared inputs, typed `db`, checked record, `refuse`, output shapes, `actor` | Stable |
| Command inputs `field.time`, `field.files` and `field.signature`, `as: 'rating'`, `'scan'` and `'color'`, and `field.reference({ tree })` | Preview |
| The command aggregates in `@mistriwork/mistri/commands`: `count`, `sum`, `avg`, `min`, `max`, `period` and the types that go with them (`Grouped`, `Measure`, …); and `Loaded` in `@mistriwork/mistri/page` and `/ui` | Preview |
| Command `lookup`, `effects` and webhooks; events and jobs (`@mistriwork/mistri/jobs`, `--jobs`); the App's default `track` | Stable |
| Durable workflows (`@mistriwork/mistri/workflows`), their `workflows` operations grant and `createWorkflowDriver` | Stable |
| Email (`"kind": "email"`): notify `email` and `mentions`, step-up codes, links by verified email | Stable |
| Tenant App mail (`defineJobs` `mail`): the signed inbound webhook, the send loop with DKIM, signed record links, `mistri mail-dns` | Stable |
| HTTP sources (`--openapi`, `--from-openapi`, `"kind": "http"`) | Stable |
| [Sign-in from a host app](/docs/embed-sign-in/) (`"kind": "embed"`, `/api/auth/embed/exchange`) | Stable |
| [Read replicas](/docs/performance/#read-replicas) (a connection's `"replicas"`) | Stable |
| The App API and App MCP (`api`, `--api-reads`, `--app-mcp`, `mistri api-token`, `mistri new --api`, the OpenAPI and AsyncAPI exports, `compare-openapi`), over loopback or, with `api.network`, beyond it | Stable |
| `mistri build` | Stable |
| [App testing](/docs/testing-apps/) (`@mistriwork/mistri/testing`, `@mistriwork/mistri/ui/testing`) and [service virtualization](/docs/service-virtualization/) (`mistri virtual`) | Stable |
| [Feature flags](/docs/dsl-flags/#feature-flags), `useFlags`, command `enabledBy`, scoped flag capabilities, `@mistriwork/mistri/openfeature` | Preview |
| [Suite Console](/docs/suites/#flags-and-console): targeting, rollouts, history and revision-checked changes; its Operations and Analytics rooms (the `jobs`, `deliveries`, `stores`, `analytics` and `workflows` operations grants); its Governance room (an App's `admin` role) | Preview |
| [Behavior analytics](/docs/analytics/): `analytics` collection and funnels, the `analytics` store and sinks, sink presets (Segment, PostHog, Amplitude, GA4, a warehouse), `useAnalytics` | Preview |
| [Experiments](/docs/experiments/) (`experiments`, `experiment()`, a role's `experiments`, `defineExperimentConversion`, `useVisitor`, `mistri experiments`) and [audiences](/docs/dsl-flags/#audiences) (`audiences`), on an App's public forms and a tenant's public intake too | Preview |
| [SCIM provisioning](/docs/scim/) (`"kind": "scim"`, a directory's accounts and leavers) | Preview |
| [Mounting an App in your server](/docs/mount-in-your-server/) (`@mistriwork/mistri/handler`) | Stable |
| [Embedding in a React app](/docs/embed-in-a-react-app/) (`@mistriwork/mistri/react`) | Stable |
| The embed router adapters (`@mistriwork/mistri/react/next`, `/react-router`, `/tanstack-router`) | Preview |
| [Integrations](/docs/integrations/) (`@mistriwork/mistri/integration`, a jobs module's `integrations`, a command's `integrations` and `send(...)`, `integrationsForm()`, a `notify` rule's `send`) and effects on a tenant App | Stable |

### The packages

`@mistriwork/ui` stays Preview at 1.0: the Apps and the browser are drawn with its primitives, but, like every Preview feature, it works as documented and may change in any 1.x release.

| Package | What it is | Status |
| --- | --- | --- |
| `mistri` | The App framework and its command (`npx @mistriwork/mistri`) | Stable |
| `tablewalk` | The [database browser](https://tablewalk.dev) and its MCP server (`npx tablewalk`), released from [its own repository](https://github.com/rbaljinder/tablewalk) | Stable |
| `@mistriwork/ui` | The React primitives both are drawn with, usable [on their own](/docs/mistri-ui/) | Preview |
| `@mistriwork/cloudflare` and `mistri deploy` | The [Cloudflare Containers roll](/docs/build-and-deploy/#deploy-to-cloudflare): one target, proven on one deployment so far | Preview |
| `@mistriwork/engine`, `@mistriwork/kit` | The engine and the shared client both install; internal, with no promise to an App's author | Internal |

### Entry points

Every public import path of the published packages, with the status its
documentation gives it. An entry point marked Stable is under the
[compatibility promise](/docs/compatibility/) except for the Preview names it
exports, which the tables above mark one by one. The `schema/*` pattern export
and `package.json` are files, not entry points.

| Entry point | What it is | Status |
| --- | --- | --- |
| `mistri` (the command, `node_modules/.bin/mistri`) | The [command line](/docs/cli/) | Stable |
| `@mistriwork/mistri/app` | Types for an App's `app.ts` | Stable |
| `@mistriwork/mistri/page` | `definePage` and the free-form page API (`Loaded` is Preview) | Stable |
| `@mistriwork/mistri/ui` | Custom components, `useCommand`, the kit (`Loaded` is Preview) | Stable |
| `@mistriwork/mistri/ui/testing` | Rendering a component against a served App in a test | Stable |
| `@mistriwork/mistri/commands` | `defineCommand`, `defineEvent`, `defineChallenges`, effects (the aggregates are Preview) | Stable |
| `@mistriwork/mistri/policy` | `defineAppRowPolicy`, `defineAppTenantPolicy` and `via()` (a row scope through a relationship) | Stable |
| `@mistriwork/mistri/jobs` | `defineJobs`, `defineJob`, `defineInbound` | Stable |
| `@mistriwork/mistri/workflows` | `defineWorkflow`, `defineWorkflows`, `flowRunner` | Stable |
| `@mistriwork/mistri/integration` | `defineIntegration`, for a vendor package | Stable |
| `@mistriwork/mistri/handler` | [Mount an App in your server](/docs/mount-in-your-server/), `mintEmbedAssertion` | Stable |
| `@mistriwork/mistri/testing` | Test helpers for Apps (`roundTrips` is Preview) | Stable |
| `@mistriwork/mistri/maintenance` | Operator steps: `provisionStores`, `applyMigrations`, inspect, redrive and prune | Stable |
| `@mistriwork/mistri/react` | [Embed in a React app](/docs/embed-in-a-react-app/) | Stable |
| `@mistriwork/mistri/react/next`, `/react/react-router`, `/react/tanstack-router` | The embed router adapters | Preview |
| `@mistriwork/mistri/openfeature` | An OpenFeature provider over the App's flags | Preview |
| `@mistriwork/ui` (the root and each component path, `style.css`) | The [primitives](/docs/mistri-ui/) | Preview |
| `@mistriwork/cloudflare` | The target `mistri deploy` rolls | Preview |
| `create-mistri` (a command, no import path) | The project scaffold | Preview |
| `@mistriwork/engine/*`, `@mistriwork/kit/*` | What the Apps and the database browser share | Internal: no promise |

Where a status here is not stated by a table above, it follows the rule in
[compatibility](/docs/compatibility/): an export of `@mistriwork/mistri` is
Stable unless listed as Preview.

### An extension package

A package that adds to mistri, such as a vendor integration or a shared
component library, depends on `@mistriwork/mistri` and imports only the Stable
entry points above:

```json title="package.json"
{
  "name": "mistri-integration-fakepay",
  "version": "1.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "peerDependencies": { "@mistriwork/mistri": "^1.0.0-rc.27" }
}
```

The range names the release candidate on purpose: npm matches a prerelease
only against a range that names one, so `^1.0.0` would call every release
candidate an unmet peer. `^1.0.0-rc.26` takes this candidate, the later ones
and every 1.x release.

```ts title="src/index.ts"
import { defineIntegration, int, shape, text } from '@mistriwork/mistri/integration';

export const fakepay = () =>
  defineIntegration({
    name: 'fakepay',
    secrets: ['apiKey'],
    client: ({ secrets }) => ({ apiKey: secrets.apiKey }),
    actions: {
      ping: { input: shape({ note: text() }), output: shape({ ok: int() }), run: async () => ({ ok: 1 }) },
    },
  });
```

The upgrade guarantee: every 1.x release of `@mistriwork/mistri` keeps these
imports and their documented shapes working until 2.0, and a change to one is
named in the changelog ([compatibility](/docs/compatibility/#stable)). The same
package importing a Preview entry (`@mistriwork/mistri/openfeature`,
`@mistriwork/ui`) or an Internal one (`@mistriwork/engine/*`) has no such
promise, and may break in any 1.x release.

The database browser (SQLite, PostgreSQL) is read-only by
default, held by the adapter; writes are opt-in per connection with
`"writable": true`, checked by the server before a statement reaches it. Apps run on PostgreSQL and SQLite; MySQL and MariaDB are not supported.

## Still refused

- An App API request that would read two connections (`api-multi-source`):
  an App of several sources serves each request from one, and promises
  nothing across requests; generic writes stay single-source.
- A row-policy App's event feed and generic writes through the App API
  (`policy-events-feed`, `api-write-unsupported`): it reads through its
  policy and writes through the commands it exposes.
- A suite's App API beyond loopback: a suite serves its Apps' APIs on
  loopback only.
- Experiment conversions from a tenant App's platform realm; a tenant's own
  commands and its public intake convert.
- A tenant App's saved form with `statusCheck` or `link`.
- A second tenant App on a database that already holds one: a tenant store is
  one App's tenants and memberships. Give each its own database.
- Apps on MySQL/MariaDB: the connection is refused ("MySQL is not supported; use PostgreSQL or SQLite."); an App
  runs on PostgreSQL or SQLite.
- An App over the database browser's MCP server (`--mcp`), and a Workbench
  inside an App: an App serves only its declared resources; the standalone
  browser is the tool for the rest.
- The platform's own email in tenant Apps (invitations, verification). A tenant
  App sends and receives its own mail through its jobs module's `mail`.
- A tenant store made before 0.8.11 (layout 1): reseed it. Every later layout
  moves forward in place with `mistri migrate stores up --app <dir>`.

## Roadmap

Release candidates are shipping, and the compatibility
promise takes effect at 1.0.0. None of what remains has a date.

A field deployment has run on Cloudflare Containers against PlanetScale
PostgreSQL, with a load test (one `standard-1` instance held 25 heavy users
steady for an hour). What remains before 1.0:

1. **A signed macOS desktop build.**
2. **Deploy proof on Google Cloud Run and AWS ECS.** Both are designed, not
   proven.
3. **1.0.0 itself.**

### Not planned

- A visual drag-and-drop page editor.
- HTML or scripts in an App definition. An App's own code runs only as
  [custom components](/docs/custom-components/), referenced by path, with
  declared reads and changes through its commands.
- Anonymous reads an App did not name: a signed-out visitor reads only what
  `auth.public` lists.
- A Workbench inside an App, or an opt-in to one: it would read past the
  declared resources, the grants and the rest.

## Related

- [Changelog](/docs/changelog/): each release's full list.
- [Compatibility](/docs/compatibility/): what the 1.0 promise covers and what may change in a 1.x release.
- [Glossary](/docs/glossary/): what Stable and Preview mean, with the other terms.
