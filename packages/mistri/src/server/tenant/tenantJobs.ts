/**
 * Durable jobs on a tenant App: `--jobs` beside `--policy`. A job starts on a
 * tenant command's event — any tenant's: its destination's route is
 * `{ scope: 'tenants' }` — or at times, once per active tenant
 * (`realm: 'tenant'`, each run carrying its tenant) or once on the platform
 * (`realm: 'platform'`, carrying none), and runs one command as a service principal
 * (tenantServiceModel.ts), through the same executor, journal and audit as
 * every command, in one fenced writer transaction per attempt.
 *
 * Who it acts as is its command's realm. A tenant command runs as the service
 * in the tenant whose event started the job; a platform command as the
 * platform's service. The event's tenant bounds both: the transaction's scope
 * holds that tenant's rows and, in the platform realm, the platform's own, so
 * a key naming another tenant's row finds nothing. The platform's own time
 * job has no tenant, and its scope holds no tenant's row at all. Neither has a membership:
 * revoking the member whose command emitted the event does not stop the job,
 * and suspending the tenant (for a tenant command) or the platform does.
 *
 * Every attempt asks again. The job host's authorizer grants it only while the
 * job is registered at its version and the App grants the principal's roles
 * the command; then `admit` reads the event's tenant's row and `@platform`,
 * refuses unless the anchors this command fences are active, and keeps the
 * versions it read. Those are the attempt's evidence, and the writer fences
 * exactly those versions to COMMIT: anything that moved in between refuses
 * the attempt with nothing applied, and the next one asks again.
 */
import { isProxy } from 'node:util/types';
import type { FlagRequestLifetime } from '../flags/requestRuntime.js';
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { flowKindCommands } from '../../shared/appFlows.js';
import { CommandTransactionFailure } from '../../adapters/commands/commandJournal.js';
import { appCommandGrants, declaredReferences, physicalBindings, resolveAppAccess, tenantAppShape, type AppDef } from '../../shared/app.js';
import { calendarDay, zonelessInstant } from '../../shared/appStamps.js';
import { appZone } from '../../shared/appZone.js';
import { wallClockText } from '../app/wallClock.js';
import { assertScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import { AppAccessDenied, type ResourceAccess } from '../app/appAccess.js';
import { appResourceCatalog } from '../app/appResources.js';
import { compileAppDefinitionValidation } from '../app/appValidation.js';
import type { StoreTarget } from '../commands/appCommandEvents.js';
import type { AuthorizedBusinessCommand, BusinessCommandBinding } from '../commands/businessCommandAccess.js';
import { createBusinessCommandAuthorizer } from '../commands/businessCommandAuthorization.js';
import { defineCommands, getCommandEvents, type BusinessCommandActor, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { CommandResultReference } from '../commands/scopedBusinessCommandAccess.js';
import { serviceActor } from '../jobs/jobAuthorization.js';
import type { JobCommandBinding } from '../jobs/jobCommands.js';
import { openJobHost, type BuiltInJob, type JobHost } from '../jobs/jobHost.js';
import { jobDeployment, jobGrantProblems, machineTimers, type JobDeployment } from '../jobs/jobLoader.js';
import {
  capturedJobModule,
  JobDeclarationError,
  pinJobs,
  runsJobs,
  saidTimer,
  withMachineTimers,
  type CapturedJob,
  type CapturedJobModule,
  type CapturedMail,
  type JobModule,
  type MachineTimer,
} from '../jobs/jobModule.js';
import { isWorkflowJob, WORKFLOW_JOB_VERSION, workflowJobId } from '../workflows/workflowKeys.js';
import { flowRunnersOf, tenantFlowChangeReader } from '../workflows/flowChanges.js';
import { flowCommandId, flowCommandProblems, withFlowCommands } from '../workflows/flowCommand.js';
import { flowCommandOf } from '../commands/flowCommandBrand.js';
import { integrationEventCommands } from '../integrations/integrationDeclaration.js';
import { integrationCommandProblems, integrationNotifyProblems, integrationRoleProblems } from '../integrations/integrationChecks.js';
import type { JobAuthorizationRequest } from '../jobs/jobRunner.js';
import type { JobContext } from '../jobs/jobs.js';
import { runTenantCommandTransaction, type TenantCommandRecords } from './tenantCommandTransaction.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantOptions } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector } from './tenantMembership.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import { captureTenantReadSource, type TenantReadSource } from './tenantReadSource.js';
import { DUE_TIMER_PAGE, type DueTimer } from './tenantDueTimers.js';
import { sandboxSkew } from './tenantSandboxClock.js';
import { captureServiceEvidence, type TenantServiceEvidence } from './tenantServiceModel.js';
import type { CommandFlags } from '../commands/commandFlags.js';
import { commandFlagsOnce } from '../commands/commandFlagCapture.js';
import { assertTenantSourcePair } from './tenantSourceIdentity.js';
import { binding as storeBinding, type TenantStoreBinding } from './tenantStoreContract.js';
import { tenantVisibleFields } from './tenantVisibleFields.js';
import { captureTenantWriteSource, TenantWriteFailure, type TenantWriteSource } from './tenantWriteSource.js';

const refuse = (message: string): never => {
  throw new JobDeclarationError(`Jobs: ${message}`);
};
const deny = (): never => {
  throw new AppAccessDenied();
};
const noReferences = (): readonly CommandResultReference[] => [];
const ownerFields = (owned: TenantOwnershipSnapshot): Record<string, string> =>
  Object.fromEntries(Object.entries(owned.ownership).flatMap(([id, rule]) => (rule.kind === 'tenant' ? [[id, rule.column]] : [])));

/** The deployment a module implies on a tenant App: jobDeployment's, over the
 * tenant event store (bound as the tenant store is) with every tenant's route.
 * Pure: no database is opened, so provisioning and startup derive it alike. */
export function tenantJobDeployment(
  module: CapturedJobModule,
  options: Readonly<{ binding: TenantStoreBinding; commands: BusinessCommandRegistry }>,
): JobDeployment {
  let owner: TenantStoreBinding;
  try {
    owner = storeBinding(options.binding);
  } catch {
    return refuse('the tenant store binding is invalid.');
  }
  const deployment = jobDeployment(module, {
    appId: owner.appId,
    commands: options.commands,
    events: { scope: 'tenants', store: (sourceId) => ({ appId: owner.appId, storeId: owner.storeId, sourceId }) },
  });
  if (deployment.sourceId !== owner.source.id) {
    refuse(
      `every job's command must be on the tenant App's source "${owner.source.id}", which holds the stores; they are on "${deployment.sourceId}".`,
    );
  }
  for (const job of module.jobs.values()) {
    const runs = options.commands[job.command.id];
    /* A job at times acts for each tenant in turn, or for the platform alone:
       it says which, and its command is of that realm. Never for no one. */
    if (job.every) {
      const realm = runs.realm === 'platform' ? 'platform' : 'tenant';
      if (!job.realm) {
        refuse(
          `job "${job.id}" runs every "${job.every.text}" and says no realm. On a tenant App a job at times runs once per active tenant ` +
            `(realm: 'tenant', a tenant command) or once on the platform (realm: 'platform', a platform command), and never for no one.`,
        );
      }
      if (job.realm !== realm) {
        refuse(
          `job "${job.id}" says realm: '${job.realm}', and runs ${realm} command "${job.command.id}": a job per tenant runs a tenant command, and one on the platform a platform command.`,
        );
      }
    }
    /* The service's binding is no tenant event owner, and it reads no
       lookup source: a job's command does neither here. Chaining jobs and
       looking up stay refused rather than half-supported. */
    if (getCommandEvents(runs))
      refuse(`job "${job.id}" runs command "${job.command.id}", which declares events: a tenant App's job records none of its own.`);
    if (typeof runs.lookup === 'function' || runs.sources !== undefined) {
      refuse(`job "${job.id}" runs command "${job.command.id}", which looks up: a tenant App's job runs no lookup.`);
    }
  }
  for (const { what, id, record } of mailCommands(module)) {
    const runs = Object.hasOwn(options.commands, id) ? options.commands[id] : undefined;
    if (!runs) refuse(`mail ${what} runs command "${id}", which the commands module does not register.`);
    /* Mail arrives for one tenant and leaves from one: its commands are that tenant's, run as its service. */
    if (runs!.realm === 'platform')
      refuse(`mail ${what} runs platform command "${id}"; mail is one tenant's, so it runs a tenant command.`);
    if (runs!.public) refuse(`mail ${what} runs command "${id}", which is public: only its public form runs it.`);
    if (getCommandEvents(runs!))
      refuse(`mail ${what} runs command "${id}", which declares events: a tenant App's service records none of its own.`);
    if (typeof runs!.lookup === 'function' || runs!.sources !== undefined)
      refuse(`mail ${what} runs command "${id}", which looks up: a tenant App's service runs no lookup.`);
    if (runs!.source !== owner.source.id)
      refuse(`mail ${what} runs command "${id}", which is not on the tenant App's source "${owner.source.id}".`);
    if (record ? runs!.targets === 'none' : runs!.targets !== 'none')
      refuse(
        record
          ? `mail ${what} runs command "${id}", which names no record; a signed link opens one record, so its command targets it.`
          : `mail ${what} runs command "${id}", which names a record; it runs with targets: 'none' and finds its rows itself.`,
      );
  }
  const [integrationProblem] = integrationCommandProblems(module.integrations, options.commands);
  if (integrationProblem) refuse(integrationProblem);
  for (const { command } of integrationEventCommands(module.integrations))
    if (options.commands[command].source !== owner.source.id)
      refuse(`integrations.webhooks runs command "${command}", which is not on the tenant App's source "${owner.source.id}".`);
  // A link's reply box answers the record the link opened, in the words a requester types: one text `body`.
  const reply = module.mail?.links?.reply;
  if (reply) {
    const opens = options.commands[module.mail!.links!.command.id],
      answers = options.commands[reply.id];
    if (answers.target !== opens.target)
      refuse(`mail links.reply runs command "${reply.id}", which targets "${answers.target}"; the link opens a "${opens.target}" record.`);
    const body = (answers.input as Record<string, { type?: string }> | undefined)?.body;
    if (body?.type !== 'text' && body?.type !== 'textarea')
      refuse(`mail links.reply runs command "${reply.id}", which takes no text "body": its reply box sends one.`);
  }
  return deployment;
}

/**
 * The module with the App's machine timers as jobs of its own (jobModule.ts
 * withMachineTimers), as a tenant App runs them: each as the first principal
 * granted its command whose every role is of that command's realm — tenant
 * roles for a tenant command, platform roles for a platform one. Startup,
 * enrollment and provisioning wrap the module alike, so each derives the same
 * deployment. A timer granted only to principals of the other realm is
 * refused by name rather than run as the wrong one.
 */
export function withTenantMachineTimers(
  module: JobModule | CapturedJobModule,
  app: AppDef,
  registry: BusinessCommandRegistry,
): CapturedJobModule {
  const captured = capturedJobModule(module);
  const timers = machineTimers(app);
  if (!timers.length) return captured;
  const roles = app.auth?.roles ?? {};
  const platform = (command: string) => Object.hasOwn(registry, command) && registry[command].realm === 'platform';
  const ofRealm = (held: readonly string[], command: string) =>
    held.every((role) => Object.hasOwn(roles, role) && (roles[role].realm === 'platform') === platform(command));
  for (const timer of timers) {
    const granted = [...captured.principals].filter(([, held]) => appCommandGrants(app, held).has(timer.command));
    if (granted.length && !granted.some(([, held]) => ofRealm(held, timer.command))) {
      const realm = platform(timer.command) ? 'platform' : 'tenant';
      refuse(
        `${saidTimer(timer, timer.command)}, a ${realm} command, ` +
          `and every principal granted it (${granted.map(([name]) => `"${name}"`).join(', ')}) holds a role of the other realm: ` +
          `a ${realm} command's timer runs as a principal whose every role is a ${realm}-realm role.`,
      );
    }
  }
  return withMachineTimers(captured, timers, (held, command) => appCommandGrants(app, held).has(command) && ofRealm(held, command));
}

/**
 * Where a tenant App's machine timers run. On a tenant-owned resource, in the
 * tenant its row's owner names: a tenant command as that tenant's service, or
 * a platform command reaching the row by key, as an event's job does. On a
 * platform-owned resource, a platform command with no tenant. A global table
 * is every tenant's and no one's, so nothing on it runs by itself.
 */
function timerProblems(module: CapturedJobModule, registry: BusinessCommandRegistry, owned: TenantOwnershipSnapshot): string[] {
  const problems: string[] = [];
  for (const job of module.jobs.values()) {
    const timer = job.timer;
    if (!timer) continue;
    const runs = saidTimer(timer, job.command.id);
    const rule = Object.hasOwn(owned.ownership, timer.resource) ? owned.ownership[timer.resource] : undefined;
    const command = Object.hasOwn(registry, job.command.id) ? registry[job.command.id] : undefined;
    if (!rule)
      problems.push(`${runs}, and the policy's ownership names no "${timer.resource}": a timer runs in the tenant that owns its row.`);
    else if (rule.kind === 'global')
      problems.push(
        `${runs}, and "${timer.resource}" is a global table: its rows are every tenant's and no one's, so no timer runs on them. ` +
          `Own it by tenant or by the platform in the policy, or drop the timer.`,
      );
    else if (rule.kind === 'platform' && command?.realm !== 'platform')
      problems.push(
        `${runs}, a tenant command, and "${timer.resource}" is platform-owned: its rows are in no tenant, so a timer on them runs a platform command (realm: 'platform').`,
      );
    if (command && command.target !== timer.resource)
      problems.push(
        `${runs}, which targets "${command.target}": a timer's command acts on the record that waited, so it targets "${timer.resource}".`,
      );
  }
  return problems;
}

/** Each command a module's mail runs: what runs it, and whether it acts on one record. */
function mailCommands(module: CapturedJobModule): Array<{ what: string; id: string; record: boolean; runAs: string }> {
  const mail = module.mail;
  if (!mail) return [];
  return [
    ...(mail.receive ? [{ what: 'receive', id: mail.receive.command.id, record: false, runAs: mail.receive.runAs }] : []),
    ...(mail.send
      ? [
          { what: 'send.claim', id: mail.send.claim.id, record: false, runAs: mail.send.runAs },
          { what: 'send.record', id: mail.send.record.id, record: false, runAs: mail.send.runAs },
        ]
      : []),
    ...(mail.links ? [{ what: 'links', id: mail.links.command.id, record: true, runAs: mail.links.runAs }] : []),
    ...(mail.links?.reply ? [{ what: 'links.reply', id: mail.links.reply.id, record: true, runAs: mail.links.runAs }] : []),
  ];
}

/** Why the App cannot run each job as its service principal: jobGrantProblems'
 * grants, and every role in its command's realm — tenant roles for a tenant
 * command, platform roles for a platform one, never a union of the two. */
function tenantJobProblems(module: CapturedJobModule, app: AppDef, registry: BusinessCommandRegistry): string[] {
  const problems = jobGrantProblems(module, app),
    roles = app.auth?.roles ?? {};
  for (const job of module.jobs.values()) {
    const platform = registry[job.command.id]?.realm === 'platform',
      realm = platform ? 'platform' : 'tenant';
    // A job's tenant is its event's or its time's, never one its input names.
    if (registry[job.command.id]?.tenant !== undefined)
      problems.push(
        `job "${job.id}" runs command "${job.command.id}", which acts in the tenant its input names (tenant); a job runs where its event or its time puts it.`,
      );
    if (module.principals.get(job.runAs)!.some((role) => !Object.hasOwn(roles, role) || (roles[role].realm === 'platform') !== platform)) {
      problems.push(
        `principal "${job.runAs}" runs ${realm} command "${job.command.id}", so every role it holds must be a ${realm}-realm role.`,
      );
    }
  }
  // Mail is one tenant's, always: its principals hold tenant roles alone.
  for (const { what, runAs } of mailCommands(module)) {
    if (module.principals.get(runAs)!.some((role) => !Object.hasOwn(roles, role) || roles[role].realm === 'platform')) {
      problems.push(`principal "${runAs}" runs mail ${what}, which is one tenant's, so every role it holds must be a tenant-realm role.`);
    }
  }
  // A webhook arrives for one tenant: its principal holds tenant service roles alone, granted what it runs.
  problems.push(...integrationRoleProblems(module.integrations, module.principals, app));
  problems.push(...integrationNotifyProblems(module.integrations, app));
  for (const { runAs, integration } of integrationEventCommands(module.integrations)) {
    if (module.principals.get(runAs)!.some((role) => !Object.hasOwn(roles, role) || roles[role].realm === 'platform'))
      problems.push(
        `principal "${runAs}" runs integrations.webhooks "${integration}", which is one tenant's, so every role it holds must be a tenant-realm role.`,
      );
  }
  const attachments = module.mail?.receive?.attachments;
  if (attachments !== undefined) {
    const command = registry[module.mail!.receive!.command.id];
    if (!app.resources?.[attachments]?.file)
      problems.push(`mail receive.attachments names "${attachments}", which is not a file resource of App "${app.id}".`);
    else if (!command?.write?.includes(attachments))
      problems.push(
        `mail receive.attachments names "${attachments}", and command "${module.mail!.receive!.command.id}" does not write it.`,
      );
  }
  // A workflow is one tenant's, always: its steps run tenant commands within that tenant.
  for (const workflow of module.workflows.values()) {
    if (module.principals.get(workflow.runAs)!.some((role) => !Object.hasOwn(roles, role) || roles[role].realm === 'platform')) {
      problems.push(
        `principal "${workflow.runAs}" runs workflow "${workflow.name}", whose instances are each one tenant's, so every role it holds must be a tenant-realm role.`,
      );
    }
  }
  return problems;
}

/** The load-time checks over the App and its attested ownership: the grants
 * and realms, then each command authorized once as its principal. */
export function assertTenantJobs(
  module: CapturedJobModule,
  app: AppDef,
  registry: BusinessCommandRegistry,
  owned: TenantOwnershipSnapshot,
  connection: string,
): void {
  const [problem] = [...tenantJobProblems(module, app, registry), ...timerProblems(module, registry, owned)];
  if (problem) refuse(problem);
  const authorizer = createBusinessCommandAuthorizer({
    app,
    registry,
    schema: owned.schema,
    connectionFor: (resource) => (Object.hasOwn(owned.resources, resource) ? connection : ''),
    writableConnection: (candidate) => candidate === connection,
    transactionalConnection: (candidate) => candidate === connection,
    managedOwnership: ownerFields(owned),
  });
  for (const job of module.jobs.values()) {
    try {
      authorizer.authorize(job.command.id, serviceActor(app.id, job.runAs, module.principals.get(job.runAs)!));
    } catch {
      refuse(`principal "${job.runAs}" cannot run command "${job.command.id}": its roles must read the command's whole footprint.`);
    }
  }
  for (const { what, id, runAs } of mailCommands(module)) {
    try {
      authorizer.authorize(id, serviceActor(app.id, runAs, module.principals.get(runAs)!));
    } catch {
      refuse(`principal "${runAs}" cannot run mail ${what} command "${id}": its roles must read the command's whole footprint.`);
    }
  }
  for (const { integration, event, command, runAs } of integrationEventCommands(module.integrations)) {
    try {
      authorizer.authorize(command, serviceActor(app.id, runAs, module.principals.get(runAs)!));
    } catch {
      refuse(
        `principal "${runAs}" cannot run command "${command}" for integrations.webhooks "${integration}" event "${event}": its roles must read the command's whole footprint.`,
      );
    }
  }
  assertTenantFlows(module, app, registry, owned, connection);
}

/**
 * A tenant App's flows runners (workflows/flowRunner.ts), judged at startup
 * and again at enrollment rather than on the day a run reaches a step. A
 * run is one tenant's: its change's stored key names the owner, and every
 * read and write it makes is scoped to that tenant. That holds only when the
 * record and both tables of rows are tenant-owned — a flow table shared by
 * every tenant would be one tenant's administrator editing another's
 * process, and a record without an owner names no tenant to run in. Each
 * step kind's command is held to what a tenant workflow's step may run
 * (bindTenantJobs stepExtract), and authorized once as the runner's principal.
 */
function assertTenantFlows(
  module: CapturedJobModule,
  app: AppDef,
  registry: BusinessCommandRegistry,
  owned: TenantOwnershipSnapshot,
  connection: string,
): void {
  const runners = flowRunnersOf(module.workflows);
  if (!runners.length) return;
  const [problem] = flowCommandProblems(app, owned.schema, registry, runners);
  if (problem) refuse(problem);
  for (const runner of runners) {
    const at = `workflow "${runner.workflow}"`;
    const binding = app.resources![runner.resource].flows!;
    for (const name of [runner.resource, binding.from, binding.steps])
      if (owned.ownership[name]?.kind !== 'tenant')
        refuse(
          `${at}: the flows of "${runner.resource}" run in each tenant, so "${name}" must be tenant-owned (ownership kind 'tenant') in the policy.`,
        );
    for (const { kind: name, command: id } of flowKindCommands(binding)) {
      const command = registry[id];
      if (command.realm === 'platform')
        refuse(`${at}: step kind "${name}" runs platform command "${id}"; a flow is one tenant's, so it runs a tenant command.`);
      if (command.public === true)
        refuse(`${at}: step kind "${name}" runs command "${id}", which is public: only its public form runs it.`);
      if (getCommandEvents(command))
        refuse(`${at}: step kind "${name}" runs command "${id}", which declares events: a tenant App's service records none of its own.`);
      if (typeof command.lookup === 'function' || command.sources !== undefined)
        refuse(`${at}: step kind "${name}" runs command "${id}", which looks up: a tenant App's service runs no lookup.`);
    }
  }
  const commands = withFlowCommands(app, owned.schema, registry, runners);
  const authorizer = createBusinessCommandAuthorizer({
    app,
    registry: commands,
    schema: owned.schema,
    connectionFor: (resource) => (Object.hasOwn(owned.resources, resource) ? connection : ''),
    writableConnection: (candidate) => candidate === connection,
    transactionalConnection: (candidate) => candidate === connection,
    managedOwnership: ownerFields(owned),
  });
  for (const runner of runners) {
    const roles = module.principals.get(runner.runAs)!;
    const binding = app.resources![runner.resource].flows!;
    try {
      authorizer.authorize(flowCommandId(runner.resource), serviceActor(app.id, runner.runAs, roles));
    } catch {
      refuse(
        `principal "${runner.runAs}" (roles ${roles.join(', ')}) must read "${runner.resource}", "${binding.from}" and "${binding.steps}" to run their flows.`,
      );
    }
    for (const { kind: name, command } of flowKindCommands(binding))
      try {
        authorizer.authorize(command, serviceActor(app.id, runner.runAs, roles));
      } catch {
        refuse(
          `principal "${runner.runAs}" cannot run command "${command}" for step kind "${name}": it must be granted the command and read its whole footprint.`,
        );
      }
  }
}

interface TenantJobsOptions {
  readonly captureFlags?: (
    principal: TenantServiceEvidence,
    lifetime: FlagRequestLifetime,
  ) => CommandFlags | undefined | Promise<CommandFlags | undefined>;
  readonly app: AppDef;
  readonly reader: TenantReadSource;
  readonly writer: TenantWriteSource;
  readonly deployment: string;
  readonly registry: BusinessCommandRegistry;
  readonly resultReferences: Readonly<Record<string, (result: unknown) => readonly CommandResultReference[]>>;
  readonly module: CapturedJobModule;
  /** Where the stores live: the tenant source's own file or database. */
  readonly target: StoreTarget;
  /** A direct PostgreSQL URL for the jobs host's `LISTEN` when `target` goes through a transaction-mode pooler. */
  readonly listen?: string;
  /** The deployment's clock, which its writer checks every evidence against. */
  readonly now: () => number;
}
type Anchors = Readonly<{ tenantVersion: string | null; platformVersion: string }>;
/** Attempts admitted and not yet run: at most the runner's claims, whose ceiling is one. */
const ADMITTED = 16;

/**
 * The jobs runtime over a tenant deployment's genuine sources: the host's
 * `admit`, the per-attempt command binding, and retirement. Bound by
 * enrollment once its sources are acquired; opened as a host by
 * openTenantJobHost. Nothing runs until a host claims a job.
 */
export function bindTenantJobs(options: TenantJobsOptions) {
  const raw = tenantOptions(options, [
    'app',
    'reader',
    'writer',
    'deployment',
    'registry',
    'resultReferences',
    'module',
    'target',
    'now',
    'captureFlags',
    'listen',
  ]);
  if (raw.captureFlags !== undefined && (typeof raw.captureFlags !== 'function' || isProxy(raw.captureFlags))) return denyTenant();
  const captureFlags = raw.captureFlags as TenantJobsOptions['captureFlags'];
  const reader = captureTenantReadSource(raw.reader as TenantReadSource),
    writer = captureTenantWriteSource(raw.writer as TenantWriteSource);
  const identity = assertTenantSourcePair(reader, writer),
    ownership = writer.ownership;
  const app = captureTenantData(raw.app as AppDef);
  if (!app || !tenantAppShape(app, ownership)) return denyTenant();
  const catalog = appResourceCatalog(
    ownership.physicalSchema,
    physicalBindings(app, ownership.source.id),
    declaredReferences(app, ownership.source.id),
  );
  assertScopeCatalog(ownership.schema, catalog.schema);
  const deploymentId = raw.deployment as string;
  tenantIdentifier(deploymentId);
  if (typeof raw.now !== 'function' || isProxy(raw.now)) return denyTenant();
  const now = raw.now as () => number;
  if (!raw.registry || typeof raw.registry !== 'object' || isProxy(raw.registry)) return denyTenant();
  const registry = defineCommands(
    tenantOptions(raw.registry, Object.keys(Object.getOwnPropertyDescriptors(raw.registry))) as BusinessCommandRegistry,
  );
  const module = pinJobs(capturedJobModule(raw.module), registry);
  if (module.inbound.size) refuse('inbound endpoints are not served on a tenant App: a delivery has no tenant to act for.');
  // Derived again, never taken from a caller: the deployment enrollment attested.
  const deployment = tenantJobDeployment(module, {
    binding: { appId: app.id, storeId: identity.storeId, source: identity.source },
    commands: registry,
  });
  assertTenantJobs(module, app, registry, ownership, identity.source.connection);
  /* A flows runner's reads and `set` steps are the platform's own command
     beside the App's (workflows/flowCommand.ts), granted to its runner alone. */
  const runners = flowRunnersOf(module.workflows);
  const commands = withFlowCommands(app, ownership.schema, registry, runners);
  const target = captureTenantData(raw.target) as StoreTarget;
  if (
    !target ||
    typeof target !== 'object' ||
    Object.keys(target).length !== 1 ||
    !('sqlite' in target
      ? typeof target.sqlite === 'string' && target.sqlite.length
      : 'postgres' in target && typeof target.postgres === 'string' && /^postgres(ql)?:\/\//i.test(target.postgres))
  )
    return denyTenant();
  const listen = raw.listen;
  if (listen !== undefined && (typeof listen !== 'string' || !('postgres' in target) || !/^postgres(ql)?:\/\//i.test(listen)))
    return denyTenant();
  const authorizer = createBusinessCommandAuthorizer({
    app,
    registry: commands,
    schema: ownership.schema,
    connectionFor: (resource) => (Object.hasOwn(ownership.resources, resource) ? identity.source.connection : deny()),
    writableConnection: (connection) => connection === identity.source.connection,
    transactionalConnection: (connection) => connection === identity.source.connection,
    managedOwnership: ownerFields(ownership),
  });
  const validation = compileAppDefinitionValidation(ownership.schema, app);
  const declarations = tenantOptions(raw.resultReferences, Object.keys(registry));
  // Each job's place, principal and visible fields, fixed for the deployment's life.
  const places = new Map<
    string,
    Readonly<{
      place: 'tenant' | 'platform';
      roles: readonly string[];
      grants: ResourceAccess;
      extract: (result: unknown) => readonly CommandResultReference[];
    }>
  >();
  for (const job of module.jobs.values()) {
    const place = registry[job.command.id].realm === 'platform' ? ('platform' as const) : ('tenant' as const);
    const roles = module.principals.get(job.runAs)!,
      extract = declarations[job.command.id];
    if (typeof extract !== 'function' || isProxy(extract)) return denyTenant();
    const access = resolveAppAccess(app, ownership.schema, [...roles]);
    // A platform service reads a tenant row's owner, as the platform realm does, and writes nothing generically.
    const visible: ResourceAccess =
      place === 'platform' ? tenantVisibleFields(ownership, { ...access, writable: new Set() }, 'platform') : access;
    places.set(
      job.id,
      Object.freeze({
        place,
        roles,
        grants: validation ? { ...visible, validation } : visible,
        extract: extract as (result: unknown) => readonly CommandResultReference[],
      }),
    );
  }
  /* A workflow's: always one tenant's, its principal's tenant roles and
     their visible fields. Its steps' commands are found as they run. */
  const flows = new Map<string, Readonly<{ roles: readonly string[]; grants: ResourceAccess; resource?: string }>>();
  for (const workflow of module.workflows.values()) {
    const roles = module.principals.get(workflow.runAs)!,
      access = resolveAppAccess(app, ownership.schema, [...roles]);
    flows.set(
      workflowJobId(workflow.name),
      Object.freeze({
        roles,
        grants: validation ? { ...access, validation } : access,
        ...(workflow.flows ? { resource: workflow.flows.resource } : {}),
      }),
    );
  }
  /** A step's command, as a workflow's principal may run it here: a tenant
   * command, never public, that records no event and looks nothing up (the
   * service's binding is no event owner and reads no lookup source), and that
   * the policy says how to read the result of. Anything else is refused.
   * A flows runner's own command is its runner's alone, and its result (the
   * plan, a condition's answer) names no record. */
  const stepExtract = (id: string, flowsOf?: string): ((result: unknown) => readonly CommandResultReference[]) => {
    const command = Object.hasOwn(commands, id) ? commands[id] : undefined,
      extract = Object.hasOwn(declarations, id) ? declarations[id] : undefined;
    const own = command && flowCommandOf(command);
    if (own) return own.resource === flowsOf ? noReferences : deny();
    if (
      !command ||
      command.realm === 'platform' ||
      command.public === true ||
      getCommandEvents(command) ||
      typeof command.lookup === 'function' ||
      command.sources !== undefined ||
      typeof extract !== 'function' ||
      isProxy(extract)
    )
      return deny();
    return extract as (result: unknown) => readonly CommandResultReference[];
  };
  const lifetimeMs = Math.min(deployment.attemptTimeoutMs, 300_000);
  let retired = false;
  const pending = new Set<Promise<void>>();
  /* The anchors' versions each admitted attempt started under, until its
     handler takes them: what the writer then fences. */
  const admitted = new Map<string, Anchors>();
  const attemptKey = (jobId: string, attempt: number) => `${jobId}\n${attempt}`;
  /** The tenant an attempt acts for: the one its job carries, always — save
   * the platform's own time job, which carries none and reaches no tenant.
   * Anything else is not authorized. */
  const tenantOf = (
    job: Pick<CapturedJob, 'every' | 'realm' | 'timer'> | undefined,
    provenance: Readonly<{ tenantId?: string }>,
  ): string | null => {
    if (job?.every && job.realm === 'platform') return provenance.tenantId === undefined ? null : denyTenant();
    /* A machine timer's tenant is its row's, as the sweep read it: a
       platform-owned row is in none, and a run naming one is not this timer's. */
    if (job?.timer) {
      const kind = Object.hasOwn(ownership.ownership, job.timer.resource) ? ownership.ownership[job.timer.resource].kind : undefined;
      if (kind === 'platform') return provenance.tenantId === undefined ? null : denyTenant();
      if (kind !== 'tenant') return denyTenant();
    }
    return parseTenantSelector([provenance.tenantId ?? '']);
  };

  /* The App's machine timers: a page of each one's due records a minute,
     read across the active tenants by the server (tenantDueTimers.ts), each
     run in the tenant its row's owner names and admitted again there. Each
     timer keeps its own page: a round of every tenant's bands, and the
     offset into a round that filled a page. */
  const pages = new Map<string, Readonly<{ round: number; offset: number }>>();
  // Only an App that marks resources clone has sandboxes, so only its sweep asks which run ahead.
  const cloning = Object.values(app.resources ?? {}).some((resource) => resource.clone);
  const sweep = async (timer: MachineTimer, cutoff: Date): Promise<readonly DueTimer[]> => {
    if (retired) return [];
    const table = ownership.schema.tables.find((candidate) => candidate.id === timer.resource);
    const since = table?.columns.find((column) => column.name === timer.since);
    if (!table || !since) return [];
    /* `since` was stamped on the App's wall clock (appStamps.ts), so the
       cutoff is read on it too; a zoned one holds the instant, said in UTC. */
    const day = calendarDay(since.type);
    const zone = day || zonelessInstant(since.type) ? appZone(app.ui) : undefined;
    const zoned = ownership.schema.dialect === 'postgres' && /with time zone|timestamptz/i.test(since.type);
    const said = (at: Date) => {
      const text = day ? wallClockText(at, zone).slice(0, 10) : wallClockText(new Date(Math.floor(at.getTime() / 1000) * 1000), zone);
      return zoned ? `${text}Z` : text;
    };
    const key = `${timer.resource}\0${timer.state ?? timer.when ?? ''}\0${timer.since}\0${timer.ms}`;
    const page = pages.get(key) ?? { round: 0, offset: 0 };
    /* An `after` timer waits in a machine state; an `at` timer, in what its `when` says (tenantDueTimers.ts). */
    const stayed =
      timer.column !== undefined ? { column: timer.column, state: timer.state } : timer.when !== undefined ? { when: timer.when } : {};
    const due = await reader.readDueTimers({
      resource: timer.resource,
      ...stayed,
      since: timer.since,
      cutoff: said(cutoff),
      round: page.round,
      offset: page.offset,
    });
    pages.set(
      key,
      due.length < DUE_TIMER_PAGE
        ? { round: (page.round + 1) % 2 ** 31, offset: 0 }
        : { round: page.round, offset: page.offset + DUE_TIMER_PAGE },
    );
    if (!cloning || ownership.ownership[timer.resource]?.kind !== 'tenant') return due;
    /* A sandbox running ahead (tenantSandboxClock.ts) reads its own rows at
       its own cutoff: a page of them each sweep, restricted to that one
       tenant by the server. A live tenant has no clock to read, so its
       records fall due on real time whatever any sandbox is set to. */
    const clocks = await reader.readSandboxClocks();
    if (!clocks.length) return due;
    const seen = new Set(due.map((row) => `${row.tenantId}\0${JSON.stringify(row.key)}`));
    const ahead = [...due];
    for (const sandbox of clocks) {
      if (retired) break;
      const skew = sandboxSkew(sandbox.clock, cutoff.getTime() + timer.ms);
      if (skew <= 0) continue;
      const more = await reader.readDueTimers({
        resource: timer.resource,
        ...stayed,
        since: timer.since,
        cutoff: said(new Date(cutoff.getTime() + skew)),
        round: 0,
        offset: 0,
        tenant: sandbox.tenantId,
      });
      for (const row of more) {
        const id = `${row.tenantId}\0${JSON.stringify(row.key)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        ahead.push(row);
      }
    }
    return ahead;
  };

  /** After the host's grants: the event's tenant is a tenant, and the anchors
   * this job's command fences are active now. Their versions are kept for the
   * attempt; anything else, including a read that fails, is not authorized. */
  const admit = async (request: JobAuthorizationRequest): Promise<boolean> => {
    for (const key of admitted.keys()) if (key.startsWith(`${request.jobId}\n`)) admitted.delete(key);
    // A workflow's advance is always one tenant's: its wake-up carries the tenant, as an event's job does.
    const flow = flows.get(request.job),
      job = flow ? undefined : module.jobs.get(request.job),
      at = job ? places.get(job.id) : flow && { place: 'tenant' as const };
    if (retired || !at || (job ? job.version !== request.version : request.version !== WORKFLOW_JOB_VERSION)) return false;
    let tenantId: string | null;
    try {
      tenantId = tenantOf(job, request.provenance);
    } catch {
      return false;
    }
    const anchors = captureTenantData(await reader.readServiceAnchors(tenantId));
    if (retired || anchors.platformVersion === null || (at.place === 'tenant' && anchors.tenantVersion === null)) return false;
    while (admitted.size >= ADMITTED) admitted.delete(admitted.keys().next().value!);
    admitted.set(
      attemptKey(request.jobId, request.attempt),
      Object.freeze({
        tenantVersion: at.place === 'tenant' ? anchors.tenantVersion : null,
        platformVersion: anchors.platformVersion,
      }),
    );
    return true;
  };

  /** One attempt's binding: the evidence of what its admission read, and the
   * one command the job runs, as its principal, in the writer's fenced
   * transaction. The runner's handler brings the actor; only this job's is taken. */
  const bind = async (context: JobContext, job: CapturedJob): Promise<JobCommandBinding> => {
    const key = attemptKey(context.jobId, context.attempt),
      anchors = admitted.get(key);
    /* A workflow's advance binds once per step, all under the one admission:
       each step's writer fences the same anchor versions again to COMMIT. */
    const flow = isWorkflowJob(job.id) ? flows.get(job.id) : undefined;
    const at = flow ? { place: 'tenant' as const, roles: flow.roles, grants: flow.grants, extract: undefined } : places.get(job.id);
    if (!flow) admitted.delete(key);
    // A lost admission is not a refusal of the job: the next attempt asks again.
    if (retired || !anchors || !at || (!flow && module.jobs.get(job.id) !== job) || (flow && context.job !== job.id))
      throw new Error('The job attempt was not admitted.');
    return bindService({
      runAs: job.runAs,
      place: at.place,
      roles: at.roles,
      grants: at.grants,
      tenantId: tenantOf(flow ? undefined : job, context.provenance),
      anchors,
      aborted: () => context.signal.aborted,
      // A job runs its one command; a workflow's step, any of its principal's tenant commands this binding can run.
      extract: (id) => (flow ? stepExtract(id, flow.resource) : id === job.command.id ? at.extract! : deny()),
    });
  };

  /** A service's binding over anchors read for one tenant (or the platform): the evidence, the
   * fenced writer transaction, and the commands `extract` admits. What bind and deliver share. */
  const bindService = (options: {
    runAs: string;
    place: 'tenant' | 'platform';
    roles: readonly string[];
    grants: ResourceAccess;
    tenantId: string | null;
    anchors: Anchors;
    aborted: () => boolean;
    extract: (id: string) => (result: unknown) => readonly CommandResultReference[];
  }): JobCommandBinding => {
    const { runAs, place, roles, grants, tenantId, anchors } = options;
    const verifiedAt = now();
    const evidence = captureServiceEvidence(
      {
        realm: 'service',
        appId: app.id,
        source: identity.source,
        deployment: deploymentId,
        principal: runAs,
        place,
        tenantId,
        tenantVersion: anchors.tenantVersion,
        platformVersion: anchors.platformVersion,
        roles: [...roles],
        verifiedAt,
        validUntil: verifiedAt + lifetimeMs,
      },
      ownership,
    );
    let lastTime = verifiedAt,
      live = true;
    const active = () => {
      if (!live || retired || options.aborted()) return denyTenant();
      const instant = now();
      if (!Number.isSafeInteger(instant) || instant < lastTime || instant >= evidence.validUntil) return denyTenant();
      lastTime = instant;
    };
    const scope = Object.freeze({ principal: evidence, grants, session: async () => active() });
    const actorId = `service:${runAs}`;
    const principal = (actor: BusinessCommandActor) =>
      !!actor &&
      typeof actor === 'object' &&
      !isProxy(actor) &&
      actor.id === actorId &&
      actor.kind === 'service' &&
      actor.appId === app.id &&
      Array.isArray(actor.roles) &&
      actor.roles.length === roles.length &&
      actor.roles.every((role) => roles.includes(role));
    const binding = Object.freeze<BusinessCommandBinding>({
      scoped: true,
      // A command at times names no record (`targets: 'none'`): its envelope's key is empty, as on a single App.
      creates: (id: string): boolean => authorizer.creates(id),
      authorize: (id, actor) => {
        if (!principal(actor)) return deny();
        const extract = options.extract(id);
        const authorization = authorizer.authorize(id, actor);
        // The footprint as a scope of trues: the writer composes the service's scope over it.
        const footprint = Object.freeze(
          Object.fromEntries(Object.keys(ownership.ownership).map((table) => [table, authorization.read.includes(table)])),
        );
        const contexts = new WeakMap<WriteTransaction, TenantCommandRecords>();
        return Object.freeze<AuthorizedBusinessCommand>({
          ...authorization,
          transaction: deny,
          /* No plain transaction: a decision's reads (its record, its choices) run in this command's own fenced
             transaction, scoped to the tenant's rows, and write nothing (decideReads.ts). Without it every tenant
             decision failed at its first read, as `deny` above, and no customer was ever asked about. */
          readsInCommand: true,
          ...(place === 'tenant'
            ? { receiptOwner: captureTenantData({ storeId: identity.storeId, sourceId: identity.source.id, tenantId: tenantId! }) }
            : {}),
          assertTarget: (records: WriteTransaction, target: Readonly<Record<string, string | number>>) =>
            contexts.get(records)?.target(target) ?? deny(),
          assertResult: (records: WriteTransaction, target: Readonly<Record<string, string | number>>, result: unknown) =>
            contexts.get(records)?.result(target, result) ?? deny(),
          commandTransaction: async (run) => {
            let workFailure: { error: unknown } | undefined;
            try {
              return await writer.serviceCommandTransaction(
                evidence,
                footprint,
                (records, journal) =>
                  runTenantCommandTransaction(ownership, scope, authorization, records, journal, extract, async (tx) => {
                    contexts.set(tx.records, tx);
                    try {
                      return await run(tx.records, tx.journal!);
                    } catch (error) {
                      workFailure = { error };
                      throw error;
                    } finally {
                      contexts.delete(tx.records);
                    }
                  }),
                active,
              );
            } catch (error) {
              // The source's confirmed or unknown outcome, around the handler's own refusal.
              throw new CommandTransactionFailure(
                workFailure?.error ?? error,
                error instanceof TenantWriteFailure ? error.outcome : 'unknown',
              );
            }
          },
        });
      },
    });
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    pending.add(held);
    const lifetime: FlagRequestLifetime = {
      generation: Object.freeze({}),
      assertCurrent: active,
      async current() {
        active();
        const fresh = await reader.readServiceAnchors(tenantId);
        active();
        if (
          fresh.platformVersion !== evidence.platformVersion ||
          (evidence.place === 'tenant' && fresh.tenantVersion !== evidence.tenantVersion)
        )
          return denyTenant();
      },
    };
    const flags = commandFlagsOnce(async () => {
      active();
      const reader = await captureFlags?.(evidence, lifetime);
      active();
      return reader;
    });
    return Object.freeze({
      binding,
      captureFlags: flags,
      release: () => {
        live = false;
        pending.delete(held);
        finish();
      },
    });
  };

  /* A mail part's principal, its tenant roles and their visible fields, and the commands it may run. */
  const mailParts = new Map<
    string,
    Readonly<{ runAs: string; roles: readonly string[]; grants: ResourceAccess; commands: ReadonlySet<string> }>
  >();
  for (const [part, runAs, commands] of [
    ['receive', module.mail?.receive?.runAs, [module.mail?.receive?.command.id]],
    ['send', module.mail?.send?.runAs, [module.mail?.send?.claim.id, module.mail?.send?.record.id]],
    ['links', module.mail?.links?.runAs, [module.mail?.links?.command.id, module.mail?.links?.reply?.id]],
  ] as const) {
    if (!runAs) continue;
    const roles = module.principals.get(runAs)!,
      access = resolveAppAccess(app, ownership.schema, [...roles]);
    mailParts.set(
      part,
      Object.freeze({
        runAs,
        roles,
        grants: validation ? { ...access, validation } : access,
        commands: new Set(commands.filter((id): id is string => !!id)),
      }),
    );
  }
  /* An integration's webhook is a part of its own: its principal, and the commands its events run. */
  for (const [integration, mapping] of module.integrations?.webhooks ?? []) {
    const roles = module.principals.get(mapping.runAs)!,
      access = resolveAppAccess(app, ownership.schema, [...roles]);
    mailParts.set(
      `integration:${integration}`,
      Object.freeze({
        runAs: mapping.runAs,
        roles,
        grants: validation ? { ...access, validation } : access,
        commands: new Set(mapping.events.values()),
      }),
    );
  }

  /**
   * A binding for a delivery that is not a job's attempt — a message in, a
   * held message out, a signed link opened — as the mail part's principal in
   * one tenant. It reads the tenant's anchors now and refuses unless the
   * tenant and the platform are active; the writer fences those versions to
   * COMMIT, as a job's attempt does.
   */
  const deliver = async (
    part: 'receive' | 'send' | 'links' | `integration:${string}`,
    tenantId: string,
    signal?: AbortSignal,
  ): Promise<JobCommandBinding> => {
    const at = mailParts.get(part);
    if (retired || !at) return deny();
    const tenant = parseTenantSelector([tenantId]);
    const anchors = captureTenantData(await reader.readServiceAnchors(tenant));
    if (retired || anchors.platformVersion === null || anchors.tenantVersion === null) return deny();
    return bindService({
      runAs: at.runAs,
      place: 'tenant',
      roles: at.roles,
      grants: at.grants,
      tenantId: tenant,
      anchors: Object.freeze({ tenantVersion: anchors.tenantVersion, platformVersion: anchors.platformVersion }),
      aborted: () => signal?.aborted === true,
      extract: (id) => {
        const extract = Object.hasOwn(declarations, id) ? declarations[id] : undefined;
        if (!at.commands.has(id) || typeof extract !== 'function' || isProxy(extract)) return deny();
        return extract as (result: unknown) => readonly CommandResultReference[];
      },
    });
  };

  return Object.freeze({
    app,
    module,
    deployment,
    target,
    listen: listen as string | undefined,
    admit,
    bind,
    deliver,
    /** Whom a job at times per tenant runs for at a slot: the tenants active now. */
    tenants: () => reader.readActiveTenants(),
    /** The records a machine timer is due on, each with its row's tenant; undefined when the module has no timer. */
    sweep: [...module.jobs.values()].some((job) => job.timer) ? sweep : undefined,
    /** What a workflow's steps run by name; each is bound and refused as stepExtract says. */
    commands,
    /** The App's catalog over the tenant source: what a decision's inputs are planned on (decide/decideHost.ts). */
    schema: ownership.schema,
    /** Every tenant's changes of the resources with flows, each with its tenant; undefined without a flows runner. */
    flowChanges: runners.length
      ? tenantFlowChangeReader({
          read: (query) => reader.readRecordActivity(query),
          schema: ownership.schema,
          resources: ownership.resources,
          owners: ownerFields(ownership),
          runners,
        })
      : undefined,
    retire(): Promise<void> {
      retired = true;
      admitted.clear();
      return Promise.allSettled([...pending]).then(() => {});
    },
  });
}
type TenantJobs = ReturnType<typeof bindTenantJobs>;

const runtimes = new WeakMap<object, { jobs: TenantJobs; open: boolean }>();
/** Tenant enrollment's alone: the jobs runtime it bound over its own sources. */
export function registerTenantJobs(enrollment: object, jobs: TenantJobs): void {
  if (runtimes.has(enrollment)) return denyTenant();
  runtimes.set(enrollment, { jobs, open: false });
}

/** What a tenant deployment's mail runs over (tenantMail.ts): its App, module, commands, tenants and mail
 * delivery bindings, and where its stores are. Undefined when it was enrolled without jobs or its module declares no mail. */
export function tenantMailRuntime(enrollment: object) {
  const owned = runtimes.get(enrollment);
  if (!owned?.jobs.module.mail) return undefined;
  const { jobs } = owned;
  return Object.freeze({
    app: jobs.app,
    mail: jobs.module.mail as CapturedMail,
    principals: jobs.module.principals,
    commands: jobs.commands,
    target: jobs.target,
    deliver: jobs.deliver,
    tenants: jobs.tenants,
  });
}
export type TenantMailRuntime = NonNullable<ReturnType<typeof tenantMailRuntime>>;

/** What a tenant deployment's integrations run over (tenantIntegrations.ts): the declaration, its principals and
 * commands, the webhook delivery bindings, and where the store is. Undefined without jobs or without integrations. */
export function tenantIntegrationRuntime(enrollment: object) {
  const jobs = runtimes.get(enrollment)?.jobs;
  const integrations = jobs?.module.integrations;
  if (!jobs || !integrations) return undefined;
  return Object.freeze({
    app: jobs.app,
    integrations,
    principals: jobs.module.principals,
    commands: jobs.commands,
    target: jobs.target,
    deliver: jobs.deliver,
  });
}

/** The providers a tenant deployment's decisions name, each once: what Manage tenants switches per tenant. */
export function tenantDecisionProviders(enrollment: object): readonly string[] | undefined {
  const decisions = runtimes.get(enrollment)?.jobs.module.decisions;
  if (!decisions?.size) return undefined;
  return Object.freeze([...new Set([...decisions.values()].flatMap((decision) => decision.providers))].sort());
}

/**
 * The one job host a tenant deployment runs, opened after enrollment over the
 * runtime it bound; undefined when it was enrolled without jobs. One at a
 * time: a second refuses until the first has stopped. The host starts it once
 * it listens and stops it before the deployment retires.
 *
 * `app` is what each attempt's grants are asked of, the enrolled App unless
 * given; the command is authorized against the enrolled App as well, so it can
 * only narrow. `now`, `idleMs`, `maxIdleMs` and `wakeInProcess` are the job host's own.
 */
export async function openTenantJobHost(
  enrollment: object,
  options: Readonly<{
    now?: () => number;
    idleMs?: number;
    maxIdleMs?: number;
    wakeInProcess?: false;
    app?: () => AppDef;
    /** The server's own work beside the App's jobs: each tenant's file sweep (tenantAuthenticatedHttp.ts). */
    builtIn?: readonly BuiltInJob[];
    /** The tenant source the deployment reads and writes, whose runtime tables (record history) retention sweeps beside the job store. */
    source?: Readonly<{ path: string }> | Readonly<{ url: string }>;
    /** Where decisions.lock is kept, beside the App's authority.lock. */
    decisionsDirectory?: string;
    /** The tenant policy's `decisions`: each tenant's daily calls and how long its rows are kept. */
    decisionPolicy?: import('../policy/appTenantPolicy.js').TenantDecisionPolicy;
  }> = {},
): Promise<JobHost | undefined> {
  const owned = runtimes.get(enrollment);
  if (!owned) return undefined;
  // A module of only mail or integrations runs no jobs: their loops are their own hosts', and no job store opens.
  if (!runsJobs(owned.jobs.module)) return undefined;
  if (owned.open) return denyTenant();
  owned.open = true;
  const { jobs } = owned;
  let decide: import('../decide/decideHost.js').DecisionRuntime | undefined;
  try {
    let builtIn = options.builtIn ?? [];
    /* The App's `retention`, once a day on the platform: the runtime tables are one set shared by every tenant and aged by
       time alone, so a run per tenant would only repeat it. The job store's database and the tenant source are swept one
       after the other (retention.ts), never in parallel, so a small pooled database is not stormed; the job host's one
       runner per slot is what keeps it to one run however many processes serve the App. */
    {
      const { retentionJob } = await import('../retention.js');
      const { storeTargetOf } = await import('../commands/appCommandEvents.js');
      const { source } = options;
      const sourceTarget = source && storeTargetOf('path' in source ? source.path : source.url);
      builtIn = [
        ...builtIn,
        retentionJob({
          ...(jobs.app.retention ? { retention: jobs.app.retention } : {}),
          targets: [jobs.target, ...(sourceTarget ? [sourceTarget] : [])],
        }),
      ];
    }
    /* A tenant's decisions run only where the operator turned a provider on for it (setTenantDecisions). */
    if (jobs.module.decisions?.size) {
      const { openDecisionRuntime, decisionRetention } = await import('../decide/decisionRuntime.js');
      const callsPerDay = options.decisionPolicy?.callsPerTenantPerDay;
      decide = await openDecisionRuntime({
        decisions: jobs.module.decisions,
        commands: jobs.commands,
        target: jobs.target,
        ...(options.decisionsDirectory === undefined ? {} : { directory: options.decisionsDirectory }),
        schema: async () => jobs.schema,
        tenancy: true,
        ...(callsPerDay === undefined ? {} : { callsPerDay: () => callsPerDay }),
        provisioning: "provisionStores with the App's tenant binding and its jobs from @mistriwork/mistri/maintenance",
      });
      const retentionDays = options.decisionPolicy?.retentionDays;
      builtIn = [...builtIn, decisionRetention(decide, jobs.app.id, retentionDays === undefined ? {} : { retentionDays })];
      /* What the tenant HTTP server reads a record's suggestions from, under the lease's own tenant (tenantHttp.ts): kept by
         the enrollment the two share, and forgotten with the host, whose store it is. */
      const { serveDecisions } = await import('../decide/decisionServing.js');
      serveDecisions(enrollment, jobs.app.id, jobs.module.decisions.values(), decide.store);
    }
    const host = await openJobHost({
      ...(decide ? { decide } : {}),
      module: jobs.module,
      deployment: jobs.deployment,
      target: jobs.target,
      ...(jobs.listen ? { listen: jobs.listen } : {}),
      app: options.app ?? (() => jobs.app),
      bind: jobs.bind,
      admit: jobs.admit,
      tenants: jobs.tenants,
      commands: jobs.commands,
      ...(jobs.sweep ? { sweep: jobs.sweep } : {}),
      ...(jobs.flowChanges ? { flowChanges: jobs.flowChanges } : {}),
      ...(builtIn.length ? { builtIn } : {}),
      provisioning: "provisionStores with the App's tenant binding and its jobs from @mistriwork/mistri/maintenance",
      ...(options.now ? { now: options.now } : {}),
      ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
      ...(options.maxIdleMs === undefined ? {} : { maxIdleMs: options.maxIdleMs }),
      ...(options.wakeInProcess === false ? { wakeInProcess: false as const } : {}),
    });
    let stopped: Promise<void> | undefined;
    return Object.freeze({
      ...host,
      stop: () =>
        (stopped ??= (async () => {
          if (decide) (await import('../decide/decisionServing.js')).serveDecisions(enrollment, jobs.app.id, []);
          await host.stop();
        })().finally(() => {
          owned.open = false;
        })),
    });
  } catch (error) {
    owned.open = false;
    if (decide) (await import('../decide/decisionServing.js')).serveDecisions(enrollment, jobs.app.id, []);
    await decide?.store.close().catch(() => {});
    throw error;
  }
}
