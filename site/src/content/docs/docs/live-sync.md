---
title: Live sync
description: Open pages follow what other people change, in place and quietly, without a reload and without ever changing a form under the person typing in it.
---

Open pages follow what other people change, in place and quietly, without a
reload and without ever changing a form under the person typing in it.

An App asks for it with one key, and is off without it:

```ts title="examples/apps/lintel/app.ts"
live: true,
sources: { lintel: { connection: 'lintel' } },
resources,
```

See it in the sample (`examples/apps/lintel/app.ts:53`).

Provision the change store and every write the App serves (a Save, a
command, a job, an agent's) tells the pages that may read it:

```sh
mistri migrate stores up --db "$DATABASE_URL"
```

A table whose writes nobody needs to see as they happen (a log, a hot counter)
stays out with `live: false` on its resource: its writes are not filed, and a
page over it refreshes as before.

## What you'll see

- **A list, a count, a dashboard tile** is read again where it stands. A
  changed row is tinted for a moment, with no message.
- **A record being viewed** is read again, and the head says
  *Updated by Ana just now* (*Updated just now* where the history does not name
  a person the reader may see).
- **A record being edited** is never changed under the person. A notice says
  *Ana changed this ticket*, with **Review changes**, which lays their change
  beside the person's own, and **Keep editing**.
- **A list the person is working in** (a row selected, a menu open, the pointer
  over the rows, scrolled or paged on) holds still behind *3 updates · Show*,
  and shows them on click or two seconds after the person stops.
- **A hidden tab** lets its stream go after 30 seconds and reads once when it
  is shown again.
- **A page under a stream of changes** lets the read already out finish and
  reads once more after it, never more, so a busy table cannot keep a page
  from drawing.

## What the stream carries

The stream carries which records changed, filtered by the reader's own grants
(a table or column they cannot read, a row outside their policy, are never
mentioned), and never a value. The page asks again through the same reads it
always used, so every rule those reads have still applies.

A dashboard takes no `refresh`. Under live sync it follows changes,
and re-reads what depends on the time (`last 30 days`, `today`) each minute,
as it does every read of a table that stays out with `live: false`; without
it, it re-reads all its reads each minute while the tab is visible.
`--no-live` turns live sync off for every App, even one that asks; a
database without the store serves as before. Changes made outside mistri
are not seen yet.

<!-- no picture: a live refresh draws what the page already draws; the difference is that nobody asked for it. -->

## Common mistakes

- The startup log says live sync is off for want of the store → run
  `mistri migrate stores up` against the App's database once.
- A page does not follow a change made in `psql` or another program → only
  writes the App serves are filed; read the page again.
- A busy log table floods every open page → give its resource `live: false`.

## Related

- [Events and jobs](/docs/events-and-jobs/): a job's writes are filed like a person's.
- [Dashboards](/docs/dashboards/): what a tile reads again, and when.
- [Change your schema](/docs/change-your-schema/): the stores `migrate stores` keeps.
- [Row access](/docs/row-access/): the policy that filters what the stream mentions.
