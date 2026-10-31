# Relay

A release-tracking console authored entirely through the existing app/page DSL.
Circuit styling, a delivery board, environment health, incidents, and release
detail pages exercise a different workflow from CRM.

From the repository root:

```sh
node test/fixtures/apps/relay/seed.mjs
npx tsx packages/mistri/src/server/index.ts --config .demo/relay.db.json --app test/fixtures/apps/relay --port 4707
```

Open http://127.0.0.1:4707/relay. The seed command refuses to replace an existing
database. Pass another database path to create a separate fixture.

This is manual tracking with fictional data, not a deployment engine. Actions
change database status only; no CI, cloud or production system is contacted.
Approvals are manual review records, not deployment gates or identity-verified
sign-offs. Services and deployment inventory are read-only in App mode. Action visibility
conditions are not server-enforced workflow rules or an authorization mechanism.
