# Running an App behind a container or a proxy

To build and deploy an App (a container, a load balancer, PostgreSQL stores,
the connection arithmetic), read [Build and deploy an App](../site/src/content/docs/docs/build-and-deploy.md)
and [the deploy targets](deploy-targets.md). This page is the two security
properties a container changes, the Tick sample in Docker Compose, and a
proxy that signs people in.

The database browser (`tablewalk`), its Docker image and its desktop app are
built and documented in their own repository:
[rbaljinder/tablewalk](https://github.com/rbaljinder/tablewalk).

---

## Two things to get right

Both are security properties, and the container changes both.

### 1. Bind broadly inside, publish narrowly outside

The server binds `127.0.0.1` by default, because a server on every
interface is one shared network away from being someone else's. Inside a
container that default is unusable: loopback in a network namespace is
reachable by nothing outside it, so the image sets `MISTRI_HOST=0.0.0.0`. Unless an auth proxy's identity header
(`--auth-proxy-header`) or the App's own sign-in guards it, it will say so on
startup, and it is right to:

```
Listening on http://0.0.0.0:4111
Warning: bound to 0.0.0.0, beyond loopback, with no sign-in. Anyone who can reach this port can read the database. Bind --host 127.0.0.1, put it behind a proxy that signs people in (--auth-proxy-header), or give the App sign-in.
```

The protection that warning is about does not disappear; it moves to the
publish flag. **Publish to the host's loopback and nowhere else:**

```sh
-p 127.0.0.1:4111:4111     # right
-p 4111:4111               # wrong — every interface of the host machine
```

The container boundary is now what confines it, and `127.0.0.1:` on the publish
is where you say so. The compose file does this and explains why in place.

This is a container-only arrangement. Running the server directly still binds
loopback by default and still warns when `--host` widens it.

### 2. Trusting the name people reach it by

`hostRefusal()` in `packages/engine/src/server/http/trust.ts` refuses any request whose `Host`
header is neither a loopback name nor the exact interface bound. That is the
DNS-rebinding defence, and it is worth keeping.

It used to run for non-GET requests only, on the reasoning that a read is
harmless. That is the wrong way round: rebinding's whole trick is to make the
request *same-origin* so the answer can be read, and the answers on offer were
the schema, the DDL, the connection list and the saved SQL.

In a container the server binds `0.0.0.0:4111` while the browser sends whatever
name you typed. `localhost:4111` passes, because loopback names are allowed. **Any other name does not.**
Reach it as `http://tick.internal:4111`, or through a reverse proxy, and
the page itself is refused:

```
$ curl http://…/ -H 'Host: tick.internal'
Refused: this request arrived for host "tick.internal".
  mistri only answers on 0.0.0.0:4111. Add --allowed-host, or set
  MISTRI_ALLOWED_HOSTS, to trust another name.
```

Which is the point. Reads were not checked until recently, so browsing looked
fine and only saving broke — a page that works until the moment you rely on it
reads as the application being buggy rather than as a host check doing its
job. Now it fails at the door, in one message, naming the fix.

Name the hosts you actually use:

```sh
docker run -e MISTRI_ALLOWED_HOSTS=tick.internal,tick.example.com …
```

or `--allowed-host tick.internal` on the command line, repeatable. Both are
empty by default and both print what they trusted on startup:

```
mistri: also answering writes for host tick.internal
```

What this does and does not relax:

- An entry with no port matches that name on **any** port, because a proxy on
  443 sends no port at all. An entry with a port (`name:8080`) is literal.
- Matching is case-insensitive and exact. `nottick.internal` does not match
  `tick.internal`; there is no wildcard, deliberately.
- The **Origin** check still runs. A page at `https://evil.example` posting to
  your trusted host is still refused.
- The **Content-Type** check still runs. A form post is still refused.
- Every name you add is a name whose DNS you are trusting. If an attacker can
  make `tick.internal` resolve to your loopback, the rebinding defence is
  gone for that name. That is a reasonable trade for a name you chose, and an
  unreasonable one for a wildcard, which is why there isn't one.

**Behind a proxy**, add the public name and terminate TLS at the proxy:

```
MISTRI_ALLOWED_HOSTS=tick.example.com
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
MISTRI_TRUST_PROXY=172.18.0.5          # or --trust-proxy 172.18.0.5, repeatable
```

Addresses and CIDR ranges, IPv4 or IPv6 (`10.0.0.5`, `10.0.0.0/8`,
`fd00::/8`), separated by commas or spaces; startup prints the list, and an
entry that is not an address or range stops it with the entry named. Name
the proxies, not the network your applicants arrive from: a listed address
is believed about whom it forwarded for, so a client inside a listed range
could write its own header. A header from any peer that is not trusted is
never read. This is rate limiting only and has nothing to do with
`--auth-proxy-header` below, which carries a signing-in proxy's user.

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

The image is built once from `examples/docker/Dockerfile`, with a builder
stage in front: it compiles the packages, runs
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
the way through. Tell the server which one:

```
mistri --app <dir> --host 0.0.0.0 --allowed-host data.example --auth-proxy-header X-Forwarded-User
```

or `MISTRI_AUTH_PROXY_HEADER=X-Forwarded-User` in the container's
environment. From then on a request from beyond loopback without that
header is refused with the header named — it did not come through the
proxy — and every write in the journal carries the value. Loopback stays
exempt, so the container's own health check keeps working. This carries
the proxy's decision into the process; it is not a login of its own.
`--trust-proxy` (no `-header`) is a different setting — which proxies the
public forms' rate limit believes about client addresses — and naming a
proxy there exempts nothing here. The header is believed only from loopback
and from the peers `--auth-proxy-from` names (or `MISTRI_AUTH_PROXY_FROM`),
which takes the same addresses and ranges: give it the proxy's own address,
because every peer in a range can then say who is signed in, and startup warns
when a range is wider than one host.
