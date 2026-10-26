---
title: Integrations
description: Connect an App to a payment, messaging or CRM provider through a package, with each tenant's secrets, signed webhooks and retried calls kept by core.
---

Connect an App to a payment, messaging or CRM provider through a package,
with each tenant's secrets, signed webhooks and retried calls kept by core.

A command calls a provider's action from its lookup, before its transaction
opens, and writes what came back:

```ts
chargeOrder: defineCommand({
  source: 'business', target: 'orders', input: {},
  integrations: { fakepay: ['charge'] },
  lookup: ({ record, integrations }) => integrations.fakepay.charge({ amount: record.amount, customer: record.customer }),
  handle: ({ db, record, lookup }) => db.orders.update(record, { status: 'charged', charge_id: lookup.id }),
}),
```

<!-- no sample: no shipped App connects a provider -->

## The package

A vendor package exports one `defineIntegration` from `@mistriwork/mistri/integration`.
It says which secrets it needs, how to build a client from them, the actions a
command may call, the webhook events it verifies, and an optional channel. It
never stores a secret, retries a call or reads a row: core does.

```ts
import { defineIntegration, int, refuse, shape, text } from '@mistriwork/mistri/integration';

export const fakepay = () =>
  defineIntegration({
    name: 'fakepay',
    secrets: ['apiKey', 'webhookSecret'],
    client: ({ secrets }) => new FakePayClient(secrets.apiKey),
    actions: {
      charge: {
        input: shape({ amount: int({ min: 1 }), customer: text() }),
        output: shape({ id: text(), status: text() }),
        async run(client, input, { idempotencyKey, signal }) {
          const charge = await client.charge(input, { idempotencyKey, signal });
          if (charge.declined) refuse('The card was declined.');
          return { id: charge.id, status: charge.status };
        },
      },
    },
    webhooks: {
      verify: ({ headers, body }, { secrets }) => verifySignature(headers, body, secrets.webhookSecret),
      events: {
        paid: { type: 'charge.succeeded', payload: shape({ charge: text(), amount: int() }) },
        stopped: { type: 'sms.stop', payload: shape({ from: text() }), optOut: 'from' },
      },
    },
    channel: { name: 'sms', send: (client, message) => client.text(message) },
  });

// Types each App's calls: `integrations.fakepay.charge(input)` takes and returns these shapes.
declare module '@mistriwork/mistri/integration' {
  interface IntegrationRegistry {
    fakepay: ReturnType<typeof fakepay>;
  }
}
```

`verify` returns the event (`{ id, type, at, data }`) or `null` for a
signature that does not hold. `refuse(reason)` is a definite no, recorded and
not retried; any other throw is retried.

The signature must cover the event time, and `at` must be read from what it
covers, never from a header of its own: core refuses a delivery more than five
minutes from now and takes the same event id and time once.

## The App side

The jobs module lists the integrations, maps each webhook event to a command
and names the principal it runs as. A command declares the actions it calls
and calls them from its lookup, typed by the package's shapes. A `send(...)`
effect goes out on an integration's channel after commit.

```ts
// jobs.ts
export default defineJobs({}, {
  principals: { payments: { roles: ['payments'] } }, // a role with "service": true
  integrations: {
    use: [fakepay()],
    webhooks: { fakepay: { runAs: 'payments', events: { paid: 'markPaid' } } },
    quietHours: { from: '21:00', to: '08:00', timezone: 'America/New_York' },
    editors: ['owner'],
  },
});

// commands.ts: the command above, with a text after commit
effects: { text: send('sms', (order) => ({ to: order.phone, text: 'Thanks for your order.', consent: order.sms_consent })) },
```

A `notify` rule tells on a channel too with `send`: the title is the message,
queued in the write's own transaction and sent after it commits, under the
same consent, opt-out and quiet hours as `send(...)`. `to` may be left out.

```ts
orders: { notify: [{ on: { changes: 'status' }, when: 'status = shipped', title: 'Order {id} has shipped.',
  send: { channel: 'sms', to: 'customer.phone', consent: 'customer.sms_ok', timezone: 'customer.timezone' } }] }
```

Add `integrationsForm('Integrations')` to a dashboard for the screen where an
editor enters the secrets. It loads on demand and never shows a saved value.

## What core does

- **Secrets**: sealed per App, tenant, integration and name under `MISTRI_SECRETS_KEY` (at least 32 bytes); a server that lists integrations without it does not start.
- **Calls**: each is journaled under an idempotency key the provider dedupes by, tried up to three times when it fails on the way, and answered from the journal when the command is replayed.
- **Webhooks**: an inbound endpoint, the same one a [`defineInbound`](/docs/events-and-jobs/#a-signed-callback-inbound) is: `POST /api/inbound/<name>` (on a tenant App, `/api/inbound/<name>/<tenant>`, verified with that tenant's secret). The package's `verify` reads the signature; everything else is the inbound endpoint's: past 256 KB is 413, a bad signature or a time more than five minutes off is 401, the same delivery again answers the first one's receipt, an event the App does not map is 202.
- **Events**: a mapped event runs its command as the service principal, with that principal's grants, in the tenant whose secret verified it.
- **Channels**: a message is suppressed when the recipient opted out or the App holds no consent, held through quiet hours, and logged either way. A held message the provider will not take is tried again a minute on, eight times in all, then recorded failed. `channel: 'email'` is built in and mails an address the record holds ([email](/docs/email/#mail-to-an-address-a-record-holds)).
- **Check**: `mistri check` refuses an unknown integration, action, event or channel by [its code](/docs/check-codes/#integration-unknown).

Provision from `@mistriwork/mistri/maintenance`: `provisionStores` with the App and its
`jobs` creates the integrations store beside the job store, with the App's
`commands` alone the delivery of each `post(...)` and `send(...)`, and
`only: ['integrations']` the store by itself. Serving never creates them;
`mistri migrate stores` brings them to this release's layout.

## A human check

`@mistriwork/challenge-turnstile` makes Cloudflare Turnstile the check that public
doors ask (`auth.challenge`). It is unpublished until after 1.0, so take it
from the repository's `packs/challenge-turnstile`. Core ships only the seam,
`defineChallenges`, and never calls a provider.

```ts title="commands.ts"
import { defineChallenges } from '@mistriwork/mistri/commands';
import { turnstile } from '@mistriwork/challenge-turnstile';

export const challenges = defineChallenges({
  verifyHuman: turnstile({ siteKey: process.env.TURNSTILE_SITE_KEY!, secret: process.env.TURNSTILE_SECRET! }),
});
```

Then name it in `auth: { challenge: 'verifyHuman' }`. A stock public form
draws the widget itself, and the widget's origin is added to the page's
Content-Security-Policy. A token is good for one submission: the form resets
the widget after every answer and sends a fresh token when it tries again.
A token that is refused, malformed, already spent, issued on another host
name or not answered within five seconds is a no. The host name is the
App's own unless `hostnames` lists others; `action`, when set, is drawn into
the widget and must come back in the answer. `turnstileStub()` is a local
stand-in for tests: it accepts each token once, its widget hands over a fresh
token that starts with `person`, and no call leaves the machine. A tenant App
names one check for all its tenants' public forms; the secret is the
deployment's, not a tenant's.

## Related

- [Commands](/docs/commands/): `lookup`, `effects` and the receipt a replay answers from.
- [Events and jobs](/docs/events-and-jobs/): the jobs module that lists integrations, and inbound callbacks.
- [Secrets](/docs/secrets/): `MISTRI_SECRETS_KEY` and what it seals.
- [Fake external services](/docs/service-virtualization/): a provider to call in tests.
