---
title: Email
description: Send an App's notices, sign-in links and form codes through one email service the server's config names, after each write commits.
---

Send an App's notices, sign-in links and form codes through one email service the server's config names, after each write commits.

```json
{ "name": "mail", "kind": "email", "url": "smtps://smtp.example.com:465",
  "from": "Compass <no-reply@example.com>",
  "auth": { "username": "${SMTP_USER}", "password": "${SMTP_PASSWORD}" } }
```

That entry goes in `mistri.json`'s `connections`. An App never names a credential or a sender: a `notify` rule says `email: true`, and the server does the rest.

<!-- no picture: a message arrives in the reader's own mail client; nothing on the App's pages changes. -->

## What you'll see

- A notice in the inbox and, for a rule with `email: true`, the same notice as an email, sent once the write has committed. Nothing is sent for a write that rolled back, and no failed send ever fails a write.
- "Forgot password?" on the sign-in card, emailing a one-time link valid for an hour.

## When to use it, and when not

- Use email when a person must hear of a change while away from the App: an assignment, a mention, a code.
- Use the inbox alone (a `notify` rule without `email`) when the App is where people work all day.
- Use a command's [webhook effect](/docs/commands/#starting-values-other-sources-webhooks) to tell another system rather than a person.

## Options

| `url` | What it does | Status |
| --- | --- | --- |
| `smtps://host:465` | TLS from the first byte | Stable |
| `smtp://host:587` | Must offer STARTTLS or nothing is sent; `"insecure": true` allows a plain relay on a trusted network | Stable |
| `log:` or `log:mail.log` | Sends nothing: each message is one JSON line on stdout or in the file, body and all, sign-in links and a write's own words (codes) included; for development and tests only | Stable |

Credentials are `${VARIABLE}` references, expanded when the transport opens and never logged. The host resolves through the same network rules as every connection; link-local addresses are refused unless `"allowLinkLocal": true`.

What is sent:

- **Notices** from a resource's `notify` rule with `email: true`, and its `mentions` ([the rule's keys](/docs/dsl-resources/)).
- **Sign-in mail**: password resets, the link that verifies an address at sign-up, a note when an application is added to an account, and an address change: a link to the new address and a notice to the old one ([sign-in](/docs/sign-in/)).
- **Form codes**: a status check's step-up code and a form's email proof ([command forms](/docs/command-forms/#forms-saved-on-every-step)).

### After the write, never inside it

A notice's email is queued in the write's own transaction, beside the notice, and sent after commit. The sender checks each message again as its recipient: an address with no account, an account that turned email off, and a record its grants can no longer read are dropped unsent. A failed send is retried after a minute, doubling to an hour; after eight tries, or a permanent refusal, the row is kept as `failed` with the reason. In a tenant App the notice and its mail stay in the inbox of the tenant whose record it is, and the sender reads each message as the recipient's membership of that tenant: someone who is not a member there, or no longer one, is not mailed. The link opens the record in that tenant, and the Notifications switch is per tenant. A tenant App's other mail goes through its jobs module ([tenant mail](/docs/tenant-mail/)).

### Mail to an address a record holds

A `notify` rule with `send: { channel: 'email' }` mails the address in a column of the record, such as a customer who has no account; the title is the subject, and the body says why the person gets it.

```ts
orders: { notify: [{ on: { changes: 'status' }, when: 'status = shipped', title: 'Order {id} has shipped.',
  send: { channel: 'email', to: 'customer_email', consent: 'mail_ok' } }] }
```

The email service needs `"links": { "secret": "${MAIL_LINK_SECRET}" }`, which signs each message's unsubscribe link; run `mistri migrate stores up --app <dir>` once to create the store that queues the mail. Before each send the server checks, in order: the address has not unsubscribed; the `consent` column is true, or the person opted in again; a visitor's write mails only an address the form proved (`link.email.verified`); and no address gets more than five messages a day, nor an App more than 500 an hour. Every message carries one-click `List-Unsubscribe` headers, and the unsubscribe page asks before it changes anything. In a tenant App each tenant's opt-outs, consent and caps are its own; provision the store with `provisionStores(<the database>, { only: ['integrations'] })` from `@mistriwork/mistri/maintenance`. In a suite the unsubscribe link sits under the App's path.

### A write's own words

A title's `{words.code}` says a value the command's write gives (`db.<table>.insert(row, { words: { code } })`) and stores nowhere: the inbox shows it as "…", and the queued mail or channel message keeps it sealed under `MISTRI_SECRETS_KEY` until it is sent, fails or expires. The `log:` transport writes it out in the clear with the rest of the message, which is why it is for development only. A rule that says words needs `email: true` or `send`, and an App with one does not start without the key. The command's side, `{ words }`, is in [commands](/docs/commands/).

## Common mistakes

- The server does not start: the App asks for email and the config names no email service → add an entry of `"kind": "email"`.
- `smtp://` sends nothing → the relay offers no STARTTLS; use `smtps://`, or `"insecure": true` only on a trusted network.
- A reset link nobody receives in development → use `url: "log:"` and read the link from the server's output.

## Related

- [Sign-in](/docs/sign-in/): password resets and verified addresses.
- [Tenant mail](/docs/tenant-mail/): a tenant App's mail in and out, DKIM, signed links and providers.
- [Connections and services](/docs/services/): every other entry in `mistri.json`.
