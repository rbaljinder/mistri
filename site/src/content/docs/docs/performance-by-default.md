---
title: Performance by default
description: "What mistri does so an App is fast without tuning, and the few things to do yourself: feel the database's distance in dev, index what you read, hold a budget in a test."
---

mistri keeps an App fast by counting round trips to the database, because the distance to it, not the CPU, is what a person waits for.

<!-- no picture: numbers and a dev log line; the line itself is shown below. -->

## What mistri does

- Reads that belong together share one round trip: a record's snapshot is pipelined, so a read costs two round trips whatever it fetches.
- The first page of an App is about fourteen round trips in all: the person, the App's payload and the page's own reads, in two waves.
- Connections come from one shared pool per database, and people arriving at once are let in a few at a time, in order, instead of all at once.
- Platform tests hold budgets: a read at most three round trips, a command at most six, a first page at most sixteen.

## What you do

Feel the distance while you build. A database on your laptop answers in a fraction of a millisecond, so a request that makes forty round trips looks instant until it is deployed.

```sh
npx @mistriwork/mistri dev . --db-latency 20
```

`--db-latency <ms>` (or `MISTRI_DEV_DB_LATENCY`) delays every database round trip by that long. It is refused under `NODE_ENV=production` and when serving a build. While you develop, each request that touched the database logs its cost:

```text
mistri: GET /api/records/lead 200: 2 round trips, db 41 ms, cpu 3 ms
```

A request over its budget says so, and links here.

Index what the App reads. `mistri check` compares the access paths an App declares (a related list's foreign key, a list's sort and fixed filter, a tenant's ownership column, a search box) with the PostgreSQL index list and prints `index-missing` with the `CREATE INDEX` line that fixes it: information under 10,000 estimated rows, a warning above. `--no-index-check` skips it. See [check codes](/docs/check-codes/).

Hold a budget in the App's own tests:

```ts
import { roundTrips } from '@mistriwork/mistri/testing';

const page = await manager.request('/api/records/lead');
assert.ok(roundTrips(page) <= 3);
```

`roundTrips` is Preview. Last, run `mistri check --deploy` to see how many connections the pools open against your database's limit, and keep the database in the same region as the container.

## What it measured

A field deployment: a half-vCPU container with the database about 16 ms away.

| Load                   | Result                                                     |
| ---------------------- | ---------------------------------------------------------- |
| One person             | list page 0.8 to 0.95 s, record 0.9 to 1.1 s, a save 0.6 s |
| 25 people for one hour | p50 181 ms, p95 587 ms                                     |
| 75 people              | p95 1.5 s at 17 requests a second                          |

See [performance and pools](/docs/performance/) for sizing the pools and reading the meters.
