---
title: Behavior analytics
description: Count views, commands, forms and your own events, and read funnels over them, in a database you own.
---

Count views, commands, forms and your own events, and read funnels over them, in a database you own.

> **Preview.** Behavior analytics, with the `analytics` operations grant, works as documented and may change in any 1.x release. See [status](/docs/status/).

```ts
analytics: {
  collect: ['views', 'commands', 'forms'],              // omitted means none
  events: { compareOpened: { fields: ['vehicleId'] } },  // a custom event a component emits
  funnels: {
    apply: { unit: 'visitor', conversionWindow: '72 hours', steps: [
      { view: 'vehicles' }, { form: 'apply', step: 'contact' }, { form: 'apply' },
      { event: 'application.submitted' } ] },
  },
},
```

```sh
mistri analytics provision --suite suite.json      # once, server stopped
mistri analytics funnel apply --from 2026-10-01 --to 2026-11-01 --suite suite.json
```

Nothing is collected unless the App says so, and nothing leaves your database unless you configure a sink.

<!-- no picture: the funnel prints as counts per step; the suite Console's Analytics room draws the same numbers. -->

## What you'll see

- Per step, how many units reached it inside the window.
- Events stored by declared id and route template, never the URL; no email, IP, user agent, referrer or payload text.
- The Console's [Analytics room](/docs/suites/#operations-and-analytics-rooms) showing events by day and each declared funnel, for a role granted it.

## When to use it

- Use analytics to see where people drop out of a flow you declared: a public form, an onboarding, a sales stage.
- Use [experiment analytics](/docs/experiments/) instead to compare two variants of a flag on a committed business outcome.
- Use [OpenTelemetry](/docs/observe/#opentelemetry) instead for latency and errors; analytics counts behavior, not performance.

## Options

| Key | Does | Default |
| --- | --- | --- |
| `collect` | Built-in kinds to record: `views`, `commands` (a command run or refused), `forms` (each step, and the submit) | none |
| `events` | Custom events and the fields each may carry (scalars of at most 200 characters) | none |
| `funnels.<id>.unit` | `visitor` (an explicit visitor cookie) or `subject` (a signed-in person) | required |
| `funnels.<id>.conversionWindow` | How long after step 1 the rest may happen, `'72 hours'` | required |
| `funnels.<id>.steps` | Two to ten: `{ view }`, `{ command }`, `{ form, step? }` or `{ event }` | required |

A component emits a custom event with `useAnalytics().emit('compareOpened', { vehicleId })` from `@mistriwork/mistri/ui`. An `event` step may also name a business event a command emits (`defineEvent`); only its name, version, time, actor and id are copied. A request with `Sec-GPC: 1` drops the visitor.

The store is configuration, beside the connections in mistri.json or in `suite.json`, and must be its own database:

```json
"analytics": { "store": "postgres://…/analytics", "app": "forecourt", "deploymentId": "prod",
  "sinks": [{ "id": "warehouse", "kind": "http", "connection": "warehouse-hook", "batch": 500 }] }
```

A sink names a `"kind": "webhook"` connection; a job POSTs batches with an `Idempotency-Key` and advances only after a 2xx. Events are insert-only; `pruneAnalyticsEvents` from `@mistriwork/mistri/maintenance` deletes only what every sink has received. `createOpenFeatureProvider()` from `@mistriwork/mistri/openfeature` answers OpenFeature flag reads from the same decisions.

A sink with a `preset` posts to a vendor itself, no SDK: `segment`, `posthog`, `amplitude`, `ga4` or `warehouse` (NDJSON, or `"format": "json"`). Its `key` is always a `${VARIABLE}`, read from the environment at startup; `endpoint` moves it to a region or a proxy (a warehouse needs one), and GA4 adds its `measurementId`:

```json
"sinks": [{ "id": "product", "kind": "http", "preset": "posthog", "key": "${POSTHOG_KEY}",
  "endpoint": "https://eu.i.posthog.com/batch/" }]
```

A vendor receives what the store holds: opaque ids, never an IP (geolocation is turned off where the vendor allows it), and an event without a person is sent as the deployment.

## Common mistakes

- `analytics-unknown-step` → a step names a view, command, form or event the App does not declare; use one of its ids, or declare the custom event.
- `analytics-not-collected` → a step counts a kind `collect` does not list; add it.
- `analytics-name-clash` → a custom event shares a name with another, or with a business event; rename the custom one.
- A custom event's field never arrives → a value that looks like an email, an IP address or a URL query is dropped (and counted); send an id instead.

## Related

- [Experiment analytics](/docs/experiments/): variants measured on committed events.
- [Several Apps in one server](/docs/suites/): the Console's Analytics room.
- [mistri check](/docs/check-codes/#analytics-unknown-step): the three analytics codes.
- [Connections and services](/docs/services/#webhooks-kind-webhook): the connection a sink posts to.
