---
title: Rows that may not overlap
description: Declare noOverlap on a resource so one chair or one person is never booked twice, and name a database constraint to say its refusal beside a field.
keywords: [noOverlap, constraints, double booking, overlap, exclusion constraint, btree_gist, constraint_failed, booking, schedule]
---

Declare noOverlap on a resource so one chair or one person is never booked twice, and name a database constraint to say its refusal beside a field.

```ts title="test/fixtures/apps/clinic/resources.ts"
noOverlap: { by: ['room'], from: 'starts_at', to: 'ends_at', when: 'status != cancelled', message: 'That room is taken then.' },
constraints: { room_booking_runs_forward: { field: 'ends_at', message: 'A booking ends after it starts.' } },
```

## What the rule holds

Among rows equal on every `by` column, no two may hold ranges that meet. A range is half-open, `[from, to)`: a booking that ends at ten and one that starts at ten do not meet. `from` and `to` are two dates, two timestamps or two numbers of one type. In a tenant App the tenant is always part of `by`.

A row is outside the rule, blocking nothing and blocked by nothing, when `when` does not match it, when a `by` column, `from` or `to` is empty, or when its range is empty (`from` equals `to`). `when` compares the row's own columns with fixed values (`=`, `!=`, `<`, `>`, `in`, `is empty`).

A write that would break it is refused beside `from` (or the `field` you name) in `message`: 422 `validation_failed` from a form or an edit, 400 `invalid_input` from a command, on every door. The words are said as written. They never carry a value, in a tenant App or under a row policy too, where the row in the way may be one the person cannot read.

## Who holds it

| Engine | Held by |
|---|---|
| PostgreSQL | An exclusion constraint your migration adds. Of several writers that each find the slot free, one commits |
| SQLite | mistri reads for a row that meets it, inside the write's transaction. SQLite runs one writer at a time |

mistri owns no DDL for your tables, so the constraint is your migration's. `mistri check` prints the statement, and an App on PostgreSQL does not start without a constraint that holds exactly the declared rule (`no-overlap-constraint`):

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE room_booking ADD CONSTRAINT room_booking_no_overlap
  EXCLUDE USING gist (clinic_id WITH =, room WITH =, tsrange(starts_at, ends_at) WITH &&) WHERE (status <> 'cancelled');
```

On SQLite `check` says the same statement ahead of time (`no-overlap-postgres`). Keep a command's own "is it free?" read if it words a better refusal; the rule is what holds when two requests race.

## A constraint of your own

`constraints` maps any constraint by the name the database gives it to a field and fixed words: a `CHECK`, a unique index, an exclusion constraint, or a trigger that raises with that name (`RAISE … USING CONSTRAINT = '…'` on PostgreSQL, `RAISE(ABORT, '…')` on SQLite). A write it refuses, from a form or a command's handler, says them where it answered `constraint_failed`. `check` refuses a name the table does not have (`constraint-unknown`).

## Limits

- The ends are two columns. A start and a length in minutes needs a stored end column.
- A trigger that reads other rows is still refused under a row policy or in a tenant App ([row access](/docs/row-access/#what-a-policy-scopes)); `noOverlap` is how such an App blocks a double booking.
- On SQLite under a row policy, a row the writer cannot read does not refuse their write (`no-overlap-rows`).
