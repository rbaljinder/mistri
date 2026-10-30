---
title: Build and deploy
description: Check and bundle an App once in CI with mistri build, then run that build in a container behind a load balancer.
---

Check and bundle an App once in CI with mistri build, then run that build in a container behind a load balancer.

```sh
npx @mistriwork/mistri build --app ./my-app --config ./mistri.json   # typecheck, validate, bundle
npx @mistriwork/mistri migrate up --config ./mistri.json --migrations ./my-app/migrations
npx @mistriwork/mistri migrate stores up --config ./mistri.json --app ./build/my-app  # the stores its commands and jobs use
npx @mistriwork/mistri --config ./mistri.json --app ./build/my-app \
  --commands ./build/my-app/server/commands.mjs
```

<!-- no picture: a build serves the same pages as the source; nothing on screen changes. -->

## What you'll see

- One line per step (typecheck, validation, bundle, database), and an exit code that names the first that failed. The typecheck runs the TypeScript installed in the App's project, which must be 7 or later (the native compiler; `npm i -D typescript`); an older one fails the step. mistri itself needs Node 24.22.1 or newer.
- A `build/my-app/` directory that starts without TypeScript, a watcher or a compile, and is byte for byte the same on every run of the same source.
- A server that re-hashes the build before serving it, and refuses a changed file or a different mistri version.

## When to use it

- Use a build for production: the start-time work is done once, in CI, and a broken App never reaches a server.
- Run the App from its source directory instead while you build it: a save reloads it, and the build is optional.
- The database browser has no build step at all: `npx tablewalk <db>` is its whole deployment.

## Options

| Flag | Does | Default |
| --- | --- | --- |
| `--app <dir>` | The App; its manifest, `pages/` and `authority.lock` travel together | required |
| `--out <dir>` | Where the build goes; replaced only when every step passes | `build/<dir name>` in the current directory, as every path on the command line is; `<dir name>-build` beside an App built from its own directory |
| `--config <path>` | Also runs the database checks and writes the schema types | skipped |
| `--commands`, `--jobs`, `--policy` | The server entries a start takes, bundled | the `commands.ts` beside the App |

| Exit | Meaning |
| --- | --- |
| `0` | Built |
| `1` | Could not build: a bad flag, no `--app`, an `--out` it will not replace |
| `2` | Typecheck errors |
| `3` | Validation: the App does not load, its `authority.lock` is stale, or the database check found problems |
| `4` | Bundle: a module could not be resolved or transformed |

The bundler is [Rolldown](https://rolldown.rs), an optional dev dependency; without it each module is type-stripped on its own. Bundles keep source maps: run Node with `NODE_OPTIONS=--enable-source-maps` and a stack trace names the App's TypeScript line.

## In a container

Build in one stage; ship the build and the pruned `node_modules`:

```dockerfile
FROM node:24-alpine AS build
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci
COPY my-app ./my-app
RUN npx @mistriwork/mistri build --app my-app --out build/my-app --commands my-app/commands.ts
RUN npm prune --omit=dev

FROM node:24-alpine
RUN apk add --no-cache tini
WORKDIR /srv
ENV NODE_ENV=production
COPY --from=build /srv/package.json ./
COPY --from=build /srv/node_modules ./node_modules
COPY --from=build /srv/build ./build
USER node
ENTRYPOINT ["/sbin/tini", "--", "node_modules/.bin/mistri"]
CMD ["--host", "0.0.0.0", "--config", "/config/mistri.json", \
     "--app", "build/my-app", "--commands", "build/my-app/server/commands.mjs"]
```

`mistri build --app my-app --commands my-app/commands.ts --dockerfile Dockerfile` writes that file for you from the same options: the build stage runs the build you named, and the runtime stage is tini, uid 1000, `--host 0.0.0.0`, `PORT` (the platform's, else 4111) and a health check on `/healthz`. Nothing is built by the command itself; run `docker build .` from the project root, where `package.json` and `package-lock.json` are. A `--config` is copied to `/config/mistri.json` and read at start, so keep every secret in it a `${NAME}`.

A build can sit anywhere — beside the App, or copied away from the project that made it: its `mistri/…` imports are answered by the mistri that serves it, the one version it is pinned to. Only a package the App installed itself needs a `node_modules` above the build.

The build stage has no database, so also run `mistri build --config …` against a staging database in CI. `examples/docker` builds Tick this way, and `DEPLOY.md` covers binding, publishing and allowed hosts.

On Cloudflare Containers, `mistri deploy` does the rest. See [Deploy to Cloudflare](#deploy-to-cloudflare).

## Deploy to Cloudflare

`mistri deploy` checks, migrates, deploys and verifies an App on Cloudflare Containers: a Worker in front of one always-on container, with `wrangler` as your devDependency.

```sh
npx @mistriwork/mistri deploy init cloudflare --app ./my-app --config ./mistri.json  # writes deploy/cloudflare/, creates nothing
cd deploy/cloudflare && npm install && npx wrangler secret put BETTER_AUTH_SECRET     # and each secret init names, and MISTRI_RESTART_TOKEN
npx @mistriwork/mistri deploy --dry-run    # the plan: check, secrets, pending migrations, backup check
npx @mistriwork/mistri deploy              # confirm, then build, migrate, wrangler deploy, wait for the new container
npx @mistriwork/mistri deploy status       # the live fingerprint, recent deploys, the newest five Cloudflare deployments
npx @mistriwork/mistri deploy verify       # re-check the newest deploy against /readyz and the smoke, and correct its record
npx @mistriwork/mistri deploy rollback     # the previous deploy, verified the same way
```

A deploy is done when `/readyz` reports the new deploy's id and the new build's id, not when the Worker is uploaded. The build id is a fingerprint of the build's inputs (the App's files, `package.json`, `package-lock.json` and the mistri version), so your machine and the image agree on it without building identical bytes. Migrations run from your machine before the code changes, so they must be expand-only. The versioned migrations go over `--migrate-url` (or `MISTRI_MIGRATE_URL`), a direct database address. The App's own stores (`migrate stores up`) do not: they use the store URLs the App's config names, read from the environment you run `mistri deploy` in, so set those variables there too; a step marked `-- mistri: contract` is its own later deploy (`--allow-contract`). `--backup-check <cmd>` refuses on a non-zero exit, and `--smoke <cmd>` runs your own check afterwards. Cloudflare Containers do not autoscale: this runs one instance. `wrangler deploy` does not replace a running container under the `durable_object` scheduling policy, so the container class (`@mistriwork/cloudflare`) records what it started the container with and, once its Durable Object runs the new Worker version, replaces a container whose image or deploy id differs. The platform moves a running Durable Object onto a new Worker version only after about five minutes, so the Worker stamps its version on the probe and the once-a-minute tick and an object behind it resets itself: a roll takes under a minute. The roll polls `/readyz` and a token-gated `GET /__mistri/status` every 5 seconds, prints a timeline of what it sees, and sends the restart only if the container still lags the Durable Object after a minute. Add `"version_metadata": { "binding": "CF_VERSION_METADATA" }` to an older `wrangler.jsonc` to have the probe report the Worker version. If the roll or the smoke fails after `wrangler deploy`, the new Worker is already serving: fix the cause, then `mistri deploy verify` (add `--roll` to fall back to a restart if the container lags) or `mistri deploy rollback`. `wrangler` reads its login from `$XDG_CONFIG_HOME/.wrangler` when that is set, so a shell whose `XDG_CONFIG_HOME` differs from the one used at `wrangler login` reports "not logged in".

## Where an App is served

One App is served at the root (`https://host/leads/127`). Several each keep their id (`https://host/billing/invoices/9`), and `--mount main=/` (or `"mount"` in the config) puts one at the root beside them. Behind a proxy that serves mistri under a path, say so once with `--base-path /tools` (or `"basePath"`, or `MISTRI_BASE_PATH`): every page, asset, cookie and emailed link then carries it. `mistri check --app ./main --routes` prints the addresses as served.

An App that signs people in needs a server of its own; put several behind one proxy, each under its own path. Its session cookie is scoped to that path, so two Apps on one host never read each other's session.

## Behind a load balancer

Run several instances of the same image and config, each stateless:

- **PostgreSQL holds the state**: business data, the command journal, events, jobs, and sessions in a `postgres://` `auth.store`. A SQLite source or the default session file ties the App to one instance. `mistri check --app ./my-app --config ./mistri.json --deploy --replicas 3`, run with the deployment's environment, refuses a SQLite source or `auth.store`, the default `auth.store`, a missing `BETTER_AUTH_SECRET`, and a public page's door without `MISTRI_FORM_KEY`, before a deploy does. It also prints each database's connection sum ("3 processes × 41 connections = 123": read and write pools, the background writer, LISTEN, read replicas, the sign-in store); add `--connection-limit <n>`, the connections the database allows this role, and a larger sum fails the check. The sum includes the hosts the App serves with (jobs, effects, integrations; pass `--jobs <file>` so the check can read them), and sizes the pool defaults for this machine's cores unless you pass `--cpus <n>`, the deployment's. It also reads the migrations not yet applied and warns about a statement that breaks the code still running during the deploy (a dropped or renamed column or table, a type change, `SET NOT NULL`, a `NOT NULL` column without a default, a dropped view or function), naming the file, line and how to stage it as expand, deploy, contract. A deliberate contract step carries `-- mistri: contract` on the line before it and is then a note; `--strict-migrations` makes the rest fail the check. It reads the database's history read-only to know what is pending, and when it cannot reach it, judges every versioned file and says so.

  ```sql
  -- mistri: contract (the code stopped reading it in 1.4)
  ALTER TABLE orders DROP COLUMN legacy_status;
  ```
- **Valkey holds what instances share**: rate limits and cached API answers, through a [cache connection](/docs/services/#the-cache-kind-cache).
- **One `MISTRI_FORM_KEY` for every instance** (32 bytes or more, `openssl rand -base64 32`), where the App has a public page that runs commands: that page's door signs its tickets with it. Without it each process signs with a key of its own and refuses the others' tickets, so a start that names a cache service or `WEB_CONCURRENCY` above one refuses, a production start (`NODE_ENV=production`, or a build served) warns, and `check --deploy` says so. The same key hashes a public form's keyed inputs.
- **Name the proxy**: `--allowed-host` (or `MISTRI_ALLOWED_HOSTS`), `--trust-proxy` for the balancer whose `X-Forwarded-For` rate limiting may believe (a managed front end with no address to name, such as Cloud Run, takes `--trust-proxy-hops 1`; one behind Cloudflare alone takes `--trust-proxy-cloudflare`; without either, every visitor shares one rate limit and one sign-in lockout), and `MISTRI_PUBLIC_URL` for the address sign-in answers to (with or without the `--base-path`; either names the same place). Apps that sign people in need a fixed `--port`. Sign-in at an `http://` public address beyond this machine is refused at startup, since passwords would cross the network in the clear: set `MISTRI_PUBLIC_URL` to the proxy's `https://` address, or bind loopback behind it; `--insecure-http-sign-in` (`MISTRI_INSECURE_HTTP_SIGN_IN=1`) serves it anyway, with a warning.
- **Health checks** poll `/healthz` for liveness and `/readyz` for readiness ([health and readiness](/docs/observe/#health-and-readiness)). Under `--base-path /desk` every route moves, the probes too: `/desk/healthz`, `/desk/readyz`.
- **Stopping**: on SIGTERM `/readyz` answers 503 at once, then the listener closes, accepted work drains, and a response that never finishes is cut after `--shutdown-grace` (10 s). A balancer that probes needs a beat between the first 503 and the close: `--drain-delay 5` (or `MISTRI_DRAIN_DELAY`) keeps the listener answering that long. Cloud Run allows 10 s in all, so leave the drain at 0 there or lower the grace; ECS and Kubernetes allow more (`stopTimeout`, `terminationGracePeriodSeconds`), and the drain plus the grace must fit inside them.
- **Every instance runs `--jobs`**: a job's slot runs once however many processes serve the App (leases in the job store), and `--jobs` is also what serves the App's inbound endpoints, so whichever instance the balancer picks must have it.
- **Migrations run before the rollout**, never at start; every instance only checks that the stores are there.

## A suite: mounted Apps

A [suite](/docs/suites/) is several Apps under one host, such as a lender at `/` and its other Apps at `/leads`, `/dealer`, `/site`, `/marketplace` and `/customer`. In production, supervise each as its own process, terminate TLS at the proxy, forward each path to its process with the host preserved, and set `MISTRI_PUBLIC_URL` and each App's `--base-path`. The lender's `/` is the proxy's fallback after the five subpaths. Mounting under one host shares no sign-in and grants no cross-App access. No shipped example is a suite; [Suites](/docs/suites/) has the launcher.

## A tenant App

A [tenant App](/docs/tenant-apps/) adds its policy and a first boot. Build it with `--policy ./app/policy.ts`; the build bundles it as `server/policy.mjs`, the Dockerfile it writes starts with it, and every step below names it. Before the first rollout, over the direct port:

```sh
P="--config ./mistri.json --app ./build/app --policy ./build/app/server/policy.mjs"
node -e "import('@mistriwork/mistri/maintenance').then((m) => m.migratePostgresAuthStore(process.env.MISTRI_AUTH_STORE))"
npx @mistriwork/mistri migrate stores up $P          # the tenant store, its journals, and the rest
npx @mistriwork/mistri tenant init north south $P    # the platform realm and the first tenants
MISTRI_ACCOUNT_PASSWORD=… npx @mistriwork/mistri tenant grant ops@lender.example --roles manager $P
```

- **`auth.store`** is a PostgreSQL database of its own, as `"${MISTRI_AUTH_STORE}"`, never the business database: a start refuses that. `migratePostgresAuthStore` makes its schema once.
- **`MISTRI_AUDIT_KEY`** (32 bytes or more), with support access: set for provisioning and every start, and kept for good beside the backups. Without it the support audit's past cannot be verified.
- **A restart** of the same build on an unchanged PostgreSQL catalog skips the catalog checks: `migrate stores up` makes a validation record, and each start of a build writes down what it checked. A changed catalog, a missing record, `mistri dev` and `mistri check` check in full. The startup line says which happened.
- **`init` and `grant`** each run again safely: a tenant already there is left, and an address that already has an account is granted, not remade.
- **Name the proxy here too**: the tenant host takes `--trust-proxy` (or `--trust-proxy-hops`, `--trust-proxy-cloudflare`) as the ordinary host does, for its sign-in, its App API and its public forms and reads, so each visitor behind the balancer keeps a rate limit of their own and the human check is told the visitor's address, not the proxy's.

## Back up and restore

Back up the databases and the secrets together; nothing else mistri keeps is outside them.

```sh
pg_dump -Fc "$DATABASE_URL" -f crm.dump                      # PostgreSQL: the App's tables and the `mistri` schema, in one snapshot
pg_restore --clean --if-exists --no-owner -d "$TARGET_URL" crm.dump
sqlite3 crm.db ".backup 'crm.backup.db'"                   # SQLite, while it runs: never a copy of the live file
```

What holds what:

- **The business database** holds your tables and, with them, the runtime stores that must agree with the rows: the command journal and receipts, record history, the inbox, jobs, workflows, events and deliveries, the email outbox, and a tenant App's tenant store, administration journal, invitations and support audit. On PostgreSQL the runtime is the schema `mistri`; `pg_dump` of the database takes both, and `-n public -n mistri` takes both when you dump by schema. Restore them as one, so receipts and history describe the rows they sit beside.
- **The sign-in store** (`auth.store`, by default `~/.config/mistri/auth/<app>.db`, `$XDG_CONFIG_HOME` when set) holds the accounts, their sessions and the API tokens. It is a database of its own, so back it up on the same schedule; lost, nobody can sign in until accounts are made again and every token is reissued.
- **A suite's** identity, grant, preference, flag and experiment databases, where the suite config puts them.
- **Files** with `storage: 'bucket'` are in the bucket; a row names its object, so keep the bucket's versioning or backup in step with the database.
- **The secrets**, in your platform's secret store, not in a dump: `BETTER_AUTH_SECRET`, `MISTRI_FORM_KEY` (changing it leaves every kept hash unmatched) and, for a tenant App with support access, `MISTRI_AUDIT_KEY` ([below](#the-audit-key)).

On a managed PostgreSQL, point-in-time recovery restores the whole instance, or a new one, to a moment, which is the consistent snapshot the first bullet asks for; restore the sign-in store to the same moment when it is on the same server. Test a restore on a scratch database before you need it.

Restore with the server stopped: the databases first, then the stores, then start. A start checks the journal and the stores and refuses what does not match, rather than creating anything. SQLite files are copied only while the server is stopped, with any `-wal` and `-shm` beside them.

Take this backup before `mistri migrate stores up`: a step has no reverse. To go back, restore the backup and run the mistri that made it, which refuses a newer layout by name. The tables `__mistri_schema_snapshot` and the PostgreSQL `mistri.schema_epoch` (SQLite has no epoch table) are caches mistri rebuilds, not stores.

### The audit key

`MISTRI_AUDIT_KEY` (32 bytes or more, apart from `BETTER_AUTH_SECRET`) seals only a tenant App's support audit, the chained record of what an operator did inside a tenant. It is not used by sign-in or any other store.

- **There is no rotation.** A store is provisioned under one key and verified only with it; starting with another is refused ("A new key needs a new support audit store"), and so is revoking a support membership.
- **To change the key**, keep the old store and the old key together as an archive (`verifyPostgresSupportAudit` or `verifySqliteSupportAudit`, from `@mistriwork/mistri/maintenance`, check the old chain with the old key), then provision a new support audit store under the new one. The old and new chains are not linked.
- **A lost key** cannot be recovered: the audit's past is unverifiable, though its rows still read. Treat the old store as unverified evidence, and provision a new store and key to carry on.

## Common mistakes

- `--commands ./my-app/commands.ts` beside a build is refused → name the build's own entry, `./build/my-app/server/commands.mjs`; the refusal prints it.
- A build refuses to start after an upgrade → a build is pinned to the mistri version that made it; rebuild in the pipeline that installs the new one.
- Exit `3` with "the effective authority differs from the lock" → review the change, run `mistri check --app <dir> --write-authority` in the source, then rebuild.
- `Cannot find package '<name>'` at start → a package the App's commands or jobs import is resolved from the build's folder upward: ship the `node_modules` that holds it above the build. `mistri/…` itself needs none: a build's `@mistriwork/mistri/commands`, `@mistriwork/mistri/jobs` and siblings are the serving mistri's own, wherever the build is put.

## Related

- [Connections and services](/docs/services/): the config file the server reads.
- [Change your schema](/docs/change-your-schema/): migrations before the rollout.
- [Reload and restart](/docs/reload-and-restart/): a build is never watched.
- [Observe and operate](/docs/observe/): readiness, traces and redrive in production.
- [Performance and pools](/docs/performance/): how many connections a rollout opens.
