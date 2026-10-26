# Keystone dealer website

Part of the [Keystone project](../README.md), mounted at `/site`. Follow the
project README to seed, provision accounts and launch all six apps together.
All data is synthetic; no credit is offered or money moved.

One App serves explicitly enrolled dealership storefronts. The suite launcher's
example maps `https://liberty-ford.localhost/site/` to dealer `liberty-ford`.
The deployment policy independently checks that the dealer is active and its
site is published before admitting public inventory, record-derived branding
and placed forms. Questions, test-drive requests and financing inquiries create
synthetic business records scoped to that dealer; eligibility is checked again
inside the write transaction. A host mapping selects a dealer, not authorization.

Signed out at the canonical `https://keystone.localhost/site/` address, the App
shows a neutral, unplaced shell with shared financing information, not a default
dealer's inventory or intake. Unconfigured hosts do not select a storefront.
See the [project setup](../README.md#prepare-the-https-addresses) for the required
trusted HTTPS proxy, exact host routing and canonical sign-in address.

Fresh setup or an explicit `--upgrade-placement` enrolls the deployment and
provisions the placement journal. The upgrade preserves an existing runtime's
accounts and credentials; ordinary resume never provisions the journal. A
persisted dedicated issuer key and physical-database/logical-source identity
survive restarts, while each activation captures a fresh epoch and the current
policy hash.

## Read the source

[app.ts](app.ts) declares policy-backed public reads and record-derived branding.
[features/publicSite.ts](features/publicSite.ts) replaces the original
single-dealer presentation over [views.ts](views.ts); [pages/](pages/) describes
record pages. The deployment-only [policy.ts](policy.ts) and
[server/publicPlacement.ts](server/publicPlacement.ts) own storefront eligibility,
row scopes and placed-form admission. [commands.ts](commands.ts) handles
submissions, using placement-neutral inputs from [server/inputs.ts](server/inputs.ts).
[dealer.ts](dealer.ts) retains legacy presentation constants and the launcher's
sample dealer ID; it does not determine public read or intake authority.

The manifest names commands by string; it never imports server handlers.
`mistri check` generates `mistri-schema.d.ts` and
`mistri-commands.d.ts`. Check this app with its own `tsconfig.json` so its
command names and schema stay separate from the other apps’ declarations.

Use the project launcher's explicit placement setup or additive upgrade before
serving this App. The [database setup](../../../databases/keystone/README.md)
describes the shared synthetic records and account provisioning.
The [suite contract](../SUITE.md) explains the authorization boundaries.
