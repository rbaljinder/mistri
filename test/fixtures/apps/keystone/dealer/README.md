# Keystone dealer settings

Part of the [Keystone project](../README.md), mounted at `/dealer`. Follow the
project README to seed, provision accounts and launch all six apps together.
All data is synthetic; no credit is offered or money moved.

A dealership’s owner and sales manager maintain its branding, car listings and team. The row policy limits reads and writes to their active dealerships. Branding and prices can be edited in place; publication, listing and team changes run commands.

## Read the source

[policy.ts](policy.ts) resolves dealership ownership from the verified account. [commands.ts](commands.ts) implements the decisions. [app.ts](app.ts) keeps publication and listing timestamps out of ordinary field writes.

The manifest names commands by string; it never imports server handlers.
`mistri check` generates `mistri-schema.d.ts` and
`mistri-commands.d.ts`. Check this app with its own `tsconfig.json` so its
command names and schema stay separate from the other apps’ declarations.

For this app’s standalone flags and account setup, use the project launcher
and [database setup](../../../databases/keystone/README.md) as the reference.
The [suite contract](../SUITE.md) explains the authorization boundaries.
