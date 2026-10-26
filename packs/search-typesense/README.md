# @mistriwork/search-typesense

Typesense as the search provider for a tablewalk App's `search` blocks.

**Unpublished until after 1.0.** It is `"private": true`, it is not in the
`tablewalk` npm package (`packs/` is outside the `files` allowlist), and the
tablewalk binary does not load it. Core rides on the database: without a
provider, a text filter runs there, and an App that declares `search` is
refused at startup with a sentence that points here.

## What it is

Search is an index, never a source of truth. The index holds a copy of the
fields a resource declares searchable, keyed by the record's primary key,
and answers a phrase with keys; the rows are re-read from the database under
the reader's own grants. The pack holds only what is Typesense's:

- `src/typesenseClient.ts`: a Typesense client over core's egress (no SDK),
  so the engine is reached under the same address policy, deadline and byte
  cap as any API, and a failure names the connection and never its key. It
  writes a tenant's scope as Typesense's `filter_by`.
- `src/index.ts`: the connection entry as it was written in `mistri.json`
  (`typesenseConnectionOf`, which checks it) and the provider
  (`typesenseSearch`).

Everything else — which filters are asked of the index, how its documents are
built and follow the App's writes, the tenant's scope, the reindex — is
core's (`packages/mistri/src/server/app/appSearchRuntime.ts`, `packages/mistri/src/server/tenant/tenantSearch.ts`).

## How it plugs in

Core's seam is `packages/mistri/src/server/app/searchProvider.ts`: a `SearchProvider` answers
the `SearchIndex` a resource's `search.connection` names, and an index does
four things — `ensureCollection`, `upsert`, `remove` and `search` (with an
optional exact-match scope). The seam is internal until the packs ship, so it
does not freeze at 1.0; today the pack reaches into `src/` by path.

```ts
import { plugSearch } from '../../packages/mistri/src/server/app/searchProvider.js';
import { typesenseSearch } from './src/index.js';

plugSearch(
  registry,
  typesenseSearch([
    { name: 'search', url: 'https://search.internal:8108', auth: { apiKey: '${TYPESENSE_API_KEY}' } },
  ]),
);
```

An App names the connection in its resource:

```ts
resources: { ticket: { search: { connection: 'search', fields: ['subject', 'requester.name'] } } }
```

## Tests

The pack's tests are in the repository's own gate: `test/typesense-client.test.ts`,
the App search tests (`test/app-search*.test.ts`, `test/app-policy-search.test.ts`,
`test/tenant-search.test.ts`), and the live one in `test/services-live.test.ts`
(`TABLEWALK_TEST_TYPESENSE`). They plug the pack into a registry and run
against an in-process double (`test/support/fakeTypesense.ts`) or a real engine.
