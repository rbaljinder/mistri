# Service virtualization: the contract

The site's [Service virtualization](../site/src/content/docs/docs/service-virtualization.md)
(<https://mistriwork.dev/docs/service-virtualization/>) is the how-to. This file
keeps the full semantics it left out: matching, state and time, faults and
limits. The code is `src/server/virtualization/`.

Unexpected requests, malformed JSON, ambiguous routes and handler errors fail
teardown, even if application code catches the resulting HTTP error. Missing
expected calls fail when `verify` runs. Intentional HTTP errors and transport
faults are expected behavior and remain visible in `service.journal()`.

## Matching

Omitted matcher fields impose no constraint. Methods are case-insensitive.
Paths match literal segments, named `:parameters`, or a final `*` remainder.
Parameters are percent-decoded after splitting the path: an encoded slash stays
inside its parameter. Duplicate parameter names and non-final wildcards are
invalid. Empty parameter values do not match.

Query and header matchers accept a string, an ordered string array, a regular
expression or a synchronous predicate over the received values. A string or
regular expression requires exactly one value. An empty array asserts absence.
Header names are case-insensitive; query names are case-sensitive. Additional
unmentioned headers and query keys are allowed. Regular expressions retain no
cursor state across requests.

Bodies are parsed as JSON for JSON content types, as fields for URL-encoded
forms, and as text otherwise. Use `{ exact: value }`, `{ partial: value }` or
`{ predicate: body => boolean }`. Partial matching recurses through object
properties; arrays retain exact order and cardinality. Predicates execute
trusted synchronous test code. They must return a boolean.

If several routes match, the highest numeric `priority` wins. Ties fail with
the conflicting route IDs. Declaration order never silently resolves an
ambiguous match. An unmatched request reports differences for candidate routes
without including body or header values.

## State, scenarios and time

Handlers receive `params`, `query`, `headers`, parsed `body`, original UTF-8
`rawBody` for webhook signature verification, `state`, `clock`,
`random` and an abort `signal`. Handlers execute serially within an instance.
Each sees a private copy of the last committed state. Successful completion
commits that copy before the transport reply; an exception or handler timeout
rolls it back. Concurrent requests cannot lose a state update. Retaining a state
reference cannot mutate a later transaction. A transport disconnect may happen
after state commits, which supports testing uncertain outcomes and idempotency.

Handlers are trusted code. Await their asynchronous work and pass `signal` to
outbound calls. The engine cannot cancel arbitrary detached work or undo an
external side effect performed by a handler.

`service.scenario('unavailable')` selects named route overrides. Same-ID routes
replace base routes; other IDs add routes. Already admitted requests keep their
captured scenario. `service.scenario(null)` returns to base behavior. Scenario
changes retain state and journal. `service.reset()` requires an idle, verified
instance and restores initial state, base routes, empty journal, clock and seed.
It cannot erase a failed test.

Logical time starts at `now` (default `0`) and advances only through
`service.clock.advance(milliseconds)`. A handler can await `clock.sleep(...)`;
the test advances time to release it. Seeded `random()` produces the same
sequence after reset. Use state counters for repeatable sequences such as two
503 replies followed by success.

## Faults and resource limits

A reply can set `delayMs` for a wall-clock response delay, `fault: 'disconnect'`
to close the connection, or `fault: 'timeout'` to withhold a response until the
caller cancels or the request deadline expires. These are separate from logical
business time. The default total request deadline is 5 seconds; configure
`handlerTimeoutMs` up to 300 seconds when needed. A caller's cancellation fences
queued handlers and late state commits.

The default body limit is 1 MiB and journal limit is 10,000 requests. Configure
`maxBodyBytes` and `maxJournalEntries` for a bounded larger fixture. Exceeding a
limit fails the test. Responses own their framing; do not supply
`content-length`, `transfer-encoding` or `connection` headers.

## The credit service example

`test/keystone-acceptance/credit-service.ts` (kept with the Keystone fixture, not shipped) models pending checks, controlled
completion and callbacks. Advance its clock by 1,000 milliseconds, then POST
`/dispatch` to deliver due callbacks. Each callback signs
`timestamp + '.' + rawBody` with HMAC-SHA256 using an explicitly supplied test
secret. The receiver verifies the raw-body signature and timestamp window and
deduplicates the signed check ID. Dispatch awaits the callback and marks it
delivered only after a successful response; receivers must tolerate a retry
after an uncertain transport outcome.
