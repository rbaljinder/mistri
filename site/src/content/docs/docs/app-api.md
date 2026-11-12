---
title: App API
description: Serve an App's declared reads and commands to other programs with scoped tokens, over HTTP or as MCP tools for a coding agent.
---

Serve an App's declared reads and commands to other programs with scoped tokens, over HTTP or as MCP tools for a coding agent.

```ts
import { expose } from '@mistriwork/mistri/app';

api: {
  version: 1,
  roles: ['operator'],
  resources: { item: expose(['id', 'revision', 'name'], { filters: ['name'], sorts: ['id'] }) },
  views: ['open-items'],
  commands: ['change'],
},
```

<!-- no sample: no sample App declares an api block; build-an-api starts one. -->

Nothing is served until you ask for it, and only on loopback unless the App
and the operator both choose the network. It works on SQLite and PostgreSQL.

## Declare what the API exposes

| Key | Says |
| --- | --- |
| `version` | The API version, in every route (`/v1`). |
| `roles` | The App roles a token may carry. Never more than they already grant. |
| `resources` | `expose(fields, { filters?, sorts?, create?, update?, delete? })` per resource: exact columns; new database columns are never added. `create`, `update` and `delete` are generic writes, off by default: commands named `create-<resource>`, `update-<resource>` and `delete-<resource>` on the routes below, held to the token's roles' own editor rules (field ceilings, validation, transitions, stamps). |
| `views` | List views served as filtered reads. |
| `events` | Command events the feed serves (`task.completed`); each is a token operation, `event:<name>`. Apps whose roles read all rows only. |
| `network` | `true` lets the API answer beyond loopback when the server listens there. Off by default. |
| `publicSpec` | `true` serves the whole OpenAPI document to a request with no token. Off by default. |
| `commands` | Commands by name, from the App's commands module, that name a record; preparation returns its opaque revision to send back as `If-Match`, with no required version column, or `{ command, label, description }`. Each route carries the command's version from `authority.lock` (`…/commands/change/v2`). A signed-in form's command (`targets: 'none'`) is exposed too, on its resource with no record; a public form's is refused. |

The declaration is checked against the catalog and the App's grants and
recorded in `authority.lock`. Features may add resources, views and commands.
A composite key is one path segment of `column=value` pairs
(`/part/order_id=1,line=2`). An App of several sources serves each request from
one connection, and says which in each operation (`x-mistri-source`); a path
from one connection's resource into another's is refused (`api-multi-source`).
Nothing is promised across requests.

A row-policy App (`auth.rows: 'policy'`) is served under its `--policy`: each
token reads and acts as its own account, through the same policy the App's
pages use, so a row the policy hides is not found and a command on it is
refused. Its token names the account by id, not by email. It writes through
the commands it exposes; it has no event feed and no generic writes
([what each kind of App can do](/docs/row-access/#what-each-kind-of-app-can-do)).

## Tokens

Tokens live in the App's native auth store; cookies never authenticate the API.
`mistri api-token --help` lists the commands: `provision` (once per store),
`issue` (prints the secret once), `inspect` and `revoke`.

```sh
mistri api-token issue --app ./ledger --config ./mistri.json --store-id <uuid> \
  --commands ./ledger/commands.ts --subject <account-id> --actor <account-id> \
  --role operator --label "Ledger automation" --expires-at 2030-01-01T00:00:00Z
```

A token carries exact roles, an expiry and optionally the operations it may
use (`--operation item:item`, `--operation command:change`). Every request
checks it again, so a revocation applies to the next one.

### A token for one row

`scopes` narrows a token to one key row, such as one clinic's records for an
agent that works on that clinic. A scope names its key resource and, for each
resource, the column that holds the key or a one-hop path through a reference:

```ts
api: {
  // …
  scopes: {
    clinic: { key: 'clinic', rows: { clinic: 'id', patient: 'clinic_id', visit: 'patient_id.clinic_id' } },
  },
}
```

Issue a scoped token with `--scope clinic:1`, or get one from an unscoped token:

```sh
curl -X POST "http://127.0.0.1:4111/api/apps/clinics/v1/\$scope" -H "Authorization: Bearer $TOKEN" \
  -d '{"scope":"clinic","key":1,"ttl":600}'
```

The child token keeps its parent's roles and operations. It lives `ttl`
seconds (15 minutes unless said, at most an hour), never longer than its
parent, and revoking the parent ends it. A key the parent cannot read answers
404, as a missing one does. A scoped token that asks again answers 409
`scope_fixed`.

The scope joins the row scope of every read, write and command, so it costs no
round trip:

- a row outside the scope is not found;
- an insert outside it answers 422 `out_of_scope`, and a mapped column the
  insert leaves out takes the key;
- a resource the scope does not map reads and writes nothing (`mistri check`
  names each one);
- a command sees the scope as `context.actor.scope` (`{ name, key }`);
- the read audit and each command receipt record it as `clinic:1`.

Scopes are for Apps whose rows are already limited: a row-policy App
(`auth.rows: 'policy'`) or a tenant App.

## Serve it over HTTP

```sh
mistri --app ./ledger --config ./mistri.json --commands ./ledger/commands.ts \
  --host 127.0.0.1 --port 4111 \
  --api-reads --api-integers decimal-string --api-requests-per-minute 120
```

`--api-integers` (`decimal-string` or `number`) and the request budget have no
defaults. Leave out `--commands` when the App exposes none. Routes live under
`/api/apps/<app-id>/v<version>`:

| Request | Does |
| --- | --- |
| `GET /<resource>` | Lists exposed rows; pass a non-null `next` back as `cursor`. A nullable sort puts its nulls last, both ways |
| `GET /<resource>/<key>` | Reads one row |
| `GET /views/<view-id>` | Applies an exposed list view; `?segment=<tab>` picks one of its tabs (the word the App's own address spells `?tab=`), and `sort=` orders it |
| `GET /<resource>/<key>/commands/<id>/v<n>/prepare` | Reads `{ version }` and an `ETag` through the command's authorized reader; runs no command |
| `POST /<resource>/<key>/commands/<id>/v<n>` | Runs a command, with `If-Match: "<revision>"` and an `Idempotency-Key` |
| `POST /<resource>/commands/<id>/v<n>` | Runs a `targets: 'many'` command: `{ "targets": [{ "key", "version" }], "input" }` |
| `POST /$scope` | Mints a token narrowed to one row: `{ "scope", "key", "ttl"? }` ([a token for one row](#a-token-for-one-row)) |
| `GET /commands/<id>/v<n>/receipts/<idempotency-key>` | Recovers a receipt |
| `POST /<resource>/commands/<id>/v<n>` | Runs a signed-in form's command: the input as the body, an `Idempotency-Key` and no `If-Match` |
| `POST /<resource>/commands/create-<resource>/v1` | A generic create, with an `Idempotency-Key`; answers the new record's key |
| `GET /$events?after=<next>&limit=<n>` | The event feed, oldest first: `{ items, next }`; only the token's `event:` operations, about records its roles read |
| `GET /$openapi` | The OpenAPI document, narrowed to this token; with `publicSpec`, the whole document to a request with no `Authorization` |
| `GET /$asyncapi` | The AsyncAPI 3 document of the feed, narrowed to this token |

A command's input is read as the form reads it. An amount from `field.money({ minor: true })` is sent in the
currency's major unit as decimal text, `{ "price": "19.99" }`, never as minor units: the command receives `1999`,
and a `1999` sent is read as 1999.00. A fraction finer than the currency's places is refused, not rounded. The
rows a read returns keep the stored integer.

A command answers `{ "receipt": { "id", "status", "replayed" }, "result" }`;
the same `Idempotency-Key` replays the receipt instead of running again.
Refusals are problem details with a `code` and an `outcome` (`not_applied`, or
`unknown`).

### Rate limits

`--api-requests-per-minute` is each token's budget, and a valid token is
judged by it alone. Requests without a token, and tokens the server refuses,
spend a second budget per client address (at most 60 a minute); over it they
wait. Over either, the answer is `429` with `Retry-After`. The counts live in
the process: a restart or a second process starts afresh.

### Beyond loopback

Set `network: true` in the App's `api`, then listen beyond loopback: another
`--host`, an `--allowed-host`, or `--trust-proxy` for the proxy in front.
Either alone is refused at startup.

```sh
mistri --app ./ledger --config ./mistri.json --host 0.0.0.0 --port 4111 \
  --allowed-host api.example.com --trust-proxy 10.0.0.5 \
  --api-reads --api-integers decimal-string --api-requests-per-minute 120
```

Only scoped bearer tokens are accepted, and only for the `Host` you allow.
mistri serves plain HTTP: put a proxy that terminates TLS in front, and name
it with `--trust-proxy` so each client's address is the one budgeted.

## Use your App from Claude Code

`--app-mcp` speaks the same API as MCP tools over stdio. Reads are `get_…`,
`list_…` and `view_…` tools; commands are `run_…` (`runMany_…`) and
`recover_…`. A form's command (`targets: 'none'`) is one `run_…` tool with no
record to name: it takes `idempotencyKey` and `input`, as the HTTP route does,
and a retry under the same key replays its receipt. The token comes from `MISTRI_API_TOKEN`, never the command line:

```sh
claude mcp add ledger -e MISTRI_API_TOKEN=<token> -- \
  mistri --app /srv/ledger --config /srv/mistri.json \
  --commands /srv/ledger/commands.ts --app-mcp --api-integers decimal-string
```

Give it a token issued for this use alone, with the fewest operations and a
near expiry, and do not add it with `--scope project`, which would write the
token into the repository.

### MCP over HTTP

`POST /api/apps/<app-id>/v<version>/$mcp` speaks the same tools as
`--app-mcp`, one JSON-RPC message per request, with the token in
`Authorization: Bearer`. It is served beside the routes, on loopback or
beyond it, under the same budgets. A missing or refused token is `401` with
`WWW-Authenticate: Bearer`, the handshake included, and it is checked again on
every request, so revoking it refuses the next call.

```sh
claude mcp add --transport http ledger https://api.example.com/api/apps/ledger/v1/\$mcp \
  --header "Authorization: Bearer <token>"
```

### OAuth for agents

With an authorization server in `mistri.json`
(`{ "name": "agents", "kind": "oauth", "apps": ["ledger"] }`,
[services](/docs/services/#oauth-kind-oauth)), an MCP client needs no token
handed to it: a `401` names the resource's metadata
(`WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/api/apps/ledger/v1/$mcp"`),
the client registers itself, and the person signs in to the App and chooses
which of their roles it may act with.

```sh
claude mcp add --transport http ledger https://api.example.com/api/apps/ledger/v1/\$mcp
```

OAuth 2.1 with public clients only: PKCE S256, redirect addresses matched
exactly, and a `resource` naming this App's API at this version. The access
token is an ordinary API token for an hour; a refresh token rotates on each
use, and the grant ends 30 days after consent. A role the person loses, or a
role the operator's `roles` leaves out, is gone from the next request; a
refresh token used twice revokes the grant. The person sees and disconnects
their clients from their profile. In a tenant App the person also picks one
of their tenants, and the token is that membership's: its rows only, its roles
only, and over once the membership is revoked or changed. The stdio
`--app-mcp` takes no OAuth token.

## Export the contract

`--export openapi` prints the document without starting a server, and
`--export asyncapi` the AsyncAPI 3 one: feed events, the webhooks commands post
to and, with `--jobs`, the signed inbound endpoints.
[Build an API](/docs/build-an-api/) walks through all of it.

```sh
mistri --app ./ledger --config ./mistri.json --commands ./ledger/commands.ts \
  --export openapi --api-integers decimal-string > current-api.json
mistri compare-openapi previous-api.json current-api.json
```

`compare-openapi` reports changes between two exported files: exit `0` when
the version requirement is met, `1` when a needed version increase is missing,
`2` for invalid input. It is a review aid, not a compatibility proof.

## A typed client

`mistri api client` writes a TypeScript client from the exported document. It
reads the file offline, with no server, App or database, and writes one file
with no imports: a type for every row and every command's input and result, a
function per operation, and an `ApiError` for a refusal.

```sh
mistri api client current-api.json --out ./src/ledger-client.ts
```

```ts
import { createClient, ApiError } from './ledger-client';

const api = createClient({ baseUrl: 'https://example.com/api/apps/ledger/v1', token });
const item = await api.readItemItem({ id: '1' });
try {
  await api.commandChange({ id: item.id, ifMatch: '"0"', idempotencyKey: crypto.randomUUID(), body: {} });
} catch (error) {
  if (error instanceof ApiError && error.problem?.code === 'stale_record') {
    // error.status is 409; error.problem is the refusal's problem details.
  }
}
```

The same document gives the same bytes, so the file can be committed and
reviewed beside `compare-openapi`'s report. Ids past 2^53 stay strings, as the
document declares them. The client uses only `fetch`, `URL` and
`URLSearchParams`, so it runs in a browser, Node 20+, Deno and Workers.

## Tenant Apps

A tenant App's token binds one membership:

```sh
mistri api-token issue --app ./depot --config ./depot.json --store-id <uuid> \
  --tenant north --policy ./policy.mjs --commands ./commands.ts \
  --subject <account> --actor <operator> --role member \
  --label "North API" --expires-at 2026-10-01T00:00:00Z
```

Serve it with `--policy` beside `--api-reads` or `--app-mcp`. The token reads
and runs only that tenant's rows; a changed membership or suspended tenant is
refused on the next call. Platform-realm views, commands and sources cannot be
exposed. A tenant token has no receipt recovery: retry with the same
`Idempotency-Key`.

The App's data may be on PostgreSQL while its sign-ins stay in the default
local store, and its connection may name the database by reference
(`"url": "${DATABASE_URL}"`).

### Tokens a member makes

On a tenant App with an `api` block, a signed-in member makes their own
tokens on their tenant's context, as **API tokens** in the account menu does: `POST /api/tokens` lists
them with the roles on offer, `/api/tokens/issue` takes
`{ label, roles?, operations?, days? }` (90 days unless said, at most 366)
and answers the secret once, and `/api/tokens/revoke` takes `{ id }`. Making
one needs a sign-in from the last five minutes; an older session answers 403
`sign_in_required`, and the person signs in again. Each
token binds the member's own membership in that tenant, with roles no wider
than theirs and the API's. A member sees and ends their own tokens. A
tenant's administrator — a member the tenant policy's `administration` lets
end memberships (`revokeMembership`) — also sees and ends other members'
tokens whose roles are all theirs too; a token acts under its own roles, never
its member's wider ones. Nobody sees another tenant's. The operator provisions the token store once
(`mistri api-token provision`); until then the routes answer
`tokens_unprovisioned`.

## Not yet

On the MCP surface (`$mcp`) only: several sources, form commands (the HTTP API above exposes a signed-in form's command), and an event stream.

## Related

- [An API-only App](/docs/build-an-api/): start an App that is only an API, step by step.
- [Commands](/docs/commands/): what an exposed command does, and how it refuses.
- [Roles and field access](/docs/roles/): the grants a token can never exceed.
- [Observe and operate](/docs/observe/): traces of every API request.
