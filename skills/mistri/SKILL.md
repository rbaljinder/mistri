---
name: mistri
description: Decision guide for building or changing a mistri App, the TypeScript DSL from @mistriwork/mistri/app over a SQLite, PostgreSQL or MySQL database. Load it before scaffolding an App; adding or reshaping its lists, record pages, forms, dashboards, navigation or look; choosing between a resource form, a fixed action and a command; or deciding sign-in, roles, row policies, tenancy, public pages and forms, hidden columns, secrets and sources; or writing its tests. Not needed for browsing a database with the standalone tablewalk browser.
license: MIT
compatibility: the mistri that installed it (mistri agent init) on Node 24, run as npx @mistriwork/mistri in the App's project; mistri shot needs Playwright's Chromium or a local Chrome (--browser <path> names one).
---

# Building a mistri App

An App is `app.ts` (helpers from `@mistriwork/mistri/app`) over a database; the server draws every page and enforces
who reads and writes what. This file is the loop and the rules; load a reference file when its step comes. Keys
ship with the package: `npx @mistriwork/mistri docs` lists the topics, `npx @mistriwork/mistri docs <topic>` prints one (`app-dsl`
indexes every key). The sample Apps the references and guides link, Tick, Lintel and Ladle, ship too: `node_modules/@mistriwork/mistri/examples/apps/`.

## The loop: brief → scaffold → seed → check (`--defaults`, `--design --fix`) → dev → test init → grade

0. **Brief**: interview first, in rounds of at most four questions with a default each, skipping what the request or
   `npx @mistriwork/mistri schema --brief` says; fill [BRIEF.md](references/brief-template.md) and get it approved
   ([interview.md](references/interview.md)). Nothing is scaffolded or seeded before approval; then `npx @mistriwork/mistri new --brief BRIEF.md ./my-app`.
1. **Orient**: `npx @mistriwork/mistri schema --brief`. Tell the person the records, the first journey, who uses it
   and what the App cannot do. Ask before touching existing data or widening scope.
2. **Settle the hard-to-undo choices** with the person: [choices.md](references/choices.md),
   [security.md](references/security.md); a public form's human check, tenant placement and limits are among them.
3. **Scaffold and seed** a disposable copy: `npx @mistriwork/mistri --config mistri.json --scaffold-app ./my-app`, then
   `npx @mistriwork/mistri seed --app ./my-app --config mistri.json` (its connection `"writable": true`); a seed script
   (outside the App's folder) only for rows it cannot make ([handback.md](references/handback.md)). The draft has a look, an Overview, a machine per status, sign-in for staff, and its recipe.
4. **Aim for a finished first shot**: take the recipe the draft's README names, from [recipes.md](references/recipes.md)
   (CRM, service desk, inventory, forum, marketplace, admin tool) for the look, the home dashboard and each list's
   presentation, and draw every status, amount, person and date ([design-language.md](references/design-language.md)).
5. **Page by page** (shell, home dashboard, lists, record pages, forms), in the App's folder:
   1. pick blocks by intent (`npx @mistriwork/mistri docs choose`) and read the page's guide (`compose-shell`,
      `compose-list`, `compose-dashboard`, `compose-record-page`, `compose-overview`, `compose-form`); a form's rows,
      steps and the intake style are in [recipes.md](references/recipes.md#forms-a-record-form-in-rows-an-application-as-an-intake);
   2. edit, then `npx @mistriwork/mistri check --app . --brief` until it exits 0: one line per problem,
      `code file:line message — fix: …`; an unfamiliar code is `npx @mistriwork/mistri explain <code>`;
   3. `npx @mistriwork/mistri check --app . --design --brief`, and fix every warning (`--fix` deletes `restated` ones;
      `--defaults` prints what the platform infers, which the App need not say);
   4. `npx @mistriwork/mistri shot --app . <route> --text` to verify what the page shows (headings, columns, row count, actions, empty states, errors);
   5. only for layout: `npx @mistriwork/mistri shot --app . <route> --both`, open both
      PNGs, grade them with [rubric.md](references/rubric.md).
6. **Walk the journey**: create, change, reload, an invalid value, an empty list, a denied action, a phone. Serve with
   `npx @mistriwork/mistri dev .` (a printed throwaway sign-in per role): a refusal names its cause (`because: …`), and
   `npx @mistriwork/mistri observe --mcp` gives `tail`, `recent_errors`, `get_trace`, `explain_access`, `n_plus_one`, `slow_queries`.
   One App is served at the root (`/leads/127`); `check --routes` prints its addresses.
7. **Test it**: `npx @mistriwork/mistri test init .` writes a journey per role and a permissions matrix; then the
   five layers ([testing.md](references/testing.md)).
8. **Grade and finish**: `npx @mistriwork/mistri grade . --config ../mistri.json` measures every page at a desk, on a phone
   and in the dark, one `code page@width — fix: …` line per finding; fix until it reports no error, then every item of
   [handback.md](references/handback.md) (notifications, documents, public side, history, search, seed, tests).
   **Report evidence**: commands and exit codes, each page's rubric, the grade's score, the whole-App checks ("Before
   calling it done"), the hand-back items and what is left; never claim an unrun check.

## Hard rules

- Public entry points only: `@mistriwork/mistri/app` in the App; `@mistriwork/mistri/commands` and `@mistriwork/mistri/policy`
  in server-only modules (`commands.ts`, `--jobs`, `--policy`), loaded, never imported. Never
  import or patch mistri's `src/`; report a missing capability instead.
- Type the definition `satisfies App` from the generated
  `mistri-schema.d.ts`; never edit it, never cast a name (`as never`).
  Change the schema only by migration: `npx @mistriwork/mistri migrate new <name> --app .`,
  `npx @mistriwork/mistri check --app . --pending`, then `npx @mistriwork/mistri migrate up --app .`;
  a database that already has tables is baselined first, with the person's word.
- Name an action by its id (`actions: { withdraw: action('Withdraw application', …) }`)
  and refer to the id everywhere: `header({ destructive: ['withdraw'] })`, a
  role's `actions`. Keep actions inline in their resource.
- A value worked out from the record's own columns is a computed column:
  `computed.boolean('due_on < today and not completed')`; one copied from a chosen record is `{ from: 'service_id.price' }`.
- The server is the security boundary: `hidden`, `fields` ceilings, grants, row policies and
  database privileges protect; `show`, `when`, `masked` and a missing button only hide.
- `auth: { rows: 'policy' }`: pass `--policy ./policy.ts` to every `check`, `dev`, `shot` and `grade`.
- Writes are opt-in twice: `"writable": true` on the connection and `access: 'write'` on the
  resource. Credentials stay in `mistri.json` as `${VARIABLE}` references, never in `app.ts`.
  Never reseed, migrate or write to an existing database without asking.
- Prefer a built-in block; a custom component only for a drawing no block makes, after the gap is shown. Spell every key as the docs do; never guess one.
- A whole screen no view draws is a free-form page: `pages/<path>.page.tsx`, `definePage` from `@mistriwork/mistri/page`,
  declaring its `reads`, `commands`, `params` and `loader`; it writes only through those commands, never `fetch`.
- A branded public site, a flow the person's own React owns, or a route that is not a command takes the general
  path, settled in step 2: [choices.md](references/choices.md#the-general-path), with Ladle as its sample.

## Reference files, loaded when the step needs them

- [interview.md](references/interview.md), [brief-template.md](references/brief-template.md): step 0, the questions and the brief.
- [choices.md](references/choices.md), [security.md](references/security.md): identity, data, access mode, public forms, environment, workflows; what only hides a value, and the checks before shipping.
- [recipes.md](references/recipes.md), [design-language.md](references/design-language.md): what a finished App of each kind holds, as patterns; looks and themes, drawn values, inputs, dashboard blocks, chart rules.
- [rubric.md](references/rubric.md), [handback.md](references/handback.md): the per-page and whole-App yes/no checks; what a finished App has beyond its pages.
