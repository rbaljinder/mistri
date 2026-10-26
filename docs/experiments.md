# Experiment analytics: the evidence contract

The site's [Experiment analytics](../site/src/content/docs/docs/experiments.md)
(<https://mistriwork.dev/docs/experiments/>) is the how-to. This file keeps the
guarantees behind it: which sources are supported, how a use becomes an
exposure, how a source is bound, and what makes evidence complete. The code is
`src/server/experiments/`.

## Supported sources

Signed-in subjects are supported in ordinary Apps and tenant Apps. An explicitly
established visitor is supported on an ordinary App's public form and on a
tenant's public intake: the submission's receipt names the public principal
(`public:<form>`), its audit carries the visitor in the same transaction, and a
tenant's intake lands in that tenant's journal, so the conversion is attributed
in that tenant's epoch. Platform triage has no supported conversion source: the
conversion registry refuses a platform command's events at startup. Do not
substitute a tenant member, service actor, or payload field for a visitor.

Each metric comes from a declared committed command event. Arbitrary SQL changes,
generic CRUD without an event, historical backfill, continuous metrics, and identity
stitching are outside this contract. Each metric counts at most one conversion per
exposed unit.

## Sources

Each source selects a deployed App connection through `sourceId`; it does not
accept a request-supplied URL. An ordinary App's event `storeId` is `app:<appId>`.
A tenant source uses its existing tenant store ID and an explicit tenant ID. Its
native service authority rechecks current tenant/platform anchors, independently
of the historical user who emitted the event. `maxClockSkewMs` is an explicit
operator bound on emitter clock skew against the source database, from 0 to
120000 milliseconds.

For global-control observations evaluated separately in a tenant, declare that
tenant as `tenantId` and set `controlTenantId: null`. Such evidence is not pooled
into a global result and cannot authorize a global winner from one tenant's sample.
Omitting `controlTenantId` uses the selected tenant as the control scope.

## Eligibility

An epoch admits a context that belongs to any one of its `audiences`, or
anyone when it names none. Who is eligible is said only through audiences: a
role or tenant list in `eligibility` is refused with
`experiment-eligibility-audiences-only`, and the same list goes in an audience
(`{ roles: ['member'], tenants: ['north'] }`) instead. Each named audience's
definition is frozen into the epoch, so it is part of the fingerprint: editing
an audience an experiment names needs a new `version`, and evidence never mixes
two definitions of who was measured. A flag rule reads the App's current
definition through the same evaluator (`packages/mistri/src/server/flags/audience.ts`), so a
rule and an epoch naming one audience agree while it is unchanged. Rollout
buckets are salted by the audience's name and the unit's kind and id, so
widening a rollout only adds units. An epoch a 0.8 release registered stored its
`roles`, `tenants` and an empty `segments` instead; it is read as stored and
keeps its fingerprint and its evidence, and an App that still runs it under 1.0
declares a new `version`.

## Record actual use

A flag evaluation alone creates no exposure. Browser components report consumption
using short-lived server-issued assignment receipts tied to the current native
session or verified visitor proof. Browser requests never choose the unit or arm.
Receipt delivery first creates a durable obligation. A confirmed use resolves it;
repeated renders and retries count once per epoch/unit. Lost receipts or reports
remain visible as pending/unknown coverage, including after process restart.

On a public surface (an App's public form or a tenant's public intake), establish
visitor identity only after an explicit interaction using `useVisitor().start()`. A form can use
`start({ form: 'apply', address: '/apply' })`; the address is interpreted by the
native public-intake owner, not as a browser-selected tenant. Reads and renders do
not mint visitor cookies. Identity is opaque, scoped, and HttpOnly; signing in does
not stitch visitor history to the account.

Server command flag reads are recorded only while the admitted handler uses them;
preparation and availability checks remain passive. A server command cannot commit
untracked experimental use: enrollment failure rolls its transaction back. Once
the obligation is durable, a later exposure-ingestion outage may leave pending
coverage while business work commits. Conversions use the existing
business outbox: a rollback emits none, an ingestion outage preserves committed
business work, and a crash after evidence ingestion but before acknowledgement is
safe to replay.

## Read evidence and decide

The worker serially drains bounded batches and publishes immutable evidence.
Changed observations are reflected on the next successful tick; otherwise
maturity/coverage is refreshed at most every 30 seconds until complete final
results exist. Database outages never turn into zero conversions or a success
claim. The source owner examines bounded receipt coverage; undiscovered work,
failed delivery, retention loss, in-flight source writers, and unacknowledged
exposure obligations block complete evidence. This is a bounded experiment system,
not an unbounded analytics pipeline.

Conversions must occur after first exposure and within that unit's conversion
window. Reordered delivery reconciles against bounded pending facts. Estimates
use mature cohorts; immature subjects remain separately visible. Finalization
requires the end date, conversion window, delivery grace, source watermark, and
complete coverage. Statistical evidence retains method/version metadata,
allocation diagnostics, multiplicity adjustment, and binary guardrail results.

A winner is an explicit authorized Console operation requiring complete final
evidence, acceptable allocation diagnostics, guardrails, and current control and
evidence revisions. A decision writes a flag audit entry referencing the immutable
evidence revision. Late corrections create new evidence and do not rewrite the
old decision. Flag and evidence databases have no cross-database atomic commit:
only the flag's `decide` audit row proves the winner was applied. On an unknown
outcome, read control history before attempting another decision.
