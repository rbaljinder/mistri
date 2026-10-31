# Parcel

A shipment tracker, App ID `parcel`: the sample that reads an API instead of
a database. Its one source is an HTTP connection to a made-up carrier
network's tracking API — six carriers and 140 shipments between US cities —
which [api.mjs](source/api.mjs) serves on your machine.
tablewalk reads the API through a description drafted from its OpenAPI spec,
so Shipments and Carriers are lists and record pages like any other, and
every question they ask is one the API documents. Parcel writes nothing.

## Start

Use Node 24 or newer and install repository dependencies with `npm install`.
From the repository root, choose the token the API will require, start the
API, and start tablewalk with the sample's connection:

```sh
export PARCEL_API_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
node test/fixtures/apps/parcel/source/api.mjs &
npx tsc -p test/fixtures/apps/parcel/tsconfig.json
npx tsx packages/mistri/src/server/index.ts --config test/fixtures/apps/parcel/source/server.example.json --app test/fixtures/apps/parcel --port 4740
```

Open <http://127.0.0.1:4740/parcel>. The API listens on 127.0.0.1:4781; stop
it with `kill %1` when you are done. The connection names the token as
`${PARCEL_API_TOKEN}`, so it is read from the environment when the connection
opens, sent only as the request's `Authorization` header, and never written
to a file or shown in the page. Choose another port if 4740 is taken.

To browse the API in the explorer with no config at all, one command reads
the spec, whose server is the local API:

```sh
npx tsx packages/mistri/src/server/index.ts --openapi test/fixtures/apps/parcel/source/openapi.json --api-token-env PARCEL_API_TOKEN --port 4741
```

The App still needs the config above, which names the connection `parcel`.

## Reading order

1. [app.ts](app.ts): the App's identity, its one source (`connection:
   'parcel'`, an HTTP connection), the menu, the look, and the en-US locale
   with values in dollars.
2. [resources.ts](resources.ts): captions, status tones, the declared value
   as money, the estimated delivery said from today, and each carrier's
   on-time rate as a bar.
3. [views.ts](views.ts): Shipments, whose tabs, filters and one sort are all
   questions the API documents, and Carriers, which takes no filters.
4. [pages/shipment.ts](pages/shipment.ts) is one shipment, read from the
   API's item path; [pages/carrier.ts](pages/carrier.ts) is a carrier and the
   shipments it is moving, a related list over `shipments.carrier_id` read
   through the API's own `carrier_id` filter.
5. [mistri-schema.d.ts](mistri-schema.d.ts) holds the generated names,
   written by `--export types` from the description, as for a database.
6. [test/fixtures/apps/parcel/source](source): the API's spec
   ([openapi.json](source/openapi.json)), the description
   drafted from it ([parcel.http.json](source/parcel.http.json)
   — read this one: it, not the spec, is what tablewalk obeys), the API
   itself ([api.mjs](source/api.mjs)) and the connection
   ([server.example.json](source/server.example.json)).

## What reading an API changes

- **No totals.** An API reports none, and counting would walk every page, so
  lists say which rows they show and whether more follow, and tabs carry no
  counts.
- **Only what the API documents.** The filters are its three query
  parameters, the tabs filter by `status`, and the sort is a value its `sort`
  parameter lists. Ask anything else — in the Advanced box, say
  `status != delivered` or a sort by weight — and the list says the API
  cannot answer it and names what it can, instead of fetching more rows and
  filtering them here.
- **References are followed one step.** The draft guessed that `carrier_id`
  points at `carriers`, from its name, and the description says so. A
  shipment therefore shows its carrier's name, read once per carrier from the
  carrier's item path, and a carrier's page lists its shipments. A filter or
  a sort on the carrier's name, or a second step beyond it, is refused: the
  API cannot answer either.
- **Read-only.** An HTTP connection takes no writes.

To redraft the description after the spec changes:

```sh
npm run --silent start -- --from-openapi test/fixtures/apps/parcel/source/openapi.json > test/fixtures/apps/parcel/source/parcel.http.json
```

The description goes to the file; what the draft guessed (the paging) and
anything it skipped stays on the terminal, to be read before trusting it. See
[docs/http-sources.md](../../../../docs/http-sources.md) for connections, auth
and the network rules every request follows.
