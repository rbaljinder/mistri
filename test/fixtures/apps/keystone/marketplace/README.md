# Keystone marketplace

Part of the [Keystone project](../README.md), mounted at `/marketplace`. Follow the
project README to seed, provision accounts and launch all six apps together.
All data is synthetic; no credit is offered or money moved.

Visitors browse cars and rates, filter photo cards, open vehicle galleries and send inquiries or rate checks. Signed-in shoppers keep their own shortlist and inquiries under a row policy. Marketplace staff can review rate checks and send a lead to a dealer.

## Read the source

[views.ts](views.ts) and [cards.ts](cards.ts) curate browsing. [features/](features/) contains the public forms and account features; [server/](server/) implements their commands. [policy.ts](policy.ts) scopes account-owned records.

The manifest names commands by string; it never imports server handlers.
`mistri check` generates `mistri-schema.d.ts` and
`mistri-commands.d.ts`. Check this app with its own `tsconfig.json` so its
command names and schema stay separate from the other apps’ declarations.

For this app’s standalone flags and account setup, use the project launcher
and [database setup](../../../databases/keystone/README.md) as the reference.
The [suite contract](../SUITE.md) explains the authorization boundaries.
