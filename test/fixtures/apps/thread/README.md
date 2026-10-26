# Thread

The modular TypeScript starter: a small issue tracker in the Lumen look,
side navigation that folds to a rail of icons, a workspace board and three
record pages. Read it after Tick's
single-file example and before the larger Compass CRM and advanced Ignition
examples. Its app and pages are authored entirely in TypeScript; the seed lives
separately under `test/fixtures/databases/thread/` as a standalone JavaScript utility,
and JSON is used only for configuration output
and the TypeScript compiler settings.

## Start

Use Node 24 or newer and install repository dependencies with `npm install`.
From the repository root, create a disposable copy outside the watched app:

```sh
thread_demo=$(mktemp -d "${TMPDIR:-/tmp}/tablewalk-thread.XXXXXX")
node test/fixtures/databases/thread/seed.mjs "$thread_demo/thread.db"
npx tsc -p test/fixtures/apps/thread/tsconfig.json
npm run start -- check --config "$thread_demo/thread.db.json" --app test/fixtures/apps/thread
npm run start -- --config "$thread_demo/thread.db.json" --app test/fixtures/apps/thread --port 4708
```

Open <http://127.0.0.1:4708/>. If 4708 already hosts a preview, select
another port for your copy. Keep the temporary directory path to restart using
the same config; temporary files can be removed by operating-system cleanup.
The seed refuses to replace either an existing database or its companion config.
It needs no external service. No database belongs in the authoring directory.

## Reading order for people and coding agents

1. [app.ts](app.ts) is the table of contents: app identity, theme, the
   resources, the views, the keyed pages, the `home` view and the nav,
   checked with `satisfies App`.
2. [resources.ts](resources.ts) says what Thread knows about each resource, once:
   the status and priority tones, keyed by the resource's own columns; the one
   New form for issues, wherever one is created; and the issue actions — offered
   on the issue page, as the `bulk` actions a queue applies to a selection, and
   as the lane moves a board allows.
3. [views.ts](views.ts) holds everything a member can open. Helpers such as
   `dashboard`, `metric`, `board` and `rows` construct ordinary data. The
   Workspace dashboard opens with two `metric` cards over `created_at` — the one
   timestamp the seed has — each with `compare: 'previous period'` and a
   `spark` trend; the dashboard's `windows` are the two phrases the reader
   can pick, and the pick replaces the query's own window. It draws the
   Projects and Cycles views read-only through `embed()` sections, so
   their columns are stated once. The **Triage** view is a `queue` — keyboard
   selection over backlog/ready issues, offering the issue actions marked
   `bulk` — and the **Board** view is a `board` over cycle 1 whose lanes are
   the machine's states in its order and whose cards move only by the verb
   that leads to their lane from where they stand, and whose lanes read in
   `rank` order: a card is dragged into
   place (in its lane or another), moved with Alt+↑/↓, or put there from its ⋯
   menu, and its name or priority is edited in place with F2. Its `limits`
   show work in progress on the lane heads — In review runs over its two.
   The **Planning** view is a `board` by `cycle_id`: a lane per cycle after
   one for issues in none, a `swimlanes` row per priority, and a card dragged
   to another cycle or row is an ordinary edit of the issue, undoable. The **Updates** view is a `split`. Choosing an
   update keeps a bounded list of 25 beside it and reads the whole update,
   body included, in the detail pane; the address names the selected row,
   `/updates/3`. It is `comment`'s one view, so that is every update's
   address, and an update opened from the issue page's activity opens there. The **Inbox** view is a second split,
   over `issue` beside Issues: the same rows read beside the whole issue,
   description included, each row chosen by `split.row` (name, assignee, status, priority) and the verbs on keys (`m`, `s`, `r`, `d`) shown beside them. Each detail is headed by its resource's `noun` —
   Issue, Update — as New is. Every view has an address — its key, `/board`,
   with a tab or a filter in words after it (`/issues?tab=backlog`) —
   and a record is its id under the view that shows its table:
   `/issues/7` is issue 7's page, and `/inbox/7` reopens it
   beside the Inbox list. A label is its name (`address: 'name'`),
   `/label/bug`.
4. [navigation.ts](navigation.ts) arranges the views in two groups; it defines
   nothing.
5. [pages/issue.ts](pages/issue.ts) combines editable fields — over which the
   page draws the issue's stepper — an activity timeline that names who wrote
   each update and adds one in place, and sibling project issues. The stepper
   is the forward path of the issue's `machine` (resources.ts), with
   `canceled` left off as an exit rather than a step. The machine is the
   policy too: only its verbs move an issue, and the server refuses any other
   change to `status`. The
   header names the forward verbs it draws (`header({ actions })`, the rest in More) and the activity reads oldest first. The
   status, priority, assignee, project and cycle fields sit in the record's
   side panel through `fields([...], { presentation: 'summary', region: 'aside' })`, compact and still
   editable (`editable: true` there). Then read
   [pages/project.ts](pages/project.ts) and [pages/cycle.ts](pages/cycle.ts) for
   related lists and aggregates: `metric` and `breakdown` with `whose`, the
   same helpers a dashboard uses. Pages are keyed in `app.ts`; the key is the
   page id, which keeps saved record links stable.
6. [mistri-schema.d.ts](mistri-schema.d.ts) records generated table and
   column names; [seed.mjs](../../databases/thread/seed.mjs) owns the synthetic schema and data.
   [tsconfig.json](tsconfig.json) checks the whole module graph without emitting
   JavaScript. Type-only imports and `.ts` module paths run through Node's native
   type stripping; there is no app build step.

When extending the example, edit the module that owns the behavior and import
new pages explicitly in `app.ts`. Keep exported definitions serializable and
keep credentials in server configuration. The app loader evaluates trusted code;
its worker is not a sandbox. Type checking catches table/base names and display
keys; queries, dotted paths, relationship fields and action values still need
schema validation through `mistri check`.

After changing the seed schema, seed a new disposable path and regenerate types
from that copy (reuse `thread_demo` from the start commands only if its schema is
already current):

```sh
npx tsx packages/mistri/src/server/index.ts --config "$thread_demo/thread.db.json" --export types > test/fixtures/apps/thread/mistri-schema.d.ts
npx tsc -p test/fixtures/apps/thread/tsconfig.json
npm run start -- check --config "$thread_demo/thread.db.json" --app test/fixtures/apps/thread
npx tsx --test test/thread-typescript.test.ts
```

The focused test checks the full reviewed normalized contract, validates
against a fresh seed, checks generated types and rejected authoring typos, and
proves overwrite refusal. An intentional behavior change requires reviewing its
contract expectation too; the stepper, the side panel and the two
metric cards were the last such review. Saving authoring modules reloads the running app;
switching the manifest format on an existing preview may require a restart.

## What to try and where it stops

Open an issue from the workspace board or queue in its editable detail modal,
change its assignee, save and undo; in Triage, select several issues with the
keyboard and apply Mark ready or Start work to exactly that selection, then read
the per-issue result; on Board, move a card from its ⋯ menu or drag it into
place, and press F2 on a card to rename it; on Planning, drag an issue to
another cycle or priority;
create an issue, filter a queue, open its project or cycle, and add an update
from the issue's Activity. Its form supplies the parent issue automatically.
Issue modals reuse the authored page and explicit Save; Tick separately shows
blur autosave. The queue stays mounted while details are open. Previous/Next
(or `j` and `k`) steps through the queue in its own order, past its loaded
page, and Details opens the full-page link.
Issue/comment writes are enabled; planning metadata and people remain read-only.
These are sample write scopes, with no sign-in, per-user ownership or tenant
isolation. Choosing a comment author is manual and is not verified identity.
The Workspace metric cards count issues by when they were created, because
that is the only timestamp the schema keeps: "Closed" is done issues opened in
the window, not issues closed in it. Their sparklines bucket that same column
by month, so the seed's single September date draws one point.

The current-cycle dashboard and the Board entry deliberately select seeded
cycle 1; Planning shows every cycle. An issue's description and an update's
body are rich text whose @ names a member; nobody is notified of it, because
Thread signs nobody in and so keeps no inbox (Commons shows mention notices).
There is no automatic cycle rollover, realtime presence or automatic audit
stream. Activity displays ordinary comment rows, not an automatic history of
edits. A status moves only along the issue's `machine`, by its verbs,
checked by the server inside the write,
whether the move comes from a button, a bulk selection or a card dragged across
the board. Bulk actions write one issue at a time through
the ordinary update route: there is no whole-selection transaction, and the
result is reported per issue. Thread does not demonstrate durable business commands or
claim parity with Linear.
