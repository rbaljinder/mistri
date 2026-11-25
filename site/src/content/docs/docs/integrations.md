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
    label: 'FakePay',
    description: 'Takes card payments and tells the App when they settle.',
    secrets: ['apiKey', 'webhookSecret'],
    client: ({ secrets }) => new FakePayClient(secrets.apiKey),
    check: async ({ secrets, signal }) =>
      (await new FakePayClient(secrets.apiKey).account({ signal })) ? { ok: true } : { ok: false, message: 'FakePay refused the API key.' },
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
      signing: 'webhookSecret',
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

`signing` names the secret the provider signs its deliveries with, when it
signs with a shared secret. The settings screen says beside it that it is at
least 24 characters and refuses a shorter one, since a short secret lets a
forged delivery be signed by guessing.

The signature must cover the event time, and `at` must be read from what it
covers, never from a header of its own: core refuses a delivery more than five
minutes from now and takes the same event id and time once.

## Add to a package's integration

A second package, or the App itself, may add actions and webhook events to an
integration without a second name. `extendIntegration` keeps the base's name,
secrets, client, signature check and channel, so a tenant enters one set of
secrets and the provider calls one address. An App lists the extension and not
its base.

```ts
import { extendIntegration, int, shape, text } from '@mistriwork/mistri/integration';
import { fakepay } from '@acme/fakepay-integration';

export const fakepayPlus = () =>
  extendIntegration(fakepay(), {
    actions: {
      void: {
        input: shape({ charge: text() }),
        output: shape({ id: text() }),
        run: (client, input: { charge: string }, { idempotencyKey }) => client.voidCharge(input.charge, idempotencyKey),
      },
    },
    webhooks: { events: { disputed: { type: 'charge.disputed', payload: shape({ charge: text() }) } } },
  });

// jobs.ts: integrations: { use: [fakepayPlus()] }, not [fakepay(), fakepayPlus()]
```

An extension adds and never overrides: an action or event the base has, or an
event type it already takes, is refused when the definition loads. It may not
declare `secrets`, `client`, `channel`, or webhooks' `verify` or `signing`:
those are the base's, and an extension that needs a secret of its own is a new
integration. It needs a base that declares webhooks to add events, since the
base's `verify` checks every delivery. An extension may be extended again.
Listing a base with its extension, or two extensions of one base, is refused
(by `mistri check` too): list the extension only.

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

The projection returns one message, or `null` for none: `(order) => (order.phone ? { … } : null)`
sends nothing for an order without a number, and nothing is queued or logged for it.

### What became of a message

A message may carry the App's own `reference` (at most 200 characters), such as
the order it is about: `send('sms', (order) => ({ to: order.phone, text: '…',
consent: order.sms_consent, reference: order.id }))`. The channel's package
receives it beside the idempotency key, to hand the provider as metadata.
The jobs module names a command that is told each time such a message settles:

```ts
integrations: { use: [fakepay()], settled: { runAs: 'payments', command: 'recordText' } }
```

It runs as that service principal, in the message's tenant, with
`{ reference, channel, state, message }` and, where there is one, `reason` and
`providerId`: `state` is `held` (quiet hours), `sent` (with the provider's id),
`suppressed` (`opted_out`, `no_consent`) or `failed` (the provider's reason).
`message` is the key the provider deduped the send by. The command takes those
of the fields it declares and no others, names no record (`targets: 'none'`)
and finds the App's row itself by the reference
([`integration-settled-input`](/docs/check-codes/#integration-settled-input)).
Each state is told once, after the channel's loop decides it; a message held
and then sent before the loop comes round is told once, as sent. A message
without a reference is never told. A refusal the command makes is said to the
operator and not offered again; one that may pass is asked again on the next
loop.

A `notify` rule tells on a channel too with `send`: the title is the message,
queued in the write's own transaction and sent after it commits, under the
same consent, opt-out and quiet hours as `send(...)`. `to` may be left out.

```ts
orders: { notify: [{ on: { changes: 'status' }, when: 'status = shipped', title: 'Order {id} has shipped.',
  send: { channel: 'sms', to: 'customer.phone', consent: 'customer.sms_ok', timezone: 'customer.timezone' } }] }
```

Add `integrationsForm('Integrations')` to a dashboard for the screen where an
editor enters the secrets. It loads on demand and never shows a saved value.
`integrations` narrows it to the ones named, in that order, for a settings page
per integration: `integrationsForm('Payments', { integrations: ['stripe'] })`.
Each must be one the jobs module lists. It narrows what the page shows, not who
may read it.

Each integration is one card: its `label` (without one, its name as a person
reads it) and `description`, its secrets' names as a person reads them (`apiKey`
is "API key"), a line saying whether it is configured, partly configured or not,
and the webhook address its provider sends to. The line reports which secrets
are saved; it does not ask the provider whether they work.

An integration that declares `check` also gets a "Test connection" button for
the people who may edit the settings. The server runs `check({ secrets, signal })`
under the saved secrets (every one must be saved first) and the card shows the
result beside the button: `{ ok: true }`, or `{ ok: false, message }` in words a
person can act on. Make it one cheap read, such as the account endpoint. It has
10 seconds. A throw or a time-out shows a generic failure and never the error's
text, since an SDK's error can carry the key, and a saved secret that appears in
a `message` is taken out.

## What core does

- **Secrets**: sealed per App, tenant, integration and name under `MISTRI_SECRETS_KEY` (at least 32 bytes); a server that lists integrations without it does not start.
- **Calls**: each is journaled under an idempotency key the provider dedupes by, tried up to three times when it fails on the way, and answered from the journal when the command is replayed.
- **Webhooks**: an inbound endpoint, the same one a [`defineInbound`](/docs/events-and-jobs/#a-signed-callback-inbound) is: `POST /api/inbound/<name>` (on a tenant App, `/api/inbound/<name>/<tenant>`; see [what a tenant keeps](/docs/tenant-apps/#what-a-tenant-keeps)). The package's `verify` reads the signature; everything else is the inbound endpoint's: past 256 KB is 413, a bad signature or a time more than five minutes off is 401, the same delivery again answers the first one's receipt, an event the App does not map is 202.
- **Files**: a provider that sends a file beside its event may send `multipart/form-data`. The signature is still over the whole body, and `verify` is given the non-file parts as `form` (a record of strings) beside the raw `body`, to build the event from. Each file part is put in the mapped command's `field.files` (or `field.signature`) of the part's name, as a person's upload is, and the command stores it with `db.<file resource>.insertFile(file, values)`. The field's own declaration bounds them: its `accept` (a type it does not take is 415), its `min` and `max` (400), and the file resource's `maxBytes` (413). A part for a field the command does not have is 404. Nothing is declared for it; only a multipart callback may weigh more than 256 KB, up to the largest file resource's `maxBytes` plus 256 KB. Only a command's top-level file fields are named by a part.
- **Events**: a mapped event runs its command as the service principal, with that principal's grants, in the tenant whose secret verified it.
- **Channels**: a message is suppressed when the recipient opted out or the App holds no consent, held through quiet hours, and logged either way; one with a `reference` is told to the App's `settled` command as it settles. A held message the provider will not take is tried again a minute on, eight times in all, then recorded failed. `channel: 'email'` is built in and mails an address the record holds ([email](/docs/email/#mail-to-an-address-a-record-holds)).
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

- [Operational guarantees](/docs/operational-guarantees/): retries, idempotency and restarts for calls, webhooks and channels.
- [Commands](/docs/commands/): `lookup`, `effects` and the receipt a replay answers from.
- [Events and jobs](/docs/events-and-jobs/): the jobs module that lists integrations, and inbound callbacks.
- [Secrets](/docs/secrets/): `MISTRI_SECRETS_KEY` and what it seals.
- [Fake external services](/docs/service-virtualization/): a provider to call in tests.
