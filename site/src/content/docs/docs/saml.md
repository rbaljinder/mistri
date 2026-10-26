---
title: SAML 2.0 sign-in
description: Sign people in through a SAML 2.0 provider, such as ADFS, Okta or Entra ID, and give them roles from its attributes.
---

Sign people in through a SAML 2.0 provider, such as ADFS, Okta or Entra ID,
and give them roles from its attributes.

```ts
auth: { providers: ['email', saml('corp')] },
```

```json
{ "name": "corp", "kind": "saml", "label": "Contoso", "entityId": "http://www.okta.com/exk1…",
  "ssoUrl": "https://contoso.okta.com/app/…/sso/saml", "certificates": ["-----BEGIN CERTIFICATE-----…"],
  "verifiedEmails": true }
```

Startup prints the two things to register at the provider: this App's entity ID (`<public URL>/api/auth/sso/saml2/sp/metadata?providerId=corp`, which also serves its metadata) and its assertion consumer service (`<public URL>/api/auth/sso/saml2/sp/acs/corp`). It needs the `@better-auth/sso` package, which `npm install @mistriwork/mistri` brings unless optional dependencies are skipped.

<!-- no picture: the sign-in screen gains one button with the provider's label; Sign-in shows that screen. -->

## What you'll see

- **Continue with Contoso** on the sign-in card: the entry's `label` is all the browser learns of it.
- A role given at every sign-in from the attributes a role's `claims` name, as for [OpenID Connect](/docs/identity-providers/).

## When to use it, and when not

- Use SAML when your organization's provider offers it and not OpenID Connect, as ADFS often does.
- Use [OpenID Connect](/docs/identity-providers/) instead wherever the provider offers both: it needs no certificates to roll over.

## Options

| Entry key | What it does | Default |
| --- | --- | --- |
| `entityId`, `ssoUrl` | The provider's entity ID (its responses' Issuer) and its sign-in address | required |
| `certificates` | One or two PEM certificates it signs with; two while it rolls one over, when its signatures must carry the certificate | required |
| `attributes` | `{ "email": "<attribute>", "name": "<attribute>" }`; without `email`, the address is an `emailAddress` NameID | none |
| `label`, `verifiedEmails`, `mfa`, `tenant`, `domains`, `insecure` | As for OpenID Connect; `mfa` lists `AuthnContextClassRef` values | |

Only sign-in the App starts is taken: a response must answer this App's own request, once, within a minute of skew. Its assertion must be signed with SHA-256 or stronger. A response with a DOCTYPE, a comment, an encrypted assertion or more than one assertion is refused unread. A person is the provider's entity ID and a persistent or `emailAddress` NameID; a transient one is refused. Attributes are the claims a role's `claims` read, and `saml.tenants()` is a tenant's own provider. Single logout is not offered.

## Common mistakes

- `[identity-provider-unknown]` → add an entry of `"kind": "saml"` with that name to `mistri.json`.
- `[identity-provider-kind]` → `saml('…')` names a `saml` entry; an `oidc` one is `oidc('…')`.

## Related

- [Sign in with your identity provider](/docs/identity-providers/): OpenID Connect, roles from claims, sign-up and linking.
- [SCIM provisioning](/docs/scim/): a directory that adds and removes the people a provider signs in.
- [Sign-in](/docs/sign-in/): the other providers, accounts and the first administrator.
