# Keystone lead desk

Part of the [Keystone project](../README.md), mounted at `/leads`. Follow the
project README to seed, provision accounts and launch all six apps together.
All data is synthetic; no credit is offered or money moved.

Each dealership is a tenant. Staff work leads, take credit applications, compare deal structures and submit to the lender. A saved public application is placed using the dealer’s intake address. A platform service principal runs the decision reminder.

## Read the source

[app.ts](app.ts) assembles the features and realm grants. [server/tenant-policy.ts](server/tenant-policy.ts) declares tenant deployment policy; [server/commands.ts](server/commands.ts) registers handlers; [server/jobs.ts](server/jobs.ts) schedules reminders. [features/apply.ts](features/apply.ts) is the public application.

The manifest names commands by string; it never imports server handlers.
`mistri check` generates `mistri-schema.d.ts` and
`mistri-commands.d.ts`. Check this app with its own `tsconfig.json` so its
command names and schema stay separate from the other apps’ declarations.

For this app’s standalone flags and account setup, use the project launcher
and [database setup](../../../databases/keystone/README.md) as the reference.
The [suite contract](../SUITE.md) explains the authorization boundaries.
