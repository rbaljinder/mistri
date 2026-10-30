/**
 * The `mistri` command line in words: `USAGE`, every command and flag of the App framework, and `SHORT_USAGE`, the
 * first screen of it. The database browser's are `tablewalk`'s own (packages/tablewalk/src/server/cli/usage.ts).
 * test/prose.test.ts holds this USAGE and the package's README (packages/mistri/README.md) to each other, and
 * scripts/cli-reference.mjs writes the site's CLI page from both.
 */
import { commandWordsOf, flagWordsOf } from '@mistriwork/engine/server/cli/usage.js';
import type { Product } from '@mistriwork/engine/server/cli/startup.js';

export const USAGE = `
mistri — the App framework: a few lines of TypeScript, a complete App
over your own database.

  mistri --app <dir>              serve an App (see --app below)
  mistri check --app <dir>        types, typecheck and validation of an App (see below)
  mistri build --app <dir>        make an App ready for production (see below)
  mistri new [<name>] [<dir>]     a starter App with its own SQLite database: a task
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
  mistri suite <suite.json>       serve a local suite with per-App configuration; its
                                  paths are relative to the suite file's folder
  mistri virtual <service.ts>     run a typed virtual HTTP service for tests
  mistri flags --help             explicit flag control-store provisioning
  mistri experiments --help       explicit experiment evidence-store provisioning
  mistri analytics --help         behavior-analytics store provisioning and funnels
  mistri shot --app <dir> [<route>…]
                                  an App's pages as PNG files, to look at (see below)
  mistri grade [<app-dir>]        an App's pages measured against the rubric (see below)
  mistri theme show <look|.>      a theme's every color, recipe, type and shape after
                                  extends, inherited values marked (see below)
  mistri schema --brief [<db>]    the schema as one line per table, for an agent's context
  mistri explain <check-code>     what a check code means, with a fix example
  mistri messages extract [--app <dir>] [--locale <tag>]
                                  an App's words for a translator: a catalog's missing
                                  keys appended as comments, or its literal captions
  mistri migrate <command>        change the schema with versioned SQL files (see below)
  mistri seed [--app <dir>]       believable rows in an App's writable database (see below)
  mistri dev [<app-dir>]          serve an App with a dev secret and a sign-in per role (see below)
  mistri test init [<app-dir>]    a starter suite: a journey per role, a permissions matrix (see below)
  mistri flows start <resource>
                                  start a resource's flows on records already there (see below)
  mistri jobs run <name>          run one of an App's jobs at times now, once (see below)
  mistri decide eval <name>       measure a decision on settled records, and pin its model (see below)
  mistri tenant init|grant        a tenant App's first boot: its realms, tenants and first operators (see below)
  mistri tenant clone|import|clock
                                  a tenant App's sandboxes: clone, import plan, dev clock (see below)
  mistri deploy [init cloudflare|status|verify|rollback|logs]
                                  an App on Cloudflare Containers (see below)
  mistri docs [topic]             the App reference, offline: access, relationships,
                                  dates, dashboards, reload and restart, …
  mistri agent init               put the agent skill where coding agents read it (see below)
  mistri compare-openapi <previous.json> <current.json>
                                  compare two exported App API documents; no server
  mistri api-token --help         local token-store maintenance; no server
  mistri mail-dns [<config.json>]
                                  the SPF, DKIM and DMARC records a tenant App's mail
                                  is sent under; makes the DKIM key if it is missing

Paths: one typed on the command line (--app, --config, --out, <suite.json>, …)
is relative to the current directory; one written in a file (mistri.json,
suite.json) is relative to that file's folder. Every command reads a file's
paths that way, a SQLite url among them; a value from the environment
("\${DATABASE_URL}") is read as given, from the current directory.

Options:
  -d, --db <target>   SQLite file path or postgres:// URL (or set DATABASE_URL,
                      used when no config names connections)
  -p, --port <n>      Port to listen on (default 4111)
      --host <addr>   Interface to bind (default 127.0.0.1, loopback only)
      --allowed-host <name>
                      Also answer for this Host header; repeatable.
                      Needed behind a proxy or in a container reached by name.
                      Or set MISTRI_ALLOWED_HOSTS=a.example,b.example
      --trust-proxy <address|CIDR>
                      A proxy whose X-Forwarded-For the public forms' rate
                      limit may believe: 10.0.0.0/8, 172.17.0.1, fd00::/8.
                      Repeatable or comma-separated; loopback is always
                      trusted. Also who may set --auth-proxy-header. Or set
                      MISTRI_TRUST_PROXY=10.0.0.0/8,fd00::/8
      --trust-proxy-hops <n>
                      Behind a managed front end with no address to name
                      (Cloud Run, a cloud load balancer): how many proxies
                      append to X-Forwarded-For. The client is the address
                      n places from the right; anything the visitor wrote
                      left of it is ignored. Rate limiting only. Or set
                      MISTRI_TRUST_PROXY_HOPS=1
      --trust-proxy-cloudflare
                      Read CF-Connecting-IP as the client. Only when the
                      server is reachable through Cloudflare alone (a tunnel
                      or its address ranges): anyone else can write the
                      header. Not with --trust-proxy-hops. Or set
                      MISTRI_TRUST_PROXY_CLOUDFLARE=1
      --insecure-http-sign-in
                      Serve sign-in at an http address beyond this machine,
                      which is otherwise refused: passwords would cross the
                      network in the clear. Prefer MISTRI_PUBLIC_URL set to
                      the https address of a TLS proxy. Or set
                      MISTRI_INSECURE_HTTP_SIGN_IN=1
      --auth-proxy-header <name>
                      Behind a proxy that signs people in: the header it sets
                      with the user (X-Forwarded-User). Requests from beyond
                      loopback must carry it and come from a --trust-proxy
                      address; every write is journaled with it. Or set
                      MISTRI_AUTH_PROXY_HEADER.
      --schema <name> Postgres only; repeatable. Defaults to all user schemas.
      --read-pool <n> PostgreSQL connections that may read at once, per
                      database (default 4; an App's follows its writers, at most 64). A connection's
                      "pool": { "read": n } in mistri.json wins.
                      Or set MISTRI_READ_POOL.
      --write-pool <n>
                      Connections an App may write through at once, per
                      PostgreSQL database (default twice the cores, 4 to 16; at most 64).
                      A connection's "pool": { "write": n } wins.
                      Or set MISTRI_WRITE_POOL.
      --lock-timeout <s>
                      Seconds a write waits for a row or table another
                      transaction holds before it is refused (default 5,
                      0.1 to 30). Or set MISTRI_LOCK_TIMEOUT.
      --pooler <mode> session (the default): PostgreSQL is reached directly,
                      or through a pooler that keeps a client on one server
                      connection. transaction: through PgBouncer in
                      transaction mode or RDS Proxy; the read-only guard and
                      the statement cap are then set per transaction.
                      Or set MISTRI_POOLER.
      --drain-delay <s>
                      Seconds /readyz answers 503 before the listener closes
                      on SIGTERM, so a balancer that probes takes this instance
                      out first (default 0, up to 120). Or set
                      MISTRI_DRAIN_DELAY.
      --shutdown-grace <s>
                      Seconds a response still unfinished after the drain may
                      keep the process before it is cut (default 10, 1 to 300).
                      Hold the drain and this inside the platform's stop
                      timeout. Or set MISTRI_SHUTDOWN_GRACE.
      --config <path> Read connections from this file, and the cache,
                      search, webhook, email (smtps://, smtp:// or log:)
                      and OAuth services beside them; the paths in it are
                      relative to its folder
      --no-config     Ignore any config file
      --no-live       Turn live sync off, even for an App that asks for it
                      (live: true): its open pages then refresh on focus and
                      after their own saves. Nothing is written to the change
                      store and /api/live answers 204.
      --db-latency <ms>
                      Development only: every database round trip waits this
                      long before it is sent (a pipelined batch pays once), to
                      feel a remote database on this machine; 20 is a typical
                      cloud distance. Or set MISTRI_DEV_DB_LATENCY. Refused
                      under NODE_ENV=production and when serving a build.
      --app <dir>     Serve an app: a directory whose app.ts (or app.mjs /
                      app.json) declares its resources, views, navigation
                      and pages. Repeatable; with more than one, every app
                      names its connection. A save reloads it; a change to
                      its grants, sources or sign-in needs a restart.
                      mistri docs getting-started is where to begin.
                      One App is served at the root (/leases/12); several
                      each under its id (/lintel/leases/12).
      --mount <app>=<path>
                      Where an App is served, over that default: / makes it
                      the main App at the root, /billing puts it there.
                      Repeatable, one per App. Or "mount" in the config.
      --base-path <path>
                      The path a reverse proxy serves this server under, like
                      /tools: every address, asset, API call, cookie and
                      link carries it. Or "basePath" in the config, or set
                      MISTRI_BASE_PATH.
      --app-entry <file>
                      With one --app: the manifest to read, when it is not
                      the directory's own app.ts. The directory stays the
                      App's root: its components, pages/, features/ and
                      authority.lock.
      --commands <file>
                      The server-only default defineCommands registry of one
                      --app, when it is not the commands.ts beside the App's
                      manifest, which is read without the flag. The App names
                      its commands and is served their input from it. Requires
                      authenticated access and an explicitly migrated writable
                      SQLite or PostgreSQL command source; restart to reload.
      --jobs <file>   Load a server-only default defineJobs module with one
                      --app and its commands: jobs that run a command, as a
                      declared principal, when a committed event says so or
                      at the times they say (every).
                      Its stores are provisioned once from
                      @mistriwork/mistri/maintenance; restart to reload.
      --policy <file>
                      Load a server-only row or tenant policy for one authenticated,
                      named-source --app whose auth.rows is "policy" or "tenant".
                      Tenant Apps require one existing provisioned SQLite or
                      PostgreSQL source.
                      Row policies support reads and
                      explicit commands and scoped creation/updates with Undo.
                      Delete/restore requires an explicit deleted-record policy.
                      App and policy changes require a restart.
      --from-openapi <spec.json|url>
                      Draft an HTTP connection's description from an
                      OpenAPI 3.0 or 3.1 spec (JSON): the resources, their
                      columns, and what each list can filter, search, sort
                      and page by. Prints the description and exits; what it
                      guessed or skipped goes to stderr, to confirm.
      --openapi <spec.json|url>
                      Serve the API a spec describes, with no config: the
                      description is drafted in memory and the base URL is
                      the spec's server. Plain http only to this machine.
      --api-url <url> With --openapi: the API's base URL, when the spec's
                      servers do not give a usable one.
      --api-token-env <name>
                      With --openapi: send $name as a bearer token.
      --scaffold-app <dir>
                      Draft an App project for the active connection, in
                      TypeScript built from the @mistriwork/mistri/app helpers: list
                      views, display rules, an Overview dashboard, record
                      pages, mistri-schema.d.ts, tsconfig.json, an
                      .oxfmtrc.json and (outside a mistri checkout)
                      package.json with format scripts. A SQLite file is
                      named by a mistri.json beside the App, by a path
                      from there. It passes mistri check as written; a
                      start to curate. With --config naming several
                      connections, one App with a source per connection;
                      a PostgreSQL one holding several schemas is
                      a source per schema on that one connection.
      --name <name>   With --scaffold-app: the App's name, instead of one
                      read off the database file's.
      --write-authority
                      With mistri check: write each app's authority.lock —
                      what it grants, one fact per line, and each command's
                      contract — to commit beside it. The server refuses to
                      start an app whose authority differs from its lock, and
                      a reload that changes it.
      --bump <command>
                      With mistri check: move the command's contract to its
                      next version in authority.lock, when it changed and the
                      App API, a job or kept receipts depend on it.
      --reindex [resource]
                      With --app and a search provider plugged in (search
                      providers are packs, after 1.0): read every searched
                      resource (or the one named) from the database into its
                      search index, then exit. Run it after declaring search,
                      and after writes made outside the App.
      --demo          Build a throwaway sample database and open it. Nothing of
                      yours is touched; it lives in the temp directory.
      --open          Open a browser once the server is up
      --dev           Serve the dev observer at /_mistri/observe: every
                      request's trace with its SQL and parameters, commands
                      with their input and refusal cause, logs, page errors.
                      Loopback only, kept in memory, credentials masked.
                      mistri observe prints its address. With an App,
                      the theme bench too, at /_theme.
      --export <fmt>  Print brief or types, then exit: brief is the schema as one
                      line per table, for an agent's context; types emits a
                      .d.ts of this connection's own table and column names
                      for the app DSL — save it next to the app and
                      "satisfies App" squiggles a typo the editor can catch
                      before the server has to.
                      openapi exports one App's API document; it enables
                      no API routes and requires --api-integers.
                      asyncapi exports its AsyncAPI 3 document: feed events,
                      webhooks and, with --jobs, inbound endpoints.
                      The schema as md, mermaid or json is the database
                      browser's: npx tablewalk <db> --export md.
      --api-integers <kind>
                      With --export openapi or asyncapi, --api-reads or --app-mcp:
                      decimal-string or number. No default; number refuses
                      unsafe integer responses.
      --api-reads     Serve one authenticated App's API and its MCP (…/$mcp):
                      its reads, and with --commands the targeted commands it
                      exposes. Requires integers and rate budget; bearer
                      tokens only; SQLite or PostgreSQL. Serving must pass
                      native readiness. On loopback, or beyond it (--host,
                      --allowed-host, --trust-proxy) only for an App whose
                      api declares network: true. A tenant App is served
                      under its --policy, each token bound to one
                      membership; a row-policy App under its --policy, each
                      token reading its own account's rows. A "kind": "oauth"
                      entry lets a signed-in person give an agent a token.
      --api-requests-per-minute <count>
                      Explicit --api-reads rate budget per token, 1–1000000;
                      no default. Counted in this process.
      --app-mcp       Speak one authenticated App's API as MCP tools on stdio
                      instead of serving HTTP: its reads, and with
                      --commands the targeted commands it exposes. The token
                      is read from MISTRI_API_TOKEN, never the command line.
                      Requires --api-integers. SQLite or PostgreSQL; a tenant
                      or row-policy App under its --policy.
  -h, --help          Print the short help and stop; --help all prints this
  -v, --version       Print the version and stop

Checking an App while authoring it — the one command of the loop:

  mistri check --app <dir> [--app-entry <file>]
                  [<db> | --db <target> | --config <path>]
                  [--commands <file>] [--jobs <file>] [--policy <file>] [--bump <command>]
                  [--routes [--mount <app>=<path>] [--base-path <path>]]
                  [--design] [--fix] [--defaults] [--fail-on-design-warning] [--warnings]
                  [--no-index-check]
                  [--pending [--pending-on <url>] [--migrations <dir>] [--history-table <name>]]
                  [--deploy [--replicas <n>] [--connection-limit <n>] [--cpus <n>] [--strict-migrations]] [--json | --brief]

  Three or four steps, each with its own verdict line. Schema types: regenerates
  the App's mistri-schema.d.ts from the database when it has drifted (a
  file mistri did not generate is left alone; an App validation refuses is
  still typed from what it declares, a refused segment, computed column or
  tags included, so its typecheck does not bury the one problem), its
  mistri-commands.d.ts
  from its commands module, which types the command names the App uses, and its
  mistri-components.d.ts, a props type for each custom component from its
  declaration (SalesSummaryProps). Typecheck: the App's
  tsconfig.json, or the flags the agent guide gives, errors said as
  file:line, the mismatch and a hint. Validation: the App loaded against its
  database, with its problems and its warnings; an App with an authority.lock
  beside its manifest fails when what it grants differs from the lock. Components, for an App that declares custom
  components: each compiled, its sources failed on markup or code from text
  and the server's environment, warned on what a look cannot dress. Every
  step runs; the errors print first, and warnings are advisory (unless
  --fail-on-design-warning is set) and print as one line a kind unless --warnings
  lists them in full. On PostgreSQL an indexes step names each foreign key, default
  sort, fixed filter, ownership column and search the App reads by that no index
  leads (index-missing), with the CREATE INDEX that adds it; --no-index-check skips it.
  --routes also prints every address the App answers to (/{app}/leads/{id},
  /{app}/leads/new, ...) and what each one opens. --design reads its pages,
  forms and shell for compositions that come out basic (a list cut beside an
  aside, a page that opens on a block of fields), each a warning with its fix:
  mistri docs design; with --fix it first deletes from the App's source
  every rule a restated warning names. --fix also writes into an App theme's
  source each color or chart order its contrast and color-blind failures
  say passes, and checks again; the themes step comes first, a line per
  theme and mode, and fonts says the faces against their 150 KB budget. --defaults prints what each column is
  drawn by when the App says nothing, and the layout each page is drawn in.
  --pending first applies the pending migrations (mistri migrate) to a
  scratch copy of the database — SQLite: a copy of the file; PostgreSQL:
  CREATE DATABASE … TEMPLATE, which needs CREATEDB and no other session on
  the database — and every step reads the copy. --pending-on <url> (which
  implies --pending) runs them on the scratch database that URL names instead,
  on any engine: a branch or restore of the real one, or an empty one the whole
  history can build; for a hosted role without CREATEDB. It is never dropped
  and never the App's own database; a \${NAME} in the URL is expanded. --deploy adds a step that
  judges whether the App survives a container being replaced: it refuses a
  source or auth.store on a SQLite file, the default auth.store, a missing
  BETTER_AUTH_SECRET and a \${NAME} the environment lacks (run it with the
  deployment's environment), and with --replicas <n> above one it warns that
  rate limits are per process without a cache service and refuses a public
  page's door without MISTRI_FORM_KEY. It also prints, per database, the
  connections one process may hold (read and write pools, the background
  writer, LISTEN, each read replica, the sign-in store's pool, and the
  hosts the App serves with: jobs, effects, integrations, decisions, the
  API event feed, the assistant; given --jobs, its module is read for them)
  times --replicas, and with --connection-limit <n> (the connections the
  database allows this role) refuses a total above it. Pool defaults follow
  the cores: --cpus <n> says the deployment's (this machine's otherwise,
  and the line says which it assumed). It also reads the migrations not yet
  applied and warns about each statement that breaks the code still running
  (a dropped or renamed column or table, a type change, SET NOT NULL, a NOT
  NULL column without a default, a dropped view or function), with how to
  stage it as expand, deploy, contract; a comment "-- mistri: contract"
  on the line before a deliberate contract step makes it a note, and
  --strict-migrations makes the rest fail. --json prints one JSON
  document instead of the lines (schema/check.schema.json): every finding
  of every step with its code, file, line, column, definition path and fix,
  for an agent; the exit code is the same. --brief prints one line per
  problem, "code file:line message — fix: …", and one "preview-feature
  (info)" line naming the Preview features the App uses; repeated warnings
  are a line a code and resource with a count (--warnings lists each).
  Exit codes: 1 could not check, 2 schema types, 3 typecheck, 4 validation,
  5 components, 6 a pending migration failed on the copy, 7 --deploy refused. What each step
  checks and the common fixes: mistri docs check-codes.

Looking at an App — its pages as PNG files, for the agent that built it:

  mistri shot --app <dir> [<route>…] [<db> | --db <target> | --config <path>]
                 [--commands <file>] [--jobs <file>] [--policy <file>]
                 [--theme <id|all>] [--palette <id>]
                 [--compare <look>] [--recipes <part>] [--dark | --light] [--phone | --desk | --both]
                 [--click <name>] [--type <field> <text>] [--press <key>] [--wait-for <text>] [--matrix]
                 [--width <px>] [--full] [--scale <1-3>] [--as <role|email> [--tenant <id>]]
                 [--out <dir>] [--text] [--browser <path>]

  Serves the App on a free port with a temporary config directory (none of
  yours is read or written), opens each route in Chromium once it has settled
  and prints the path of each PNG. A route is /{app}/leads/12 or leads/12;
  with none, every view and page the App declares, a page on its first record.
      --theme <id|all>  with shot or grade: a built-in look (workshop, lumen,
                      mono, sage, ledger) or one of the App's own themes instead of the
                      one it wears; with shot, all shoots every built-in
                      look, then the App's. The menu stands where that
                      theme suggests (shell.placement) unless the App's
                      ui.shell says, which a note says
      --palette <id>  with shot or grade: one of that theme's palettes
      --compare <look>  the App's theme (or --theme) beside that look, one
                      picture of the two, <page>-<mode>.png,
                      the look on the left
      --recipes <part>  one page (the home, or the route) in each value of
                      that recipe part, one contact sheet at
                      <part>-<page>-<mode>.png; a note
                      names values that draw the page nearly alike
      --dark, --light
                      the scheme a reader picked: the page wears it as if
                      chosen in its menu, whatever the machine is set to
                      (without either, the machine's, light)
      --click <name>  before the picture, press the button, link, tab, menu
                      item or option with that accessible name, else the
                      visible text; css:<selector> names an element by
                      selector
      --type <field> <text>
                      type into the box with that label or placeholder
                      (css:<selector> likewise)
      --press <key>   press a key (Enter, Escape, ArrowDown)
      --wait-for <text>  wait until that text is visible. These four run in
                      the order given, repeatable, on every route; the page is
                      settled (requests done, nothing busy) before the first
                      and after each, and a name that matches nothing in 15
                      seconds is refused with the step and the address
      --matrix        every built-in look and the App's own, light and dark, at a
                      desk and on a phone, for the routes: <page>-<look>-
                      <light|dark>-<desk|phone>.png and an index.html laying
                      them out. Takes no --theme, --palette, --dark, --light
                      or size flag
      --phone, --desk, --both
                      390 wide, 1280 wide (the default), or both
      --width <px>    the window's width instead (320 to 2560), with --desk
                      or --phone: a narrow desk, a tablet
      --full          the whole page, not the window
      --scale <1-3>   device pixels per CSS pixel (default 1; 2 for a sharp
                      picture): the page lays out the same, the PNG is larger
      --as <role>     sign in as an account of that role the App's local
                      store holds (one with a person row first, then the
                      earliest made), in a copy of it (its password reset
                      there only), else as a fresh one, which owns no rows;
                      never a service role, which no person signs in as;
                      without it, signed out
      --as <email>    sign in as that account, already made (by mistri dev
                      or a local start), with the password in
                      MISTRI_AS_PASSWORD; its store is read, never written
      --tenant <id>   with --as on a tenant App: the tenant the role is held
                      in (a platform role needs none). The account is granted
                      a temporary membership in the App's tenant store,
                      journaled as maintenance:mistri-shot and revoked when
                      the shot ends; each page opens in that context
      --out <dir>     with shot: where every file goes, from the current
                      directory (default mistri-shots/<app> in the system's
                      temporary directory, where --compare, --recipes and
                      --matrix each write to compare/, recipes/ or matrix/)
      --text          with shot: print what each page shows (title, headings,
                      table columns and row count, actions, empty states, page
                      errors) as compact text instead of writing PNG files
      --browser <path>  a Chromium or Chrome to shoot with (default: the CHROME
                      variable, else Playwright's own, the machine's Chrome,
                      then any Chromium another Playwright version installed)
  Needs Playwright's Chromium: install the playwright package where you run it,
  then install its headless Chromium (shot prints the exact command when it is
  missing); the machine's Chrome serves when Playwright's browser is missing.
  Exit codes: 1 could not shoot, 2 a page threw or a
  section could not be drawn.

Rows to look at — a draft judged on believable data, with no seed script:

  mistri seed [--app <dir>] [<db> | --db <target> | --config <path>]
                 [--connection <name>] [--rows <n>] [--seed <n>] [--append]

  Fills the App's database (or every table, without --app) through its
  adapter, parents before children: CHECK vocabularies, keys, NOT NULL and
  unique columns hold. A status the App moves with a machine (or, without
  an App, one read off the vocabulary) is spread over its states — most work
  open, about a third done, a little called off — each record with the
  stamps of the states it passed through. Dates fall across the last 90
  days, and some open work is due today or overdue. Names, emails
  (example.com) and phone numbers (555-01xx) come from a small word list.
  Writes only to a connection whose config says "writable": true.
      --rows <n>      rows per main table (default 40); staff and lookups
                      get fewer, lines more
      --seed <n>      the same rows again, on the same day (default: one
                      chosen and printed)
      --append        add to tables that already hold rows; without it, a
                      table with rows is refused before anything is written
  Exit codes: 1 could not run, 2 refused (read-only, or rows already there).

Grading an App — the rubric measured in a browser, not looked at:

  mistri grade [<app-dir>] [<db> | --db <target> | --config <path>]
                  [--commands <file>] [--jobs <file>] [--policy <file>] [<route>…]
                  [--as <role|email|all> [--tenant <id>]] [--theme <id|all> [--palette <id|all>]]
                  [--json] [--browser <path>]

  Serves the App as shot does and opens every view and a record of each page
  at 1280, 390 and 320 wide, and at 390 in the dark scheme. Each is measured:
  sideways scroll, figures and words cut off, controls drawn over each other,
  targets under 44px on a phone, text and field edges below the contrast
  rule, layout shift after the first paint, page errors and failed requests,
  empty sections, two number formats in one surface, chart axes that are not
  round, a record's name past two lines on a phone. One line per finding,
  "code file:line page@widths message — fix: …", then a score out of 100.
  The App is <app-dir>, else the current directory. An App with sign-in is
  graded as the role that reads the most, unless --as names one (or an
  account, as shot's --as <email> does).
      --json          with grade: one JSON document of the findings and score
      --theme <id>    with grade: grade in a built-in look or one of the App's
                      own themes instead of the one it wears; a finding
                      the theme causes is placed at the theme, and any
                      error fails it; all grades every look as one table,
                      a row each and a column each window
  --palette all and --as all add a row for each palette (at 390, light and
  dark, its colors only) and for signed out and each role. A finding of the
  theme contract says its promise, C1 to C13: mistri docs theme-contract.
  Exit codes: 1 could not grade, 2 an error-level finding. The codes and their
  fixes: mistri docs design.

A theme as it is worn — every color, recipe, type and shape after extends:

  mistri theme show <look|theme-id|.> [--app <dir>] [--diff <look|theme-id>] [--json]

  A built-in look (workshop, lumen, mono, sage, ledger), or a theme of the App in --app (else
  the current directory); . is the one the App wears. Every color in light
  and dark and each palette's changes, every recipe, the type and the shape,
  each value it inherits marked with where from: the look it extends, its
  Default palette, the plain structure's default, or derived from its other
  colors.
      --diff <look>   only what differs from that look or theme
      --json          with theme show: one JSON document

Changing the schema — versioned SQL files in Flyway's format, forward only:

  mistri migrate new <name> [--repeatable]
  mistri migrate status | up | validate | baseline | repair
  mistri migrate diff <name> | check | squash
                  [--app <dir>] [<db> | --db <target> | --config <path>]
                  [--connection <name>] [--schema <name>] [--migrations <dir>]
                  [--history-table <name>] [--dry-run] [--tool flyway]
                  [--schema-file <path>] [--dev-url <url>]

  V3__add_payoff_quote.sql runs once, in version order, in its own
  transaction (a failure is recorded as failed); R__views.sql runs again whenever it changes.
  up applies what is pending; with --app it then regenerates the App's schema
  types and runs check, which names the view, page or command a dropped or
  renamed column breaks. status lists what is applied and pending, the changes
  made outside migrations (drift), and whether the App's types are older than
  the database. validate fails on a changed, missing or failed file, a pending
  one, or drift. baseline records a database that already has tables as
  version 0, touching nothing, and writes its schema beside the migrations
  (baseline.schema.json, never run). repair removes failed entries, accepts
  changed files and marks missing ones deleted.

  diff, check and squash read the schema you want from schema.sql beside the
  migrations (db/migrations -> db/schema.sql). diff writes the next V file
  holding what the migrations still lack to build it, for review: a rename
  comes out as a drop and an add. The first is schema.sql itself, written
  with no download. check fails (exit 2) when the migrations,
  applied to a scratch database, do not build schema.sql. squash folds the V
  files into one V1__baseline.sql, before a database worth keeping exists.
  mistri's own __mistri_* tables are left out. The comparison is Atlas's
  community build, pinned and checked by sha256, fetched on first use into
  .mistri/bin with its update check off (MISTRI_ATLAS names your own);
  serving never fetches it. PostgreSQL and SQLite.
      --migrations <dir>
                      where the files are (default: migrations/ in the App, or
                      the connection's "migrations": { "dir": … } in
                      mistri.json, relative to that file)
      --history-table <name>
                      the history table: Flyway's layout, named
                      __mistri_schema_history unless this or the
                      connection's "migrations": { "table" } says otherwise
                      (flyway_schema_history, to take over from Flyway)
      --connection <name>
                      with several connections and no --app: which one
      --dry-run       with up, baseline or repair: print what would run
                      (the SQL, for up) and change nothing
      --tool flyway   run the command with an installed Flyway instead (on the
                      PATH, or MISTRI_FLYWAY), over the same files and history
      --repeatable    with new: an R__ file
      --schema-file <path>
                      with diff, check or squash: the schema you want (default
                      schema.sql beside the migrations directory)
      --dev-url <url> with diff, check or squash on PostgreSQL: the server
                      where two scratch databases are made and dropped
                      (default: the connection's; needs CREATEDB)
  A run holds a lock — PostgreSQL: the advisory lock Flyway takes for the same
  table; SQLite: its write lock — so two deploys never migrate
  at once. Scoped to the App's schemas (or the connection's, or --schema).
  Exit codes: 1 could not run, 2 files and history disagree, 3 a migration
  failed, 4 applied but the App no longer checks.

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

Starting flows on records already there — a backfill, run once beside the server:
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

Running a job now — one of an App's jobs at times, once, by hand:
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

Measuring a decision before it applies — and pinning the model that earned it:
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

A tenant App's first boot — after mistri migrate stores up --policy:
  mistri tenant init [<tenant>...] --app <dir> --policy <file>
  mistri tenant grant <email> --roles <role,...> [--tenant <id>] [--name <name>] [--days <n>]
                  --app <dir> --policy <file> [--operator <name>] [<db> | --db <target> | --config <path>]
  init opens the platform realm (when the App declares one) and puts each named
  tenant, active; one already there is left as it is, so it runs again after a
  stop part-way. grant grants <email> a membership of the platform realm, or
  with --tenant of that tenant, with that realm's --roles, for --days (default
  180, at most 366). An address with no account gets one in the App's auth
  store, its password read from MISTRI_ACCOUNT_PASSWORD, never the command
  line. Exit codes: 1 could not run.

A tenant App's sandboxes — a copy of a tenant to try changes in:
  mistri tenant clone <source> <sandbox> --app <dir> --policy <file> [--samples]
  mistri tenant import <sandbox> --app <dir> --policy <file>
  mistri tenant clock <sandbox> --app <dir> --policy <file> --ahead <duration> [--rate <n>]
                  [--operator <name>] [--commands <file>] [<db> | --db <target> | --config <path>]
  clone makes a new sandbox tenant from a copy of the source's rows of every
  resource the App marks clone: 'config' (and 'sample' with --samples), its
  ids rewritten so the copy names only its own rows. import prints what
  importing the sandbox into its source would change and what conflicts; the
  source's owner approves it in Manage tenants. clock sets a sandbox's dev
  clock, which its machine timers fall due on; a live tenant has none.
  Exit codes: 1 could not run.

Building an App for production — optional; an App also runs from its source:

  mistri build --app <dir> [--app-entry <file>] [--out <dir>]
                  [--config <path>] [--commands <file>] [--jobs <file>]
                  [--policy <file>] [--dockerfile <file>]

  Typechecks the App (its tsconfig.json, with the App's or mistri's
  TypeScript), validates it as a start does, bundles its definition and
  server entries (with rolldown when it is installed; otherwise each module
  is type-stripped on its own), and writes app.json, mistri-build.json
  and server/<kind>.mjs, and an App's custom components as components/.
      --out <dir>     Where the build goes, from the current directory as
                      every path on the command line is (default
                      build/<dir name> in the current directory, the project
                      the build must stay inside to resolve mistri; or
                      <dir name>-build beside an App built from its own
                      directory). Replaced whole on success; refused unless
                      it is new, empty or an earlier build.
      --dockerfile <file>  Build nothing: write the Dockerfile that builds this
                      App with these options in a build stage and serves it
                      (tini, uid 1000, PORT, a /healthz health check). Run
                      docker build from the project root; --config is copied
                      in, not built with.
  A --config may list this App (and no other): its apps[].env is what the
  definition is built with. With --config reaching the App's database, it
  also writes the generated types and runs mistri check's validation on the build. Serve
  it with --app <out>, and the build's own server/<kind>.mjs for --commands,
  --jobs or --policy. A build is pinned to the mistri version that made
  it and never watched.
  Exit codes: 1 could not build, 2 typecheck, 3 validation, 4 bundle.

Deploying an App to Cloudflare Containers — a Worker in front of one always-on container:

  mistri deploy init cloudflare --app <dir> [--config <path>] [--commands <file>] [--jobs <file>]
                  [--policy <file>] [--app-entry <file>] [--out <dir>] [--dir <dir>] [--force]
  mistri deploy [--dry-run] [--yes] [--allow-contract] [--allow-dirty]
                  [--migrate-url <url>] [--migrations <dir>] [--connection-limit <n>] [--verbose]
                  [--backup-check <cmd>] [--smoke <cmd>] [--roll-timeout <minutes>] [--dir <dir>]
  mistri deploy verify [--roll] [--roll-timeout <minutes>] [--smoke <cmd>] [--dir <dir>]
  mistri deploy status | rollback [<deploy-id>] [--dry-run] | logs [--dir <dir>]

  init writes deploy/cloudflare/ (wrangler.jsonc, src/index.ts against
  @mistriwork/cloudflare, package.json and the build request) from the App's
  build flags, naming every secret mistri.json reads. It creates nothing on
  Cloudflare and refuses to replace existing files without --force.
  deploy prints a plan and changes nothing until confirmed (--yes in CI;
  --dry-run stops after the plan). It refuses when check --deploy fails, a
  secret is missing from the Worker (compared by name through wrangler
  secret list, never read), a pending migration is a contract step marked
  "-- mistri: contract" (unless --allow-contract), or the working tree is
  dirty (unless --allow-dirty). It then builds, runs --backup-check (a
  non-zero exit refuses), applies the migrations and the App's stores from
  this machine: the versioned migrations over --migrate-url or
  MISTRI_MIGRATE_URL (a direct database address, never the container's), the
  App's stores over the store URLs its config names, read from this
  machine's environment and not from --migrate-url. It runs wrangler deploy with a new
  MISTRI_DEPLOY_ID, and restarts the container with MISTRI_RESTART_TOKEN
  (sent only to an https MISTRI_PUBLIC_URL, or http on localhost)
  until /readyz reports that deploy id and this build's id, for up to
  --roll-timeout minutes (default 20), failing with what it last saw. --smoke
  runs your command afterwards. Each deploy is a row in __mistri_deploys in
  the migration database. A history problem (a recorded migration missing from
  the directory) refuses the plan; --migrations <dir> overrides the config's
  directory. A failure after wrangler deploy says the new Worker version is
  serving; verify re-checks the newest deploy against /readyz and the smoke
  (--roll restarts the container until it matches) and corrects its record.
  status prints the live /readyz fingerprint and the record it matches, the
  recorded deploys and the newest five Cloudflare deployments (it creates
  nothing); rollback returns to the previous successful deploy (or the
  one named) with wrangler rollback and the same verification, and refuses
  when a contract migration was applied after it; logs is wrangler tail. Run
  from the project root. wrangler reads its login from $XDG_CONFIG_HOME/.wrangler when
  that is set: a shell whose XDG_CONFIG_HOME differs from the one used at
  wrangler login reports "not logged in". Exit codes: 1 could not, declined or failed, 7 refused.

Comparing exported App API documents:

  mistri compare-openapi <previous.json> <current.json>

  Reads two bounded local JSON files, prints a conservative change report,
  and exits without loading a config, database or command handlers.
  Requires no-follow/nonblocking file-open support; Windows is not supported.
  Exit 0: version requirement met; 1: a required version increase is missing
  or the version decreased; 2: invalid input or unsupported document.
  Findings remain visible after a version increase. This is not a general
  OpenAPI compatibility proof, and it does not enable API routes.

Reading the reference offline:

  mistri docs                     list the topics and every shipped page
  mistri docs <topic>             print one (access-model, secrets, relationships, …)
  mistri docs <topic> --brief     its headings and the first sentence under each, one screen
  mistri docs --search <words>    every line of the shipped pages that says them

Giving a coding agent the App skill:

  mistri agent init [--dir <project>] [--tool claude|codex|cursor|copilot|all] [--force]

  Copies the skill mistri ships (a decision guide for building an App:
  which block fits, the design language, the choices that are hard to undo,
  and a rubric for screenshots) into the project, and points at it from a
  marked block in AGENTS.md. Claude Code reads .claude/skills/mistri;
  Codex, Cursor and Copilot read .agents/skills/mistri; all (the default)
  writes both.
      --dir <project> where to install (default: the current directory)
      --tool <name>   claude, codex, cursor, copilot or all; comma-separated
      --force         replace a copy the project has changed
  A re-run updates a copy it installed and says so; one the project changed
  is left alone, and the exit code is 1.

Running an App on this machine, and testing it:

  mistri dev [<app-dir>] [<db> | --db <target> | --config <path>] [options]

  Serves the App (default: the current directory) as --app <dir> --dev does,
  with a throwaway session secret and an account per declared role, each
  sign-in printed. They are kept in <app-dir>/.mistri/ (the auth store too),
  so a restart signs the same people in; delete it to start over. Local and
  for development only: it refuses to run with NODE_ENV=production. The
  database is the App's mistri.json unless one is named. Where auth.me
  names the table people are rows of, each role's account takes the email of
  one of its rows, so a view of "= me" shows that person's records. A
  tenant App, started with its --policy, gets an account per role that is a
  member of the first two tenants of its profile table, or of the platform
  realm for a platform role.

  mistri test init [<app-dir>] [--config <path>] [--force]

  Writes tests/start.ts, tests/journeys.test.ts and tests/permissions.test.ts
  into the App, on @mistriwork/mistri/testing alone: a journey per role (its views, a
  record, a command it is granted, each machine verb it holds), each job at
  times run now, and every role × resource and command, allowed or refused as
  authority.lock says, for Node's test runner (tests/*.test.ts). A row-policy
  App is served with the policy.ts and jobs.ts beside its app.ts. A tenant
  App gets tests/tenants.test.ts instead: for two of its tenants, each
  resource a tenant owns, each command a tenant role runs and each platform
  role's reads, served with its tenant policy and commands.ts. A file
  already there is refused unless --force.
      --config <path> with test init: the mistri.json the suite copies its
                      database from (default: the App's own); the suite reads
                      MISTRI_TEST_CONFIG first, when it is set

Connections can also come from a mistri.json:

  { "connections": [ { "name": "app", "url": "postgres://localhost/app" } ] }

An App's definition reads no environment unless the file lists it:

  { "apps": [ { "dir": "apps/ops", "env": ["REGION"] } ] }

Looked for in ./mistri.json, ./.mistri.json, then
$XDG_CONFIG_HOME/mistri/connections.json.

Watching what a --dev server did:

  mistri observe [--url <base>]      print the running dev server's observer address
  mistri observe --mcp [--url <base>]
                                     speak its telemetry to a coding agent on stdio:
                                     check (mistri check --json; no server needed),
                                     recent_errors, list_traces, get_trace, search_logs,
                                     slow_queries, n_plus_one, explain_access,
                                     page_vitals, tail

OpenTelemetry is on when the standard variables say so: set
OTEL_EXPORTER_OTLP_ENDPOINT (and OTEL_EXPORTER_OTLP_HEADERS, OTEL_SERVICE_NAME,
OTEL_RESOURCE_ATTRIBUTES, OTEL_TRACES_SAMPLER as your collector, Datadog or
Dynatrace asks) and traces, metrics and logs are sent over OTLP/HTTP. Nothing
private is in them: no bodies, row values, SQL parameters, emails or tokens.
GET /healthz and /readyz answer an orchestrator (under --base-path, as every
route is); /robots.txt and /sitemap.xml a crawler, with an App's public
addresses where it has auth.public.

Set MISTRI_DIAGNOSTICS=1 for best-effort HTTP JSONL diagnostics on stderr
and generated X-Request-ID response headers. Disabled by default. These records
omit URLs, bodies, identities, SQL and error messages; existing human CLI logs
are separate.

Browsing a database with no App is the database browser's: npx tablewalk <db>.

`.trim();

/** `mistri schema --help`: the one form of the command, with the connection flags it reads. */
export const SCHEMA_USAGE = `mistri schema --brief [<db> | --db <target> | --config <path>] [--schema <name>]

The schema as one line per table, for an agent's context: columns with short types,
primary keys (*), nullable columns (?), vocabularies ({a|b}) and foreign keys (→).
The same as --export brief. mistri's own store tables (__mistri_*, the sign-in
store's schema) are left out and counted on the first line.

  <db>               a SQLite file, a postgres:// URL
  --db <target>      the same, as a flag
  --config <path>    a mistri.json naming connections (its first)
  --schema <name>    Postgres only; repeatable. Defaults to all user schemas.
  --brief            required: without it a word after mistri is a SQLite file's name
`;

/**
 * What `--help` prints: the commands a person reaches for first and the options every start takes, on one screen.
 * USAGE is over seven hundred lines, and a first `--help` that scrolls past its own top answers nothing; it is one
 * `--help all` away, and `test/prose.test.ts` holds this list to the commands USAGE names.
 */
export const SHORT_USAGE = `
mistri — the App framework: a few lines of TypeScript, a complete App
over your own database.

  mistri --app <dir>              serve an App
  mistri dev [<app-dir>]          serve an App with a dev secret and a sign-in per role
  mistri check --app <dir>        types, typecheck and validation of an App
  mistri build --app <dir>        make an App ready for production
  mistri migrate <command>        change the schema with versioned SQL files
  mistri seed [--app <dir>]       believable rows in an App's writable database
  mistri shot --app <dir>         an App's pages as PNG files
  mistri grade [<app-dir>]        an App's pages measured against the rubric
  mistri test init [<app-dir>]    a starter suite: a journey per role, a permissions matrix
  mistri docs [topic]             the App reference, offline
  mistri explain <check-code>     what a check code means, with a fix example
  and: new, deploy, suite, virtual, flags, experiments, analytics, theme, schema, messages,
       flows, jobs, decide, tenant, agent, observe, compare-openapi, api-token, mail-dns

Common options:
  -d, --db <target>   SQLite file path or postgres:// URL (or set DATABASE_URL)
  -p, --port <n>      Port to listen on (default 4111)
      --host <addr>   Interface to bind (default 127.0.0.1, loopback only)
      --config <path> Read connections from this file
      --app <dir>     Serve an app: a directory whose app.ts declares it
  -v, --version       Print the version and stop

  mistri --help all               every command and option, in full
  mistri <command> --help         one command's options

Browsing a database with no App is tablewalk's: npx tablewalk --help.
`.trim();

/** The App framework, as the shared start reads it (engine cli/startup.ts). */
export const MISTRI: Product = {
  bin: 'mistri',
  usage: USAGE,
  shortUsage: SHORT_USAGE,
  commandWords: commandWordsOf(USAGE, 'mistri'),
  flagWords: flagWordsOf(USAGE),
};
