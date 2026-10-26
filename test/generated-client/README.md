# Local generated-client contract check

This opt-in check generates types from the actual read-preview renderer with
openapi-typescript and typechecks an openapi-fetch client. An in-memory fetch
stub also passes its serialized query through the real request/response codecs.
It does not start a
server, read an App database, install dependencies itself, or send HTTP requests.
It verifies both explicit integer strategies, required keys, optional sparse
fields, full item rows, hidden fields/filters/resources, and absent generic writes.
It is not acceptance of bearer authentication, cursor execution, or live routes.

The client uses `querySerializer: { array: { style: 'form', explode: false } }`
to match the preview's comma-separated filter arrays. Generated TypeScript
alone does not configure a fetch client's runtime serialization.

The private composite-key contract is also checked: a closed object parameter
with `style: simple` and `explode: true`, using openapi-fetch's explicitly
configured `serializeObjectParam` path serializer. Unicode, commas, equals,
slashes and percent signs survive exactly once. Its default path serializer
is deliberately shown to be incompatible; no double-decoding is allowed.
Composite export remains refused until importer interoperability is complete.

Install tooling in a fresh temporary directory so the repository dependency
graph and running previews remain unchanged:

```sh
client_tools=$(mktemp -d)
npm install --prefix "$client_tools" --ignore-scripts --no-audit --no-fund --save-exact openapi-typescript@7.13.0 openapi-fetch@0.17.0
node --import tsx test/check-api-generated-client.mjs --tools "$client_tools"
```

The script requires those exact direct versions and the checkout's TypeScript.
Keep the temporary tooling lockfile when recording evidence; direct version pins
alone do not freeze transitive dependencies. Generated test files are removed
after the run; the tooling directory remains for reuse or manual cleanup.

## Real loopback integration

A separate check uses the same pinned tooling with disposable SQLite business
and native-auth stores, a genuinely issued token and the real HTTP server:

```sh
node --import tsx test/check-api-live-generated-client.mjs --tools "$client_tools"
```

Unlike the pure checker above, this starts a loopback listener and performs
native database operations and HTTP requests. Run it serially with other
fixture suites. It exercises generated clients against the actual server path,
bearer authentication, projected reads and cursor continuation; its temporary
stores and listener are cleaned up. This is SQLite coverage, not PostgreSQL,
command execution or production network deployment acceptance.

The generator and client APIs follow their upstream documentation:
[Node generation](https://openapi-ts.dev/node) and
[typed fetch client](https://openapi-ts.dev/openapi-fetch/).
