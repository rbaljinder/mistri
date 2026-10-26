# Apps on mistri

An App curates the shared database runtime with a TypeScript DSL: navigation,
record pages, forms, dashboards, actions and themes over a database you already
have. The standalone database browser, `tablewalk`, is a product of its own.

Apps compose shared presentation components through the DSL and customize their
look through themes. Examples exercise those public capabilities: a task queue,
an actionable note, or a dashboard context column uses the same renderer in
every App. Application-specific data and copy stay in the App declaration. A dashboard may carry a short plain-text `description`, shown under its heading without adding a custom screen component.

This page is the map. The contract itself lives in one place per fact:

| Question | Where it is answered |
| --- | --- |
| Which sample do I read first? | [`examples/apps/README.md`](../examples/apps/README.md) — Tick, then Lintel, the flagship. Database setup is under [`examples/databases/`](../examples/databases/README.md). |
| What does each key mean? | [The App DSL](../site/src/content/docs/docs/app-dsl.md) — the reference: resources, views, pages, `home`, `nav`, `auth` and `ui`. |
| How does the loop work? | [Authoring guide](authoring.md) — formats, the edit-save-check loop, pages, sign-in and grants, row policies, commands. |
| How do I build one with an agent? | [Build an App with a coding agent](../site/src/content/docs/docs/build-with-an-agent.md) — the brief, the loop, the acceptance gate. |
| How do I change its schema? | [Change your schema](../site/src/content/docs/docs/change-your-schema.md) — `mistri migrate`: versioned SQL in Flyway's format, `check --pending`, baseline and drift. |
| How does it speak several languages? | [Languages](../site/src/content/docs/docs/languages.md) — `messages/<locale>.ts` catalogs, `msg()` where a caption goes, each reader said their own on the server. |
| How do I ship one? | [Build and deploy an App](../site/src/content/docs/docs/build-and-deploy.md) — `mistri build`, serving a build, Docker, a load balancer. |
| Queues, boards, bulk actions, modal records? | [Lists](../site/src/content/docs/docs/lists.md) and [Choose a building block](../site/src/content/docs/docs/choose.md). |
| Fixed actions versus business commands? | [Actions](../site/src/content/docs/docs/actions.md) and [commands](../site/src/content/docs/docs/commands.md). |
| Sign-in, field access, named sources? | [Sign-in](../site/src/content/docs/docs/sign-in.md), [roles and field access](../site/src/content/docs/docs/roles.md), [sources](../site/src/content/docs/docs/sources.md). |
| What can it build? | [The component tour](../site/src/content/docs/docs/components.md), and [the DSL in one App](../site/src/content/docs/docs/dsl-tour.md) for one small App step by step. |
| Looks and presets? | [Looks](../site/src/content/docs/docs/looks.md) shows the built-in looks side by side; [theming](theming.md) is the contract. |
| Connections, a cache, search, webhooks? | [Connections and services](../site/src/content/docs/docs/services.md). |
| Pools, the client, operators? | [Performance and pools](../site/src/content/docs/docs/performance.md) and [Observe and operate](../site/src/content/docs/docs/observe.md). |
| Tenant Apps? | [Tenant App startup](tenant-apps.md). |
| What is done, in progress, queued? | [Capabilities & roadmap](../site/src/content/docs/docs/status.md). |

## The one rule

**The app layer composes the core; it never grows into it.** The core stays a
focused database browser. Every feature must keep the core touchpoints
countable (a flag, a merge call, a route that delegates). If a feature needs
the core to *know about apps* beyond handing them a request, the design is
wrong — stop and rethink.

Three invariants follow from it and hold in every arc: errors name the fix at
startup; the manifest stays machine-editable data; and [`docs/design.md`](design.md)
governs how anything looks or moves.

## What an App is

A directory with one entry point. TypeScript is the primary authoring path:

```ts title="app.ts"
import { defineApp, listView } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';

export default defineApp({
  id: 'lintel',
  name: 'Lintel',
  resources: { unit: {} },
  views: { units: listView('Rent roll', 'unit') },
  home: 'units',
} satisfies App);
```

This App uses Lintel's schema: one declared resource, one list view over
it, and the `home` every App names. Resources, views, pages and nav can each
live in their own typed module; Tick keeps its tiny schema type inline instead.
Physical connections and credentials belong in server configuration, never in
the App definition.

**Record names.** A resource may select the text that identifies one record
with `recordLabel`, including a joined path such as
`{ recordLabel: 'vehicle_id.title' }` on `saved_vehicle`. It is separate from
`labels` (captions) and `noun` (the kind of record). If an explicit name is
null or unavailable to the reader, mistri uses the complete primary key;
it never substitutes an ownership field such as `account_id`. The declaration
does not grant field access. With no `recordLabel`, existing name inference is
unchanged. See [the resource reference](../site/src/content/docs/docs/dsl-resources.md).

**Named queries.** A resource's `segments` name its queries once
(`open: 'status is open'`). The name is a word of the query language, so a
tab, a section's source, a rollup and the App API's `?segment=` all read the
same conditions, compiled inline: there is no second statement to drift. A
tab no longer writes its own query; it names a segment, and the segment's
name is its address. A segment only narrows, under the reader's row policy
and field grants, and one that reads a column the reader may not read is
not served to them. See [the resource reference](../site/src/content/docs/docs/dsl-resources.md#segments).

**Stock a line uses.** `consumes` on a line (`part_id.on_hand` by `quantity`)
keeps a stored balance in step with the lines that use it. It is held in
the App's write layer, so every door (Save, an import, the App API, MCP, a
command's own writes) moves the balance the same way, and a take past zero
refuses the whole write. A balance that is only read stays a rollup.
`restocks` is the same rule the other way round, on a line that brings stock
in, so receiving stock is a New form on the receipt rather than a command.

**A rule about a parent.** A `validation` may read through one reference
(`order_id.status = bench`), so a line keeps the rule its parent sets. The
server reads the parent in the write's own transaction, so an order moved
earlier in the same write is judged as moved, and says the rule's message at
the reference. One hop only: a rule two tables away belongs in a command.

**Pages found by their files.** A record page is a file in `pages/` whose
default export is the page (`pages/lead.ts`: `export default page('lead',
[…])`), keyed by its name, as `pages/<key>.json`, a free-form
`pages/<path>.page.tsx` and a catalog `messages/<locale>.ts` are. `app.ts`
lists none of them, and `mistri check` says each file it found and what it
became, so a file that was not read (no default export) is seen not to be.

**A default aside.** A record page that declares no `region: 'aside'` section
gets the generated page's: the record's remaining readable fields (those no
section shows, never the record's name) as a `properties` rail titled by the
resource's noun. It is drawn in `validatePage`, against the reader's own
catalog, so a column they cannot read is not offered. `page(…, { aside: false })`
leaves it out; nothing remaining, or a `fields([])` that already says the whole
record, draws none.

**Named sets of states.** A machine's `groups` name the states people talk
about together (`onBench: ['checked_in', 'in_repair']`), and the query
language asks them as it asks `is open`: `status is onBench`. So a group is
one word in a query, a segment, a tab, a nav count and a board, whose lanes
shrink to the group, and is never a second list to keep in step.

**A role on top of another.** `extends` folds another role's grants into a
role before anything is judged (`manager: { extends: 'mechanic', commands:
['approveQuote'] }`), as if they were written out, so authority.lock and every
screen that explains a role say what it holds in full. Grants pass down, and a
view's or page's `roles` open to a role that extends one they name; never who
holds the role, and a row policy's `principal.roles` still match by name.

**Mail to someone without an account.** A `notify` rule with
`send: { channel: 'email', to, consent }` mails the address a record holds,
such as a customer who never signs in. The message is queued in the write's
own transaction, in the integrations store, and sent after the write commits.
It is suppressed when the person opted out, when the record holds no consent,
when a visitor's write names an address no form proved, or past the per-address
and per-App caps. Each message carries a signed one-click unsubscribe link.
Accounts keep `email: true`, which is checked again against the recipient's
grants. See [email](../site/src/content/docs/docs/email.md#mail-to-an-address-a-record-holds).

`app.ts`, `app.mjs` and data-only `app.json` are all accepted; a directory
must contain exactly one. The typed helpers return ordinary data and every
format goes through the same parser. Node 24 loads the typed module graph
without a separate App build, so the authoring loop needs none; typechecking
is an explicit authoring check. For production, `mistri build` is an
optional step that typechecks, validates and bundles an App once and writes
a directory the server starts from without loading TypeScript; see
[Build and deploy an App](../site/src/content/docs/docs/build-and-deploy.md).

Executable manifests run as trusted server code in a fresh worker, not a
sandbox. Their serializable export crosses a structured-clone boundary, so
functions cannot ride in the manifest. Keep server commands and private
identity or policy code outside the public manifest graph. JSON remains valid
for runtime connection configuration and data-only interchange; it is not the
recommended App authoring path.

That boundary is also why an App's own React code is **named, never held**:
`component('pay-history', { module: './widgets/PayHistory.tsx' })` is a name
and a path, placed through a declared kind (a `custom()` section, a value
renderer), and the server compiles the module beside the definition. What the
component reads is declared beside it and planned like any section, so the
core's grants, planners and boundary are the component's too; it only draws,
with `@mistriwork/mistri/ui`. See
[custom components](../site/src/content/docs/docs/custom-components.md).

A record goes on paper the same way: a page made with `document()` is an
invoice, a packing slip or a payslip, offered as a verb on its record and
read through the record page's own plan and reads, so the grants it meets
are the page's. Nothing renders it on the server — the browser prints the
sheet and saves the PDF. See
[documents](../site/src/content/docs/docs/documents.md).

An open page of an App that asks for it (`live: true`) follows what other people change. Every write it serves is recorded as the tables and keys it
changed; each reader's stream is told only of what their grants read, and the page asks again the reads that change
touches, through their own paths, so the grants and scopes of a read are the ones it always had. A list is refreshed
in place, a viewed record says it was updated, a record being edited is never changed beneath the person (a notice
offers the change beside theirs), and a list being worked in holds still behind an "N updates" pill. A dashboard
therefore takes no `refresh`. See [live sync](../site/src/content/docs/docs/live-sync.md); the rules the pages follow
are in [the design system](design.md), rule 11.

## What the samples are, and are not

The public samples curate synthetic databases through the shared renderer. Review queues, status strips and action `when` conditions curate the
UI; server permissions and command checks enforce access and business rules.
Lintel's resident portal exercises row isolation through the framework's
server policy (`policy.ts`); no sample's labels or queue filters are an authorization boundary. The
apps that were samples until 0.9.2 (the CRM, Thread, Keystone and the rest) and older apps under
`test/fixtures/apps/` are regression fixtures, not starters, and do not ship.
