# Keystone customer portal

Part of the [Keystone project](../README.md), mounted at `/customer`. Follow the
project README to seed, provision accounts and launch all six apps together.
All data is synthetic; no credit is offered or money moved.

Borrowers see their own loans, installments, payments and documents. They schedule a synthetic payment, request a payoff quote and manage autopay through commands. The policy resolves the borrower from the verified account; commands copy ownership from the authorized record.

## Read the source

[policy.ts](policy.ts) scopes the borrower’s records. [commands.ts](commands.ts) implements the four operations, with field shapes in [inputs.ts](inputs.ts). [pages/](pages/) describes loan, payment, autopay and profile pages.

The manifest names commands by string; it never imports server handlers.
`mistri check` generates `mistri-schema.d.ts` and
`mistri-commands.d.ts`. Check this app with its own `tsconfig.json` so its
command names and schema stay separate from the other apps’ declarations.

For this app’s standalone flags and account setup, use the project launcher
and [database setup](../../../databases/keystone/README.md) as the reference.
The [suite contract](../SUITE.md) explains the authorization boundaries.
