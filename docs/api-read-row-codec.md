# Read-row wire codec foundation

This internal codec binds an already checked read operation's exact flat field
projection to one JSON Schema and one row encoder. It is not a route, query
executor, authorization proof, generated API or complete transport contract.
Its stage is `read-row-wire-codec`; it does not validate a list envelope itself.
A separate envelope codec checks the page limit, optional bounded count and
opaque continuation field. Transport-wide byte/depth limits and live cursor
integration remain separate work.

Integer representation must be chosen explicitly: `decimal-string` preserves
the full signed-int64 range from exact adapter numbers/decimal strings; `number`
refuses anything outside JavaScript's safe integer range. Unsafe numbers are
never repaired by stringifying them. Known floating-point types accept finite
numbers only, known text types accept strings only, and PostgreSQL booleans
accept booleans only. SQLite numeric boolean representations are not
silently converted by this raw-read codec.

Every exposed field, including the complete nonnullable primary key, is required.
Joined fields allow null because the query compiler uses LEFT JOIN even when
foreign-key columns are declared nonnullable. Extra input fields are omitted;
extra output fields are disallowed by the schema. Missing own data properties,
getters and unsupported row objects refuse without invoking getters. Normal
and null-prototype adapter records are accepted. Captured metadata and returned
schemas/rows cannot be changed after construction.

Nonempty catalog `allowed` values on supported text/integer/DATE columns are encoded
through the same scalar codec, deduplicated and enforced as an enum in both
schema and encoder. Impossible or empty sets refuse; ambiguous boolean and
floating-point allowed-value metadata is not guessed. This does not add support
for database ENUM type declarations.

Decimal/money, unsigned integer declarations, unknown or custom types, raw enum
types, binary/JSON and timestamp/time/instant types are outside this slice. It makes no claim
that database range, precision or arbitrary CHECK constraints are fully described
by the wire schema. Unsupported representations fail rather than guessing.

Exact SQL `DATE` declarations accept only real Gregorian `YYYY-MM-DD` strings
from `0001-01-01` through `9999-12-31`. The schema checks leap years and month
lengths as the encoder does, without a JavaScript Date or timezone conversion.
PostgreSQL's DATE text parser retains text; SQLite
stored values must already have this shape. Non-ISO PostgreSQL DateStyle output,
BC/infinity, timestamps and numeric SQLite values fail closed.
This is a codec contract, not live-database verification or support for DATE keys.

## Typed filter foundation

`validateApiFilters` consumes the lexical list parser's filters and the checked
operation's explicit filter allowlist. It shares the row scalar codec's SQL-type
classification, integer representation, enums and encoding. Results contain only
immutable equals/in/range predicate data; caller and row-scope authorization are
still pending. No SQL is produced.

Integer bounds retain exact digits and are compared without floating conversion.
Floating values use strict finite decimal syntax (no exponent, hexadecimal,
nonfinite or nonzero-underflow values); reversed ranges refuse. Text keeps numeric
lookalikes as strings and supports only equality/in. Booleans accept only literal
`true`/`false`, not numeric aliases. Duplicate encoded list members collapse.
DATE supports equality/in and inclusive civil-date ranges, compared
lexicographically after strict calendar validation. Date range recognition is
API-only; the browser's address helper is unchanged. Enum-constrained DATE range
endpoints must be declared enum members, just like integer range endpoints.
Nullable/joined fields do not introduce an implicit null sentinel: text `null`
is the string, not SQL NULL. An explicit null-filter vocabulary is future work.

Decoded text members retain leading/trailing spaces exactly; numeric and boolean
padding refuses rather than silently trimming. Floating values use binary64
semantics, not arbitrary decimal precision; decimals rounding to the same number
have equal bounds. Signed zero is canonicalized to JSON's single zero in both
row and predicate encoders. Scalar metadata must be own data properties, and
allowed-value arrays must be dense string data: accessors/proxies and sparse
enum arrays refuse rather than creating invalid schemas.

## Resource-list request planning

The internal `planApiReadRequest` composes checked exposure, strict lexical
parsing, typed filters, complete-key ordering and projected row/envelope encoding.
It accepts resource-list operations; authored views use a separate planner so
their standing constraints cannot disappear. It executes no SQL
and grants no authority. Cursor input is retained as `unverifiedCursor`, never
as proof that another page may be read.

Sparse response fields retain the complete key. An exposed sort field omitted
from the response remains in the separate internal fetch projection and is
stripped by the response encoder. Narrowing fields cannot bypass validation of
unsupported types elsewhere in the operation's full exposure. The envelope
enforces the requested page limit and includes a count only when requested.

Each list plan also has a typed boundary codec for its complete effective order.
It projects only ordering values, preserves exact integer keys, and produces
lexicographic continuation branches for mixed ascending/descending sorts.
Ties continue through the complete primary key. These branches are an additional
AND constraint, never a replacement for standing questions, request refinements
or authorization. The separate private encrypted cursor codec checks exact
bindings and explicit lifetimes, but is not integrated with request execution.
A text ordering column's terms carry a binary collation, as the view's ORDER BY
does, so neither follows the database's own collation. Trusted binding
computation and key lifecycle belong to the serving owner; neither codec alone
can authorize pagination.

`planApiItemReadRequest` uses a separate strict key codec and the full exposed
row projection. Its input is one raw, still-encoded URL segment. Composite keys
name every key column; literal comma/equals separators are split before values
are decoded exactly once. Integer keys require canonical digits. Text keys keep
encoded delimiters, while empty/control text and single dot segments refuse.
Only nonnullable text/signed-integer keys are currently supported. A valid key
does not prove that a record exists or that the caller may read it. No item
route or HTTP error mapping is introduced by this planner.

`planApiViewReadRequest` selects the declared/default tab, preserves the
AND-composed standing question and resolves its order separately from request
sort overrides. Relative dates use the supplied request clock and existing query
date semantics, not the catalog's fixed validation date. The immutable standing
filter and typed refinements must both constrain a future executor. Undeclared
tabs, ambiguous tab identifiers and standing limits refuse. These plans still
perform no database reads, authorize no principal and verify no cursor.

Catalog and request planning share `parseApiStandingQuery`. Integer predicates
must use canonical signed-int64 digits; decimal/exponent spellings refuse
before rounded values can become standing constraints. A second pass through
the existing grammar disables only integer-to-number coercion to validate
lexemes; the original predicate is retained after validation. Text and DATE
semantics are unchanged, and this does not choose a default wire strategy.

## Existing query-compiler handoff

The private `createApiReadView` helper rechecks raw route inputs and converts a
request plan to an immutable `ViewDef` for the existing SQL compiler. It retains
standing OR branches and adds every refinement to each branch. Boolean list
filters expand into bounded equality branches rather than being converted to
numeric or non-null predicates. Unverified cursor input still refuses.

Lists request one row beyond the page limit; items request at most two rows.
A future execution owner must remove the list sentinel before encoding, reject
multiple item rows, and separately enforce current authorization. Requested
counts remain plan metadata: the row-fetch limit is not a count bound, so the
owner must pass an explicit bounded count limit. This handoff itself executes
no query and installs no route.
