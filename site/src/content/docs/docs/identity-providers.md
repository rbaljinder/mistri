---
title: Sign in with your identity provider
description: Sign people in through an OpenID Connect or SAML 2.0 provider (Entra ID, Okta, ADFS, Keycloak) and give them roles from its claims.
---

Sign people in through an OpenID Connect or SAML 2.0 provider (Entra ID,
Okta, ADFS, Keycloak) and give them roles from its claims.

```ts
auth: {
  providers: ['email', oidc('workforce')],
  signUp: { providers: [oidc('workforce')] },          // or { domains: ['contoso.com'] }
  roles: { underwriter: { read: true, commands: ['approve-loan'], claims: { groups: ['2f1c…'] } } },
},
```

```json
{ "name": "workforce", "kind": "oidc", "label": "Contoso", "issuer": "https://login.microsoftonline.com/<tenant id>/v2.0",
  "clientId": "<application id>", "clientSecret": "${WORKFORCE_CLIENT_SECRET}" }
```

The App names the provider and `mistri.json` says where it is. Register `<public URL>/api/auth/callback/workforce` at the provider.

<!-- no picture: the sign-in screen gains one button with the provider's label; Sign-in shows that screen. -->

## What you'll see

- **Continue with Contoso** on the sign-in card: the entry's `label` is all the browser learns of it.
- An underwriter's role given at every sign-in from the `groups` claim, and recorded in the account's history.

## When to use it, and when not

- Use a provider when your organization already signs people in and decides their groups; use [passwords](/docs/sign-in/) for a small team without one.
- Use `claims` when the provider should decide roles; leave it off and an administrator sets roles by hand.

## Options

| Entry key | What it does | Default |
| --- | --- | --- |
| `issuer`, `clientId`, `clientSecret` | The provider; the secret is only ever a `${VARIABLE}`, and a literal one is refused | required |
| `scopes` | What is asked for | `email profile` |
| `discovery` | A metadata URL other than `<issuer>/.well-known/openid-configuration` | derived |
| `verifiedEmails` | The provider asserts only verified addresses | `false` |
| `mfa` | The `acr` values that mean more than one factor | none |
| `insecure` | Allows an `http` issuer on a trusted network | `false` |
| `backchannelLogout` | The provider may end the sessions it opened (below) | `false` |

Every sign-in is a code flow with PKCE, state and nonce. The server checks the ID token's signature, issuer, audience, `azp`, age (a minute of skew) and nonce. A person is the issuer's subject, never an email, and only the ID token is kept.

- **Roles.** `claims: { <claim or dotted.path>: [values] }` gives a role at each sign-in, and counts only in a session that provider opened: a password session of the same account keeps only the roles set by hand. A sign-in that leaves no declared role is refused.
- **Whose claims.** With more than one provider, say which one a rule reads: `claims: { provider: oidc('workforce'), groups: ['admins'] }`. A rule without `provider` is read from any of them, and `check` warns where there is more than one.
- **Sign-up.** `'invite'` makes no account at a first sign-in, `'open'` does, and `{ providers, domains }` does through those providers or for a verified email in those domains.
- **Linking.** An address links to an existing account only if verified (`email_verified`, or `verifiedEmails`).
- **Step-up.** Opening a support session needs a sign-in from the last five minutes; with `mfa`, one with more than one factor.
- **A tenant's own.** `oidc.tenants()` offers **Sign in with your work email**; an entry with `"tenant": "north", "domains": ["north-motors.com"]` is that tenant's, set by whoever runs the platform. It gives no membership.
- **SAML 2.0.** `saml('corp')` and a `"kind": "saml"` entry sign in the same way: [SAML 2.0 sign-in](/docs/saml/). A directory that adds and removes people is [SCIM provisioning](/docs/scim/).
- **Back-channel logout.** With `"backchannelLogout": true`, register `<public URL>/api/auth/backchannel-logout/<name>` at the provider (startup prints it). A signed logout token ends the sessions that provider's session opened, by `sid` or by subject; API tokens are the account's and stay.

Recipes: **Entra ID** issuer `https://login.microsoftonline.com/<tenant id>/v2.0`, add the `email` optional claim, and use `verifiedEmails` only for a single-tenant app. **Entra External ID** `https://<tenant id>.ciamlogin.com/<tenant id>/v2.0`.
**Azure AD B2C** `https://<name>.b2clogin.com/tfp/<tenant id>/<policy>/v2.0/` with `discovery` set to `https://<name>.b2clogin.com/<name>.onmicrosoft.com/<policy>/v2.0/.well-known/openid-configuration`.
**Okta** `https://<org>.okta.com/oauth2/default`, a `groups` claim, `"mfa": ["urn:okta:loa:2fa:any"]`. **Keycloak** `https://<host>/realms/<realm>`, **Add to ID token** in the roles mapper, then `claims: { 'realm_access.roles': [...] }`.

## Common mistakes

- `[identity-provider-unknown]` or `[identity-provider-kind]` → add an entry with that name to `mistri.json`: `"kind": "oidc"` for `oidc('…')`, `"kind": "saml"` for `saml('…')`.
- `[claim-without-provider]`: a role has `claims` and no `oidc('…')` or `saml('…')` provider → add the provider, or drop `claims`; `[claim-grants-nothing]` → give the role a grant, or drop it.
- `[claim-provider-unknown]` → `claims.provider` names one of the App's `providers`; `[claim-any-provider]` (warning) → add `provider` to the role's `claims`.
- `[claim-in-tenant-app]` → in a tenant App, grant the membership in the tenant store instead.

## Related

- [Sign-in](/docs/sign-in/): the other providers, accounts and the first administrator.
- [Roles and field access](/docs/roles/): what a role from claims grants.
- [Several Apps in one server](/docs/suites/): one provider shared by a suite.
