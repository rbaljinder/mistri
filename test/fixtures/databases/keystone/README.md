# Keystone database

Keystone is a lending platform told as several Apps over **one PostgreSQL
database**: the lender's own App, a marketplace, the dealers' lead desk, each
dealer's public site, the dealers' settings, and loan servicing for the
lender's customers. [Start all six Apps](../../apps/keystone/README.md) with
one command. [SUITE.md](../../apps/keystone/SUITE.md) explains who reads each
table and why the schema is shaped the way it is.

Everything here is synthetic. No credit is offered, no bureau is asked, no
money moves, and no figure on any screen is real.

- `schema.sql`: thirty-one tables, each with one owner (a dealer, the lender,
  or nobody). Its header says why the keys look the way they do: `/leads` is a
  tenant App, and the whole schema is written to a tenant App's rules.
- `fixture.mjs`: the rows, drawn deterministically from a day. Pure: no
  database and no clock, so a test can call `buildKeystone('2026-09-26')`.
- `pdf.mjs`: the one-page PDFs a borrower downloads (contracts, statements).
- `seed-postgres.mjs`: the schema, the rows, the vehicles' studio photos (drawn
  by [Forecourt's renderer](../forecourt/photos.mjs)) and the stores every App
  shares, into an empty database; then a config naming the connection.
- `server.example.json`: the runtime template, one writable connection named
  `keystone` from `KEYSTONE_DATABASE_URL`.

## Seed

Node 24 and a source checkout with dependencies installed. Make a new,
dedicated PostgreSQL database whose `public` schema is empty; the seed refuses
anything else, and refuses an existing config path.

```sh
createdb keystone
node --import tsx test/fixtures/databases/keystone/seed-postgres.mjs \
  postgres://localhost/keystone /tmp/keystone/server.json
```

It prints each table's count when seeding finishes. Options:

- `KEYSTONE_TODAY=2026-09-26` pins the day every date is counted back from.
  Without it the day is today (UTC), so "past due" and "funded this month"
  stay true whenever you seed. Two runs with the same day write the same
  rows, byte for byte.
- `--photos featured` (the default) photographs each dealer's four featured
  listings from three angles: 120 photos, about 7 MB. `--photos all` adds
  one photo for every other listed or pending vehicle, roughly three times that;
  `--photos none` draws nothing.

It provisions the command journal, the record history and the inbox, which
every App shares (each keyed by App where it needs to be). It does **not**
provision `/leads`' tenant store, grant any membership, make any account or
write any intake address: those belong to the Apps, and an intake address is
random by design, so a public repository cannot predict one.

## Provision the Apps

The [shared suite launcher](../../apps/keystone/README.md), `start-suite.mjs`,
provisions the tenant stores and five explicit suite personas itself. It uses
one identity store, separate per-App grants and stable account-ID business
bindings. Use it for the one-process demonstration.

For independent sign-in stores, the older `start.mjs` launcher uses these
individual steps, with a separate `XDG_CONFIG_HOME` and keys for each App:

1. `provision-leads.mjs <database-url> <new-directory>` provisions tenant
   stores, dealer memberships, support accounts and intake addresses. It needs
   `MISTRI_AUDIT_KEY` and the Leads App's `BETTER_AUTH_SECRET`.
2. `provision-dealer.mjs <database-url> <new-credentials.json>` creates manager
   accounts in the Dealer App's auth store. It links `dealer_user.dealer_account_id`;
   `dealer_user.account_id` remains the Leads membership identity.
3. `provision-customer.mjs <database-url> <new-credentials.json>` creates three
   borrower accounts and links their customer rows.
4. After starting the lender with `MISTRI_AUTH_ADMIN_EMAIL` and
   `MISTRI_AUTH_ADMIN_PASSWORD`, `provision-lender.mjs` adds the remaining
   staff through Manage accounts. Set `KEYSTONE_DATABASE_URL`, `LENDER_URL`,
   `LENDER_ADMIN_PASSWORD` and `LENDER_STAFF_PASSWORD`.

Run the scripts with `node --import tsx`. For individual provisioning, use the
same App-specific XDG directory and auth/form/audit keys as its server.
Passwords are generated into private credential files or supplied through the
environment; none of these scripts prints them. Provision Leads before any
server opens its tenant database: provisioning changes the schema epoch.

## What it holds

| Table | Rows | |
| --- | ---: | --- |
| `dealer` | 12 | Ten active, one on hold after a funding audit, one prospect onboarding |
| `dealer_user` | 91 | The dealers' people; one finance manager works at two dealers |
| `vehicle` | 600 | 200 listed, 85 pending, 28 in stock, 8 wholesale, 279 sold |
| `lead` / `lead_activity` | 638 / 1,833 | Every status; each of the eleven trading dealers holds its own `LD-1001` |
| `deal` / `deal_scenario` / `trade_in` | 449 / 1,347 / 147 | Structured deals with a payment grid |
| `loan_application` | 400 | 250 funded, 20 approved, 10 countered, 22 conditioned, 18 in review, 15 submitted, 50 declined, 15 withdrawn |
| `underwriting_file` / `stipulation` | 400 / 874 | The lender's file on each, and the approval conditions |
| `funding` | 270 | 250 funded, the rest in the funding queue |
| `loan` / `installment` / `payment` | 250 / 16,626 / 3,376 | Thirty months of a book: 194 current, 15 past due, 25 delinquent, 3 charged off, 13 paid off |
| `customer` | 242 | Some borrowers came back for a second car |
| `loan_document` | 1,422 | Contracts, disclosures, statements and letters, one small PDF each |
| `prequalification` | 120 | Marketplace soft checks, some sent on to a dealer |
| `intake_submission` | 6 | Apply forms the lender triages |

Counts are for any day; the statuses of loans and of the open applications
move with `KEYSTONE_TODAY` because they are counted from it.

## Reseeding, not migration

There is no migration script. `/leads` is a tenant App, and on PostgreSQL a
tenant App's database may hold only its declared resources and reserved
`__mistri_*` tables (docs/tenant-apps.md, "A database of its own"), so a
marker table would refuse its startup. A changed schema is a new database and
a fresh seed. Never reseed a database an App is serving.
