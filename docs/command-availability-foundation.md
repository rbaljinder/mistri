# Command availability foundation

The server exposes a bounded visibility endpoint. Existing prepare paths check
`availability` before prefill, and
fresh execution rechecks it inside the transaction before the handler. Applied
receipt replay does not rerun business eligibility; existing receipt authority
checks remain in force. Record actions and bulk command menus consume visibility
before showing an action.
Handlers must retain their business authorization checks.

`defineCommand` accepts an optional `availability(context)` for commands naming
existing records (`targets` other than `'none'`). It returns one boolean per record, in order.
One-record commands also receive a batch, so a list can check several records
with one actor/staff lookup. The context provides the actor, immutable records,
read-only footprint `db`, cancellation signal, clock and request metadata. It
provides neither caller input nor a raw transaction or write methods.

The internal evaluator requires an already-authorized reader and target rows;
it does not establish principal, row, state or version authority. It captures
the actor as bounded data (64 KiB) and target rows through the existing bounded
structured-operation snapshot, at most the existing bulk target limit,
invokes only the captured eligibility hook, and accepts only an equally sized
dense boolean array. Results, records and nested JSON object/array containers are
immutable. Byte values are detached copies (JavaScript cannot freeze nonempty
typed arrays). No hook means no new row-value restrictions or eligibility
restriction beyond the host's existing checks; creating commands remain unchanged.
Trusted server code can still perform outside effects through its own imports;
the read-only context is a capability boundary, not a JavaScript sandbox.

`POST /api/commands/availability` accepts `{ checks: [{ command, commandVersion,
keys }] }` and returns `{ checks: [{ command, commandVersion, available }] }`.
Checks and their boolean arrays preserve request order. The strict envelope
allows at most 16 distinct commands and 200 total keys, with nonempty unique
keys per command; it accepts no actor, revisions or business input. Even a
single-record command can check several keys. Creating and public commands
answer false here; their existing execution contracts are unchanged.

Each command is authorized before its target data is read. Unknown, ungranted,
wrong-version and missing/invisible targets answer false without private
reasons, keys or revisions. Operational failures are generic; cancellation and
context expiry retain their normal lifecycle checks. No initial or handler runs.
Ordinary and row-policy paths use one target batch query per command. Tenant
and platform paths additionally retain one ownership-validation query per
matched target (at most 200 across the request); this first correctness slice
does not claim constant query count for those realms. Each predicate is still
called once per command, not once per row.

In a tenant App the whole batch is answered in one read snapshot, not the
writer's command transaction: the membership is revalidated in that snapshot,
each check reads through its own command's footprint and the tenant's row
scope, and its records refuse every write. The answer is advice — the
command's own transaction reads its target again, at the revision the form
saw, in the state its `when` requires, and asks the same hook before its
handler runs — so it holds no writer and queues behind none. On a platform
lease it is not refused while the account is inside a tenant elsewhere; the
command it advises on is.

An ordinary App's checks read the same way, for the same reason: through the
command source's own readers, under the command's read grants, with records
that refuse every write, every check of a request at once. They used to run
one writer transaction after another — a loan with four verbs was four,
queued behind every write, each looking its tables up in the catalog again —
and a record page at 20 ms to the database spent 0.6 s on them. A binding
whose source a verifier owns (`bindVerifiedBusinessCommands`) and a row-policy
App's policy context still answer in their own transactions.
A record page asks its verbs inside its one composed request
(`/api/pages/compose`); the client answers each check from it, once.

The client hides pending/unavailable actions, batches checks within a microtask,
and retires results with their record surface, principal, connection and tenant
lease. Writes invalidate visibility alongside record data. A shared batch is not
aborted when one caller unmounts; ownership checks discard late responses.
Recovery of an already-submitted command remains separate from the visibility
of a new action, so an uncertain operation can still be reconciled.

Existing bulk prepare performs one additional
target batch read and one hook call for eligible targets, not a per-row hook.
Visibility is a hint that can become stale, never permission to execute. Missing/invisible
records and failed checks must not disclose private reasons or staff mappings.

Ignition's revision command declares the hook and shares its staff/desk
predicate with its existing handler check. Empty staff mappings remain denied;
no deployment permissions are inferred or granted.
