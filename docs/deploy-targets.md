# Deploy targets: Cloud Run, ECS Fargate, Cloudflare Containers

A design note, not a guide. It decides how a built App runs as a container on
three hosts with PlanetScale Postgres as the database, names what mistri
must change before 1.0 for that to be clean, and plans the smallest real
deploy that would prove each. One of the three, Cloudflare Containers on
PlanetScale Postgres, has run a real deployment (below); Cloud Run and ECS
Fargate have not been deployed, and what is said of them is design, not proof.

The cloud facts were read on **2026-10-18** from each vendor's own pages
(linked at the end). These products change month to month; a figure older
than a few months should be re-read before anyone spends against it. What is
said about mistri is read from the source and cited by path.

## What has run

A field deployment ran for several days on **Cloudflare Containers**, one
`standard-1` instance, against **PlanetScale PostgreSQL**. A 75-minute load
test held 25 heavy users steady for an hour:

| | |
| --- | --- |
| Errors | 0.33% |
| Request latency | p50 189 ms, p95 1.7 s, p99 2.9 s |
| Heap over the hour | flat: 156.9 MB to 157.3 MB |
| Garbage collection | 3.5% of CPU |

One `standard-1` instance saturated between 25 and 50 heavy users. At 50 the
median was 1.95 s, p99 13.3 s, and 1.6% of requests failed. So the
single-instance limit below is measured, not assumed: past it, add instances
(which needs the shared stores in G1) or a larger class. Cloud Run and ECS
Fargate are unproven.

## The decision in brief

| | Cloud Run | ECS Fargate (Express Mode) | Cloudflare Containers |
| --- | --- | --- | --- |
| Verdict | **First target.** Fits the contract with least glue | **Second.** Fits, more pieces, most control | **Third, single instance only** until it autoscales |
| Shape | One service, instance billing, min 1 | One service behind the shared ALB, 1–N tasks | A Worker in front of a fixed set of instances |
| Small-App cost | ~$45/month | ~$40/month | ~$15/month |
| Reason to pick | Managed TLS, probes, streaming, jobs for migrations | Fine-grained network, IAM roles, long stop timeout | Cheapest, Cloudflare already holds the domain |

AWS App Runner is **not** a candidate: it stopped taking new customers on
2026-04-30 and is in maintenance mode, and AWS points people at ECS Express
Mode instead. It also never carried WebSockets. Fargate is the AWS answer.

PlanetScale Postgres goes behind its managed PgBouncer (port 6432) with
`--pooler transaction` for the App's traffic, and directly (port 5432) for
the session store, migrations and store upgrades. Saves are a fixed number of
round trips and pipeline through the pooler (see PlanetScale Postgres below).
The pooler's own server pool, not the App's, is what fills `max_connections`:
size it to leave room for the direct connections (Connections, below).

## What mistri keeps, and where

Everything durable is a database mistri is told to use. The registry of
its own tables is `packages/mistri/src/server/storeLayouts.ts`; each store moves only through
`mistri migrate stores up`, never at start.

| Store | Where it lives | Engines | Durable? |
| --- | --- | --- | --- |
| Sign-in accounts, sessions (`auth`) and `api-tokens` | `auth.store`; default a SQLite file at `$XDG_CONFIG_HOME/mistri/auth/<app>.db` (`defaultStore`, `packages/mistri/src/server/auth/auth.ts:1146`) | SQLite, PostgreSQL | Yes. Lost, everyone is signed out |
| Command journal, sequences, events, event delivery, jobs, workflows, public placement | Beside the App's commands, on its source | SQLite, PostgreSQL | Yes |
| Record history, inbox, branding, assistant, mail, integrations | The App's source | SQLite, PostgreSQL | Yes |
| Tenant store, invitations, administration, support audit, sandboxes | The tenant platform's database | SQLite, PostgreSQL | Yes |
| Flags, experiments | Configured store | **PostgreSQL only** | Yes |
| Analytics | `analytics.store` in the config | SQLite, PostgreSQL | Yes |
| Suite grants, preferences, authority | `identity.grants`: three files beside the suite's identity store, or three schemas of one PostgreSQL database (`packages/mistri/src/server/auth/suiteStoresPostgres.ts`) | SQLite, PostgreSQL | Yes |
| Rate limits, sign-in lockouts, cached API answers | A `cache` connection (Valkey), else **the process's memory** | Valkey | No, but per-process without a cache |
| File bytes | The row (`content: 'data'`) or an S3-compatible bucket (`storage: 'bucket'`, `src/server/files/`) | — | Yes |
| Record layouts (Workbench only) | `$XDG_CONFIG_HOME/tablewalk/layouts.json` (`packages/engine/src/server/layouts.ts`) | file | Not for Apps |
| Image variants | `MISTRI_IMAGE_CACHE`, else a private temp folder (`packages/mistri/src/server/http/imageVariants.ts`); also, for a public resource, the file resource's bucket (`<prefix>_variants/<app>/`, re-creatable, so a lifecycle rule may expire it; the files sweep deletes the copies of removed pictures) | file, then bucket | No, a cache; the bucket's copies are shared by instances |
| V8 compile cache | `~/.cache/mistri/compile`, failure ignored (`packages/mistri/src/server/index.ts:50`) | file | No, a cache |
| Schema snapshot and epoch | `__mistri_schema_snapshot` in the business database, `mistri.schema_epoch` on PostgreSQL | — | Rebuilt |

So the rule for a container is short: **every store a `postgres://` URL, no
SQLite file anywhere, files in the row or a bucket, a Valkey cache once
there is more than one instance.** The site's
[Build and deploy](../site/src/content/docs/docs/build-and-deploy.md#behind-a-load-balancer)
already says this; what is missing is anything that refuses the wrong shape
(G1).

A suite on PostgreSQL (G7) gives up one thing the SQLite suite has. On
SQLite a child App's grant is read in the same turn as the decision it
admits, so nothing can change between the read and the write. On
PostgreSQL the read is awaited: the projection reads the grant again before
and after each await, and a write fences at the last await before
`COMMIT`, as an App's PostgreSQL sessions already do. A grant revoked after
that point takes effect at the next request. Because a SQLite business
store fences its commands on a grant read in the same turn, a suite whose
grants are on PostgreSQL refuses at start to serve an App whose connections
are not PostgreSQL too.

## Process model

One Node process per container (`packages/mistri/src/server/cli/serve.ts`). There are no
workers or child processes. Inside it, beside the HTTP server:

- **The jobs host** (`packages/mistri/src/server/jobs/jobHost.ts`), only with `--jobs`: a
  `setTimeout` chain that claims due jobs, backing off to a 30-second idle
  ceiling. A job's slot "runs once however many processes serve the App"
  (site `events-and-jobs.md`), by leases in the job store, so several
  `--jobs` processes are safe. `--jobs` also serves the App's **inbound
  endpoints** (`packages/mistri/src/server/cli/commandHost.ts`), so whichever instance the load
  balancer picks must have it.
- **The effects host** (`packages/mistri/src/server/effects/effectHost.ts`): delivers
  commands' outbound webhooks. It runs wherever `--commands` runs.
- **The email outbox** and contact mail, when an App sends email.
- **The analytics sink**, when configured.
- **Write lanes**: per database, `read + write + 1` PostgreSQL connections at
  most for the App's (or a tenant App's) one request pool, nine by default, and
  five more for the server's stores when it declares any, and the sign-in
  store's own pool (`MISTRI_AUTH_POOL`, default 4) when it is on the same
  database (`docs/postgresql.md`, "Sizing" and "Per database, per process").

Streams are Server-Sent Events, not WebSockets: the assistant
(`packages/mistri/src/server/http/assistantRoutes.ts`), a suite's notices
(`packages/mistri/src/server/http/suite.ts`), and the dev-only reload stream
(`packages/mistri/src/server/app/appLive.ts`, never on a build). Nothing upgrades a socket.

**Consequence: a production App is never scale-to-zero, and its CPU must run
between requests.** Effects, mail and jobs are background loops in the web
process. A host that freezes CPU outside requests (Cloud Run's request
billing) or sleeps an idle container (Cloudflare's default) stalls them until
the next visitor. That is the single most important fact for choosing a
billing mode below.

`build-and-deploy.md` used to say "start `--jobs` in one worker replica",
while `events-and-jobs.md` says slots are safe across processes and inbound
endpoints need `--jobs`. With one load-balanced service, the second is the one
that works: **run every replica identically, with `--jobs`.** The site
sentence now says so (G6, 0.9.6).

## The container contract

Target-neutral; each host below is a mapping of it.

**Image.** The App's own image, built as in `build-and-deploy.md#in-a-container`:
a build stage runs `mistri build`, the runtime stage carries `build/`,
pruned `node_modules`, `tini` as PID 1, uid 1000. The published ghcr image is
the database browser's and is not an App's base: an App's image pins the
mistri version that built it, so `mistri build --dockerfile <file>`
writes the Dockerfile from the build's own options (G6, 0.9.7) instead of a
shared base image. The browser's image is published for `linux/amd64` and
`linux/arm64`; build the App's for `arm64` on Fargate Graviton and `amd64` for
Cloudflare, which has accepted only that.

**Configuration.** `mistri.json` is baked into the image, with every secret
written as `${NAME}` (expanded at open, never sent to the browser,
`docs/deploy.md#passwords-in-a-container`). No volume mounts: none of the three
offers a convenient one, and none is needed.

**Port and bind.** `TABLEWALK_HOST=0.0.0.0`, `TABLEWALK_PORT=4111`; tell the
platform the port is 4111. mistri reads `PORT` when no `--port` is given, and the image's
entrypoint maps it (G6, 0.9.6).

**Environment.**

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `MISTRI_PUBLIC_URL` | `https://app.example.com` (cookies, OAuth callbacks, emailed links) |
| `MISTRI_ALLOWED_HOSTS` | the custom domain and the platform's own hostname |
| `MISTRI_POOLER` | `transaction` |
| `MISTRI_TRUST_PROXY` | the balancer's range, where it is knowable |
| `MISTRI_TRUST_PROXY_HOPS` | `1` on Cloud Run, whose front end has no nameable address; `MISTRI_TRUST_PROXY_CLOUDFLARE=1` behind Cloudflare alone |
| `BETTER_AUTH_SECRET` | 32+ characters, from the platform's secret store |
| `MISTRI_AUDIT_KEY` | a tenant App with support access: 32+ bytes, apart from `BETTER_AUTH_SECRET`, kept for good (the support audit's past is verified with it) |
| `APP_DB_PASSWORD` etc. | referenced from `mistri.json` |
| `MISTRI_S3_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` | when files go to a bucket and the platform gives no role (an ECS task role, or EC2's with `MISTRI_S3_INSTANCE_ROLE=1`, is read instead: G3, 0.9.7) |
| `MISTRI_DRAIN_DELAY`, `MISTRI_SHUTDOWN_GRACE` | seconds; see Shutdown (G5, 0.9.7) |
| `NODE_OPTIONS` | `--enable-source-maps` |

**Health.** Liveness `GET /healthz`; readiness and startup `GET /readyz`
(503 while starting, while a tenant App's writer is closed after an uncertain
write and reopening, and from shutdown on); both answer before any gate or App
and probe no database (`packages/engine/src/server/http/probes.ts`). Under `--base-path`
they move with it. The repository's `Dockerfile` probes
`/healthz` (G6, 0.9.6).

**Shutdown.** SIGTERM via `tini`: readiness turns 503, the listener closes,
jobs, effects, outbox and analytics stop, accepted work drains, idle sockets
close, and a response that never finishes is cut after `--shutdown-grace`
(`MISTRI_SHUTDOWN_GRACE`, default 10 seconds, `shutdownTimings` in
`packages/engine/src/server/cli/args.ts`). `--drain-delay` (`MISTRI_DRAIN_DELAY`, default 0)
holds the listener open that many seconds after readiness turns 503, so a
balancer that probes sees the 503 before connections are refused (G5, 0.9.7).
The drain, then the work, then the grace must fit inside the platform's stop
timeout: ask for at least 30 seconds where it lets you, and set both flags
under 10 where it does not.

**Timeouts.** mistri's request timeout is 10 minutes, keep-alive 65
seconds (`packages/engine/src/server/serverTimeouts.ts`), longer than an ALB's 60-second
idle, which is the right way round.

**Filesystem.** A read-only root works if `/tmp` is writable (image
variants) and the compile cache is pointed at `/tmp` or disabled
(`NODE_COMPILE_CACHE=/tmp/v8` or `NODE_DISABLE_COMPILE_CACHE=1`). State must
not live on local disk: no SQLite source, no default `auth.store`, no
analytics file, no suite.

**Instances.** Min 1, always. Max 2–3 for a small App; past one, a Valkey
cache, or every instance keeps its own rate limits and lockouts. Connections:
behind PgBouncer the App's pools cost PgBouncer clients, and PgBouncer opens
server connections up to its own pool size, whatever the instance count; an
`auth.store` pool, a `"listen"` URL or a migration on the direct port costs
real ones beside them. The pooler's pool has to leave room for those (PlanetScale
Postgres, Connections).

**Migrations.** Never at start (stores are attested, not created, at open).
A step before the rollout, from CI or a one-off task, over the direct port:
`migrate up` and `migrate stores up` take a **session** advisory lock
(`packages/engine/src/server/migrate/database.ts`, `packages/mistri/src/server/storeLayouts.ts`), which a
transaction-mode pooler cannot hold.

**A tenant App.** The same contract, with its policy on every step: the build
takes `--policy` and writes it as `server/policy.mjs`, which the generated
Dockerfile's start, `migrate stores up --policy` and the first boot name. Its
`auth.store` is a PostgreSQL database of its own (startup refuses the business
database), migrated once with `migratePostgresAuthStore`. The first boot is a
one-off task after the stores: `mistri tenant init` opens the platform realm
and the first tenants, and `mistri tenant grant` makes the first operator's
account and membership; both run again safely. `tenant-apps.md#deploying-a-tenant-app`
has the order.

## Cloud Run

**Shape.** One service, `--port 4111`, **instance-based billing** ("CPU always
allocated"), min instances 1, max 3, concurrency 80. Secrets from Secret
Manager as environment variables. Migrations as a Cloud Run Job from the same
image (`mistri migrate …` as its command). Region us-central1 or us-east4,
where PlanetScale also runs on GCP.

**Cold starts and zero.** Request-based billing gives no CPU outside requests,
which stalls effects, mail and jobs (above), so it is ruled out for an App.
With min 1 the only cold starts are scale-outs, Node start plus the App load:
a few seconds, to be measured.

**Requests and streams.** Request timeout configurable up to 60 minutes; set
15 so the assistant's stream outlives mistri's own 10. SSE and WebSockets
both work, bounded by that timeout. The container must listen within 4
minutes; a startup probe on `/readyz` holds traffic until it does.

**Shutdown.** SIGTERM, then **10 seconds** to SIGKILL, fixed. mistri's own
grace is also 10, so an in-flight stream is cut; ordinary requests finish.
Leave `--drain-delay` at 0 (the 10 seconds are all the work gets) and, to let
the grace end before the kill, set `--shutdown-grace 8`.

**Domain and TLS.** The `*.run.app` address has managed TLS. A custom domain
is either Cloud Run's domain mapping (still limited in regions as last read)
or a global external Application Load Balancer, about $18/month more. Put
both names in `MISTRI_ALLOWED_HOSTS`.

**Cost, small App** (1 vCPU, 1 GiB, always on, us-central1 Tier 1):
CPU 2,592,000 s less 240,000 free × $0.000018 ≈ $42; memory 2,592,000 GiB-s
less 450,000 free × $0.000002 ≈ $4; no request fee under instance billing.
**≈ $46/month**, plus Secret Manager pennies and internet egress to
PlanetScale.

**Gotchas.**
- The client address: Cloud Run's front end is not an address you can name
  in `--trust-proxy`, so without `--trust-proxy-hops 1` every visitor shares
  one rate-limit budget and one lockout counter (G2, closed in 0.9.6).
- Cloud Run does not pull from ghcr directly; push to Artifact Registry, or
  front ghcr with an Artifact Registry remote repository.
- Egress to PlanetScale is over the internet from shared Google addresses;
  an IP allowlist on PlanetScale needs Cloud NAT and a static address.

## ECS Fargate, through ECS Express Mode

**Shape.** An Express Mode service: a Fargate service, an ALB shared by up to
25 such services (host-header rules), ACM certificate, auto scaling. One task
of 0.5 vCPU / 1 GB on Graviton, desired 1, max 3. Secrets from Secrets
Manager into the task definition. Migrations as a one-off `RunTask` of the
same image, or from CI. Public subnets with a public address avoid a NAT
gateway (~$33/month on its own).

**Cold starts and zero.** Always on; there is no scale-to-zero. A scale-out
task takes tens of seconds (image pull, then the health check).

**Requests and streams.** ALB idle timeout 60 seconds by default; raise it to
300 for SSE that can go quiet. WebSockets work through the ALB.

**Shutdown.** On a rollout ECS deregisters the target, waits the
deregistration delay (default 300 s; set 30), then sends SIGTERM and waits
`stopTimeout` (default 30 s, up to 120). The longest grace of the three.

**Domain and TLS.** ACM certificate on the ALB, free; DNS in Route 53 or
anywhere a CNAME goes.

**Cost, small App** (us-east-1): Fargate arm64 0.5 vCPU × $0.03238/h + 1 GB ×
$0.00356/h ≈ $14; ALB ≈ $16 plus ~$6 of capacity units (shared across up to
25 services); public IPv4 $3.65; logs and secrets ~$3. **≈ $43/month.**

**Gotchas.**
- `MISTRI_TRUST_PROXY` can name the VPC's range, so the client address is
  right here, unlike the other two.
- Bucket credentials: Fargate's task role is read from the container
  credentials endpoint (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`) and renewed
  five minutes before it expires (`packages/mistri/src/server/files/platformCredentials.ts`,
  G3, 0.9.7); no keys in the task definition. Static `MISTRI_S3_*` keys
  still win when set. Give the ALB's deregistration delay the work a drain
  would do, and leave `--drain-delay` at 0 or a few seconds.
- More resources to tear down: a proof must delete the ALB, target groups and
  log groups, not just the service.

## Cloudflare Containers

**Status.** Generally available since 2026-04-13. Autoscaling is still not
shipped: instances are addressed by id, and stateless routing is
`getRandom(binding, N)` over a fixed N, chosen regardless of location.

**Shape.** A Worker on the custom domain whose `fetch` forwards to a
`Container` class (a Durable Object per instance) with `defaultPort = 4111`,
`envVars` filled from Worker secrets, `sleepAfter` long, and a placement
constraint `regions = ["ENAM"]` to sit near PlanetScale us-east-1. Instance
type `basic` (1/4 vCPU, 1 GiB, 4 GB disk) or `standard-1` (1/2 vCPU, 4 GiB).
Migrations from CI; there is no one-off task.

**Cold starts and zero.** An idle instance sleeps after `sleepAfter` (default
10 minutes) and wakes on the next request in 1–3 seconds plus Node's start.
Hosts also restart "on an irregular cadence" with no promised lifetime. A
sleeping instance runs no jobs, effects or mail, so an App needs a Worker
Cron Trigger that wakes it every minute, and must accept that a scheduled job
can be late by a restart.

**Requests and streams.** No fixed request limit. WebSockets and streamed
responses pass through the Worker's `fetch` (not `containerFetch`). Outbound
TCP to any port is allowed while `enableInternet` is on, which PostgreSQL
needs.

**Shutdown.** SIGTERM, then up to 15 minutes to SIGKILL; a deploy rolls
instances gradually.

**Domain and TLS.** A Worker custom domain on a Cloudflare zone: free,
immediate, and the zone `tablewalk.dev` is already there.

**Cost, small App** (`basic`, always awake by the cron): Workers Paid $5;
memory 2,592,000 GiB-s less 90,000 included × $0.0000025 ≈ $6.25; disk ≈
$0.70; CPU is billed on active use only, ~$1 at a light load. **≈ $13/month**;
`standard-1` ≈ $34.

**Gotchas, and where it is unfit.**
- **Unfit for an App that must scale out.** N instances is a number in the
  Worker, not a policy; there is no load- or health-aware routing, and an
  instance that is unready still receives its share.
- **Unfit for latency without placement.** By default an instance starts
  near the visitor, not the database; a page is several PostgreSQL round
  trips, so a visitor in Europe would make a container in Europe talk to
  Virginia. The `regions` constraint fixes this at region granularity only.
- The container's peer is Cloudflare's internal path, so the client address
  needs `CF-Connecting-IP`, which mistri does not read (G2).
- The glue is a package and a command (rc.4). `mistri deploy init cloudflare`
  writes `deploy/cloudflare/`: a Worker of about fifteen lines against
  `@mistriwork/cloudflare`, a `wrangler.jsonc` with the container, its Durable
  Object, the `ENAM` placement and a `* * * * *` cron, and the build request.
  `MistriContainer` is the class a field deployment needed in the end: always
  on (`onActivityExpired` does nothing, so jobs, effects and mail run between
  requests), patient (mistri listens only after its startup checks, and the
  class's own 20 s port wait turned every request during a start into a 500),
  pinned to an image and instance type when the account creates container
  applications from the Durable Object, restartable with a token (a code update
  resets the Durable Object but leaves a running container alone), and it hands
  the Worker's named vars and secrets to the container. `mistriWorker` forwards
  `fetch` to one named instance and touches `/readyz` on the cron;
  `forwardEmail` signs inbound tenant mail to the App.
- `mistri deploy` is the manual runbook as one checked command: plan (check
  --deploy, secrets by name, pending migrations and the contract refusal, a
  backup hook), build, migrations over a direct URL from the operator's machine,
  `wrangler deploy --var MISTRI_DEPLOY_ID:<uuid>`, then a restart until
  `/readyz` answers `{ deploy, build }` with both new ids (the check is of the
  configuration, not liveness: one restart reached the old Durable Object and
  started a container with the old environment), a smoke, and a row in
  `__mistri_deploys`. `rollback` is `wrangler rollback` plus the same
  verification, and refuses past a contract migration. What has actually run is
  in "What has run" above; this has been exercised against a fake runner, not
  yet an account.
- Fine today for: one always-on instance of a small App, a demo, a preview
  per branch.

## PlanetScale Postgres

**Two endpoints, used for different things.**

| Traffic | Endpoint | Why |
| --- | --- | --- |
| The App's reads and writes, its command stores, jobs, events | PgBouncer, port 6432, user `role|bouncer`, `MISTRI_POOLER=transaction` | Server connections stay few however many instances run |
| `auth.store` (sessions, accounts, tokens) | PgBouncer, port 6432, or direct | Since rc.1 its search path and statement cap are set per transaction behind `--pooler transaction` (`packages/mistri/src/server/auth/authStore.ts`); before, it relied on a startup `options` parameter PgBouncer does not carry, and every sign-in failed with `relation "user" does not exist`. Since rc.2 its client pipelines, so each statement and its transaction are one round trip, and a session is read once per `MISTRI_AUTH_SESSION_CACHE` seconds (default 5, `authStoreReads.ts`): a field report had a list page make 116 transactions on it, eleven observations of the session per API call at three round trips each. `MISTRI_AUTH_POOL` (default 4) sizes its pool |
| `migrate up`, `migrate stores up`, `pg_dump` | Direct, port 5432 | Session advisory locks; PlanetScale also advises direct for DDL |

**What transaction mode breaks, and what mistri already does about it.**
PlanetScale lists persistent prepared statements, temporary tables,
`LISTEN`/`NOTIFY`, session advisory locks and session `SET` as unsupported.

| Feature | mistri's use | Behind `--pooler transaction` |
| --- | --- | --- |
| Session `SET` (read-only, statement and lock timeouts, the auth store's search path) | Per connection on the direct path | `SET LOCAL` per transaction (`packages/engine/src/adapters/postgresPooler.ts`); the migration tables' serve-time readers set nothing |
| Prepared statements | None named; user SQL's are cleared | Untrusted leases run the in-transaction half of `DISCARD ALL` |
| Advisory locks | Runtime takes only `pg_advisory_xact_lock`; session locks only in migrations and store upgrades | Fine at runtime; migrations go direct |
| Temporary tables | None at runtime | — |
| `LISTEN`/`NOTIFY` | A jobs host's wake (`packages/mistri/src/adapters/events/postgresCommandEventWake.ts`) | Disabled unless the connection names a direct `"listen"` URL, which carries the `LISTEN`; otherwise the host polls, up to its 30 s idle ceiling (G4, 0.9.7) |

Each statement outside a transaction becomes `BEGIN; SET LOCAL …; stmt;
COMMIT`: a single read costs three round trips instead of one. That is the
price of the pooler, and a reason to keep the container's region next to the
database's. A client that pipelines — every writer, and the `auth.store` pool —
sends the three together and waits once. A save does not pay it per statement: a writer pipelines inside its
transaction, so a save is one flight for the `BEGIN` and what is read behind it,
one for each awaited dependent read or write, and a last one with the `COMMIT`,
and a transaction-mode pooler keeps the pipeline on one server connection.
`test/write-flights.test.ts` holds each sample App's save to that budget.

**Connections.** The App's pools cost PgBouncer clients, but PgBouncer holds
real server connections behind them: up to `default_pool_size` (or the
per-user/database `pool_size`) for each user and database pair it serves, and
it keeps them open. Those share `max_connections` with everything on the direct
port: each instance's `LISTEN` (a connection's `"listen"` URL), a migration or
store upgrade, `pg_dump`, an operator's `psql`. Measured on PS-5
(`max_connections` 25), one App process with pools of 4 and 4 drove PgBouncer
to 18 server connections, which with the one direct `LISTEN` filled what the
server leaves ordinary roles: `psql` and migrations on port 5432 were refused
with "remaining connection slots are reserved for roles with the SUPERUSER
attribute". So size the pooler, not the App:

```
pooler server pool  <  max_connections
                     − reserved slots   (SHOW superuser_reserved_connections; SHOW reserved_connections)
                     − instances × 1    (each one's direct LISTEN)
                     − 1                (a migration or store upgrade)
                     − admin sessions   (psql, pg_dump)
```

On PS-5 that leaves a pooler pool well under 20; a pool of 10 keeps `psql`
and a migration working beside two instances. Watch `max_client_conn` too
(below). Use the pooler port for the App, the direct port for DDL, migrations
and `pg_dump`.

**TLS.** PlanetScale's examples end `?sslmode=verify-full&sslrootcert=system&sslnegotiation=direct`.
`node-pg` (pg-connection-string 2.14.0, `node_modules/pg-connection-string/index.js`)
reads `sslrootcert` as a **file path**, so `system` was a file that did not
exist and the connection failed at open. mistri now strips
`sslrootcert=system` before `pg` sees the string and asks for a verified
connection (`pgConnectionOptions`, `packages/engine/src/adapters/postgresValues.ts`): the
chain and host name are checked against Node's default CA bundle, which is
verify-full. `sslnegotiation=direct` is understood by `pg` itself. A real path
still works. A field deployment has since run against PlanetScale PostgreSQL (see "What has run").

**Branching.** A PlanetScale Postgres branch is a separate cluster: empty, or
restored from a backup with schema and data. There are no deploy requests and
no schema merge between branches. That suits mistri's model, where
reviewed `V__` files (written by the `schema.sql` diff,
[schema-sql.md](../site/src/content/docs/docs/schema-sql.md))
are the only way schema moves: run `migrate up` against a branch restored from
last night's backup in CI, then against `main` before the rollout. `check
--pending` copies the database with `CREATE DATABASE … TEMPLATE`, which needs
`CREATEDB`; whether a PlanetScale role has it is unverified, and a branch is
the better scratch copy: `check --pending-on <branch url>` runs the pending
migrations on it instead of copying (G10, 0.9.7).

**Where mistri's own stores go.** In the App's database, beside its rows
(on PostgreSQL in the `mistri` schema: `pg_dump -n public` dumps the App, `-n
mistri` the runtime, and the schema is `REVOKE ALL … FROM PUBLIC`),
so one backup holds the journal consistent with the data
(`build-and-deploy.md#back-up-and-restore`; on PostgreSQL `pg_dump -n public`
takes the App's data and `-n mistri` the runtime state). `auth.store` can be the same
database over the direct port. Flags and experiments need PostgreSQL and
are fine here.

**Size.** PS-10 single node (1/8 vCPU, 1 GiB, $10/month arm64) for a proof;
HA from $30. Watch PgBouncer's `max_client_conn` (100 per bouncer) against
instances × (read + write + 2), and five more each when the App declares jobs
or another server store.

## Gaps before 1.0, ranked

Ranked by how badly a first real deploy goes without it. Sizes are focused
working days including tests and the prose that states the fact.

| # | Gap | Why it ranks here | Size |
| --- | --- | --- | --- |
| G1 | **Done in 0.9.6** (`mistri check --deploy [--replicas <n>]`, the command only: `NODE_ENV=production` is set by every image and by hosts that run one container on a volume with SQLite, which is supported, so a start does not refuse on it). **Deploy preflight**: `mistri check --deploy` (and the same refusal at a `NODE_ENV=production` start) naming every store a start will open and refusing a SQLite file, the default `auth.store`, a SQLite source; warning on per-process rate limits | Without it the likeliest first deploy works, then signs everyone out on every restart and keeps a session per instance | 3–4 |
| G2 | **Done in 0.9.6** (`--trust-proxy-hops`, `--trust-proxy-cloudflare`). **Client address on managed front ends**: trust the nearest hop by count (`--trust-proxy-hops 1`) and read `CF-Connecting-IP` from Cloudflare | Today, on Cloud Run and Cloudflare, all visitors share one rate-limit budget and one sign-in lockout: one attacker locks everyone out | 1–2 |
| G3 | **Done in 0.9.7** (ECS task role, EC2 IMDSv2 behind `MISTRI_S3_INSTANCE_ROLE=1`, refreshed; GCS by HMAC in `file-storage.md`). **Bucket credentials from the platform**: ECS task role and EC2/IMDS credentials in the SigV4 signer, refreshed; GCS by HMAC documented | Long-lived keys in env are the only option on AWS today | 2 |
| G4 | **Done in 0.9.7** (a connection's `"listen"`, for an App's job host and a tenant App's). **`LISTEN` on a direct URL under `--pooler transaction`**: an optional `listen` URL on the connection | Cross-instance facts wait up to 30 s; also stops idle polling against a metered database | 1 |
| G5 | **Done in 0.9.7** (`--drain-delay`, `--shutdown-grace`). **Drain**: a configurable delay between `/readyz` failing and the listener closing, and `SHUTDOWN_GRACE_MS` as a setting | Cloud Run gives 10 s in all; balancers that probe need a beat before the close | 1 |
| G6 | **Done in 0.9.7** (health check, `PORT` and the jobs sentence in 0.9.6; `mistri build --dockerfile <file>` writes an App's Dockerfile, and the release image is built for `linux/amd64` and `linux/arm64`). **Container polish**: `Dockerfile` health check on `/healthz`; honour `PORT`; an App base image or `mistri build --dockerfile`; multi-arch publish; fix the "one worker replica" sentence | Each is small; together they are the difference between the docs and the first try | 2 |
| G7 | **Done in 0.9.7** (`identity.store` and `identity.grants` as `postgres://` URLs, together or not at all; the grants, preferences and authority history are schemas of the grants database; a write fences its grant re-read at the last await before `COMMIT`, as PostgreSQL sessions already do). **Suite stores on PostgreSQL** (grants, preferences, authority were SQLite-only) | Only suites; a suite could not run stateless at all | 3 |
| G8 | **Done in 0.9.6.** **`sslrootcert=system`**: accept it as "the system CAs" when parsing a connection URL | The first string a PlanetScale user pastes fails | 0.5 |
| G9 | **Done in 0.9.7, now `mistri deploy` and `@mistriwork/cloudflare` (rc.4).** **Cloudflare glue**: a Worker template, `wrangler.jsonc`, keep-awake cron | Only if Cloudflare is pursued | 1–2 |
| G10 | **Done in 0.9.7** (`--pending-on <url>`, any engine). **`check --pending` against a named scratch database** (`--pending-on <url>`) instead of `CREATE DATABASE … TEMPLATE` | Hosted roles often lack `CREATEDB`; a branch is the better copy | 1 |

Not gaps: health endpoints, sessions in PostgreSQL, the command stores on
PostgreSQL, transaction-pooler safety, uploads to S3/R2, graceful shutdown.
They exist; G1 and G5 tightened the last two. "Stateless sessions" (signed
cookies with no store) is deliberately not proposed: a store-backed session
is what makes sign-out and revocation real.

About 16–19 days for G1–G8 and G10; G1, G2, G6 and G8 (about a week) are
the minimum before a proof is worth paying for.

## Proof plan

One App, the same image on all three, one PlanetScale database. The App is
Lintel, the flagship, because it carries a row policy, commands, jobs at
times, effects and the stores they use, with PostgreSQL as its target. Lintel
is not a tenant App: a tenant App's proof adds its first boot (`tenant init`
and `tenant grant` as the one-off task) and a sign-in on a platform lease and a
tenant's after a restart. A
proof passes when, on each host:

1. A CI step runs `migrate up` and `migrate stores up` over the direct port,
   then the service starts and `/readyz` turns 200.
2. Sign in, restart every instance, still signed in.
3. Two instances: a scheduled job's slot runs once (the job store's rows say
   so), an inbound endpoint answers on both.
4. A rollout while a script saves in a loop: no 5xx other than `server_busy`
   or `row_locked` with `not_applied`.
5. An upload lands in the bucket (R2 for Cloudflare, S3 for AWS, GCS by HMAC
   for Google) and downloads after a restart.
6. Measured and written down: cold start, p50/p95 of a record page, the
   client address the log records, round trips through PgBouncer.
7. Torn down, and the bill checked a day later.

| Target | Runs for | Expected cost | What I need from you |
| --- | --- | --- | --- |
| PlanetScale | the whole proof, ~2 weeks | ~$5 (PS-10 single node, prorated) | An organization with billing, and a service token scoped to one database |
| Cloud Run | 3 days | ~$5, mostly covered by the free tier | A GCP project with billing; a deploy service account key or Workload Identity for CI; Artifact Registry and Secret Manager enabled |
| ECS Fargate | 3 days | ~$5 (the ALB is most of it) | An AWS account; an IAM role for CI with ECS, ECR, ELB, Secrets Manager and S3 rights; a budget alarm |
| Cloudflare | 3 days | $5 Workers Paid (if not already on it) + ~$1 | An API token with Workers, Containers and R2 edit on the account that holds `tablewalk.dev` |

Total under $25 if each is torn down on schedule; I would ask for a $50 cap.
Before spending: G1, G2, G6 and G8 land first, so the proof tests the
platform and not the gaps. Each account gets a budget alert before the first
deploy. Nothing is created until you say so, and secrets go into each
platform's store, never into the repository or `.notes/`.

## Sources (read 2026-10-18)

- Cloudflare Containers: [limits](https://developers.cloudflare.com/containers/platform-details/limits/),
  [pricing](https://developers.cloudflare.com/containers/pricing/),
  [FAQ](https://developers.cloudflare.com/containers/faq/),
  [scaling and routing](https://developers.cloudflare.com/containers/platform-details/scaling-and-routing/),
  [outbound traffic](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/),
  [placement](https://developers.cloudflare.com/containers/platform-details/placement/),
  [GA changelog, 2026-04-13](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/).
- Cloud Run: [container contract](https://docs.cloud.google.com/run/docs/container-contract),
  [pricing](https://cloud.google.com/run/pricing).
- AWS: [App Runner availability change](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html),
  [ECS Express Mode](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-overview.html);
  Fargate (arm64) and ALB rates are AWS's published us-east-1 rates, not
  re-read today: confirm them in the pricing calculator before the proof.
- PlanetScale: [PgBouncer](https://planetscale.com/docs/postgres/connecting/pgbouncer),
  [branching](https://planetscale.com/docs/postgres/branching),
  [pricing](https://planetscale.com/pricing).
