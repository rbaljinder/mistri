# Lintel

A property company's operations App: three Denver buildings, their homes,
leases, rent ledger, repairs and storeroom, run from one App by two audiences.
The office works a staff desk — leasing, a manager, technicians, an
accountant — and residents sign in to the same App and see only their own
household. Signed out, the public browses what is to let and asks for a
viewing. It runs on PostgreSQL, its target, and on SQLite, in the Lumen look.

The authoring entry is [`app.ts`](app.ts). The database is created separately
under [`examples/databases/lintel`](../../databases/lintel/); the generated
[`mistri-schema.d.ts`](mistri-schema.d.ts) and
[`mistri-commands.d.ts`](mistri-commands.d.ts) stay here.

## What to read where

- [`app.ts`](app.ts): the roles. `manager` `extends` `leasing` and `admin`
  extends `manager`; a technician reads who lives where and never what it
  costs (`fields`); a resident is a role whose rows the policy decides
  (`rows: 'policy'`). Home rules send each role to its own start: the portal,
  the technician's queue, the ledger, Today. `live: true` asks for live
  sync: an open page follows what others change, under each reader's grants.
- [`resources.ts`](resources.ts): what Lintel says of each table once. A
  lease, a charge, a repair and a viewing each travel a `machine`; the
  repair's has `groups` (`status is onSite`) and a `since` column. A studio
  says so (`display.values` on `bedrooms`) rather than "0 bd". Cancel request is
  a command, `cancelRequest`, which asks why: only the roles granted the command
  are offered it, so a technician, who moves a repair by its status alone, is not. A lease's
  last day ends it by itself (`at: { end_on }`). A part used on a repair
  `consumes` the storeroom's shelf and a delivery `restocks` it — on every
  door, a take past zero refused whole — and a part is logged only while its
  repair is on site (`validation` through `request_id.status`). A finished
  repair emails the resident whether or not they have an account
  (`notify` with `{ channel: 'email', to, consent }`), only while
  `email_ok` says they agreed, with a one-click unsubscribe.
- [`commands/`](commands/): every business write, each in its own
  transaction — leasing (sign, give notice, end), the ledger (post rent, late
  fees, payments, one-off charges), repairs (report, book a visit, complete,
  cancel, the conversation) and the public viewing request.
- The resident's **Report a problem** is a three-step intake (`style: 'intake'`
  in `views.ts`): the problem with the category as icon cards, the details with
  urgent as Yes/No buttons, then whether staff may enter, which asks a visit
  window beside the date only when the answer is No (`when: 'entry_ok = false'`).
  It also opens in a dialog from a unit's record. The staff New work order draws
  `category` as the same cards (`form.fields.category.as` in `resources.ts`).
- [`policy.ts`](policy.ts): the row policy, loaded with `--policy`. The office
  reads every building; a resident is found from the verified session's email
  and reads their resident row, leases, homes, charges, payments and repairs,
  with every message on those repairs but the office's internal notes. The
  jobs' services are named here too, each given only the rows it works in.
- [`jobs.ts`](jobs.ts), loaded with `--jobs`: rent posted at six on the first
  of each month, Denver time, by the `rent-poster` service; the late-fee
  workflow ([`late-fees.ts`](late-fees.ts)) it starts through the
  `rent.posted` event ([`events.ts`](events.ts)), which sleeps through the
  grace days and assesses a fee on each rent still open; and the payment
  processor's signed callback, `POST /api/inbound/paymentSettled`, applied
  once per payment id. It also declares a decision, `routeRepair`: every
  fifteen minutes the `repair-triage` service asks a model which technician
  should take each new repair nobody has picked up, from the repair's title,
  description, category and building, and offers the answer on the repair's
  Technician field through `assignTechnician`. It only suggests: the office
  accepts, changes or dismisses it, and nothing is assigned until someone
  does. A pick applies by itself only above `apply`, and only once
  `mistri decide eval routeRepair --pin` has measured the model on settled
  repairs and pinned its version in [`decisions.lock`](decisions.lock); that
  is the office's decision to make, so the example leaves `apply` out. With
  no `JEV_API_KEY` or `ANTHROPIC_API_KEY` in the server's environment it asks
  no one. Its reads are the service's rows under the policy, so `decide eval`
  takes `--policy` as a start does.
- [`views.ts`](views.ts), [`dashboards.ts`](dashboards.ts),
  [`navigation.ts`](navigation.ts), [`landing.ts`](landing.ts): the public
  listing cards refined from a rail, the viewing form, the rent roll edited in
  place, the office's repairs queue with the one picked beside it (`split`),
  the occupancy gantt, the viewing calendar, the repair board and the
  technician's queue, the manager's Today and the resident's portal.
- [`pages/`](pages/): record pages, one per file, found by their file. A
  repair is a conversation (`layout: 'conversation'`) with a reply and an
  internal-note composer ending the thread; a lease is its money; a home and
  a building are showcases (`layout: 'showcase'`), the photos with the asking
  rent or the building's facts beside them. Every page that declares no aside
  gets one of the record's remaining fields; a showcase does not. A repair has two pages, chosen by role: the office's, with the
  resident's card and the history of changes, and the resident's own
  ([`resident_request.ts`](pages/resident_request.ts)), which has neither.
  Two pages are drawn whole by code:
  [`delivery-board.page.tsx`](pages/delivery-board.page.tsx), the storeroom's
  board (see below), and [`add-charge.page.tsx`](pages/add-charge.page.tsx),
  under Books for the manager and the accountant. It chooses a current lease
  and asks the lease's own Add charge command over two steps with `<Steps>`:
  what the charge is for, then how much and when it is due. Continue checks
  only the step it is on, in the browser and on the server, and the command
  runs once, from the last step. The step is a page param, so a reload or a
  shared link opens the same step, or the first one not answered yet. Its
  test, [`pages/add-charge.test.tsx`](pages/add-charge.test.tsx), runs under
  Vitest.
- [`blueprint.ts`](blueprint.ts): a second theme written from scratch, the office's drawing set (blue ink on gridded
  vellum, a blueprint in dark mode), that a reader picks under Preferences; the App still wears Lintel's own.
- [`hearth.ts`](hearth.ts): a third, calm and one thing at a time: big tight Figtree titles
  ([`fonts/`](fonts/), under the SIL Open Font License), soft warm-gray fields, pill buttons and one persimmon
  accent on off-white paper. A reader picks it under Preferences too.
- [`tidelight.ts`](tidelight.ts): a brand in one block over Mono: one deep teal for every action, warm daylight
  neutrals and softer corners; Mono's type and spacing stay. Also in the reader's picker.

`authority.lock` beside `app.ts` records every grant; the server refuses to
start an App whose grants differ from it, and the permissions test reads it.

## Records and a carrier's API

Lintel reads from three places, and the storeroom's delivery board draws all
three together.

- **Records:** the database under [`examples/databases/lintel`](../../databases/lintel/)
  (PostgreSQL, or SQLite). The storeroom's deliveries (`part_receipt`) carry
  the carrier's `tracking_number`.
- **The API:** Northbound Freight, a made-up carrier whose tracking API is read
  over HTTP and never written. The `carrier` source in `app.ts` names its
  connection, never its URL. [`carrier/openapi.json`](../../databases/lintel/carrier/openapi.json)
  is the pinned spec and [`carrier/northbound.http.json`](../../databases/lintel/carrier/northbound.http.json)
  the `mistri.http/1` description drafted from it (the sha256 of the spec is
  pinned inside; `tests/carrier.test.ts` fails when either changes alone).
  Its shipments are the table `carrier.shipments`: a status, the carrier's
  ETA and the last scan's place and time, filtered by `status` and sorted by
  ETA. The Carrier tracking list in the menu reads it on its own.
- **The room that reads both:** [`pages/delivery-board.page.tsx`](pages/delivery-board.page.tsx),
  Lintel's first free-form page, under Maintenance. It declares both reads and
  draws what is on its way (soonest first, with the last scan), what needs a
  look (a held parcel, a late one, a delivery nobody booked in) and what was
  received lately, with the carrier's word beside each. A foreign key cannot
  cross sources yet, so the page matches a shipment to its delivery by
  tracking number itself, which is why it stays hand-built rather than a
  `<Board>`. A `<Calendar>` under the tables stands the same deliveries on the
  month they fell in, the list views' own calendar over the read the page
  already holds. Its test, [`pages/delivery-board.test.tsx`](pages/delivery-board.test.tsx),
  runs under Vitest.
- **Grants:** an HTTP connection reads only, and the App's roles decide who
  reads it: the office (leasing, manager, admin) and technicians, never a
  resident or the accountant. A page is offered only to a role granted every
  read it declares, so the board is offered to the manager, the admin and
  technicians (its `roles`), and the roles without the carrier read the
  deliveries list instead.

To run the stub beside the App, give it a port and point the carrier
connection at it. [`carrier/api.mjs`](../../databases/lintel/carrier/api.mjs)
answers the spec with the same shipments every start (one for each seeded
delivery, all delivered, and four still on their way) and needs no key:

```sh
node examples/databases/lintel/carrier/api.mjs --port 4782
```

The seed's config already names the connection at `http://127.0.0.1:4782/v1/`;
on another port, change its `url`. [`carrier/server.example.json`](../../databases/lintel/carrier/server.example.json)
is the same connection to add beside `lintel` in a server config of your own.
`tests/start.ts` serves the stub on a free port for each test run.

## Run locally

From the repository root, with Node 24+ and dependencies installed, seed a new
SQLite file outside the App directory, then serve it with the jobs module and
the policy:

```sh
DIR=$(mktemp -d /tmp/lintel.XXXXXX)
export LINTEL_MAIL_SECRET=$(openssl rand -base64 24) PAYMENT_CALLBACK_SECRET=$(openssl rand -hex 16)
export BETTER_AUTH_SECRET=$(openssl rand -base64 32)
export MISTRI_AUTH_ADMIN_EMAIL=admin@example.test MISTRI_AUTH_ADMIN_PASSWORD=choose-a-long-password
node --import tsx examples/databases/lintel/seed.mjs "$DIR/lintel.db"
npx tsx packages/mistri/src/server/index.ts --config "$DIR/lintel.db.json" --app examples/apps/lintel \
  --jobs examples/apps/lintel/jobs.ts --policy examples/apps/lintel/policy.ts --port 4610
```

The seed writes `<file>.json` beside the database: a writable connection named
`lintel`, and an email service that writes each message to `<file>.mail.log`
instead of sending it. It also provisions every store the App and its jobs use
(`mistri migrate stores up --app … --jobs …`). `LINTEL_TODAY=YYYY-MM-DD`
seeds the same file every time.

On PostgreSQL, give the seed an empty database and a new config path:

```sh
node --import tsx examples/databases/lintel/seed-postgres.mjs postgres://localhost/lintel "$DIR/lintel.json"
```

The admin account the first start makes adds the others from the accounts
screen. A resident's account reads the household whose resident row has the
same email.

## Check

```sh
npx tsc -p examples/apps/lintel/tsconfig.json
npx tsx packages/mistri/src/server/index.ts check --app examples/apps/lintel --design --config "$DIR/lintel.db.json" \
  --jobs examples/apps/lintel/jobs.ts --policy examples/apps/lintel/policy.ts
```

`check` says three pages leave a section out for a role, on purpose: a
technician's lease page has no rent and their resident page no balance, and
the accountant reads a repair without its conversation.

## Tests

[`tests/`](tests/) is the App's own suite, written on `@mistriwork/mistri/testing` and
Playwright alone, the way an App's repository would hold it. `mistri test
init` writes a starter suite for an App without a row policy; for this one it
says to start the App by hand, which is what [`tests/start.ts`](tests/start.ts)
does: a workspace of its own, the App copied into it, the real seed, the App
served with its jobs and policy, an account per role (each office account is a seeded staff member, so Today greets Maya by name), and one seeded
resident's address made the resident account's.

| File                   | Covers                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permissions.test.ts`  | every role × resource and command as `authority.lock` says; a resident's household and nothing else; a technician and the ledger, Cancel and New; what a visitor reads      |
| `ledger.test.ts`       | rent posted once however often asked, a payment, a one-off charge in cents, the late-fee workflow on a test clock (`createWorkflowDriver`)                                  |
| `maintenance.test.ts`  | a visit booked, started and completed, the resident mailed or not by their consent, parts off the shelf and a take past zero refused, internal notes                        |
| `portal.test.ts`       | a resident's home, a problem reported on their own home and written on, a visit window asked only when entry is not allowed, a neighbor's repair refused                    |
| `tracking.test.ts`     | the carrier's tracking read through the App by the office and refused to a resident, the accountant and a visitor; the delivery board offered to the storeroom's roles only |
| `integrations.test.ts` | the processor's signed callback applied once, replayed, forged and wrong ones refused                                                                                       |
| `decisions.test.ts`    | the routing decision on a scripted model: each new repair suggested a technician, the office reads it, nothing assigned, a neighbor's refused to a resident                 |
| `*.spec.ts`            | the browser: the public listings and viewing request, the staff desk, the resident portal on a phone, each role's shared pages, a listing's and a repair's layout           |

```sh
node scripts/test-node.mjs examples/apps/lintel/tests/*.test.ts
npx playwright test --config examples/apps/lintel/tests/playwright.config.ts
```

The suite ships in the package as documentation; it runs from a checkout of
this repository, which holds the seed it starts from.
