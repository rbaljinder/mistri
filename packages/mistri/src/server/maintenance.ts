/**
 * The maintenance entry, `@mistriwork/mistri/maintenance`: explicit operator steps for
 * the command event store, event delivery and the durable job store, on
 * SQLite or PostgreSQL. Nothing here runs when an App starts. Each call opens
 * what it needs, does one bounded thing and closes it again; provisioning is
 * idempotent and refuses a foreign layout unchanged.
 *
 * `provisionStores` provisions every store mistri keeps beside an App's
 * records, from the one store list (storeLayouts.ts): the stores an App opts
 * into by name (`only`: record history, live sync, the inbox, branding, the assistant,
 * tenant sandboxes, integrations, PostgreSQL's schema epoch), and the stores
 * bound to the App, derived from `app` and `jobs` exactly as the server
 * derives them at startup: the App's (or tenant App's) event store, one
 * delivery destination per webhook effect or job, and the job, workflow, mail
 * and integrations stores a jobs module needs. The server attests each at
 * startup and never creates it. `effectDeliveryPolicies` names each webhook
 * destination's policy, which inspection, redrive and pruning take. Cloning
 * and importing tenant sandboxes are `mistri tenant` and Manage tenants,
 * not calls here. The schema epoch is one row that moves with every DDL, so a
 * command checks the catalog by reading it instead of the catalog itself; it
 * needs a role that may create event triggers, and without it nothing is less
 * correct, only slower.
 *
 * `applyMigrations` applies a directory of versioned SQL migrations, as
 * `mistri migrate up` does (migrate/runner.ts): for a seed or a deploy
 * script that migrates a database before it starts a server.
 *
 * Redrive, prune and inspection are maintenance only, with no HTTP surface:
 * a redrive is recorded in the attempt history with the operator's id, and
 * inspection returns no payload, input, provenance or error text.
 */
import { provisionSqliteCommandEventStore, type CommandEventStoreBinding } from '../adapters/events/commandEventSchema.js';
import type { EventDeliveryStore } from '../adapters/events/eventDeliveryContract.js';
import { provisionSqliteEventDeliveryStore } from '../adapters/events/eventDeliverySchema.js';
import { openSqliteEventDeliveryStore } from '../adapters/events/eventDeliveryStore.js';
import {
  deliveryFail,
  type EventDeliveryAttemptInspection,
  type EventDeliveryInspection,
  type EventDeliveryPolicy,
  type EventDeliveryState,
} from '../adapters/events/eventDeliveryTypes.js';
import { provisionPostgresCommandEventStore } from '../adapters/events/postgresCommandEventStore.js';
import { openPostgresEventDeliveryStore, provisionPostgresEventDeliveryStore } from '../adapters/events/postgresEventDeliveryStore.js';
import { openSqliteJobStore } from '../adapters/jobs/jobStore.js';
import type { JobStore } from '../adapters/jobs/jobStoreContract.js';
import { provisionSqliteJobStore } from '../adapters/jobs/jobStoreSchema.js';
import {
  captureJobPolicy,
  jobFail,
  type JobAttemptInspection,
  type JobInspection,
  type JobPolicyInput,
  type JobState,
} from '../adapters/jobs/jobStoreTypes.js';
import { migratePostgresJobStore, openPostgresJobStore } from '../adapters/jobs/postgresJobStore.js';
import { MYSQL_REFUSAL } from '@mistriwork/engine/adapters/connect.js';
import { PgConnectionManager } from '@mistriwork/engine/adapters/postgresPool.js';
import { openSqliteWorkflowStore } from '../adapters/workflows/workflowStore.js';
import type { WorkflowStore } from '../adapters/workflows/workflowStoreContract.js';
import { openPostgresWorkflowStore } from '../adapters/workflows/postgresWorkflowStore.js';
import { migratePostgresWorkflowStore, provisionSqliteWorkflowStore } from '../adapters/workflows/workflowStoreSchema.js';
import { migratePostgresMailStore, openMailStore, provisionSqliteMailStore } from '../adapters/mail/mailStore.js';
import { provisionPostgresIntegrations, provisionSqliteIntegrations } from '../adapters/integrations/integrationStore.js';
import { mailLinkKey } from './email/mailLinks.js';
import {
  WORKFLOW_OPERATOR,
  workflowFail,
  workflowRefuse,
  type WorkflowActionInspection,
  type WorkflowInspection,
  type WorkflowState,
  type WorkflowStepInspection,
} from '../adapters/workflows/workflowStoreTypes.js';
import { retryAdmits, wakeKey, WORKFLOW_JOB_VERSION, workflowJobId, workflowOfPartition } from './workflows/workflowKeys.js';
import { appCommandEventStore } from './commands/appCommandEvents.js';
import { effectDeployment } from './effects/effectHost.js';
import { withCommandVersions, type BusinessCommandRegistry } from './commands/businessCommands.js';
import { lockedVersion } from './commands/commandContracts.js';
import type { TenantStoreBinding } from './tenant/tenantStoreContract.js';
import { runFunnel, type FunnelResult } from './analytics/funnel.js';
import { openAnalyticsStore, pruneAnalyticsEvents as pruneStoredAnalyticsEvents, type AnalyticsBinding } from './analytics/store.js';
import type { AnalyticsFunnel } from '../shared/appAnalytics.js';
import { jobDeployment } from './jobs/jobLoader.js';
import { provisionSqliteDecisions } from '../adapters/decide/sqliteDecisions.js';
import { provisionPostgresDecisions } from '../adapters/decide/postgresDecisions.js';
import { capturedJobModule, runsJobs, type CapturedJobModule, type JobModule } from './jobs/jobModule.js';
import { supportAuditKey } from './tenant/tenantSupportAuditContract.js';
import { STORES, TENANT_ORDER, type StoreProvisioned } from './storeLayouts.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import { DECLARABLE_STORES, declaredStores } from './stores/declaredStores.js';
import type { Dialect } from '@mistriwork/engine/server/migrate/database.js';

export type {
  CommandEventStoreBinding,
  EventDeliveryAttemptInspection,
  EventDeliveryInspection,
  EventDeliveryPolicy,
  JobAttemptInspection,
  JobInspection,
  JobPolicyInput,
  WorkflowActionInspection,
  WorkflowInspection,
  WorkflowState,
  WorkflowStepInspection,
};

/* A deployment migrates its command journal itself, before starting the server — startup and requests attest
   it and never migrate. The PostgreSQL authentication store, the tenant store, its administration journal,
   invitations and support audit are migrated the same explicit way, on the stopped database, and the support
   audit — the chained record of what an operator did inside a dealer's tenant, under the deployment's
   MISTRI_AUDIT_KEY — is verified here: verification reports any session whose rows were altered, by id.
   SQLite tenant stores are made by `provisionStores`. */
export { migrateSqliteCommandJournal } from '../adapters/commands/commandJournal.js';
export { migratePostgresCommandJournal } from '../adapters/commands/postgresCommandJournal.js';
export { migratePostgresAuthStore } from '../adapters/auth/postgresAuthStore.js';
export { migratePostgresTenantStore } from './tenant/tenantStorePostgres.js';
export { migratePostgresTenantAdministrationJournal } from './tenant/tenantAdministrationJournalPostgres.js';
export { migratePostgresTenantInvitations } from './tenant/tenantInvitationStorePostgres.js';
export { verifySqliteSupportAudit } from './tenant/tenantSupportAudit.js';
export { migratePostgresSupportAudit, verifyPostgresSupportAudit } from './tenant/tenantSupportAuditPostgres.js';
export type { TenantStoreBinding };

/** Where a store lives: an existing SQLite file, or a PostgreSQL database. */
export type MaintenanceTarget = Readonly<{ sqlite: string }> | Readonly<{ postgres: string }>;
/** A page of inspection rows and, when there may be more, where to continue. */
export interface MaintenancePage<Row> {
  readonly rows: readonly Row[];
  readonly after?: string;
}

const PAGE = 128;
/** Bounded pruning: at most this many batches per call, each its own transaction. */
const PRUNE_BATCHES = 64;

function target(value: MaintenanceTarget, fail: () => never): Readonly<{ sqlite: string } | { postgres: string }> {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 1) return fail();
  if ('sqlite' in value && typeof value.sqlite === 'string' && value.sqlite.length) return Object.freeze({ sqlite: value.sqlite });
  if ('postgres' in value && typeof value.postgres === 'string' && /^postgres(ql)?:\/\//i.test(value.postgres))
    return Object.freeze({ postgres: value.postgres });
  return fail();
}
function ids(values: unknown, fail: () => never): readonly string[] {
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > PAGE ||
    new Set(values).size !== values.length ||
    values.some((value) => typeof value !== 'string')
  )
    return fail();
  return Object.freeze([...values]);
}

/**
 * Apply every pending migration in `dir` (Flyway's `V<version>__<name>.sql`
 * and `R__<name>.sql`), each in its own transaction, and record them in the
 * history table, mistri's own unless `table` names another. Resolves to
 * the scripts applied; rejects, having applied what came before it, when one
 * fails or the files and the history disagree. A database with tables and no
 * history is refused: `mistri migrate baseline` records it first.
 */
export async function applyMigrations(
  where: MaintenanceTarget,
  dir: string,
  options: Readonly<{ table?: string; schemas?: readonly string[] }> = {},
): Promise<readonly string[]> {
  const on = target(where, () => {
    throw new TypeError('applyMigrations needs { sqlite: <path> } or { postgres: <url> }.');
  });
  const { migrateUp } = await import('@mistriwork/engine/server/migrate/runner.js');
  const { DEFAULT_HISTORY_TABLE } = await import('@mistriwork/engine/server/migrate/history.js');
  const result = await migrateUp({
    url: 'sqlite' in on ? on.sqlite : on.postgres,
    schemas: options.schemas ?? [],
    dir,
    table: options.table ?? DEFAULT_HISTORY_TABLE,
  });
  const problem =
    result.refused ??
    result.status.plan.problems[0] ??
    (result.failure ? `${result.failure.file.script}: ${result.failure.message}` : undefined);
  if (problem) throw new Error(`Migrations in ${dir} were not all applied: ${problem}`);
  return result.applied.map(({ file }) => file.script);
}

/** The event store an App's emitting commands write into, beside the
 * source's command journal, which must already be migrated. One per App;
 * idempotent, and a foreign layout is refused unchanged. Run it with the
 * server stopped. */
function provisionSqliteAppCommandEvents(
  path: string,
  request: Readonly<{ appId: string; sourceId: string }>,
): { version: 1; provisioned: boolean } {
  return provisionSqliteCommandEventStore(path, appCommandEventStore(request?.appId, request?.sourceId));
}
async function provisionPostgresAppCommandEvents(
  url: string,
  request: Readonly<{ appId: string; sourceId: string }>,
): Promise<{ version: 1; provisioned: boolean }> {
  return provisionPostgresCommandEventStore(url, appCommandEventStore(request?.appId, request?.sourceId));
}

/** A tenant App's event store: its commands' batches are the tenants', so it is
 * bound exactly as the tenant store is (the App, the tenant policy's storeId
 * and the source). The command journal must already be migrated. Idempotent;
 * a foreign layout is refused unchanged. Run it with the server stopped. */
const tenantEventStore = (binding: TenantStoreBinding): CommandEventStoreBinding => ({
  appId: binding?.appId,
  storeId: binding?.storeId,
  sourceId: binding?.source?.id,
});
function provisionSqliteTenantCommandEvents(path: string, binding: TenantStoreBinding): { version: 1; provisioned: boolean } {
  return provisionSqliteCommandEventStore(path, tenantEventStore(binding));
}
async function provisionPostgresTenantCommandEvents(
  url: string,
  binding: TenantStoreBinding,
): Promise<{ version: 1; provisioned: boolean }> {
  return provisionPostgresCommandEventStore(url, tenantEventStore(binding));
}

/** What a jobs provisioning created: true where this call provisioned it. */
interface JobsProvisioned {
  readonly events: boolean;
  readonly destinations: readonly Readonly<{ id: string; added: boolean }>[];
  /** The job store: false, and not made, for a module that runs no jobs (only mail, inbound or integrations). */
  readonly jobs: boolean;
  /** The workflow store, present when the module declares workflows. */
  readonly workflows?: boolean;
  /** The mail store, present when the module declares mail. */
  readonly mail?: boolean;
  /** The integrations store, present when the module lists integrations. */
  readonly integrations?: boolean;
  /** The decision store, present when the module declares decisions. */
  readonly decisions?: boolean;
}
/** A `--jobs` deployment request: the App, a registry holding at least
 * every command the jobs start on and run, as the server registers them,
 * and the jobs module. `lock` is the App's authority.lock text: a delivery
 * destination names the version of each command it listens to, and the server
 * reads those versions from the lock, so a provisioning that omits it can only
 * attest an App whose contracts are all at version 1. */
interface JobsProvisionRequest {
  readonly appId: string;
  readonly commands: BusinessCommandRegistry;
  readonly jobs: JobModule;
  readonly lock?: string;
}
const deploymentOf = (request: JobsProvisionRequest) =>
  jobDeployment(capturedJobModule(request?.jobs), {
    appId: request.appId,
    commands: request.lock === undefined ? request.commands : withCommandVersions(request.commands, lockedVersion(request.lock)),
  });

/**
 * Everything a `--jobs` module needs on its SQLite source, which must
 * already hold the command journal: the App's event store, each job's
 * delivery destination and the job store, derived exactly as the server
 * derives them at startup. Idempotent; run it with the server stopped.
 */
/* The integrations store holds an integration's secrets and calls, and every verified inbound delivery while its
   window is open: a module with inbound endpoints keeps it, as one with integrations does. */
const keepsDeliveries = (module: CapturedJobModule): boolean => module.integrations !== undefined || module.inbound.size > 0;

function provisionSqliteJobs(path: string, request: JobsProvisionRequest): JobsProvisioned {
  const deployment = deploymentOf(request);
  const events = provisionSqliteCommandEventStore(path, deployment.events).provisioned;
  const destinations = [...deployment.destinations, ...deployment.workflowDestinations].map(({ policy }) =>
    Object.freeze({ id: policy.destinationId, added: provisionSqliteEventDeliveryStore(path, policy, { stopped: true }).destinationAdded }),
  );
  const jobs = runsJobs(capturedJobModule(request.jobs)) && provisionSqliteJobStore(path, deployment.store).provisioned;
  return Object.freeze({
    events,
    destinations: Object.freeze(destinations),
    jobs,
    ...(deployment.workflowDestinations.length ? { workflows: provisionSqliteWorkflowStore(path).provisioned } : {}),
    ...(keepsDeliveries(capturedJobModule(request.jobs)) ? { integrations: provisionSqliteIntegrations(path).provisioned } : {}),
    ...(capturedJobModule(request.jobs).decisions ? { decisions: provisionSqliteDecisions(path).provisioned } : {}),
  });
}
/** The same on a PostgreSQL source, each step under the shared migration
 * lock; hosts already running may keep running. */
async function provisionPostgresJobs(url: string, request: JobsProvisionRequest): Promise<JobsProvisioned> {
  const deployment = deploymentOf(request);
  const events = (await provisionPostgresCommandEventStore(url, deployment.events)).provisioned;
  const destinations: Array<Readonly<{ id: string; added: boolean }>> = [];
  for (const { policy } of [...deployment.destinations, ...deployment.workflowDestinations]) {
    destinations.push(
      Object.freeze({ id: policy.destinationId, added: (await provisionPostgresEventDeliveryStore(url, policy)).destinationAdded }),
    );
  }
  const jobs = runsJobs(capturedJobModule(request.jobs)) && (await migratePostgresJobStore(url, deployment.store)).migrated;
  return Object.freeze({
    events,
    destinations: Object.freeze(destinations),
    jobs,
    ...(deployment.workflowDestinations.length
      ? { workflows: (await migratePostgresWorkflowStore(url, deployment.store.namespace)).migrated }
      : {}),
    ...(capturedJobModule(request.jobs).mail ? { mail: (await migratePostgresMailStore(url)).provisioned } : {}),
    ...(keepsDeliveries(capturedJobModule(request.jobs)) ? { integrations: (await provisionPostgresIntegrations(url)).provisioned } : {}),
    ...(capturedJobModule(request.jobs).decisions ? { decisions: (await provisionPostgresDecisions(url)).provisioned } : {}),
  });
}

/** What an effects provisioning created: true where this call provisioned it. */
interface EffectsProvisioned {
  readonly events: boolean;
  readonly destinations: readonly Readonly<{ id: string; webhook: string; added: boolean }>[];
}
/** The App, and a registry holding every command with effects, as the server registers it. A tenant App also
 * names its tenant store (`storeId`, its policy's): its effects ride the tenant event store, every tenant's. */
interface EffectsProvisionRequest {
  readonly appId: string;
  readonly commands: BusinessCommandRegistry;
  readonly storeId?: string;
}
function effectsOf(request: EffectsProvisionRequest) {
  const storeId = request?.storeId;
  const deployment = effectDeployment({
    appId: request?.appId,
    commands: request?.commands,
    ...(storeId === undefined ? {} : { tenants: (sourceId: string) => ({ appId: request.appId, storeId, sourceId }) }),
  });
  if (!deployment) throw new Error('No command in this registry has effects, so there is nothing to provision.');
  return deployment;
}

/**
 * Everything a registry's effects need on their SQLite source, which must
 * already hold the command journal: the App's event store and each webhook's
 * delivery destination. Idempotent; run it with the server stopped, and again
 * after a command version or an effect changes, which is a new destination.
 */
function provisionSqliteEffects(path: string, request: EffectsProvisionRequest): EffectsProvisioned {
  const deployment = effectsOf(request);
  const events = provisionSqliteCommandEventStore(path, deployment.events).provisioned;
  const destinations = deployment.destinations.map(({ webhook, policy }) =>
    Object.freeze({
      id: policy.destinationId,
      webhook,
      added: provisionSqliteEventDeliveryStore(path, policy, { stopped: true }).destinationAdded,
    }),
  );
  return Object.freeze({ events, destinations: Object.freeze(destinations) });
}
/** The same on a PostgreSQL source, each step under the shared migration lock. */
async function provisionPostgresEffects(url: string, request: EffectsProvisionRequest): Promise<EffectsProvisioned> {
  const deployment = effectsOf(request);
  const events = (await provisionPostgresCommandEventStore(url, deployment.events)).provisioned;
  const destinations: Array<Readonly<{ id: string; webhook: string; added: boolean }>> = [];
  for (const { webhook, policy } of deployment.destinations) {
    destinations.push(
      Object.freeze({
        id: policy.destinationId,
        webhook,
        added: (await provisionPostgresEventDeliveryStore(url, policy)).destinationAdded,
      }),
    );
  }
  return Object.freeze({ events, destinations: Object.freeze(destinations) });
}
/** Each webhook's delivery policy, as the server derives it: what inspectEventDeliveries, redrive and prune take. */
export function effectDeliveryPolicies(
  request: EffectsProvisionRequest,
): readonly Readonly<{ webhook: string; policy: EventDeliveryPolicy }>[] {
  return Object.freeze(effectsOf(request).destinations.map(({ webhook, policy }) => Object.freeze({ webhook, policy })));
}

/* ---------- provisioning: one entry over the store list ---------- */

/** A database provisionStores works on: a SQLite file or a PostgreSQL URL. */

/** The App the bound stores belong to, as the server binds them at startup. */
export interface StoresApp {
  /** The App's id. A tenant App's is its binding's, and may be left out. */
  readonly id?: string;
  /** The source its commands run on: the App's event store is bound to it. */
  readonly source?: string;
  /** A registry holding every command the effects or the jobs name, as the server registers it. */
  readonly commands?: BusinessCommandRegistry;
  /** The App's authority.lock text: a job's delivery destination names the version of each command it listens to,
   * read from the lock, so a provisioning without it can only attest an App whose contracts are all at version 1. */
  readonly lock?: string;
  /** A tenant App: its tenant store's binding, which binds its event store, effects and jobs to every tenant. */
  readonly tenant?: TenantStoreBinding;
  /** A tenant App's loaded definition, when its machines declare timers (`after`, `at`): they run as jobs of the
   * module, wrapped as the server wraps it, so a module whose only jobs are the timers still gets its job store. */
  readonly definition?: AppDef;
  /** The App's pages, which `definition` is read with: a history section is a page's (declaredStores.ts). */
  readonly pages?: readonly PageDef[];
}

export interface ProvisionStoresOptions {
  /**
   * The App the bound stores belong to. With `jobs`, everything the module
   * needs: the event store, a delivery destination per job and workflow, and
   * the job, workflow, mail, integrations and decision stores. Otherwise, when its
   * `commands` post effects, the event store and a destination per webhook;
   * otherwise its event store alone, bound to its `source` or `tenant`.
   */
  readonly app?: StoresApp;
  /** The `--jobs` module, with `app.commands`. */
  readonly jobs?: JobModule;
  /** Stores that need no binding, by their id in the store list: `record-history`, `inbox`, `branding`, `assistant`, `decisions`,
   * `tenant-sandboxes`, `integrations`, `live-change`, `schema-epoch`. Given the App's `definition` (and `pages`) and no `only`, every
   * one of them the App declares is made (declaredStores.ts); given both, an `only` that names one the App does not declare is
   * refused, so a hand-kept list cannot drift from the App. Also a tenant App's own, which need `app.tenant`:
   * `tenant-store`, `tenant-administration`, `tenant-invitations`, `tenant-support-audit`, made in that order
   * whatever order they are listed in. When `only` names nothing else, `app.tenant` is the binding alone and the
   * App's command stores are not provisioned. */
  readonly only?: readonly string[];
}

/** What provisionStores did. */
export interface StoresProvisioned {
  /** Each store it reached, by id: the version it left, where the store keeps one, and whether this call created it. */
  readonly stores: Readonly<Record<string, StoreProvisioned>>;
  /** Each delivery destination it reached (a webhook's, a job's, a workflow's), and whether this call added it. */
  readonly destinations: readonly Readonly<{ id: string; webhook?: string; added: boolean }>[];
}

const storesFail = (why: string): never => {
  throw new TypeError(`provisionStores: ${why}`);
};

function storeTarget(value: MaintenanceTarget): Readonly<{ dialect: Dialect; address: string }> {
  if (value && typeof value === 'object' && 'mysql' in value) return storesFail(MYSQL_REFUSAL);
  const at = target(value, () => storesFail('the target is { sqlite: <path> } or { postgres: <url> }.'));
  return Object.freeze('sqlite' in at ? { dialect: 'sqlite', address: at.sqlite } : { dialect: 'postgres', address: at.postgres });
}

/**
 * Provision the stores an App needs in one database, from the store list
 * (storeLayouts.ts). Idempotent: a store already there is left as it is and
 * reported `provisioned: false`; a foreign layout is refused unchanged. Run
 * it with the server stopped (on PostgreSQL, each step takes the shared
 * migration lock, so hosts already running may keep running). The command
 * journal a bound store stands on must already be there
 * (`migrateSqliteCommandJournal` / `migratePostgresCommandJournal`, below). A tenant App's stores (`only: ['tenant-store', …]`) take
 * its binding as `app: { tenant }`.
 */
export async function provisionStores(where: MaintenanceTarget, options: ProvisionStoresOptions = {}): Promise<StoresProvisioned> {
  const { dialect, address } = storeTarget(where);
  const { app, jobs, only = [] } = options ?? {};
  if (!Array.isArray(only) || only.some((id) => typeof id !== 'string')) storesFail('`only` is a list of store ids.');
  if (app === undefined && jobs === undefined && !only.length) storesFail('name the stores (`only`) or the App they are bound to (`app`).');
  if (jobs !== undefined && !app?.commands) storesFail("a jobs module runs the App's commands: give `app.commands` with it.");
  if (app?.tenant !== undefined && app.id !== undefined && app.id !== app.tenant?.appId)
    storesFail("the App's id and its tenant binding's App are not the same.");
  // Every store is checked before any is made: a refused list provisions nothing.
  let wanted = [...new Set(only)];
  /* The App's own declaration decides which of its stores are wanted: derived when `only` is left out, checked when it is not. */
  if (app?.definition !== undefined) {
    const declared = await declaredStores(app.definition, app.pages, jobs);
    const refused = wanted.filter((id) => DECLARABLE_STORES.includes(id) && !declared.includes(id));
    if (refused.length)
      storesFail(
        `the App does not declare ${refused.map((id) => `"${id}"`).join(', ')}${declared.length ? ` (it declares ${declared.map((id) => `"${id}"`).join(', ')})` : ' (it declares no store of that kind)'}; take it out of \`only\`, or declare what needs it.`,
      );
    if (!wanted.length) {
      wanted = declared.filter((id) => STORES.find((each) => each.id === id)?.provision?.[dialect]);
    }
  }
  const unbound = wanted.map((id) => {
    const def = STORES.find((each) => each.id === id);
    if (!def) return storesFail(`no store is called "${id}".`);
    if (def.provisionTenant) {
      const make = def.provisionTenant[dialect as 'sqlite' | 'postgres'];
      if (!make)
        return storesFail(
          `"${id}" (${def.title}) is kept in ${Object.keys(def.provisionTenant).join(' or ')}, and this database is ${dialect}.`,
        );
      if (app?.tenant === undefined)
        return storesFail(`"${id}" (${def.title}) is a tenant App's: give its binding as \`app: { tenant }\`.`);
      const tenant = app.tenant;
      return [id, (at: string) => make(at, tenant)] as const;
    }
    const make = def.provision?.[dialect];
    if (!make)
      return storesFail(
        def.provision
          ? `"${id}" (${def.title}) is kept in ${Object.keys(def.provision).join(' or ')}, and this database is ${dialect}.`
          : `"${id}" (${def.title}) is bound to an App: provision it with \`app\`${def.id === 'jobs' || def.id === 'workflows' || def.id === 'mail' ? ' and `jobs`' : ''}.`,
      );
    return [id, make] as const;
  });
  // The audit's key is read before the first store is made: a missing one refuses the whole list.
  if (wanted.includes('tenant-support-audit')) supportAuditKey();
  // Dependency order, not the caller's: the journal needs the tenant store, the invitations need the journal.
  const rank = (id: string) => (TENANT_ORDER.includes(id) ? TENANT_ORDER.indexOf(id) : -1);
  unbound.sort((a, b) => rank(a[0]) - rank(b[0]));
  // `app` is only the tenant binding's carrier when every store asked for is a tenant store: the App's own
  // command stores are provisioned by `app` alone, or beside stores that are not the tenant's.
  const tenantOnly = jobs === undefined && wanted.length > 0 && wanted.every((id) => TENANT_ORDER.includes(id));
  /* An App given by its declaration alone (no commands, source, tenant or jobs) binds no command store: nothing then says where its events live. */
  const bindsNothing =
    app?.definition !== undefined &&
    jobs === undefined &&
    app.commands === undefined &&
    app.source === undefined &&
    app.tenant === undefined;
  const stores: Record<string, StoreProvisioned> = {};
  let destinations: readonly Readonly<{ id: string; webhook?: string; added: boolean }>[] = [];
  if ((app !== undefined || jobs !== undefined) && !tenantOnly && !bindsNothing) {
    const bound = await boundStores(dialect, address, app!, jobs);
    Object.assign(stores, bound.stores);
    destinations = bound.destinations;
  }
  for (const [id, make] of unbound) if (!(id in stores)) stores[id] = Object.freeze({ ...(await make(address)) });
  return Object.freeze({ stores: Object.freeze(stores), destinations: Object.freeze(destinations) });
}

/* The bound stores, each derived by the same function the server's startup uses; the results say what was made. */
async function boundStores(
  dialect: 'sqlite' | 'postgres',
  address: string,
  app: StoresApp,
  jobs: JobModule | undefined,
): Promise<Pick<StoresProvisioned, 'stores' | 'destinations'>> {
  const appId = app.id ?? app.tenant?.appId;
  if (typeof appId !== 'string') return storesFail("the App's `id` is needed (or its `tenant` binding).");
  const sqlite = dialect === 'sqlite';
  const madeOf = (made: JobsProvisioned) => ({
    stores: {
      'command-events': Object.freeze({ provisioned: made.events }),
      ...(runsJobsOf(app, jobs!) ? { jobs: Object.freeze({ provisioned: made.jobs }) } : {}),
      ...(made.workflows === undefined ? {} : { workflows: Object.freeze({ provisioned: made.workflows }) }),
      ...(made.mail === undefined ? {} : { mail: Object.freeze({ provisioned: made.mail }) }),
      ...(made.integrations === undefined ? {} : { integrations: Object.freeze({ provisioned: made.integrations }) }),
    },
    destinations: made.destinations,
  });
  if (jobs !== undefined) {
    const module = capturedJobModule(jobs);
    /* Inbound endpoints alone run no job and keep no job store: the integrations store their deliveries are
       remembered in, and whatever else the App binds here. */
    if (app.tenant === undefined && !runsJobs(module) && !module.mail && !module.integrations && module.inbound.size) {
      const integrations = sqlite
        ? provisionSqliteIntegrations(address).provisioned
        : (await provisionPostgresIntegrations(address)).provisioned;
      const binds = app.source !== undefined || (app.commands !== undefined && effectDeployment({ appId, commands: app.commands }));
      const rest = binds ? await boundStores(dialect, address, app, undefined) : { stores: {}, destinations: [] };
      return {
        stores: { ...rest.stores, integrations: Object.freeze({ provisioned: integrations }) },
        destinations: rest.destinations,
      };
    }
    if (app.tenant !== undefined) {
      const request = { commands: app.commands!, jobs, ...(app.definition ? { app: app.definition } : {}) };
      return madeOf(
        sqlite ? provisionSqliteTenantJobs(address, app.tenant, request) : await provisionPostgresTenantJobs(address, app.tenant, request),
      );
    }
    const request = { appId, commands: app.commands!, jobs, ...(app.lock === undefined ? {} : { lock: app.lock }) };
    return madeOf(sqlite ? provisionSqliteJobs(address, request) : await provisionPostgresJobs(address, request));
  }
  const effects =
    app.commands &&
    effectDeployment({
      appId,
      commands: app.commands,
      ...(app.tenant === undefined ? {} : { tenants: (sourceId: string) => ({ appId, storeId: app.tenant!.storeId, sourceId }) }),
    });
  if (effects) {
    const request = { appId, commands: app.commands!, ...(app.tenant === undefined ? {} : { storeId: app.tenant.storeId }) };
    const made = sqlite ? provisionSqliteEffects(address, request) : await provisionPostgresEffects(address, request);
    return { stores: { 'command-events': Object.freeze({ provisioned: made.events }) }, destinations: made.destinations };
  }
  if (app.tenant !== undefined) {
    const made = sqlite
      ? provisionSqliteTenantCommandEvents(address, app.tenant)
      : await provisionPostgresTenantCommandEvents(address, app.tenant);
    return { stores: { 'command-events': Object.freeze({ ...made }) }, destinations: [] };
  }
  if (app.source === undefined)
    return storesFail('the App binds no store here: give its `source`, its `commands` with effects, or `jobs`.');
  const request = { appId, sourceId: app.source };
  const made = sqlite ? provisionSqliteAppCommandEvents(address, request) : await provisionPostgresAppCommandEvents(address, request);
  return { stores: { 'command-events': Object.freeze({ ...made }) }, destinations: [] };
}

/* Whether the module runs jobs, as the provisioning that made (or found) the job store decided it. */
const runsJobsOf = (app: StoresApp, jobs: JobModule) =>
  runsJobs(
    app.tenant !== undefined && app.definition !== undefined
      ? withTenantMachineTimers(jobs, app.definition, app.commands!)
      : capturedJobModule(jobs),
  );

async function withDeliveries<T>(
  where: MaintenanceTarget,
  policy: EventDeliveryPolicy,
  run: (store: EventDeliveryStore) => Promise<T>,
): Promise<T> {
  const at = target(where, deliveryFail);
  if ('sqlite' in at) {
    const store = openSqliteEventDeliveryStore(at.sqlite, policy);
    try {
      return await run(store);
    } finally {
      await store.close();
    }
  }
  const connection = new PgConnectionManager(at.postgres);
  try {
    const store = await openPostgresEventDeliveryStore(connection, policy);
    try {
      return await run(store);
    } finally {
      await store.close();
    }
  } finally {
    await connection.close().catch(() => {});
  }
}
async function withJobs<T>(where: MaintenanceTarget, policy: JobPolicyInput, run: (store: JobStore) => Promise<T>): Promise<T> {
  const at = target(where, jobFail);
  if ('sqlite' in at) {
    const store = openSqliteJobStore(at.sqlite, policy);
    try {
      return await run(store);
    } finally {
      await store.close();
    }
  }
  const connection = new PgConnectionManager(at.postgres);
  try {
    const store = await openPostgresJobStore(connection, policy);
    try {
      return await run(store);
    } finally {
      await store.close();
    }
  } finally {
    await connection.close().catch(() => {});
  }
}

/** One destination's deliveries, by event id, at most 128 a page. */
export async function inspectEventDeliveries(
  where: MaintenanceTarget,
  policy: EventDeliveryPolicy,
  filter: Readonly<{ state?: EventDeliveryState; after?: string; limit?: number }> = {},
): Promise<MaintenancePage<EventDeliveryInspection>> {
  return withDeliveries(where, policy, async (store) => {
    const limit = filter.limit ?? PAGE;
    const rows = await store.inspect(filter.state, filter.after ?? '', limit);
    return Object.freeze({ rows, ...(rows.length === limit ? { after: rows.at(-1)!.eventId } : {}) });
  });
}
export async function inspectEventDeliveryAttempts(
  where: MaintenanceTarget,
  policy: EventDeliveryPolicy,
  eventId: string,
): Promise<readonly EventDeliveryAttemptInspection[]> {
  return withDeliveries(where, policy, (store) => store.attempts(eventId));
}
/** Failed or unknown deliveries back to retry, each recorded with the
 * operator. The first refusal stops the call; the ones before it stand. */
export async function redriveEventDeliveries(
  where: MaintenanceTarget,
  policy: EventDeliveryPolicy,
  request: Readonly<{ eventIds: readonly string[]; operator: string }>,
): Promise<readonly EventDeliveryInspection[]> {
  const eventIds = ids(request?.eventIds, deliveryFail);
  return withDeliveries(where, policy, async (store) => {
    const done = [];
    for (const eventId of eventIds) done.push(await store.redrive(eventId, request.operator, Date.now()));
    return Object.freeze(done);
  });
}
/** Delivered receipts older than `olderThanMs`, in bounded batches. Receipt
 * markers stay, so nothing pruned is discovered again. */
export async function pruneEventDeliveries(
  where: MaintenanceTarget,
  policy: EventDeliveryPolicy,
  request: Readonly<{ olderThanMs: number; batch?: number }>,
): Promise<Readonly<{ receipts: number; deliveries: number; more: boolean }>> {
  return withDeliveries(where, policy, async (store) => {
    let receipts = 0,
      deliveries = 0,
      more = true;
    for (let batch = 0; batch < PRUNE_BATCHES && more; batch++) {
      const result = await store.prune(request.olderThanMs, Date.now(), request.batch ?? 64);
      receipts += result.receipts;
      deliveries += result.deliveries;
      more = result.more;
    }
    return Object.freeze({ receipts, deliveries, more });
  });
}

/** The namespace's jobs, in insertion order, at most 128 a page. */
export async function inspectJobs(
  where: MaintenanceTarget,
  policy: JobPolicyInput,
  filter: Readonly<{ state?: JobState; job?: string; after?: string; limit?: number }> = {},
): Promise<MaintenancePage<JobInspection>> {
  return withJobs(where, policy, async (store) => {
    const limit = filter.limit ?? PAGE;
    const rows = await store.inspect(
      {
        ...(filter.state === undefined ? {} : { state: filter.state }),
        ...(filter.job === undefined ? {} : { job: filter.job }),
        ...(filter.after === undefined ? {} : { afterId: filter.after }),
      },
      limit,
    );
    return Object.freeze({ rows, ...(rows.length === limit ? { after: rows.at(-1)!.id } : {}) });
  });
}
export async function inspectJobAttempts(
  where: MaintenanceTarget,
  policy: JobPolicyInput,
  id: string,
): Promise<readonly JobAttemptInspection[]> {
  return withJobs(where, policy, (store) => store.attempts(id));
}
/** Failed jobs, or unknown ones whose lease has run out, back to retry with
 * a fresh budget, each recorded with the operator. */
export async function redriveJobs(
  where: MaintenanceTarget,
  policy: JobPolicyInput,
  request: Readonly<{ ids: readonly string[]; operator: string }>,
): Promise<readonly JobInspection[]> {
  const jobIds = ids(request?.ids, jobFail);
  return withJobs(where, policy, async (store) => {
    const done = [];
    for (const id of jobIds) done.push(await store.redrive(id, request.operator, Date.now()));
    return Object.freeze(done);
  });
}
/** Succeeded jobs older than `olderThanMs`, in bounded batches. */
export async function pruneJobs(
  where: MaintenanceTarget,
  policy: JobPolicyInput,
  request: Readonly<{ olderThanMs: number; batch?: number }>,
): Promise<Readonly<{ pruned: number; more: boolean }>> {
  return withJobs(where, policy, async (store) => {
    let pruned = 0,
      more = true;
    for (let batch = 0; batch < PRUNE_BATCHES && more; batch++) {
      const result = await store.prune(request.olderThanMs, Date.now(), request.batch ?? 256);
      pruned += result.pruned;
      more = result.more;
    }
    return Object.freeze({ pruned, more });
  });
}

/* ---------- durable workflows ----------
   The instances a jobs module's workflows started, and what an operator may do
   to one. Inspection returns no payload, result or error text; a retry and a
   cancel are the operator's, kept in the instance's history, and a retry's
   next advance is a job in the job store. Each call is of one App's
   instances: the job policy names its namespace, which on PostgreSQL is
   the App's share of a database several Apps may hold. */
async function withWorkflows<T>(where: MaintenanceTarget, policy: JobPolicyInput, run: (store: WorkflowStore) => Promise<T>): Promise<T> {
  const at = target(where, workflowFail);
  let namespace: string;
  try {
    namespace = captureJobPolicy(policy).namespace;
  } catch {
    return workflowRefuse('operator_invalid');
  }
  if ('sqlite' in at) {
    const store = openSqliteWorkflowStore(at.sqlite);
    try {
      return await run(store);
    } finally {
      await store.close();
    }
  }
  const connection = new PgConnectionManager(at.postgres);
  try {
    const store = await openPostgresWorkflowStore(connection, namespace);
    try {
      return await run(store);
    } finally {
      await store.close();
    }
  } finally {
    await connection.close().catch(() => {});
  }
}

/**
 * Workflow instances by id, at most 128 a page, with the state, version, key,
 * current step and next wake-up of each.
 */
export async function inspectWorkflows(
  where: MaintenanceTarget,
  policy: JobPolicyInput,
  filter: Readonly<{ state?: WorkflowState; workflow?: string; after?: string; limit?: number }> = {},
): Promise<MaintenancePage<WorkflowInspection>> {
  return withWorkflows(where, policy, async (store) => {
    const limit = filter.limit ?? PAGE;
    const rows = await store.inspect(
      {
        ...(filter.state === undefined ? {} : { state: filter.state }),
        ...(filter.workflow === undefined ? {} : { workflow: filter.workflow }),
        ...(filter.after === undefined ? {} : { afterId: filter.after }),
      },
      limit,
    );
    return Object.freeze({ rows, ...(rows.length === limit ? { after: rows.at(-1)!.id } : {}) });
  });
}
/**
 * One instance's steps, in the order they were first reached.
 */
export async function inspectWorkflowSteps(
  where: MaintenanceTarget,
  policy: JobPolicyInput,
  id: string,
): Promise<readonly WorkflowStepInspection[]> {
  return withWorkflows(where, policy, (store) => store.steps(id));
}
/**
 * Who cancelled or retried one instance, and when, oldest first.
 */
export async function inspectWorkflowActions(
  where: MaintenanceTarget,
  policy: JobPolicyInput,
  id: string,
): Promise<readonly WorkflowActionInspection[]> {
  return withWorkflows(where, policy, (store) => store.actions(id));
}
/**
 * Stop a live instance for good. One already over is unchanged.
 */
export async function cancelWorkflow(
  where: MaintenanceTarget,
  policy: JobPolicyInput,
  request: Readonly<{ id: string; operator: string }>,
): Promise<Readonly<{ outcome: 'cancelled' | 'unchanged'; state: WorkflowState }>> {
  if (!request || typeof request.operator !== 'string' || !WORKFLOW_OPERATOR.test(request.operator))
    return workflowRefuse('operator_invalid');
  return withWorkflows(where, policy, (store) => store.cancel(request.id, request.operator, Date.now()));
}
/**
 * Run a `failed` or `diverged` instance again from its last good step: the
 * step that stopped it, and every one after, is forgotten, and a wake-up job
 * is enqueued in the job store. On a tenant App, `tenantId` names
 * the instance's tenant, which the wake-up carries: without it, or with
 * another, a tenant's instance is refused as not_retryable, unchanged.
 */
export async function retryWorkflow(
  where: MaintenanceTarget,
  policy: JobPolicyInput,
  request: Readonly<{ id: string; operator: string; appId: string; tenantId?: string }>,
): Promise<WorkflowInspection> {
  if (
    !request ||
    typeof request.operator !== 'string' ||
    !WORKFLOW_OPERATOR.test(request.operator) ||
    typeof request.appId !== 'string' ||
    (request.tenantId !== undefined && (typeof request.tenantId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(request.tenantId)))
  )
    return workflowRefuse('operator_invalid');
  return withWorkflows(where, policy, (store) =>
    withJobs(where, policy, async (jobs) => {
      const now = Date.now();
      const instance = await store.retry(request.id, request.operator, now, retryAdmits(request.tenantId));
      await jobs.enqueue(
        {
          job: workflowJobId(workflowOfPartition(instance.workflow).name),
          version: WORKFLOW_JOB_VERSION,
          idempotencyKey: wakeKey('retry', instance.id, instance.epoch),
          input: { instance: instance.id },
          provenance: {
            appId: request.appId,
            actorId: `operator:${request.operator}`,
            ...(request.tenantId === undefined ? {} : { tenantId: request.tenantId }),
            correlationId: instance.id,
            causationId: instance.id,
          },
        },
        now,
      );
      return Object.freeze({
        id: instance.id,
        workflow: instance.workflow,
        version: instance.version,
        key: instance.key,
        state: instance.state,
        currentStep: instance.currentStep,
        waitEvent: instance.waitEvent,
        wakeAt: instance.wakeAt,
        problem: instance.problem,
        problemStep: instance.problemStep,
        createdAt: instance.createdAt,
        updatedAt: instance.updatedAt,
      });
    }),
  );
}
/**
 * Completed and cancelled instances older than `olderThanMs`, with their steps,
 * and the signals nothing can read any more, in bounded batches.
 */
export async function pruneWorkflows(
  where: MaintenanceTarget,
  policy: JobPolicyInput,
  request: Readonly<{ olderThanMs: number; batch?: number }>,
): Promise<Readonly<{ pruned: number; more: boolean }>> {
  return withWorkflows(where, policy, async (store) => {
    let pruned = 0,
      more = true;
    for (let batch = 0; batch < PRUNE_BATCHES && more; batch++) {
      const result = await store.prune(request.olderThanMs, Date.now(), request.batch ?? 256);
      pruned += result.pruned;
      more = result.more;
    }
    return Object.freeze({ pruned, more });
  });
}

/* ---------- a tenant App's jobs ----------
   Appended as one block, import included: the entry's sections are added by
   separate pieces of work, each at the end. */
import { tenantJobDeployment, withTenantMachineTimers } from './tenant/tenantJobs.js';
import type { AppDef } from '../shared/app.js';

/** A tenant App's `--jobs` request: a registry holding at least every command
 * the jobs start on and run, as the server registers them, and the jobs
 * module. The App, its store and its source are the tenant store binding's. */
interface TenantJobsProvisionRequest {
  readonly commands: BusinessCommandRegistry;
  readonly jobs: JobModule;
  /** The loaded App, when its machines declare timers (`after`, `at`): they
   * run as jobs of the module, wrapped as the server wraps it at startup, so a
   * module whose only jobs are the timers still gets its job store. */
  readonly app?: AppDef;
}
const tenantModuleOf = (request: TenantJobsProvisionRequest) =>
  request?.app === undefined ? capturedJobModule(request?.jobs) : withTenantMachineTimers(request.jobs, request.app, request.commands);
const tenantJobsOf = (binding: TenantStoreBinding, request: TenantJobsProvisionRequest) =>
  tenantJobDeployment(tenantModuleOf(request), { binding, commands: request?.commands });

/**
 * Everything a tenant App's `--jobs` needs on its SQLite source, which must
 * already hold the tenant store and the command journal: the tenant event
 * store (bound as the tenant store is), one delivery destination per job,
 * taking every tenant's facts of the command it starts on, and the job store.
 * Derived exactly as the server derives them at startup, which attests them
 * and never creates them. Idempotent; run it with the server stopped.
 */
function provisionSqliteTenantJobs(path: string, binding: TenantStoreBinding, request: TenantJobsProvisionRequest): JobsProvisioned {
  const deployment = tenantJobsOf(binding, request),
    module = tenantModuleOf(request);
  const events = provisionSqliteCommandEventStore(path, deployment.events).provisioned;
  const destinations = [...deployment.destinations, ...deployment.workflowDestinations].map(({ policy }) =>
    Object.freeze({ id: policy.destinationId, added: provisionSqliteEventDeliveryStore(path, policy, { stopped: true }).destinationAdded }),
  );
  return Object.freeze({
    events,
    destinations: Object.freeze(destinations),
    jobs: runsJobs(module) && provisionSqliteJobStore(path, deployment.store).provisioned,
    ...(deployment.workflowDestinations.length ? { workflows: provisionSqliteWorkflowStore(path).provisioned } : {}),
    ...(module.mail ? { mail: provisionSqliteMailStore(path).provisioned } : {}),
    ...(module.integrations ? { integrations: provisionSqliteIntegrations(path).provisioned } : {}),
  });
}
/** The same on a PostgreSQL source, each step under the shared migration lock. */
async function provisionPostgresTenantJobs(
  url: string,
  binding: TenantStoreBinding,
  request: TenantJobsProvisionRequest,
): Promise<JobsProvisioned> {
  const deployment = tenantJobsOf(binding, request),
    module = tenantModuleOf(request);
  const events = (await provisionPostgresCommandEventStore(url, deployment.events)).provisioned;
  const destinations: Array<Readonly<{ id: string; added: boolean }>> = [];
  for (const { policy } of [...deployment.destinations, ...deployment.workflowDestinations]) {
    destinations.push(
      Object.freeze({ id: policy.destinationId, added: (await provisionPostgresEventDeliveryStore(url, policy)).destinationAdded }),
    );
  }
  return Object.freeze({
    events,
    destinations: Object.freeze(destinations),
    jobs: runsJobs(module) && (await migratePostgresJobStore(url, deployment.store)).migrated,
    ...(deployment.workflowDestinations.length
      ? { workflows: (await migratePostgresWorkflowStore(url, deployment.store.namespace)).migrated }
      : {}),
    ...(module.mail ? { mail: (await migratePostgresMailStore(url)).provisioned } : {}),
    ...(module.integrations ? { integrations: (await provisionPostgresIntegrations(url)).provisioned } : {}),
  });
}
/**
 * End signed mail links: one by its nonce, or every link to one
 * record of a tenant. A revoked link answers as an expired one; the others
 * the secret signs are untouched. Returns how many were revoked.
 */
export async function revokeTenantMailLinks(
  target: Readonly<{ sqlite: string }> | Readonly<{ postgres: string }>,
  selector:
    | Readonly<{ tenant: string; nonce: string }>
    | Readonly<{ tenant: string; resource: string; key: Readonly<Record<string, string | number>> }>,
  now: number = Date.now(),
): Promise<number> {
  const store = await openMailStore(target);
  try {
    return await store.revoke(
      'nonce' in selector
        ? { tenantId: selector.tenant, nonce: selector.nonce }
        : { tenantId: selector.tenant, resource: selector.resource, keyJson: mailLinkKey(selector.key) },
      now,
    );
  } finally {
    await store.close();
  }
}

/** The job store's policy and each job's delivery policy, as the server
 * derives them: what inspectJobs, inspectEventDeliveries and their redrives
 * and prunes take for a tenant App's jobs. */
export function tenantJobPolicies(
  binding: TenantStoreBinding,
  request: TenantJobsProvisionRequest,
): Readonly<{
  store: JobPolicyInput;
  destinations: readonly Readonly<{ job: string; policy: EventDeliveryPolicy }>[];
  workflowDestinations: readonly Readonly<{ workflow: string; policy: EventDeliveryPolicy }>[];
}> {
  const deployment = tenantJobsOf(binding, request);
  return Object.freeze({
    store: deployment.store,
    destinations: deployment.destinations,
    workflowDestinations: deployment.workflowDestinations,
  });
}
/* Tenant maintenance (tenant/tenantMaintenance.ts): a tenant store's
   tenants, `@platform` row, platform and tenant memberships, each one
   journaled transaction under `maintenance:<operator>`, and native accounts
   in the App's own auth store. Platform staff are managed only here. */
export {
  createAppAccounts,
  grantPlatformMembership,
  grantTenantMembership,
  putTenant,
  revokePlatformMembership,
  revokeTenantMembership,
  setPlatformStatus,
  TenantMaintenanceRefusal,
} from './tenant/tenantMaintenance.js';
export type { MembershipResult, TenantAnchorResult, TenantMaintenanceTarget } from './tenant/tenantMaintenance.js';

/* ---------- behavior analytics (src/server/analytics/) ---------- */

/** @preview Where an analytics store lives: its URL and the binding that names its tables. */
export type AnalyticsLocation = Readonly<{ url: string; binding: AnalyticsBinding }>;
/**
 * A funnel the App declares, counted over `[from, to)` (a Date, or milliseconds) from the analytics store. A tenant's
 * own is `tenantId`; without one, every tenant's.
 *
 * @preview Analytics is a Preview feature (docs/status.md).
 */
export async function inspectFunnel(
  where: AnalyticsLocation,
  funnel: AnalyticsFunnel,
  window: Readonly<{ from: number | Date; to: number | Date; tenantId?: string }>,
): Promise<FunnelResult> {
  const store = await openAnalyticsStore(where);
  try {
    return await runFunnel(store, funnel, {
      fromMs: +window.from,
      toMs: +window.to,
      ...(window.tenantId ? { tenantId: window.tenantId } : {}),
    });
  } finally {
    await store.close();
  }
}
/**
 * Events older than `before` that every sink has already been given; returns how many.
 *
 * @preview Analytics is a Preview feature (docs/status.md).
 */
export async function pruneAnalyticsEvents(where: AnalyticsLocation, request: Readonly<{ before: number | Date }>): Promise<number> {
  return pruneStoredAnalyticsEvents(where.url, { binding: where.binding, before: request.before });
}
export type { AnalyticsFunnel, FunnelResult };
