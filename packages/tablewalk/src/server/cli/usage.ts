/**
 * The `tablewalk` command line in words: `USAGE`, every command and flag the database browser takes, and
 * `SHORT_USAGE`, the first screen of it. The App framework's are `mistri`'s own
 * (packages/mistri/src/server/cli/usage.ts). test/prose.test.ts holds this USAGE and the package's README
 * (packages/tablewalk/README.md) to each other, and scripts/cli-reference.mjs writes the site's CLI page from both.
 */
import { commandWordsOf, flagWordsOf } from '@mistriwork/engine/server/cli/usage.js';
import type { Product } from '@mistriwork/engine/server/cli/startup.js';

export const USAGE = `
tablewalk — browse a relational database as a graph you walk.

  tablewalk                       start with nothing; the page asks for a connection
  tablewalk <sqlite-file>
  tablewalk postgres://user:pass@host/db
  tablewalk --db postgres://… --schema public --port 4111
  tablewalk --demo                a throwaway sample database, opened
  tablewalk <db> --mcp            the database's tools for a coding agent, on stdio
  tablewalk <db> --export md      the schema in words; mermaid or json too
  tablewalk migrate <command>     change the schema with versioned SQL files (see below)
  tablewalk seed [<db>]           believable rows in a writable database (see below)

An App (pages, commands and policies over a database) is mistri's: npx @mistriwork/mistri
dev, npx @mistriwork/mistri check, npx @mistriwork/mistri --app <dir>. tablewalk refuses an App's start
and names the mistri command that runs it.

Paths: one typed on the command line (--config, --migrations, --schema-file, …)
is relative to the current directory; one written in a file (tablewalk.json)
is relative to that file's folder. Every command reads a file's paths that
way, a SQLite url among them; a value from the environment
("\${DATABASE_URL}") is read as given, from the current directory.

Options:
  -d, --db <target>   SQLite file path, or a postgres:// or mysql:// URL (or set DATABASE_URL,
                      used when no config names connections)
  -p, --port <n>      Port to listen on (default 4111)
      --host <addr>   Interface to bind (default 127.0.0.1, loopback only)
      --allowed-host <name>
                      Also answer for this Host header; repeatable.
                      Needed behind a proxy or in a container reached by name.
                      Or set TABLEWALK_ALLOWED_HOSTS=a.example,b.example
      --trust-proxy <address|CIDR>
                      A proxy whose X-Forwarded-For the rate limit may
                      believe: 10.0.0.0/8, 172.17.0.1, fd00::/8.
                      Repeatable or comma-separated; loopback is always
                      trusted. Rate limiting only, never sign-in. Or set
                      TABLEWALK_TRUST_PROXY=10.0.0.0/8,fd00::/8
      --trust-proxy-hops <n>
                      Behind a managed front end with no address to name
                      (Cloud Run, a cloud load balancer): how many proxies
                      append to X-Forwarded-For. The client is the address
                      n places from the right; anything the visitor wrote
                      left of it is ignored. Rate limiting only. Or set
                      TABLEWALK_TRUST_PROXY_HOPS=1
      --trust-proxy-cloudflare
                      Read CF-Connecting-IP as the client. Only when the
                      server is reachable through Cloudflare alone (a tunnel
                      or its address ranges): anyone else can write the
                      header. Not with --trust-proxy-hops. Or set
                      TABLEWALK_TRUST_PROXY_CLOUDFLARE=1
      --auth-proxy-header <name>
                      Behind a proxy that signs people in: the header it sets
                      with the user (X-Forwarded-User). Requests from beyond
                      loopback must carry it, and every write is journaled
                      with it. Or set TABLEWALK_AUTH_PROXY_HEADER.
      --schema <name> Postgres only; repeatable. Defaults to all user schemas.
      --read-pool <n> PostgreSQL connections that may read at once, per
                      database (default 4, at most 64). A connection's
                      "pool": { "read": n } in tablewalk.json wins.
                      Or set TABLEWALK_READ_POOL.
      --lock-timeout <s>
                      Seconds a write waits for a row or table another
                      transaction holds before it is refused (default 5,
                      0.1 to 30). Or set TABLEWALK_LOCK_TIMEOUT.
      --pooler <mode> session (the default): PostgreSQL is reached directly,
                      or through a pooler that keeps a client on one server
                      connection. transaction: through PgBouncer in
                      transaction mode or RDS Proxy; the read-only guard and
                      the statement cap are then set per transaction.
                      Or set TABLEWALK_POOLER.
      --drain-delay <s>
                      Seconds /readyz answers 503 before the listener closes
                      on SIGTERM, so a balancer that probes takes this instance
                      out first (default 0, up to 120). Or set
                      TABLEWALK_DRAIN_DELAY.
      --shutdown-grace <s>
                      Seconds a response still unfinished after the drain may
                      keep the process before it is cut (default 10, 1 to 300).
                      Hold the drain and this inside the platform's stop
                      timeout. Or set TABLEWALK_SHUTDOWN_GRACE.
      --config <path> Read connections from this file; the paths in it are
                      relative to its folder. A file that lists Apps is
                      mistri's to serve, and is refused here.
      --no-config     Ignore any config file
      --base-path <path>
                      The path a reverse proxy serves this server under, like
                      /tools: every address, asset, API call, cookie and
                      link carries it. Or "basePath" in the config, or set
                      TABLEWALK_BASE_PATH.
      --openapi <spec.json|url>
                      Serve the API a spec describes, with no config: the
                      description is drafted in memory and the base URL is
                      the spec's server. Plain http only to this machine.
      --api-url <url> With --openapi: the API's base URL, when the spec's
                      servers do not give a usable one.
      --api-token-env <name>
                      With --openapi: send $name as a bearer token.
      --demo          Build a throwaway sample database and open it. Nothing of
                      yours is touched; it lives in the temp directory.
      --open          Open a browser once the server is up
      --mcp           Speak MCP on stdio for coding agents, instead of HTTP:
                      the database browser's tools, which serve no App
      --tools <name>  Offer one job's worth of tools instead of all of them:
                      explore, migrate, seed, or full (the default).
      --output-schema Advertise each tool's output shape in tools/list. Off by
                      default: it is half the listing's size, and most agents
                      never read it. Answers carry the same fields either way.
      --export <fmt>  Print the schema as md, mermaid or json, then exit.
      --lint [fmt]    Report what the shape will cost — missing keys,
                      unindexed references, naive timestamps — as text or
                      json, then exit.
      --fail-on <sev> With --lint, exit non-zero when a finding is at least
                      this severe: high, medium or low. For CI.
      --diff <conn>   Compare the active connection's shape with this one,
                      print the differences, then exit. Exit code 1 when they
                      differ, the way diff(1) does.
  -h, --help          Print the short help and stop; --help all prints this
  -v, --version       Print the version and stop


Changing the schema — versioned SQL files in Flyway's format, forward only:

  tablewalk migrate new <name> [--repeatable]
  tablewalk migrate status | up | validate | baseline | repair
  tablewalk migrate diff <name> | check | squash
                  [<db> | --db <target> | --config <path>]
                  [--connection <name>] [--schema <name>] [--migrations <dir>]
                  [--history-table <name>] [--dry-run] [--tool flyway]
                  [--schema-file <path>] [--dev-url <url>]

  V3__add_payoff_quote.sql runs once, in version order, in its own
  transaction (MySQL commits DDL as it goes: a failure there stops the run
  and is recorded as failed); R__views.sql runs again whenever it changes.
  up applies what is pending. status lists what is applied and pending, and
  the changes made outside migrations (drift). validate fails on a changed, missing or failed file, a pending
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
  tablewalk's own __mistri_* tables are left out. The comparison is Atlas's
  community build, pinned and checked by sha256, fetched on first use into
  .tablewalk/bin with its update check off (TABLEWALK_ATLAS names your own);
  serving never fetches it. PostgreSQL and SQLite.
      --migrations <dir>
                      where the files are (default: the connection's
                      "migrations": { "dir": … } in tablewalk.json, relative
                      to that file, else migrations/)
      --history-table <name>
                      the history table: Flyway's layout, named
                      __mistri_schema_history unless this or the
                      connection's "migrations": { "table" } says otherwise
                      (flyway_schema_history, to take over from Flyway)
      --connection <name>
                      with several connections: which one
      --dry-run       with up, baseline or repair: print what would run
                      (the SQL, for up) and change nothing
      --tool flyway   run the command with an installed Flyway instead (on the
                      PATH, or TABLEWALK_FLYWAY), over the same files and history
      --repeatable    with new: an R__ file
      --schema-file <path>
                      with diff, check or squash: the schema you want (default
                      schema.sql beside the migrations directory)
      --dev-url <url> with diff, check or squash on PostgreSQL: the server
                      where two scratch databases are made and dropped
                      (default: the connection's; needs CREATEDB)
  A run holds a lock — PostgreSQL: the advisory lock Flyway takes for the same
  table; MySQL: GET_LOCK; SQLite: its write lock — so two deploys never migrate
  at once. Scoped to the connection's schemas, or --schema.
  Exit codes: 1 could not run, 2 files and history disagree, 3 a migration
  failed. An App's migrate (its types regenerated and checked after up, its
  stores and files) is mistri's: npx @mistriwork/mistri migrate --app <dir>.

Rows to look at — a draft judged on believable data, with no seed script:

  tablewalk seed [<db> | --db <target> | --config <path>]
                 [--connection <name>] [--rows <n>] [--seed <n>] [--append]

  Fills every table through its adapter, parents before children: CHECK
  vocabularies, keys, NOT NULL and unique columns hold. A status read off
  its vocabulary is spread over its states — most work open, about a third
  done, a little called off — each record with the stamps of the states it
  passed through. Dates fall across the last 90
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
  An App's seed, each status the way its machine moves it, is mistri's:
  npx @mistriwork/mistri seed --app <dir>.

Connections can also come from a tablewalk.json:

  { "connections": [ { "name": "app", "url": "postgres://localhost/app" } ] }

Looked for in ./tablewalk.json, ./.tablewalk.json, then
$XDG_CONFIG_HOME/tablewalk/connections.json.

OpenTelemetry is on when the standard variables say so: set
OTEL_EXPORTER_OTLP_ENDPOINT (and OTEL_EXPORTER_OTLP_HEADERS, OTEL_SERVICE_NAME,
OTEL_RESOURCE_ATTRIBUTES, OTEL_TRACES_SAMPLER as your collector, Datadog or
Dynatrace asks) and traces, metrics and logs are sent over OTLP/HTTP. Nothing
private is in them: no bodies, row values, SQL parameters, emails or tokens.
GET /healthz and /readyz answer an orchestrator (under --base-path, as every
route is).

Set TABLEWALK_DIAGNOSTICS=1 for best-effort HTTP JSONL diagnostics on stderr
and generated X-Request-ID response headers. Disabled by default. These records
omit URLs, bodies, identities, SQL and error messages; existing human CLI logs
are separate.

Browsing is read-only. Editing is off by default, per connection: its
"writable": true in tablewalk.json, enforced at the adapter, not the UI.
`.trim();

/**
 * What `--help` prints: the commands a person reaches for first and the options every start takes, on one screen.
 * `test/prose.test.ts` holds this list to the commands USAGE names.
 */
export const SHORT_USAGE = `
tablewalk — browse a relational database as a graph you walk.

  tablewalk [<sqlite-file> | postgres://… | --db <target>]
                                  browse a database; the page asks when none is named
  tablewalk --demo                a throwaway sample database, opened
  tablewalk migrate <command>     change the schema with versioned SQL files
  tablewalk seed [<db>]           believable rows in a writable database

Common options:
  -d, --db <target>   SQLite file path or postgres:// URL (or set DATABASE_URL)
  -p, --port <n>      Port to listen on (default 4111)
      --host <addr>   Interface to bind (default 127.0.0.1, loopback only)
      --config <path> Read connections from this file
      --mcp           Speak MCP on stdio for coding agents, instead of HTTP
      --lint [fmt]    Report what the shape will cost, then exit
      --diff <conn>   Compare the active connection's shape with this one
  -v, --version       Print the version and stop

  tablewalk --help all            every command and option, in full
  tablewalk <command> --help      one command's options

An App is mistri's: npx @mistriwork/mistri --help.
`.trim();

/**
 * The App framework's command words. Each is mistri's, and `tablewalk <word>` is refused with `npx @mistriwork/mistri <word>`
 * rather than opened as a SQLite file of that name. This binary does not import the App framework to ask it, so the
 * list is written here, and test/cli-binaries.test.ts holds it to the words mistri's USAGE names.
 */
export const APP_COMMAND_WORDS: readonly string[] = [
  'agent',
  'analytics',
  'api-token',
  'build',
  'check',
  'compare-openapi',
  'decide',
  'dev',
  'docs',
  'experiments',
  'explain',
  'flags',
  'flows',
  'grade',
  'jobs',
  'mail-dns',
  'messages',
  'migrate',
  'new',
  'observe',
  'schema',
  'seed',
  'shot',
  'suite',
  'tenant',
  'test',
  'theme',
  'virtual',
];

/** The database browser, as the shared start reads it (engine cli/startup.ts). */
export const BROWSER: Product = {
  bin: 'tablewalk',
  usage: USAGE,
  shortUsage: SHORT_USAGE,
  commandWords: commandWordsOf(USAGE, 'tablewalk'),
  flagWords: flagWordsOf(USAGE),
};
