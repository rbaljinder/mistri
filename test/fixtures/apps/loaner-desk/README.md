# Loaner Desk

A small SQLite App for a fictional equipment desk: **check out, return, check
out again**. Two server commands keep equipment availability and its loans
together. The example uses the existing command transaction and revision APIs,
with database constraints as the final guard. It needs no custom component.

## Run from a source checkout

Use Node 24+ with this repository's dependencies installed. From its root:

```sh
WORK=$(mktemp -d "${TMPDIR:-/tmp}/loaner-desk.XXXXXX")
node --import tsx test/fixtures/databases/loaner-desk/seed.mjs "$WORK/loaner.db"
npm run start -- check --app test/fixtures/apps/loaner-desk --config "$WORK/loaner.db.json"
BETTER_AUTH_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')" \
MISTRI_AUTH_ADMIN_EMAIL=admin@example.test \
MISTRI_AUTH_ADMIN_PASSWORD=disposable-loaner-desk-password \
npm run start -- --app test/fixtures/apps/loaner-desk --config "$WORK/loaner.db.json" --port 4746
```

Open `http://localhost:4746/` and sign in with the local administrator above.
The seed refuses existing database/config files, provisions the command journal,
and writes an absolute database path into the companion writable config. Keep
that database, config and runtime stores outside the App directory. The seed
creates synthetic borrowers and equipment, not accounts; first startup creates
the administrator. Commands are discovered from the adjacent `commands.ts`.

## Try the workflow

1. Open **Equipment → Camera kit → Check out**. Choose **Ada Brooks** and a
   due date of today or later. The receipt confirms checkout; **Loans** has
   one open loan and the equipment is checked out.
2. Open that loan and **Return**. Its status and return date change together;
   the equipment is available again. Check it out to Ben: the first loan stays
   in history, with only the second loan open.
3. To see a conflict, open Camera kit's checkout form in two tabs **before**
   submitting either. Submit one, then the other. The second form says something
   changed and asks for a reload. It must not report success or create a loan.

The equipment and borrower pages show related loan **lists**, including history.
A displayed card or button is not evidence of uniqueness; the index enforces it.

## The return kiosk (optional)

`jobs.ts` adds one integration: a self-service drop box that scans a returned
item and calls `POST /api/inbound/kioskReturn`, signed with HMAC over the time
and the exact bytes. A verified delivery runs `returnEquipment` on the scanned
loan as the `return-kiosk` principal, which holds the `kiosk` service role
(`service: true`) and so that one command, never a person's role. The kiosk's scan id is the receipt's key: a retried delivery replays
it, and a forged, unsigned or late one is refused before any command runs.
A delivery is remembered while its window is open, so a replay of the same
bytes is refused: provision the integrations store once (`provisionStores(…,
{ only: ['integrations'] })` from `@mistriwork/mistri/maintenance`), then serve with
`--jobs test/fixtures/apps/loaner-desk/jobs.ts` and `KIOSK_CALLBACK_SECRET`
set; without `--jobs` the App is unchanged.

## Which layer owns each rule?

| Layer | Rule |
| --- | --- |
| Input declaration | A borrower reference and a valid due date are required. The picker offers active borrowers. |
| Command transaction | Reread borrower eligibility; require a currently available item; validate the due date against today's UTC date; change equipment and loan together. Return uses the loan's stored equipment key. Checkout/return dates come from the server. |
| Revision and receipt | Prepare reads the current revision. A stale submission is refused; replaying the same successful request returns its receipt without another write. |
| Database | Foreign keys; valid statuses and canonical dates; due/return date ordering; `open` iff `returned_on IS NULL`; a partial unique index permitting only one open loan per item. |
| Role grants | Staff and admin run the two commands but have no generic writes. Viewer reads only. Resource `access: 'write'` is the command's ceiling, not a role's permission to edit. |

`when` is checked on the stored target inside the transaction. Action `when`
only controls the button. A filtered picker is likewise advice: the handler
checks the borrower again. Helpful handler refusals appear in the command form.

The unique index is:

```sql
CREATE UNIQUE INDEX one_open_loan_per_item
ON equipment_loan(equipment_id) WHERE returned_on IS NULL;
```

A read-before-insert check alone cannot replace it. SQLite serializes command
writers with `BEGIN IMMEDIATE`; two checkout requests prepared at the same
revision yield one success and one `stale_record`. A direct writer still meets
the unique index and loan checks. Equipment's **cached availability** is kept
consistent by the command transaction: these constraints do not enforce that
cross-table relationship for arbitrary external SQL.

Return sets status and date in one update, then restores availability. If either
write fails, both roll back. Returning an old, closed loan cannot make equipment
available while a newer loan is open. No failure is treated as success, and a
new idempotency key is not an automatic retry of an uncertain submission.

## Read and verify

- `app.ts`: the whole UI and its command-only role grants.
- `commands.ts`: the two operations; imports only the public command SDK and
  generated row types. The App names commands without importing the module.
- `jobs.ts`: the kiosk's signed callback, loaded only with `--jobs`.
- [seed.mjs](../../databases/loaner-desk/seed.mjs): the business schema,
  invariants, initial rows and explicit journal provisioning.
- `mistri-schema.d.ts`, `mistri-commands.d.ts`, `authority.lock`: generated
  schema types, command types and authority/contracts.

From the repository root:

```sh
npx tsc --noEmit -p test/fixtures/apps/loaner-desk/tsconfig.json
node --import tsx --test test/loaner-desk.test.ts
npm run e2e -- e2e/loaner-desk.spec.ts
```

The public acceptance suite in
[test/loaner-desk-acceptance](../../testing/loaner-desk/) tests the App the
way its own repository would, through `@mistriwork/mistri/testing` alone: unit, API,
the kiosk as a virtual service, the browser on a desk and a phone, and the
authorization matrix. `prove-red.mjs` breaks one policy and the kiosk's
receipt key in copies of the App and shows each test go red.

```sh
node --import tsx --test test/loaner-desk-acceptance/acceptance.test.ts
npx playwright test --config examples/testing/playwright.config.ts loaner-desk
node --import tsx test/loaner-desk-acceptance/prove-red.mjs
```

Run Node and browser gates sequentially. The Node suite loads the real seed,
App and handlers and owns each database/server: concurrent distinct submissions,
receipt replay, return/recheckout, invalid input/current eligibility, direct SQL
invariants, rollback after the first write, viewer/CRUD refusals and the existing
metadata-based unrestricted-edit diagnostic. The browser suite owns its server
and database and exercises the forms and visible stale-submission refusal.

This is a synthetic, single-source, role-scoped example. Its tests do not certify
another Loaner Desk deployment, tenant isolation, external-writer cross-table
consistency or production deployment.
