/**
 * The HTTP server: what `mistri` does when no other mode was asked for.
 * The served state (connections, config sections, apps, commands, jobs, the
 * row policy) is held in one object that createApp reads per request, so an
 * app reload is a swap on it; sign-in and the policy are attached before it
 * listens, a busy default port rolls on, and a signal shuts it all down.
 */
import { learnValueLabels } from '../app/valueLabels.js';
import { setBuildIdSource } from '@mistriwork/engine/server/http/probes.js';
import { startupReport } from '@mistriwork/engine/shared/refusal.js';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { basename, dirname, relative } from 'node:path';
import { captureAppAuthRuntime, createAppAuth, ignoredAdminEnvironment } from '../auth/auth.js';
import { expandEnvReferences } from '@mistriwork/engine/server/auth/credentials.js';
import { testControlFrom } from '../http/testControl.js';
import { openWebhook } from '../webhooks.js';
import type { Webhook } from '../commands/commandEffects.js';
import { loadConfig, type Registry } from '@mistriwork/engine/server/connections.js';
import { configLocations } from '@mistriwork/engine/server/config/locations.js';
import { appMissingTables, isRowPolicyApp, isTenantApp, resolveAppAccess } from '../../shared/app.js';
import { appSignUpProblems } from '../../shared/appWarnings.js';
import { appUsesCommands } from '../../shared/appCommandIds.js';
import {
  appAdvisories,
  appProblems,
  assertAppScopes,
  componentWatchDirs,
  mergeAppPages,
  reloadApp,
  watchApp,
  loadedFiles,
  themeWatchDirs,
  type AppHost,
  type LoadedApp,
} from '../app/apps.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../policy/appPolicyHttp.js';
import { appEntrypoint } from '../app/appEntrypoint.js';
import { appLive } from '../app/appLive.js';
import { policyStartupLines } from './policyStartup.js';
import { validateBusinessCommandStartup } from '../commands/businessCommandLoader.js';
import { ensureAppRecordHistory, historyRules } from '../recordHistory.js';
import { ensureAppLive, liveStartupLines, settleLiveStartup } from '../live/liveBinding.js';
import { closeLiveStreams } from '../live/liveStream.js';
import { appKeepsInbox, ensureAppInbox } from '../inbox.js';
import { purgeAppAssistants, purgeOnSchedule } from '../assistant/assistantRetention.js';
import { assistantStoreFor } from '../assistant/assistantStores.js';
import { assistantModel } from '../assistant/assistantModel.js';
import { appSendsEmail, createEmailOutbox, emailProblems } from '../email/outbox.js';
import { appEmailsContacts } from '../email/contactMail.js';
import type { StoreTarget } from '../commands/appCommandEvents.js';
import { diagnosticsFromEnvironment } from '@mistriwork/engine/server/operations/diagnostics.js';
import { collectCapacity } from '../operations/capacity.js';
import { apiReadLifetimes, commandOperations, createApp } from '../http/server.js';
import type { StartupApps } from './apps.js';
import { unsweptBuckets } from '../files/fileStorage.js';
import { openBrowser } from '@mistriwork/engine/server/cli/browser.js';
import { DEFAULT_SHUTDOWN_TIMINGS, shutdownTimings, type Options } from '@mistriwork/engine/server/cli/args.js';
import type { StartupConfig } from '@mistriwork/engine/server/cli/config.js';
import { readinessOf, type CommandHost } from './commandHost.js';
import { assertApiReadStartupComposition } from './api-read-startup-options.js';
import { apiReadStartupOptions, apiServingLine, exposureLines, proxyIdentityLines } from '@mistriwork/engine/server/cli/startupOptions.js';
import { closeDevClientHmr, retireDevClient } from '@mistriwork/engine/server/devclient.js';
import { refusalReasons } from '@mistriwork/engine/server/evidence.js';
import { authoringApp } from '@mistriwork/engine/server/http/refusalReport.js';
import { appHome, outward, publicRoot, settingsMount, type AddressMount } from '@mistriwork/engine/shared/mount.js';
import { adviseConnectionLimits } from '@mistriwork/engine/adapters/connectionBudget.js';
import { startTelemetry } from '@mistriwork/engine/adapters/telemetry/start.js';
import { runtimeVersion } from '@mistriwork/engine/server/packageVersion.js';
import { withTenantApiRequests } from '../tenant/tenantApiRequest.js';
import { pausedTenantWriters } from '../tenant/tenantWriterHealth.js';
import {
  emailConfigOf,
  emailOf,
  embedIssuersOf,
  identityProvidersOf,
  oauthServerOf,
  scimDirectoriesOf,
  webhookConfigOf,
} from '../serviceConnections.js';
import { CONFIG_SECTIONS } from '../serviceConnections.js';

/** What links in cookies, callbacks and mail are minted for: the mounting host's origin, MISTRI_PUBLIC_URL, the first --allowed-host, or loopback. */
const publicUrl = (opts: Options, base: string) =>
  publicRoot(
    opts.embedded?.publicURL ??
      (process.env.MISTRI_PUBLIC_URL?.trim() ||
        (opts.allowedHosts[0] ? `https://${opts.allowedHosts[0]}` : `http://localhost:${opts.port}`)),
    base,
  );

export async function serveHttp(
  opts: Options,
  registry: Registry,
  config: StartupConfig,
  apps: StartupApps,
  hosted: CommandHost,
  nothingToOpen: boolean,
): Promise<void> {
  await startServing(opts, registry, config, apps, hosted, nothingToOpen);
}

/** A server wired and started but listening on nothing: what a mounted handler dispatches to (embed/handler.ts). */
export interface MountedServing {
  /** Never listened on: its `request` listeners are the whole pipeline, analytics' beacon included. */
  readonly server: Server;
  readonly mount: AddressMount;
  /** The same shutdown a signal runs, short of exiting the process. */
  close(): Promise<void>;
}

/**
 * Everything `serveHttp` does short of a port. The command line listens on
 * the server and owns the process's signals; a mounted handler
 * (`opts.embedded`) gets the server back unlistened, its jobs started as a
 * listening server's are, and owns its shutdown through `close`. One startup
 * for both, so a mounted App is served by exactly the pipeline the command
 * line serves it by.
 */
export async function startServing(
  opts: Options,
  registry: Registry,
  config: StartupConfig,
  apps: StartupApps,
  hosted: CommandHost,
  nothingToOpen: boolean,
): Promise<MountedServing | undefined> {
  const { configPath } = config;
  const { loadedApps, pagesBeforeApp } = apps;
  const { commandHosting, jobHost, retentionTimer, inbound, jobLines, jobApp, jobPolicy, jobPrincipals, effectHost, effectLines } = hosted;
  /* A row-policy App's jobs run under the policy it serves now: none while it starts again after a save. */
  jobPolicy.current = () => serving.policy;
  // What the jobs run as and where the commands' events go: the policy binds both (commandHost.ts).
  const policyBindings = {
    ...(jobPrincipals.size ? { services: jobPrincipals } : {}),
    ...(commandHosting?.events ? { events: commandHosting.events } : {}),
  };
  /* Where each App is served, and under what path (shared/mount.ts): the
     flags over the config, each App by its id, checked against the Apps
     that loaded before anything listens. */
  let mount: AddressMount;
  try {
    mount = settingsMount(
      loadedApps.map((loaded) => loaded.app.id),
      opts,
      config,
    );
  } catch (error) {
    console.error(`mistri: ${startupReport(error)}`);
    if (opts.embedded) throw error;
    process.exitCode = 1;
    return undefined;
  }
  /* Held in a variable rather than inlined because createApp reads it per
     request: an app reload swaps `pages`, `app` and `appLoadError` here and
     every request from then on serves the new load. */
  const serving = {
    registry,
    views: config.views,
    configPath,
    queries: config.queries,
    pages: apps.pages,
    layouts: config.layouts,
    apps: loadedApps.map((app): AppHost => ({ app, pages: [] })),
    commands: opts.policy ? undefined : commandHosting,
    jobs: readinessOf(jobHost, effectHost),
    inbound,
    /* A test host's setup and job runs (http/testControl.ts): none unless startTestApp started this process. */
    testControl: testControlFrom(process.env, {
      registry,
      apps: (): readonly AppHost[] => serving.apps,
      ...(jobHost ? { jobs: jobHost } : {}),
      ...(opts.policy ? { policy: opts.policy } : {}),
    }),
    policy: undefined as HttpAppPolicy | undefined,
    policyUnavailable: false as boolean | string,
    apiReads: undefined as
      | (NonNullable<ReturnType<typeof apiReadStartupOptions>> & { engine: ReturnType<typeof assertApiReadStartupComposition> })
      | undefined,
    diagnostics: diagnosticsFromEnvironment(process.env.MISTRI_DIAGNOSTICS),
    bound: {
      host: opts.host,
      port: opts.port,
      allowedHosts: opts.allowedHosts,
      identityHeader: opts.authProxyHeader,
      trustedProxies: opts.trustedProxies,
      identityProxies: opts.authProxies,
      ...(opts.embedded?.origins?.length ? { embedOrigins: opts.embedded.origins } : {}),
    },
    /* The Apps' places as startup settled them; an App keeps its place through a reload. */
    addresses: { base: mount.base, mounts: { ...mount.apps } },
    /* `/readyz`: listening, not shutting down, and every App's data served
       (a row policy restarting after a save, or an App whose authority
       changed, is not), and no tenant writer closed by an uncertain write:
       one writer serves all of an App's tenants, and an orchestrator acts on
       the status alone, so a 200 saying "degraded" would be the G193 outage
       again. The writer reopens itself (tenantWriterLifecycle.ts); readiness
       returns with it, and an instance whose writer cannot come back is
       replaced. */
    ready: () =>
      listening &&
      !stopping &&
      !serving.policyUnavailable &&
      !serving.apps.some((host) => host.unavailable) &&
      !pausedTenantWriters().length,
  };
  let listening = false;
  /* The build being served is what /readyz fingerprints (engine http/probes.ts). */
  setBuildIdSource(() => serving.apps.find((host) => host.app.build)?.app.build?.id ?? null);
  /* OpenTelemetry when OTEL_* asks for it (nothing loaded otherwise), and the
     dev observer when --dev does — on a loopback listener only, since what it
     keeps is the SQL with its parameters and the bodies both ways. A
     production start never imports it. */
  const telemetry = await startTelemetry(process.env, runtimeVersion());
  /* The pools, as the conventions' connection gauges: read when the exporter
     reads, from the counters the capacity section already keeps. By
     position, never a connection's name. */
  const stopPoolGauges = telemetry.gauges?.(() => {
    const pools = collectCapacity(registry).pools;
    const point = (pool: (typeof pools)[number], value: number, state?: string) => ({
      value,
      attributes: {
        'db.client.connection.pool.name': `${pool.position}:${pool.role}${pool.replica ?? ''}`,
        ...(state ? { 'db.client.connection.state': state } : {}),
      },
    });
    return [
      {
        name: 'db.client.connection.count',
        description: 'Connections in each pool by state.',
        unit: '{connection}',
        kind: 'updown' as const,
        points: pools.flatMap((pool) => [
          point(pool, pool.inUse, 'used'),
          point(pool, Math.max(0, (pool.open ?? pool.inUse) - pool.inUse), 'idle'),
        ]),
      },
      {
        name: 'db.client.connection.pending_requests',
        description: 'Checkouts waiting for a connection.',
        unit: '{request}',
        kind: 'updown' as const,
        points: pools.map((pool) => point(pool, pool.waiting)),
      },
      {
        name: 'db.client.connection.max',
        description: 'The most connections each pool may hold.',
        unit: '{connection}',
        kind: 'updown' as const,
        points: pools.map((pool) => point(pool, pool.size)),
      },
    ];
  });
  let observer: import('../observe/observer.js').Observer | undefined;
  let bench: import('../themeBench/bench.js').ThemeBench | undefined;
  if (opts.dev) {
    if (opts.host !== '127.0.0.1' && opts.host !== 'localhost' && opts.host !== '::1') {
      console.error(`mistri: --dev serves the observer on a loopback listener only; ${opts.host} is not one, so it is off.`);
    } else {
      const { startObserver } = await import('../observe/observer.js');
      observer = startObserver(
        { registry, apps: () => serving.apps },
        { slowMs: Number(process.env.MISTRI_OBSERVE_SLOW_MS) > 0 ? Number(process.env.MISTRI_OBSERVE_SLOW_MS) : undefined },
      );
      // The theme bench rides the same loopback-only dev start: a theme written against the App's own pages.
      if (serving.apps.length) bench = (await import('../themeBench/bench.js')).startThemeBench({ apps: () => serving.apps });
    }
  }
  let server: ReturnType<typeof createApp> | undefined;
  let outbox: ReturnType<typeof createEmailOutbox> | undefined;
  let stopAssistantPurge: (() => void) | undefined;
  let contactMail: import('../email/contactMail.js').ContactMail | undefined;
  let analytics: import('../analytics/host.js').AnalyticsHost | undefined;
  let stopping = false,
    cleanupPromise: Promise<void> | undefined;
  /* A startup failure already said in its own words (a row-policy App's, policyStartup.ts): not said again under
     "Server startup error", which restated it framed as the policy's. */
  let said: unknown;
  let exitStatus = 0,
    exitPromise: Promise<void> | undefined;
  const stopWatchers: Array<() => void> = [];
  const background = new Set<Promise<unknown>>();
  const retiredPolicies = new WeakSet<HttpAppPolicy>();
  /* The row policy's and the commands' own files, as the policy started with
     them. Node imports a module once, so an App reload starts its policy again
     from the code already loaded: a save that changed either file cannot take
     effect without a restart, and is told so rather than half-applied. */
  const moduleFiles = [opts.policy, opts.commands].filter((file): file is string => typeof file === 'string');
  const moduleTexts = () =>
    moduleFiles.map((file) => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    });
  let startedModules: Array<string | null> = [];
  const retirePolicy = () => {
    const policy = serving.policy;
    if (!policy || retiredPolicies.has(policy)) return;
    retiredPolicies.add(policy);
    return policy.retire();
  };
  const track = <T>(work: Promise<T>) => {
    background.add(work);
    void work.then(
      () => background.delete(work),
      () => background.delete(work),
    );
    return work;
  };
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    stopping = true;
    let failed = false;
    const attempt = async (work: () => unknown) => {
      try {
        await work();
      } catch {
        failed = true;
        exitStatus = 1;
      }
    };
    let retiring: Promise<void>;
    let stoppedWatchers: Array<Promise<void>>;
    // Validated at startup (startup.ts, embed/handler.ts); the defaults hold for a caller that skipped it.
    const timings = shutdownTimings(opts);
    const { drainMs, graceMs } = typeof timings === 'string' ? DEFAULT_SHUTDOWN_TIMINGS : timings;
    // Register before any owner callback can reenter shutdown.
    cleanupPromise = Promise.resolve().then(async () => {
      await Promise.all(stoppedWatchers);
      /* Readiness is already 503 (`stopping`); a balancer that probes needs a beat to see it and take this instance
         out before the listener stops answering. Requests still arrive and are served meanwhile. */
      if (drainMs) await new Promise((resolve) => setTimeout(resolve, drainMs));
      /* Live streams never finish on their own: each is told the server is stopping, and its page reconnects elsewhere. */
      closeLiveStreams();
      const listenerClosed = attempt(() =>
        server
          ? new Promise<void>((resolve, reject) => {
              server!.close((error) => {
                if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
                else resolve();
              });
            })
          : undefined,
      );
      await Promise.all([
        retiring,
        attempt(() => (server ? closeDevClientHmr(server) : undefined)),
        attempt(() => jobHost?.stop()),
        attempt(() => retentionTimer?.stop()),
        attempt(() => effectHost?.stop()),
        attempt(() => outbox?.stop()),
        attempt(() => stopAssistantPurge?.()),
        attempt(() => contactMail?.stop()),
        attempt(() => analytics?.close()),
        attempt(retirePolicy),
      ]);
      await Promise.allSettled([...background, ...(server ? (commandOperations.get(server) ?? []) : [])]);
      // A policy acquired during an early signal publishes inside tracked
      // startup work; it may not have existed during the first retirement.
      await attempt(retirePolicy);
      // A request active when close() ran may just have become keep-alive
      // idle. Sweep only idle HTTP sockets after draining accepted work;
      // never terminate a still-running API response to accelerate shutdown.
      server?.closeIdleConnections();
      // A response that finishes later sweeps again (serverTimeouts.ts). One
      // that never finishes — a client that stopped reading — would hold the
      // exit for the ten-minute request timeout, so it gets a bounded grace.
      const grace = setTimeout(() => server?.closeAllConnections(), graceMs);
      await listenerClosed;
      clearTimeout(grace);
      await attempt(() => (server ? retireDevClient(server) : undefined));
      for (const host of serving.apps) await attempt(() => host.auth?.close());
      await attempt(() => registry.closeAll());
      await attempt(() => serving.diagnostics?.flush());
      stopPoolGauges?.();
      await attempt(() => telemetry.shutdown());
      observer?.stop();
      bench?.stop();
      if (failed) console.error('mistri: one or more server resources could not be closed cleanly.');
    });
    // Revocation must precede queued read microtasks, not merely eventual
    // resource teardown. attempt invokes each owner synchronously before await.
    retiring = attempt(() => (server ? apiReadLifetimes.get(server)?.retire() : undefined));
    stoppedWatchers = stopWatchers.map((stop) => attempt(stop));
    return cleanupPromise;
  };
  const exit = (status: number): Promise<void> => {
    exitStatus = Math.max(exitStatus, status);
    if (!exitPromise) {
      let drained: Promise<void>;
      exitPromise = Promise.resolve()
        .then(() => drained)
        .then(() => {
          // A mounted handler's process is its host's: shut down, never exit.
          if (opts.embedded) return;
          process.off('SIGINT', shutdown);
          process.off('SIGTERM', shutdown);
          process.exit(exitStatus);
        });
      // Publish the exit promise before synchronous retirement can reenter.
      drained = cleanup();
    }
    return exitPromise;
  };
  const shutdown = () => {
    void exit(0);
  };
  // Acquisition promises publish their late results inside the tracked work.
  // An early signal drains those results before closing native stores.
  if (!opts.embedded) {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
  try {
    const apiOptions = apiReadStartupOptions(opts);
    serving.apiReads = apiOptions && {
      ...apiOptions,
      engine: assertApiReadStartupComposition(
        loadedApps,
        registry.configs(),
        opts.commands !== undefined,
        // A row-policy App's API is served under its --policy (policyApiOwner.ts).
        opts.policy !== undefined,
        apiOptions.network === true,
      ),
    };
    /* Each diagnostics summary carries the pools and the event loop as they
     were when it was taken: the capacity the operator bundle reads. */
    serving.diagnostics?.watchCapacity(() => collectCapacity(registry));
    /* An App that names its connection and finds tables it declares missing
       there is refused before anything listens: its schema was never applied,
       and the warnings below scrolled past a server whose every screen then
       answered with an error. An App with no connection of its own keeps the
       warning, since it may be served over several (appCeilingWarnings). */
    for (const host of serving.apps) {
      const app = host.app;
      const scoped = app.app.connection;
      const match = scoped && registry.list().find((c) => c.id === scoped || c.name === scoped);
      if (!match || isTenantApp(app.app)) continue;
      const missing = appMissingTables(app.app, (await track(loadAppRuntimeResources(registry, app.app, match.id))).schema);
      if (stopping) return undefined;
      if (!missing.length) continue;
      const dir = relative(process.cwd(), app.dir ?? dirname(app.path)) || '.';
      const quoted = missing.map((name) => `"${name}"`);
      const named =
        quoted.length === 1 ? `the table ${quoted[0]}` : `the tables ${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
      const why =
        `${app.path}: "${app.app.name}" declares ${named}, which ${match.name} does not have. ` +
        `Apply the schema first: mistri migrate up --app ${dir} (mistri migrate diff init --app ${dir} writes the first migration from schema.sql).`;
      console.error(`App error: ${why}`);
      said = new Error(why);
      throw said;
    }
    /* Sign-in, for the app that asked. One per server: the session is a
     cookie on this origin, and two apps with two ideas of who is signed in
     would share it. The public URL is what the cookies and the OAuth
     callbacks are minted for — the first --allowed-host, or the loopback
     address, unless MISTRI_PUBLIC_URL says otherwise. */
    const withAuth = serving.apps.filter((h) => h.app.app.auth);
    if (withAuth.length && serving.apps.length !== 1) {
      console.error('App error: an authenticated application requires its own application server.');
      throw new Error('An authenticated application requires its own application server.');
    }
    // The admin variables reach no store where nothing signs in: said once, so the operator is not left guessing.
    const unread = withAuth.length
      ? undefined
      : serving.apps[0] && ignoredAdminEnvironment(process.env, serving.apps[0].app.app.name, false);
    if (unread) console.error(unread);
    if (withAuth.length === 1) {
      if (opts.port === 0 && !opts.embedded) {
        console.error('App error: authenticated applications require a stable nonzero --port; choose a free port explicitly.');
        throw new Error('Authenticated applications require a stable nonzero --port.');
      }
      const host = withAuth[0];
      const publicURL = publicUrl(opts, mount.base);
      const trustedOrigins = [
        ...new Set([
          publicURL,
          ...opts.allowedHosts.map((h) => `https://${h}`),
          `http://localhost:${opts.port}`,
          `http://127.0.0.1:${opts.port}`,
        ]),
      ];
      try {
        /* The OAuth authorization server issues tokens for the App's network
           API: served only beside that API, never as a door to nothing. */
        const oauth = oauthServerOf(registry);
        if (oauth?.apps.includes(host.app.app.id) && !serving.apiReads) {
          throw new Error(
            `the config file's OAuth authorization server "${oauth.name}" issues tokens for "${host.app.app.id}"'s API, which this server does not serve. Serve it with --api-reads, or take "${host.app.app.id}" off its "apps".`,
          );
        }
        const mail = emailOf(registry);
        const auth = await track(
          createAppAuth(host.app, {
            baseURL: `${publicURL}${mount.base}`,
            trustedOrigins,
            excludeConnections: registry.configs(),
            identity: identityProvidersOf(registry),
            embed: embedIssuersOf(registry),
            scim: scimDirectoriesOf(registry),
            ...(opts.trustedProxies ? { trustedProxies: opts.trustedProxies } : {}),
            listenHost: opts.host,
            ...(opts.dev ? { development: true } : {}),
            ...(mail ? { mail } : {}),
            ...(oauth ? { oauth: { config: oauth, home: appHome(mount, host.app.app.id).replace(/\/$/, '') } } : {}),
          }).then((auth) => {
            host.auth = auth;
            return auth;
          }),
        );
        if (stopping) return undefined;
        console.log(`mistri: "${host.app.app.name}" signs people in (${auth.spec.providers.join(', ')}; sessions in ${auth.store})`);
      } catch (err) {
        console.error(`App error: ${startupReport(err)}`);
        throw err;
      }
    }
    if (opts.policy) {
      try {
        const host = serving.apps[0];
        const auth = host.auth!;
        await track(
          loadHttpAppPolicy({
            registry,
            app: host.app.app,
            file: opts.policy,
            commands: commandHosting?.registry,
            ...policyBindings,
            // A storefront's placed form draws the App's input components from the compile being served.
            components: () => serving.apps[0]?.app.components,
            // An App API request answers for itself (policyApiOwner.ts); a browser's is its session's.
            verifySession: withTenantApiRequests((request: IncomingMessage) => auth.session(request)),
          }).then((policy) => {
            serving.policy = policy;
          }),
        );
        startedModules = moduleTexts();
        if (stopping) return undefined;
      } catch (error) {
        for (const line of await policyStartupLines(error, serving.apps[0]?.app)) console.error(line);
        said = error;
        throw error;
      }
    }
    /* Record history: an App page that shows one needs its store, which is
     provisioned once and never here, so a server that would keep none does
     not start. Bound now, so the first write — a command, an agent's —
     records before any page is read. */
    for (const host of serving.apps) {
      const history = historyRules(host.app.app, host.app.pages).size > 0;
      // Notifications likewise: a store provisioned once, attested and bound before the first write.
      if (!history && !appKeepsInbox(host.app.app)) continue;
      try {
        if (history) await track(ensureAppRecordHistory(registry, host));
        if (appKeepsInbox(host.app.app)) await track(ensureAppInbox(registry, host));
      } catch (error) {
        console.error(`App error: ${startupReport(error)}`);
        throw error;
      }
      if (stopping) return undefined;
    }
    /* Live sync: marked now, so the first write is told to the pages open on it, and the store asked where the database
       is open already. A database without its store is not refused; live sync is off there, and said so once
       (`mistri migrate stores up` provisions it). One not open yet is asked at its first use. */
    for (const host of serving.apps) ensureAppLive(registry, host);
    await track(settleLiveStartup(registry));
    if (stopping) return undefined;
    for (const line of liveStartupLines(
      registry,
      serving.apps.map((host) => host.app.app),
    ))
      console.log(`mistri: ${line}`);
    /* The assistant's conversations likewise: a store provisioned once, attested here —
       when there is a model to talk to; without one the assistant is not offered at all. */
    for (const host of serving.apps) {
      if (!host.app.app.assistant || !assistantModel()) continue;
      try {
        await track(assistantStoreFor(registry, host));
      } catch (error) {
        console.error(`App error: ${startupReport(error)}`);
        throw error;
      }
      if (stopping) return undefined;
    }
    /* And kept for the retention period, as a tenant App's are: purged now and every six hours, over the Apps
       served at the time, so a reload that adds or drops an assistant is followed. */
    if (serving.apps.some((host) => host.app.app.assistant) && assistantModel())
      stopAssistantPurge = purgeOnSchedule(() => track(purgeAppAssistants(registry, serving.apps, Date.now())));
    /* Email: a notify rule that mails needs the config's email service, and
     its outbox is sent from here, after each write commits (email/outbox.ts). */
    for (const host of serving.apps) {
      const problem = emailProblems(host.app.app, Boolean(emailConfigOf(registry)));
      if (problem) {
        console.error(`App error: ${problem}`);
        throw new Error(problem);
      }
    }
    /* Mail to an address a record holds (`notify.send` email): what it needs, checked as `mistri check` checks it, and
       its store, loop and unsubscribe route, answered before any gate as an inbound delivery is (email/contactMail.ts). */
    const contacts = serving.apps.filter((host) => appEmailsContacts(host.app.app));
    if (contacts.length) {
      const { contactEmailFindings } = await import('../integrations/integrationChecks.js');
      const { contactMailPlaces, openContactMail } = await import('../email/contactMail.js');
      const { UNSUBSCRIBE_PATH } = await import('../email/unsubscribe.js');
      const service = emailConfigOf(registry);
      const apps: Array<{ id: string; name: string; target: StoreTarget }> = [];
      try {
        for (const host of contacts) {
          const places = await track(contactMailPlaces(registry, host));
          const findings = contactEmailFindings(host.app.app, {
            email: service ? { links: Boolean(service.links?.secret) } : undefined,
            commands: commandHosting?.registry ?? host.app.commands?.registry,
            connectionOf: places.connectionOf,
          });
          for (const warning of findings.warnings) console.warn(`mistri: warning: ${warning}`);
          if (findings.problems.length || !places.target)
            throw new Error(findings.problems[0] ?? `${host.app.app.name}: its notify rules' records are not in SQLite or PostgreSQL.`);
          apps.push({ id: host.app.app.id, name: host.app.app.name, target: places.target });
        }
        contactMail = await track(
          openContactMail({
            apps,
            transport: emailOf(registry)!,
            // A reference to the environment, as the config file must write it; the value is what signs.
            secret: expandEnvReferences(service!.links!.secret),
            address: `${publicUrl(opts, mount.base).replace(/\/+$/, '')}${outward(mount, UNSUBSCRIBE_PATH)}`,
          }),
        );
      } catch (error) {
        console.error(`App error: ${startupReport(error)}`);
        throw error;
      }
      if (stopping) return undefined;
      const mail = contactMail,
        inner = serving.inbound;
      serving.inbound = Object.freeze({
        handle: async (req: IncomingMessage, res: ServerResponse, url: URL) =>
          (await mail.handle(req, res, url)) || (inner ? inner.handle(req, res, url) : false),
      });
    }
    const activeServer = createApp(serving);
    server = activeServer;
    /* Behavior analytics, when the config file binds a store (src/server/analytics/). One App per file;
     it is read once here, so a save to the App's `analytics` takes a restart. */
    const analyticsConfig = configPath ? (await loadConfig(configPath, CONFIG_SECTIONS))?.analytics : undefined;
    if (analyticsConfig) {
      try {
        if (serving.apps.length !== 1) throw new Error('"analytics" in a config file serves one App; use a suite for several.');
        const only = serving.apps[0],
          sessions = only.auth && captureAppAuthRuntime(only.auth);
        if (analyticsConfig.app !== undefined && analyticsConfig.app !== only.app.app.id)
          throw new Error(`"analytics" names App "${analyticsConfig.app}", but this server serves "${only.app.app.id}".`);
        if (isTenantApp(only.app.app)) throw new Error('analytics for tenant Apps is not available yet.');
        const opened = new Map<string, Webhook>();
        const { openAnalyticsHost, bindAnalyticsServer } = await import('../analytics/host.js');
        analytics = await track(
          openAnalyticsHost({
            configuration: analyticsConfig,
            app: only.app,
            environment: analyticsConfig.deploymentId,
            mount: appHome(mount, only.app.app.id).replace(/\/$/, ''),
            bound: serving.bound,
            subject: async (req) => (sessions ? (await sessions.sessionInstance(req).catch(() => null))?.identity.id : undefined) ?? null,
            webhook: (name) => {
              const service = opened.has(name) ? undefined : webhookConfigOf(registry, name);
              if (service) opened.set(name, openWebhook(service));
              return opened.get(name);
            },
            onSinkError: (sink, message) => console.error(`mistri: analytics sink "${sink}": ${message}`),
          }),
        );
        bindAnalyticsServer(activeServer, analytics);
      } catch (error) {
        console.error(`Analytics startup error: ${startupReport(error)}`);
        throw error;
      }
    }
    if (serving.apps.some((host) => appSendsEmail(host.app.app))) {
      outbox = createEmailOutbox({
        registry,
        hosts: () => serving.apps,
        transport: emailOf(registry)!,
        baseURL: publicUrl(opts, mount.base),
        mount: () => mount,
        policy: () => serving.policy,
      });
      outbox.start();
      console.log(`mistri: notifications are emailed through "${emailConfigOf(registry)!.name}"`);
    }
    await track(Promise.resolve(apiReadLifetimes.get(activeServer)?.prepare()));
    if (stopping) return undefined;

    /* While `--app` is on, the directory is live: a save takes effect on the
     next request, no restart. That is the authoring loop the app layer exists
     for (docs/apps.md) — an agent or a person iterating with the browser
     open. A save that does not load keeps the last good app being served and
     says why on stderr and on /api/app; the next good save wins. */
    /* The dedicated validation pass: open the app's own connection — the one
     deliberate eager open in a lazily-opening server, paid only with --app,
     because an app author is exactly the person a startup echo helps — and
     say every entry- and page-level reason on stderr, where the loop is
     watching. Non-fatal: the entries carry their reasons in the UI too, and
     an app scoped to a connection this server also serves must not take the
     others down. Fire-and-forget so a slow database never delays listen. */
    const echoAppWarnings = async (app: LoadedApp) => {
      try {
        const scoped = app.app.connection;
        const match = registry.list().find((c) => c.id === scoped || c.name === scoped);
        if (scoped && !match) {
          console.error(`App warning: ${app.path}: names connection "${scoped}", which this server does not have.`);
          return;
        }
        const resources = await loadAppRuntimeResources(registry, app.app, match?.id ?? registry.active!);
        resolveAppAccess(app.app, resources.schema, []);
        await learnValueLabels(app, resources.schema);
        for (const line of [
          ...appProblems(app, resources.schema),
          ...appAdvisories(app, resources.schema),
          ...appSignUpProblems(app.app, Boolean(emailConfigOf(registry))).map((warning) => `${app.path}: ${warning}`),
        ])
          console.error(`App warning: ${line}`);
      } catch (error) {
        console.error(`App warning: ${startupReport(error)}`);
      }
    };
    for (const loaded of loadedApps) void track(echoAppWarnings(loaded));

    /* One watcher per app directory. A reload swaps that app in place, then
     the served pages are rebuilt from the config file's own pages plus
     every app in order — a swap that only re-merged its own app would
     collide the others with themselves. A rebuild that collides (a reload
     introducing a page id another app holds) keeps the last good pages
     and carries the reason on that app, like any broken save. */
    const rebuildServedPages = () => {
      try {
        assertAppScopes(
          serving.apps.map((host) => host.app),
          (scope) => registry.list().find((connection) => connection.id === scope || connection.name === scope)?.id ?? scope,
        );
        serving.pages = serving.apps.reduce((pages, h) => mergeAppPages(pages, h.app, configPath), pagesBeforeApp);
        return undefined;
      } catch (err) {
        return (err as Error).message;
      }
    };
    for (const host of serving.apps) {
      /* A build is served as built: hot reload is the source's authoring loop,
       and a production server watches no files. */
      if (host.app.build) continue;
      /* The directory the app was loaded from, so pages/ reloads with it. */
      const appTarget = host.app.dir ?? host.app.path;
      // Its author, signed in on this machine, is told what a refusal was (refusalReport.ts).
      authoringApp(host.app.path);
      /* The pages open on it follow each save (appLive.ts). Not in a handler
         mounted in another server: a stream that never ends is that server's
         socket to spend. */
      if (!opts.embedded) {
        const live = (host.live = appLive());
        stopWatchers.push(() => live.close());
      }
      /* Reloads chain: a burst of saves used to start overlapping loads, and
       a worker taking its time meant the *older* read could finish last and
       win the swap. One at a time, in order, and the newest save is what
       ends up served. */
      let chain: Promise<void> = Promise.resolve();
      stopWatchers.push(
        watchApp(
          appTarget,
          () => {
            if (stopping) return;
            // Revoke before the candidate reload can await or publish. API hot
            // reload is restart-only even when browser presentation can reload.
            const retiringReads = apiReadLifetimes.get(activeServer)?.retire();
            if (opts.policy) {
              /* A row-policy App reloads like any other, with one difference: its
           data is refused from the moment of the save until the policy has
           started again for the new App, so a changed privacy declaration is
           never served beside the old one. */
              const withdraw = () => {
                const previous = serving.policy;
                serving.policy = undefined;
                serving.policyUnavailable = 'The App changed and is reloading. Try again in a moment.';
                if (previous && !retiredPolicies.has(previous)) {
                  retiredPolicies.add(previous);
                  void track(previous.retire().catch(() => console.error('Policy retirement failed; stop and restart the server.')));
                }
              };
              withdraw();
              chain = track(
                chain
                  .then(async () => {
                    await retiringReads;
                    if (stopping) return;
                    // A reload queued behind another withdraws the policy that one started.
                    withdraw();
                    const refuse = (notice: string, operator: string[]) => {
                      serving.policyUnavailable = notice;
                      host.loadError = operator[0];
                      for (const [index, line] of operator.entries()) console.error(index ? `  ${line}` : `App error: ${line}`);
                    };
                    const moved = moduleFiles.filter((_file, index) => moduleTexts()[index] !== startedModules[index]);
                    if (moved.length) {
                      return refuse(
                        "The App's row policy or commands changed. They are read once, at startup: restart the server to apply the change.",
                        [
                          `${moved.map((file) => basename(file)).join(' and ')} changed. A row policy and its commands are read once, at startup: ` +
                            'restart the server to apply the change. Its data is refused until then.',
                        ],
                      );
                    }
                    const candidate = { ...host };
                    if (!(await reloadApp(candidate, appTarget, pagesBeforeApp, configPath))) {
                      host.loadFailure = candidate.loadFailure;
                      if (candidate.unavailable) host.unavailable = candidate.unavailable;
                      return refuse(
                        candidate.unavailable
                          ? "The App's access or sign-in changed. Restart the server to apply the change."
                          : 'The App changed, and the change did not load. Its data is unavailable until the next good save.',
                        [
                          `${candidate.loadError ?? 'The App did not load.'} Its data is refused until ${candidate.unavailable ? 'a restart' : 'the next good save'}.`,
                        ],
                      );
                    }
                    if (!isRowPolicyApp(candidate.app.app)) {
                      return refuse('The App changed how it scopes rows. Restart the server to apply the change.', [
                        "The App no longer declares auth.rows: 'policy'. Restart the server without --policy to serve it.",
                      ]);
                    }
                    let policy: HttpAppPolicy;
                    try {
                      policy = await loadHttpAppPolicy({
                        registry,
                        app: candidate.app.app,
                        file: opts.policy!,
                        commands: commandHosting?.registry,
                        ...policyBindings,
                        components: () => candidate.app.components,
                        verifySession: withTenantApiRequests((request: IncomingMessage) => host.auth!.session(request)),
                      });
                    } catch (error) {
                      return refuse(
                        'The App changed, and its row policy could not start with it. Its data is unavailable until the next good save.',
                        [
                          `The row policy could not start with the changed App: ${(error as Error).message}`,
                          ...refusalReasons(error).map((reason) => `because: ${reason}`),
                          'Its data is refused until the next good save.',
                        ],
                      );
                    }
                    if (stopping) {
                      await policy.retire().catch(() => {});
                      return;
                    }
                    const before = { app: host.app, pages: host.pages };
                    host.app = candidate.app;
                    host.pages = candidate.pages;
                    host.loadError = undefined;
                    const collision = rebuildServedPages();
                    if (collision) {
                      host.app = before.app;
                      host.pages = before.pages;
                      rebuildServedPages();
                      await policy.retire().catch(() => {});
                      return refuse('The App changed, and the change did not load. Its data is unavailable until the next good save.', [
                        `${collision} Its data is refused until the next good save.`,
                      ]);
                    }
                    serving.policy = policy;
                    serving.policyUnavailable = false;
                    console.log(`mistri: app "${host.app.app.name}" reloaded from ${host.app.path}, its row policy started again`);
                    if (!stopping) void track(echoAppWarnings(host.app));
                  })
                  /* Good or broken, the pages open on it ask again (appLive.ts). */
                  .then(() => (stopping ? undefined : host.live?.announce(host)))
                  .catch(() => {
                    console.error('App reload failed; stop and restart the server.');
                  }),
              );
              return;
            }
            chain = track(
              chain
                .then(async () => {
                  await retiringReads;
                  if (stopping) return;
                  const before = { app: host.app, pages: host.pages };
                  // Database-backed command checks await: keep the candidate private until
                  // validation completes so generic routes cannot observe an invalid policy.
                  const candidate = { ...host };
                  const swapped = await reloadApp(candidate, appTarget, pagesBeforeApp, configPath);
                  if (stopping) return;
                  if (!swapped) {
                    host.loadError = candidate.loadError;
                    host.loadFailure = candidate.loadFailure;
                    if (candidate.unavailable) {
                      /* The App's authority changed: its requests stop until a restart
               (reloadApp), rather than serving either authority. */
                      host.unavailable = candidate.unavailable;
                      console.error(`App error: ${host.loadError}`);
                      return;
                    }
                    // The loader's own message names the file and the fix.
                    console.error(`App error: ${host.loadError} Still serving the last good app.`);
                    return;
                  }
                  let collision: string | undefined;
                  try {
                    if (isTenantApp(candidate.app.app)) {
                      serving.policyUnavailable = true;
                      throw new Error('Tenant applications are not enabled in public transports.');
                    }
                    if (isRowPolicyApp(candidate.app.app)) {
                      serving.policyUnavailable = true;
                      throw new Error('Row policies require restarting with --policy <file>.');
                    }
                    if (serving.commands) {
                      if (candidate.app.app.id !== serving.commands.appId)
                        throw new Error('A command application ID requires a server restart to change.');
                      const owner = appEntrypoint(candidate, registry);
                      if (!owner) throw new Error('The command application has no entry point.');
                      const releases: Array<() => void> = [];
                      try {
                        const resources = await loadAppRuntimeResources(registry, candidate.app.app, owner, (id) =>
                          releases.push(registry.lease(id)),
                        );
                        await validateBusinessCommandStartup(
                          candidate.app.app,
                          serving.commands.registry,
                          resources,
                          (id) => registry.configOf(id)?.writable === true,
                          serving.commands.events,
                        );
                      } finally {
                        for (const release of releases.reverse()) release();
                      }
                    } else if (appUsesCommands(candidate.app.app)) {
                      throw new Error('Business commands require restarting with --commands <file>.');
                    }
                    if (candidate.app.app.api && !serving.commands) {
                      const owner = appEntrypoint(candidate, registry);
                      if (!owner) throw new Error('The API application has no entry point.');
                      const releases: Array<() => void> = [];
                      try {
                        await loadAppRuntimeResources(registry, candidate.app.app, owner, (id) => releases.push(registry.lease(id)));
                      } finally {
                        for (const release of releases.reverse()) release();
                      }
                    }
                    if (stopping) return;
                    host.app = candidate.app;
                    host.pages = candidate.pages;
                    host.loadError = candidate.loadError;
                    collision = rebuildServedPages();
                  } catch {
                    collision =
                      'The reloaded app is incompatible with the registered commands or row policy. New access restrictions have NOT been activated. Stop the server and restart with a valid configuration.';
                  }
                  if (collision) {
                    /* The swap and the served pages move together or not at all. A
             manifest that loaded but collides on a page id another app holds
             goes back to the last good load — serving the new nav beside the
             old pages was the mixture `reloadApp` promises never to make. */
                    host.app = before.app;
                    host.pages = before.pages;
                    host.loadError = `${collision} Still serving the last good app.`;
                    rebuildServedPages();
                    console.error(`App error: ${host.loadError}`);
                    return;
                  }
                  console.log(`mistri: app "${host.app.app.name}" reloaded from ${host.app.path}`);
                  if (!stopping) void track(echoAppWarnings(host.app));
                })
                /* Good or broken, the pages open on it ask again (appLive.ts). */
                .then(() => (stopping ? undefined : host.live?.announce(host)))
                .catch(() => {
                  console.error('App reload failed; stop and restart the server.');
                }),
            );
          },
          undefined,
          () => [...componentWatchDirs(host.app), ...themeWatchDirs(host.app), ...(host.app.entry ? [dirname(host.app.entry)] : [])],
          () => loadedFiles(host.app),
        ),
      );
    }
    /* What a listening server starts once it listens: the jobs, analytics
       and the effects. A mounted handler starts them at once, because its
       host's server is already taking traffic. */
    const startBackground = (): boolean => {
      try {
        if (jobHost || inbound) {
          jobApp.current = () => serving.apps[0].app.app;
          for (const line of jobLines) console.log(`mistri: ${line}`);
          jobHost?.start();
        }
        /* Objects no row names (deleted records', refused uploads') are the sweep's: the jobs host runs it daily; without one, cron does. */
        for (const line of unsweptBuckets(
          loadedApps.map((loaded) => loaded.app),
          Boolean(jobHost),
        ))
          console.log(`mistri: ${line}`);
        analytics?.start();
        contactMail?.start();
        if (effectHost) {
          for (const line of effectLines) console.log(`mistri: ${line}`);
          effectHost.start();
        }
        return true;
      } catch {
        console.error('mistri: background workers could not start.');
        void exit(1);
        return false;
      }
    };
    if (opts.embedded) {
      if (!startBackground()) throw new Error('Background workers could not start.');
      listening = true;
      for (const host of serving.apps) console.log(`  ${host.app.app.name}: mounted at ${appHome(mount, host.app.app.id)}`);
      return { server: activeServer, mount, close: () => exit(0) };
    }
    /* A busy port is a normal thing, not a stack trace.

     `server.listen` with no error handler throws EADDRINUSE and takes the
     process down with a Node-internal trace — which is what happened when a
     second `mistri` met the first on 4111. So: if the port was the default
     and something is already there, roll on to the next one and say so; if it
     was named explicitly with --port, respect that and fail with one clear
     line rather than a guess the caller did not ask for. */
    const FIRST_PORT = opts.port;
    activeServer.on('error', (err: NodeJS.ErrnoException) => {
      if (stopping) {
        exitStatus = 1;
        return;
      }
      if (err.code === 'EADDRINUSE') {
        if (!withAuth.length && !opts.portGiven && opts.port - FIRST_PORT < 20) {
          console.log(`mistri: port ${opts.port} is in use, trying ${opts.port + 1}…`);
          opts.port += 1;
          setImmediate(() => {
            if (!stopping) activeServer.listen(opts.port, opts.host);
          });
          return;
        }
        console.error(
          `mistri: port ${opts.port} is already in use.` +
            (opts.portGiven ? ' Pick another with --port <n>.' : ' Give it a free one with --port <n>.'),
        );
        void exit(1);
        return;
      }
      console.error(`mistri: ${startupReport(err)}`);
      void exit(1);
    });
    activeServer.once('listening', () => {
      if (stopping) return;
      const address = activeServer.address();
      if (address && typeof address !== 'string') {
        opts.port = address.port;
        serving.bound.port = address.port;
      }
      if (!startBackground()) return;
      /* One question per database, once the pools are open and serving has not waited for it: whether this process's
         pools fit what the server allows. A warning only; a failed question says nothing. */
      void adviseConnectionLimits((line) => console.log(`mistri: warning: ${line}`));
      const shown = opts.host === '127.0.0.1' ? 'localhost' : opts.host;
      listening = true;
      console.log(`Listening on http://${shown}:${opts.port}${mount.base}`);
      observer?.listening(`http://${shown}:${opts.port}${mount.base}`);
      bench?.listening(`http://${shown}:${opts.port}${mount.base}`);
      /* The App's address, said where the person who started it is looking:
       where it is mounted (the root for one App, its id beside others), which
       is easy to guess wrong. */
      for (const host of serving.apps)
        console.log(`  ${host.app.app.name}: http://${shown}:${opts.port}${appHome(mount, host.app.app.id)}`);
      if (serving.apiReads) for (const host of serving.apps) console.log(apiServingLine(host.app.app, serving.apiReads));
      if (nothingToOpen) {
        /* Said here rather than left for the browser to explain, because
         somebody who meant to pass a database and mistyped the flag is
         looking at this terminal, not at the page. The config paths go with
         it for the same reason they go with the usage: "no connection" and
         "your config file is not where I looked" are the same sentence from
         the reader's side. */
        console.log('mistri: no connection yet — open the page and it will ask for one.');
        console.log(`  A config file would have been read from:\n    ${configLocations(opts.config).join('\n    ')}`);
      }
      for (const line of exposureLines(
        opts.host,
        serving.apps.map((host) => host.app.app),
        opts.authProxyHeader,
      ))
        console.log(line);
      if (opts.allowedHosts.length) {
        // Printed because it relaxes a security check, and a relaxed check that
        // nobody can see in the log is one nobody remembers turning on.
        console.log(`mistri: also answering writes for host ${opts.allowedHosts.join(', ')}`);
      }
      for (const line of proxyIdentityLines(opts.host, opts.authProxyHeader, opts.authProxies)) console.log(line);
      if (opts.trustProxyHops !== undefined) {
        console.log(
          `mistri: the client address is ${opts.trustProxyHops} place(s) from the right of X-Forwarded-For, for rate limits and sign-in lockout`,
        );
      }
      if (opts.trustProxyCloudflare) {
        console.log('mistri: the client address is CF-Connecting-IP; keep this server reachable through Cloudflare only');
      }
      if (opts.trustedProxies?.length) {
        console.log(
          `mistri: the public form rate limit reads X-Forwarded-For from ${opts.trustedProxies.map((range) => range.text).join(', ')} as well as loopback`,
        );
      }
      /* MISTRI_OPEN, when set, has the last word on the browser. The desktop
       app runs this server as a child and shows the page in its own window, so
       it sets MISTRI_OPEN='' — a second copy opening in Safari or Chrome
       alongside the window is a bug, not a courtesy. An explicit empty (or
       0/false) suppresses the open whatever asked for it — the flag, --demo,
       anything; '1'/'true' forces it. Unset leaves the flags in charge. */
      const envOpen = process.env.MISTRI_OPEN;
      const wantOpen = envOpen === undefined ? opts.open : !(envOpen === '' || envOpen === '0' || envOpen.toLowerCase() === 'false');
      if (wantOpen) void openBrowser(`http://${shown}:${opts.port}${mount.base || ''}${mount.base ? '/' : ''}`);
    });
    activeServer.listen(opts.port, opts.host);
    return undefined;
  } catch (error) {
    // An acquisition rejected before readiness, even if a signal also arrived.
    // A drained successful acquisition exits cleanly via the stopping checks;
    // interrupted/failed readiness is not reported as successful startup.
    if (stopping) {
      await exit(1);
      if (opts.embedded) throw error;
      return undefined;
    }
    if (error !== said)
      console.error(
        serving.apiReads
          ? 'API startup error: API readiness could not be established.'
          : `Server startup error: ${error instanceof Error ? startupReport(error) : 'The server could not start.'}`,
      );
    await exit(1);
    if (opts.embedded) throw error;
    return undefined;
  }
}
