---
title: Stock that can't be oversold
description: Declare consumes on a line so the stock it uses is taken, given back and refused at zero on every write.
keywords: [consumes, restocks, stock, inventory, oversell, on_hand, backorder, receipt, consumes_refused]
---

Declare consumes on a line so the stock it uses is taken, given back and refused at zero on every write.

```ts title="examples/apps/lintel/resources.ts"
consumes: { column: 'part_id.on_hand', by: 'quantity', message: 'Only {part_id.on_hand} of {part_id.name} left in the storeroom' },
```

See it in the sample (`examples/apps/lintel/resources.ts:296`).

## What a write does

Each write of a line moves `part.on_hand`:

| The write | The balance |
|---|---|
| Insert | Subtracts `by` (one per line without it), or refuses with 422 `consumes_refused` and writes nothing |
| Delete | Gives it back |
| Update | Moves the difference; a line moved to another part gives back to one and takes from the other |
| The reference set to null | Gives back |

`message` is filled from the part as it stands, with only what the reader may read.

## When to use it, and when not

Use it for a stored balance that must never go below zero. It applies on every door: Save, a list cell, an import, the App API, MCP and a command's own writes. Writing the line is the whole grant, so no role needs write access to `on_hand`.

For a figure you only read, such as units used so far, use a rollup (`sum('work_order_part', 'quantity')`) and store nothing.

## Options

- **`floor: false`.** Lets the balance go below zero, for backorders.
- **`by`.** The line's amount column; leave it out for one per line.
- **`message`.** The sentence a refusal says, reading `{ref.column}` of the part.

## Bring stock in: `restocks`

Receiving stock is a line too: `restocks` is `consumes` the other way round, so Receive stock is the receipt's New form, with no command.

```ts title="examples/apps/lintel/resources.ts"
restocks: { column: 'part_id.on_hand', by: 'quantity', message: 'Only {part_id.on_hand} of {part_id.name} are still on the shelf' },
```

See it in the sample (`examples/apps/lintel/resources.ts:330`).

An insert adds `by`, an update moves the difference, and a delete takes it back out, refused where those parts were used since. It takes the same keys and is held on the same doors.

A `restocks` refused (a delete or an update that would take back stock already used) answers with the same `consumes_refused` as `consumes`, since both refusals are the balance's.

## Limits

- There is no `when`. A cancel action zeroes its lines' quantity or deletes them, and the stock comes back.
- The part's history does not record the move; the line's does.

## Common mistakes

- `consumes-path`: `column` starts with something that is not a reference of the line. Write `part_id.on_hand`.
- `consumes-balance`: the balance is not a number column of the record the reference names.
- `consumes-by`: `by` is not a number column of the line.
- `consumes-decimal`: a whole-number balance moved by an amount that may be a fraction. Give both the same numeric type.
- `consumes-written`: a command writes a line and the balance too, so the line would count twice. Leave it to the rule. A command that writes only the balance (a stock count) is not named.

## Related

- [Check codes](/docs/check-codes/): every `consumes-*` code.
- [Money, lines and live totals](/docs/order-lines/): rollups over lines.
- [Relationships](/docs/relationships/): the reference a line follows.
