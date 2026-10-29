# The in-App assistant

An App may offer its signed-in people an assistant: a side panel (and, if the
App places it, a page of its own) where they ask in words and the model answers with the App's own blocks — a list, a
figure, a chart, a record — and proposes the App's own verbs as cards the
person confirms. This file is the design record: what it may do, under whose
authority, how it is built and why. The site's "Add an assistant" page is the
author's half; this is the maintainer's.

## The one rule: never wider than the person

The assistant has no authority of its own. Everything it reads it reads as
the person asking, through the requests the person's page would send; nothing
it proposes runs until the person runs it, through the form the page already
draws. Concretely:

- **Reads go through the dispatcher, as the person.** A tool call is answered
  by asking the server's own HTTP dispatcher (`handle`, through the loopback
  first paint already uses: `http/firstPaint.ts` `loopbackRequest`,
  `http/handler.ts` `loopback`) with the turn request's own headers — its
  session cookie, its proxy identity, its host. The gate, the App's grants,
  field access, a row policy and its scopes apply exactly as they do to the
  page's fetch, because it *is* that fetch, answered into memory. There is no
  assistant read path to keep in step with the real one.
- **The catalog is the person's.** What the model is told exists — the
  resources, views, actions and commands — is built from `/api/app` asked as
  the person (`servedApp` plus the per-principal answers: `writableTables`,
  `grantedActions`, `grantedCommands`), so a command a role is not granted is
  not in the catalog, cannot be described, and cannot be proposed.
- **Writes are never the server's.** `run` builds a *proposal*: the action,
  the record, the values, checked against the catalog and the record's current
  state. The proposal is drawn as a card; a fixed action's Confirm, a
  command's form and a New form's Save are the person's own click through the
  page's existing write path (`/api/update`, `CommandForm`, the New form). The
  outcome is reported back to the conversation afterwards. A model that is
  talked into "running" something by text in a record can only ever produce a
  card nobody has to press.
- **Record text is data.** Tool results are JSON the model is told is data
  from the App's records, never instructions; the system prompt says so, and
  the structure above means it does not have to be believed. A result is
  short on purpose (`fitted` in `assistantTools.ts`: about 6,000 characters,
  a table block's first five rows in its shown columns, twenty records from a
  search), because every later step of the turn reads it again.

Tenancy follows from the first point for an ordinary App with a row policy:
the scope is the request's. A tenant App (`auth.rows: 'tenant'`) is served by
its own host with per-tab context leases (`tenant/tenantHttp.ts`); there the
assistant answers inside one tenant at a time, on the tab's lease, and only
where the platform owner has switched it on (see [In a tenant App](#in-a-tenant-app)).

## Harness: thin, in-house, over our own store

The question was whether to adopt an agent harness or write a thin loop.

**Flue** (flueframework.com, Apache-2.0 TypeScript) defines agents as
functions with React-like hooks (`usePersistentState`, `useAgentStart`,
`useModel`), records sessions in its own durable streams, and deploys to its
listed backends (Cloudflare, AWS, Node, Postgres/Mongo/Redis adapters). Judged
against what mistri needs:

| Criterion | Flue | Thin harness |
| --- | --- | --- |
| Storage in the App's own Postgres/SQLite, tenant-scoped, provisioned and attested like every other store | Its own durable stream and adapters; tenancy would be ours to bolt on | `__mistri_assistant_*` tables beside the records (on PostgreSQL, `mistri.assistant_*`), provisioned once, attested at start, scoped by `(app, tenant, account)` in every statement |
| Runs in-process, inside the request that holds the person's authority | Agents are deployments addressed over HTTP | The loop runs inside the turn request; every tool call is that request's loopback |
| Streaming hooks for blocks | Durable streams of its own events | Our SSE events are exactly the panel's items (text, step, block, proposal) |
| Dependency weight | A framework, Vite and its integrations | No new dependency: one ~250-line provider module over `fetch` |
| Product boundary ("ride on Postgres; don't build what a dependency gives us") | Gives a loop and a store we would not use, and wants its own runtime | The loop is ~200 lines; the parts that matter (authority, storage, blocks) are ours in either case |

Flue was not verified to keep sessions in our tenant-scoped store or to run
inside a request's authority, and both are the point, so the harness is
in-house. What a dependency would give — the agent loop — is the smallest
part; what it cannot give — the person's authority on every call — is the
largest.

The provider is one small interface (`server/assistant/assistantModel.ts`):
`stream(request, onText, signal) → { content, stopReason, usage }`. The one
provider is Anthropic's Messages API over plain `fetch` with streaming (no SDK
dependency: the image carries nothing new and the interface is the seam an SDK
would sit behind). The default model is `claude-sonnet-5-5`; an App may name
another. The operator's key is `ANTHROPIC_API_KEY` in the server's
environment — never in the App definition, never sent to the client.

A **scripted model** (`server/assistant/assistantScripted.ts`) is the test
double: turns written as data (text, tool calls, the person's words they
answer), so every node, component and browser test runs offline and
deterministic. The operator selects it with `MISTRI_ASSISTANT_SCRIPT=<file>`,
which a server under `NODE_ENV=production` does not read; an App's own tests
pass the script to `startTestApp({ assistant })`, and the server's tests inject
one directly (`setAssistantModel`).

## The tool core

Five tools, the same for every App, so the starting context does not grow
with the App — discovery is a tool, not a preamble:

| Tool | What it does | Authority |
| --- | --- | --- |
| `find` | Search the catalog (resources, views, actions) and records by words | Catalog from `/api/app` and `/api/schema`; records through `/api/run` |
| `describe` | One resource's fields (types, choices from the DSL, references as ids) or one action's inputs | `/api/app`, `/api/schema` |
| `query` | One read in the query language over the person's resources | `/api/run` |
| `show` | Draw a block for the person | Validated, then checked by the read it will draw |
| `run` | Propose an action, a command or a new record | Proposal only; the person confirms |

The starting context is a fixed preamble, the App's name and instructions and
a compact catalog: each resource and view by name, each action by
`resource.action` and label. Field lists, command inputs and choices arrive
only when `describe` asks for them. `test/assistant-context.test.ts` holds
every sample App's starting context (system plus tools) under its token budget,
measured on the App's whole catalog (every role), which bounds every person's.

Results are split: the person sees the whole block; the model is told a
summary — the count, the columns, the first rows with their ids and their
canonical addresses. Record links are canonical addresses
(`shared/appAddress.ts`), which the panel draws as links.

On a record, the panel takes the record as context: the turn names it, and the
actions it offers *now* — fixed actions whose `when` the record meets, the
commands availability allows (`/api/commands/availability`) — so "log a call"
on a lead starts from that lead's verbs.

The stable prefix (tools, then system) carries `cache_control`; what changes —
today's date, the record in view — rides in the person's message, never the
prefix.

## Blocks

A block is data the model writes and the server validates, drawn by the App's
existing components in the App's look:

- `table`, `metric`, `chart`, `breakdown` are dashboard sections
  (`Dashboard.tsx`): the same keys an author writes (`from`, `query`, `show`,
  `sort`, `limit`, `by`, `measure`, `shape`), checked against the person's
  readable resources and then asked once through the read the section will
  draw (a table's is the dashboard's own, `dashboardListQuery`), so a block
  that would fail never reaches the panel, and a table that matched nothing is
  not drawn: the model is told so and says it in a sentence. Rows open their
  records; charts and figures are the dashboard's. A chart keeps the shape the
  model asks for; unasked, groups of a kind are bars and a calendar bucket a
  line.
- `record` is one record's identifying fields, read again by the card the way
  the glance reads (`PeekPanel` `useGlance`: `referenceProjection` and one
  `/api/view/run` row by key), so a reference is its record's label, linking
  to its page.

### Acting from a card

A record card carries the record's verbs — the App's `ActionBar` with the
resource's actions, judged by the same `when` read (`rootMatches`) — and Edit,
which opens the record's edit dialog (`pageBridge.openPeek(…, 'modal')`). A
table block whose table has a view with `rowActions` gets that list's ⋯ menu on
each row (`RowActions`), which mounts the same `ActionBar`. So a verb pressed in
the conversation is the verb on the record page: a fixed action writes through
`/api/update` (its Confirm and Reason dialogs included), a command through its
`CommandForm` (`/api/commands/prepare`, then `/execute`), an edit through the record's form. The
card and the row menu are drawn only for a person who may run one of the verbs
(`writeAllowed`, `grantedActions`, `grantedCommands`, as the record page
decides), and the server judges every write again.

**The security model is unchanged.** The assistant still has no authority of
its own and the model still cannot write: these buttons are the person's own
clicks on the App's own write paths, under their session, exactly as on the
record page. What a verb came to is reported to the conversation by
`POST /api/assistant/acted` (`ActionBar` tells the panel through the
`ActionOutcomes` context): it checks the conversation is the person's and the
verb is one they run, appends an `acted` event, and runs nothing — it is a note,
not a write, and the model has no tool that reaches it. The model reads it on
its next turn as text marked as coming from the App, not typed by the person,
and the scripted test model ignores it as words. After a verb the panel
invalidates its queries, so cards and tables read again.

No model-written HTML or JSX, ever: a block is a closed set of keys.

## Conversations

Conversations are kept per person in the App's own database
(`adapters/assistant/`): a conversation row and an append-only event list —
the person's words, the model's content as the API returned it (thinking
blocks and their signatures included, so a continued turn is a byte-identical
prefix; each reply keeps the model that made it, and when the App's `model`
changes mid-conversation the new model reads the earlier replies' words and
calls but not their thinking, which was another model's), tool results with what the panel drew, proposals and their outcomes,
summaries. Every statement names `(app, tenant, account)`; a conversation id
from another person is simply not found. Usage is a row per model call, and
the caps are read from it: tokens per turn (where a call's cached input, the
turn so far read again, counts at a tenth, as it is billed), per person per day,
per App per day (`limits`; a person's day is 200,000 tokens unless the App names
another figure, so an App that forgets a cap still has one), and in a tenant App per tenant per day (the tenant policy's
`assistant.tokensPerTenantPerDay`). A turn past a cap is refused before the model is asked.

A proposal waiting for the person is a durable pause: the conversation's
state is `awaiting`, and the panel, opened on any device or after a restart,
draws the card again; its outcome continues the turn. Stop aborts the stream
(the server sees the request close and aborts the model call; what was said
is kept). Retry and Edit cut the event list after the person's last words —
the prefix the model saw stays as it was, which is what preserved thinking
asks. A long conversation is compacted by summary: the model summarises the
events before the newest person message into one, and the next call starts
from it.

A conversation untouched for 90 days is purged, its events with it, every six
hours while the server runs, as a tenant App's are (`assistantRetention.ts`).
There is no key for it in the App: a tenant App's policy may set its own period
(`assistant.retentionDays`), and an ordinary App keeps the default. Usage rows
are not conversations and stay, since the caps and the bill read them.

The store is provisioned like every other, once, by the operator
(`provisionStores(<the database>, { app: { definition } })` from
`@mistriwork/mistri/maintenance`, which makes every store the App declares;
`only: ['assistant']` names it alone and is refused for an App with no `assistant`), attested when an App that declares an assistant
starts with a model to reach, and never created by serving. A server with no
model (no `ANTHROPIC_API_KEY`) neither offers the assistant nor asks for its
store, so an App that declares one still starts everywhere else.

## The panel

Loaded on demand: the first page carries the trigger alone — one icon button
beside the account's, dressed by the bell's rules already in the first paint,
its glyph riding the App payload — and the panel, its stylesheet and
everything it draws with are a chunk of their own, fetched when the button is
first pointed at or pressed. The trigger's box is held from the moment the bar
is drawn, so nothing in the bar moves when it arrives. The panel stands beside
the page, not over it: no scrim, and the page stays live under the person's
hand. Streaming
text appears as it is written with nothing pulsing; tool steps are one quiet
line each, folded; blocks reserve their height before their rows arrive so
nothing below them moves; the composer is pinned at the panel's foot. Enter
sends, Shift+Enter breaks a line, Escape stops a running turn and then closes.
On a phone the panel is the whole screen. A turn says "Working…" the moment it
is sent, still text in the muted ink, and then what each tool is doing as it
runs ("Reading lead…", the `running` event's `label`), until the model's words
arrive. A turn cut off on the way — the network gone, the server restarted, a
proxy's bare 5xx, a stream closed before its `done` — says the connection to
the server dropped, with Try again: retried from the person's words when the
server had kept them, else sent as it was. A conversation the server refuses
to open says why, with New conversation beside it; one that is gone starts a
new one quietly. The panel reopens on its last conversation only for the same
account and customer.

**One column.** Wide — full screen, or the page — the conversation reads in one
centred column of at most 760px: the words, the person's messages (at its right
edge), the folded steps, tables, charts, record cards and proposals all stand
between the same two edges, and a wide table scrolls inside the column rather
than leaving it. A record card's fields are never fewer than two a row, so on a
phone it is a compact grid. The composer is a light field one line tall that
grows with its words (to about eight lines, then scrolls), with Send beside it:
quiet until there is something to send, then the one filled action. While a
proposal waits, the field is shut and says why over itself — a dot and "Waiting
for you to confirm or decline.", which is also the field's description — so a
grey Send is not the only sign. An empty conversation draws its intro, starters
and composer as one group in the middle of the pane, as a new chat opens.

**Full screen.** A labelled button in the head (`aria-pressed`) widens the panel
over the content area and back: the panel's left edge moves to `#content`'s,
measured on the zoom-aware ruler, and nothing beneath it moves (the e2e
measures layout shifts). The conversation takes the one column above. It is not
animated (a frequent toggle; motion doctrine). The choice is remembered per
person and App in `localStorage` (read and written in try/catch). Escape steps
back to the side panel first, keeping the focus where it was, then closes. A
phone has no full screen to go to and shows no button.

**Starters.** `starters` (up to six one-line questions) are offered as a grid
of buttons on an empty conversation; one sends as the person's words.

**The conversation list.** One component (`ConversationList.tsx`) is the
panel's Conversations view and the page's rail. It is a flat inbox, not a stack
of cards: a quiet line per conversation (its title, cut with an ellipsis and
whole in its `title`, and its day — "Today", "Yesterday", a weekday within the
week, then "Sep 4"), no border and no fill at rest, a faint fill on hover, and
a quiet tint of the accent and a medium title for the current one. What needs
the person comes first: a conversation in the `awaiting` state sits under
"Waiting for you" with a small accent dot. The rest fall under Today,
Yesterday, Earlier this week (the five days before) and Older. Days are
calendar days in the App's `ui.timezone`, counted from the clock as it is now:
a list left open over midnight moves its rows within the minute. While this
panel's turn runs, its row says "Working" where the time would be, and nothing
pulses. Rename and Delete are in a row's ⋯ menu, one quiet trailing mark that
shows on hover or focus and always on touch (the list rows' rule); the page's
head carries the same menu beside the open conversation's title, which heads
the page in place of the bare "Assistant". Rename edits the title in place
(`POST /api/assistant/rename`; the row keeps its place). Delete asks first in
a dialog, because an App keeps no undo.

**Search.** The box — a small filter field labelled "Filter conversations",
inset in the list and marked with a funnel, so it is not taken for the App's
search — filters titles as the person types, from the list already
loaded. After a short pause it also asks `/api/assistant/search`, which is one
statement scoped by `(app, tenant, account)` on SQLite and Postgres:
`lower(body_json) LIKE ? ESCAPE '!'` over the person's and the model's events
only, with `%`, `_` and `!` escaped, at most 400 candidates and 20 answers. Each
candidate is then confirmed on its words alone, so what a tool was asked or
answered never matches. No index is added: a person's conversations are few,
and the owner index narrows them first. An answer carries one muted line of the
words, cut on word edges, with the match marked. Escape empties the box before
it closes anything.

## The page

`placement: ['panel', 'page']` gives the assistant a room at
`/<app>/assistant`, and a conversation `/<app>/assistant/<id>`
(`appAddress.ts` `ASSISTANT_ROOM`, claimed only by an App that has the page; a
view may not take the key). Nav places it by the word `'assistant'`, once;
where nav does not, it closes the menu. It is the panel's component in a room
mode (`AssistantRoom`), loaded on demand like the panel, so a first page
carries none of it: conversations in a rail on a desk and, on a phone, a sheet
from the left over the conversation, which stays in sight beside it (the head's
first control opens it),
the composer at the foot, the conversation id riding the walk entry's `tab`
so a new turn's id becomes the address without leaving the room. It is
offered, like the panel, only where the payload's `assistant` is (a role it is
not offered to, or a server without a model, has neither).

## In a tenant App

What leaves the platform is the person's messages and the rows their own reads
return, sent to Anthropic with the server's `ANTHROPIC_API_KEY`; the platform
owner holds that key and its bill, never a tenant.

- **A conversation is one tenant's.** It is stored with `(app, tenant,
  account)`, listed and resumed only in that tenant, so switching customer
  switches the panel's history. The browser never names the tenant: it sends
  its tab's lease, the host recovers that lease as this login (admitting the
  membership again) and takes the tenant from it (`tenant/tenantAssistant.ts`).
  An id from the other tenant is not found; a request that names a tenant is
  refused. The assistant's page (`placement: 'page'`) is a tenant room: it is
  served inside a customer, and a nav that places it in a `platform` group is
  refused where it is written (`shared/appTenancy.ts`).
- **Every tool call is a tenant request.** The assistant's reads go to the
  tenant data server on the lease, with the same membership check and read
  scope a page's own fetch gets, admitted per call: a person removed
  mid-conversation is refused at the next call.
- **The switch is the platform owner's.** Each tenant's assistant is off until
  an operator turns it on in **Account → Manage tenants** (`setTenantAssistant`),
  naming a consent reference; every change is journaled with who, when and that
  reference. A tenant's own admin, where `delegates` grants it, may turn it
  off, never on. It is read on every request and before every model call: off,
  the panel is not drawn and the routes answer 403.
- **A support session has no assistant**, nor does the platform realm.
- **Usage** by tenant, by day or by month, with a CSV download, is a tab in
  Manage tenants for an operator who may set the switch.
- **Retention.** Conversations untouched for `assistant.retentionDays` (default
  90) are purged every six hours while the host runs; closing a tenant deletes
  its conversations and switch with it. Token counts stay: they are the bill.

## Not yet

- Per-role instructions; `gallery` and `timeline` blocks; rich-text blocks.
- Writes without confirmation for named low-risk commands.
- Other providers behind the same interface.
- A CLI command that provisions the store (today it is the maintenance call).
