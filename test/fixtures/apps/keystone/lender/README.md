# Keystone lender

Part of the [Keystone project](../README.md), mounted at `/`. Follow the
project README to seed, provision accounts and launch all six apps together.
All data is synthetic; no credit is offered or money moved.

The lender’s staff assign underwriting, record decisions, clear conditions, fund loans, post payments and manage dealer relationships. Role grants and column ceilings separate underwriting, funding, servicing and relationship work.

## Read the source

[commands.ts](commands.ts) contains seventeen operations. [inputs.ts](inputs.ts) supplies their field shapes. [resources.ts](resources.ts), [views.ts](views.ts) and [pages/](pages/) describe the workspaces.

The credit decision is a durable workflow: [server/credit-decision.ts](server/credit-decision.ts) starts when an underwriter runs `requestCreditCheck`, requests the check from the provider through a `credit-provider` webhook connection, waits for the signed callback, approves a score of 720 or more by itself, and otherwise refers the file and waits for an underwriter's decision, with a reminder. The callback is a verified inbound endpoint declared in [server/jobs.ts](server/jobs.ts) (`POST /api/inbound/creditResult`) that runs `recordCreditResult` as the `credit-provider` principal. Name `jobs.ts` as the App's `jobs` in the suite, add a `credit-provider` webhook connection, and set `CREDIT_CALLBACK_SECRET` to turn it on. Roles with the `workflows` operations grant see the instances on the Workflows page ([pages/workflows.page.tsx](pages/workflows.page.tsx)).

The manifest names commands by string; it never imports server handlers.
`mistri check` generates `mistri-schema.d.ts` and
`mistri-commands.d.ts`. Check this app with its own `tsconfig.json` so its
command names and schema stay separate from the other apps’ declarations.

For this app’s standalone flags and account setup, use the project launcher
and [database setup](../../../databases/keystone/README.md) as the reference.
The [suite contract](../SUITE.md) explains the authorization boundaries.
