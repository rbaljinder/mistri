---
title: Sign in from your app
description: Sign the person already signed in to your own app into a mistri App, with no second login.
---

Sign the person already signed in to your own app into a mistri App, with no second login.

```json
{ "name": "portal", "kind": "embed", "issuer": "https://portal.example.com",
  "secret": "${PORTAL_EMBED_SECRET}", "origins": ["https://portal.example.com"] }
```

Your server signs a minute-long assertion of who is there:

```js
import { createHmac, randomUUID } from 'node:crypto';

const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
export function assertionFor(user, page = 'https://portal.example.com') {
  const now = Math.floor(Date.now() / 1000);
  const body = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({
    iss: 'https://portal.example.com', aud: 'compass', origin: page, sub: user.id,
    email: user.email, email_verified: true, name: user.name, jti: randomUUID(), iat: now, exp: now + 60,
  })}`;
  return `${body}.${createHmac('sha256', process.env.PORTAL_EMBED_SECRET).update(body).digest('base64url')}`;
}
```

In Node, `mintEmbedAssertion` from `@mistriwork/mistri/handler` signs the same assertion, HS256 with a secret or ES256 and EdDSA with a private key:

```js
import { mintEmbedAssertion } from '@mistriwork/mistri/handler';

const assertion = await mintEmbedAssertion({
  issuer: 'https://portal.example.com', key: process.env.PORTAL_EMBED_SECRET, app: 'compass',
  origin: 'https://portal.example.com', subject: user.id, email: user.email, emailVerified: true, name: user.name,
});
```

Your page posts it to the App and goes on signed in:

```js
const reply = await fetch('https://crm.example.com/api/auth/embed/exchange', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assertion }),
});
const { token } = await reply.json(); // only from another origin: send it as `Authorization: Bearer <token>`
```

<!-- no picture: the person lands on the App's own pages, already signed in; there is no screen of its own. -->

## What you'll see

- On the App's own origin (you proxy or mount it): the App's ordinary session cookie, the same grants as a password sign-in, and no sign-in screen. It is never a recent sign-in: what asks for one (opening a support session, making an API token) sends the person to sign in at the App's own page.
- From another origin in `origins`: no cookie, but a bearer good for an hour, only from that page and only on the App's browser routes. Never on sign-in, account or API-token routes (so it cannot be traded for a longer-lived credential), nor on a tenant's administration, invitations, branding or an integration's settings, nor on a platform operator's support sessions inside a tenant; those stay on the App's own origin. The bearer opens a session of its own that lapses with it.

## When to use it, and when not

- Use it when your own app already knows who is there and the App sits inside it, behind your proxy or in your pages.
- Use an [identity provider](/docs/identity-providers/) instead when people should sign in at the App itself with your organization's accounts.

## Options

| Entry key | What it does | Default | Status |
| --- | --- | --- | --- |
| `issuer` | Exactly the assertions' `iss` | required | Stable |
| `secret` or `jwks` | A `${VARIABLE}` holding an HS256 secret of 32 bytes or more, or your JWKS URL (ES256, EdDSA); a literal secret is refused | one required | Stable |
| `origins` | The pages that may exchange; an assertion names one in its `origin` claim | required | Stable |
| `apps` | The App ids (`aud`) it may sign people into | every App | Stable |
| `accounts` | `separate` keeps your subject apart from existing accounts; `link-verified-email` links one when both sides verified the address | `separate` | Stable |
| `createAccounts` | `false` signs in only accounts that exist already | accounts made at first sign-in | Stable |
| `roles` | `{ "<App role>": ["<your role>"] }`: the assertion's `roles` claim counts only through this map | ignored | Stable |
| `insecure` | Allows an `http` JWKS on a trusted network | `false` | Stable |

The server checks the signature, issuer, audience, origin, a lifetime of five minutes at most and thirty seconds of clock skew, and takes each `jti` once (kept in the App's auth store, so every instance refuses a replay). Each issuer has thirty exchanges a minute per client address. A tenant App's exchange works the same way and gives no membership. `POST /api/auth/embed/sign-out` ends the session when yours ends: with the bearer from another origin, or the cookie from the App's own page.

## Common mistakes

- `assertion_origin` → the `origin` claim must be the page that posts it, and listed in `origins`.
- `rate_limited` → exchange once per page load and keep the session; a bearer lasts an hour.
- `account_exists` → an account already has that email: set `"accounts": "link-verified-email"` and send `email_verified: true`.
- `[embed-issuer-no-auth]` → the App does not sign people in: give it `auth`.

## Related

- [Sign-in](/docs/sign-in/): the sessions and roles this exchange hands out.
- [Identity providers](/docs/identity-providers/): when people sign in at the App itself.
- [Tenant Apps](/docs/tenant-apps/): membership stays the tenant store's.
- [Secrets and hidden columns](/docs/secrets/): how `${VARIABLE}` references are read.
