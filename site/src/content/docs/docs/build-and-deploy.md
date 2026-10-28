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

- One line per step (typecheck, validation, bundle, database), and an exit code that names the first that failed. The typecheck runs the TypeScript installed in the App's project, which must be 7 or later (the native compiler; `npm i -D typescript`); an older one fails the step. mistri itself needs Node 24 or newer.
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

On Cloudflare Containers, `examples/deploy/cloudflare` is a Worker, a `wrangler.jsonc` and a once-a-minute cron that keeps the container awake, to copy beside the generated Dockerfile. It runs a fixed number of instances (Cloudflare does not autoscale) and is a template, not a tested deploy.

## Where an App is served

One App is served at the root (`https://host/leads/127`). Several each keep their id (`https://host/billing/invoices/9`), and `--mount main=/` (or `"mount"` in the config) puts one at the root beside them. Behind a proxy that serves mistri under a path, say so once with `--base-path /tools` (or `"basePath"`, or `MISTRI_BASE_PATH`): every page, asset, cookie and emailed link then carries it. `mistri check --app ./main --routes` prints the addresses as served.

An App that signs people in needs a server of its own; put several behind one proxy, each under its own path. Its session cookie is scoped to that path, so two Apps on one host never read each other's session.

## Behind a load balancer

Run several instances of the same image and config, each stateless:

- **PostgreSQL holds the state**: business data, the command journal, events, jobs, and sessions in a `postgres://` `auth.store`. A SQLite source or the default session file ties the App to one instance. `mistri check --app ./my-app --config ./mistri.json --deploy --replicas 3`, run with the deployment's environment, refuses a SQLite source or `auth.store`, the default `auth.store`, a missing `BETTER_AUTH_SECRET`, and a public page's door without `MISTRI_FORM_KEY`, before a deploy does.
- **Valkey holds what instances share**: rate limits and cached API answers, through a [cache connection](/docs/services/#the-cache-kind-cache).
- **One `MISTRI_FORM_KEY` for every instance** (32 bytes or more, `openssl rand -base64 32`), where the App has a public page that runs commands: that page's door signs its tickets with it. Without it each process signs with a key of its own and refuses the others' tickets, so a start that names a cache service or `WEB_CONCURRENCY` above one refuses, a production start (`NODE_ENV=production`, or a build served) warns, and `check --deploy` says so. The same key hashes a public form's keyed inputs.
- **Name the proxy**: `--allowed-host` (or `MISTRI_ALLOWED_HOSTS`), `--trust-proxy` for the balancer whose `X-Forwarded-For` rate limiting may believe (a managed front end with no address to name, such as Cloud Run, takes `--trust-proxy-hops 1`; one behind Cloudflare alone takes `--trust-proxy-cloudflare`; without either, every visitor shares one rate limit and one sign-in lockout), and `MISTRI_PUBLIC_URL` for the address sign-in answers to (with or without the `--base-path`; either names the same place). Apps that sign people in need a fixed `--port`.
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

mistri keeps nothing of its own beside what it is told to use, so a backup is the databases and the stores the config and the App name:

- **The business database**, with the engine's own tool (`pg_dump`, or SQLite's `.backup` or `VACUUM INTO`, not a copy of a live file). The command journal, receipts, audit rows and event store live in it, so one backup keeps them consistent with the rows. On PostgreSQL the App's tables are in `public` and mistri's runtime state is in a schema named `mistri`: `pg_dump -n public` dumps the App, `-n mistri` the runtime; take both. The runtime schema is closed to other roles (`REVOKE ALL ON SCHEMA mistri FROM PUBLIC`).
- **The session store**: `auth.store`, or by default `~/.config/mistri/auth/<app>.db` (`$XDG_CONFIG_HOME` when set). Lost, it signs everyone out; nothing else.
- **Each other store the config names**: an `analytics` store, a tenant store, a cache needs none.
- **Files** with `storage: 'bucket'` are in the bucket: back it up with the database, since a row names its object.

Restore with the server stopped: the databases first, then the stores, then start. A start checks the journal and the stores and refuses what does not match, rather than creating anything.

Take this backup before `mistri migrate stores up`: a step has no reverse. To go back, restore the backup and run the mistri that made it, which refuses a newer layout by name. The tables `__mistri_schema_snapshot` and the PostgreSQL `mistri.schema_epoch` (SQLite and MySQL have no epoch table) are caches mistri rebuilds, not stores.

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
