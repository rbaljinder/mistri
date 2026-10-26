---
title: Experiment analytics
description: Split a flag between variants, measure each on a committed business event, and decide a winner from complete evidence.
---

Split a flag between variants, measure each on a committed business event, and decide a winner from complete evidence.

> **Preview.** Experiments work as documented and may change in any 1.x release; `mistri check` reports a use of them as information. See [status](/docs/status/).

```ts
flags: { offerCopy: flag.string('standard', { owner: 'growth', variants: ['standard', 'clearer'] }) },
experiments: {
  offerCopy: experiment({
    version: 'offer-copy-1', unit: 'subject', control: 'standard',
    startsAt: '2027-01-01T00:00:00.000Z', endsAt: '2027-01-15T00:00:00.000Z',
    conversionWindow: '48 hours', deliveryGrace: '24 hours',
    eligibility: { rollout: 100 },
    allocation: [{ value: 'standard', weight: 50 }, { value: 'clearer', weight: 50 }],
    primary: { conversion: 'applicationSubmitted' },
  }),
},
```
<!-- no sample: no shipped App declares an experiment -->

It runs in a [suite](/docs/suites/) with shared identity, a flag control store and its own evidence database.

<!-- no picture: the evidence is read in the suite Console, which needs a provisioned suite to draw. -->

## What you'll see

- In the Console, each variant's mature cohort, its conversions, delivery coverage and guardrails, with immature subjects shown apart.
- An exposure only when the feature was actually used: a flag evaluation alone creates none, and a lost report shows as pending coverage, never as zero.
- A winner decision refused until the end date, both windows and delivery coverage are complete.

## When to use it

- Use an experiment to choose between variants on a business outcome a command commits, such as an application submitted.
- Use a plain [flag](/docs/suites/#flags-and-console) instead for a rollout or a kill switch, where nothing is being compared.
- Use [behavior analytics](/docs/analytics/) instead to see where people drop out of a flow, without variants.

## Options

| Key | Does |
| --- | --- |
| `version` | The epoch; changing allocation, variants, eligibility, dates, windows or metrics needs a new one |
| `unit` | `subject` (signed in) or `visitor` (a public form or a tenant's public intake, after `useVisitor().start()`) |
| `control`, `allocation` | The control variant, and two to sixteen weighted arms |
| `startsAt`, `endsAt` | Fixed UTC times |
| `conversionWindow`, `deliveryGrace` (`'48 hours'`) | How long after first exposure a conversion counts, and how long late events may arrive |
| `eligibility` | `rollout` and [`audiences`](/docs/dsl-flags/#audiences), each frozen into the version |
| `primary`, `guardrails` | The conversion that decides, and binary guardrails with a `maxIncrease` |

A conversion is declared in the server commands module, beside the default `defineCommands` registry, from the same `defineEvent` handle the command emits:

```ts title="commands.ts"
export const experimentConversions = [
  defineExperimentConversion({ id: 'applicationSubmitted', on: applicationSubmittedEvent,
    unit: { kind: 'subject', source: 'actor' } }),
];
```

## Configure and provision

In `suite.json`, beside `identity` and `flags`, name a dedicated PostgreSQL evidence database, an assignment key (a base64url 32-byte secret of its own) and each source:

```json
"experiments": {
  "store": "postgres://experiment_owner@localhost/mistri_experiments",
  "deploymentId": "experiment-evidence", "assignmentKeyEnv": "EXPERIMENT_ASSIGNMENT_KEY",
  "sources": [{ "appId": "lending", "flagId": "offerCopy", "tenantId": null, "sourceId": "business",
    "storeId": "app:lending", "commandIds": ["submitApplication"], "maxClockSkewMs": 1000 }]
}
```

```sh
mistri experiments provision --suite suite.json           # the evidence layout
mistri experiments provision-sources --suite suite.json   # each epoch's event store and outbox
mistri suite suite.json
```

Run `provision-sources` again after adding an epoch or a source; serving only attests. A version-1 evidence database moves forward with `mistri migrate stores up --suite suite.json`.

## Common mistakes

- A source refuses at startup naming a platform command → platform triage has no conversion source; measure a tenant's own command or its public intake.
- An edited audience is refused for a running experiment → its definition is part of the version; start a new `version`.
- A conversion never counts → the conversion names a string or payload field; it must reuse the `defineEvent` handle the command emits.
- An epoch edited in place is refused → a change to allocation, dates or metrics is a new `version`.
- The winner was decided but the flag did not change → the flag's `decide` audit row is the proof; read the control history before deciding again.

## Related

- [Several Apps in one server](/docs/suites/#flags-and-console): the Console and flag store.
- [Behavior analytics](/docs/analytics/): funnels without variants.
- [Feature flags in the DSL](/docs/dsl-flags/#feature-flags): `flag.*` and scoped capabilities.
- `docs/experiments.md`: exposure, evidence and decision guarantees in full.
