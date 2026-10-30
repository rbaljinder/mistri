---
title: Incident runbook
description: What to check, in order, when a served App is down, slow or refusing work, what to collect, and when to ask for help.
keywords: [incident, runbook, outage, healthz, readyz, support bundle, server_busy, store unavailable, escalation]
---

What to check, in order, when a served App is down, slow or refusing work, what to collect, and when to ask for help.

```sh
curl -fsS localhost:4111/healthz && curl -fsS localhost:4111/readyz   # alive? ready?
npx @mistriwork/mistri check --app . --config mistri.json --deploy --replicas 2 --connection-limit 100
```

## First checks

1. **Liveness and readiness.** `/healthz` answers 200 while the process runs; `/readyz` answers 503 while starting, while a row policy restarts, while a tenant App's writer is closed after an uncertain write, and from shutdown on. A balancer's check belongs on `/api/app` ([health and readiness](/docs/observe/#health-and-readiness)). Under `--base-path` the probes move with it.
2. **The log.** A start that cannot proceed prints one line naming why, and exits: a store behind its layout names `mistri migrate stores up`, a missing secret names the variable, a database it cannot reach names the connection. A request refusal logs one line with its cause, never a driver's text.
3. **What the deployment would hold.** `mistri check --app . --deploy` (run with the deployment's environment) prints, per database, the processes times the connections each may hold, and with `--connection-limit` refuses a total above what the role allows. Too many processes for the role is the commonest cause of a start that works and a rollout that does not.
4. **The capacity section.** Fetch the [support bundle](#the-support-bundle) twice a minute apart and compare: `waiting`, `queued` and `timedOut` rising mean the pool, not the database, is the limit ([reading the pool meters](/docs/performance/#reading-the-pool-meters)).

## What the refusals mean

| You see | It means | Do |
| --- | --- | --- |
| 503 `server_busy`, `Retry-After: 1` | Every connection was busy for two seconds, or 64 requests were queued | Add pods or raise the pool within the database's limit; look for one slow statement first |
| 503 `row_locked` | A write waited five seconds for a lock | A migration or a long transaction holds the table; end it |
| 503 `Retry-After: 30` | The database's connection limit was reached | Lower the pools or processes; `check --deploy` says by how much |
| 503 naming a store (the assistant, a journal, the audit) | The store is missing, behind its layout, or its database is down | `mistri migrate stores status`, then `up` ([back up first](/docs/build-and-deploy/#back-up-and-restore)) |
| `/readyz` 503 on a tenant App, stays | The writer closed after a COMMIT it could not confirm; it reopens itself, backing off to a minute | Read the log line: it says whether the command committed. A retry with its idempotency key is answered from its receipt |
| Everyone signed out | The sign-in store or `BETTER_AUTH_SECRET` changed | Restore the store, or set the secret it was made with |
| Start refused for `MISTRI_AUDIT_KEY` | It is not the key the support audit was set up with | [Set the original](/docs/build-and-deploy/#the-audit-key); it cannot be rotated in place |

## The support bundle

`GET /api/operations/support`, for a role holding the `bundle` operation ([operator reads](/docs/observe/#operator-reads)), answers one JSON document: readiness with its named checks, HTTP metrics and the capacity section. It carries `"event": "mistri.support"` and `"version": 1`; quote the version when you send one. It holds no names, paths, SQL, values, identities or credentials, so it is safe to attach to a ticket.

## Escalate when

- Readiness has been 503 for ten minutes after the database is reachable and the log names nothing you can fix.
- A store refuses with a layout message and no backup is at hand: stop, do not run `up`.
- A security fault is suspected: stop sharing logs and [report it privately](/docs/security/#report-a-vulnerability).

Send the bundle, the server's version (`mistri --version`), the first log lines after the failure and the output of `check --deploy`.

## Related

- [Observe and operate](/docs/observe/): readiness, traces and redrive.
- [Performance and pools](/docs/performance/): reading the pool meters.
- [Build and deploy](/docs/build-and-deploy/): backup, restore and rollout.
