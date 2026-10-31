---
title: Tenant mail
description: A tenant App receives mail through a signed webhook and sends its held messages over SMTP with DKIM, each in its own tenant.
---

A tenant App receives mail through a signed webhook and sends its held
messages over SMTP with DKIM, each in its own tenant.

A tenant App (`auth.rows: 'tenant'`) runs its desk's mail through its jobs
module: mail that arrives runs a command in the tenant its address names, and
mail the App holds is sent from it. The webhook lives with the App's other
`/api` routes: `/api/mail/inbound` for an App served alone (`--mount` moves
pages, not `/api`), `/<base>/api/mail/inbound` under `--base`, and
`/<mount>/api/mail/inbound` in a suite.

```ts
export default defineJobs({}, {
  principals: { 'mail-intake': { roles: ['intake'] }, 'mail-sender': { roles: ['sender'] },
                'requester-links': { roles: ['reader'] } },
  mail: {
    receive: { runAs: 'mail-intake', command: 'receiveEmail', attachments: 'attachment' },
    send: { runAs: 'mail-sender', claim: 'claimOutbox', record: 'recordSent', every: '30 seconds' },
    links: { runAs: 'requester-links', command: 'viewTicket', reply: 'replyToTicket' },
  },
});
```

```json
{ "name": "mail", "kind": "email", "url": "smtps://smtp.example.com:465",
  "from": "Help Desk <desk@example.com>",
  "auth": { "username": "${SMTP_USER}", "password": "${SMTP_PASSWORD}" },
  "inbound": { "secret": "${MAIL_INBOUND_SECRET}", "domain": "in.example.com", "maxBytes": 10485760 },
  "dkim": { "selector": "tw1", "key": "dkim-tw1.pem" },
  "domains": { "acme.com": "acme" },
  "links": { "secret": "${MAIL_LINK_SECRET}", "ttl": "30 days" },
  "spf": "_spf.example-relay.com", "returnPath": "bounce.example.com" }
```

- **`receive`**: each message runs `command` as `runAs` in its tenant, with
  `targets: 'none'`. Its input is `{ to, from, from_name, subject, body,
  message_id, in_reply_to, references }` (the body without the quoted
  history), or what `input: (mail) => ({ … })` makes of the whole message.
  The Message-ID is the receipt's idempotency key: a retried message writes
  nothing twice. `attachments` names a file resource the command writes; each
  part must pass its size and name rules and reaches the handler as
  `files: [{ name, type, size, data }]` in its context, which
  `db.attachment.insertFile(file, { message_id })` stores. The audit keeps
  name, type and size, never bytes.
- **`send`**: every `every` (5 seconds to a day, default a minute), in each
  active tenant, `claim` returns `{ messages: [{ id, from, to, cc?, replyTo?,
  subject, text, html?, messageId?, inReplyTo?, references?, link? }] }`. Each
  is sent with its own Message-ID, In-Reply-To and References, signed with
  DKIM, and `record` runs with `{ id, status: 'sent' | 'failed' | 'bounced',
  messageId?, error? }`. A From on a domain `domains` gives that tenant is sent
  as it is; any other goes From the service's address under the tenant's name,
  with the tenant's address as Reply-To.
- **`links`**: a message with `link: { id: 4 }` gets a signed link to that
  record where its words say `{link}`. Opening
  `GET /api/mail/link?token=…` runs `command` on that record as `runAs` and
  shows its result, what the App decided a requester may see, as a page
  with no sign-in: a `title` or `subject` heads it, other values are listed,
  and a list of objects is drawn item by item. The page runs no script, loads
  nothing from elsewhere and sends no Referer. With `reply: 'replyToTicket'` (a command on the
  same record with a text `body`) the page has a reply box; without it the
  page is read-only. Asked with `Accept: application/json`, the link answers
  `{ resource, key, view }`. A link expires after `ttl`;
  `revokeTenantMailLinks(target, { tenant, resource, key })` from
  `@mistriwork/mistri/maintenance` ends it sooner.

## Addresses and DNS

`<mailbox>+<tenant>@<inbound.domain>` routes to that tenant's `mailbox`; a
tenant's own `help@acme.com` forwards there, or names its domain in
`domains`. `mistri mail-dns mistri.json` makes the DKIM key when the
file is missing and prints each domain's DKIM and DMARC records and the SPF
record of the domain bounces return to (`bounce+<tenant>@<returnPath>`).

## The webhook

`POST /api/mail/inbound` takes one message as JSON, signed with
`inbound.secret`:

```text
x-mistri-timestamp: 1791194400
x-mistri-signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>">
```

```json
{ "recipient": "help+acme@in.example.com",
  "from": "Ann Lee <ann@example.org>", "to": ["help@acme.com"], "cc": [],
  "subject": "The printer is on fire", "messageId": "<CAF1@mail.example.org>",
  "inReplyTo": "<notice.12@acme.com>", "references": ["<notice.12@acme.com>"],
  "text": "…", "html": "<p>…</p>",
  "headers": { "auto-submitted": "no", "precedence": "" },
  "attachments": [{ "name": "photo.jpg", "type": "image/jpeg", "content": "<base64>" }] }
```

| Answer | Why |
| --- | --- |
| 204 | taken, or the same Message-ID again |
| 202 | dropped and logged: Auto-Submitted other than `no`, Precedence `bulk`/`list`/`junk`, a bounce, mail from this server's own addresses, or more than 30 messages from one sender to one tenant in an hour |
| 401 | no valid signature, or a timestamp more than five minutes off |
| 404 | no active tenant's address |
| 409 | the same signed delivery again |
| 413 | larger than `maxBytes` (default 10 MiB), or an attachment past its file resource's limit |

Dropped and unrouted messages are kept in the platform's mail log
(`__mistri_mail_log`, or `mistri.mail_log` on PostgreSQL, 90 days), never shown to the App.

## Providers

Each provider posts its own shape; a small forwarder you deploy maps it to the
JSON above and signs it.

**Cloudflare Email Workers**: route the domain's addresses to this Worker,
with `MAIL_WEBHOOK` and `MAIL_INBOUND_SECRET` set.

```js
import PostalMime from 'postal-mime';

export default {
  async email(message, env) {
    const mail = await PostalMime.parse(message.raw, { attachmentEncoding: 'base64' });
    const body = JSON.stringify({
      recipient: message.to, from: mail.from, to: mail.to ?? [], cc: mail.cc ?? [],
      subject: mail.subject ?? '', messageId: mail.messageId,
      inReplyTo: mail.inReplyTo, references: mail.references,
      text: mail.text, html: mail.html,
      headers: Object.fromEntries(mail.headers.map((h) => [h.key, h.value])),
      attachments: mail.attachments.map((a) => ({ name: a.filename ?? 'attachment', type: a.mimeType, content: a.content })),
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.MAIL_INBOUND_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)));
    const signature = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
    const answer = await fetch(env.MAIL_WEBHOOK, { method: 'POST', body, headers: {
      'content-type': 'application/json', 'x-mistri-timestamp': timestamp, 'x-mistri-signature': `v1=${signature}` } });
    if (answer.ok || answer.status === 409) return;
    if (answer.status === 404) message.setReject('No such mailbox');
    else if (answer.status === 413) message.setReject('Message too large');
    else if (answer.status === 400 || answer.status === 422) message.setReject('Message could not be processed');
    else throw new Error(`mistri answered ${answer.status}`); // 401, 403, 429, 5xx: let Email Routing retry
  },
};
```

| Neutral field | Postmark (inbound JSON) | SendGrid (Inbound Parse, multipart) | Mailgun (route `forward`, multipart) |
| --- | --- | --- | --- |
| `recipient` | `OriginalRecipient` | `envelope.to[0]` (JSON) | `recipient` |
| `from` | `FromFull` (`Email`, `Name`) | `from` | `from` |
| `to`, `cc` | `ToFull`, `CcFull` | `to`, `cc` | `To`, `Cc` |
| `subject` | `Subject` | `subject` | `subject` |
| `messageId`, `inReplyTo`, `references` | `Headers` named `Message-ID`, `In-Reply-To`, `References` | the same names in `headers` (raw text) | `Message-Id`, `In-Reply-To`, `References` |
| `text`, `html` | `TextBody`, `HtmlBody` | `text`, `html` | `body-plain`, `body-html` |
| `headers` | `Headers` (`Name`, `Value`) | `headers` (raw text) | `message-headers` (JSON pairs) |
| `attachments` | `Attachments` (`Name`, `ContentType`, `Content` already base64) | the file parts, with `attachment-info` | the file parts `attachment-1…` |
| Check before forwarding | Basic auth on the webhook address | Basic auth on the webhook address | the `timestamp`, `token`, `signature` HMAC under the signing key |

## Common mistakes

- Every inbound message answers 401 → the forwarder signs a body other than the one it sends (re-serialized JSON), or its clock is more than five minutes off.
- A tenant's mail lands in spam → publish the records `mistri mail-dns` prints, and name the tenant's domain in `domains` only once its DKIM record is in place.
- The server does not start: the jobs module receives mail and the email service has no `inbound` → add it, with its secret as a `${VARIABLE}`.

## Related

- [Email](/docs/email/): the email service and what every App sends.
- [Events, jobs and workflows](/docs/events-and-jobs/): the jobs module mail is declared in.
- [Tenant Apps](/docs/tenant-apps/): tenants, the platform realm and service principals.
