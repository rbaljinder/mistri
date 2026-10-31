> Regression fixture retained for existing coverage. Start new apps from [Keystone](../../../../test/fixtures/apps/keystone/README.md).

# Ignition

A lender's platform above its dealerships, authored in the TypeScript DSL. Each
dealership is a **tenant**; the lender is the **platform realm** above them all.
It is the project's multi-tenant sample, and the one place every tenancy feature
is exercised on a domain rather than on a fixture.

**PostgreSQL only.** Two dedicated databases: the lending database the App owns,
and an applicant directory that only the lender's realm can read. SQLite has not
left the project, but it is no longer this sample's deployment story — the SQLite
mirror of this schema lives in `test/support/ignitionTenantFixture.ts` for tests
and browser fixtures.

Everything here is synthetic. No credit is offered, no underwriting happens, and
no figure on any screen is real.

## What it demonstrates

- **Isolation supplied by the framework, not by application filters.** A
  dealership's context cannot read another's rows or any of the lender's, because
  the runtime composes the ownership predicate outside every caller filter and
  leaves the lender's tables out of the dealership's catalog and schema
  altogether. The three active dealerships hold the *same* business references —
  `L-2001`, `AL-1001` — so opening one and then the other is how you see it.
- **Two realms, one App.** A dealership works its own leads; the lender reads
  across every dealership and owns the review. Each realm refuses the other's
  rooms and the other's commands.
- **Ownership deciding the schema.** A tenant row may reference a platform row
  only as the tenancy profile, through its own ownership column. So the lender's
  columns cannot sit on a dealership's application: they live on a platform-owned
  `review_file`, one per application. That is the realm boundary being paid for
  in the schema rather than asserted in prose.
- **Public intake without an enumeration oracle.** The financing form asks for no
  dealer code at all; each dealership publishes the form under its own intake
  address, and anything the address does not place goes to the lender's triage,
  answered identically.
- **A long application saved on every step, inside one dealership.** About you,
  address, income, the loan and co-applicants are each saved as the applicant
  moves on, into the dealership the link named. The applicant's place is a
  cookie whose hash the draft keeps, bound to that dealership as well as to the
  draft: under another dealership's link it continues nothing.

## Non-goals

No underwriting, credit pull, pricing, lending offer, adverse-action notice,
disbursement or payment processing. Document rows are checklist metadata, never
uploaded files. Seeded statuses and outcomes exist to populate interface states.
Support sessions ("enter as dealer") and delegated dealer administration are
*declared* in the tenant policy, but their in-sample flows and browser proofs are
not built yet.

## Prerequisites

Node 24+, a source checkout with dependencies installed, and two new, dedicated
PostgreSQL databases whose `public` schema is empty. Database setup lives
separately, under
[`examples/databases/ignition`](../../../../examples/databases/ignition/README.md) — read its
README for the seeding recipe and what the seed provisions.

## Set it up

```sh
export IGNITION_LENDING_SEED_URL=postgres://…/ignition_lending
export IGNITION_APPLICANTS_SEED_URL=postgres://…/ignition_applicants
export MISTRI_AUDIT_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')"
node --import tsx examples/databases/ignition/seed-postgres.mjs /tmp/ignition-fixture
```

The seed writes `server.json` and a `0600` `credentials.json` into that new
directory. The credentials file holds every account's password and each active
dealership's intake link; the seed **never prints either**. Do not commit it.

Then the private deployment settings. None of these belong in App source or
committed configuration:

```sh
export IGNITION_LENDING_DATABASE_URL=postgres://…/ignition_lending
export IGNITION_APPLICANTS_DATABASE_URL=postgres://…/ignition_applicants   # a read-only login
export BETTER_AUTH_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')"
export MISTRI_AUDIT_KEY=…    # the same key the seed used
export XDG_CONFIG_HOME=/tmp/ignition-fixture/auth
```

`MISTRI_AUDIT_KEY` is required because the tenant policy declares a `support`
block, and startup attests the support audit store at every start. Keep it apart
from `BETTER_AUTH_SECRET`. There is no `MISTRI_AUTH_ADMIN_*` step and no
private staff-map file: sign-in grants nothing until a membership is granted, and
the seed grants them.

## Run it

```sh
npx tsx packages/mistri/src/server/index.ts --config /tmp/ignition-fixture/server.json \
  --app test/fixtures/apps/ignition \
  --policy test/fixtures/apps/ignition/tenant-policy.ts \
  --jobs test/fixtures/apps/ignition/jobs.ts --port 4712
```

Open <http://127.0.0.1:4712/>. Signed out it is the lender's front page.
Sign in with an account from `credentials.json` and you are asked to choose:
a dealership, or **Lender**. One seeded person holds memberships at two
dealerships, which is what makes per-tab switching something you can actually
try — each tab holds its own choice.

The public form needs no account. Use an intake link from `credentials.json`
(`/form/finance?via=<address>`): each step is saved into that
dealership as a `draft` lead, which its lists leave out, and the submit makes it
a `new` one. Open the bare form with no `?via=` and it lands in the lender's
**Intake triage** instead — with the same answer, on purpose.

## Module map

| File | What it is |
| --- | --- |
| `app.ts` | Identity, the two sources, every resource's owner and ceiling, the roles and their realms, the features, `home` and `nav`. |
| `tenant-policy.ts` | Server-only. Ownership, the two row scopes, delegated administration and invitations, the intake address column, the support grants, one result extractor per command. Never imported by the App graph. |
| `features/` | One module per capability, each with its views, pages, nav fragment, display rules and the grants its commands need. |
| `features/*.ts` | Each feature's browser-safe command presentation: what its actions or form ask for, and which realm each belongs to. |
| `leads.ts` | The dealership's four commands (tenant realm), each whole: input, target and handler. |
| `platform.ts` | The lender's six commands (platform realm). |
| `financing.ts` | The public form's commands — one per step and the submit — each branching on where the server placed the draft. |
| `review.ts` | The review clock's command, run only by its job's service principal. |
| `events.ts`, `jobs.ts`, `commands.ts` | The committed fact, the job that starts on it, and the registry beside the manifest: the App names each command by its key (typed in `mistri-commands.d.ts`). |
| `authority.lock` | Everything the App and its features grant, one fact per line. `mistri check` fails the moment it differs. |

## Who may do what

No role holds generic write, so Save, New and Delete are off for everyone and
every change is a named command in exactly one realm.

| Realm | Role | May |
| --- | --- | --- |
| Dealership | `dealer_admin` | Read its own dealership; qualify, disqualify, convert, withdraw. |
| Dealership | `dealer_staff` | Read its own dealership; disqualify and convert. Not qualify — confirming a deal is the admin's. |
| Dealership | `dealer_viewer` | Read its own dealership. |
| Lender | `platform_admin` | Read every dealership; assign, decide, revise, rotate an intake address, close a triage submission. |
| Lender | `manager` | Read every dealership; assign, review, decide, revise, close a triage submission. |
| Lender | `reviewer` | Read every dealership, with column ceilings on the applicant directory; record a review. |
| Lender | `automation` | Held only by the review clock's service principal: one command, and reads of its footprint. |

The same application row draws different verbs depending on which realm the tab
is in — Withdraw inside a dealership, Assign and Decide on the lender's lease. Each
realm reads it on a page of its own: the dealership's is in the tenant realm, where
the lender's tables do not exist, and the lender's (`lender-application`, a
platform-realm page over the tenant-owned table) draws the reviews, decisions and
assignments beside it as one timeline.

## The lead gate

| Step | Realm | Command |
| --- | --- | --- |
| Each step saves a `draft` lead in the dealership its intake address named | public | `startFinancing`, `saveFinancingAddress`, `saveFinancingIncome`, `saveFinancingLoan`, `saveFinancingCoApplicants` |
| The submit makes the draft a `new` lead | public | `applyForFinancing` |
| `new` → `qualified` | dealership | `qualifyLead` |
| `new`/`qualified` → `disqualified`, reason required | dealership | `disqualifyLead` |
| `qualified` → `converted`, creating the application `submitted` | dealership | `convertLead` |
| `submitted` → `in_review`, creating the lender's `review_file` | lender | `assignReviewer` (across dealerships) |
| review recorded, → `manager_review` or `documents_pending` | lender | `recordReview` |
| → `approved` / `declined` | lender | `recordDecision` |
| open → `withdrawn` | dealership | `withdrawApplication` |

`convertLead` matches the stock number against that dealership's own inventory,
so there is nothing to enumerate, and it reserves nothing — a lead holds nothing
scarce, and two applicants may name the same vehicle.

## The review clock

Converting a lead records `application.submitted` in the same transaction as the
application. The `reviewDue` job (`jobs.ts`) falls due the day after the deadline
that fact carried, and runs `flagOverdueReview` as the service principal
`review-clock`, which holds the platform role `automation` and nothing else.

It is a *platform* command, so it is fenced on the `@platform` row rather than on
any dealership: suspending one dealership does not stop the lender noticing that
its review is late, while suspending the lender stops the clock for everyone. The
deadline travels in the fact because at conversion no `review_file` exists yet —
the lender creates that when it assigns a reviewer — and if one exists by the
time the job runs, its date wins, so a revision can move the deadline.

`mistri check` prints the effective automation:

```text
jobs: reviewDue@1 on application.submitted@1 (convertLead@1) → flagOverdueReview@1 as review-clock
```

## Checks

```sh
npx tsc -p test/fixtures/apps/ignition/tsconfig.json
npx tsx packages/mistri/src/server/index.ts check --config /tmp/ignition-fixture/server.json --app test/fixtures/apps/ignition \
  --policy test/fixtures/apps/ignition/tenant-policy.ts \
  --jobs test/fixtures/apps/ignition/jobs.ts
```

The App's own suites are `test/ignition-tenancy.test.ts` (a real `mistri check`,
isolation, the realm refusals, the saved form's placement and triage, and its
token bound to the dealership), `test/ignition-commands.test.ts`
(the lead gate and all-or-nothing), `test/ignition-review-clock.test.ts` (the
fact, the job and the alert), `test/ignition-lending-fixture.test.ts` (the seeded
shape and the memberships) and `test/ignition-seed.test.ts` (the PostgreSQL seed,
which runs only with `TABLEWALK_TEST_PG`). Run them through `tsx --test`, as the
node gate does. All but the last run on SQLite *and* PostgreSQL from
`test/support/ignitionLendingFixture.ts`, which seeds both engines from
`schema.mjs`; the sample itself is PostgreSQL only.

Ignition is also the one App with a **browser** gate, and the only tenant App
exercised in a browser anywhere in this repository:
`e2e/ignition-tenancy.spec.ts` (two dealerships behind the same references, the
person with two memberships, a key from one dealership pasted into another's
lease), `e2e/ignition-landing.spec.ts` (the public front page, the staff door,
and the lender's own realm), `e2e/ignition-workflow.spec.ts` (both ordered
workflow strips) and `e2e/ignition-public-form.spec.ts` (`?via=` placement of
every step, the enumeration oracle that is not there, and a draft that another
dealership's link cannot continue). They deploy the sample exactly as
this README does — the public seed on two dedicated databases,
`--policy --jobs` — so they need `TABLEWALK_TEST_PG` pointed at a
PostgreSQL server whose role may `CREATEDB`, and skip with a reason without one:

```sh
TABLEWALK_TEST_PG=postgres://…/postgres npm run e2e -- e2e/ignition-*.spec.ts
```

After a schema change, regenerate both committed artifacts and commit them with
the change: `--export types > test/fixtures/apps/ignition/mistri-schema.d.ts`, and
`mistri check --write-authority` for `authority.lock`.

## Known limitations

- The financing form saves every step but serves no status check and no
  "add to my account": a tenant App's saved form does not serve `statusCheck`
  or `link` yet, so an applicant's receipt is theirs to quote to the dealership.

- Support sessions and delegated dealer administration are declared in the tenant
  policy but have no flow in the sample yet, and no browser proof.
- The browser specs assert the lead gate's strip and the verbs a Lead record
  offers (Qualify or Convert filled, Disqualify last and quiet) rather than
  driving the gate; the gate itself is proved through the deployment API
  (`test/ignition-commands.test.ts`).
- Ignition is **not** a Docker compose target: it needs PostgreSQL, `--policy`,
  its commands, `--jobs` and a provisioning step. The compose example keeps Tick,
  Thread and Compass; see the build-and-deploy guide for tenant deployment.
- There is no migration path from the previous single-tenant sample, by design —
  see the database README for why reseeding is the supported route.
- No cross-source transaction or join exists between the two databases;
  `loan_application.applicant_ref` is an opaque string, not a foreign key.
- The `api` block serves a dealership's own four tables, read only, plus its two
  lead commands — `qualifyLead` and `convertLead` — and nothing of the lender's.
  `disqualifyLead` and `withdrawApplication` are held back on purpose, not by a
  limit: each is a closing word that should carry a person's reason. No test
  serves a token against the block yet.
- No command in the **lender's** realm runs on this release: `assignReviewer`,
  `recordReview`, `recordDecision`, `reviseApplication`, `rotateIntakeAddress`
  and `closeIntakeSubmission` are each refused at `execute`, with a cause that
  names nothing, so none has a test proving it. The dealership's own commands,
  `withdrawApplication` included, are proved on both engines. The coverage map
  says which rows that costs. See [DESIGN.md](DESIGN.md).

See [DESIGN.md](DESIGN.md) for the platform-feature coverage map and the
boundaries this sample deliberately does not cross.
