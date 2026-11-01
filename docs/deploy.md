# Running the tablewalk database browser somewhere other than your terminal

This page is about the database browser (`tablewalk`). To deploy an App built
with mistri (a container, a load balancer, PostgreSQL stores, the connection
arithmetic), read [Build and deploy an App](../site/src/content/docs/docs/build-and-deploy.md)
and [the deploy targets](deploy-targets.md).

Two ways to ship the browser: a Docker image, and a desktop app. They share the same
server and the same client — nothing below is a second implementation of
anything.

- [Docker](#docker)
  - [Quick start](#quick-start)
  - [Configuration is a mount, not a rebuild](#configuration-is-a-mount-not-a-rebuild)
  - [Passwords in a container](#passwords-in-a-container)
  - [Two things to get right](#two-things-to-get-right)
  - [When it does not start](#when-it-does-not-start)
  - [Reference](#reference)
- [Tick with Docker Compose](#tick-with-docker-compose)
- [Desktop app](#desktop-app)
  - [Tauri or Electron](#tauri-or-electron)
  - [Running it](#running-it)
  - [Building it](#building-it)

---

## Docker

### Quick start

```sh
docker build -t tablewalk:local .

docker run --rm \
  -p 127.0.0.1:4111:4111 \
  -v "$PWD/myconfig:/config:ro" \
  -v "$PWD/data:/data:ro" \
  tablewalk:local
```

Then open <http://localhost:4111>.

`myconfig/tablewalk.json` is yours to write; `examples/tablewalk.json` is a
working one to copy (its `examples/postgres-seed.sql` is the schema it
expects, for a Postgres you bring). There is no compose file at the root any
more; the one compose setup in the repository is three of the sample Apps, below
under [Tick with Docker Compose](#tick-with-docker-compose).

### Configuration is a mount, not a rebuild

**The image contains no connections, no views, no layouts and no database.** It
contains tablewalk. Everything it browses is read at start from `/config`:

| Path in the container | What it holds | Read by |
| --- | --- | --- |
| `/config/tablewalk.json` | connections and views | `loadConfig()` in `packages/engine/src/server/connections.ts`, `parseViewsConfig` in `packages/engine/src/shared/view.ts` |
| `/config/tablewalk/layouts.json` | record layouts, keyed by connection then table | `packages/engine/src/server/layouts.ts` |
| `/config/tablewalk/credentials.json` | passwords, if you insist on a file (see below) | `packages/engine/src/server/auth/credentials.ts` |

The last two come from `XDG_CONFIG_HOME`, which the image sets to `/config`;
the first is passed to the server as `--config`. So one directory covers all
three, and a mount of it is the entire configuration mechanism:

```sh
-v "$PWD/myconfig:/config"
```

Changing what tablewalk browses means editing a file on the host and restarting
the container. It never means rebuilding the image.

`examples/` in this repo is laid out as exactly that directory, so you can copy
it and start editing:

```
examples/
  tablewalk.json          → /config/tablewalk.json
  tablewalk/layouts.json  → /config/tablewalk/layouts.json
  postgres-seed.sql      (the schema tablewalk.json's connection expects)
```

**Read-only or writable?** Mounting `:ro` pins the configuration: nobody can
change it from the browser, and saving a record layout in the UI reports, in as
many words, that it was kept in the browser only —

```
{"error":"Saved in this browser only — the layout file could not be written:
  EROFS: read-only file system, open '/config/tablewalk/layouts.json'"}
```

which is the honest outcome, not a bug. Mount it writable if you want layout
edits to persist. Either way the container runs as uid 1000 (`node`), so a
writable bind mount has to be readable and writable by that uid on the host.

**Overriding the paths.** `TABLEWALK_CONFIG` names the connections file
explicitly; `XDG_CONFIG_HOME` moves everything else. Anything you pass after
the image name goes straight to the server, so `docker run … tablewalk:local
--schema public --no-config` works as it does on the command line.

### Passwords in a container

`packages/engine/src/server/auth/credentials.ts` prefers the OS keychain. **There is no keychain in
a Linux container** — `keychainAvailable()` is `platform() === 'darwin'` and
that is false here. So the mechanism for Docker is environment expansion:

```json
{ "connections": [
  { "name": "app", "url": "postgres://app:${APP_DB_PASSWORD}@db:5432/app" }
] }
```

```sh
docker run -e APP_DB_PASSWORD=… …
```

The variable is expanded when the connection is opened, at the last possible
moment, and the resolved URL never leaves the server process — the browser is
sent a redacted form. An unset variable is a startup error naming the variable,
not an empty password and a confusing authentication failure. You can confirm
which mechanism was used without seeing the secret: `/api/connections` reports
`"secret":"environment"`.

A `credentials.json` at `/config/tablewalk/credentials.json` also works, and is
refused unless its mode is 0600. Writing the password inline in the URL works
too, and the UI will tell you it is a bad idea.

### Two things to get right

Both are security properties, and the container changes both.

#### 1. Bind broadly inside, publish narrowly outside

tablewalk binds `127.0.0.1` by default, because a database browser on every
interface is one shared network away from being someone else's database
browser. Inside a container that default is unusable: loopback in a network
namespace is reachable by nothing outside it, so the image sets
`TABLEWALK_HOST=0.0.0.0`. Unless an auth proxy's identity header
(`--auth-proxy-header`) or the App's own sign-in guards it, it will say so on
startup, and it is right to:

```
Listening on http://0.0.0.0:4111
Warning: bound to 0.0.0.0, beyond loopback, with no sign-in. Anyone who can reach this port can read the database. Bind --host 127.0.0.1, put it behind a proxy that signs people in (--auth-proxy-header), or give the App sign-in.
```

Binding wider also changes what the server accepts *from* the browser. On
loopback the connection manager may reference `${ENV_VAR}`, look a password
up in the keychain, open a SQLite file by path and save the config, because
the browser is the operator. Bound to `0.0.0.0` — or answering to an
`--allowed-host` name — none of that is accepted from the page any more: a
connection added there is a plain network URL used exactly as written, a
config connection cannot be redirected, and saving is refused. Put the
connections a container should have in the mounted `tablewalk.json`; that is
the file it reads, and the only place it takes a file path from.

The protection that warning is about does not disappear; it moves to the
publish flag. **Publish to the host's loopback and nowhere else:**

```sh
-p 127.0.0.1:4111:4111     # right
-p 4111:4111               # wrong — every interface of the host machine
```

The container boundary is now what confines it, and `127.0.0.1:` on the publish
is where you say so. The compose file does this and explains why in place.

This is a container-only arrangement. Running tablewalk directly still binds
loopback by default and still warns when `--host` widens it.

#### 2. Trusting the name people reach it by

`hostRefusal()` in `packages/engine/src/server/http/trust.ts` refuses any request whose `Host`
header is neither a loopback name nor the exact interface bound. That is the
DNS-rebinding defence, and it is worth keeping.

It used to run for non-GET requests only, on the reasoning that a read is
harmless. That is the wrong way round: rebinding's whole trick is to make the
request *same-origin* so the answer can be read, and the answers on offer were
the schema, the DDL, the connection list and the saved SQL.

In a container the server binds `0.0.0.0:4111` while the browser sends whatever
name you typed. `localhost:4111` passes, because loopback names are allowed —
which is why the quick start above just works. **Any other name does not.**
Reach it as `http://tablewalk.internal:4111`, or through a reverse proxy, and
the page itself is refused:

```
$ curl http://…/ -H 'Host: tablewalk.internal'
Refused: this request arrived for host "tablewalk.internal".
  tablewalk only answers on 0.0.0.0:4111. Add --allowed-host, or set
  TABLEWALK_ALLOWED_HOSTS, to trust another name.
```

Which is the point. Reads were not checked until recently, so browsing looked
fine and only saving broke — a page that works until the moment you rely on it
reads as the application being buggy rather than as a host check doing its
job. Now it fails at the door, in one message, naming the fix.

Name the hosts you actually use:

```sh
docker run -e TABLEWALK_ALLOWED_HOSTS=tablewalk.internal,tablewalk.example.com …
```

or `--allowed-host tablewalk.internal` on the command line, repeatable. Both are
empty by default and both print what they trusted on startup:

```
tablewalk: also answering writes for host tablewalk.internal
```

What this does and does not relax:

- An entry with no port matches that name on **any** port, because a proxy on
  443 sends no port at all. An entry with a port (`name:8080`) is literal.
- Matching is case-insensitive and exact. `nottablewalk.internal` does not match
  `tablewalk.internal`; there is no wildcard, deliberately.
- The **Origin** check still runs. A page at `https://evil.example` posting to
  your trusted host is still refused.
- The **Content-Type** check still runs. A form post is still refused.
- Every name you add is a name whose DNS you are trusting. If an attacker can
  make `tablewalk.internal` resolve to your loopback, the rebinding defence is
  gone for that name. That is a reasonable trade for a name you chose, and an
  unreasonable one for a wildcard, which is why there isn't one.

**Behind a proxy**, add the public name and terminate TLS at the proxy:

```
TABLEWALK_ALLOWED_HOSTS=tablewalk.example.com
```

Pass the original `Host` through (`proxy_set_header Host $host;` in nginx). If
your proxy rewrites `Host` to the upstream address instead, add *that* name.
A public form's rate limit counts the client a trusted proxy says it
forwarded for: the `X-Forwarded-For` hop nearest the right that is not a
trusted proxy itself. Loopback (the same machine or container) is always
trusted. A proxy anywhere else — another container on the compose network, a
load balancer on another host — must be named, or every applicant behind it
counts as the proxy's one address and shares one budget:

```
TABLEWALK_TRUST_PROXY=172.18.0.5          # or --trust-proxy 172.18.0.5, repeatable
```

Addresses and CIDR ranges, IPv4 or IPv6 (`10.0.0.5`, `10.0.0.0/8`,
`fd00::/8`), separated by commas or spaces; startup prints the list, and an
entry that is not an address or range stops it with the entry named. Name
the proxies, not the network your applicants arrive from: a listed address
is believed about whom it forwarded for, so a client inside a listed range
could write its own header. A header from any peer that is not trusted is
never read. This is rate limiting only and has nothing to do with
`--auth-proxy-header` below, which carries a signing-in proxy's user.

### When it does not start

The server is deliberately loud about configuration, and exits rather than
guessing. What you will see in `docker logs`:

**Nothing mounted at all** — the usage text, the list of paths that were
searched, and exit 1. The container will restart-loop if you gave it a restart
policy. Mount a `/config`, or pass `--db` / `-e DATABASE_URL`.

**Malformed `tablewalk.json`** — one line, and exit 1:

```
Config error: /config/tablewalk.json is not valid JSON: Unexpected end of JSON input
```

Also `… needs a "connections" array`, or `… connection 2 has no "url"`. A
config file that exists but is wrong is never skipped, because silently
ignoring a file someone wrote is worse than refusing to start.

**A database it cannot reach** — the active connection is opened eagerly, so a
bad target is a startup error rather than a broken page:

```
Could not open the active connection:
  app: connect ECONNREFUSED 172.18.0.2:5432
```

In compose this is usually a race with the database's first boot; have the
tablewalk service `depends_on` the database with `condition: service_healthy`
for that reason. Otherwise check the hostname is the compose *service* name
(`db`, not `localhost` — `localhost` inside the container is the container).

**A missing environment variable** in a connection string:

```
Config error: Connection references $APP_DB_PASSWORD, which is not set.
  Export it, or remove it from the connection.
```

**A view that does not resolve** is *not* a startup failure. It comes back from
`/api/views` carrying its own error, so the rest of the app keeps working:

```
"error": "Nothing in invoice_line.invoice_id points at invoice.
          Try: public.invoice_line via invoice_id"
```

That one is worth knowing: on Postgres a table's id is schema-qualified, and an
aggregate resolves its child table by id. Write `count public.invoice_line via
invoice_id`, not `count invoice_line via invoice_id`. The base table is the one
place a bare name is accepted.

**Layouts that do not appear** — they are keyed by connection **id**, which is
the slugged connection name, then by table id (`public.invoice` on Postgres,
`invoice` on SQLite). A list section's `via` is a foreign-key **constraint
name** as it appears in `/api/schema`. `examples/tablewalk/layouts.json` is a
worked example against `examples/postgres-seed.sql`, which names its
constraints explicitly for exactly this reason.

### Reference

**Environment**

| Variable | Default | Effect |
| --- | --- | --- |
| `TABLEWALK_HOST` | `0.0.0.0` | Interface to bind. Container-only default; see above. |
| `TABLEWALK_TRUST_PROXY` | unset | Proxies beyond loopback (addresses or CIDR ranges, commas or spaces) whose `X-Forwarded-For` the public forms' rate limit reads; see *Behind a proxy*. Not sign-in. |
| `TABLEWALK_AUTH_PROXY_HEADER` | unset | The header a signing-in proxy sets with the user; see *Behind a proxy that signs people in*. |
| `TABLEWALK_AUTH_PROXY_FROM` | unset | The peers beyond loopback whose auth proxy header is believed (addresses or CIDR ranges); name the proxy itself. Separate from `TABLEWALK_TRUST_PROXY`. |
| `BETTER_AUTH_SECRET` | unset | Required by an app with `auth`: 32+ characters, `openssl rand -base64 32`, kept for the life of the sessions. |
| `MISTRI_PUBLIC_URL` | first `--allowed-host` as https, else loopback | The address an app with `auth` mints cookies and OAuth callbacks for. |
| `MISTRI_AUTH_ADMIN_EMAIL` / `_PASSWORD` | unset | Creates the first admin account for an app with `auth`, once. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, `GOOGLE_…` | unset | A social provider an app's `auth.providers` lists. |
| `TABLEWALK_PORT` | `PORT`, else `4111` | Port to listen on. Platforms that set `PORT` (Cloud Run) need nothing more; outside the image the server reads `PORT` too, when no `--port` is given. |
| `TABLEWALK_CONFIG` | `/config/tablewalk.json` if present | Connections and views file. |
| `TABLEWALK_ALLOWED_HOSTS` | *(empty)* | Extra `Host` names answered at all. Comma- or space-separated. |
| `XDG_CONFIG_HOME` | `/config` | Where layouts and credentials live. |
| `DATABASE_URL` | *(unset)* | A single connection, instead of a config file. |

**Image**

- Base `node:24.22.1-alpine3.24`, pinned. Node 24 is required, not preferred:
  the SQLite adapter is `node:sqlite`, which needs a flag before 23.4.
- Multi-stage. The server is compiled with `tsc` and the client bundled
  with Vite in the build stage, so no `tsx`, no Vite and no esbuild at
  runtime — `npm prune --omit=dev` drops them before the final stage.
- ~239 MB, nearly all of it the Node runtime; the application layers total
  about 7 MB.
- Runs as uid 1000 (`node`), never root.
- `tini` is PID 1, so signals and orphaned children are handled by something
  whose job that is. `docker stop` returns in about 200 ms with exit code 0.
- `HEALTHCHECK` polls `/healthz` on loopback inside the container.

**A note on writes.** Connections are read-only unless the config file opts in
per connection:

```json
{ "name": "local", "url": "…", "writable": true }
```

The server enforces this; the browser's write toggle is a second gate, not the
only one. Leaving it out is the right default for a file a colleague may have
copied without reading every line.

---

## Tick with Docker Compose

The Tick sample App in its own container with its own seeded SQLite database,
from one image, in one command:

```sh
docker compose -f examples/docker/docker-compose.yml up --build
```

| App | Open | Container |
| --- | --- | --- |
| Tick | <http://localhost:4741/tick> | `mistri-tick` |

The image is built once from `examples/docker/Dockerfile`, which is the
quick start's with a builder stage in front: it compiles the packages, runs
`mistri build` for the App — typecheck, validation, bundle —
and ships the builds with the runtime, never the Apps' TypeScript. It follows
both of the rules above: the container binds `0.0.0.0`, every port is
published to `127.0.0.1` only, and each service lists its own compose service
name in `MISTRI_ALLOWED_HOSTS` so another container on the network can
reach it by name — `localhost` needs nothing, any other name is refused until
it is added. The server starts from the App's build under `/app/builds`,
served as built: nothing is mounted from the checkout and nothing reloads, so
a change to an App is `up --build`. Each container's
`examples/docker/start.sh` seeds its database into a named volume at
`/config` on first boot and skips the seed on every boot after.
`docker compose … down -v` throws the data away; without `-v` it survives.
[Build and deploy an App](../site/src/content/docs/docs/build-and-deploy.md) is
the same recipe for an App of your own.

Lintel, the flagship, is not in the compose file. It needs a row policy, its
commands, its jobs and the stores they use, and a seeding step of its own,
with PostgreSQL as its target; [its README](../examples/apps/lintel/README.md) is
the recipe for running it, and
[examples/docker/README.md](../examples/docker/README.md) says the same in one
paragraph.

---

## Behind a proxy that signs people in

Access, oauth2-proxy and their kin put the user's identity in a header on
the way through. Tell tablewalk which one:

```
tablewalk --host 0.0.0.0 --allowed-host data.example --auth-proxy-header X-Forwarded-User
```

or `TABLEWALK_AUTH_PROXY_HEADER=X-Forwarded-User` in the container's
environment. From then on a request from beyond loopback without that
header is refused with the header named — it did not come through the
proxy — and every write in the journal carries the value. Loopback stays
exempt, so the container's own health check keeps working. This carries
the proxy's decision into the process; it is not a login of its own.
`--trust-proxy` (no `-header`) is a different setting — which proxies the
public forms' rate limit believes about client addresses — and naming a
proxy there exempts nothing here. The header is believed only from loopback
and from the peers `--auth-proxy-from` names (or `TABLEWALK_AUTH_PROXY_FROM`),
which takes the same addresses and ranges: give it the proxy's own address,
because every peer in a range can then say who is signed in, and startup warns
when a range is wider than one host.

## Desktop app

In `desktop/`, with its own `package.json`, so the root project builds and
tests without it.

### Tauri or Electron

**Electron**, and for this codebase it is not close.

The deciding fact is the runtime. tablewalk is a Node HTTP server that requires
Node 24 for `node:sqlite`. Electron 43 *is* Node 24 — verified, not assumed:

```
$ ELECTRON_RUN_AS_NODE=1 electron -e "console.log(process.versions.node); require('node:sqlite')"
24.18.1
node:sqlite works -> [Object: null prototype] { a: 1 }
```

So the app gets its Node runtime for free, from the same binary that draws the
window, re-entered with `ELECTRON_RUN_AS_NODE=1`. One runtime, one version to
test, one thing to sign.

Tauri has no Node in it. The server would need a **sidecar**: a real Node 24
binary, downloaded per platform and per architecture, committed or fetched at
build time, and shipped inside the bundle. That is where the usual argument for
Tauri collapses —

| | Tauri | Electron |
| --- | --- | --- |
| Shell | ~10 MB | ~250 MB |
| Node 24 for `node:sqlite` | +~110 MB sidecar, per platform | included |
| Realistic bundle | ~120 MB | ~292 MB (measured, macOS arm64) |
| Toolchain to build | Rust **and** Node | Node |
| Languages to maintain | Rust + JS | JS |
| Sidecar plumbing | spawn, per-platform naming, signing each binary separately | none |

Electron is roughly 2.5× the download to avoid a Rust toolchain, a
per-platform binary acquisition step, and a second language in a project
maintained by one person. The other factors are closer than they are usually
claimed to be: both need an Apple Developer ID and notarisation on macOS and
both have a first-party updater (`electron-updater`, `tauri-plugin-updater`).
Tauri's smaller bundle would matter if the app were only a webview. It is not —
it is a Node server that happens to have a window.

Two smaller things that also fell out in Electron's favour here:

- The client is plain ES modules with no bundler. Both would serve it fine, but
  Electron ships one Chromium, so "works in my browser" and "works in the app"
  are the same statement. Tauri uses the OS webview — WKWebView, WebView2,
  WebKitGTK — and that is three engines to test a bundler-free client against.
- `pg` is pure JS with no native module, so neither approach needs
  `@electron/rebuild` to do anything. That removes what is usually Electron's
  worst maintenance burden.

**If the bundle size ever becomes the deciding constraint**, the honest
alternative is not Tauri — it is dropping the desktop app and shipping the
Docker image plus `npx tablewalk`, which is 0 MB and already works.

### Running it

```sh
npm install            # once, at the repo root
cd desktop
npm install
npm run dev
```

That works against a fresh checkout with **no build step**. `main.js` prefers
`dist/server/index.js` and falls back to running `packages/tablewalk/src/server/index.ts` through
tsx, resolved from the root project's `node_modules`. Pass a database, or let
it ask:

```sh
npm run dev -- ~/some.db
```

What it does, in order: an argument, then the database you had open last, then
a `tablewalk.json` the server can find on its own, and only then a file picker.

Behaviour worth knowing:

- The server runs on a **free port chosen at launch**, not 4111, so it never
  collides with a `npm start` you already have running.
- The window loads `http://127.0.0.1:<port>/`, which is loopback, so the
  cross-origin guard needs no `--allowed-host`. The desktop app is the one
  deployment that really is local.
- **Closing the window quits**, on macOS too. tablewalk holds an open database;
  staying resident with nothing on screen to say so is worse than the
  convention is worth.
- **The server dies with the app.** `will-quit` covers every route out — menu
  quit, Cmd-Q, last window closed, SIGINT from the terminal — with SIGTERM
  first so connections close, and SIGKILL after three seconds because "the app
  closed but something still holds the database" is the worse failure.
- One instance only. A second launch focuses the existing window instead of
  starting a second server on a second port.
- File ▸ Open Database… (Cmd-O) restarts the server against a new file. File ▸
  Open in Browser hands the same URL to your real browser.

### Building it

```sh
cd desktop
npm run dist:dir     # unpacked app, no signing — good for a smoke test
npm run dist         # installers
```

`npm run dist` runs `desktop/scripts/stage.mjs` first, which builds the server, copies
`dist/` and installs production-only dependencies into `desktop/build/server/`.
That staging exists because the root `node_modules` holds tsx, typescript and
esbuild — a build toolchain that is larger than the app and has no business in
it. The staged tree is about 6.7 MB.

Verified here on macOS arm64: `dist:dir` produces a 292 MB `mistri.app` that
launches, starts its server from `Contents/Resources/server/dist`, serves the
client and shuts down cleanly.

**What the build needs that this machine may not have:**

- **macOS signing and notarisation.** Unsigned builds run locally and are
  refused on anyone else's Mac. You need an Apple Developer ID Application
  certificate in the login keychain, then:

  ```sh
  export APPLE_ID="you@example.com"
  export APPLE_APP_SPECIFIC_PASSWORD="…"     # appleid.apple.com, not your password
  export APPLE_TEAM_ID="XXXXXXXXXX"
  npm run dist
  ```

  `entitlements.mac.plist` is already set up for the hardened runtime, and two
  of its entries are load-bearing: `allow-jit` (V8 writes machine code) and
  `allow-dyld-environment-variables` (without it the hardened runtime strips
  `ELECTRON_RUN_AS_NODE`, and the server child starts as a second copy of the
  GUI instead of as Node — the app appears to hang waiting for a server that
  was never a server). To build unsigned on purpose:
  `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir`.

- **Windows** needs a code-signing certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`)
  or SmartScreen will warn on every download. **Linux** AppImage needs nothing.

- **Cross-compiling is not worth it.** Build each platform on that platform,
  in CI, from the same tag.

- **Auto-update is not wired up.** Adding it is `electron-updater` plus a
  publish target in the `build` block, and it needs somewhere to publish to —
  a GitHub release is the cheap option. Left out deliberately: an updater
  pointing nowhere is worse than none.

- **There is no application icon**, so the build uses Electron's. Drop a
  1024×1024 `icon.png` in `desktop/assets/` to fix that.
