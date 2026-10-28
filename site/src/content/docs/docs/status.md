---
title: Status & roadmap
description: The 1.0.0-rc.2 scope, stable and preview features, current limitations and planned work.
---

The 1.0.0-rc.2 scope, stable and preview features, current limitations and planned work.

```sh
npx @mistriwork/mistri check --app .
#   preview: This App uses Preview features (…). They work as documented and may change in any 1.x release.
```

This site describes **mistri 1.0.0-rc.2**, the first release candidate and the first release under the mistri name:
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
analytics, SCIM, and the Gantt presentation. The kernel, tenant Apps, SAML,
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
| Rollups (`count`, `sum`, `min`, `max`) | Stable |
| Editing, autosave, lists edited in place (`editable`) and **Set field…** | Stable |
| Files and attachments (`file`), tags (`tags`), CSV import (`import`) | Stable |
| A resource's `search` and `mistri --reindex`: they need a search pack, which ships after 1.0, so nothing can be plugged in before then | Preview |
| Resource `validation`, transitions (`machine`) and an action's `reason` | Stable |
| A machine state's `after` and a resource's `at` timers, which run through the jobs, and a machine's service-only moves (`by`) | Stable |
| Dashboards: metrics, charts, breakdowns, `rows`, `activity()`, section `windows`, interactive `embed`, `firstRun()` | Stable |
| `funnel()`; chart shapes `stacked`, `scatter`, `heatmap`, `waterfall`, `treemap`; `target`; `find()`; `week`, `weekday`/`hour` groups | Stable |
| Dashboard `note` `variant: 'banner'`, `breakdown` `shape: 'steps'`, a donut's `total`, `curve: 'smooth'`, `windowControl: 'button'` | Stable |
| Gallery, `headline()` (and its earlier figure, `was`), `card()`, facts, sheet and property-rail sections, section `tab`, ordered workflow strip, related cards, `related(…, { same, near })` | Stable |
| The Gantt presentation (`gantt()`, `kind: 'gantt'` and its keys) | Preview |
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
| The four built-in looks: Workshop (the default, set in Barlow), Lumen (set in Inter), Mono and Sage; `defineTheme`, `ui.theme` and `customThemes`; the twelve palettes every look offers; the theme validator in `mistri check` | Stable |
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
| [Embedding in a React app](/docs/embed-in-a-react-app/) (`@mistriwork/mistri/react` and its router adapters) | Stable |
| [Integrations](/docs/integrations/) (`@mistriwork/mistri/integration`, a jobs module's `integrations`, a command's `integrations` and `send(...)`, `integrationsForm()`, a `notify` rule's `send`) and effects on a tenant App | Stable |

### The packages

<!-- TODO(1.0): @mistriwork/ui is Preview pending the maintainer's decision on whether its primitives are Stable at 1.0. -->

| Package | What it is | Status |
| --- | --- | --- |
| `mistri` | The App framework and its command (`npx @mistriwork/mistri`) | Stable |
| `tablewalk` | The [database browser](/docs/database-browser/) and its MCP server (`npx tablewalk`) | Stable |
| `@mistriwork/ui` | The React primitives both are drawn with, usable [on their own](/docs/mistri-ui/) | Preview |
| `@mistriwork/engine`, `@mistriwork/kit` | The engine and the shared client both install; internal, with no promise to an App's author | Internal |

The database browser (SQLite, PostgreSQL, MySQL/MariaDB) is read-only by
default; writes are opt-in per connection with `"writable": true`, enforced at
the adapter. Apps run on PostgreSQL and SQLite; MySQL/MariaDB is supported for
browsing.

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
- Apps on MySQL/MariaDB (`app-on-mysql`, at `check` and at startup): an App
  runs on PostgreSQL or SQLite. MySQL/MariaDB is supported for browsing, in
  the database browser and its MCP server.
- An App over the database browser's MCP server (`--mcp`), and a Workbench
  inside an App: an App serves only its declared resources; the standalone
  browser is the tool for the rest.
- The platform's own email in tenant Apps (invitations, verification). A tenant
  App sends and receives its own mail through its jobs module's `mail`.
- A tenant store made before 0.8.11 (layout 1): reseed it. Every later layout
  moves forward in place with `mistri migrate stores up --app <dir>`.

## Roadmap

Planned work, in order. None of it has a date.

1. **Container deploys.** An App deployed and running on container
   platforms, with a hosted PostgreSQL, before 1.0.
2. **1.0 release candidate.** The surface frozen and the compatibility
   promise in force.

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
- [Glossary](/docs/glossary/): what Stable and Preview mean, with the other terms.
