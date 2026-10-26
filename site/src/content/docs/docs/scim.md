---
title: SCIM provisioning
description: Let a directory (Entra ID, Okta, any SCIM 2.0 client) create, update, deactivate and delete an App's people, so leavers lose access at once.
---

Let a directory (Entra ID, Okta, any SCIM 2.0 client) create, update,
deactivate and delete an App's people, so leavers lose access at once.

> **Preview.** SCIM provisioning works as documented and may change in any 1.x release. See [status](/docs/status/).

```json
{ "name": "entra", "kind": "scim", "provider": "workforce", "tokens": ["${ENTRA_SCIM_TOKEN}"],
  "roles": { "manager": ["Sales Managers"] } }
```

That entry goes in `mistri.json` beside the [identity provider](/docs/identity-providers/) people sign in through. Register `<public URL>/api/auth/scim/v2` and the token at the directory (startup prints the address).

<!-- no picture: the directory works over an API; people appear in, and leave, the App's account list. -->

## What you'll see

- A person the directory assigns gets an account with no password, and signs in through the provider.
- A person it deactivates or deletes is signed out at once, and their API tokens and OAuth grants stop working.

## When to use it, and when not

- Use a directory when it decides who works here and a leaver must lose access the moment they leave.
- Use roles from the provider's claims alone ([identity providers](/docs/identity-providers/)) when access may wait for the next sign-in.

## Options

| Entry key | What it does | Default |
| --- | --- | --- |
| `provider` | The `oidc` or `saml` entry people sign in through; it must have `domains`, the only addresses the directory reaches (anything else is a 409) | required |
| `tokens` | One `${VARIABLE}` bearer token of at least 32 characters, or two while one rotates | required |
| `roles` | `{ "<App role>": ["<group name>"] }`: the roles the directory sets and clears; a role an administrator gave stays | none |
| `apps` | The Apps it provisions, by id | every App that signs in through `provider` |

- **Accounts.** A verified address is linked to its account; an unverified one loses its earlier sign-in methods first; anyone else gets an account with no password, who signs in through the provider.
- **Leavers.** A deactivated or deleted person is banned, their sessions end, and their API tokens and OAuth grants are revoked. Reactivating lifts only that ban; revoked tokens stay revoked.
- **A tenant's own.** With a tenant's provider, the directory makes and ends that tenant's memberships, never the global account; a membership it ends or changes ends the API tokens and OAuth grants made for it. The tenant policy needs `administration` or `invitations`.
- **Limits.** Each directory gets 600 requests a minute.

## Common mistakes

- `[scim-no-auth]` or `[scim-provider-unused]` → give the App `auth` with the directory's provider in `auth.providers`, or take the App off the directory's `apps`.
- `[scim-role-unknown]` or `[scim-role-service]` → map a person's role the App declares in `auth.roles`.
- `[scim-role-claims]` → a role is the directory's or the claims', never both: drop one.
- `[scim-tenant-roles]` → map a tenant role from the directory's groups: a member holds one.

## Related

- [Sign in with your identity provider](/docs/identity-providers/): the `oidc` or `saml` entry a directory names.
- [Roles and field access](/docs/roles/): what a role the directory sets grants.
- [Tenant Apps](/docs/tenant-apps/): the memberships a tenant's directory manages.
