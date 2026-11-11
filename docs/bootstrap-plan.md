# Bootstrap plan and project profile: design note (rc.11)

Status: APPROVED 2026-11-01. The user approved every recommendation (D1–D11) as written. A field report (finding F12) asked for two things:

- **One bootstrap plan.** The App's migrations applied and then `mistri check` exited nonzero because the command
  and event stores did not exist yet, so the App kept its own ordered setup script. The report wants one
  inspectable plan that reports applied, pending and failed phases, tells a pending prerequisite apart from failed
  SQL, and says whether anything was applied.
- **One project context.** The policy, jobs, commands, config and App paths have to be passed the same way to
  several commands. The report wants a project manifest or shared invocation profile that commands can find, and
  check and CI still have to show the effective runtime authority.

Both reproduce. Neither needs a new command: `mistri migrate` already has the steps, `mistri deploy` already runs
them in the right order, and `mistri.json` is already the file every App command looks for.

## What happens today (reproduced on rc11/main, 2026-11-01)

The App was a `mistri new` starter with one command that projects an event (`task.completed`), one job on that
event and two roles, served from this checkout against a fresh SQLite file.

| Step | Exit | What it said |
| --- | --- | --- |
| `migrate up --app . --config mistri.json --jobs jobs.ts` | 1 | `--jobs is for stores.` `up` does not take the App's jobs. |
| `migrate up --app . --config mistri.json` | **4** | `applied V1__task.sql`, then the check: `validation failed … Command "finish" declares events, but source "scratch" has no event store`, then "**The migrations are applied, and the App no longer fits the schema they made**". That last sentence is wrong: the schema fits, and a store is missing. |
| `check --app . --jobs jobs.ts` | **4** | The same refusal. It exits 4, the code for an App that does not fit its database. |
| `migrate status --app .` | 0 | "Up to date at version 1." Stores are not mentioned. |
| `migrate stores status --app .` | 0 | Every one of the 30 known layouts is `absent`. It does not say which ones this App needs. |
| `migrate stores up --app .` (no `--jobs`) | 0 | Provisions the live sync store, command journal and event store. |
| `check --app . --jobs jobs.ts` | 4 | Now a real authoring fault appears (`command-and-edit`), which the store refusal had hidden. After that is fixed, the next missing store: `Jobs startup error: … job store or event delivery … could not be opened`. |
| `migrate stores up --app . --jobs jobs.ts` | 0 | `job store provisioned, 1 delivery destination(s), 1 added` |
| `check --app . --jobs jobs.ts` | 0 | Passes and lists `jobs: touchFinished@1 on task.completed@1 …`. |
| `check --app .` (no `--jobs`) | **0** | Also passes, with no line saying the jobs were not loaded. A sample App with a policy, an inbound endpoint and a decision also passes `check` without `--jobs`. (Since rc.11 it still passes, with a `not-loaded` info line naming the jobs file it did not read.) |
| serve and `mistri dev` before `stores up` | refuse | The same event-store sentence. Neither one migrates or provisions. |
| `seed --app .` before `stores up` | 0 | Seeding writes rows directly and needs no store. |
| `stores up` before `migrate up`, on an empty file | 0 | On SQLite, stores do not depend on the App's tables. The order only matters because `up --app` checks the App. |

So the report is right on both counts, with three corrections:

1. Check does not test stores itself (`build/check.ts` has no store step). Validation loads the App through the
   command host, which refuses an absent store (`commands/appCommandEvents.ts:93`, `cli/commandHost.ts:136-149`).
   One refusal stops the whole load, so the next store and any real fault stay hidden until it is fixed.
2. The steps are only ordered in the deploy path. `mistri deploy` already runs `migrate up` and then `migrate stores
   up` with the App's entries (`deploy/effects.ts:195-210`), and it reads them from `mistri-deploy.json`
   (`deploy/types.ts:115-129`: `app`, `appEntry`, `config`, `commands`, `jobs`, `policy`). Locally there is no such
   sequence. `migrate stores up` is named on 21 site pages, each for its own feature, and the agent skill's loop
   (`skills/mistri/SKILL.md` step 3 onward) never mentions it.
3. A profile half exists, and the commands disagree about where to find it. `mistri dev` reads
   `<app>/mistri.json` first (`cli/devMode.ts:100-104`). Serve, check, migrate, seed, shot and grade read
   `--config`, then `./mistri.json` and `./.mistri.json` in the working directory, then the person's own
   `connections.json` (`packages/engine/src/server/config/locations.ts`, `configLocations`). Running `check --app scratch` from the parent
   directory finds no database, while `dev scratch` finds it. `mistri new` writes `--app . --config mistri.json`
   into four package scripts. The site's deploy page builds the profile by hand
   (`P="--config … --app … --policy …"`, `build-and-deploy.md:132`), and the skill says "pass `--policy` to every
   `check`, `dev`, `shot` and `grade`".

### The context flags, per command

The flags share one parser (`engine/server/cli/args.ts:176-266`). No flag has an environment equivalent. The only
module found by convention is `commands.ts|mjs|js` beside the manifest (`app/apps.ts:303`). Policy and jobs are
never inferred, and a tenant App refuses to start without "explicit `--policy` enrollment" (`cli/apps.ts:124`).

| Command | `--app` | `--config`/db | `--commands` | `--jobs` | `--policy` | `--app-entry` |
| --- | --- | --- | --- | --- | --- | --- |
| serve (`mistri --app`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `dev` | ✓ (or positional) | ✓ (finds `<app>/mistri.json`) | ✓ | ✓ | ✓ | |
| `check`, `build`, `deploy` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `shot`, `grade` | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `migrate up/status/…` | ✓ | ✓ | | **refused** | ✓ (handed to its check) | |
| `migrate stores up` | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `seed` | ✓ | ✓ | | | | |
| `test init` | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `tenant` | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `flows` | ✓ | ✓ | | | ✓ | |
| `jobs` | ✓ | ✓ | (implied) | ✓ | ✓ | |
| `decide` | ✓ | ✓ | (implied) | ✓ | | |
| `api-token` | ✓ | ✓ | ✓ | | ✓ | |

Secrets live in the environment (`BETTER_AUTH_SECRET`, and `${VAR}` in `mistri.json` connection URLs). Dev keeps
its own secret and passwords in `.mistri/dev.json`, mode 0600, in a gitignored folder (`cli/devMode.ts:44-63`).

## Part A: the bootstrap plan

**A1. Extend `mistri migrate`, with no new command.** With `--app`, `migrate status` prints the plan and changes
nothing, and `migrate up` carries it out. It already applies migrations, writes types and checks. It also brings
up the stores, in the same order and through the same code that `mistri deploy` runs (`deploy/effects.ts`), so
there is one sequence. `migrate stores up` stays as the step on its own. `up` accepts `--jobs` and `--commands`
and hands them to the stores step, so the first row of the table above stops being a refusal.

**A2. The phases, in order.**

| # | Phase | What it covers | Run by `up --app` |
| --- | --- | --- | --- |
| 1 | migrations | the App's versioned and repeatable files, drift and history problems (`migrationStatus`) | yes |
| 2 | stores | only the layouts **this App** uses: the journal, event store and live sync for its commands, the job store and deliveries for its jobs, record history, notifications, the assistant (from `declaredStores.ts` and the stores step's App walk) | yes |
| 3 | sign-in store | SQLite: made by the first start, and the plan says where (dev's or a plain start's, the rule `tenant grant` uses). PostgreSQL `auth.store`: today a `node -e` call to `migratePostgresAuthStore` (decision D4) | PostgreSQL only |
| 4 | seed | reported only: "main tables empty: `mistri seed --app .`" (decision D3) | no |
| 5 | check | the App judged against the result, with the effective context (Part B) | yes |

A tenant App's `tenant init` and `migrate files up` are listed as follow-on steps with their commands, and are not
run. Feature stores that are provisioned on purpose (`flags`, `experiments`, `analytics`) are left out of the plan.

**A3. Statuses.** Each phase gets one word, and the details go on the lines under it:

- `done`: already in place before this run.
- `applied`: changed by this run, with a count and names.
- `pending`: `up` would change it.
- `waiting`: not run because an earlier phase is pending or failed. This is the "pending prerequisite" the report
  asked to see.
- `failed`: the file or store, the database's message, and whether its transaction rolled back. Each migration and
  each store step runs in its own transaction, so a failure never half-applies one step.
- `skipped`: with the reason, such as "an App with row policies and no `--policy`" (the rc.11 fix) or "this App
  uses no jobs".

The plan always ends with one line about changes, such as `Changed: 1 migration, 4 stores.`,
`Nothing changed.` or `Changed: V1__task.sql. Not changed: stores (failed), check (waiting).`

```
Bootstrap of "scratch" (sqlite, scratch.db), context from ./mistri.json
  1 migrations     pending  V1__task.sql
  2 stores         pending  command journal, event store, live sync, job store (+1 delivery)
  3 sign-in store  at start a SQLite file the first start makes (.mistri/config/mistri/auth/scratch.db under dev)
  4 seed           —        task is empty: mistri seed --app .
  5 check          waiting  runs after 1 and 2
Nothing changed. mistri migrate up --app . applies 1 and 2, then checks.
```

**A4. Exit codes.** These extend the codes `migrate` already has (1 could not run, 2 files and history disagree,
3 a migration failed, 4 applied but the App no longer checks):

- `up`: adds **5, a store step failed**. The summary line says which migrations did apply. Code 4 applies only
  when the check really fails. Its closing sentence names the store when a store was the cause, and never claims a
  schema misfit.
- `status --app`: unchanged (0, or 2 when nothing has ever been applied), because a plan is a report.
- `validate --app`: exits 2 when **any** phase is pending, not only migrations. This becomes CI's check that the
  database is ready for this App.
- `check`: adds **8, stores pending** (decision D5), separate from 4 (does not fit). Validation keeps going with
  the store refusals set aside, so a real fault such as the hidden `command-and-edit` shows in the same run. The
  finding carries a new code, `store-pending`, documented in `check-codes.md` and `mistri explain`, and its fix is
  the exact `migrate up --app …` command with the run's own flags (`storesUpCommand` already builds such a command,
  `stores/storesCli.ts:168`).

`--json` on `migrate status`, `migrate up` and `check` carries the same phases as data:
`{ phase, status, items[], error? }`, plus `changed: boolean`.

## Part B: the project profile

**B1. Where it lives: an `app` block in `mistri.json`.** It is the file every App command already looks for. It
already holds connections with `${VAR}` references and no secrets, and its saves keep top-level keys they do not
know (`saveConfig` spreads `existingConfig`, `engine/server/connections.ts:1115-1123, 1179`).

```json
{
  "app": { "dir": ".", "commands": "commands.ts", "jobs": "jobs.ts", "policy": "policy.ts" },
  "connections": [{ "name": "desk", "url": "desk.db", "writable": true, "migrations": { "dir": "db/migrations" } }]
}
```

- **Keys it may hold:** `dir`, `entry` (as `--app-entry`), `commands`, `jobs` and `policy`, and nothing else. An
  unknown key is refused by name, to catch typos. These are the entries that carry authority. Ports, mounts and
  looks stay as flags.
- **Paths** follow the repository's rule: a path in a file is relative to that file's folder.
- **No secrets.** The block takes paths only. A `${…}` reference, or a value that is not a path to a file that
  exists, is refused. The secret, the passwords and the dev accounts stay in the environment and `.mistri/dev.json`.
- **Not a second App definition.** It names modules and defines nothing. This keeps the rule that runtime connection
  JSON is configuration.

**B2. One discovery rule for every App command.** The order is `--config`, then `<--app dir>/mistri.json`, then
`./mistri.json` and `./.mistri.json`, then the person's own file. This is dev's rule, used by every command. Without
`--app`, the found file's `app.dir` supplies the App. There is no walking up through parent directories. The order
is fixed and printed.

**B3. Precedence.** A flag beats the profile, and the profile beats the `commands.ts` convention. There is no
environment layer, because the environment is for secrets. When a flag overrides the profile, the run says so:
`policy: ./other.ts (flag, over mistri.json's ./policy.ts)`.

**B4. Showing the effective authority.** Every App command prints the context it resolved in one block, before
anything else:

```
Context: ./mistri.json (beside the App)
  app       .            mistri.json
  commands  commands.ts  beside app.ts
  jobs      jobs.ts      mistri.json
  policy    none         the App has no row policies
```

`check --brief` puts this on one line. `check --json`, `migrate --json` and the build manifest add
`context: { config, app, entries: { commands|jobs|policy: { path, from: 'flag'|'profile'|'convention'|'build' } | null } }`.
A check that runs without jobs on an App whose commands project events says so as an `info` line, which closes
the silent pass in the table above. The authority lock stays the gate. The profile only decides which modules
are loaded, and the lock still refuses a different result.

**B5. Builds.** `mistri build` reads the profile like any other command, and its manifest already records the
bundled entries (`build/build.ts:443-456`). Serving a build defaults to those recorded entries (decision D9), the
same way `stores up` already does for a build (`cli/appTargets.ts:83-89`). A flag must still name the build's own
bundle (`assertBuildEntries`, `cli/apps.ts:34`). The startup line names the entries with `from: build`. The
generated Dockerfile keeps its explicit `CMD` flags, so the image does not depend on them.

**B6. Cloudflare deploys.** `mistri-deploy.json` keeps the keys that belong only to a deploy (`secrets`,
`optionalSecrets`, `backupCheck`, `smoke`). For `app`, `appEntry`, `config`, `commands`, `jobs` and `policy`, it
falls back to the profile, and `deploy init` stops copying them when the profile has them. The deploy plan prints
Part A's phases for the migrate step it already runs.

## Tests that would prove it

- `test/migrate-bootstrap-plan.test.ts` uses the reproduction's App: a command with an event, a job and a fresh
  SQLite file.
  - `status --app` shows migrations and stores `pending`, check `waiting` and `Nothing changed`.
  - `up --app --jobs` applies both phases, the check passes, the run exits 0 and reports
    `Changed: 1 migration, 4 stores`. A second run reports `Nothing changed`.
  - A V2 file with bad SQL: migrations `failed` naming V2, V1 `applied`, stores `waiting`, exit 3.
  - A store ahead of its layout: exit 5, and the migrations show as applied.
  - These fail today: `up` exits 4 and stores are not in the plan.
- `test/check-store-pending.test.ts`: migrations applied with no stores gives exit 8 and `store-pending`, and the
  fix command carries `--jobs`. The same run also reports a `command-and-edit` fault, which fails today because the
  first refusal hides it. Running `check` without `--jobs` on an App with events prints the info line.
- `test/project-profile.test.ts`:
  - A profile with `jobs` and `policy` lets `check --app .` load both, and `--json` shows `from: 'profile'`.
  - A flag overrides the profile and is printed.
  - An unknown key is refused. A `${VAR}` in the block is refused.
  - Paths resolve from the file's folder when the command runs from another directory.
  - `check --app ./scratch` and `dev ./scratch` find the same file from the parent directory. Today `check` finds
    none.
- Build and deploy: serving a build with no entry flags uses its recorded entries, and a foreign `--policy` is
  still refused. Unit tests on `deploy/config.ts` and `plan.ts` cover the profile fallback.
- PostgreSQL, when `TABLEWALK_TEST_PG` is set: the plan's stores and sign-in store phases on PostgreSQL, and
  `up` provisions a `postgres://` `auth.store`.
- Prose:
  - `USAGE`, the package README and the site CLI page name the new exit codes and the `app` block, and
    `test/prose.test.ts` holds the flag lists.
  - `agent-skill.test.ts` covers the skill's loop (step 3 gains `migrate up --app .`). The "pass `--policy` to
    every…" rule becomes "name it once in `mistri.json`".

## Decisions for the user

1. **D1. The plan's home.** Extend `migrate` (`status --app` and `up --app`), or add a new `mistri setup`.
   *Recommend extending migrate.*
2. **D2. Should `migrate up --app` also run the stores step?** `mistri deploy` already does both. *Recommend yes.*
   `migrate stores up` stays for a store-only upgrade. With `--dry-run`, `up` prints the plan.
3. **D3. Seed.** Report only, run by `up`, or run by `up --seed`. *Recommend report only.* Seed rows are
   throwaway data, and a profile that seeds by default would one day seed a real database.
4. **D4. PostgreSQL sign-in store.** Fold `migratePostgresAuthStore` into the stores step when `auth.store` is a
   `postgres://` URL. *Recommend yes.* It is the one bootstrap step that has no CLI today.
5. **D5. `check` on a pending store.** A new exit code 8 and `store-pending`, with validation continuing, or
   exit 4 with better words. *Recommend 8 and continuing.* CI can then tell "run the migrate step" apart from
   "fix the App".
6. **D6. Where the profile lives.** The `app` block in `mistri.json`, a new `mistri.project.json`, a `"mistri"`
   key in `package.json`, or paths named in `defineApp`. *Recommend `mistri.json`*, because it is already found
   and already free of secrets. `package.json` is shared across a monorepo's Apps. Naming the modules in the App
   would make the App choose its own authority, which the "never inferred" rule exists to prevent.
7. **D7. Discovery.** The App's folder, then the working directory, with no walking up. *Recommend this.* Where a
   project has both files, the App's own `mistri.json` now wins for check and serve as well as dev. That is a
   clean break before 1.0, and the context block shows it.
8. **D8. Leaving out an entry the profile names.** `--no-jobs` and `--no-policy`, or another `--config`.
   *Recommend another `--config` for now*, and add the `--no-` flags only when someone asks.
9. **D9. Serving a build.** Default to the build's recorded entries, or keep requiring the flags. *Recommend the
   recorded entries.* The build is the hashed record of the authority someone chose, and `stores up` already
   reads it.
10. **D10. Tenant enrollment.** Does a `policy` named in the profile count as the "explicit `--policy`
    enrollment" a tenant App needs? *Recommend yes.* The file is checked in and reviewed, and every command prints
    it with `from: profile`. Saying no would leave tenant Apps as the one place where the flag must still be
    repeated.
11. **D11. Deploy config.** `mistri-deploy.json` falls back to the profile for the entry keys. *Recommend yes.*

## Size and files

About 26–30 agent-hours, in two commits that each pass review on their own:

- **Part A (13–15 h):**
  - plan model and printer: `engine/src/server/migrate/cli.ts` (a host hook for phases and the new exit codes),
    `mistri/src/server/cli/appTargets.ts` (stores and sign-in phases, `--jobs` and `--commands` on `up`),
    `mistri/src/server/stores/storesCli.ts` (a dry-run "what this App needs"), `stores/declaredStores.ts`;
  - the PostgreSQL sign-in step: `adapters/auth/postgresAuthStore.ts`, called from `storesCli.ts`;
  - check's `store-pending`: `build/check.ts`, `build/checkCodes.ts`, `build/checkProblems.ts`,
    `cli/commandHost.ts` (store attestation reported under `checkApp`), `commands/appCommandEvents.ts`,
    `jobs/` attestation;
  - deploy reuses the plan: `deploy/effects.ts`, `deploy/plan.ts`.
- **Part B (11–13 h):**
  - the profile reader: `engine/src/server/connections.ts` (`loadConfig`, the `app` block),
    `engine/src/server/config/locations.ts` (the shared discovery rule), `engine/src/server/cli/args.ts` (applying
    the profile under flags);
  - folding dev's own rule into the shared one: `mistri/src/server/cli/devMode.ts`;
  - the context block: `build/check.ts`, `cli/serve.ts`, `cli/oneShot.ts`;
  - builds: `cli/apps.ts`, `build/build.ts`;
  - deploy: `deploy/config.ts`, `deploy/init.ts`, `deploy/types.ts`;
  - the scaffold: `scaffold.ts` and `cli/newApp.ts` (write the block, and drop the repeated flags from package
    scripts), `cli/testInit.ts`.
- **Prose and skill (3 h):**
  - `cli/usage.ts`, `packages/mistri/README.md`;
  - site: `cli.md`, `change-your-schema.md`, `build-and-deploy.md` (drop `P=`), `events-and-jobs.md`,
    `commands.md`, `check-codes.md`, `getting-started.md`;
  - `skills/mistri/SKILL.md`;
  - `CHANGELOG.md`.
- **Tests (included above):** the three new files, plus additions to `migrate-app-stores.test.ts`,
  `migrate-row-policy-check.test.ts`, `migrate-built-app-stores.test.ts`, `app-dev-mode.test.ts` and
  `prose.test.ts`.

Not in this note: walking up through parent directories to find the profile, an environment layer, a `mistri setup`
command, and running `tenant init` or `migrate files up` from the plan. Each one waits until someone asks for it.
