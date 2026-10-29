# API exposure metadata

An App can declare explicit read exposure with `api` and `expose()`:

```ts title="app.ts"
import { defineApp, expose, listView } from '@mistriwork/mistri/app';

export default defineApp({
  name: 'Directory',
  resources: { person: {} },
  auth: { roles: { reader: { read: ['person'] } } },
  home: 'people',
  views: { people: listView('People', 'person') },
  api: {
    version: 1,
    roles: ['reader'],
    resources: {
      person: expose(['id', 'name'], { filters: ['name'], sorts: ['id'] }),
    },
    views: ['people'],
  },
});
```

This is validated metadata, not a running REST API. The declaration does not
create routes or credentials. A separate local CLI export can produce an
OpenAPI document, as described below. `api.commands` may also
name commands, by name, that address a record. A command preparation read
returns the revision a caller sends back; no version column is required. They are checked against the App's
commands module, which loading the App always loads. A form command has no
record to address and no route, so it is refused.

An `api` declaration is accepted for an ordinary SQL App with
`auth.rows: 'all'` (the default) and for a tenant App (`auth.rows: 'tenant'`),
whose tokens each act through one tenant membership. A tenant App's exposure is
checked against the web UI's own tenant catalog: platform-owned resources and
the managed ownership column are never exposed, and API roles must be tenant
roles. A row-policy App (`auth.rows: 'policy'`) is accepted too: its catalog
is the same per-role grant as an ordinary App's, and its rows are narrowed per
token by its own policy deployment when the request runs (below). Existing
Apps without `api` retain their behavior.

### Several sources

An ordinary or row-policy App of several sources may expose resources of any
of them, on SQLite and PostgreSQL. Each request reads, or commits on, exactly
one connection: the one its operation's source names, fixed when the catalog
is checked (sources that share a connection are one). On PostgreSQL an
ordinary App's read is one `REPEATABLE READ` snapshot on that connection.
Nothing is promised across requests — not between two resources on different
sources, not between the pages of a list, not between the event feed and a
read. Inside a request every other connection refuses, so an operation that
would read a second database fails rather than reading it. A row-policy App's
read runs in its deployment's context through that connection's reader alone
(`readsAt`), under the principal's rows there; no other connection's reader is
bound.

The checks say so before anything runs. A field, filter or sort whose path
reaches a resource on another connection is refused (`api-multi-source`):
expose that resource as an operation of its own. So is an exposed command
whose lookup (`sources`) reads another connection; a command's own reads and
writes are on its target's connection already. A resource on a source the API
does not serve — an HTTP API, or an engine it does not read — is refused
(`api-source-unsupported`). Every connection an exposed operation reads must be
on the engine of the native auth store, as for one source; a source the API
never reads is not judged. Generic writes stay single-source
(`api-write-unsupported`), and a tenant App keeps one source of its own.

The documents of such an App say this; a one-source App's are unchanged. Every
OpenAPI operation carries `x-mistri-source`, the source it reads or commits
on, and the document `x-mistri-consistency: single-source-per-request`;
each App MCP tool's description ends with the same sentence. The event feed
reads the store beside the source its emitting commands share. A schema change
on any of the App's connections retires the API's owner once a request on that
connection sees it, and the API answers 503 until it is rebuilt, as for one
source.

### Row-policy Apps

A row-policy App's API is served only under its `--policy`, by one owner over
the policy deployment the App's pages use (`policyApiOwner.ts`); the ordinary
engine owners refuse it, since they read tables whole. Every read and command
runs in the deployment's context for the token's account: the deployment asks
the API request who is calling, the request observes its token natively, and
the policy resolves that principal's rows. The principal is the account by id,
with the token's roles (narrowed to the roles the account holds now); it
carries no email, so a policy or stamp that matches a person by email finds
nobody for a token. Every token names an account, so there is no token without
a principal to refuse. After the work the token is observed once more before
the answer is handed over, as on the other owners. Deliberately not served:

- the event feed (`policy-events-feed`): a journaled event's payload is not
  re-read through the policy, so the feed could carry a row the token's
  account no longer reaches;
- generic writes (`api-write-unsupported`): a row-policy App writes through
  the commands it exposes, which its deployment's scoped binding runs;
- receipt recovery: a scoped binding's receipts are not recoverable through
  the shared recovery, so that route answers 422, outcome unknown, as a tenant
  App's does.

A command is checked before it runs and again before its answer; as for a
browser session, a revocation while its transaction is open does not roll it
back, and its answer is then withheld, outcome unknown.

## Exposure and authority

Fields must be explicit and include the complete primary key. Filters and sorts
must be members of that projection; listing a field does not automatically
make it filterable or sortable. UI `show` columns do not determine the API
projection, and adding a database column cannot widen it. File bytes and
nullable sorting paths, including reference joins, are refused in this slice.

The logical catalog validates the complete operation: output fields, joins,
standing queries, tabs and ordering dependencies. At least one declared API
role must read the whole shape. Combining partial access from two roles does
not make an operation eligible. Declaring exposure never grants database access.

The checked server catalog captures each exposed view's authored standing query,
AND-composed tab questions, effective ordering and first-tab default. It does not
freeze relative dates at validation time: request planning must supply a clock.
Tab identifiers reuse the browser's label-to-address spelling; ambiguous, empty
or reserved identifiers refuse. The API selects a tab with `?segment=<id>`, as a
resource list selects a segment; `?tab=` is the App's own page address and the
API refuses it. Standing query limits are currently unsupported
and refuse rather than being silently discarded. Authored view filter controls
are metadata only and cannot widen the explicit API resource filter allowlist.

Standing predicates on supported signed-integer columns require canonical
signed 64-bit integer literals. Decimal/exponent spellings, leading zeros and
boolean words refuse, even if JavaScript would round or coerce them to an
integer. Canonical digits beyond 2^53 remain exact strings. This API-only
constraint does not change the browser query grammar or select an output
integer representation.

API version, roles, exposure and referenced view semantics participate in
`authority.lock`. Widening fields or changing a standing query requires the
same explicit authority acceptance as other App authority changes. Descriptions
and presentation labels alone do not widen authority. Tab and named-sort labels
are exceptions because they identify existing selections.

Features may contribute `api.resources` and `api.views` only after the root App
declares `api`. Version, roles, `publicSpec` and the root description belong to
the App. Compatible projections merge; conflicting declarations name their
contributors. A referenced view's query is attributed to the feature that
authored the view, separately from the feature that exposed it.

An API reference can retain a list view for catalog validation without adding
it to navigation. It is not a substitute for an App's required home view.

## Scoped discovery

With local reads enabled, `GET /api/apps/{app-id}/v{version}/$openapi` returns
the read document narrowed to the bearer token's currently eligible
operations. For an App that exposes commands, the same route returns the
composed document — reads and commands — narrowed the same way. Item, list and view permissions remain independent. A valid token
with no eligible operations receives empty paths and row schemas. The route
accepts no query parameters and never uses browser cookies for authentication.

Unreferenced row schemas, eligible-role names and authored standing predicates
are omitted. Global App information, including its authored description,
remains discoverable; do not put secrets in that metadata. Authorization and
schema lifetime are checked again immediately before response handoff.

The document names itself with `x-mistri-document` (`app-api-reads`, or
`app-api` once commands compose in). With `publicSpec: true`, a request that
presents no `Authorization` header at all receives the whole composed
document instead, without eligible roles or standing predicates, charged to
its address's unauthenticated budget. A request that presents a credential is
always checked: a bad one is 401, never quietly answered with the public copy.
Publishing the shape grants nothing — every operation still needs a token
whose scope includes it. The AsyncAPI document stays a token's own.

## Local token-store maintenance

`mistri api-token --help` describes the local operator commands. They do
not start an API server or enable bearer authentication. This CLI slice
supports existing, separate SQLite and PostgreSQL native authentication stores.
Issuance currently requires a business source of the same engine as its auth store.

All commands require explicit `--app`, `--config` and `--store-id` arguments.
The store ID is a canonical UUID chosen once for that store; subsequent calls
must use the same ID. The App's authority lock must be accepted. Use trusted
App code and a connection-only configuration, with existing literal SQLite
file paths rather than credential references, URI paths or environment-variable
paths for SQLite maintenance. Business database paths follow the CLI's working
directory. PostgreSQL targets must include explicit user, host, port and database;
only `sslmode` and `options` URI parameters are currently supported. Configured
PostgreSQL credentials are resolved once for the invocation; the selected
auth store must also pass live business-database separation checks.

- `provision` explicitly adds the token extension to an existing native auth
  store. It does not create an auth database, users or account grants.
- `issue --subject <account-id> --actor <account-id> --role <role>
  --label <label> --expires-at <UTC-instant>` issues for an eligible native
  account. Repeat `--role` to request additional exact roles. Expiry must be
  a future UTC instant such as `2030-01-01T00:00:00Z`, not a local or relative
  date. The selected business source must be an existing literal SQLite path
  or a captured PostgreSQL connection, matching the auth-store engine. Its
  logical catalog is read through an invocation-owned read-only adapter.
- `inspect --token-id <uuid>` returns metadata and the current revision, or
  `null` for an unknown token. It never returns the secret or its digest.
- `revoke --token-id <uuid> --expected-version <revision> --actor <account-id>`
  revokes exactly the observed revision. The actor must be an eligible native
  account, but naming an actor is audit metadata—not remote authorization.

Issuance prints the token secret once, only after commit. Treat stdout as a
secret: store it securely and do not send it to CI logs. The store retains
only a digest, so a lost secret cannot be retrieved with inspect. To narrow
issuance to specific checked operation IDs, repeat `--operation <id>`. Omitting
that flag permits current and future eligible operations under the exact
issued roles; `--deny-all-operations` permits none. These options cannot be
combined. For an App whose `api` exposes commands, `issue` also takes
`--commands <file>`, the App's registry, because the catalog it checks
`--operation` IDs against includes those commands (`command:<id>`); without
it, issuance for such an App refuses. `provision`, `inspect` and `revoke`
never need it. Issuance does not itself activate a route or bearer
authentication.

For a tenant App, `issue` takes `--tenant <id>` and `--policy <file>`, the
App's server-only tenant policy, which names its tenant store. The subject's
membership in that tenant is read natively from the business database: it must
be active, in an active tenant, and the token's roles must be tenant roles that
membership holds. The token records the tenant, the membership ID and the
membership's version; any later change to that membership — its roles, its
status, a reissue — leaves the token without authority rather than following
it. The membership and the token live in separate databases, so issuance is a
native read of one followed by a transaction in the other, not one transaction;
the bound version is what makes a change in between safe. An `all` App refuses
`--tenant`, and a tenant App refuses a token without it. Tenant command
exposure is not issued for yet.

The token store layout is version 2, which carries that binding. A version 1
store is refused, not migrated: provision a fresh one.

### A tenant App's API reads

A tenant App's API reads run through the App's enrolled tenant deployment —
the reader and writer its web UI uses, never a second connection — under the
web UI's row scope for the token's membership. For each request, in order:

1. the token is observed natively in the auth store: its account must still be
   eligible, and it must be bound to one membership;
2. the operation must be in the token's scope, and the request is planned
   against the tenant catalog before any data is read;
3. the tenant runtime admits the account in the bound tenant — the membership
   it reads natively must be the bound one, at the bound version — and re-reads
   the token and then the membership before and after the read;
4. after all business work the token is observed once more and the answer is
   handed over; on PostgreSQL inside the auth store's native handoff, while its
   locks are held.

The token lives in the auth database and the membership in the business
database. Each check is native and fresh, but the two are sequential, never one
atomic observation: the last membership check follows all business work, and
the token's follows it. A revoked membership, a changed membership version or a
suspended tenant answers 403; a revoked, expired or unknown token, or one
issued for another App, answers 401.
A business database that cannot answer — busy, unreachable, a terminated
connection — answers 503 `temporarily_unavailable` (the same code the command
transport uses): authority was never decided, so it is not a refusal, and
nothing was read. A token store that cannot answer is the same case and answers
the same way: "we could not check" is never "your token is bad", so an
unreachable or failing auth database is 503 with the outcome unknown, never
401. The answer carries no database text, and a request that
fails this way is still refused, never served from anything but a fresh check.

A tenant-owned table's key is opaque text, or includes its tenant column (the
tenant store's rule). Lists and views order it by bytes, like any text sort
(below), and page through the bound membership's rows only. A cursor is bound
to the token's observed scope and its membership: presented under another
token — another tenant's, or another of the same account's — it is refused as
an invalid request and yields no rows.

A tenant App that exposes commands serves them to tenant tokens too; issue
one with `--tenant`, `--policy` and `--commands`. A command runs through the
tenant runtime's own command path — the membership's row scope, its fence
until COMMIT, its journal — and its answer says only what is known:

- a membership refused before any work (revoked, a changed version, a
  suspended tenant) is 403, outcome `not_applied`;
- a refusal inside the command transaction (another tenant's key, a stale
  revision) keeps the runtime's own outcome, which may be `unknown`, and is
  never upgraded;
- a business database that cannot answer, or a failure whose cause cannot be
  told, is 503 with outcome `unknown`: retry under the same Idempotency-Key,
  which replays an applied receipt.

A tenant token has no receipt recovery. The runtime's receipts belong to the
tenant, and the shared recovery refuses them, so the recovery route answers
422 (outcome `unknown`), and neither the `$openapi` document nor the tool
listing offers it. A tenant command must be in the tenant realm, write only
tenant-owned tables on the tenant source, and target a table whose key does
not include its tenant column; a command cannot yet run on a resource with
field access rules.

Serve it with the tenant host's own startup, under the App's policy:
`--api-reads` mounts the App API beside the tenant browser UI,
and `--app-mcp` enrolls the deployment itself, with no browser session at
all, so only App API requests answer. Both take `--policy` (and
`--commands` for an App that exposes commands) exactly as the tenant host
does, and use that deployment's one reader and writer.

These are local operator actions using filesystem access, not browser actions.
The complete configured business-store set is checked for separation before
maintenance. Removed API exposure or subject demotion does not prevent revoke.
Successful commands print one JSON result and exit zero; failures exit two.
A failed command or broken output pipe may leave the outcome uncertain:
inspect the same store/token before retrying. Failed issuance reports its
non-secret token ID when one has been selected, including an output failure
after commit. Revoke that record if the secret was lost; never blindly reissue.
Commands never retry mutations automatically. Schema inspection and auth-store
issuance are not one atomic transaction across databases.

## Serving the App API

After explicitly provisioning the separate native token store and issuing a
token, start the API with all three opt-in flags:

```sh
mistri --app ./directory --config ./mistri.json \
  --host 127.0.0.1 --port 4111 \
  --api-reads --api-integers decimal-string --api-requests-per-minute 120
```

For an App that exposes commands, also pass its registry. The command routes
are then served beside the reads; without `--commands` the server refuses to
start rather than serve half the declared API:

```sh
mistri --app ./ledger --config ./mistri.json --commands ./ledger/commands.ts \
  --host 127.0.0.1 --port 4111 \
  --api-reads --api-integers decimal-string --api-requests-per-minute 120
```

This requires one ordinary authenticated App with explicit `api` exposure and
an accepted authority lock, on one of two engines: an unambiguous literal
SQLite business-file path with a separate existing native SQLite auth store,
or explicit `postgres://` URLs — user, host, port and database named, only
`sslmode` and `options` parameters — for the business database and a separate
native PostgreSQL auth store. The token extension must already be provisioned.
Commands also need a writable, journal-migrated source, as they do in the
browser. Readiness is checked before listening; this mode does not provision
the token extension. A tenant or row-policy App is served under its
`--policy` (above); several sources are served one connection per request
(above), and a proxy identity header (`--auth-proxy-header`) is refused. On PostgreSQL the
answer is written inside the token store's final native handoff, after the
last authorization and while its locks are held.

Choose `decimal-string` or `number` explicitly; there is no default integer
representation. The request budget must also be explicit, from 1 to 1,000,000
requests per minute, and is each credential's own: keyed by a digest of the
whole credential, never its printed token ID, so a forged secret under a real
ID spends a budget of its own rather than the token's. A valid token is
judged by its own budget alone, so clients sharing a NAT or a proxy never
spend one another's; there is no ceiling across credentials for that reason,
and the transports' pending limit bounds what forged ones cost. A second
budget per client address (the budget, at most 60 a minute) counts what the
address does unauthenticated — no credential (a malformed one counts as
none), a credential the owner refuses (401), the public document — and over
it those requests are 429 instead, until its window rolls over; a request
that presents a well-formed credential is still checked. Both answer 429
with `Retry-After`. Rate limiting is process-local, not a distributed quota.
This mode cannot be combined with OpenAPI export, import, MCP or one-shot modes.

### Beyond loopback

Network exposure takes two decisions, and either alone refuses at startup.
The App declares `api.network: true`, recorded in `authority.lock`; the
operator listens beyond loopback — a non-loopback `--host`, an
`--allowed-host`, or a `--trust-proxy` — which `apiReadStartupOptions` reads
as the operator's half. The transports then admit peers off this machine, but
the `Host` header must still be the bound address or an `--allowed-host`
(DNS rebinding), a repeated `Host` or `Origin` is ambiguous, and a foreign
`Origin` is refused. The client address the budgets use is
`forwardedClient`'s: `X-Forwarded-For` only from a `--trust-proxy` peer.
mistri serves plain HTTP; TLS is terminated in front of it. A suite serves
its Apps' APIs on loopback only.

A tenant App's host passes its `--trust-proxy` ranges to the App API alone:
the API budgets each client by the address the proxy forwards, but the
tenant host's other routes (its public forms, invitation claims) still see
the proxy's own address, as they did before the API could leave loopback. Startup prints where the API answers, whether
beyond loopback, and its budget.

Read endpoints live under `/api/apps/<app-id>/v<api-version>`: `GET /<resource>`
lists exposed rows, `GET /<resource>/<key>` reads an item, and
`GET /views/<view-id>` applies an exposed list view's standing query. Send the
token through `Authorization: Bearer <token>`, never a URL parameter. Cookies
and proxy roles do not authenticate these endpoints, and bearer tokens do not
authenticate the browser's internal API. List responses contain `items` and
`next`; pass a non-null `next` back as the `cursor` query parameter.

Cursor ordering supports integer, finite-number, PostgreSQL boolean and text
columns. A nullable sort puts its nulls last in either direction, on every
dialect, and a cursor that stops on a null resumes among the nulls; the primary
key that ends every order is nonnullable. Text is ordered and compared by its bytes — `COLLATE "C"` on
PostgreSQL, `COLLATE BINARY` on SQLite — whatever collation the column or the
database declares, so a page boundary means the same thing to the ORDER BY and
to the comparison that resumes it, and `B` sorts before `a`. A cursor carries
the exact text of its boundary row; the complete primary key breaks ties.
Date ordering, including a date primary-key tie-breaker, is refused; dates can
still be projected. So can PostgreSQL `numeric`/`decimal` (exact text, `format: decimal`,
never a JSON number) and PostgreSQL `timestamptz` (an RFC 3339 instant,
`format: date-time`); neither can be filtered or sorted by. A column the API cannot say is refused
when the App is checked, not when the spec is exported. Joined ordering is also refused. Integer
representation and supported scalar-type restrictions apply to actual rows,
not just the generated schema.

Disconnecting cancels that request's remaining read work and suppresses its
response without retiring the shared reader. SQLite checks cancellation between
statements; a synchronous statement already running still finishes. Its lease
is retained until the work settles, and cancelled reads skip subsequent counts.

API reload is restart-only: changing the App retires its API owners, and
serving resumes only after restarting with a valid configuration. Cursors are
bound to that serving lifetime and do not survive restart. The request budget
is shared by reads, commands and `$mcp`.

### Commands

A targeted command the App exposes is run with
`POST /<resource>/<key>/commands/<command-id>/v<command-version>`. Send the
record's current revision as a strong `If-Match: "<revision>"` and a
client-chosen `Idempotency-Key` of 16–128 letters, digits, `_` or `-`; the body
is the command's input object. A command declared with `targets: 'many'` is
also served at `POST /<resource>/commands/<command-id>/v<n>` with a body of
`{ "targets": [{ "key": …, "version": … }], "input": … }` and no `If-Match`.

Before execution, `GET` the one-record command route with `/prepare` appended.
This bearer-authorized read returns `{ "version": <opaque integer> }` and its
strong `ETag`. Use that tag unchanged as `If-Match`; for bulk execution prepare
each target and carry its `version` beside its key. The revision is read through
the command's own authorized footprint, including when no version column
exists. Preparation writes no receipt and returns no hidden row fields.

Success answers `{ "receipt": { "id", "status", "replayed" }, "result" }`.
The same key with the same request replays the receipt (with
`Idempotent-Replayed: true`) instead of running the command again, so retry a
lost answer with the same key, never a new one.
`GET /commands/<command-id>/v<n>/receipts/<idempotency-key>` recovers an
applied request as `{ "receipt": { "id", "status": "applied", "recovered":
true }, "targets", "result" }`; an unknown key answers 404 with outcome
`unknown`.

Refusals are problem details (`application/problem+json`) with a fixed
`code`. Refusals decided before the command owner has the request carry no
outcome: 400 `invalid_request` or `idempotency_key_required`, 401
`unauthenticated`, 404, 405, 428 `precondition_required` (no `If-Match`), 429
over budget. After that, every refusal also says its `outcome`: `not_applied`,
or `unknown` when the server cannot tell (for example, an answer lost after
commit). The owner's codes are 403 `forbidden`, 404 `not_found`, 409
`stale_record`, `duplicate_record`, `ineligible_state` or
`idempotency_conflict`, 410 `command_version_mismatch`, 422 `invalid_input`
or `consumes_refused` (a line's `consumes` would take more than is left), and
503 `temporarily_unavailable` or `row_locked` (a row the command needed
was held by another transaction past the lock timeout; nothing was applied,
and a `Retry-After` header says when to try again). A stale revision's refusal
names the target it is about only when the request named it.

Each request is authorized by a fresh native observation of the token, and
again immediately before the answer is written: a token revoked in between
gets no stale result, and an uncertain outcome is reported as `unknown`, never
as not applied.

## App MCP

`--app-mcp` answers the same App API as MCP tools on stdin/stdout instead of
HTTP, for an agent's MCP client to start as a local process. It loads exactly
one App the way serving does, opens no listener, and reads the bearer token
from `MISTRI_API_TOKEN` — never from the command line, where other
processes can read it. The variable is removed from the process environment
before any App or command code loads; a missing or malformed value refuses
startup without echoing it.

```sh
MISTRI_API_TOKEN=… \
  mistri --app ./ledger --config ./mistri.json --commands ./ledger/commands.ts \
  --app-mcp --api-integers decimal-string
```

It needs the same App as the HTTP API — one ordinary authenticated App with
explicit exposure, an accepted lock, and the token extension provisioned in
its native auth store — plus `--api-integers`. It cannot be combined with
`--api-reads`, `--mcp`, `--jobs`, `--port`, `--open` or an import, one-shot,
demo or policy mode. It serves the same two engines as HTTP, with the same
checks. `--commands` is required exactly when the App exposes commands; a
read-only session loads no command code. It serves no sign-in, so it needs no
`BETTER_AUTH_SECRET` and never holds one: the native store and its token
observation are exactly the serving ones, and nothing it could sign outlives
the process.

The token is checked once at startup, through the same owner that answers
`tools/list`: a revoked, expired, unknown or other-App token exits with status
1 and a message that names the variable, never its value, before any tool is
listed. Every call is still authorized again on its own.

The session answers `initialize`, `ping`, `tools/list`, `tools/call` and
`notifications/cancelled`. `tools/list` is what the token may use now, from a
fresh native observation: `get_…`, `list_…` and `view_…` tools for its reads, and
`prepare_…`, `run_…` (`runMany_…` for `targets: 'many'`) and `recover_…` for its commands.
The read-only preparation tool takes `key` and returns `{ version }`, without
running the command. Pass that revision unchanged to execution.
A command tool takes `key`, `version` (the record's revision),
`idempotencyKey` and `input`. The idempotency key is required and never
generated, so a retry replays the receipt instead of running the command
again. Results carry the HTTP API's JSON as text and as `structuredContent`;
refusals are tool errors with the same `code` and `outcome`. A listing is
never permission: every call is authorized again, so a revocation reaches the
next call. App MCP does not run the webhook publisher; effects a command
records are delivered by the App's HTTP server.

### Over HTTP

`--api-reads` also answers `POST /api/apps/<app-id>/v<n>/$mcp`, the stateless
JSON form of MCP's Streamable HTTP transport, for every App it serves — an
ordinary App through the read and command transports' own owners, a tenant
App through its tenant owner. Each POST is one JSON-RPC message with the
bearer token in `Authorization`, read afresh every time; a session is made for
that message and discarded, so nothing a client keeps is authentication. It is
admitted as the routes are, under the same budgets. A missing token, or one
the owner refuses, is HTTP 401 with `WWW-Authenticate: Bearer`, the handshake
included: `initialize` and `ping` first ask the owner whether the token
observes. An OAuth 2.1 token source would plug in at that same check; it is
not implemented, and only issued API tokens are accepted.

## OpenAPI export

Export exactly one App with explicit API exposure and an accepted authority
lock. The configured database supplies the logical schema; export does not
start an API server or initialize authentication storage.

```sh
mistri --app ./directory --config ./mistri.json \
  --export openapi --api-integers decimal-string > directory.openapi.json
```

Choose the integer representation explicitly. `decimal-string` preserves the
signed-int64 range; `number` requires values within JavaScript's safe integer
range. There is no default. `decimal-string` means integer digits, not SQL
`DECIMAL`, `NUMERIC` or money support; those types remain unsupported.
A composite key is one path parameter, an object serialized with
`style: simple, explode: true` (`order_id=1,line=2`); a generated client must
be given that serializer. the database browser's OpenAPI importer skips such a
resource rather than misreading it.

Read documents include closed, status-specific error envelopes of the form
`{"error":{"code":"not_found","message":"The API request could not be completed."}}`.
They describe the private transport's refusals without exposing account,
token, SQL or driver details. Generated clients still need explicit runtime
configuration: a base URL including the document's server path, a bearer header,
and comma-separated filter-array serialization. Generated types alone do not
configure those behaviors or validate responses at runtime.

Compare two exported documents without opening an App, database or server:

```sh
mistri compare-openapi previous.openapi.json directory.openapi.json
```

The JSON report retains findings even when the API version has been increased.
Exit status is `0` when the version requirement is met, `1` when a required
increase is missing or the version decreased, and `2` for invalid or unsupported
input. Comparison requires bounded regular local files and no-follow/nonblocking
file-open support; Windows comparison is currently unsupported. This is a
conservative comparison of these documents, not a general OpenAPI
compatibility proof or evidence of live endpoint behavior.

## Remaining contract work

Execution on both engines composes genuine native token observation,
projected item/list/view reads, verified cursor continuation and, for exposed
commands, the shared command executor with idempotent receipts, through the
explicit `--api-reads` opt-in above. An `api` declaration or token issuance
alone does not enable it, and `api.network` alone does not open a listener.
Several sources remain refused at check time; OAuth-issued
tokens would be read where the bearer token is today, behind the same owner
check, and are not implemented.
