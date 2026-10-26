# Sample database setup

This directory holds the synthetic database setup for the
[public Apps](../apps/README.md). These are database assets, not additional
sample applications. App manifests, typed modules and each App's README live
under `examples/apps/`; seeds, migrations and example server configuration live
here.

| App | Database setup | Start with |
| --- | --- | --- |
| Tick | [tick/seed.mjs](tick/seed.mjs) | [Tick README](../apps/tick/README.md) |
| Lintel | [lintel/seed.mjs](lintel/seed.mjs) (SQLite, with every store the App and its jobs use), [seed-postgres.mjs](lintel/seed-postgres.mjs) (the same buildings in PostgreSQL), the schema in [schema.mjs](lintel/schema.mjs), the buildings, leases, ledger and repairs from [data.mjs](lintel/data.mjs) and the street views [images.mjs](lintel/images.mjs) draws | [Lintel README](../apps/lintel/README.md) |
| Ladle | [ladle/seed.mjs](ladle/seed.mjs) (SQLite: the classes, the bookings and the App's stores) | [Ladle README](../apps/ladle/README.md) |
| Ignition (a test fixture) | [ignition/seed-postgres.mjs](ignition/seed-postgres.mjs), the schema in [schema.mjs](ignition/schema.mjs) and [server.example.json](ignition/server.example.json) | [Ignition README](../../test/fixtures/apps/ignition/README.md) |

Ignition is a regression fixture (`test/fixtures/apps/ignition`), not a public
sample; its PostgreSQL seed stays here because the fixture and its suites
use it. The seeds of every other App that was a sample until 0.9.2 are under
[`test/fixtures/databases/`](../../test/fixtures/databases/), beside the
fixtures in [`test/fixtures/apps/`](../../test/fixtures/apps/README.md).

The seeds of Tick, Lintel and Ladle ship in the npm package. From the repository root
or from `node_modules/@mistriwork/mistri`, Tick takes an unused SQLite filename:

```sh
node examples/databases/tick/seed.mjs /tmp/my-tick.db
```

Tick writes `<file>.json` beside the database with a writable connection named
`tick`. Use it with `--config <file>.json` and `--app examples/apps/tick`; from an
installed package, copy the App out of `node_modules` first (Node does not run
TypeScript from there) and name the copy. Lintel's seed then takes
`LINTEL_APP=<the copy>`.
Lintel has separate instructions (SQLite or PostgreSQL, with the stores its jobs
use); do not infer its arguments from Tick's, and follow its README. Ladle's
seed takes `LADLE_APP=<the copy>` the same way and provisions the App's stores.

Tick, Lintel and Ladle create their tables in their seeds. An App of your own
keeps its schema as migrations
([change your schema](../../site/src/content/docs/docs/change-your-schema.md)):
`migrations/V1__….sql` applied through `applyMigrations` from
`@mistriwork/mistri/maintenance`, so `mistri migrate status --config <file>.json`
answers and a change to the schema is the next `V` file.

Seeds should refuse existing targets. Choose a new disposable path or dedicated
empty database; do not delete or reseed a working preview to repeat setup. Keep
mutable databases, generated runtime configuration and credentials outside watched
App directories. Example JSON files document server configuration, not canonical
App authoring. Loading an App does not create or migrate its business database.
