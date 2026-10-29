/**
 * Business commands and durable jobs at startup: a `--commands` registry
 * checked against the one --app's sources, its declared events bound to the
 * App's attested event store, and a `--jobs` host and the effects host — the
 * webhooks the commands post to — opened (and so attested) here, to start
 * once the server listens.
 */
import { dirname } from 'node:path';
import { appZone } from '../../shared/appZone.js';
import { logicalResource, type AppDef } from '../../shared/appModel.js';
import { appUsesCommands } from '../../shared/appCommandIds.js';
import type { LoadedApp } from '../app/apps.js';
import type { StoreTarget } from '../commands/appCommandEvents.js';
import type { Webhook } from '../commands/commandEffects.js';
import type { EffectDeployment, EffectHost } from '../effects/effectHost.js';
import type { CommandJournalAppScope } from '../../adapters/commands/commandJournalTypes.js';
import type { JobHost } from '../jobs/jobHost.js';
import type { InboundHost } from '../jobs/inboundHost.js';
import type { WorkflowShape } from '../workflows/workflowProbe.js';
import type { PreparedJobs } from '../jobs/jobLoader.js';
import type { CommandHosting } from '../http/handler.js';
import type { JobsReadiness } from '../http/appContext.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { Options } from '@mistriwork/engine/server/cli/args.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { FlagRequestRuntime } from '../flags/requestRuntime.js';
import type { HttpAppPolicy } from '../policy/appPolicyHttp.js';
import { commandsOf } from '../stores/commandStores.js';
import { resolveConnection } from '@mistriwork/engine/server/auth/credentials.js';

/* What hosting needs, loaded only when there is something to host: every
   start reaches hostCommands, and most have no --commands. */
const hostingModules = () =>
  Promise.all([
    import('../app/appEntrypoint.js'),
    import('../app/appRuntimeResources.js'),
    import('../commands/businessCommandLoader.js'),
    import('../commands/appCommandEvents.js'),
    import('../commands/businessCommands.js'),
    import('../api/apiCommandCatalog.js'),
    import('../effects/effectHost.js'),
    import('../webhooks.js'),
    import('../jobs/jobHost.js'),
    import('../jobs/jobLoader.js'),
    import('../jobs/jobModule.js'),
    import('../commands/commandContracts.js'),
    import('../jobs/inboundHost.js'),
    import('../workflows/workflowProbe.js'),
  ]);

/* The job and effect hosts answer readiness together: the operator reads one list. */
export function readinessOf(...hosts: Array<JobsReadiness | undefined>): JobsReadiness | undefined {
  const present = hosts.filter((host): host is JobsReadiness => host !== undefined);
  const workflows = present.find((host) => host.workflows)?.workflows;
  return present.length ? { readiness: () => present.flatMap((host) => host.readiness()), ...(workflows ? { workflows } : {}) } : undefined;
}

export interface CommandHost {
  commandHosting?: CommandHosting;
  /* The `--jobs` host, opened (and so attested) here and started once the
     server listens. It authorizes each attempt against the App served now. */
  jobHost?: JobHost;
  /** The retention prune on its own timer, for an App with no job host to schedule it. */
  retentionTimer?: { stop(): void };
  /** The jobs module's inbound endpoints, answered by the HTTP server beside the jobs. */
  inbound?: InboundHost;
  jobLines: readonly string[];
  /** The App the jobs authorize against; the server points it at the one it serves. */
  jobApp: { current: () => AppDef };
  /** A row-policy App's policy the jobs run under; the server points it at the one it serves. */
  jobPolicy: { current: () => HttpAppPolicy | undefined };
  /* The effects host: each webhook destination's publisher, opened (and so
     attested) here and started once the server listens. */
  effectHost?: EffectHost;
  effectLines: readonly string[];
  /** The commands a job runs or starts on: durable dependents of their contracts (commandContracts.ts). */
  jobCommands: ReadonlySet<string>;
  /** The roles the jobs module's principals hold: service identities, never a person's. */
  jobRoles: ReadonlySet<string>;
  /** The jobs module's principals and their roles: under a row policy, each a service the policy names. */
  jobPrincipals: ReadonlyMap<string, readonly string[]>;
  /** The commands each principal runs: its jobs', timers', workflow steps', inbound endpoints' and integration webhooks'. */
  serviceRuns: ReadonlyMap<string, ReadonlySet<string>>;
  /** The jobs module's workflows, probed: their lines in authority.lock, and what is wrong with them. */
  workflows: readonly WorkflowShape[];
  workflowProblems: readonly string[];
  /** The jobs module's decisions, by name: check judges their inputs and decisions.lock. */
  decisions?: ReadonlyMap<string, import('../decide/decisionModule.js').CapturedDecision>;
}

export async function hostCommands(opts: Options, registry: Registry, loadedApps: LoadedApp[]): Promise<CommandHost> {
  let hosted: AppCommandHost | undefined;
  let commandHosting: CommandHosting | undefined;
  const jobApp = { current: (): AppDef => loadedApps[0].app };
  const jobPolicy = { current: (): HttpAppPolicy | undefined => undefined };
  const commandApps = loadedApps.filter((loaded) => appUsesCommands(loaded.app));
  /* The module the App was loaded with — `--commands`, or its commands.ts —
     or, for a build, the build's own bundle, which the flag names. */
  const loadedCommands = loadedApps.find((loaded) => loaded.commands)?.commands;
  if (opts.commands !== undefined || loadedCommands || commandApps.length) {
    const [{ appEntrypoint }, { loadBusinessCommands }, { withCommandVersions }, { lockedVersion }, { JobDeclarationError }] =
      await Promise.all([
        import('../app/appEntrypoint.js'),
        import('../commands/businessCommandLoader.js'),
        import('../commands/businessCommands.js'),
        import('../commands/commandContracts.js'),
        import('../jobs/jobModule.js'),
      ]);
    try {
      if ((opts.commands === undefined && !loadedCommands) || opts.apps?.length !== 1 || loadedApps.length !== 1) {
        throw new Error(
          'Business commands need exactly one explicit --app, with no additional configured apps, and its commands module: ' +
            'commands.ts beside its manifest, or --commands <file>.',
        );
      }
      const commands =
        loadedApps[0].commands?.registry ??
        withCommandVersions(await loadBusinessCommands(opts.commands!), lockedVersion(loadedApps[0].authority?.lock));
      const owner = appEntrypoint({ app: loadedApps[0], pages: [] }, registry);
      if (!owner) throw new Error('The command application has no configured entry point.');
      // Enrolled Apps attest only through their scoped deployment below. Never
      // acquire an ordinary journal transaction just to validate that App.
      hosted = await hostAppCommands({
        app: loadedApps[0].app,
        commands,
        registry,
        owner,
        ...(opts.policy ? { policy: () => jobPolicy.current() } : {}),
        jobsFile: opts.jobs,
        environment: process.env,
        locate: (id) => registry.configOf(id)?.url,
        current: () => jobApp.current(),
        checkApp: opts.checkApp,
        ...decisionsDirectoryOf(loadedApps[0]),
      });
      commandHosting = hosted.commandHosting;
    } catch (error) {
      const { refusalHeadline, refusalReasonsBelow } = await import('@mistriwork/engine/shared/refusal.js');
      console.error(`${error instanceof JobDeclarationError ? 'Jobs' : 'Command'} startup error: ${refusalHeadline(error)}`);
      for (const because of refusalReasonsBelow(error)) console.error(`  because: ${because}`);
      // A store behind its layout is the one refusal with a command to say.
      const { storesBehind, storesUpCommand } = await import('../stores/storesCli.js');
      const behind = await storesBehind({ registry, config: {} as never, schemas: opts.schemas });
      if (behind.length)
        console.error(`Stores behind their layout: ${behind.join('; ')}.\nBring them forward with: ${storesUpCommand(opts)}`);
      await registry.closeAll();
      if (opts.embedded) throw error;
      process.exit(1);
    }
  } else if (opts.jobs !== undefined) {
    // A job runs a command: with no registry, the module would load and nothing would ever run it.
    const refusal = '--jobs requires the App command registry its jobs run: keep commands.ts beside the App or pass --commands.';
    if (opts.embedded) throw new Error(refusal);
    console.error(`mistri: ${refusal}`);
    await registry.closeAll();
    process.exit(1);
  }
  return {
    commandHosting,
    jobHost: hosted?.jobHost,
    ...(hosted?.retentionTimer ? { retentionTimer: hosted.retentionTimer } : {}),
    inbound: hosted?.inbound,
    jobLines: hosted?.jobLines ?? [],
    jobApp,
    jobPolicy,
    effectHost: hosted?.effectHost,
    effectLines: hosted?.effectLines ?? [],
    jobCommands: hosted?.jobCommands ?? new Set(),
    jobRoles: hosted?.jobRoles ?? new Set(),
    jobPrincipals: hosted?.jobPrincipals ?? new Map(),
    serviceRuns: hosted?.serviceRuns ?? new Map(),
    workflows: hosted?.workflows ?? [],
    workflowProblems: hosted?.workflowProblems ?? [],
    ...(hosted?.decisions ? { decisions: hosted.decisions } : {}),
  };
}

/** One App's commands, as `mistri serve` hosts them and a suite hosts each of its Apps. */
interface AppCommandHostOptions {
  readonly app: AppDef;
  readonly commands: BusinessCommandRegistry;
  /** The App's own registry: its connections, webhooks and services. */
  readonly registry: Registry;
  /** The App's entry connection. */
  readonly owner: string;
  /** A row-policy App's policy, as it serves now: it owns the commands, and its
   * jobs, timers, inbound endpoints and integration webhooks run each attempt
   * under it as their principal. Absent while the policy restarts after a save. */
  readonly policy?: () => HttpAppPolicy | undefined;
  readonly jobsFile?: string;
  /** Where the inbound endpoints' secrets are read: the process's, or a suite App's captured environment. */
  readonly environment: NodeJS.ProcessEnv;
  /** A source's URL, with the App's environment applied. */
  readonly locate: (id: string) => string | undefined;
  /** The App the jobs authorize against, read per attempt. */
  readonly current: () => AppDef;
  /** `mistri check`: workflow problems and missing inbound secrets are reported, not refused. */
  readonly checkApp?: boolean;
  readonly flagRuntime?: () => FlagRequestRuntime | undefined;
  /** Where decisions.lock is kept: beside authority.lock, or in the App's directory. */
  readonly decisionsDirectory?: string;
}
export type AppCommandHost = Omit<CommandHost, 'jobApp' | 'jobPolicy'>;

/**
 * Bind an App's commands to its event store, check its API exposure, and
 * open its effects host and, with a jobs module, its job host and inbound
 * endpoints: attested here, started once the server listens. The one path
 * serve and a suite both take, so a suite runs an App the way serve does.
 */
export async function hostAppCommands(options: AppCommandHostOptions): Promise<AppCommandHost> {
  const { app, commands, registry, owner, environment, locate, checkApp } = options;
  const [
    ,
    { loadAppRuntimeResources },
    { bindHttpBusinessCommands, validateBusinessCommandStartup },
    { appCommandEventsFor, storeTargetOf },
    { getCommandEffects },
    { checkApiCommandCatalog },
    { effectDeployment, openEffectHost },
    { openWebhook },
    { openJobHost, registryJobBinding },
    { prepareJobs },
    { JobDeclarationError },
    ,
    { createInboundHost, inboundEndpoint, inboundSecretProblems },
    { checkWorkflows },
  ] = await hostingModules();
  /* The App framework's config sections, read only where an App hosts commands: `--mcp` and the browser never
     reach here, and this was the one static import that loaded them all at startup. */
  const { webhookConfigOf } = await import('../serviceConnections.js');
  let jobHost: JobHost | undefined;
  let retentionTimer: { stop(): void } | undefined;
  let inbound: InboundHost | undefined;
  let jobLines: readonly string[] = [];
  let effectHost: EffectHost | undefined;
  let effectLines: readonly string[] = [];
  let jobCommands: ReadonlySet<string> = new Set();
  let jobRoles: ReadonlySet<string> = new Set();
  let jobPrincipals: ReadonlyMap<string, readonly string[]> = new Map();
  const serviceRuns = new Map<string, Set<string>>();
  let workflows: readonly WorkflowShape[] = [];
  let workflowProblems: readonly string[] = [];
  let events: CommandJournalAppScope | undefined;
  let prepared: PreparedJobs | undefined;
  let appConnections: readonly string[] = [];
  let decide: import('../decide/decideHost.js').DecisionRuntime | undefined;
  let jobRegistry: BusinessCommandRegistry = commands;
  let flowRunners: readonly import('../workflows/flowCommand.js').FlowRunnerRef[] = [];
  let effects: { deployment: EffectDeployment; target: StoreTarget; webhooks: ReadonlyMap<string, Webhook> } | undefined;
  /* A row-policy App's policy owns its commands and its API: what is hosted
     here for one is its event store, its effects and its jobs module, each
     attempt run under the policy. */
  const rowPolicy = options.policy !== undefined;
  const releases: Array<() => void> = [];
  try {
    const resources = await loadAppRuntimeResources(registry, app, owner, (id) => releases.push(registry.lease(id)));
    appConnections = resources.connections;
    const writable = (id: string) => registry.configOf(id)?.writable === true;
    // The feed's events are judged before any store is opened for them (apiEventFeed.ts).
    const [{ withApiWrites }, { apiEventProblems }] = await Promise.all([
      import('../api/apiGenericWrites.js'),
      import('../api/apiEventFeed.js'),
    ]);
    const eventProblems = apiEventProblems(app, commands);
    if (eventProblems.length) throw new Error(eventProblems.join(' '));
    // Commands that declare events write into the App's attested event store; under a policy, through its scope.
    events = await appCommandEventsFor(app, commands, resources, locate);
    if (!rowPolicy) {
      await validateBusinessCommandStartup(app, commands, resources, writable, events);
      // Commands the App exposes to its API are checked against this
      // registry at startup, so a wrong exposure never waits for a request.
      // Its generic writes and feed events are checked with them (apiGenericWrites.ts, apiEventFeed.ts).
      const served = withApiWrites(app, resources.schema, commands);
      const api = served.app.api;
      if (api?.commands.length) {
        checkApiCommandCatalog(api, served.app, resources.schema, served.registry!, {
          connectionFor: resources.connectionFor,
          writableConnection: writable,
          transactionalConnection: (id) => !!commandsOf(resources.forConnection(id)).commandTransaction,
        });
      }
    }
    // Effects post to webhooks the config file names, from the event store beside the commands' source.
    const deployment = effectDeployment({ appId: app.id, commands });
    if (deployment) {
      const webhooks = new Map<string, Webhook>();
      for (const { webhook } of deployment.destinations) {
        // A channel (`channel:sms`) is sent through the App's integrations, opened below, never a config webhook.
        if (webhook.startsWith('channel:')) continue;
        const config = webhookConfigOf(registry, webhook);
        if (!config)
          throw new Error(
            `A command posts to webhook "${webhook}", which the config file does not name. Add a "kind": "webhook" connection called "${webhook}".`,
          );
        webhooks.set(webhook, openWebhook(config));
      }
      const posting = Object.values(commands).find((command) => getCommandEffects(command))!;
      const target = storeTargetOf(locate(resources.connectionFor(logicalResource(app, posting.source, posting.target))));
      if (!target) throw new Error(`Effects keep their deliveries beside source "${deployment.sourceId}", which holds no event store.`);
      effects = { deployment, target, webhooks };
      effectLines = Object.entries(commands).flatMap(([id, command]) =>
        (getCommandEffects(command) ?? []).map((effect) => `effects: ${effect.name} (${id}@${command.version}) → ${effect.destination}`),
      );
    }
    // A call or a send needs the jobs module's integrations to go through; without the module, nothing would.
    if (!options.jobsFile) {
      const checks = await import('../integrations/integrationChecks.js');
      const [problem] = [...checks.integrationCommandProblems(undefined, commands), ...checks.integrationNotifyProblems(undefined, app)];
      if (problem) throw new JobDeclarationError(problem);
    }
    if (options.jobsFile) {
      const binding = bindHttpBusinessCommands(app, commands, resources, writable, events).binding;
      prepared = await prepareJobs({
        file: options.jobsFile,
        app,
        commands,
        resources,
        locate,
        binding,
        listen: async (id) => {
          const config = registry.configOf(id);
          return config?.listen ? (await resolveConnection(config.name, config.listen, { secrets: true, environment })).url : undefined;
        },
      });
      /* A flows runner's reads and writes are a command the platform adds to
           the registry its jobs run against (flowCommand.ts), never the App's. */
      const { flowCommandProblems, withFlowCommands } = await import('../workflows/flowCommand.js');
      const { flowRunnersOf } = await import('../workflows/flowChanges.js');
      flowRunners = flowRunnersOf(prepared.module.workflows);
      /* A flows runner's command is the platform's, beside the App's: the policy's resultReferences name no such command. */
      if (rowPolicy && flowRunners.length)
        throw new JobDeclarationError('A flows runner does not run under a row policy: its writes are no command the policy scopes.');
      const flowProblems = flowRunners.length ? flowCommandProblems(app, resources.schema, commands, flowRunners) : [];
      let checked = binding;
      if (flowRunners.length && !flowProblems.length) {
        jobRegistry = withFlowCommands(app, resources.schema, commands, flowRunners);
        checked = bindHttpBusinessCommands(app, jobRegistry, resources, writable, events).binding;
      }
      if (prepared.module.workflows.size) {
        // What the workflows' steps name is judged now, not on the day an instance reaches it.
        workflows = await checkWorkflows(prepared.module, {
          app,
          commands: jobRegistry,
          binding: checked,
          hasConnection: (name) => !!webhookConfigOf(registry, name),
        });
        workflowProblems = [...flowProblems, ...workflows.flatMap((shape) => shape.problems)];
        for (const shape of workflows)
          if (shape.capped)
            process.stderr.write(
              `workflow "${shape.workflow.name}": check stopped at its cap of paths through it; a branch beyond them is not seen or locked.\n`,
            );
        if (workflowProblems.length && !checkApp) throw new JobDeclarationError(workflowProblems.join(' '));
      }
    }
  } finally {
    for (const release of releases.reverse()) release();
  }
  const commandHosting: CommandHosting = { appId: app.id, registry: commands, ...(events ? { events } : {}) };
  let integrations: import('../integrations/integrationHost.js').AppIntegrations | undefined;
  let deliveries: import('../../adapters/integrations/integrationStore.js').IntegrationStore | undefined;
  try {
    const bind = prepared
      ? registryJobBinding({
          registry,
          app: options.current,
          owner,
          commands: jobRegistry,
          events,
          flagRuntime: options.flagRuntime,
          ...(options.policy ? { policy: options.policy } : {}),
        })
      : undefined;
    if (prepared?.module.integrations && prepared.integrationTarget) {
      // Secrets are sealed under the deployment's key: without one the server does not start, and mistri check says so.
      const { assertSecretsKey, configureSecretsKey } = await import('../integrations/integrationSecrets.js');
      configureSecretsKey(app.id, environment);
      let sealing = true;
      try {
        assertSecretsKey(app.id);
      } catch (error) {
        if (!checkApp) throw new JobDeclarationError((error as Error).message);
        jobLines = [...jobLines, `warning: ${(error as Error).message}`];
        sealing = false;
      }
      if (sealing && !checkApp) {
        const { openAppIntegrations } = await import('../integrations/integrationHost.js');
        integrations = await openAppIntegrations({
          appId: app.id,
          declared: prepared.module.integrations,
          target: prepared.integrationTarget,
        });
      }
    }
    if (effects) effectHost = await openEffectHost({ ...effects, ...(integrations ? { channels: integrations.channel } : {}) });
    if (integrations) effectHost = withIntegrations(effectHost, integrations);
    if (prepared) {
      // Mail is routed to a tenant by its address; an App without tenants has no one for it to arrive for, yet.
      if (prepared.module.mail)
        throw new JobDeclarationError('Jobs mail is served on a tenant App (auth.rows: "tenant"); this App has no tenants.');
      jobLines = [...prepared.lines, ...jobLines];
      jobCommands = new Set([...prepared.module.jobs.values()].flatMap((job) => [...(job.from ? [job.from.id] : []), job.command.id]));
      jobRoles = new Set([...prepared.module.principals.values()].flat());
      jobPrincipals = prepared.module.principals;
      const runs = (runAs: string, command: string) => serviceRuns.set(runAs, (serviceRuns.get(runAs) ?? new Set()).add(command));
      for (const job of prepared.module.jobs.values()) runs(job.runAs, job.command.id);
      for (const shape of workflows)
        for (const step of shape.steps) if (step.kind === 'run' && step.target) runs(shape.workflow.runAs, step.target);
      for (const endpoint of prepared.module.inbound.values()) runs(endpoint.runAs, endpoint.command.id);
      for (const mapping of prepared.module.integrations?.webhooks.values() ?? [])
        for (const command of mapping.events.values()) runs(mapping.runAs, command);
      for (const mapping of prepared.module.integrations?.webhooks.values() ?? [])
        for (const command of mapping.events.values()) jobCommands = new Set([...jobCommands, command]);
      // A module of only inbound endpoints or integrations runs no jobs, and has no job store to open.
      if (prepared.deployment && prepared.module.jobs.size + prepared.module.workflows.size > 0) {
        const opened = new Map<string, Webhook>();
        // A workflow's `w.call` reaches the config file's webhook connections by name, opened when first used.
        const webhooks = {
          get(name: string): Webhook | undefined {
            const config = opened.has(name) ? undefined : webhookConfigOf(registry, name);
            if (config) opened.set(name, openWebhook(config));
            return opened.get(name);
          },
        };
        for (const shape of workflows) for (const step of shape.steps) if (step.kind === 'call' && step.target) webhooks.get(step.target);
        let builtIn = await filesSweep(registry, app, options.current, owner);
        for (const job of builtIn)
          jobLines = [...jobLines, `the jobs sweep ${app.id}'s buckets each day at ${job.every.text} (cron, UTC).`];
        /* The App's `retention`: one daily prune of its runtime tables, on the job store's database and every connection the App uses. */
        {
          const { retentionJob } = await import('../retention.js');
          const targets = [prepared.target!, ...appConnections.flatMap((id) => storeTargetOf(locate(id)) ?? [])];
          builtIn = [...builtIn, retentionJob({ ...(app.retention ? { retention: app.retention } : {}), targets })];
        }
        /* Decisions decide with a store of their own beside the job store, and the lock beside authority.lock. */
        if (prepared.module.decisions?.size) {
          const { openDecisionRuntime, decisionRetention } = await import('../decide/decisionRuntime.js');
          decide = await openDecisionRuntime({
            decisions: prepared.module.decisions,
            commands: jobRegistry,
            target: prepared.target!,
            ...(options.decisionsDirectory === undefined ? {} : { directory: options.decisionsDirectory }),
            schema: async () => {
              const releases: Array<() => void> = [];
              try {
                return (await loadAppRuntimeResources(registry, options.current(), owner, (id) => releases.push(registry.lease(id))))
                  .schema;
              } finally {
                for (const release of releases) release();
              }
            },
            tenancy: false,
          });
          builtIn = [...builtIn, decisionRetention(decide, app.id)];
        }
        jobHost = await openJobHost({
          ...(decide ? { decide } : {}),
          module: prepared.module,
          deployment: prepared.deployment,
          target: prepared.target!,
          ...(prepared.listen ? { listen: prepared.listen } : {}),
          app: options.current,
          bind: (context, job) => bind!(context, job.runAs),
          commands: jobRegistry,
          webhooks,
          sweep: machineTimerSweep(registry, options.current, owner, options.policy),
          builtIn,
          ...(flowRunners.length
            ? {
                flowChanges: (await import('../workflows/flowChanges.js')).flowChangeReader({
                  registry,
                  app: options.current,
                  owner,
                  runners: flowRunners,
                }),
              }
            : {}),
        });
      }
      if (prepared.module.inbound.size) {
        // A secret nobody set verifies nothing: the server does not start on it, and mistri check says so.
        const missing = inboundSecretProblems(prepared.module, environment);
        if (missing.length && !checkApp) throw new JobDeclarationError(missing.join(' '));
        jobLines = [...jobLines, ...missing.map((problem) => `warning: ${problem}`)];
        for (const command of prepared.module.inbound.values()) jobCommands = new Set([...jobCommands, command.command.id]);
      }
      /* Inbound endpoints alone remember their deliveries in the integrations store's `seen`, as an integration's
         webhooks do: the store is opened for that once their secrets are known set, and closed with the effects host. */
      if (prepared.module.inbound.size && !integrations && prepared.integrationTarget && !checkApp) {
        const { openIntegrationStore } = await import('../../adapters/integrations/integrationStore.js');
        deliveries = await openIntegrationStore(prepared.integrationTarget);
        effectHost = withStore(effectHost, deliveries);
      }
      // A defineInbound and an integration's webhooks are one kind of endpoint, answered by one host before any gate.
      const store = integrations?.runtime.store ?? deliveries;
      if (store) {
        const { integrationEndpoints } = await import('../integrations/integrationInbound.js');
        inbound = createInboundHost({
          endpoints: [
            ...[...prepared.module.inbound.values()].map((endpoint) => inboundEndpoint(endpoint, environment)),
            ...(integrations ? integrationEndpoints(integrations.runtime, commands) : []),
          ],
          appId: app.id,
          principals: prepared.module.principals,
          bind: ({ runAs }) => bind!(undefined, runAs),
          deliveries: store,
        });
      }
    }
    /* An App that runs no jobs opens no job host, and the host is what schedules its retention (a job store is what
       it needs): the same daily prune then runs on its own timer, over the connections the App writes to. */
    if (!jobHost && !checkApp) {
      const { retentionJob, retentionPrunes, startRetentionTimer } = await import('../retention.js');
      const targets = appConnections
        .filter((id) => registry.configOf(id)?.writable === true)
        .flatMap((id) => storeTargetOf(locate(id)) ?? []);
      if (targets.length && retentionPrunes(app.retention))
        retentionTimer = startRetentionTimer(retentionJob({ ...(app.retention ? { retention: app.retention } : {}), targets }));
    }
    /* What this App decides rides its payload (decisionServing.ts), from the module hosted now: none is none. */
    const { serveDecisions } = await import('../decide/decisionServing.js');
    serveDecisions(registry, app.id, prepared?.module.decisions?.values() ?? [], decide?.store);
  } catch (error) {
    await Promise.allSettled([effectHost?.stop() ?? integrations?.stop() ?? deliveries?.close(), jobHost?.stop() ?? decide?.store.close()]);
    retentionTimer?.stop();
    throw error;
  }
  return {
    commandHosting,
    jobHost,
    ...(retentionTimer ? { retentionTimer } : {}),
    inbound,
    jobLines,
    effectHost,
    effectLines,
    jobCommands,
    jobRoles,
    jobPrincipals,
    serviceRuns,
    workflows,
    workflowProblems,
    ...(prepared?.module.decisions ? { decisions: prepared.module.decisions } : {}),
  };
}

/**
 * A machine timer's sweep (appMachine.ts `after` and `at`): the records of its
 * table in its state since at or before the cutoff, read through the App's
 * catalog, at most a hundred a minute — the rest are found by the next sweeps.
 * A record whose timer ran and left it where it was (an `at` timer's warning
 * moves nothing) is still due, so each sweep reads the page after the last
 * one, from the first again once a page comes back short: a hundred such
 * records cannot hide the hundred-and-first. A due record enqueued twice runs
 * once, under its stay's key (jobHost.ts). Under a row policy the records are
 * read as the timer's principal, in the rows the policy gives it: a timer
 * never finds a record its command could not reach.
 */
function machineTimerSweep(registry: Registry, app: () => AppDef, owner: string, policy?: () => HttpAppPolicy | undefined) {
  const pages = new Map<string, number>();
  type Due = Readonly<{ key: Readonly<Record<string, string | number>>; since: string }>;
  type Reader = Pick<import('@mistriwork/engine/adapters/adapter.js').Adapter, 'query'>;
  const read = async (
    runAs: string,
    sweep: (schema: import('@mistriwork/engine/shared/schema.js').DatabaseSchema, reader: (table: string) => Reader) => Promise<Due[]>,
  ) => {
    if (policy) {
      const serving = policy();
      if (!serving) throw new Error('The row policy is starting again; the timer looks on its next sweep.');
      return serving.withService(runAs, (context) => sweep(context.schema, () => context.data));
    }
    const { loadAppRuntimeResources } = await import('../app/appRuntimeResources.js');
    const releases: Array<() => void> = [];
    try {
      const resources = await loadAppRuntimeResources(registry, app(), owner, (id) => releases.push(registry.lease(id)));
      return await sweep(resources.schema, (table) => resources.forConnection(resources.connectionFor(table)));
    } finally {
      for (const release of releases.reverse()) release();
    }
  };
  return async (timer: import('../jobs/jobModule.js').MachineTimer, cutoff: Date, runAs: string) => {
    const { wallClockText } = await import('../app/wallClock.js');
    const { calendarDay, zonelessInstant } = await import('../../shared/appStamps.js');
    return read(runAs, async (schema, reader) => {
      const table = schema.tables.find((item) => item.id === timer.resource);
      const since = table?.columns.find((column) => column.name === timer.since);
      if (!table || !since) return [];
      const keys = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
      /* `since` was stamped on the App's wall clock (appStamps.ts), so the cutoff is read on it too; a zoned one holds the instant, in UTC. */
      const day = calendarDay(since.type);
      const zone = day || zonelessInstant(since.type) ? appZone(app().ui) : undefined;
      const at = day ? wallClockText(cutoff, zone).slice(0, 10) : wallClockText(new Date(Math.floor(cutoff.getTime() / 1000) * 1000), zone);
      /* An `after` timer's records are those in its state; an `at` timer's, those its `when` holds (appAtWhen.ts), each condition group with the instant passed. */
      const passed = { column: timer.since, op: '<=' as const, value: at };
      let groups: import('@mistriwork/engine/shared/filter.js').Condition[][];
      if (timer.column !== undefined) groups = [[{ column: timer.column, op: '=', value: timer.state }, passed]];
      else if (timer.when !== undefined) {
        const { atWhenFilter } = await import('../../shared/appAtWhen.js');
        const parsed = atWhenFilter(schema, table, timer.when, cutoff);
        if (!parsed.filter) throw new Error(`"${timer.resource}" at ${timer.at}, when: ${parsed.problem}`);
        groups = parsed.filter.groups.length ? parsed.filter.groups.map((group) => [...group, passed]) : [[passed]];
      } else groups = [[passed]];
      /* An `at` timer that ran leaves its instant passed, so its fired records stay in the read: the newest instants come first, so a mark set a minute ago is not behind every one already fired (the job's key, which holds the instant, keeps a fired one from running again). */
      const direction = timer.column === undefined ? ('desc' as const) : ('asc' as const);
      const page = `${timer.resource}\0${timer.state ?? timer.when ?? ''}\0${timer.since}\0${timer.ms}`;
      const offset = pages.get(page) ?? 0;
      const found = await reader(timer.resource).query({
        table: timer.resource,
        columns: [...keys, timer.since],
        orderBy: [timer.since, ...keys].map((column, index) => ({ column, direction: index ? ('asc' as const) : direction })),
        limit: 100,
        offset,
        filter: { groups },
      });
      pages.set(page, found.rows.length < 100 ? 0 : offset + 100);
      return found.rows.map((row) => ({
        key: Object.fromEntries(keys.map((column) => [column, row[column] as string | number])),
        since: String(row[timer.since]),
      }));
    });
  };
}

/**
 * An App's buckets swept once a day by its jobs host (files/filesCli.ts
 * sweepAppFiles): the objects no row names and no one wrote in the last hour,
 * read through the App's own catalog. A tenant App's are the command's.
 */
async function filesSweep(
  registry: Registry,
  app: AppDef,
  current: () => AppDef,
  owner: string,
): Promise<readonly import('../jobs/jobHost.js').BuiltInJob[]> {
  const [{ bucketResources }, { isTenantApp }] = await Promise.all([import('../files/fileStorage.js'), import('../../shared/app.js')]);
  if (isTenantApp(app) || !bucketResources([app]).length) return [];
  const [{ FILES_SWEEP_JOB, filesSweepEvery, sweepAppFiles }, { parseEvery }] = await Promise.all([
    import('../files/filesCli.js'),
    import('../jobs/jobSchedule.js'),
  ]);
  return [
    {
      id: FILES_SWEEP_JOB,
      every: parseEvery(filesSweepEvery(app.id)),
      run: async () => {
        const { loadAppRuntimeResources } = await import('../app/appRuntimeResources.js');
        const releases: Array<() => void> = [];
        try {
          const resources = await loadAppRuntimeResources(registry, current(), owner, (id) => releases.push(registry.lease(id)));
          const code = await sweepAppFiles(
            current(),
            resources.schema,
            (table) => resources.forConnection(resources.connectionFor(table)),
            (line) => console.log(`mistri: files sweep:${line.startsWith(' ') ? '' : ' '}${line.trim()}`),
          );
          // A delete the bucket refused is retried by the job's own retries, not lost.
          if (code !== 0) throw new Error('The files sweep could not delete every unnamed object.');
        } finally {
          for (const release of releases.reverse()) release();
        }
      },
    },
  ];
}

/* An inbound-only module's deliveries store lives as long as the effects host: closed when it stops. */
function withStore(host: EffectHost | undefined, store: Readonly<{ close(): Promise<void> }>): EffectHost {
  return Object.freeze({
    readiness: () => host?.readiness() ?? [],
    deliveries: host?.deliveries ?? [],
    tick: async () => (host ? host.tick() : false),
    start: () => host?.start(),
    async stop() {
      await host?.stop();
      await store.close();
    },
  });
}

/* The effects host carries the integrations' life: started and stopped with it, held messages sent on its loop's
   schedule, so serve and a suite run them without a second owner. Without effects it is the integrations alone. */
function withIntegrations(
  host: EffectHost | undefined,
  integrations: import('../integrations/integrationHost.js').AppIntegrations,
): EffectHost {
  return Object.freeze({
    readiness: () => host?.readiness() ?? [],
    deliveries: host?.deliveries ?? [],
    async tick() {
      const moved = host ? await host.tick() : false;
      return (await integrations.sendDue()) || moved;
    },
    start() {
      host?.start();
      integrations.start();
    },
    async stop() {
      await host?.stop();
      await integrations.stop();
    },
  });
}

/** Where an App keeps decisions.lock: beside its authority.lock, or in its directory; nowhere for an App without one. */
export function decisionsDirectoryOf(loaded: Pick<LoadedApp, 'authority' | 'dir'>): { decisionsDirectory?: string } {
  const directory = loaded.authority ? dirname(loaded.authority.lockPath) : loaded.dir;
  return directory === undefined ? {} : { decisionsDirectory: directory };
}
