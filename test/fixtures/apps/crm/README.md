# Compass

A modular CRM sample for tablewalk's app layer: a 12-table SQLite database
(accounts, contacts, leads, a staged opportunity pipeline with quote lines,
activities, tasks, campaigns) plus an app directory that curates it — grouped
views, per-list columns and filter tabs, fixed `set` actions, two curated New
forms, a registered custom theme, and five composite detail pages
(`pages/*.ts`) with metrics, breakdowns, dotted-path cards, `about` sections
and one `when` section that appears only once a lead is converted.

The user/LLM authoring entry is [`app.ts`](app.ts). Database creation is separate
under [`test/fixtures/databases/crm`](../../databases/compass/); generated
[`mistri-schema.d.ts`](mistri-schema.d.ts) stays here with the App modules.

## TypeScript authoring

[`app.ts`](app.ts) composes the application with `defineApp` and schema-derived
`satisfies App` checks. No separate app build is needed: the server loads this
TypeScript module graph directly.

- [`dashboard.ts`](dashboard.ts): `dashboard`, `metric`, `chart`, `breakdown`,
  `matrix`, `rows`, and `note` compose the sales dashboard. The Won card
  compares against the previous period and draws its monthly `spark`; the
  dashboard's `windows` are the three phrases the reader can pick, and the
  note says what each section does with the pick. A section's `format` says a
  computed measure's figures: time with customers (`sum minutes * 60`) as
  `duration`, pipeline confidence by rep as `percent`.
- [`resources.ts`](resources.ts): what Compass knows about each resource,
  once — which it writes; `money`, `percent`, `tones` and `relative` display
  rules (the `'*'` key in a tone map is the fallback for every value the map
  does not name, so a vocabulary is all pills); the column captions every
  view and form uses (`labels`); the Leads and Opportunities New forms (the
  lead form has a `description`, sections with a line under them, a
  `created_on` that starts `'today'` and per-field `help` and `placeholder`
  in `fields`; the opportunity form uses `groups` — Deal, Forecast — to lay
  its fields out in two parts); fixed `set` actions; and `validation` rules, resource
  invariants checked on every write, whichever surface makes it.
- [`views.ts`](views.ts): the lists — their columns, filters and tabs — beside
  the sales dashboard; Tasks draws its filters as a rail of counted facets
  (`filterBar: 'rail'`) and edits a task's priority, due date and
  owner in place, with "Set field…" for a selection (`editable`), Task calendar puts the tasks on a month by
  due date (`presentation: calendar(…)`), Leads offers each
  row's actions from a ⋯ menu (`rowActions`), Opportunities sums its amounts
  and their weighted value — a computed column, `amount * probability / 100` —
  in a footer (`totals`), Pipeline draws the open deals as lanes of the stage
  machine, a card dragged (or moved from its ⋯ menu, or with Alt+←/→) only
  into a stage one of its verbs leads to (`board`), and Products reads as a compact ledger
  (`density: 'compact'`). [`navigation.ts`](navigation.ts) arranges them in
  four groups, each with an icon.
- [`theme.ts`](theme.ts): `defineTheme` builds Meridian, a custom theme
  registered through `ui.customThemes` in `app.ts` and offered in the reader's theme
  picker; the app's own default stays the legacy accent tokens.
- [`pages/`](pages/): record pages built with `page`, `related`, and timeline streams, one per file (`export default page(…)`), found by their file without a list in `app.ts`.
- [`app.ts`](app.ts) also declares `assistant({ instructions, exclude, limits })`: with
  `ANTHROPIC_API_KEY` set and the store provisioned, a rep asks it to sum up a lead, show stale deals or log a
  call, and confirms each change it proposes.

Queries and relationship paths remain ordinary strings validated against the
database when the app loads. [`mistri-schema.d.ts`](mistri-schema.d.ts)
adds editor checks for table names and each resource's columns. Check the entire app with:

```sh
npx tsc -p test/fixtures/apps/crm/tsconfig.json
```

`test/crm-typescript.test.ts` checks those generated types against a disposable
seed database and type-checks the app, without touching the live example data.

## Run locally

From the repository root, with Node 24+ and dependencies installed, create a
fresh disposable database outside the authoring directory:

```sh
COMPASS_FIXTURE_DIR=$(mktemp -d /tmp/tablewalk-compass.XXXXXX)
node test/fixtures/databases/crm/make-crm-db.mjs "$COMPASS_FIXTURE_DIR/compass.db"
npx tsx packages/mistri/src/server/index.ts --db "$COMPASS_FIXTURE_DIR/compass.db" \
  --app test/fixtures/apps/crm --port 4601 --no-config
```

The seeder uses a fixed PRNG seed and dates anchored to the current UTC day.
Set `MISTRI_CRM_TODAY=2026-08-30` to reproduce a specific day. The default
output is `test/fixtures/databases/crm/compass.db` when no path is supplied. Existing
files (including symlinks) are refused. A failed seed may leave a partial new
file; choose a new output path for another attempt. Existing `crm.db` copies
remain usable with `--db`; the seed never replaces them.

Open [Compass](http://127.0.0.1:4601/). Browsing is read-only by default.
To enable the authored CRM edits on your fresh fixture, create a runtime config
outside the app directory and set `COMPASS_DB` to the fixture's absolute path:

```json
{ "connections": [{ "name": "compass", "url": "${COMPASS_DB}", "writable": true }] }
```

Launch with `--config <runtime-config.json> --app test/fixtures/apps/crm` instead
of `--db ... --no-config`. The App further limits writes to leads, opportunities,
tasks, activities, and contacts; UI actions are ordinary record updates, and
form groups and display rules never change what the server accepts. This
JSON config supplies the database connection; `app.ts` remains the App source.

Three resource `validation` rules hold on those writes: an opportunity's
`close_date` is on or after its `created_on`, a won opportunity (`stage` is
`closed_won`) has a `probability` of 100, and a lead whose `status` is
`converted` names its `converted_contact_id`. The server checks the stored row
after every insert and update — the New form, a record Save, a fixed action or
an API call — and rolls the write back when a rule fails. The refusal is one
fixed message, "The record does not satisfy the application rules.", and it
names each failing field with another, "This value does not meet the
application rules.": the New form marks that field and keeps what was typed,
and the insert and update routes answer with a `rejected` outcome listing the
fields. The rule's own message stays in the App; a record Save shows the
summary rather than marking the field. A rule requires a field, or compares
it with another field (`other`) or with a constant (`value`, typed against the
column like a query literal), and `when` limits a rule to the rows its structured
predicate matches.

Validate the same disposable database without starting a server:

```sh
npx tsx packages/mistri/src/server/index.ts check --db "$COMPASS_FIXTURE_DIR/compass.db" \
  --app test/fixtures/apps/crm --no-config
```

## Optional PostgreSQL fixture

Use a new dedicated database with an empty `public` schema. Set
`TABLEWALK_TEST_PG` privately to its seed-role URL, then copy the SQLite fixture:

```sh
node test/fixtures/databases/crm/seed-postgres.mjs "$TABLEWALK_TEST_PG" "$COMPASS_FIXTURE_DIR/compass.db"
```

The source SQLite file is opened read-only. PostgreSQL tables and rows are
created in one transaction, preserving the existing fixture DDL. Any existing
object in `public` refuses seeding; nothing is dropped or replaced. A connection
failure around commit can leave the outcome uncertain; inspect the dedicated
database before retrying. Configure a separate runtime connection and pass it
with `--config <runtime-config.json> --app test/fixtures/apps/crm` to browse it.
