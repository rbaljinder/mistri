# Tick with Docker Compose

Tick in its own container with its own seeded SQLite database, from one image
that builds it, in one command. Run from the repository root:

```sh
docker compose -f examples/docker/docker-compose.yml up --build
```

| App | Open | Service | Data volume |
| --- | --- | --- | --- |
| Tick | <http://localhost:4741/tick> | `mistri-tick` | `tick-data` |

Tick is the one App here because it is the one that needs nothing else: a
SQLite file in a volume and no sign-in. Lintel, the flagship, is not a compose
target; see [Lintel is not a compose sample](#lintel-is-not-a-compose-sample).

`docker compose -f examples/docker/docker-compose.yml down` stops them and
keeps the data; add `-v` to throw the databases away and start from the
seeded data again. The Apps are built into the image, so `--build` is needed
the first time and after any change to an App or to the server.

## What it is made of

- **One image, built in two stages** from [`Dockerfile`](Dockerfile) beside
  this file, tagged `mistri-samples:local` and shared by every service.
  The builder stage builds the packages, runs `mistri build` for the App —
  its typecheck, the validation a start would run, the bundle — and seeds its
  data into a template. The runtime stage ships node, the installed
  packages and their production dependencies, the build and the template: no App's
  TypeScript, no seed script, no compiler. [Build and deploy an
  App](../../site/src/content/docs/docs/build-and-deploy.md) is the same
  recipe for an App of your own.
- **Served as built.** Each server starts from `/app/builds/<app>`, which
  loads no TypeScript and watches nothing. There is no hot reload here: save
  an App on the host and rebuild the image. The build is pinned to the
  mistri in the image, which is the one that made it.
- **Data seeded once, when the image is built.** Each seed runs in the builder
  into `/config` — the path its volume is mounted at, since a connection config
  names its database by absolute path — and the result is kept as a template,
  which is why the runtime needs no seed script at all. On first boot
  `start.sh <app>` copies its template into the volume; the connection
  config's existence makes every later boot a skip, so a restart never touches
  the data.
- **A named volume at `/config`.** The image creates `/config` for
  its unprivileged `node` user, so a volume mounted there is writable with
  no chown step. It holds the database, its connection config, and any
  record layout saved from the UI (`/config/mistri/layouts.json`, through
  `XDG_CONFIG_HOME`).

## The two rules from DEPLOY.md

Both of [Two things to get right](../../DEPLOY.md#two-things-to-get-right)
are applied as written.

**Bind broadly inside, publish narrowly outside.** The image binds
`0.0.0.0`, because loopback inside a container reaches nothing. Every
`ports` line publishes to `127.0.0.1` on the host and nowhere else. To
expose a sample beyond the machine, change the publish line deliberately,
and read that section first.

**Trusting the name people reach it by.** The server refuses any `Host` it
was not told to answer. What each service accepts:

- `localhost` and `127.0.0.1`, on any port — loopback names always pass, so
  the addresses in the table above work with no configuration.
- Its own compose service name (`mistri-tick`), on any port — set through
  `MISTRI_ALLOWED_HOSTS` so that another container on the compose
  network, a reverse proxy for instance, can reach it by that name.
- Nothing else. Reaching a sample as `samples.internal` or through a proxy
  with a public name is refused with a message naming the fix; add the name
  to that service's `MISTRI_ALLOWED_HOSTS` (comma-separated).

`MISTRI_OPEN=0` on every service keeps the server from trying to open a
browser, which a container has no way to do.

## Lintel is not a compose sample

Lintel is the flagship, and none of what it needs is something this compose
file can hand it: a row policy (`--policy`), its commands (`--commands`), its
jobs (`--jobs`) and the stores they use, and a seeding step of its own, with
PostgreSQL as its target. A container per App with a SQLite file in a volume is
the wrong shape for it, and bending this file into that shape would cost Tick
its one-command start. Its [README](../apps/lintel/README.md) is the recipe for
running it, and [Build and deploy an
App](../../site/src/content/docs/docs/build-and-deploy.md) says what a
deployment of an App like it needs.

## Running the same thing without Docker

The container runs nothing that a checkout cannot. `start.sh` reads
`MISTRI_ROOT` (the checkout; the image's `/app`), `MISTRI_BUILDS` (the
builds; the image's `/app/builds`) and `MISTRI_DATA` (the data directory;
the image's `/config`). A checkout has no seeded templates, so it seeds the
data directory in place on first start:

```sh
npm run build
node node_modules/@mistriwork/mistri/dist/server/index.js build --app examples/apps/tick --out build/tick
mkdir -p /tmp/tw-tick
MISTRI_ROOT="$PWD" MISTRI_BUILDS="$PWD/build" MISTRI_DATA=/tmp/tw-tick \
  MISTRI_HOST=127.0.0.1 MISTRI_PORT=4741 MISTRI_OPEN=0 sh examples/docker/start.sh tick
```

Then <http://127.0.0.1:4741/tick>. `seed.mjs tick <dir>` alone seeds
without serving, and prints the config path it would hand to `--config`.
