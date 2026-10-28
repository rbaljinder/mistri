<img src="mark.svg" alt="mistri" width="48" height="48" />

# mistri

**A few lines of TypeScript. A complete App.** — [mistriwork.dev](https://mistriwork.dev)

The App framework: navigation, record pages, forms, dashboards, commands,
policies, jobs and workflows declared in a typed DSL over a database you
already have — SQLite, PostgreSQL or MySQL — and served from it.

```bash
npm create mistri                               # a starter App, in a directory of its own
npx @mistriwork/mistri dev ./my-app             # serve it with a dev secret and a sign-in per role
npx @mistriwork/mistri check --app ./my-app     # schema types, typecheck and validation
```

It needs Node 24 or newer. Browsing a database with no App is the database
browser's, a package of its own: `npx tablewalk <db>`. The DSL is imported as
`@mistriwork/mistri/app`, `@mistriwork/mistri/commands` and the rest until the names move.

## Build an App

App mode uses a version-controlled TypeScript DSL to define navigation, record
pages, forms, dashboards, actions and themes over the same database runtime.
JSON remains supported as a data-only definition format. Neither requires an
App build to run on the supported Node 24 runtime; TypeScript examples also
have an explicit typecheck (TypeScript 7 or later, the native compiler), and `mistri build` is the optional production
step that runs it, validates the App and bundles it — see
[Build and deploy an App](https://mistriwork.dev/docs/build-and-deploy/).
These App features ship in mistri 1.0.0-rc.2; the
[status page](https://mistriwork.dev/docs/status/) says what is stable
and what comes next. Start with the sample catalog (`examples/apps/README.md`),
written for people and coding agents, then the authoring guide (`docs/authoring.md`).

The reference ships in the package, so it reads offline: `npx @mistriwork/mistri docs`
lists one-screen topics — what an App serves: its declared resources, and
no Workbench (`access-model`), keeping columns and secrets out of the browser (`secrets`),
`relationships`, `dates-and-types`, `reload-and-restart`, `check-codes` — and
`npx @mistriwork/mistri docs <topic>` prints one (`--brief`: its headings and the first sentence under each). `schema/app.d.ts` carries the DSL's
hover docs, and `mistri observe --mcp` offers the same pages to a coding agent as
`mistri://docs/topic/<topic>` resources.

Apps are internal tools and data apps over a database you already have. An
App serves only the resources it declares; the standalone browser
(`npx tablewalk <db>`, no App) is the tool for the tables it does not curate.
Think admin consoles, operations desks, review queues, CRM-style workspaces, where
the schema is the product model and shipping matters more than bespoke UI.
Where a product needs its own design or its own code — a branded public site,
a screen no view draws, a route that is not a command — the App sits inside
it: a free-form page of the App's own, the handler mounted in your server, the
App embedded in your React app ([the general path](https://mistriwork.dev/docs/general-path/)).

What 0.8.1 builds, each shown once on the site:

| | |
|---|---|
| **The DSL** | Resources, views, actions, commands and a look, typed against your own schema: [the DSL in one App](https://mistriwork.dev/docs/dsl-tour/), then [the reference](https://mistriwork.dev/docs/app-dsl/) |
| **Four looks, twelve palettes** | Workshop (the default, in Safety orange), Lumen, Mono and Sage, each offering the same twelve palettes, one structure and type scale, or a look of the App's own: [looks](https://mistriwork.dev/docs/looks/) |
| **Building blocks** | Cards, galleries, facts and sheets, a property rail, a record's sections as tabs, similar lists, a filter bar or a filter rail, boards and calendars you drag in, lists kept in your order: [choose a building block](https://mistriwork.dev/docs/choose/) and the [component tour](https://mistriwork.dev/docs/components/) |
| **Your own components** | Where no built-in fits, a React module of the App's own as a section, a value renderer, a form's input, a list's rows or a whole room, fed by declared, authorized reads, changing data only through the App's commands and drawn with `@mistriwork/mistri/ui` in every look: [custom components](https://mistriwork.dev/docs/custom-components/) |
| **An assistant** | People ask the App about their records, see answers drawn as its own tables and records, and confirm the changes it proposes, under their own grants; Claude via `ANTHROPIC_API_KEY`: [add an assistant](https://mistriwork.dev/docs/assistant/) |
| **The App API** | An App's reads and commands to scoped tokens over HTTP — loopback by default, the network when the App declares `api.network` — and to a coding agent as MCP tools (`--app-mcp`, or `…/$mcp`), rate-limited per token, on SQLite and PostgreSQL, tenant and row-policy Apps included: [the App API](https://mistriwork.dev/docs/app-api/) |
| **Commands** | Declared inputs, a typed `db`, a checked record, `refuse` and output shapes, `lookup` and `effects`: [actions & commands](https://mistriwork.dev/docs/commands/) |
| **Sources and services** | An API as a connection, a shared cache and webhooks; tenant Apps with invitations, events and public intake: [services](https://mistriwork.dev/docs/services/) |
| **Jobs and workflows** | Jobs on events and at times, signed callbacks and durable workflows; flows whose steps are rows that people edit while the App runs: [events & jobs](https://mistriwork.dev/docs/events-and-jobs/) |
| **Shipping** | `mistri build`, an App's first page in 314 KB of script with brotli, PostgreSQL pools sized per connection: [build and deploy](https://mistriwork.dev/docs/build-and-deploy/), [performance](https://mistriwork.dev/docs/performance/) |

Building with a coding agent? Use the [agent build guide](https://mistriwork.dev/docs/build-with-an-agent/)
for a copyable prompt that works from the npm package, the loop and a concrete verification checklist,
and `npx @mistriwork/mistri agent init` to install [the agent skill](https://mistriwork.dev/docs/build-with-an-agent/#the-agent-skill)
that Claude Code, Codex, Cursor and Copilot load on their own.

An App's addresses read as words, one canonical address per thing. A record
is its id under the first view showing its table that the reader is served
(`/leases/12`; a resident's repair `/my-requests/12`, the office's
`/repairs/12`, and a mailed link is the recipient's own), so
following a reference opens the target's own address and Back retraces the
walk; a list is its view's key, and what the reader chose follows as
parameters: `/leases?tab=ending_soon&search=reyes`,
`/listings?bedrooms=2&market_rent=..200000&sort=-market_rent`. The New
form is `/leases/new`, a dashboard `/today?period=last-30-days`;
a natural key (Thread's labels, `/thread/label/bug`) and, on public pages, a slug
(Forecourt's vehicles, `/forecourt/vehicles/1-2024-toyota-corolla-le`) are opt-in. Only a question
those cannot say is written as `q=` its text. The database browser keeps the
query language in its links, and those still open inside an App.

A server serving one App serves it at the root, as above. Serve several and
each keeps its id (`/lintel/leases/12`); `--mount main=/` makes one of them
the main App at the root beside the others, and `--base-path /tools` serves
everything under a reverse proxy's path (`https://host/tools/leases/12`).
`mistri check --routes` prints the addresses as they will be served, and
refuses a main App's route that another App's place would hide.

For independent per-App connections and sign-in on one local listener,
`mistri suite suite.json` provides an initial suite runtime. See
[Local App suites](https://mistriwork.dev/docs/suites/) for configuration and
the currently supported subset.

For an opt-in local performance check, run `npm run test:load:smoke` from the
installed checkout. The [load-testing section](https://mistriwork.dev/docs/performance/#load-testing)
describes concurrent HTTP traffic and real browser journeys against a fresh,
isolated instance of a test fixture App; existing previews and databases are not load targets.

Two TypeScript example projects ship, a small one and a full one:

| Sample | Start here for |
| --- | --- |
| Tick (`examples/apps/tick/README.md`) | A five-minute TODO app: one DSL file with inline types, plus a README. Seed with `node examples/databases/tick/seed.mjs <db>`. |
| Lintel (`examples/apps/lintel/README.md`) | The flagship, property operations in the Lumen look: a staff desk and a resident portal in one App under a row policy, roles that extend roles, a rent ledger posted by a job, a late-fee workflow, repairs whose parts come off a storeroom shelf, a signed payment callback, a public listing with a viewing form, and its own test suite. PostgreSQL or SQLite. |

Both use the shared renderer. Seed fresh disposable databases and follow each
sample's README. Database setup lives separately under
`examples/databases/`. Review queues, status strips and action `when`
conditions are UI curation; server permissions and command checks enforce access
and business rules. Lintel's row policy and `authority.lock` show both.

Two access models exist, both opt-in and both enforced on the server. A **row policy** (`auth.rows: 'policy'` plus
`--policy <file>`) scopes what an authenticated App reads and, on a SQLite or
PostgreSQL source, what it may update, insert, delete and undo; see
row policies and Undo (`docs/authoring.md`). A **tenant
App** (`auth.rows: 'tenant'` plus `--policy <file>`) adds native sign-in,
verified membership and per-tab tenant selection on one provisioned SQLite
file or dedicated PostgreSQL database; see tenant startup (`docs/tenant-apps.md`)
for the supported boundary and what a tenant App still refuses.

## Mail, agents and sign-in

An App's `mistri.json` can name two connections beside its databases:

```json
{
  "connections": [
    { "name": "mail",   "kind": "email", "url": "smtps://smtp.example.com:465",
      "from": "Compass <no-reply@example.com>",
      "auth": { "username": "${SMTP_USER}", "password": "${SMTP_PASSWORD}" } },
    { "name": "agents", "kind": "oauth", "apps": ["compass"], "roles": ["sales"] }
  ]
}
```

`mail` is the
one email service a server sends through — notifications marked `email: true`,
a status check's step-up code, sign-up verification and reset links — over
`smtps://`, `smtp://` with STARTTLS, or `log:` (write each message instead of
sending it, for development). A notice's email is queued with its write and
sent after the commit, with retries; a failed send never fails the write
(`mistri docs email`). `agents` is an OAuth 2.1 authorization server for
the App API: an MCP client registers itself, the person signs in to the App
and picks which of their roles it may act with (at most `roles`; in a tenant
App, which of their tenants too, the token that one membership's), and the
client gets an hour's API token and a rotating refresh token, the grant
ending after 30 days or when the person disconnects it from their profile
([the App API](https://mistriwork.dev/docs/app-api/#oauth-for-agents)).

An App can sign people in itself: `"auth": { "providers": ["email"] }` in
its manifest brings in [Better Auth](https://better-auth.com) — email and
password, GitHub, Google or any OpenID Connect or SAML 2.0 provider (Entra ID,
Okta, ADFS, Keycloak…) with roles from its claims, invite-only, open or just-in-time
sign-up, roles with their own write scope — with sessions in a SQLite file of
mistri's own and the secrets in the environment. `mistri docs
access-sources` has the block and `mistri docs identity-providers` the
providers; it is an optional dependency, installed only by apps that ask.

## Options

```
mistri --app <dir>            serve an App: its pages, commands and jobs (below)
mistri check --app <dir>      types, typecheck and validation of an App (below)
mistri build --app <dir>      make an App ready for production (below)
mistri new [<name>] [<dir>]   a starter App with its own SQLite database: a task
                              list in one app.ts, a schema and rows, for mistri dev
mistri new --brief <BRIEF.md> [<dir>]
                              an App drafted from an approved brief: its schema, database, roles,
                              commands and look (the mistri skill's step 0)
mistri new --template intake [<name>] [<dir>]
                              a public multi-step intake: the stock form over one table,
                              no page or CSS of its own
mistri new --api <name> [<dir>]
                              an App that is only an API: a resource, a command,
                              its event, tokens and MCP; no pages
mistri shot --app <dir>       an App's pages as PNG files, to look at (below)
mistri grade [<app-dir>]      an App's pages measured against the rubric (below)
mistri theme show <look|.>    a theme's every color, recipe, type and shape (below)
mistri schema --brief         the schema as one line per table, for an agent's context
mistri explain <code>         what a check code means, with its fix (below)
mistri messages extract [--app <dir>] [--locale <tag>]
                              an App's words for a translator: a catalog's missing
                              keys appended as comments, or its literal captions
mistri migrate <command>      change the schema with versioned SQL files (below)
mistri seed [--app <dir>]     believable rows in an App's writable database (below)
mistri dev [<app-dir>]        serve an App with a dev secret and a sign-in per role (below)
mistri test init [<app-dir>]
                              a starter suite: a journey per role, a permissions matrix (below)
mistri flows start <resource>
                              start a resource's flows on records already there (below)
mistri jobs run <name>        run one of an App's jobs at times now, once (below)
mistri decide eval <name>     measure a decision on settled records, and pin its model (below)
mistri tenant init|grant      a tenant App's first boot: its realms, tenants and first operators (below)
mistri tenant clone|import|clock
                              a tenant App's sandboxes: clone, import plan, dev clock (below)
mistri docs [topic]           the App reference, offline (below)
mistri agent init             put the agent skill where coding agents read it (below)
mistri mail-dns [<config>]    the SPF, DKIM and DMARC records tenant mail is sent under
  -d, --db <target>           the App's database: a SQLite path or a URL (or set DATABASE_URL,
                              used when no config names connections)
  -p, --port <n>              default 4111
      --schema <name>         Postgres only; repeatable. Defaults to all user schemas.
      --read-pool <n>         PostgreSQL connections that may read at once, per
                              database (default 4; an App's follows its writers, at most 64); a connection's
                              "pool": { "read": n } wins. Or set
                              MISTRI_READ_POOL
      --write-pool <n>        connections an App may write through at once,
                              per PostgreSQL or MySQL database (default twice the cores, 4 to 16; at most 64; the database browser always writes
                              through one); a connection's "pool": { "write":
                              n } wins. Or set MISTRI_WRITE_POOL
      --lock-timeout <s>      seconds a write waits for a row or table another
                              transaction holds before it is refused (default
                              5, 0.1 to 30). Or set MISTRI_LOCK_TIMEOUT
      --pooler <mode>         session (default: direct, or a pooler that keeps
                              a client on one server connection) or transaction
                              (PgBouncer in transaction mode, RDS Proxy): the
                              read-only guard and statement cap are then set
                              per transaction. Or set MISTRI_POOLER
      --drain-delay <s>       seconds /readyz answers 503 before the listener
                              closes on SIGTERM, so a balancer that probes
                              takes this instance out first (default 0, up to
                              120). Or set MISTRI_DRAIN_DELAY
      --shutdown-grace <s>    seconds a response still unfinished after the
                              drain may keep the process before it is cut
                              (default 10, 1 to 300); hold both inside the
                              platform's stop timeout. Or set
                              MISTRI_SHUTDOWN_GRACE
      --host <addr>           interface to bind (default 127.0.0.1)
      --allowed-host <name>   also answer for this Host header; repeatable
      --trust-proxy <address|CIDR>
                              a proxy whose X-Forwarded-For the public forms'
                              rate limit may believe (10.0.0.0/8, 172.17.0.1,
                              fd00::/8); repeatable or comma-separated, or set
                              MISTRI_TRUST_PROXY. Loopback is always trusted.
                              Rate limiting only, never sign-in
      --trust-proxy-hops <n>  behind a managed front end with no address to name
                              (Cloud Run, a cloud load balancer): how many
                              proxies append to X-Forwarded-For; the client is
                              the address n places from the right. Or set
                              MISTRI_TRUST_PROXY_HOPS
      --trust-proxy-cloudflare
                              read CF-Connecting-IP as the client; only when the
                              server is reachable through Cloudflare alone; not
                              with --trust-proxy-hops. Or set
                              MISTRI_TRUST_PROXY_CLOUDFLARE=1
      --auth-proxy-header <name>
                              behind a proxy that signs people in: the header
                              it sets with the user (X-Forwarded-User). Requests
                              from beyond loopback must carry it, and every
                              write is journaled with it
      --config <path>         read connections from this file, and the
                              cache, search, webhook, email (smtps://,
                              smtp:// or log:) and OAuth services beside
                              them; the paths in it are relative to its folder
      --no-config             ignore any config file
      --no-live               turn live sync off, even for an App that asks
                              for it (live: true): its open pages then
                              refresh on focus and after their own saves.
                              Nothing is written to the change store and
                              /api/live answers 204
      --app <dir>             serve an app: a directory whose app.ts (or
                              app.mjs / app.json) declares its resources,
                              views, navigation and pages. Repeatable; with
                              more than one, every app names its connection.
                              A config file can say the same with
                              "apps": [dir | { "dir", "env" }, …]; "env" lists
                              the variables the App's definition may read, and
                              it reads no others. A save reloads the App; a
                              change to its grants, sources or sign-in needs a
                              restart (mistri docs reload-and-restart).
                              One App is served at the root (/leases/12);
                              several each under its id (/lintel/leases/12)
      --mount <app>=<path>    where an App is served, over that default: /
                              makes it the main App at the root, /billing
                              puts it there. Repeatable, one per App. Or
                              "mount": { "<app>": "/" } in the config
      --base-path <path>      the path a reverse proxy serves this server
                              under, like /tools: every address, asset, API
                              call, cookie and link carries it. Or "basePath"
                              in the config, or set MISTRI_BASE_PATH
      --app-entry <file>      with one --app: the manifest to read, when it is
                              not the directory's own app.ts. The directory
                              stays the App's root: components, pages/,
                              features/ and authority.lock
      --commands <file>       the server-only default defineCommands registry of
                              one explicit --app, when it is not the
                              commands.ts beside its manifest (read without
                              the flag); authenticated access and a migrated
                              writable SQLite or PostgreSQL command source
                              required. Restart the server to reload commands.
      --jobs <file>           load a server-only default defineJobs module with
                              one --app and its commands: jobs that run a
                              command, as a declared principal, when a
                              committed event says so or at the times they
                              say (every). Stores provisioned once from
                              @mistriwork/mistri/maintenance; restart to reload.
      --policy <file>         load a server-only row or tenant policy for one authenticated,
                              named-source --app whose auth.rows is "policy" or "tenant".
                              Tenant Apps require one existing provisioned SQLite or
                              PostgreSQL source.
                              Row policies support reads and
                              explicit commands and scoped creation/updates with Undo.
                              Delete/restore requires an explicit deleted-record policy.
                              App and policy changes require a restart.
      --from-openapi <spec>   draft an HTTP connection's description from an
                              OpenAPI 3.0 or 3.1 JSON spec (a file or URL),
                              print it, and exit; guesses and skipped
                              operations go to stderr
      --openapi <spec>        serve an API straight from its OpenAPI spec (a
                              file or URL): the description is drafted in
                              memory and the base URL is the spec's server
      --api-url <url>         with --openapi: the API's base URL, when the
                              spec's servers do not give a usable one
      --api-token-env <name>  with --openapi: send $name as a bearer token
      --scaffold-app <dir>    draft an App project for the active connection
                              in helper-built TypeScript — list views, display
                              rules, an Overview, record pages, schema types,
                              tsconfig.json, an .oxfmtrc.json, a mistri.json
                              naming a SQLite file by a path from the App, and
                              (outside a checkout) package.json with format
                              scripts — that passes mistri
                              check as written, and exit. A start to curate.
                              With --config naming several connections, one
                              App with a source per connection; a PostgreSQL
                              or MySQL one holding several schemas is a source
                              per schema on that one connection.
      --name <name>           with --scaffold-app: the App's name, instead of
                              one read off the database file's
      mistri check             with --app: validate the app against its
                              connection, print every problem, and exit
                              non-zero if any. For CI. An app with an
                              authority.lock also fails when what it
                              grants differs from the lock.
      --write-authority       with mistri check: write each app's
                              authority.lock (what it grants, one fact per
                              line, and each command's contract) to commit
                              beside it. The server refuses to start an app
                              whose authority differs from its lock, and a
                              reload that changes it.
      --bump <command>        with mistri check: move the command's contract
                              to its next version in authority.lock, when it
                              changed and the App API, a job or kept
                              receipts depend on it
      --reindex [resource]    with --app and a search provider plugged in
                              (a pack, after 1.0): read every searched
                              resource (or the one named) from the
                              database into its search index, then exit
      --demo                  build a throwaway sample database and open it
      --open                  open a browser once the server is up
      --dev                   serve the dev observer at /_mistri/observe
                              (loopback only, in memory, credentials masked)
                              and, with an App, the theme bench at /_theme
      --mcp                   speak MCP on stdio instead of serving HTTP
                              (the database browser's tools; no App)
      --export <fmt>          print the schema as md, mermaid, json, brief or types
                              (a .d.ts of this connection's names for the app
                              DSL), then exit; openapi exports one App's API
                              document, enabling no API routes;
                              asyncapi its AsyncAPI 3 document (feed events,
                              webhooks, and inbound endpoints with --jobs)
      --api-integers <kind>   required with --export openapi or asyncapi,
                              --api-reads or
                              --app-mcp: decimal-string or number; no default
                              integer wire representation
      --api-reads             serve one authenticated App's API and its MCP
                              (…/$mcp): its reads, and with --commands the
                              targeted commands it exposes; requires integer
                              choice, rate budget and native readiness;
                              SQLite or PostgreSQL; on loopback, or beyond it
                              only for an App whose api declares network: true;
                              a tenant App under its --policy, each token
                              bound to one membership; a row-policy App under
                              its --policy, each token reading its own
                              account's rows; a "kind": "oauth" entry lets a
                              signed-in person give an agent a token
      --api-requests-per-minute <count>
                              explicit --api-reads rate budget per token,
                              1–1000000, counted in this process
      --app-mcp               speak one authenticated App's API as MCP tools on
                              stdio, instead of serving HTTP: its
                              reads, and with --commands the targeted commands
                              it exposes. The token comes from
                              MISTRI_API_TOKEN, never the command line;
                              requires --api-integers; SQLite or PostgreSQL;
                              a tenant or row-policy App under its --policy
      --diff <conn>           compare shapes with this connection, then exit
  -h, --help                  print the short help and stop; --help all, this
  -v, --version               print the version and stop

mistri compare-openapi <previous.json> <current.json>
                              compare two exported App API documents; JSON
                              report, no server or database. Exit 0: version
                              requirement met; 1: unmet or version decreased;
                              2: invalid input. Not a general compatibility proof.
                              Requires no-follow/nonblocking file-open support;
                              Windows comparison is not supported yet.

mistri check --app <dir> [--app-entry <file>]
                [<db> | --db <target> | --config <path>]
                [--commands <file>] [--jobs <file>] [--policy <file>] [--bump <command>]
                [--routes [--mount <app>=<path>] [--base-path <path>]]
                [--design] [--fix] [--defaults] [--fail-on-design-warning] [--warnings]
                [--pending [--pending-on <url>] [--migrations <dir>] [--history-table <name>]]
                [--deploy [--replicas <n>]] [--json | --brief]
                              the authoring loop in one command: regenerate the
                              App's mistri-schema.d.ts when the database
                              has changed, its mistri-commands.d.ts from
                              its commands module and its mistri-components.d.ts
                              (a props type for each custom component, from its
                              declaration), typecheck it (file:line, the
                              mismatch, a hint) and validate it. Every
                              step runs; the errors print first, and warnings are advisory (unless --fail-on-design-warning is set) and print as one line a kind unless --warnings lists them in full. --routes also
                              prints every address the App answers to, as the
                              --mount and --base-path given would serve it, and
                              fails on a route another App's place would hide;
                              --design warns where a page, form or the shell
                              will come out basic, with the fix (mistri
                              docs design), and with --fix deletes the rules a
                              restated warning names; --fix also writes into
                              an App theme's source each color or chart order
                              its failures say passes; --defaults prints what
                              each column is drawn by and each page's layout;
                              --pending judges
                              the App against a scratch copy of the database
                              with the pending migrations applied (SQLite: a
                              copy of the file; PostgreSQL: CREATE DATABASE
                              … TEMPLATE); --pending-on <url> applies them
                              to the scratch database that URL names instead
                              (a branch of the real one; no CREATEDB needed);
                              --deploy judges whether the App
                              survives a replaced container (no SQLite
                              source or auth.store, BETTER_AUTH_SECRET set;
                              --replicas <n> warns of per-process rate
                              limits); --json prints one JSON document of
                              every finding (code, file, line, path, fix) for
                              an agent, or --brief one line per problem
                              (code file:line message — fix: …). Exit 1 could not check, 2 schema
                              types, 3 typecheck, 4 validation, 5 components,
                              6 a pending migration failed on the copy, 7 --deploy refused
                              (mistri docs check-codes)

mistri schema --brief [<db> | --db <target> | --config <path>]
                              the schema as one line per table (columns with
                              short types, vocabularies, foreign keys), for an
                              agent's context; the same as --export brief
mistri explain <check-code>
                              one screen on a code check prints: what it
                              means and the fix, from the check-codes page;
                              an unknown code lists the nearest

mistri migrate new <name> [--repeatable]
mistri migrate status | up | validate | baseline | repair
mistri migrate diff <name> | check | squash
                [--app <dir>] [<db> | --db <target> | --config <path>]
                [--connection <name>] [--schema <name>] [--migrations <dir>]
                [--history-table <name>] [--dry-run] [--tool flyway]
                [--schema-file <path>] [--dev-url <url>]
                              versioned SQL files in Flyway's format, forward
                              only: V3__add_payoff_quote.sql once, in its own
                              transaction (MySQL: none; a failure stops the
                              run); R__views.sql again when it changes. up
                              applies what is pending, then with --app
                              regenerates the App's types and runs check;
                              status shows applied, pending, drift made
                              outside migrations and types older than the
                              database; validate fails on any of those;
                              baseline records an existing database as
                              version 0 and writes baseline.schema.json;
                              repair fixes the history. A lock keeps two
                              deploys apart. Exit 1 could not run, 2 files
                              and history disagree, 3 a migration failed,
                              4 applied but the App no longer checks.
                              diff writes the next V file from schema.sql
                              (beside the migrations): what they still lack,
                              for review; check exits 2 when the migrations
                              do not build schema.sql; squash folds the V
                              files into V1__baseline.sql. Atlas community,
                              pinned by sha256, fetched once into
                              .mistri/bin (MISTRI_ATLAS: your own)

mistri migrate stores status | up
                [--suite <suite.json>] [--app <dir> [--jobs <file>] [--policy <file>]]
                [<db> | --db <target> | --config <path>] [--connection <name>]
The layouts mistri keeps in a database of its own (auth, tokens, history,
inbox, command journal and sequences, tenant stores, flags, experiments, analytics)
move forward only here: serving never migrates, and refuses a store behind
its layout with this command in the message. status prints one line per
store; up applies each pending step in its own transaction (PostgreSQL: under
an advisory lock) and is safe to run twice. --suite adds the suite's identity,
grant, preference, flag and experiment stores and each App's connections.
With --app, up also creates every store the App uses: the inbox its notify
rules write, the record history it shows, the command journal and event
store its commands need, their effects' store; --jobs <file> adds the jobs
module's stores and delivery destinations. The one step before it serves.
A tenant App's stores are bound to its policy: with --policy <file>, up
also makes the tenant store and the journals the policy declares.
--app may name a build (mistri build): its own bundled commands and jobs
are read, and a --jobs or --commands must name the build's own.
Exit codes: 1 could not run, 2 a store refused, 3 a step failed.

mistri migrate files status | up | sweep --app <dir>
                [<db> | --db <target> | --config <path>] [--connection <name>]
                [--policy <file>] [--dry-run]
An App's files move to where each resource's storage says: up copies each
database-kept file to the bucket and then empties its content, or back; a
file is read from wherever its row says throughout, so up can stop and run
again anywhere. sweep deletes the bucket's objects no row names (a deleted
record's, an upload whose row was refused) that are older than an hour. status
counts both sides; --dry-run says what up or sweep would do. A tenant App
names its --policy. Credentials come from MISTRI_S3_ACCESS_KEY_ID and
MISTRI_S3_SECRET_ACCESS_KEY, else from an ECS task role or (with
MISTRI_S3_INSTANCE_ROLE=1) an EC2 instance role; a server whose App names a
bucket does not start without them. Served with --jobs, an App is swept daily by the
server itself (a tenant App tenant by tenant); otherwise run sweep daily
from cron.
Exit codes: 1 could not run, 3 some files did not move.

mistri flows start <resource> --app <dir> --jobs <file>
                [--where <query>] [--flow <id>] [--tenant <id> --policy <file>]
                [--dry-run] [<db> | --db <target> | --config <path>]
Start a resource's created flows on the records already there, as though
each had just been created: one keyed dispatch per record, in the App's job
store, which the server started with --jobs runs. Each flow's condition
still decides. --where narrows the records (the query language over their
own columns), --flow to one flow; a tenant App runs one --tenant at a time,
whose owner column its --policy names. Running it again starts nothing new.
Exit codes: 1 could not run.

mistri jobs run <name> --app <dir> --jobs <file> [--wait <seconds>]
                [<db> | --db <target> | --config <path>]
Enqueues one run of the job in the App's job store, marked manual beside
the slots the schedule enqueues, for the server started with --jobs to run
as the job's principal, journaled as a slot's run is; waits --wait seconds
(default 60; 0 returns at once) and says how it ended. A job at times runs
one at a time: a manual run waits while the schedule's run of the job holds
its lease. A name that is not one of the App's jobs at times is refused with
the names that are. A job store with no run of a job yet starts at its next
slot: a first start never runs a missed one.
Exit codes: 1 could not run, 2 still waiting when --wait ran out, 3 the run
did not succeed.

mistri decide eval <decision> --app <dir> --jobs <file> [--provider jev|anthropic]
                [--limit <n>] [--truth "<query>"] [--max-cost <dollars>] [--max-error <share>]
                [--dry] [--yes] [--pin] [--json <file>] [--policy <file>] [<db> | --db <target> | --config <path>]
Asks a provider about records whose answer people settled (--truth narrows
them; default every record with the field set, at most --limit, 500) and
reports accuracy, Brier, calibration error, a reliability table and what the
declared thresholds would have applied, suggested and left. The records are
read as the decision reads them, put back as they were before the answer was
settled where the App keeps their history. It prints the count and a price
that errs high first, and asks nothing without --yes or above --max-cost
(default $5); --dry prints what one record would send. It writes nothing to
the database and never applies; --pin writes the model version into
decisions.lock, which is what lets a decision apply, only when the share it
would apply was wrong at most --max-error of the time (default 0.02).
Exit codes: 1 could not run, 2 not spent (no --yes, or over --max-cost),
3 --pin asked and not earned. A row-policy App names its policy with
--policy, and the records are read as its service reads them when served.

mistri tenant init [<tenant>...] --app <dir> --policy <file>
mistri tenant grant <email> --roles <role,...> [--tenant <id>] [--name <name>] [--days <n>]
                --app <dir> --policy <file> [--operator <name>] [<db> | --db <target> | --config <path>]
A tenant App's first boot, after `mistri migrate stores up --policy`, from
a shell or a deployment's one-off job. init opens the platform realm (when the App declares one) and puts each named
tenant, active; one already there is left as it is, so it runs again after a
stop part-way. grant grants <email> a membership of the platform realm, or
with --tenant of that tenant, with that realm's --roles, for --days (default
180, at most 366). An address with no account gets one in the App's auth
store, its password read from MISTRI_ACCOUNT_PASSWORD, never the command
line. Exit codes: 1 could not run.

mistri tenant clone <source> <sandbox> --app <dir> --policy <file> [--samples]
mistri tenant import <sandbox> --app <dir> --policy <file>
mistri tenant clock <sandbox> --app <dir> --policy <file> --ahead <duration> [--rate <n>]
                [--operator <name>] [--commands <file>] [<db> | --db <target> | --config <path>]
A tenant App's sandboxes: a copy of a tenant to try changes in. clone makes
a new sandbox tenant from a copy of the source's rows of every resource the
App marks clone: 'config' (and 'sample' with --samples), its ids rewritten so
the copy names only its own rows. import prints what importing the sandbox
into its source would change and what conflicts; the source's owner approves
it in Manage tenants. clock sets a sandbox's dev clock, --ahead of real time
and --rate times as fast, which its machine timers fall due on; a live tenant
has none. --operator names who ran it on the receipt (default: your login).
Exit codes: 1 could not run.
      --migrations <dir>      with migrate: where the files are (default
                              migrations/ in the App, or the connection's
                              "migrations": { "dir": … })
      --history-table <name>  with migrate: the history table (default
                              __mistri_schema_history, Flyway's layout;
                              flyway_schema_history to take over from Flyway)
      --connection <name>     with migrate: which configured connection
      --dry-run               with migrate up, baseline or repair: print what
                              would run and change nothing
      --tool flyway           with migrate: run it with an installed Flyway
                              (PATH or MISTRI_FLYWAY), same files and history
      --schema-file <path>    with migrate diff, check or squash: the schema
                              you want (default schema.sql beside the
                              migrations directory)
      --dev-url <url>         with migrate diff, check or squash on
                              PostgreSQL: where two scratch databases are made
                              and dropped (default the connection's server)
      --repeatable            with migrate new: an R__ file

mistri shot --app <dir> [<route>…] [<db> | --db <target> | --config <path>]
                [--theme <id|all>] [--palette <id>]
                [--compare <look>] [--recipes <part>] [--dark | --light] [--phone | --desk | --both]
                [--click <name>] [--type <field> <text>] [--press <key>] [--wait-for <text>] [--matrix]
                [--width <px>] [--full] [--scale <1-3>] [--as <role|email> [--tenant <id>]]
                [--out <dir>] [--text]
                              serve the App on a free port with a temporary
                              config directory and write a PNG of each route
                              (with none, every view and page it declares);
                              prints each file's path. Needs Playwright's
                              Chromium. Exit 1 could not shoot, 2 a page threw
      --theme <id|all>        with shot or grade: a built-in look (workshop,
                              lumen, mono, sage) or one of the App's own themes instead of
                              the one it wears; with shot, all: every look,
                              then the App's. The menu stands where that
                              theme suggests (shell.placement) unless the
                              App's ui.shell says, which a note says
      --palette <id>          with shot or grade: one of that theme's palettes
      --compare <look>        with shot: the App's theme (or --theme) beside
                              that look, one picture of the two,
                              <page>-<mode>.png, the look left
      --recipes <part>        with shot: one page in each value of that recipe
                              part, one contact sheet,
                              <part>-<page>-<mode>.png; a note
                              names values that draw the page nearly alike
      --dark, --light         with shot: the scheme a reader picked, worn as if
                              chosen in the page's menu (without either, the
                              machine's, light)
      --click <name>          with shot: before the picture, press the button,
                              link, tab, menu item or option with that
                              accessible name, else the visible text;
                              css:<selector> names an element by selector
      --type <field> <text>   with shot: type into the box with that label or
                              placeholder (css:<selector> likewise)
      --press <key>           with shot: press a key (Enter, Escape, ArrowDown)
      --wait-for <text>       with shot: wait until that text is visible. The
                              four run in the order given, on every route; the
                              page is settled before the first and after each,
                              and a step that matches nothing in 15 seconds is
                              refused with the step and the address
      --matrix                with shot: every built-in look and the App's own,
                              light and dark, at a desk and on a phone, for the routes, as
                              <page>-<look>-<mode>-<size>.png
                              and an index.html; takes no --theme, --palette,
                              --dark, --light or size flag
      --phone, --desk, --both with shot: 390 wide, 1280 (default), or both
      --width <px>            with shot: the window's width instead (320 to
                              2560), with --desk or --phone
      --full                  with shot: the whole page, not the window
      --scale <1-3>           with shot: device pixels per CSS pixel (default 1;
                              2 is sharp); the page lays out the same
      --as <role>             with shot or grade: signed in as the earliest
                              account of that role in the App's local store,
                              in a copy of it, else a fresh one (no rows)
      --as <email>            with shot or grade: signed in as that account,
                              already made (mistri dev or a local start),
                              with the password in MISTRI_AS_PASSWORD; its
                              store is copied, never written
      --tenant <id>           with shot --as on a tenant App: the tenant the
                              role is held in, a temporary membership in the
                              App's tenant store (journaled), revoked when the
                              shot ends; a platform role needs none
      --out <dir>             with shot: where every file goes, from the current
                              directory (default mistri-shots/<app> in the
                              temporary directory, where --compare, --recipes
                              and --matrix write to compare/, recipes/, matrix/)
      --text                  with shot: print what each page shows (title,
                              headings, table columns and row count, actions,
                              empty states, page errors) as compact text, not
                              PNG files
      --browser <path>        with shot: a Chromium or Chrome to shoot with
                              (default: CHROME, else Playwright's own, the
                              machine's Chrome, then any installed Chromium)

mistri seed [--app <dir>] [<db> | --db <target> | --config <path>]
                [--connection <name>] [--rows <n>] [--seed <n>] [--append]
                              fill the App's writable database with rows to
                              look at, parents first: vocabularies, keys, NOT
                              NULL and unique hold; each status spread the way
                              its machine moves, with matching stamps; dates
                              over the last 90 days, some work due today or
                              overdue. Exit 1 could not run, 2 refused
      --rows <n>              with seed: rows per main table (default 40)
      --seed <n>              with seed: the same rows again, on the same day
      --append                with seed: add to tables that already hold rows

mistri grade [<app-dir>] [<db> | --db <target> | --config <path>] [<route>…]
                [--as <role|email|all> [--tenant <id>]] [--theme <id|all> [--palette <id|all>]]
                [--json] [--browser <path>]
                              serve the App as shot does and measure every view
                              and a record of each page at 1280, 390 and 320
                              wide and at 390 dark: sideways scroll, cut
                              figures and words, overlapping controls, targets
                              under 40px on a phone, contrast, layout shift,
                              page errors and failed requests, empty sections,
                              mixed number formats, unround chart ticks, a
                              record's name past two lines. One line per
                              finding with its fix, then a score. Signed in
                              as the role that reads the most unless --as
                              names one. --theme all, --palette all and
                              --as all grade every look, palette and role
                              as one table, each finding with its theme
                              contract promise (C1 to C13). Exit 1 could not
                              grade, 2 an error-level finding
      --json                  with grade: one JSON document of the findings

mistri theme show <look|theme-id|.> [--app <dir>] [--diff <look>] [--json]
                              a built-in look, or a theme of the App in --app
                              (else here; . is the one it wears): every color
                              in light and dark and each palette's changes,
                              every recipe, the type and the shape, each value
                              it inherits marked with where from
      --diff <look>           with theme show: only what differs from that
                              look or theme
      --json                  with theme show: one JSON document

mistri build --app <dir> [--app-entry <file>] [--out <dir>]
                [--config <path>] [--commands <file>] [--jobs <file>]
                [--policy <file>] [--dockerfile <file>]
                              typecheck, validate and bundle an App for
                              production (optional; an App also runs from its
                              source). With --config reaching the database,
                              also write its types and validate it on the
                              build. Exit 1 could not build, 2 typecheck,
                              3 validation, 4 bundle
      --out <dir>             with build: where the build goes, from the
                              current directory (default build/<dir name> in
                              the current directory, or <dir name>-build
                              beside an App built from its own directory); replaced
                              whole on success, refused unless new, empty
                              or an earlier build
      --dockerfile <file>     with build: build nothing, write the Dockerfile
                              that builds this App in a build stage and serves
                              it (tini, uid 1000, PORT, a /healthz health
                              check); run docker build from the project root

mistri docs [topic]           the reference the package ships: with no topic,
                              the topics (start, access-model, secrets,
                              relationships, dates-and-types, …) and every
                              other page; with one, that page
      --search <words>        with docs: every line of the shipped pages that
                              says them

mistri agent init [--dir <project>] [--tool claude|codex|cursor|copilot|all] [--force]
                              copy the App skill into the project
                              (.claude/skills/mistri for Claude Code,
                              .agents/skills/mistri for Codex, Cursor and
                              Copilot) and point at it from AGENTS.md; a copy
                              the project changed is left alone (exit 1)
      --dir <project>         with agent init: where (default: here)
      --tool <name>           with agent init: which agents; default all
      --force                 with agent init: replace a changed copy

mistri dev [<app-dir>]        serve the App as --app <dir> --dev does, with a
                              throwaway session secret and an account per
                              declared role, each sign-in printed; kept in
                              <app-dir>/.mistri/, local and dev only
                              (refused under NODE_ENV=production); with
                              auth.me, each account is one of its rows

mistri test init [<app-dir>] [--config <path>] [--force]
                              write tests/ into the App on @mistriwork/mistri/testing:
                              a journey per role and a permissions matrix from
                              authority.lock, for Node's test runner
      --config <path>         with test init: the mistri.json its database is copied from
      --force                 with test init: write over the suite's files

mistri observe [--mcp] [--url <base>]
                              the running --dev server's observer: print its
                              address, or with --mcp speak its telemetry to a
                              coding agent on stdio (check, which runs
                              mistri check --json and needs no server,
                              recent_errors, list_traces, get_trace, search_logs,
                              slow_queries, n_plus_one, explain_access,
                              page_vitals, tail)
      --url <base>            with observe: the dev server (default: the one
                              this machine started most recently)
```

A path typed on the command line (`--app`, `--config`, `--out`, a suite file)
is relative to the current directory; a path written in a file
(`mistri.json`, `suite.json`) is relative to that file's folder. Every
command reads a file's paths that way — serve, check, build, shot, grade,
migrate, seed, a suite and a test host — so a connection's `"url": "./shop.db"`
is the file beside the config wherever the command runs. A value from the
environment (`"${DATABASE_URL}"`) is read as given, from the current directory.

An option it does not recognize is an error, not a shrug: `mistri --prot
4111` says so rather than quietly serving the default port.

## License

MIT.
