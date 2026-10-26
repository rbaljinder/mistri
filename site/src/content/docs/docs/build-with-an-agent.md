---
title: Build an App with a coding agent
description: Install the agent skill, hand the agent a brief, and let it build page by page against `mistri check`, screenshots and a rubric.
---

Install the agent skill, hand the agent a brief, and let it build page by page against `mistri check`, screenshots and a rubric.

```sh
npm init -y && npm install @mistriwork/mistri typescript
npx @mistriwork/mistri agent init
```

Everything here works from the npm package in your App's project; the agent
needs no mistri checkout. It suits Claude Code, Codex, Cursor and GitHub
Copilot, and any agent that reads `AGENTS.md`.

<span id="the-agent-skill"></span>
## 1. Install the skill

In an empty folder, or the project the App will live in:

```sh
npm init -y && npm install @mistriwork/mistri typescript
npx @mistriwork/mistri agent init
```

The skill is a decision guide in the [Agent Skills](https://agentskills.io)
format: a first-shot recipe per kind of App (CRM, service desk, inventory,
forum, admin tool), which look and which block fits an intent, how each page
should look, which choices are hard to undo (data, access, secrets, public
forms, environment), and the loop and rubric below. Each rule links one line of a sample App. For keys, it
sends the agent to `npx @mistriwork/mistri docs <topic>`, which ships in the package.

| Agent | Reads | `--tool` |
| --- | --- | --- |
| Claude Code | `.claude/skills/mistri/` | `claude` |
| Codex | `.agents/skills/mistri/` | `codex` |
| Cursor | `.agents/skills/mistri/` | `cursor` |
| GitHub Copilot | `.agents/skills/mistri/` (and `.claude/skills/`) | `copilot` |

With no `--tool` it writes both folders, and adds a short marked block to
`AGENTS.md` naming the skill; the rest of that file is left alone.

**You should now see** `SKILL.md` under `.claude/skills/mistri/` and
`.agents/skills/mistri/`, each with a `.mistri-skill.json` beside it.
Commit them with the project.

After upgrading mistri, run `npx @mistriwork/mistri agent init` again. An untouched
copy is updated; one the project has edited is left alone, the command names
the files that differ and exits 1, and `--force` replaces them.

## 2. Hand it the brief

Replace the bracketed part with who uses the App, the records they work with
and one complete journey, for example "a clinic's front desk: book a visit,
check the patient in, record the claim".

```text
Build a mistri App for [users, records and first complete journey].
Use the mistri skill in this project, and the mistri installed here
(npx @mistriwork/mistri). Look up keys with npx @mistriwork/mistri docs <topic>.

Before editing, brief me (the skill's step 0): ask in rounds of at most four
questions, each with a default, skipping what is known, then fill BRIEF.md
and wait for my approval. Write nothing to the App until I approve it.
1. Inspect the actual database schema. Summarize the data model, permissions,
   first journey and unsupported needs.
2. Ask before touching existing data, exposing a server publicly or widening
   the requested scope. Work on a disposable copy of the database.

Build in the skill's loop:
1. Scaffold and seed: draft the App from the database (npx @mistriwork/mistri
   --scaffold-app), fill the disposable copy with npx @mistriwork/mistri seed --app
   <dir> instead of writing a seed script, and run npx @mistriwork/mistri check --app
   <dir>. Take the first-shot recipe the draft's README names for the look,
   the home dashboard and each list's presentation.
2. Then page by page (shell, lists, dashboard, each record page, each form):
   read that page type's guide (npx @mistriwork/mistri docs compose-record-page, and so
   on), edit, run npx @mistriwork/mistri check, screenshot the page with
   npx @mistriwork/mistri shot --both, compare it with the guide's worked example, and
   fix what differs before the next page.
3. Grade every screenshot against the skill's rubric, at a desk and on a
   phone. A page is done when every check passes.
4. Before handing back: npx @mistriwork/mistri test init and green tests,
   npx @mistriwork/mistri grade with nothing to fix, and every item of the skill's
   hand-back checklist (references/handback.md).

Rules:
- Use the TypeScript DSL from @mistriwork/mistri/app with the generated schema types
  (TypeScript 7 or later).
- Business handlers go in a separate server module (@mistriwork/mistri/commands).
- Connections and secrets stay in mistri.json and the environment. Opt in
  to only the writes the App needs; hiding a button is not security.
- Prefer the built-in blocks. Do not invent keys or import anything but
  @mistriwork/mistri/app, @mistriwork/mistri/commands and @mistriwork/mistri/policy. Report missing
  capabilities instead.
- Walk the whole journey in a browser: reload persistence, invalid input, the
  empty state and the keyboard. Do not call unrun checks passed.

Deliver the App, a README with exact setup, check and start commands, the
screenshots with each page's rubric result, the local URL and anything left.
Do not deploy or publish unless explicitly requested.
```

**You should now see** the agent ask a short round of questions, then show a
BRIEF.md (what it heard, the schema sketch, the screens, the commands with what
they refuse, roles and a look) and wait for your word before it writes a page.

### The brief

The skill's step 0 is an interview (`references/interview.md`): rounds of at
most four questions, each with a sensible default, on purpose, people and roles,
the things and their life cycles, rules, data, the outside world, look and
locale. What you answer, and what the agent derives, goes in `BRIEF.md`, which
you approve before anything is built. Hand over a full brief up front and it
asks only the gaps. A brief for a new database ends in a small machine block, and

```sh
npx @mistriwork/mistri new --brief BRIEF.md ./my-app
```

drafts the App from it: the schema and first migration, a SQLite database, the
lists, record pages and dashboard, the roles, a stub per command (its refusals
left as TODO lines for the agent to write) and the look. For a database that
already exists, the agent drafts with `--scaffold-app` and carries the brief's
roles and commands in by hand.

<span id="scaffold-then-curate-your-own-app"></span>
### The loop it runs

In order: scaffold → seed → check (`--defaults`, `--design --fix`) → dev →
test init → grade, then the skill's hand-back checklist. SKILL.md walks the
same loop.

**Scaffold and seed.** Over a disposable copy of the database, named in a
`mistri.json` beside the project as
`{ "connections": [{ "name": "ops", "url": "${DATABASE_URL}", "writable": true }] }`
(a SQLite file can be named on the command line instead, as in the
[quickstart](/docs/quickstart-app/), but `seed` writes only through a
config that says `"writable": true`):

```sh
npx @mistriwork/mistri --config mistri.json --scaffold-app ./my-app --name "Front desk"
cd my-app && npm install && npx @mistriwork/mistri check --app . --config ../mistri.json
npx @mistriwork/mistri seed --app . --config ../mistri.json   # about 40 rows per main table
```

`seed` is the seed script you would otherwise write: rows that keep the
schema's vocabularies, keys and unique columns, each status spread the way
the App's machine moves it with matching stamps, and dates over the last 90
days with some work due today or overdue. `--seed <n>` makes the same rows
again; a table that already holds rows is refused unless `--append`.

The draft passes `check` and `check --design` as written: Lumen, a logo and
a grouped menu with the lookups folded; an Overview home of counts, the main
table's flow as steps, a trend by month and a donut where its columns allow;
statuses as tones; records named by their parent; a record page for every
table others point at; and New forms in named groups. Over a writable
connection it reads more off the schema: a status vocabulary becomes a
`machine` (a path forward, a cancel or reject that asks first, final states
last) with the stamps its verbs set; a staff table with an email becomes the
sign-in (`auth.me`) and a "My …" queue; a line's total is computed and summed
on its parent. Its README names the nearest first-shot recipe, and why.

**Then, page by page** (shell, lists, dashboard, record pages, forms):

1. **Read its guide**: `npx @mistriwork/mistri docs compose-shell`, `compose-list`,
   `compose-dashboard`, `compose-record-page`, `compose-overview` or
   `compose-form`. Each rule is "when X, use Y" with one sample line.
2. **Edit**, then run `npx @mistriwork/mistri check --app . --json` until it exits 0.
   Each problem carries its `code`, `file`, `line`, definition `path` and,
   where known, a `fix` ([check codes](/docs/check-codes/)).
3. **Lint the composition**: `npx @mistriwork/mistri check --app . --design` warns where
   a page will come out basic, each with its fix ([design checks](/docs/design-lint/)).
4. **Screenshot it**: `npx @mistriwork/mistri shot --app . <route> --both` prints a PNG
   at a desk and on a phone (`--as <role>` signs in). `--click Printer`,
   `--type Search lap`, `--press Enter` and `--wait-for Laptop` get the page to
   a record, a filled box or an opened menu first, and `--matrix` shoots every
   look, light and dark, at a desk and on a phone, with an index page. Install the browser once
   with `npm install --save-dev playwright && npx playwright install chromium`.
5. **Compare and fix** against the guide's worked example, then go round again.
6. **Grade it**: `npx @mistriwork/mistri grade . --config ../mistri.json` measures
   every page at a desk, on a phone and in the dark ([below](#grade-before-handing-back)).

To spend fewer tokens, ask for the short forms: `npx @mistriwork/mistri schema --brief`
(one line per table), `npx @mistriwork/mistri check --app . --brief` (one line per
problem with its fix), `npx @mistriwork/mistri explain <code>` (one screen on a code)
and `npx @mistriwork/mistri shot --app . <route> --text` (what the page shows as text:
title, headings, table columns and row count, actions, empty states, errors).
Keep the screenshot for questions of layout.

<span id="check-every-edit"></span>
`mistri check` runs these steps, each with its own exit code:

| Step | What it does | Exit code on failure |
| --- | --- | --- |
| Schema types | Regenerates `mistri-schema.d.ts` when the database or the App's rollups or segments changed | 2 |
| Typecheck | The App's `tsconfig.json`; errors as `file:line`, the mismatch and a hint | 3 |
| Validation | The App against the database; preview lines and warnings never fail | 4 |
| Components | Only with [custom components](/docs/custom-components/): compile and source checks | 5 |

`--routes` prints every address the App serves. A running server reloads the
App but never rewrites its types, so run `check` after a migration
([change your schema](/docs/change-your-schema/)).

<span id="a-standalone-project"></span>
The scaffold writes the App's `package.json` (`"type": "module"`, mistri
and TypeScript 7 or later) and a
`tsconfig.json` like the samples'. Commands also need `@types/node` named in
the tsconfig (`"types": ["node"]`; TypeScript 7 loads no `@types` package it is
not told to), and their
journal and event store are provisioned once, with the server stopped:
`npx @mistriwork/mistri migrate stores up --app .`.

**Run it and test it.** `npx @mistriwork/mistri dev .` serves the App with a
throwaway session secret and prints a sign-in for every role, kept in
`.mistri/` (which the scaffold's `.gitignore` names). With `auth.me`, each
role's account takes the email of a row of that table, so `me` is someone in
the data. `npx @mistriwork/mistri test init .`
writes `tests/`: a journey per role and a permissions matrix from
`authority.lock`, run with `node --test 'tests/*.test.ts'`. They stand on
`@mistriwork/mistri/testing`: `host.as(role)` signs a role in, and `.update`, `.command`
and `.act` return a result, a refusal with its status and code, so no test
hand-writes a request ([testing an App](/docs/testing-apps/)).

<span id="before-handing-back"></span>
**Before handing back**, the skill's `references/handback.md` asks for what
a finished App has beyond its pages, or the reason the domain needs none:
`notify` on the machine's edges, a `document()` where the domain has paper,
a public command form or page where customers interact, `history()`, a
`recordLabel` people search by, `mistri seed` rather than a seed script,
`mistri test init` with green tests, `check --design` clean and
`mistri grade` with nothing to fix.

## 3. Acceptance: the rubric

<!-- The same checks are the skill's (skills/mistri/references/rubric.md); test/agent-skill.test.ts keeps the two identical. -->

Grade each screenshot, desk and phone, against its page type. Every check is
yes or no; a no is fixed before the page is done.

**Record page**
- The name is words (not "Visit #12" or a bare code), with the state beside it.
- Three or four facts under the name, with units; none repeats the name.
- The figures share one row; no card wraps alone.
- Child lists are tabs; no column is cut and the status is visible.
- The aside holds the parent's card, the current child and a property rail,
  nothing wider than two columns.
- On a phone, the main work comes before the aside.
- The filled button is the forward verb; destructive verbs come last.

**Form**
- A sentence under the heading says what a new record is for.
- Fields sit in groups named by nouns, none longer than seven.
- Every required field starts filled or is plainly the reader's to fill;
  created-on dates start today.
- Choices read as words, references as names.
- Long text has a box of several lines; a dependent picker offers only the
  chosen parent's records.
- Add and Cancel sit together at the end.

**Overview page**
- The name appears once, with its avatar or mark.
- A row of three to five figures, each with its unit or word.
- A chart of activity in time order, no taller than it needs.
- Lists of what it made, every column readable; an empty one is left out.
- No aside half empty beside a long main column.

**List**
- The first column names the row; no raw id, and a reference reads by name.
- Four to seven columns fit at 1280 wide without cutting the status.
- Tabs are counted, in working order, All last.
- Money has its currency, states are a tone and a word, due dates say how far.
- The filters are the ways it is narrowed (a rail for three or more).
- On a phone the rows read without a sideways scroll.

**Dashboard**
- The first row is three or four figures of one width.
- Every figure says its window; a compared one says against what.
- Charts run in time order with readable axes.
- A chart has one measure per axis, at most four colors, a legend where
  color means something, and its categories in their fixed order.
- A breakdown's words are words, and its total matches the figure it divides.
- The page ends where its content ends.

**Navigation and shell**
- A look chosen for the work and written in `ui.theme`, and a mark beside the
  App's name.
- At most seven top-level entries; groups named by the work; a section used
  rarely starts folded.
- Every entry has an icon of what it lists; counts beside the lists.
- Home is the page a person starts the day on.
- The folded rail and the phone menu still reach every entry.

**Before calling it done**
- The look was chosen on purpose (Lumen, Mono, Sage or a theme of the App's
  own), and a theme of its own passes `mistri check`.
- Home is a dashboard a person starts the day on.
- Status, money, people and dates are drawn (a tone, a currency, an avatar, a
  relative date); no raw code, id or timestamp is printed anywhere.
- The menu is grouped by the work, with rarely used sections folded.
- No page scrolls sideways on a phone, at 390 and at 320 wide.
- Every chart passes the color check: the look's own colors in order, a
  custom theme's validated for color-vision deficiency, no color by position alone.
- Nothing jumps after the first paint: reload a page and watch its first second.
- Every list and section that can be empty says what belongs there.
- `mistri check --app .` exits 0 (typecheck and validation), and
  `check --design` has nothing left to fix.
- `mistri grade` reports no error: it measures what this list can be
  measured on, every page at a desk, on a phone and in the dark.

## Grade before handing back

About two thirds of the rubric is measurement, and `mistri grade` takes it:
it serves the App, opens every view and a record of each page at 1280, 390
and 320 wide and at 390 in the dark, and prints one line per finding with its
fix, at the file and line that declares the page.

```sh
npx @mistriwork/mistri grade . --config ../mistri.json            # one line per finding, then a score
npx @mistriwork/mistri grade . --config ../mistri.json --as desk  # as a role sees it
```

Run it last, after `check` and `check --design`, and fix each error (exit code
2) before handing back: a page that scrolls sideways, a cut figure, two
controls on each other, text under the contrast rule, a jump after the first
paint, a page error or a failed request. Fix the warnings you can; a warning
about one of the platform's own controls goes in the report rather than into a
restyle. Put the score in the report. The screenshots are left for questions
of taste: the order of a page, its words, whether it is the right page. The
codes are on [design checks](/docs/design-lint/#measured-in-a-browser-mistri-grade).

## Choose the right building block

The skill sends the agent to [Choose a building block](/docs/choose/) for
which view, section or command a need calls for; `npx @mistriwork/mistri docs choose`
prints it offline. Tenant Apps have their own startup contract: do not fake
tenancy with a `tenant_id` filter. MCP can inspect a development database but
does not act as an App user, so test authorization over HTTP.

## Definition of done

The agent's report shows evidence, not "it should work":

- **Setup:** a new engineer can follow the App's README without a missing
  table, hidden variable or private import.
- **Checks:** `mistri check` exits 0 against the real fixture, and
  `mistri grade` reports no error, with its score.
- **Pages:** each page's desk and phone screenshots (`mistri shot --both`),
  each looked at, with its rubric passed and nothing left that `check --design`
  could fix.
- **Journey:** create, read and change a record; state survives a reload.
- **Failure states:** empty lists, invalid values, denied operations and
  failed writes behave honestly; an unknown command outcome is not a failure.
- **Limits:** unsupported needs, checks not run and production work left.

Keep the handoff compact, with distinct evidence for each claim:

| Evidence | Record in the App handoff |
| --- | --- |
| Routes and layout | Local URL and route list; desk and phone PNG paths, rubric result and any failed item per page |
| Static checks | Exact `check` command and exit status; design findings, including warnings |
| Journeys | Actions actually performed, user/role, resulting rows and reload result; empty and invalid-input cases |
| Authorization and concurrency | Denied requests and overlapping writes tested against a disposable database, or explicitly **not tested** |
| Deployment | Environment/build/production checks performed, or explicitly **not deployed** |

Screenshots establish layout, not write safety, authorization, concurrency or
production readiness. Do not promote an untested claim into a pass.

## Related

- [Choose a building block](/docs/choose/): the intent-to-block rules the skill routes to.
- [mistri check](/docs/check-codes/): every check code, with its fix.
- [Design checks](/docs/design-lint/): what `check --design` and `mistri grade` measure.
- [Observe and operate](/docs/observe/): the dev observer and its MCP tools.
- [Test an App](/docs/testing-apps/): the suite an agent leaves behind.
