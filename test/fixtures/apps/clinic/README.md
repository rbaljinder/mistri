# Clinic (test fixture)

A tenant App converted from a single-tenant one, kept to prove what the tenant
docs promise end to end. It is not a public example or a starter.

A clinic is a tenant; the business that runs every clinic is the platform.

- `schema.ts`, `resources.ts`, `views.ts`, `app.ts`: patients, appointments,
  payments, a price list and visit requests a clinic owns; the clinic profile
  and a triage queue the platform owns.
- `commands.ts`: `recordPayment` (a clinic's, on an appointment),
  `postNotice` (the platform's, into the clinic its input names, shaped like
  the docs' `seedDesk`) and `requestVisit` (a public form placed by intake
  address).
- `server/tenant-policy.ts`: ownership, rows, administration, invitations,
  support visits, intake and public reads.

The database is `test/fixtures/databases/clinic/seed.mjs` (SQLite or
PostgreSQL). Its stores are made the way a deployment makes them:

```sh
mistri migrate stores up --app test/fixtures/apps/clinic \
  --policy test/fixtures/apps/clinic/server/tenant-policy.ts --config mistri.json
```

`test/support/clinicFixture.ts` serves it through `@mistriwork/mistri/testing`;
`test/tenant-clinic.test.ts` is the evidence, on both engines, and
`test/tenant-clinic-flows.test.ts` drives its intake, public reads, Manage
tenants, invitations and sandbox over HTTP.
