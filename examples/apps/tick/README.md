# Tick

A tiny tasks app: add tasks inline, check them off in the list, and browse
Open, Today, Overdue, Upcoming and Done. Clicking a task opens a detail modal over the
list. The modal uses the same authored record fields, editing, actions and
confirmed deletion as the full page; Details opens that page directly.
Both editors autosave a changed field when you leave it. Save and Discard remain
available. Previous/Next (or `j` and `k`) follows the original list, in its
order and tab, past its first page too.
Each task still has just a name, a completed flag, an optional due date and its
place in the list.
The App home (`/`) opens directly to Tasks: every App names its `home`, and
Tick's is `home: 'tasks'`. `nav` is optional; Tick has none, so it draws no menu.
The `shell` settings hide the menu, search, breadcrumbs and visible page title,
and center the content with `width: 'narrow'` and `gutter: 'comfortable'`.
`headerWidth: 'content'` aligns the brand and header controls with that same
width and gutter on desktop and phones; the background and border stay full width.
Omitting `headerWidth` or setting it to `'full'` keeps the usual header spacing.
Omit these settings to keep Tablewalk's default shell. List-level
`filterBar: 'none'` hides the filter form without hiding the task-view tabs.
`open: 'modal'` controls task-list detail opening; the modal fills the screen on
phones and keeps keyboard focus inside until dismissed.

## Quickstart

Use Node 24+ with repository dependencies installed. Run from the repository root:

```sh
tick_dir=$(mktemp -d /tmp/mistri-tick.XXXXXX)
node examples/databases/tick/seed.mjs "$tick_dir/tick.db"
npx tsx packages/mistri/src/server/index.ts check --config "$tick_dir/tick.db.json" --app examples/apps/tick
npx tsx packages/mistri/src/server/index.ts --config "$tick_dir/tick.db.json" --app examples/apps/tick
```

Open the address printed by the server. The seed creates four deterministic
synthetic tasks and a writable connection named `tick` in `<database>.json`.
It requires an explicit database path and refuses an existing database or config,
including symlinks. Choose a fresh path to start over.

## Authoring

[app.ts](app.ts) contains the entire app as `defineApp` data with an inline
`TypedAppConfig` schema type. Edit its view, record fields, the task resource's form
defaults or fixed `set` actions; the server reloads the manifest automatically. New tasks
default to open and may omit the due date. Deletion requires confirmation.

Database creation lives separately in [seed.mjs](../../databases/tick/seed.mjs).
The app directory contains only `app.ts` and this README; it needs no generated
declarations or local TypeScript configuration. Loading the manifest or importing
the seed module never creates a database.

The `task` resource block says what Tick knows about a task, once: it is
written (`access: 'write'`), its New form, its two
actions (keyed by id, `complete` and `reopen`) and its overdue flag. The `tasks` view says how the list reads:
`presentation: checklist('name', 'completed', { lines: ['due_on'] })`
chooses the shared checklist presentation; `quickAdd: true` puts the task's New
form directly above the list. Neither requires a custom renderer or write API.
A due date reads from today ("in 3 days", "yesterday") in the list and on
the record without a word from the App: the platform says a date named like a
due date that way, and the date itself is the tooltip. The New form's
`show: ['name', 'due_on']` asks for the task's name and its day and nothing else:
whether a task is completed is not a question when adding one, so `completed` is
defaulted (`defaults: { completed: false }`) and left out of what the form shows.
`show` and `defaults` apply to the New form (inline and in the modal), not to
editing an existing task, and they never change what the server accepts.
Today means due today; Upcoming means later than today. Undated and overdue
tasks remain in Open. The date phrases are evaluated by Tablewalk, not fixed
dates embedded in this manifest.
Overdue reads a computed column: `computed: { is_overdue: computed.boolean('due_on
< today and not completed') }` is a yes-or-no worked out in the statement, never
stored, so the tab's query names it like a column (`is_overdue = true`) and a
list could show, sort or tone by it. `today` there is the App's day, as in a
query. The inline `Tables` type lists it beside the columns.

Open and Today read in the order you keep: `order: 'position'` names the
numeric column holding each task's place. Drag a task into place (on a phone,
hold it a moment first), press Alt+↑ or Alt+↓ on a focused task, or pick Move
up, down, to top or to bottom from its grip. Each move is an ordinary update of
the one task's `position`, halfway between its new neighbors, with Undo.
Upcoming sorts by due date and Done by when a task was added, so their grips
hide. `position` stays out of the shown fields and the New form; a new task
has no place yet, and reads first until it is moved.

Completion and reopening are ordinary updates through the shared editing controls.
Pending writes wait for acknowledgement; an uncertain write stays locked with
an explanation instead of being automatically retried. The record page retains
Complete/Reopen actions as well.
`ui.editing: { save: 'blur' }` opts full-page and modal editors into that behavior. Each blur
saves the whole currently staged valid snapshot with its expected originals;
separate blur gestures are separate transactions. Unselected reference searches
or invalid fields block submission. Leaving before dispatch retains a draft in
this tab, and retained or rejected drafts require explicit Save. Remove `ui.editing`
or set `{ save: 'explicit' }` to require Save for all edits;
New/Add, checklist toggles and Complete/Reopen keep their own interactions.
There is no authentication, server workflow or background automation in Tick.
