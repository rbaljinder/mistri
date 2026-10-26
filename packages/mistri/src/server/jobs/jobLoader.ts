/**
 * The `--jobs` module, loaded and checked, and the deployment it implies.
 *
 * Everything a jobs module needs at run time is derived here, once, from the
 * module and the command registry, so the host at startup and the operator's
 * `provision…Jobs` agree byte for byte: the App's event store, one delivery
 * destination per job (`job:<id>@<version>`, routed from the command version
 * that emits its event) and the job store's policy. Startup attests what
 * provisioning created and never creates it.
 *
 * The load-time checks: every command and event reference resolves at its
 * pinned version; every principal a job runs as is declared and granted the
 * job's command, through roles with no generic write and no operations; the
 * subscription graph (command, event, job, command) is acyclic, so no job can
 * start itself again; every command involved shares one source, which holds
 * the stores; and `maxInFlight` stays within that source's writer.
 */
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { moduleFailure } from '../moduleFailure.js';
import { recordRefusalCause } from '@mistriwork/engine/shared/refusal.js';
import type { CommandEventStoreBinding } from '../../adapters/events/commandEventSchema.js';
import { captureEventDeliveryPolicy, type EventDeliveryPolicy } from '../../adapters/events/eventDeliveryTypes.js';
import { captureJobPolicy, JOB_ID, type JobPolicy } from '../../adapters/jobs/jobStoreTypes.js';
import { appCommandGrants, grantsByRole, logicalResource, type AppDef } from '../../shared/app.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import { appCommandEventStore, storeTargetOf, type StoreTarget } from '../commands/appCommandEvents.js';
import type { BusinessCommandBinding } from '../commands/businessCommandAccess.js';
import { serviceRoleRefusal } from '../commands/businessCommandAuthorization.js';
import {
  getCommandEffects,
  getCommandEvents,
  type AnyBusinessCommand,
  type BusinessCommandRegistry,
} from '../commands/businessCommands.js';
import { integrationCommandProblems, integrationNotifyProblems, integrationRoleProblems } from '../integrations/integrationChecks.js';
import { integrationEventCommands } from '../integrations/integrationDeclaration.js';
import { serviceActor } from './jobAuthorization.js';
import {
  capturedJobModule,
  JobDeclarationError,
  pinJobs,
  saidTimer,
  withMachineTimers,
  type CapturedJob,
  type CapturedJobModule,
  type JobCommandReference,
  type MachineTimer,
} from './jobModule.js';
import { workflowDestinationId } from '../workflows/workflowKeys.js';
import { decisionCommandProblems, describeDecisions } from '../decide/decisionChecks.js';

/** The App's timers: each machine state's wait (appMachine.ts `after`), counted from the machine's `since`, and each
 * resource's instant (appAt.ts `at`), due once the column's time has come and its `when` holds. */
export function machineTimers(app: AppDef): (MachineTimer & { command: string })[] {
  return Object.entries(app.resources ?? {}).flatMap(([resource, def]) => {
    const machine = def.machine;
    /* An `at` timer is one whose stay is the instant itself: due once it has come, and once per instant the column holds. */
    const at = (def.at ?? []).map((timer) => ({
      resource,
      since: timer.column,
      ms: 0,
      after: `the time in ${timer.column}`,
      at: timer.column,
      ...(timer.when === undefined ? {} : { when: timer.when }),
      command: timer.command,
    }));
    if (!machine) return at;
    return [
      ...machine.states.flatMap((state) =>
        (state.after ?? []).map((timer) => {
          if (!machine.since)
            throw new JobDeclarationError(
              `Jobs: the machine of "${resource}" waits ${timer.after} in "${state.name}", and names no "since": a timer counts from the moment the state changed.`,
            );
          return {
            resource,
            column: machine.column,
            since: machine.since,
            state: state.name,
            ms: timer.ms,
            after: timer.after,
            command: timer.command,
          };
        }),
      ),
      ...at,
    ];
  });
}

/** The delivery service every job destination names. */
export const JOB_SERVICE_ID = 'mistri.jobs';
/* A job destination's bounds. They are part of its identity, like its
   route: changing them means a new job version, which is a new destination. */
const DELIVERY_LIMITS = Object.freeze({
  maxAttempts: 8,
  leaseMs: 30_000,
  timeoutMs: 10_000,
  backoffMs: 1_000,
  maxBackoffMs: 60_000,
  maxRetained: 10_000,
  scanBatch: 8,
});
/* Writers on the jobs' source. Both engines serialise writes through one
   writer connection, first come first served, so a job's command queues
   with HTTP's: with at most this many jobs leased, an HTTP command waits
   behind no more than this many job commands. */
const SOURCE_WRITERS = 1;

const refuse = (message: string): never => {
  throw new JobDeclarationError(`Jobs: ${message}`);
};

/** The job store a module's jobs are kept in, as the server opens it: `mistri flows start` enqueues into the same one. */
export function jobStorePolicy(module: CapturedJobModule, appId: string): JobPolicy {
  let store: JobPolicy;
  /* The namespace defaults to the App's id: on PostgreSQL several Apps share
     one job store, a namespace each, and a shared default would hand one
     App's jobs to another's runner. An id a namespace cannot spell is prefixed. */
  const namespace = JOB_ID.test(appId) ? appId : `app-${appId}`;
  try {
    store = captureJobPolicy({ namespace, maxInFlight: SOURCE_WRITERS, ...module.store });
  } catch {
    return refuse(
      'the store bounds are invalid: namespace is letters, digits, underscores and hyphens; maxAttempts 1 to 32; ' +
        'leaseMs 1,000 to 600,000; backoffMs base at most cap, at most a day; maxInFlight at least 1.',
    );
  }
  if (store.maxInFlight > SOURCE_WRITERS) {
    refuse(
      `store maxInFlight ${store.maxInFlight} is more than the source's ${SOURCE_WRITERS} writer: ` +
        "a job's command shares it with HTTP, so no more jobs than writers may be in flight.",
    );
  }
  return store;
}

/** The module as the server runs it: the App's machine timers added as jobs, each command pinned to the registry's. */
export async function servedJobModule(file: string, app: AppDef, commands: BusinessCommandRegistry): Promise<CapturedJobModule> {
  return pinJobs(
    withMachineTimers(await loadJobModule(file), machineTimers(app), (roles, id) => appCommandGrants(app, roles).has(id)),
    commands,
  );
}

/** Trusted deployment code, run once in the server with its private environment. */
export async function loadJobModule(file: string): Promise<CapturedJobModule> {
  let exported: unknown;
  try {
    exported = (await import(pathToFileURL(resolve(file)).href)).default;
  } catch (error) {
    // Our own declaration refusals name only ids; anything else may carry private configuration.
    if (error instanceof JobDeclarationError) throw error;
    // The sentence is fixed; what failed is recorded for the operator's console alone.
    throw recordRefusalCause(
      new JobDeclarationError('The jobs module could not be loaded. Export a default defineJobs module.'),
      `The jobs module "${basename(file)}" did not load: ${moduleFailure(resolve(file), error)}`,
    );
  }
  return capturedJobModule(exported);
}

export interface JobDeployment {
  readonly appId: string;
  /** The one source every job's command and emitting command is on. */
  readonly sourceId: string;
  readonly events: CommandEventStoreBinding;
  readonly destinations: readonly Readonly<{ job: string; policy: EventDeliveryPolicy }>[];
  /** One destination a workflow: the facts it starts on and waits for, from the commands that record them. */
  readonly workflowDestinations: readonly Readonly<{ workflow: string; policy: EventDeliveryPolicy }>[];
  /** A command on the jobs' source, which locates the database that holds the stores. */
  readonly anchor: string;
  readonly store: JobPolicy;
  /** Below the lease, so an attempt that runs out of time is still this host's to record. */
  readonly attemptTimeoutMs: number;
}

const jobDestinationId = (job: Pick<CapturedJob, 'id' | 'version'>): string => `job:${job.id}@${job.version}`;
const pinned = (reference: JobCommandReference) => `${reference.id}@${reference.version}`;

/** Where a deployment's jobs start: the event store their emitting commands
 * write into on their one source, and which of its facts a destination takes. */
interface JobEvents {
  readonly store: (sourceId: string) => CommandEventStoreBinding;
  /** 'app': the App's own commands' facts. 'tenants': every tenant's, in a tenant App's store. */
  readonly scope: 'app' | 'tenants';
}

/** The deployment a module implies over a command registry, checked. Pure: no
 * database is opened. Without `events`, the App's own event store and facts. */
export function jobDeployment(
  captured: CapturedJobModule,
  options: Readonly<{ appId: string; commands: BusinessCommandRegistry; events?: JobEvents }>,
): JobDeployment {
  const { commands } = options;
  const module = pinJobs(captured, commands);
  if (!module.jobs.size && !module.workflows.size && !module.mail && !module.integrations)
    refuse('the module declares no jobs or workflows, only inbound endpoints: it has no job store to provision.');
  const command = (reference: JobCommandReference, what: string): AnyBusinessCommand => {
    const found = Object.hasOwn(commands, reference.id) ? commands[reference.id] : undefined;
    return found ?? refuse(`${what} "${reference.id}", which the commands module does not register.`);
  };
  const sources = new Map<string, string>();
  for (const job of module.jobs.values()) {
    const runs = command(job.command, `job "${job.id}" runs command`);
    if (runs.public) refuse(`job "${job.id}" runs command "${job.command.id}", which is public: only its public form runs it.`);
    sources.set(job.command.id, runs.source);
    /* A job at times runs a sweep: a command that names no record, and finds what is due itself. */
    if (job.every) {
      // Once per tenant or once on the platform is a tenant App's choice (tenantJobs.ts); an App without tenants has neither.
      if (job.realm && options.events?.scope !== 'tenants')
        refuse(`job "${job.id}" says realm: '${job.realm}', which only a tenant App's job at times declares.`);
      // A decision's clock reads the records due itself, and runs its command on each one (decideHost.ts).
      if (runs.targets !== 'none' && !job.decide)
        refuse(
          `job "${job.id}" runs "${job.command.id}" every "${job.every.text}", and that command names a record; a job at times runs a command with targets: 'none', which finds what is due itself.`,
        );
      continue;
    }
    /* A machine's timer runs its command on the record that waited: a verb of that record. */
    if (job.timer) {
      if (runs.targets === 'none')
        refuse(`${saidTimer(job.timer, job.command.id)}; a timer's command acts on the record, so it names one.`);
      continue;
    }
    const from = command(job.from!, `job "${job.id}" starts on command`);
    const manifest = getCommandEvents(from)?.expectation ?? [];
    if (!manifest.some((event) => event.name === job.event!.name && event.version === job.event!.version)) {
      refuse(
        `job "${job.id}" starts on event "${job.event!.name}" version ${job.event!.version}, ` +
          `which command "${job.from!.id}" version ${job.from!.version} does not declare.`,
      );
    }
    // An event's job names the one record its command acts on, which the command reads for it.
    if (runs.targets === 'none')
      refuse(
        `job "${job.id}" runs command "${job.command.id}", which names no record (targets: 'none'); an event's job runs a command on the record it names.`,
      );
    sources.set(job.from!.id, from.source);
  }
  /* A workflow starts on, and waits for, facts that commands record: those commands are on the jobs' source too. */
  const workflowRoutes = new Map<
    string,
    Array<{ commandId: string; commandVersion: number; manifest: readonly { name: string; version: number }[] }>
  >();
  for (const workflow of module.workflows.values()) {
    const routes: Array<{ commandId: string; commandVersion: number; manifest: readonly { name: string; version: number }[] }> = [];
    // A flows runner is started by the host from its records' changes (flowRunner.ts): only what it waits for is delivered.
    for (const event of workflow.flows ? workflow.listens : [workflow.start, ...workflow.listens]) {
      const emitters = Object.entries(commands).filter(([, candidate]) =>
        (getCommandEvents(candidate)?.expectation ?? []).some(
          (declared) => declared.name === event.name && declared.version === event.version,
        ),
      );
      if (!emitters.length)
        refuse(
          `workflow "${workflow.name}" ${event === workflow.start ? 'starts on' : 'waits for'} event "${event.name}" version ${event.version}, which no registered command declares.`,
        );
      for (const [id, emitter] of emitters) {
        sources.set(id, emitter.source);
        if (!routes.some((route) => route.commandId === id))
          routes.push({ commandId: id, commandVersion: emitter.version, manifest: [...getCommandEvents(emitter)!.expectation] });
      }
    }
    workflowRoutes.set(workflow.name, routes);
  }
  /* Mail's commands write beside the stores too: the mail store is on the same database. */
  const mail = module.mail;
  for (const reference of [mail?.receive?.command, mail?.send?.claim, mail?.send?.record, mail?.links?.command])
    if (reference) {
      if (!Object.hasOwn(commands, reference.id))
        refuse(`mail runs command "${reference.id}", which the commands module does not register.`);
      sources.set(reference.id, commands[reference.id].source);
    }
  /* An integration's events run commands that write beside the stores, as mail's do. */
  for (const { command: id } of integrationEventCommands(module.integrations))
    if (Object.hasOwn(commands, id)) sources.set(id, commands[id].source);
  /* A module of flows runners that wait for nothing, or of integrations no event maps, names no command of its own: its stores sit on the App's one source. */
  if (!sources.size && (module.integrations || [...module.workflows.values()].some((workflow) => workflow.flows))) {
    const homes = new Set(Object.values(commands).map((candidate) => candidate.source));
    const [anchor] = Object.keys(commands);
    if (homes.size !== 1 || anchor === undefined)
      refuse(
        "a flows runner or an integration keeps its stores on the source of the App's commands, and this App's commands are on several (or there are none).",
      );
    sources.set(anchor, commands[anchor].source);
  }
  const [sourceId, ...others] = new Set(sources.values());
  if (others.length) {
    refuse(
      `every job's command, every command a job or workflow starts on, and every command a workflow waits on, must share one source, which holds the job store; ` +
        `${[...sources].map(([id, source]) => `"${id}" is on "${source}"`).join(', ')}.`,
    );
  }
  acyclic(module);
  const store = jobStorePolicy(module, options.appId);
  const events = options.events ? options.events.store(sourceId) : appCommandEventStore(options.appId, sourceId);
  const destinations = [...module.jobs.values()]
    .filter((job) => job.from)
    .map((job) => {
      try {
        return Object.freeze({
          job: job.id,
          policy: captureEventDeliveryPolicy({
            source: events,
            serviceId: JOB_SERVICE_ID,
            destinationId: jobDestinationId(job),
            limits: { ...DELIVERY_LIMITS },
            routes: [
              {
                scope: options.events?.scope ?? 'app',
                commandId: job.from!.id,
                commandVersion: job.from!.version,
                manifest: [...getCommandEvents(commands[job.from!.id])!.expectation],
              },
            ],
          }),
        });
      } catch {
        return refuse(`job "${job.id}" does not make a valid delivery destination for App "${options.appId}".`);
      }
    });
  const workflowDestinations = [...module.workflows.values()]
    .filter((workflow) => workflowRoutes.get(workflow.name)!.length)
    .map((workflow) => {
      try {
        return Object.freeze({
          workflow: workflow.name,
          policy: captureEventDeliveryPolicy({
            source: events,
            serviceId: JOB_SERVICE_ID,
            destinationId: workflowDestinationId(workflow.name, workflow.version),
            limits: { ...DELIVERY_LIMITS },
            routes: workflowRoutes.get(workflow.name)!.map((route) => ({ scope: options.events?.scope ?? 'app', ...route })),
          }),
        });
      } catch {
        return refuse(`workflow "${workflow.name}" does not make a valid delivery destination for App "${options.appId}".`);
      }
    });
  return Object.freeze({
    appId: options.appId,
    sourceId,
    events,
    destinations: Object.freeze(destinations),
    workflowDestinations: Object.freeze(workflowDestinations),
    anchor: [...sources.keys()][0],
    store,
    attemptTimeoutMs: Math.min(15_000, Math.floor(store.leaseMs / 2)),
  });
}

/** Command, event, job, command: a job whose command emits what starts a
 * job leading back to it would run forever. Refused with the loop it found. */
function acyclic(module: CapturedJobModule): void {
  const edges = new Map<string, Array<{ job: string; to: string }>>();
  for (const job of module.jobs.values()) {
    if (!job.from) continue;
    const from = pinned(job.from);
    if (!edges.has(from)) edges.set(from, []);
    edges.get(from)!.push({ job: `${job.id}@${job.version}`, to: pinned(job.command) });
  }
  const state = new Map<string, 'open' | 'done'>();
  const visit = (nodes: readonly string[], labels: readonly string[]): void => {
    const node = nodes.at(-1)!;
    state.set(node, 'open');
    for (const edge of edges.get(node) ?? []) {
      if (state.get(edge.to) === 'open') {
        const parts: string[] = [];
        for (let i = nodes.indexOf(edge.to); i < nodes.length; i++) parts.push(nodes[i], i < nodes.length - 1 ? labels[i] : edge.job);
        refuse(`the subscription graph has a cycle, so a job could start itself again: ${[...parts, edge.to].join(' → ')}.`);
      }
      if (!state.has(edge.to)) visit([...nodes, edge.to], [...labels, edge.job]);
    }
    state.set(node, 'done');
  };
  for (const node of edges.keys()) if (!state.has(node)) visit([node], []);
}

/** What a principal runs, as its problems name it: a job, or an inbound endpoint. */
function runners(module: CapturedJobModule): Array<{ what: string; runAs: string; command: string }> {
  return [
    ...[...module.jobs.values()].map((job) => ({ what: `job "${job.id}"`, runAs: job.runAs, command: job.command.id })),
    ...[...module.inbound.values()].map((endpoint) => ({
      what: `inbound endpoint "${endpoint.name}"`,
      runAs: endpoint.runAs,
      command: endpoint.command.id,
    })),
    ...(module.mail?.receive ? [{ what: 'mail receive', runAs: module.mail.receive.runAs, command: module.mail.receive.command.id }] : []),
    ...(module.mail?.send
      ? [
          { what: 'mail send.claim', runAs: module.mail.send.runAs, command: module.mail.send.claim.id },
          { what: 'mail send.record', runAs: module.mail.send.runAs, command: module.mail.send.record.id },
        ]
      : []),
    ...(module.mail?.links ? [{ what: 'mail links', runAs: module.mail.links.runAs, command: module.mail.links.command.id }] : []),
  ];
}

/** Why the loaded App cannot run each job or inbound endpoint as its principal; empty when it can. */
export function jobGrantProblems(module: CapturedJobModule, app: AppDef): string[] {
  if (!grantsByRole(app)) return [`App "${app.id}" grants nothing by role, and a job's principal holds roles.`];
  const problems: string[] = [];
  // A workflow's commands are its steps': which a principal may run is checked where they are found (workflowContracts.ts), not here.
  for (const workflow of module.workflows.values()) {
    const refusal = serviceRoleRefusal(app, module.principals.get(workflow.runAs)!);
    if (refusal) problems.push(`principal "${workflow.runAs}" cannot run workflow "${workflow.name}": ${refusal}.`);
  }
  for (const { what, runAs, command } of runners(module)) {
    const roles = module.principals.get(runAs)!;
    const refusal = serviceRoleRefusal(app, roles);
    if (refusal) problems.push(`principal "${runAs}" cannot run ${what}: ${refusal}.`);
    else if (!appCommandGrants(app, roles).has(command)) {
      problems.push(`principal "${runAs}" (roles ${roles.join(', ')}) is not granted command "${command}" in App "${app.id}".`);
    }
  }
  /* An inbound endpoint is called by someone outside, who proves only a secret: what it runs as is a service, every
     role it holds `service: true`, never a person's. An integration's webhooks are an inbound endpoint, held the same
     (integrationRoleProblems says it for them, by its code); they also grant no generic writes or operations. */
  const roles = app.auth?.roles ?? {};
  for (const endpoint of module.inbound.values()) {
    const person = module.principals.get(endpoint.runAs)!.filter((role) => !Object.hasOwn(roles, role) || roles[role].service !== true);
    if (person.length)
      problems.push(
        `principal "${endpoint.runAs}" runs inbound endpoint "${endpoint.name}", so every role it holds is a service role ("service": true); ` +
          `${person.map((role) => `"${role}"`).join(', ')} ${person.length === 1 ? 'is' : 'are'} not.`,
      );
  }
  for (const { integration, event, runAs } of integrationEventCommands(module.integrations)) {
    const refusal = serviceRoleRefusal(app, module.principals.get(runAs)!);
    if (refusal) problems.push(`principal "${runAs}" cannot run integrations.webhooks "${integration}" event "${event}": ${refusal}.`);
  }
  return problems;
}

/** The grants, then each job's command authorized once as its principal
 * through the real binding: its roles must read the command's footprint. */
function assertJobGrants(module: CapturedJobModule, app: AppDef, binding: BusinessCommandBinding): void {
  const [problem] = jobGrantProblems(module, app);
  if (problem) refuse(problem);
  for (const job of module.jobs.values()) {
    try {
      const authorized = binding.authorize(job.command.id, serviceActor(app.id, job.runAs, module.principals.get(job.runAs)!));
      if (job.timer && authorized.resource !== job.timer.resource)
        refuse(`timer "${job.id}" must run a command targeting "${job.timer.resource}".`);
    } catch {
      refuse(`principal "${job.runAs}" cannot run command "${job.command.id}": its roles must read the command's whole footprint.`);
    }
  }
  for (const endpoint of module.inbound.values()) {
    try {
      binding.authorize(endpoint.command.id, serviceActor(app.id, endpoint.runAs, module.principals.get(endpoint.runAs)!));
    } catch {
      refuse(
        `principal "${endpoint.runAs}" cannot run command "${endpoint.command.id}" for inbound endpoint "${endpoint.name}": its roles must read the command's whole footprint.`,
      );
    }
  }
}

export interface PreparedJobs {
  readonly module: CapturedJobModule;
  /** Absent for a module of inbound endpoints alone, which has no store. */
  readonly deployment?: JobDeployment;
  /** The database of the jobs' source, which holds the stores. Absent with the deployment. */
  readonly target?: StoreTarget;
  /** The connection's `"listen"` URL, when it names one and the target is PostgreSQL. */
  readonly listen?: string;
  /** The effective automation, one line a job. */
  readonly lines: readonly string[];
  /** Where the integrations store is, when the module lists integrations: beside the commands' source. */
  readonly integrationTarget?: StoreTarget;
}

/** Load a `--jobs` file and check it against the commands and the loaded
 * App. The stores are attested when the host opens them. */
export async function prepareJobs(
  options: Readonly<{
    file: string;
    app: AppDef;
    commands: BusinessCommandRegistry;
    resources: Pick<RuntimeResources, 'connectionFor'>;
    binding: BusinessCommandBinding;
    locate: (connection: string) => string | undefined;
    /** The direct URL a connection's `"listen"` names, resolved: where a jobs host holds its LISTEN behind a pooler. */
    listen?: (connection: string) => Promise<string | undefined>;
  }>,
): Promise<PreparedJobs> {
  const { app, commands } = options;
  const module = await servedJobModule(options.file, app, commands);
  for (const endpoint of module.inbound.values()) {
    const found = Object.hasOwn(commands, endpoint.command.id) ? commands[endpoint.command.id] : undefined;
    if (!found)
      refuse(`inbound endpoint "${endpoint.name}" runs command "${endpoint.command.id}", which the commands module does not register.`);
    // A caller outside the App reaches it only through the verified endpoint, never a public form.
    else if (found.public)
      refuse(`inbound endpoint "${endpoint.name}" runs command "${endpoint.command.id}", which is public: only its public form runs it.`);
  }
  assertJobGrants(module, app, options.binding);
  const [decisionProblem] = decisionCommandProblems(module.decisions?.values() ?? [], app, commands);
  if (decisionProblem) refuse(decisionProblem);
  const [integrationProblem] = [
    ...integrationCommandProblems(module.integrations, commands),
    ...integrationRoleProblems(module.integrations, module.principals, app),
    ...integrationNotifyProblems(module.integrations, app),
  ];
  if (integrationProblem) refuse(integrationProblem);
  // An integration's webhook is an inbound endpoint: its principal reads its command's footprint, as a defineInbound's does.
  for (const { integration, event, command, runAs } of integrationEventCommands(module.integrations)) {
    try {
      options.binding.authorize(command, serviceActor(app.id, runAs, module.principals.get(runAs)!));
    } catch {
      refuse(
        `principal "${runAs}" cannot run command "${command}" for integrations.webhooks "${integration}" event "${event}": its roles must read the command's whole footprint.`,
      );
    }
  }
  const lines = Object.freeze(describeJobs(module));
  /* The integrations store sits beside the commands that call through it: the source every command shares. An inbound
     endpoint remembers its deliveries in it, as an integration's webhooks do. */
  const integrationTarget = module.integrations || module.inbound.size ? integrationStoreTarget(app, commands, module, options) : undefined;
  const integrated = integrationTarget ? { integrationTarget } : {};
  if (!module.jobs.size && !module.workflows.size) return Object.freeze({ module, lines, ...integrated });
  const deployment = jobDeployment(module, { appId: app.id, commands });
  const runs = commands[deployment.anchor];
  const connection = options.resources.connectionFor(logicalResource(app, runs.source, runs.target));
  const target =
    storeTargetOf(options.locate(connection)) ??
    refuse(`source "${deployment.sourceId}" is not a SQLite or PostgreSQL database, so it cannot hold the job store.`);
  const listen = 'postgres' in target ? await options.listen?.(connection) : undefined;
  return Object.freeze({ module, deployment, target, lines, ...integrated, ...(listen ? { listen } : {}) });
}

function integrationStoreTarget(
  app: AppDef,
  commands: BusinessCommandRegistry,
  module: CapturedJobModule,
  options: Readonly<{ resources: Pick<RuntimeResources, 'connectionFor'>; locate: (connection: string) => string | undefined }>,
): StoreTarget {
  const inbound = new Set([...module.inbound.values()].map((endpoint) => endpoint.command.id));
  const using = Object.entries(commands)
    .filter(([id, command]) => command.integrations || getCommandEffects(command) || inbound.has(id))
    .map(([, command]) => command);
  const candidates = using.length ? using : Object.values(commands);
  const sources = new Set(candidates.map((command) => command.source));
  if (sources.size !== 1)
    refuse(
      `commands that call integrations, send on a channel or run from an inbound endpoint share one source, which holds the integrations store; they are on ${[...sources].join(' and ')}.`,
    );
  const runs = candidates[0];
  return (
    storeTargetOf(options.locate(options.resources.connectionFor(logicalResource(app, runs.source, runs.target)))) ??
    refuse(`source "${runs.source}" is not a SQLite or PostgreSQL database, so it cannot hold the integrations store.`)
  );
}

/** The effective automation, one line a job, as `mistri check` prints it. */
export function describeJobs(module: CapturedJobModule): string[] {
  const inbound = [...module.inbound.values()].map(
    (endpoint) =>
      `inbound: ${endpoint.name} POST /api/inbound/${endpoint.name} (hmac ${endpoint.verify.algorithm}` +
      `${endpoint.verify.windowMs === undefined ? '' : `, ±${endpoint.verify.windowMs / 1000}s`}, secret ${endpoint.verify.secretEnv}) → ${pinned(endpoint.command)} as ${endpoint.runAs}`,
  );
  const workflows = [...module.workflows.values()].map(
    (workflow) =>
      `workflows: ${workflow.name}@${workflow.version} on ${workflow.flows ? `the changes of ${workflow.flows.resource} (its flows)` : `${workflow.start.name}@${workflow.start.version}`}` +
      `${workflow.listens.length ? ` (waits for ${workflow.listens.map((event) => `${event.name}@${event.version}`).join(', ')})` : ''} as ${workflow.runAs}`,
  );
  const integrations = [...(module.integrations?.use.values() ?? [])].map((integration) => {
    const mapping = module.integrations!.webhooks.get(integration.name);
    const events = [...(mapping?.events ?? [])].map(([event, command]) => `${event} → ${command}`);
    return (
      `integrations: ${integration.name}` +
      (integration.actions.size ? ` actions ${[...integration.actions.keys()].join(', ')}` : '') +
      (events.length ? `; webhook ${events.join(', ')} as ${mapping!.runAs}` : '') +
      (integration.channel ? `; channel ${integration.channel.name}` : '')
    );
  });
  return [
    ...[...module.jobs.values()].map((job) =>
      job.timer
        ? `jobs: ${job.id}@${job.version} ${job.timer.at ? `at ${job.timer.at} in ${job.timer.resource}${job.timer.when === undefined ? '' : ` when ${job.timer.when}`}` : `after ${job.timer.after} in ${job.timer.resource} "${job.timer.state}"`} → ${pinned(job.command)} as ${job.runAs}`
        : job.every
          ? `jobs: ${job.id}@${job.version} every "${job.every.text}" (${job.every.timezone})${job.realm === 'tenant' ? ' per tenant' : job.realm === 'platform' ? ' on the platform' : ''} → ${pinned(job.command)} as ${job.runAs}`
          : `jobs: ${job.id}@${job.version} on ${job.event!.name}@${job.event!.version} (${pinned(job.from!)}) → ${pinned(job.command)} as ${job.runAs}`,
    ),
    ...workflows,
    ...inbound,
    ...integrations,
    ...describeDecisions(module.decisions?.values() ?? []),
  ];
}
