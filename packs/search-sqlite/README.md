# @mistriwork/search-sqlite

SQLite FTS5 as the search provider for a mistri App's `search` blocks.

**Unpublished until after 1.0.** It is `"private": true`, it is not in the
`@mistriwork/mistri` npm package (`packs/` is outside the `files` allowlist),
and the mistri binary does not load it. Core rides on the database: without
a provider, a text filter runs there, and an App that declares `search` is
refused at startup with a sentence that points at the packs.

## What it is

Search is an index, never a source of truth. The index holds a copy of the
fields a resource declares searchable, keyed by the record's primary key,
and answers a phrase with keys; the rows are re-read from the database under
the reader's own grants. The pack holds only what is SQLite's:

- `src/sqliteFts.ts`: one FTS5 table per collection in one file, on Node's
  built-in `node:sqlite` (the engine's SQLite adapter uses the same driver,
  so the pack adds no dependency). It writes a tenant's scope as an exact
  match on a column, ranks by bm25 with an earlier declared field weighing
  more (full-text ranking: a rare word in a later field can still outrank a
  common word in an earlier one), and rebuilds a table when a declaration
  adds a field — FTS5 tables cannot be altered. Collection and field names
  must be word characters; anything else is refused rather than quoted.
- `src/index.ts`: the connection entry as the deployment writes it
  (`sqliteSearchConnectionOf`, which checks it) and the provider
  (`sqliteSearch`).

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
import { sqliteSearch } from './src/index.js';

plugSearch(registry, sqliteSearch([{ name: 'fts', file: './search.db' }]));
```

An App names the connection in its resource:

```ts
resources: { ticket: { search: { connection: 'fts', fields: ['subject', 'requester.name'] } } }
```

The file is opened on first use. `:memory:` holds the index in the process
only, like the built-in `memory` provider, and suits tests; a file survives
a restart, so no reindex is needed after one. The index is a copy: a record
deleted outside the App keeps its document until the next write or reindex,
and searches already hide rows the database no longer has.

## What it is not

- **Postgres tsvector.** The tree serves two databases, but this pack covers
  SQLite only. A Postgres-backed provider is the same seam with a different
  index, in `@mistriwork/search-postgres` (one tsvector table per
  collection, GIN-indexed, in the deployment's own database); its tests are
  Postgres-gated, so a live Postgres run in CI is what proves it.
- **A large catalog.** FTS5 in one file suits the moderate tables Mistri's
  home turf holds. A large catalog still wants the Typesense pack, which
  answers from a dedicated engine instead of the deployment's disk.

## Tests

The pack's tests are in the repository's own gate:
`test/search-sqlite.test.ts` (the provider contract, ranking, scope, the
field-add rebuild, and a file reopened across a close), and the App search
tests (`test/app-search*.test.ts`) exercise the same seam through the
Typesense pack.
