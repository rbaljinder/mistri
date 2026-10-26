# Compass database fixtures

Start with the [Compass App README](../../apps/compass/README.md) for the complete
seed, launch, and validation commands. The typed App source lives separately in
`test/fixtures/apps/crm`.

`make-crm-db.mjs [new-output.db]` creates a fresh SQLite database, defaulting to
`compass.db` beside the script. Existing paths are refused. `seed-postgres.mjs
<new-postgres-url> [source.db]` copies that fixture into an empty PostgreSQL
`public` schema; its source defaults to the same `compass.db` and is read-only.
Neither entry replaces existing data. `MISTRI_CRM_TODAY` preserves the seed's
date-pinning contract. Existing `crm.db` copies can be supplied explicitly.
