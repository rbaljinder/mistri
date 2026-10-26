# What protects a value, and what only hides it

An App serves every column of every declared resource to whoever may read it,
whatever its pages draw. Decide what must never reach a browser before the
first page. The ways that hold, strongest first (a database role without
`SELECT`, `hidden`, a role's `fields`), are the table in `mistri docs secrets`;
grants are `mistri docs roles`, own rows `mistri docs row-access`.

## Beyond hiding a column

- **A change only its owner may make**: a command that checks `actor` against
  the stored row and calls `refuse` — a resident's report finds their own
  resident row by `actor` ([lintel/commands/maintenance.ts:48](../../../examples/apps/lintel/commands/maintenance.ts#L48)),
  and `refuse`s when there is none ([lintel/commands/maintenance.ts:49](../../../examples/apps/lintel/commands/maintenance.ts#L49)).
- **Only a reader's own rows**: a row policy scoped by `principal.id`, the
  verified account, with `rows: 'policy'`.
- **Who did it, never typed**: a command's `actor`, or the `me` and `now`
  stamps in a fixed action's `set`.
- **Kept out of the write trail and history**: `audit: { redact: [...] }`;
  the column is still read.
- **A column a role may not read, inside a command**: the `fields` ceiling
  does not bind the handler; keep the column out of its `output`.

## Only hides it (the value still reaches the browser)

`show`, a page's `fields`, `nav`; `when` on an action (the server checks it
only for a machine's verb or in a command); `masked`; a view filter for
"their" rows (use a row policy); a button left off a role's pages (withhold
the command instead).

## Checks before you ship

- Without `auth`, the server stays on loopback (the default `--host`) or
  behind a proxy that signs people in (`--auth-proxy-header`).
- `signUp: 'open'` with a privileged `defaultRole` leaks all that role reads.
- A resource reads unless it says `access: 'write'`; a role is granted only
  within it, and a command's `target` needs `access: 'write'`.
- `mistri check` reads the App once per role and names a column a role
  cannot read, a footprint it cannot read, a write grant that cannot make a row.
- `BETTER_AUTH_SECRET`, connection URLs and a provider's `clientSecret` are
  `${VARIABLE}` references from the environment, never literals.
- `verifiedEmails` on a provider only when it verifies every address it
  asserts (a multi-tenant Entra registration does not); a tenant's own
  provider (`oidc.tenants()`) asserts only its `domains` and grants no
  membership (`mistri docs identity-providers`).
- Tenant `branding.editors` names the tenant roles that may save the brand,
  the smallest that should; a support operator and the platform realm never
  save it, and `allow` opens only what a tenant may change (`mistri docs themes`).
- A public form or page: `auth.challenge` named before launch, `--trust-proxy`
  set on whichever host serves it (the tenant host too), a choice table opened
  under `auth.public` by label columns only, and no picture in `auth.public`
  that must stay private ([choices.md](choices.md#public-pages-and-forms)).
- Prove authorization over HTTP as each role, wrong role, wrong App and wrong
  tenant included (`mistri docs testing-apps`); `mistri shot --as <role>`
  only shows it, and MCP never acts as an App user.
