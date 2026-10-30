---
title: Security model
description: What the server enforces for every App, what it leaves to the database and to you, and where each line is drawn.
keywords: [security, threat model, read-only, writable, csp, grants, authority lock, report a vulnerability]
---

What the server enforces for every App, what it leaves to the database and to
you, and where each line is drawn.

```json title="mistri.json"
{
  "connections": [
    { "name": "crm", "url": "${DATABASE_URL}", "writable": true }
  ]
}
```

A connection is read-only until it says `"writable": true`, and the server
checks that in every route and tool that writes, before a statement reaches
the database. The database role is the limit that holds whatever the server
does: connect as one that can do no more than the App needs.

## What the server enforces

- **Every read is the reader's own.** A list, a count, an export, a rollup and
  a record's history go through one authorized reader: the role's table and
  field grants, its row scope and the row policy. A field the reader may not
  read is refused, never narrowed into an oracle.
- **A hidden column is never served.** A resource's `hidden` cuts it from the
  catalog every read goes through; a query that names it is refused as naming
  a column that is not there.
- **Queries compile to structure, never to SQL text.** Every value is a bound
  parameter, and table names are checked against the catalog.
- **Writes go through the one pipeline.** A save, an action and a command each
  check the role's grant on the server; a role granted one fixed action writes
  that action and nothing else.
- **A public door holds what it is sent.** A public form, or a public page's
  command, runs as the public principal under per-client and App-wide rate
  limits, a 64 KB body limit (held while the body arrives, for at most ten
  seconds, before the human check), a submission key and a decoy field. A
  public page's command also needs the page's own ticket, at least three
  seconds old, and comes from the page's own origin, never an embedding
  host's. `auth.challenge` adds a human check, asked before the App-wide
  budget is spent; each token counts once ([public
  forms](/docs/command-forms/#public-forms)). A tenant App's public forms ask
  it the same way, and offer a choice from a table only the rows of the tenant
  the request places, read under that tenant's `auth.public` grants and kept
  per tenant. One rule places a form's read, its submission, every step and
  the flags its page reads: the tenant's mapped host by that tenant's own
  address, the shared host by `?via=`, and both at once is `400`. Behind a
  proxy, the ordinary host and the tenant host alike count each visitor by
  the address the proxies `--trust-proxy` names report, and tell the human
  check that address; without it every visitor shares one budget.
- **The page talks to its own server.** A Content-Security-Policy keeps
  scripts and requests on the App's origin and on the origins `ui.csp` names.
- **Every grant is written down.** `authority.lock` lists each grant, ceiling
  and binding the App holds, one line each, so a change to who may do what
  shows in review ([the authority lock](/docs/dsl-features/#the-authority-lock)).

## What it leaves to you

- **The App directory is code.** `app.ts`, `commands.ts` and custom components
  run with the server's privileges; keep the directory writable only by the
  account that serves it. A load, and every hot reload, refuses the directory or
  any directory under it (`node_modules` apart) that is writable by everyone,
  keeping the last good App serving; that guard does not run on Windows, where
  directory ACLs are yours to set. `mistri check` and every load (serve, `dev`) refuse a
  component that turns text into markup or code (`dangerouslySetInnerHTML`,
  `eval`); that lint reads text and is heuristic, an App's author is trusted,
  and it is not a sandbox.
- **Loopback is not a login.** A server binds `127.0.0.1`. An App that signs
  people in protects itself; one that does not belongs behind a proxy that
  authenticates (`--auth-proxy-header`).
- **A picture a visitor may read is public.** A file resource `auth.public`
  opens, with no row policy, is delivered for any cache to keep (`public,
  max-age=86400`, a year at an address that names its bytes), and its resized
  copies sit in the bucket for every instance. Keep a picture that must stay
  private out of `auth.public`, or behind a row policy
  ([file storage](/docs/file-storage/)).
- **Secrets live in the environment.** Write `${NAME}` in `mistri.json`,
  never the value ([secrets](/docs/secrets/)).
- **`MISTRI_SERVER_TIMING=1` is for load testing only.** It puts the process's
  own state (heap, garbage collection, pool use and queues) in the
  `Server-Timing` header of every response, to any requester, signed in or not.
  Keep it off in production, or set `MISTRI_SERVER_TIMING_TOKEN` so the process
  entry goes only to a request that sends it as an `x-mistri-timing` header.

## mistri is not a sandbox

An App is trusted server code. Its `app.ts`, `commands.ts`, jobs and custom components run in the server's process with the server's privileges: its environment, its files, its network and every connection in the config. Nothing confines them, and the load-time lint for raw HTML and `eval` is a guard against mistakes, not against a hostile author.

- **Load only Apps you wrote or reviewed.** Never serve code from a customer, a plugin directory or a download you have not read. To run code you do not trust, give it a process, a container and a database role of its own.
- **A tenant App isolates data by policy, not by process.** Every tenant's requests run in one process and one database, kept apart by the tenant store, the row policy and the checks on every read and write. A flaw in the App's own code, or a database role wider than the App needs, can cross that line, so the role is still the limit that holds ([tenant Apps](/docs/tenant-apps/)). A customer who needs process isolation needs a deployment of their own.
- **Suite Apps share a server.** Apps mounted in one suite share its process; mount only Apps you trust equally.

## Report a vulnerability

<!-- TODO(1.0): reporting address -->

Email security@tablewalk.dev rather than opening a public issue. You will get
an acknowledgement within a few days. The repository's `SECURITY.md` holds the
whole model, point by point.

## Related

- [Resources and fields](/docs/access-model/): what each resource and field grants.
- [Roles](/docs/roles/): what a role may read, write and run.
- [Row access](/docs/row-access/): the policy every read and write passes.
- [Build and deploy](/docs/build-and-deploy/): binding, allowed hosts and the proxy in production.
