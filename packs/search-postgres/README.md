# @mistriwork/search-postgres

Postgres tsvector as the search provider for a mistri App's `search` blocks.

**Unpublished until after 1.0.** It is `"private": true`, it is not in the
`@mistriwork/mistri` npm package (`packs/` is outside the `files` allowlist),
and the mistri binary does not load it. Core rides on the database: without
a provider, a text filter runs there, and an App that declares `search` is
refused at startup with a sentence that points at the packs.

## What it is

Search is an index, never a source of truth. The index holds a copy of the
fields a resource declares searchable, keyed by the record's primary key,
and answers a phrase with keys; the rows are re-read from the database under
the reader's own grants. The pack holds only what is Postgres's:

- `src/postgresTsvector.ts`: one table per collection in the database the
  connection names, over `pg` — already an optional dependency of the
  engine, loaded on first use by dynamic import, so the pack adds no
  dependency. Each table holds the key as `text PRIMARY KEY`, each declared
  field as `text`, the tenant as a plain `text` column, and one generated
  `tsvector` column per field (`to_tsvector('simple', coalesce(field, ''))`)
  with a GIN index per vector column. The `simple` configuration on both
  the vector and the query means no stemming and no stop words, and the
  server's `default_text_search_config` never changes what an index holds.
  It writes a tenant's scope as an exact match on the tenant column, ranks
  by `ts_rank` with an earlier asked field weighing more, ties falling to
  the key, and rebuilds a table when a declaration adds a field — a
  generated column's expression cannot be altered. A field is never
  dropped. Collection and field names must be word characters; anything
  else is refused rather than quoted. Tables land in the connection's
  search path: a dedicated database, or a role whose search path names a
  schema, is the isolation, as it is for the connection's own database.
  There is no migration history and no store layout for search indexes:
  provisioning is lazy, on `ensureCollection`, exactly as the SQLite
  pack's is.
- `src/index.ts`: the connection entry as the deployment writes it
  (`postgresSearchConnectionOf`, which checks it) and the provider
  (`postgresSearch`).

Two deliberate divergences from the SQLite pack, both in
`src/postgresTsvector.ts`'s header: the runtime passes a tenant App's
tenant field inside `ensureCollection`'s field list, so here
`mistri_tenant` (and `id`, the document key) are stripped from the
searchable set and always present as plain columns, never as vector
columns; and there is no field cache, because a Postgres deployment is
multi-process and another process may have rebuilt a table since this one
last looked — every call re-reads the table's columns from the catalog.

Everything else — which filters are asked of the index, how its documents
are built and follow the App's writes, the tenant's scope, the reindex — is
core's (`packages/mistri/src/server/app/appSearchRuntime.ts`,
`packages/mistri/src/server/tenant/tenantSearch.ts`).

## How it plugs in

Core's seam is `packages/mistri/src/server/app/searchProvider.ts`: a
`SearchProvider` answers the `SearchIndex` a resource's `search.connection`
names, and an index does four things — `ensureCollection`, `upsert`,
`remove` and `search` (with an optional exact-match scope). The seam is
internal until the packs ship, so it does not freeze at 1.0; today the pack
reaches into `src/` by path.

```ts
import { plugSearch } from '../../packages/mistri/src/server/app/searchProvider.js';
import { postgresSearch } from './src/index.js';

plugSearch(registry, postgresSearch([{ name: 'pgsearch', url: '${DATABASE_URL}' }]));
```

An App names the connection in its resource:

```ts
resources: { ticket: { search: { connection: 'pgsearch', fields: ['subject', 'requester.name'] } } }
```

The pool is opened on first use. A `${VAR}` reference in `url` expands
when it opens, as a service URL's does, and is never logged. The index is
tables in Postgres, so it survives a restart and no reindex is needed after
one. The index is a copy: a record deleted outside the App keeps its
document until the next write or reindex, and searches already hide rows
the database no longer has.

## What it is not

- **A large catalog.** Tsvector tables in the deployment's own database
  suit the moderate tables Mistri's home turf holds. A large catalog still
  wants the Typesense pack, which answers from a dedicated engine instead
  of the deployment's database.
- **A schema-scoped store.** There is no `schema` option and no layout
  attestation: the tables are the pack's own, provisioned lazily, not a
  runtime store. Point the connection at a dedicated database (or a role
  with a pinned search path) when the index must not share a schema with
  business tables.

## Tests

The pack's tests are in the repository's own gate:
`test/search-postgres.test.ts` (the provider contract, ranking, scope, the
field-add rebuild, the GIN indexes, and a second provider over the same
database reading the same index). The suite is Postgres-gated: it skips
unless `TABLEWALK_TEST_PG` names a server, and CI sets
`TABLEWALK_REQUIRE_LIVE=1`, which turns that skip into a failure — so the
live half cannot pass silently without a server. The connection-config
checks (bad entries refused, unknown connections, bad names) run without a
server.
