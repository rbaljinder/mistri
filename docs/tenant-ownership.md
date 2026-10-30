# Tenant subsystems: who owns what

A tenant App's runtime is several small subsystems, each with a store, a
connection manager and one reason to write. This note says which owns which;
it is deliberately silent on how many connections each may hold, which is
`packages/mistri/src/server/build/servedHosts.ts` and `docs/postgresql.md`.
The registry that defines every store, its tables and its layout version is
`packages/mistri/src/server/storeLayouts.ts`.

All of them sit in the **home source's database**, beside the tenant data and
the command journal (a tenant App is one existing SQLite or PostgreSQL
database, `tenant-apps.md`). The exceptions are the sign-in store and a
suite's databases, which are databases of their own. On PostgreSQL a store's
tables are in the `mistri` schema without the `__mistri_` prefix.

| Subsystem | Owns (store id, table prefix) | Writes when | Code |
| --- | --- | --- | --- |
| Tenant | `tenant-store`, `__mistri_tenant_`: tenants, memberships, the platform realm | An operator changes a tenant or membership; a request only reads | `server/tenant/tenantStore*.ts`, `tenantMembership.ts`, `tenantPlatform.ts` |
| Administration | `tenant-administration`, `__mistri_admin_`: one receipt per administrative operation, with its audit columns | Every operation under **Account → Manage tenants** and the tenant CLI | `tenantAdministration*.ts` |
| Invitations | `tenant-invitations`, `__mistri_invitation_` | An invitation is made, claimed or revoked | `tenantInvitation*.ts` |
| Support | `tenant-support-audit`, `__mistri_support_`: sessions and the chained entries sealed with `MISTRI_AUDIT_KEY`; the operator's lease is a support membership (`tenantSupportMembership*.ts`) | A platform operator enters a tenant, acts, and leaves | `tenantSupport*.ts` |
| Jobs | `jobs`, `workflows`, `command-events` and `event-delivery`: `__mistri_job_`, `__mistri_workflow_`, `__mistri_event_`, `__mistri_delivery_` | The jobs host claims, runs and settles work; a command emits an event | `server/jobs/`, `tenantJobs.ts`, `tenantFeatureEvents.ts` |
| Outbox | The email outbox is part of the notification store (`inbox`, `__mistri_inbox_`): a notice and its mail row are written in the triggering write's transaction and sent after it commits | A `notify` rule with `email: true`; the sender loop claims and settles rows | `server/email/outbox.ts`, `adapters/inbox/inboxMail.ts`, `tenantNoticeMail.ts` |
| Integrations | `integrations`, `__mistri_integration_`: secrets, calls, verified webhook deliveries and channel messages; a rule that mails an address a record holds queues there too | An integration call or inbound delivery | `server/integrations/`, `tenantIntegrations.ts` |

Beside them, in the same database and owned by no one subsystem: the command
journal (`command-journal`, receipts and audit of every command), record
history, live sync's change store, sandboxes, branding, the per-tenant switches
for the assistant and decisions, the assistant's conversations, the mail log
and a production build's validation record.

## Rules that follow

- **Where two must agree, one transaction writes both.** A notice and its mail
  row, and an administrative operation's receipt and audit columns, commit
  together (`tenant-apps.md`), so a rollback leaves neither.
- **Provisioning is explicit, in dependency order.** The tenant store first,
  then the administration journal, then invitations, then the support audit
  (`TENANT_ORDER` in `storeLayouts.ts`); `mistri migrate stores up --app <dir>
  --policy <file>` runs them so. Serving attests each store and never creates
  or migrates one.
- **A backup takes them together.** They describe the same rows, so they are
  restored as one snapshot (`build-and-deploy.md`, Back up and restore).
- **The audit key belongs to Support alone.** No other store uses
  `MISTRI_AUDIT_KEY`.
