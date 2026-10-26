# Ignition: the platform's proving ground

Start with the [Ignition README](README.md). This document is the other half of
why Ignition exists: it is the sample where the platform's features are exercised
on a real domain rather than on a synthetic fixture, so it is also where a gap in
those features shows up as something the domain cannot say.

The coverage map below is the point of the document. It is honest in both
directions: a row says where Ignition uses a feature and which test proves it
*there*, and a feature the domain does not want is listed with the reason rather
than bent into the sample to make a table look full.

## Coverage map

A test named here proves the feature **in Ignition**. Framework suites prove the
mechanisms themselves elsewhere; those are not listed.

**Read the proof column literally.** A row naming a test means that test asserts
that feature on this App, on both engines, today. A row marked **not covered**
says so plainly and gives the reason; it is not a promise. The remaining ones
wait on one platform defect: no **platform-realm** command runs on this release.
`execute` is refused `temporarily_unavailable`, and the cause recorded under it
is a `TenantWriteFailure` that names nothing, so there is no field, table or
step to write a test against. The dealership's own commands, including
`withdrawApplication`, are proved.

| Platform feature | Where Ignition uses it | Proof |
| --- | --- | --- |
| A real `mistri check` on the whole two-realm App | Both realms, the policy, the commands and the jobs | `test/ignition-tenancy.test.ts` (against a live catalog, printing the automation) |
| Tenant ownership, injected and immutable | `tenant_id` on `lead`, `loan_application`, `application_document`, `vehicle` | `test/ignition-tenancy.test.ts` (a dealership's catalog does not carry the column) |
| Isolation with colliding business keys | Three dealerships hold the same `L-2001` and `AL-1001` | `test/ignition-tenancy.test.ts` (each sees only its own); `test/ignition-lending-fixture.test.ts` (both references, all three) |
| Composite tenant keys | `(tenant_id, lead_id)`, `(tenant_id, vehicle_id)`, `(tenant_id, application_id)` | Declared in `schema.mjs` and applied by every fixture run on both engines. **Not covered**: no test yet forces a cross-tenant key and watches it refuse. |
| Tenant-local uniqueness | `UNIQUE (tenant_id, reference)`, `UNIQUE (tenant_id, stock_reference)` | Applied on both engines, and load-bearing — a conversion derives `AL-2003` from `L-2003`, which is why the seeded applications are numbered clear of it. **Not covered**: no test asserts the refusal itself. |
| Global ownership, read by all and owned by none | `vehicle_model` | `test/ignition-tenancy.test.ts` (it is in a dealership's five-table catalog, and no dealership owns it) |
| The platform realm reading across tenants | Portfolio, Manager desk, the lender's application list | `test/ignition-tenancy.test.ts` (the lender reads one reference in all three dealerships, and sees whose each is) |
| The tenancy profile | `dealer`, one row per tenant; `dealer.id` *is* the tenant id | `test/ignition-lending-fixture.test.ts` (four dealerships, each a tenant of the store) |
| Platform-only source, read-only, by qualified name | `applicants` (`realm: 'platform'`) | `test/ignition-tenancy.test.ts` (absent from a dealership's catalog); `test/ignition-seed.test.ts` (its own database, native types and constraints) |
| Field (column) ceilings | `reviewer` role on the applicant directory | **Not covered.** The suite that asserted it read the applicant directory through a deployment; that proof has not been rebuilt. |
| Tenant commands | `qualifyLead`, `disqualifyLead`, `convertLead`, `withdrawApplication` | `test/ignition-commands.test.ts` (the gate in order, its refusals out of order, and the application withdrawn) |
| Separation of duties inside a dealership | `dealer_staff` converts but does not qualify | `test/ignition-commands.test.ts` |
| Platform commands | `assignReviewer`, `recordReview`, `recordDecision`, `reviseApplication`, `rotateIntakeAddress`, `closeIntakeSubmission` | **Not covered.** No platform-realm command runs on this release: each is refused with a `TenantWriteFailure` carrying no cause. |
| Realm refusals: each realm refuses the other's commands | A dealership cannot assign; the lender cannot qualify | `test/ignition-tenancy.test.ts` (both directions refused, and the lead untouched) |
| Several targets in one command (`targets: 'many'`), all or none | `qualifyLead` within a dealership | `test/ignition-commands.test.ts` (one request, one receipt). **Not covered**: `assignReviewer` spanning two dealerships, for the same reason as the platform commands above. |
| Author resolved through business data | `lender_staff.account_id` in every platform command | `test/ignition-lending-fixture.test.ts` proves every staff row carries its account. **Not covered**: no platform command runs to use it. |
| Record revisions guarding a race between realms | `withdrawApplication` against `recordDecision` | **Not covered**: `withdrawApplication` runs now, but `recordDecision` is a platform command and does not, so there is no race to stage. |
| Public intake placed by address | The financing form's steps and `applyForFinancing` with `?via=`, `dealer.intake_address` | `test/ignition-tenancy.test.ts` (the address names the dealership) |
| A public form saved on every step, inside one tenant | `finance`: about you, address, income, the loan and co-applicants, a `draft` lead with `lead_co_applicant` rows beneath it | `test/ignition-tenancy.test.ts` (every step lands in the dealership, the submit clears the token, and a token issued in one dealership continues nothing under another's address or none); `e2e/ignition-public-form.spec.ts` (the same in a browser); `test/tenant-saved-form.test.ts` (forged ids and another dealer's rows refused inside a step, on both engines) |
| Intake triage, and the platform never inserting a tenant row | `intake_submission` | `test/ignition-tenancy.test.ts` (an unresolved address lands with the lender, answered identically) |
| Command events | `application.submitted` from `convertLead` | `test/ignition-review-clock.test.ts` |
| Tenant jobs and a platform service principal | `reviewDue` → `flagOverdueReview` as `review-clock` | `test/ignition-review-clock.test.ts` (end to end: the fact, the delivery, the job, the alert, and a second tick writing nothing) |
| Public maintenance provisioning and seeding | `examples/databases/ignition/seed-postgres.mjs` | `test/ignition-seed.test.ts` (what it refuses, and what one run leaves) |
| Secrets kept out of what the seed returns | A 0600 credentials file; the connection file names variables | `test/ignition-seed.test.ts` |
| Suspended tenants | `parkside`, seeded suspended | `test/ignition-lending-fixture.test.ts`; `test/ignition-seed.test.ts` (it alone publishes no intake address) |
| An App API over a dealership's own data | `api` in `app.ts`: four tables read only, two lead commands, two dealership roles | `test/fixtures/apps/ignition/authority.lock` carries all forty facts, and `mistri check` refuses a drift. **Not covered**: no test serves a token yet. |
| Property rail on a record | The application record's vehicle; the lender's review file | `test/app-build-parity.test.ts` (authored definitions round-trip) |
| A record's header, its one forward verb filled | Lead (Qualify, then Convert; Disqualify named destructive), Application (Withdraw named destructive, so nothing is filled), the lender's application (Assign, Record review or Record decision) | `e2e/ignition-workflow.spec.ts` (a qualified lead fills Convert and draws Disqualify last) |
| Related lists as tabs | Dealership: Applications / Review files; a staff member's files, reviews and decisions | `test/app-build-parity.test.ts` |
| A platform-realm page over a tenant-owned table, with a timeline | The lender's application: the reviews, decisions and assignments that key on `application_id`, merged into one stream. The dealership's page of the same row is in the tenant realm, where those tables are not in the schema at all | `test/tenant-metadata.test.ts` (a timeline survives the tenant host's capture); `e2e/ignition-workflow.spec.ts` (the lender's page of a decided application, its strip and its activity, and no dealership verb) |
| Ordered workflow strip | Lead `new → qualified → converted`; application `submitted → … → approved` | `test/app-build-parity.test.ts` |
| Stacked bars | Portfolio: the book by dealership and stage | `test/app-build-parity.test.ts` |
| A target on a metric | Portfolio: approvals against the lender's goal | `test/app-build-parity.test.ts` |
| Relative dates | Review deadlines on the reviewer's desk | `test/app-build-parity.test.ts` |
| Keyboard selection queue | New leads | `test/app-build-parity.test.ts` |
| Icon rail | `ui.shell.rail` with an icon on every menu entry | `test/app-build-parity.test.ts` |
| Landing page, content only | `landing.ts`, served signed out | `e2e/ignition-landing.spec.ts` |
| Print | Nothing to declare: printing is CSS-only, and a record prints the tab it is on | `test/repo/print.test.ts` |
| Rollups under tenancy | A vehicle's `applications`, counted in the dealership's context; each dealership's `in_flight`, counted across the platform realm | `e2e/ignition-display.spec.ts` (the vehicle's count agrees with its related list; the lender's list draws the column); `test/tenant-rollups.test.ts` (another tenant's rows pointing at a record are never counted, on both engines) |
| Records named, never keyed | `vehicle_id`, `lead_id` and `tenant_id`, each a leg of a composite tenant key, drawn by the record's name; a document by its category's word | `e2e/ignition-display.spec.ts` (no opaque `north-motors:…` key on the page; "Identity", not "identity") |
| `mistri shot` in a tenant's context | `--as dealer_admin --tenant north-motors`, `--as manager` | `e2e/ignition-display.spec.ts` |

### Declared, not yet exercised here

| Feature | State | Why |
| --- | --- | --- |
| Support sessions ("enter as dealer") | `support` block in `tenant-policy.ts`; startup attests the audit store | The in-sample flow and its browser proof wait on the audited business path. Until then the policy is declaration only. |
| Delegated dealer administration | `administration.delegates` for `dealer_admin` | Same: the grant is declared and the framework enforces it, but no sample screen walks a dealer admin through managing their own people yet. |
| Account-creating invitations | `invitations.delegates` for `dealer_admin` | Declared; the claim flow is not part of the sample yet. |

### Deliberately not used, with the reason

| Feature | Why not |
| --- | --- |
| Exposing the lender's half through the API | The `api` block is live and covers a dealership's own four tables (see the map above). It names none of the lender's: not the applicant directory, which is a platform-only source; not a `realm: 'platform'` view; not a platform command. Each of the three is refused by name when the App is read, so this is a boundary the framework holds rather than one this file merely observes. A token belongs to one dealership, and the lender's cross-dealer reading is not a thing a dealership's token should be able to ask for. |
| Exposing `disqualifyLead` and `withdrawApplication` through the API | A choice, not a limit — the API carries `qualifyLead` and `convertLead`, and could carry these two the same way. Both are a closing word: a lead refused, an application pulled out from under the lender's review. Each takes a reason someone writes, and a record closed by an integration with no reason is worse than one left open. A dealer's system can move a lead forward without a browser; it cannot end one. |
| `duration` display format | It says a stored number of **seconds** as its two largest units. Ignition stores dates, not elapsed time, so "review age" has no column to format; `relative` on the deadline is the honest fit and is what the reviewer's desk uses. |
| Generic CRUD (Save, New, Delete) | No role holds generic write on purpose. Every change is a named command, so every change has a receipt, an audit row and a version guard. |
| A `bulk: true` action on a selection | Both multi-target commands declare `targets: 'many'`, but a tenant App's HTTP host takes one key per execution, so offering a selection in the browser would promise what the transport cannot carry. Spanning several records is available through the deployment API, where it is all-or-nothing. |
| Boards and calendars | The lender's work is a queue with a deadline, not lanes or a month. Thread and Compass are where those belong. |
| Tags, attachments, saved views | Nothing in this domain wants them: a document row is checklist metadata, never a file, and the lists here are the workflow's own. |
| Undo | Tenant Undo is withheld by the framework, and a decision should be corrected by an audited command rather than reversed. |

## Boundaries this sample keeps

**A typed code is never ownership.** The public form asks for no dealer code. A
typed code is guessable, so trusting one would let anyone place a row in any
dealership, and refusing an unknown one would tell them which dealerships exist.
The dealership is decided by the intake address its own published link carries and
only the server resolves; everything else lands in the lender's triage, and every
case is answered identically.

**Triage stays with the lender.** A submission in triage is never moved into a
dealership. The platform realm does not insert a tenant's row — by declaration,
not omission — so no such command exists to offer. Lender staff follow the
applicant up on that dealership's own link and close the submission with a note.
This is a deliberate decision, not a missing feature: giving the platform the
power to create a dealership's records would weaken the ownership invariant that
makes the rest of the sample true.

**The dealership sees an outcome, not the lender's file.** What a dealership is
told about the lender's progress is its own application's status. That needs no
field ceiling, because the reviewer, the desk and the review notes are not in the
dealership's realm at all — they are on the platform-owned `review_file`, which a
tenant context has no schema for.

**Separation of duties, twice.** A dealership's staff may work a lead but not
qualify it; the lender's reviewer records a finding but cannot decide. Neither
side can take the other's step, and neither can run the other's commands.

**Nothing scarce is held by an unverified write.** A public submission creates a
lead and reserves no vehicle, so it cannot be used to deny a vehicle to anyone
else, and two applicants may name the same stock number.

## What a reader should take from it

If you are building a tenant App, the order these things were decided in matters
more than the code. Ownership came first, and it forced the schema: once a tenant
row may point at a platform row only as its own profile, the lender's columns had
to move off the dealership's application, and `review_file` exists because of
that rule rather than because a designer preferred it. Realms came next and
decided the commands, and only then did the screens follow — which is why the
same application row can carry both realms' verbs, each realm reading it on a page of its own.
