# Ignition database fixtures

Start with the [Ignition App README](../../../test/fixtures/apps/ignition/README.md). The typed App
source and generated schema live separately in `test/fixtures/apps/ignition`.

Ignition is the multi-tenant sample: each dealership is a tenant and the lender
is the platform realm above them. That makes it **PostgreSQL only**. SQLite has
not disappeared from the project, but it is no longer this sample's deployment
story — the SQLite mirror of this schema lives in
`test/support/ignitionTenantFixture.ts` and exists for tests and browser
fixtures.

- `schema.mjs`: both databases as DDL, plus the deterministic fixture rows. It is
  the one place the shape is written, and the seed and the SQLite test fixture
  both read it. Its header explains why ownership, not taste, decides the
  shape — chiefly why the lender's columns sit on a platform-owned `review_file`
  instead of on a dealership's application.
- `seed-postgres.mjs [new-directory]`: creates both databases' tables and rows,
  provisions every reserved store through the public maintenance steps, then
  seeds the platform row, the four dealerships, the lender's staff and the
  dealerships' people. Defaults to `data/` beside this script. Run it under
  `node --import tsx` in a checkout, so it imports `@mistriwork/mistri/commands` and
  `@mistriwork/mistri/maintenance` from `src/`; a built checkout or the installed package
  runs it under plain `node`.
- `server.example.json`: the runtime template, naming `IGNITION_LENDING_DATABASE_URL`
  (writable) and `IGNITION_APPLICANTS_DATABASE_URL` (read-only) with stable
  `loans`/`applicants` connection names. A platform-only source is read only, so
  its connection must never say `"writable": true`.

## Seeding

Two new, dedicated PostgreSQL databases, each with an empty `public` schema. The
seed adds and never replaces: an existing object in either one refuses the whole
run, and existing directories are refused too.

```sh
export IGNITION_LENDING_SEED_URL=postgres://…/ignition_lending
export IGNITION_APPLICANTS_SEED_URL=postgres://…/ignition_applicants
export MISTRI_AUDIT_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')"
node --import tsx examples/databases/ignition/seed-postgres.mjs /tmp/ignition-fixture
```

It prints the paths it wrote and the counts, and **never a password or an intake
address**. Both of those go into `credentials.json` in the new directory, written
mode `0600`: the accounts with their passwords and which realm each belongs to,
and each active dealership's public intake link. Do not commit that file or paste
its contents.

`MISTRI_AUDIT_KEY` is required because the seed provisions the support audit
store, which the tenant host attests at every start. Keep it apart from
`BETTER_AUTH_SECRET`.

## What the seed provisions, and in what order

Startup only ever *attests* these stores; it never creates one, which is why
this is an explicit step and not a side effect of serving. Each is a public
maintenance entry, and each is idempotent on the exact layout it expects:

1. the tenant store (`migratePostgresTenantStore`),
2. the administration journal (`migratePostgresTenantAdministrationJournal`),
3. invitation storage (`migratePostgresTenantInvitations`),
4. the command journal (`migratePostgresCommandJournal`),
5. the tenant command event store, the job store and the `reviewDue` delivery
   destination (`provisionStores` with the tenant binding and the jobs module),
6. the support audit store (`migratePostgresSupportAudit`).

Then the realm and its people, each one its own journaled transaction under
`maintenance:ignition-seed`: `setPlatformStatus`, `putTenant` per dealership,
`createAppAccounts` for everyone, and `grantPlatformMembership` /
`grantTenantMembership`. The lender's `lender_staff` rows are then given the
account ids those accounts came back with, because a platform command resolves
its author through `lender_staff.account_id`. There is no private staff-map file
any more.

## The fixture it seeds

Four dealerships: `north-motors`, `harbor-auto` and `valley-vehicles` active, and
`parkside` suspended — a suspended tenant the sample actually holds rather than
describes. One `dealer_admin` and two staff per active dealership, plus one
person with memberships at **both** North and Harbor, which is what makes
per-tab dealership switching something you can try. On the lender's side, one
`platform_admin`, two managers on two desks and three reviewers.

The three active dealerships hold the **same business references** — `L-2001`,
`AL-1001` — on purpose. Opening one dealership and then another is how the sample
shows isolation, and a guessed key from one is simply not found in the other.
About eight leads each, the 48 applications spread across them, and two
submissions sitting in the lender's triage.

## Reseeding, not migration

There is no migration script here, and that is deliberate. On PostgreSQL a
tenant App's database must hold only its declared resources and reserved
`__mistri_*` tables, so the previous sample's migration marker tables would
each be an undeclared table that refuses startup. The framework has no users to
keep compatible yet, so the supported path forward is a fresh seed into a new
database. Never reseed a running preview.

No cross-source transaction is implied by the two databases: the lending
database and the applicant directory are seeded independently, and nothing joins
them. `loan_application.applicant_ref` is an opaque string, not a foreign key.
