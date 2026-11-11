# Apps on mistri

An App curates the shared database runtime with a TypeScript DSL: navigation,
record pages, forms, dashboards, actions and themes over a database you already
have. The standalone database browser, `tablewalk`, is a product of its own,
in [its own repository](https://github.com/rbaljinder/tablewalk).

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

**The app layer composes the core; it never grows into it.** The core (the
engine and the kit, which the database browser is built on too) stays focused. Every feature must keep the core touchpoints
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
it, and a `home` naming where a visitor starts (an App that names none starts
on an inferred overview, below). Resources, views, pages and nav can each
live in their own typed module; Tick keeps its tiny schema type inline instead.
Physical connections and credentials belong in server configuration, never in
the App definition.

**Record names.** A resource may select the text that identifies one record
with `recordLabel`, including a joined path such as
`{ recordLabel: 'vehicle_id.title' }` on `saved_vehicle`. It is separate from
`labels` (captions) and `noun` (the kind of record). If an explicit name is
null or unavailable to the reader, mistri uses the complete primary key;
it never substitutes an ownership field such as `account_id`. The declaration
does not grant field access. With no `recordLabel`, the name is the table's
name column (`name`, `title`, `number`…), else its first text where every
record has one; a record whose only text may be blank (a visit's `summary`,
written after the visit) is named by the record it belongs to and its day,
"Fix sticking door · Sep 13, 2026", else by its noun and key, "Line item #1".
The grid, the crumbs, the palette, a reference chip and a card read that one
name. `mistri check --design` says `unnamed-records` where a listed resource
leans on this. See [the resource reference](../site/src/content/docs/docs/dsl-resources.md).

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

**A record with no page of its own.** A resource no page names still opens on
a whole page, inferred from the catalog and what the App declares: the name
with its display `subtitle` under it, the status as its dot and word, and up
to four facts (what it belongs to, its money, its date, a count, then its
rollups and figures); a classic form, caption beside value, one section per
`form.groups` group (or `form.steps`), the status a `machine` moves and a
reference drawn as a card left out; every related table the reader may read
as a tab with its count, and `history()` as the last tab where the resource
keeps one; and beside them a card per reference with something to say.
Nothing is new to write: `labels`, `display`, `form` and `machine` are what it
reads. A page you write replaces it whole (docs/design.md, "The inferred
record").

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

## Surfaces: a front end of your own

An App can be the backend of screens it does not draw, a Next.js page on the same domain, say. What that front end
may read and run is a surface, one file each under `surfaces/`, keyed by the file's name:

```ts
// surfaces/desk.surface.ts
import { defineSurface } from '@mistriwork/mistri/page';

export default defineSurface({ label: 'Desk', reads: ['loan', 'reviewer'], commands: ['assign'] });
```

A surface is a free-form page with nothing to draw: its `reads`, `commands`, `forms`, `loader` and `roles` are judged
by a page's rules and codes, and a key only a drawn page has (`component`, `nav`, `layout`, `head`, `params`,
`public`, `actions`) is refused with the page's code for it. The catalog lists each as `kind: 'surface'`, the grade
counts them, and `authority.lock` carries a line for each read, command and loader.

The front end uses `@mistriwork/mistri/react/headless`: a `Provider` with no shell and no styles, and the page hooks
(`useRows`, `useRecord`, `useBreakdown`, `useOptions`, `useCommand`, `useAction`, `useForm`, `useHref`). Every request
it makes names its surface in `X-Mistri-Surface`, and the server holds it there (`server/http/surfaceGate.ts`):

- A surface's requests take only the routes a headless host calls: view/run, the breakdowns, the page loader, the
  command routes and `GET /api/file`. Any other `/api/` route is refused.
- A read of a resource the surface does not read, or a command it does not run, is refused 403 `{ code: 'surface' }`
  before anything is read or run. So is a header naming a surface the App does not have, or one offered only to
  other roles.
- `ui: { headless: true }` makes the surfaces the App's only door: an `/api/` request with no header is refused, and
  the App's own screens answer 404 ("this App is headless; it is served through its embed surfaces"). Its sign-in,
  OAuth consent and auth routes still open, and so do who-am-I and sign-out. Signed in, the sign-in page goes to its
  `?then=` address when that is on the same origin (`/sign-in?then=/applications`), and otherwise says the person is
  signed in and may close the tab or go back.
- A surface widens nothing: the reader's grants, row policy and field ceilings decide what a read returns and whether
  a command runs, as for any request. A surface is offered to the roles that read what it reads.

A server component has no browser session, so it asks the mounted handler for a surface token
(`mistri.tokenFor(request, { surface, ttl })`, `server/embed/handler.ts`) and sends it as `Authorization: Bearer …` to
the App's API (`server/auth/surfaceToken.ts`):

- The token is stateless and of its own kind: `mstsf1.<claims>.<signature>`, an HMAC-SHA-256 over the kind, the App's id,
  the person, their session, the surface and the expiry, keyed from `BETTER_AUTH_SECRET` (HKDF), so every process of a
  deployment checks it and no API token, session or other App's token is read as one. `ttl` is in seconds, 60 by
  default, 300 at most (more is refused); a surface the App does not have, or one not offered to this person, is refused
  at mint, and so is a request with no signed-in session (`SurfaceTokenRefused`).
- The token is the surface header: a request with it takes that surface exactly as `X-Mistri-Surface` would, and a
  header naming another is refused 403 `{ code: 'surface' }`. It opens only the routes a surface takes, and no other
  (the account's, sign-in's, token issuance's, MCP's and the API's are refused 403 before they are read).
- The person's session and account are read on every request (as a cookie's are), so signing out, a banned account or a
  role taken away ends the token before its time, and grants and row policy are read live. Expired, tampered, another
  App's and a token whose session has ended are 401. It is for an App that serves its own sign-in, not a tenant App.

Surfaces are read only when the App is served from its directory (`--app <dir>`, `createHandler({ app: dir })`).
`e2e/embed-headless.spec.ts` drives a headless App end to end: sign in, list, run, and a revoked grant refused.
[`examples/embed`](../examples/embed/README.md) is the same in a Next.js app: a route handler mounts the App under
`/api/mistri`, and a page lists its rows and runs its command with plain elements.

Not yet; these are planned for rc.26:

- `useForm` and `useAction` refuse under the headless Provider; run a command with `useCommand`.
- No live sync: a surface's reads are not refreshed by other people's changes.
- A command that names no record (`target: 'none'`) is refused from a surface.
- `useHref` writes `<basePath>/<view>/<key>` and `<basePath>/<view>`, not the App's canonical addresses.
- A person who signs in after the Provider has opened is not seen until the page reloads; the Provider does not
  boot again.

## What each kind of App can do

An unscoped App's roles read whole tables; a row-policy App narrows them per person; a tenant App serves several
organizations from one App. The table is the site's ([row access](../site/src/content/docs/docs/row-access.md#what-each-kind-of-app-can-do)),
kept equal to it by `test/prose.test.ts`; change both together.

<!-- capability-table:start -->
| Capability | Unscoped App | Row policy | Tenant App |
| --- | --- | --- | --- |
| File fields of a signed-in command | Yes | Yes | Yes, 10 MB a file at most |
| File fields of a public form ([files](../site/src/content/docs/docs/commands.md#files-and-a-signature)) | Yes | Yes, into the fixed destination of a `publicForms` form (not a placed one) | Yes, held in the place its address names |
| Tables of files (`resources.*.file`) | Yes | Yes: an upload is an insert the policy judges | Yes, 10 MB a file at most |
| Stamps (`me`, `now`) on actions, New forms and uploads | Yes | Yes | Yes: `me` is the member's row in its tenant |
| Public forms ([command forms](../site/src/content/docs/docs/command-forms.md)) | Yes | Only those `publicForms` enrolls, fixed or placed | Yes, placed with one tenant by its link |
| Forms saved on every step (`resume`), public | Yes | No: `mistri check` refuses one | Yes, without `statusCheck` or `link` |
| Forms saved on every step, signed in (`owner`) | Yes | Yes: every step runs under the person's grant and policy | Yes: the member's own draft, in its tenant |
| Database triggers a command's write fires | Run as written | Validation-only ones run; any other refuses the write (`[command-trigger]`) unless [named](../site/src/content/docs/docs/row-access.md#triggers-the-app-names) (Preview) | Validation-only ones run; any other refuses the write; none can be named yet |
| Commands over the [App API](../site/src/content/docs/docs/app-api.md) and its MCP | Yes | Yes, each token as its own account | Yes, each token bound to one membership |
| The App API's generic writes | Yes, where every role reads all rows | No | No |
| The App API's event feed | Yes, where every role reads all rows | No (`[policy-events-feed]`) | No: webhooks instead (`[api-event-unsupported]`) |
| `mistri check --pending`, `check --deploy`, `mistri build` | Every step | Every step, given `--policy` | The queries step is skipped; validation is judged up to the tenant stores |
| Delete and restore | Yes | Only with `authorizeDeletedRecord` | Only with `authorizeDeletedRecord` (`[tenant-delete-unauthorized]`) |
| List exports | Yes | Yes, the person's rows | Yes, the tenant's rows |
| The [assistant](../site/src/content/docs/docs/assistant.md) | Yes | Yes, reading as the person, under the policy | Yes, where the platform owner turns it on for that customer |
| [Live sync](../site/src/content/docs/docs/live-sync.md) | Yes | Yes, naming only changes to the person's rows | Yes, naming only the tenant's own changes |
<!-- capability-table:end -->

## What an App gets without declaring it

A coding agent's least effort is a `listView(label, table)` per table and no
home, so that App has to read as if somebody had arranged it. Each piece
below is inferred only where the App declares none, from the catalog and what
the App says of the resource (its record label, display rules and machine),
never from a row; a declared piece is drawn as written, and the others are
still inferred beside it. A list that names its columns (`show`) or a
presentation has been arranged, and none of its parts is inferred: its order,
tabs and filters were left to the defaults on purpose. The served view lists
what was inferred under `inferred`.

**A list's columns.** The name first (the display title, with a code the row
is also quoted by, unique in the catalog, as its second line: a job's number
under its title), then the state, what it belongs to by name, one date (due,
else start, else created) and its money, then its other short words and
figures, seven at most and fewer where the room is narrow. The key is left
out where the row has a name, as are a column the schema pins to one value,
long text, a second copy of what a second line already says, every date but
the one, an address past its first part, and documents and bytes. A row whose
own name may be blank leads with what it belongs to (a visit by its job).

**A list's order.** Work with a state and a date to be done by reads soonest
first by that date, the undated after the dated on every engine
(`sort due_on nulls last`); anything else newest first by when it came to be; a
table with neither by its name. Never by its key.

**A list's tabs.** From the machine, or a `status` vocabulary whose final
words are read off what they say (completed, cancelled, closed, paid…): Open,
each open state while there are two to five, Done and All, the last two
newest first. Their counts are one grouped read in the first document. A list
whose standing `query` names the state keeps its own reading: no tabs, order
or board are inferred for it.

**A list's filters.** Every vocabulary and yes-or-no among its own columns
(the state only where no tab says it already), each reference to a table of
at most fifty records, and the one date. A due date earlier than today on an
open row is toned as overdue, as everywhere.

**A board to switch to.** A list whose machine has three to seven open
states gets a List | Board switch in its filter bar, kept per reader and view
in the browser and said to the server in a cookie, so a page opened on the
board carries its reads. The lanes are the open states in the machine's
order, and the final ones together in one folded Done lane, present only
where the list can hold a finished record (not under Open); a card is the
name, what it belongs to, the date and the priority toned. Dropping a card
runs the one verb that leads there, through the command path and its grants,
and is refused with the reason where none or two do; a drop on Done writes
the one final state the card's verbs lead to. Like a declared board, it reads
every lane's first twenty cards in the list's one read, windowed by the
state (`lanes: { by, limit }` on `/api/run`, one `ROW_NUMBER` statement), and
every lane's count in one breakdown: two statements however many lanes.

**An overview home.** An App that names no `home` starts on `/overview`, an
overview of its main table — the one a machine moves, else the one the most
tables point at: its rows by state as one strip of figures, each opening the
list; the open rows overdue or due today; the reader's open rows where the
table points at the one `auth.me` reads people from, said empty in so many
words when they have none; and the newest. Each appears only where the table
can answer it, four statements at most and no total under a list, all in the
first document. A `nav` that leaves it out gets it as its first item,
Overview; `nav` may place it as `overview` itself, and a view of the App's own
at that key is the App's, and then it must name its home.

**A sidebar that holds the bar.** A side-placed App's signed-in screens at a
desk draw no band across the window (`ui.shell.header`, `'sidebar'` unless
said): the sidebar runs the window's full height with the App's mark, New and
the search (⌘K) at its head and the bell and the account at its foot, and each
room's own head row is the content's first line. Folding leaves the icon rail.
A phone keeps the bar over its drawer, and public pages, sign-in and the top
placement keep the bar as before. `header: 'bar'` puts the bar back across the
window; so does `rail: false` with no `header`, since a sidebar folded away
whole would take the mark, the search and the account with it.

## What the samples are, and are not

The public samples curate synthetic databases through the shared renderer. Review queues, status strips and action `when` conditions curate the
UI; server permissions and command checks enforce access and business rules.
Lintel's resident portal exercises row isolation through the framework's
server policy (`policy.ts`); no sample's labels or queue filters are an authorization boundary. The
apps that were samples until 0.9.2 (the CRM, Thread, Keystone and the rest) and older apps under
`test/fixtures/apps/` are regression fixtures, not starters, and do not ship.
