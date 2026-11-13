---
title: Identity in production
description: Who can sign in, how a sign-in is proved again for sensitive steps, how accounts link, and what ends a person's open sessions when you remove a role, a grant or an account.
---

Who can sign in, how a sign-in is proved again for sensitive steps, how
accounts link, and what ends a person's open sessions when you remove a role,
a grant or an account.

```ts
auth: {
  providers: ['email', oidc('workforce')],     // passwords for a few, your provider for the rest
  signUp: { providers: [oidc('workforce')] },
  roles: { underwriter: { read: true, commands: ['approve-loan'], claims: { groups: ['2f1c…'] } } },
},
```

```json
{ "name": "workforce", "kind": "oidc", "issuer": "https://login.microsoftonline.com/<tenant id>/v2.0",
  "clientId": "<application id>", "clientSecret": "${WORKFORCE_CLIENT_SECRET}",
  "mfa": ["http://schemas.openid.net/pape/policies/2007/06/multi-factor"], "backchannelLogout": true }
```

This page gathers what the other identity pages say into one checklist for a
production App and adds what none of them says in one place: when a removal
takes effect. The sources stay where they were: [sign-in](/docs/sign-in/),
[identity providers](/docs/identity-providers/), [SAML](/docs/saml/),
[SCIM](/docs/scim/), [sign in from your app](/docs/embed-sign-in/) and the
generated [auth reference](/docs/dsl-auth/).

## What signs a person in

| Door | What it is | Status |
| --- | --- | --- |
| Password (`'email'`) | An account in the sign-in store; resets by emailed link; locks after repeated failures | Stable |
| `'github'`, `'google'` | The provider's account, matched to an account by a verified address | Stable |
| `oidc('<name>')` | Any OpenID Connect provider: Entra ID, Okta, Keycloak, Azure AD B2C | Stable |
| `saml('<name>')` | A SAML 2.0 provider | Stable |
| A host app's assertion (`"kind": "embed"`) | Your own app vouches for the person it already signed in | Stable |
| A directory (`"kind": "scim"`) | Creates, updates and removes accounts; it does not sign anyone in | Preview |
| An API token, or an OAuth grant for an agent | A credential an account made; it acts under the roles it was made with | Stable |

**Multi-factor and passkeys.** mistri has no authenticator-app, passkey or
text-message sign-in of its own. Require them at your identity provider, and
list the `acr` (OpenID Connect) or `AuthnContextClassRef` (SAML) values that
mean more than one factor in the entry's `mfa`: a step-up then counts only a
sign-in that shows one of them. A password-only App has one factor.

**One-time codes that do exist.** A password reset is an emailed link, good for an hour.
A public form's `statusCheck.stepUp` emails (or texts, on an integration's channel) a six-digit code that opens more
for 15 minutes, and `link.email` proves an address by a code
([command forms](/docs/command-forms/#forms-saved-on-every-step)). These prove
control of an address for one form; they do not sign anyone in.

## Proving a sign-in again (step-up)

Some steps want a sign-in that is recent, not just a session that is valid:

| Step | How recent |
| --- | --- |
| Opening a platform support session inside a tenant | The last five minutes |
| A tenant member making an API token | The last five minutes; an older session is answered 403 `sign_in_required` |

The age counts from when the person signed in. For a session an identity
provider opened it counts from the ID token's `auth_time`, never later than the
session itself: a provider that signs someone in silently from its own session
asked them nothing, so that does not make it recent. A provider sign-in with no
usable `auth_time` does not count at all, and the step sends the person back to
the provider for a fresh authentication. When the provider entry lists `mfa`, a
sign-in counts only if it shows more than one factor. The longest any step may
ask for is 15 minutes. A session a host app's assertion opened is never recent,
whatever its age: those steps send the person to sign in at the App's own
page. There is nothing to configure; the App author's part is to put a
sensitive step behind one of the doors above rather than invent a fresh-login
check in a component.

## Accounts that link

An address links two ways of signing in to one account only when it is proved.

| Door | Links when |
| --- | --- |
| An identity provider | The provider says the address is verified (`email_verified`, or `verifiedEmails` on the entry). An unverified address never links; no provider is trusted by name |
| A host app's assertion | `"accounts": "link-verified-email"` and both sides verified the address; otherwise `separate` keeps your subject apart and a clash is `account_exists` |
| A directory | A verified address is linked; for an unverified one the earlier sign-in methods are removed first |
| A public form's `link` | Proven control only: the same device, a passed status check, or an email verified by code, never a matching name |

Only a verified address is matched to `me` and to the rows a row policy finds
by email ([who verifies an address](/docs/sign-in/#who-verifies-an-address)).

## When a removal takes effect

A session is a cookie that names a row in the sign-in store. Its roles are not
copied into it: they are read from the account on each request. That is why
most removals need no sign-out.

| You do this | Open sessions | Takes effect |
| --- | --- | --- |
| Deactivate an account, or set it a new password, on the accounts screen | Every other session ends. The account's API tokens and OAuth grants are revoked. Reactivating restores none of them | At once on this server |
| Change an account's roles by hand | Stay open and carry the new roles | The next request |
| Remove a person from a group your provider sends as `claims` | Stay open with the roles they were given at sign-in | The next sign-in through that provider. To end sooner: deactivate the account, let the directory do it (SCIM), or have the provider send a back-channel logout |
| The provider's back-channel logout (`backchannelLogout: true`) | The sessions that provider's session opened end, by `sid` or by subject. API tokens are the account's and stay | When the signed logout token arrives |
| A directory deactivates or deletes a person | Banned, sessions end, API tokens and OAuth grants revoked. Reactivating lifts only the ban | When the directory calls |
| A tenant member's membership is changed or the tenant is suspended | An API token made for it is refused | The next call |
| Take a command or a resource out of a role's grants (a new App definition, then a restart) | Stay open | The next request after the restart, for reads, writes and commands, including a receipt lookup for a command no longer granted |
| Take the grant from a service principal a job runs as | Nothing is held open | The next attempt: every attempt is authorized again, and a revoked one fails `not_authorized` without running the handler |
| A host app's session (`"kind": "embed"`) | On the App's own origin, an ordinary session; from another origin, a bearer good for an hour. `POST /api/auth/embed/sign-out` ends it | When your session ends and you call it, or after the hour |
| Sign out | The App locks and clears at once | At once |

Two limits are worth knowing before you promise anyone "immediately":

- **More than one server.** With a `postgres://` sign-in store, each server
  keeps what it read about a session for `MISTRI_AUTH_SESSION_CACHE` seconds
  (default 5, at most 60; `0` reads the store on every request). A change made
  through this server drops what it kept at once; a change another server or an
  operator's SQL made is honored here within that time.
- **What the browser already has.** What a page fetched stays in that tab.
  mistri sends a signed-in reader's pictures as `private, no-cache` so a
  withdrawn grant takes effect for them, but it does not reach into a browser
  to erase a screen, and there is no polling for a changed policy.

A row-policy App's policy sees the roles and the verified email and name of the
session that made the request, never ones the request body claims
([`PolicyPrincipal`](/docs/row-access/)).

## Limits on guessing

- A password sign-in locks an address after five failed attempts in 15 minutes,
  first for 30 seconds and doubling with each lock within a day up to 15
  minutes. An address no account has is counted and refused in the same words,
  so the lock does not reveal who has an account. The count is kept in the
  deployment's sign-in state, so it holds across instances.
- A public status check locks a receipt for an hour after five wrong answers or
  codes.
- A host-app exchange allows thirty a minute per issuer and client address; a
  directory gets 600 requests a minute.

## Before production

- Set `BETTER_AUTH_SECRET` (32 characters or more) and an email service, so resets and verified addresses work.
- Keep `signUp: 'invite'` unless you run an [email service](/docs/email/); `mistri check` fails open sign-up without one.
- Put people on a provider and require its multi-factor, with `mfa` listing what counts; keep passwords for a break-glass administrator.
- Turn on `backchannelLogout` where the provider supports it, and a directory where leavers must lose access the moment they leave.
- Keep the sign-in store in PostgreSQL when you run more than one instance, and decide whether five seconds of cache is acceptable for revocation.

*Proved by:* `test/account-administration.test.ts` (deactivation and a new password end sessions), `test/auth-store-reads.test.ts` (a write this process makes drops what was kept; the cache is bounded), `test/native-sign-in-age.test.ts` and `test/identity-providers.test.ts` (the age of a sign-in; `auth_time` and `mfa`), `test/auth-sign-in-lockout.test.ts` (the lock), `test/backchannel-logout-retry.test.ts` (a logout token), `test/embed-auth.test.ts` (the host-app exchange), `test/job-runner.test.ts` (a revoked grant on a later attempt), `test/business-command-execution.test.ts` (a revoked grant hides a receipt).
