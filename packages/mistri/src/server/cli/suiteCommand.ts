/** The initial suite CLI serves explicit independent App deployments. */
import { slug } from '@mistriwork/engine/shared/slug.js';
import { configureWriteOrder } from '@mistriwork/engine/adapters/writeLanes.js';
import { isTenantApp, isRowPolicyApp, isFormView, isPublicForm } from '../../shared/app.js';
import { appUsesCommands } from '../../shared/appCommandIds.js';
import { configureFormKey } from '../forms/formKey.js';
import { appMounts, appHome, segmentsTakenFrom } from '@mistriwork/engine/shared/mount.js';
import { mountClashes } from '../../shared/appAddress.js';
import { emailProblems } from '../email/outbox.js';
import { nativeMailAccount } from '../auth/authAccounts.js';
import { suiteAppRoles } from '../auth/suiteAppRoles.js';
import { assertAppSearch } from '../app/appSearchRuntime.js';
import { assertApiReadStartupComposition } from './api-read-startup-options.js';
import { configurePublicFormLimits } from '@mistriwork/engine/server/http/rateLimit.js';
import { configureSignInState } from '../auth/signInState.js';
import { loadApp, appProblems, appRoutes, type LoadedApp } from '../app/apps.js';
import { appEntrypoint } from '../app/appEntrypoint.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import type { CommandHosting } from '../http/appContext.js';
import { expandEnv } from '@mistriwork/engine/server/auth/credentials.js';
import { openWebhook } from '../webhooks.js';
import type { Webhook } from '../commands/commandEffects.js';
import { decisionsDirectoryOf, hostAppCommands, readinessOf, type AppCommandHost } from './commandHost.js';
import { assertHttpRowPolicyApp, type HttpAppPolicy } from '../policy/appPolicyHttp.js';
import { Registry, loadConfig } from '@mistriwork/engine/server/connections.js';
import { createSuite } from '../http/suite.js';
import { openSuiteApp } from '../http/suiteApp.js';
import { openSuiteTenant } from '../http/suiteTenant.js';
import type { FlagRequestRuntime } from '../flags/requestRuntime.js';
import { readSuiteConfiguration, type SuiteConfiguration } from './suiteConfig.js';
import { assertBuildEntries } from './apps.js';
import { openSuiteIdentity } from '../auth/suiteIdentity.js';
import { runSuiteGrantCommand } from './suiteGrant.js';
import { createSuiteLinkCatalog, type SuiteLinkCatalog } from '../app/suiteLinks.js';
import { suiteLinkHttp, type SuiteLinkHost } from '../auth/suiteLinkHttp.js';
import { captureAppFlagCatalog } from '../flags/appCatalog.js';
import { resolveExperimentSource } from '../experiments/sourceConfiguration.js';
import { loadExperimentConversions } from '../experiments/loader.js';
import { consoleIdentityRegistration, openSuiteConsole } from '../console/host.js';
import { consoleStoreStatuses } from '../console/operations.js';
import { consoleCommandAudit } from '../console/governance.js';
import { suiteGovernance } from '../console/suiteGovernance.js';
import { nativeAccountEmailOf } from '../auth/authAccounts.js';
import { captureSuitePlacementPolicy, createSuitePublicPlacement } from './suitePublicPlacement.js';
import { webhookConfigOf } from '../serviceConnections.js';
import { CONFIG_SECTIONS } from '../serviceConnections.js';

const SUITE_USAGE = 'mistri suite <suite.json>';

/* An App entry is loaded as `mistri serve --app <dir> --commands <file>` loads one: a source directory with the
   named module (or its commands.ts), and a `mistri build` with its own bundled entries, each still named, never
   inferred (apps.ts assertBuildEntries) — a build's commands module is its server/commands.mjs, at the versions its
   authority.lock holds, as serve's hostCommands reads it. */
async function loadSuiteApp(deployment: SuiteConfiguration['apps'][number]): Promise<LoadedApp> {
  const { commands, jobs, policy } = deployment;
  const where = `Suite App "${deployment.id}"`;
  let app: LoadedApp;
  try {
    app = await loadApp(deployment.directory, { lock: 'enforce', ...(commands === undefined ? {} : { commands }) });
    if (!app.build) return app;
    assertBuildEntries({ commands, jobs, policy }, [app]);
  } catch (error) {
    throw new Error(`${where}: ${(error as Error).message}`, { cause: error });
  }
  if (commands === undefined) return app;
  const [{ loadBusinessCommands }, { withCommandVersions }, { lockedVersion }] = await Promise.all([
    import('../commands/businessCommandLoader.js'),
    import('../commands/businessCommands.js'),
    import('../commands/commandContracts.js'),
  ]);
  return {
    ...app,
    commands: { file: commands, registry: withCommandVersions(await loadBusinessCommands(commands), lockedVersion(app.authority?.lock)) },
  };
}

export async function startConfiguredSuite(file: string, environment: NodeJS.ProcessEnv = process.env) {
  const config = await readSuiteConfiguration(file, environment);
  if (config.experiments && !config.experiments.assignmentKey)
    throw new Error('Experiment analytics requires an explicit dedicated assignmentKeyEnv key.');
  const placements = createSuitePublicPlacement(config);
  const consoleRegistration = config.console?.enabled ? consoleIdentityRegistration(config.basePath) : undefined;
  const addresses = {
    base: config.basePath,
    mounts: Object.fromEntries(config.apps.map((app) => [app.id, app.mount])),
    publicOrigin: config.publicOrigin,
    hosts: config.hosts,
  };
  const mount = appMounts(
    config.apps.map((app) => app.id),
    addresses,
  );
  const apps: Array<{
    deployment: (typeof config.apps)[number];
    app: Awaited<ReturnType<typeof loadApp>>;
    connections: NonNullable<Awaited<ReturnType<typeof loadConfig>>>['connections'];
    services: NonNullable<Awaited<ReturnType<typeof loadConfig>>>['services'];
    publicSurface: boolean;
    flagGraph: ReturnType<typeof captureAppFlagCatalog>;
    experimentConversions: Awaited<ReturnType<typeof loadExperimentConversions>> | undefined;
    analytics?: NonNullable<Awaited<ReturnType<typeof loadConfig>>>['analytics'];
  }> = [];
  // No registry or session store opens until every declaration is accepted.
  for (const deployment of config.apps) {
    const app = await loadSuiteApp(deployment);
    const flagGraph = captureAppFlagCatalog(app.app, app.commands?.registry);
    const experimentConversions =
      config.experiments && Object.keys(flagGraph.experiments).length
        ? await loadExperimentConversions(app.commands?.file ?? '', app.commands!.registry)
        : undefined;
    if (app.app.id !== deployment.id) throw new Error(`Suite id "${deployment.id}" does not match its App id "${app.app.id}".`);
    const noBucket = (await import('../files/fileStorage.js')).bucketCredentialsProblem([app.app]);
    if (noBucket) throw new Error(`Suite App "${deployment.id}": ${noBucket}`);
    /* An API declaration is inert until the deployment opts in, as it is for
       serve without --api-reads. Opted in, serve's own rules apply; a suite
       adds two of its own: scoped tokens are minted against the App's own
       sign-in store, which shared identity replaces, and the API answers only
       on loopback, which a public origin or host mapping does not. */
    if (deployment.api) {
      if (!app.app.api) throw new Error(`Suite App "${deployment.id}": "api" serves an App's declared API, and this App declares none.`);
      if (config.identity)
        throw new Error(
          `Suite App "${deployment.id}": API tokens belong to the App's own sign-in store, and shared identity replaces it; serve this App's API from its own server.`,
        );
      if (config.publicOrigin || config.hosts?.length)
        throw new Error(
          `Suite App "${deployment.id}": the local read API answers only on loopback, as serve's --api-reads does, so it cannot be served beside a publicOrigin or host mapping.`,
        );
      if (isTenantApp(app.app))
        throw new Error(
          `Suite App "${deployment.id}": a tenant App's API is served by its own tenant host under its policy, which the suite's tenant runtime does not mount.`,
        );
    }
    const formViews = Object.values(app.app.views).filter(isFormView);
    const publicSurface = Boolean(app.app.auth?.public || formViews.some(isPublicForm) || app.app.landing);
    if (config.hosts?.some((host) => host.app === deployment.id) && !publicSurface) {
      throw new Error(`Suite App "${deployment.id}": host mappings require a declared public surface.`);
    }
    const tenant = isTenantApp(app.app);
    // At the root, a tenant App's own sign-in and membership routes are the shared identity's sign-in and chooser routes.
    if (tenant && !deployment.mount && config.identity) {
      throw new Error(
        `Suite App "${deployment.id}": a tenant App at the root of a suite with shared identity would answer the suite's sign-in and App chooser routes with its own; mount it at a sub-App path.`,
      );
    }
    if ((isRowPolicyApp(app.app) || tenant) !== Boolean(deployment.policy)) {
      throw new Error(`Suite App "${deployment.id}" requires a policy file exactly when auth.rows is "policy" or "tenant".`);
    }
    if (deployment.policy && !tenant) assertHttpRowPolicyApp(app.app, Boolean(app.commands));
    if (appUsesCommands(app.app) && !app.commands)
      throw new Error(
        `Suite App "${deployment.id}" needs its registered commands module: commands.ts beside its manifest, or "commands" (a build's server/commands.mjs).`,
      );
    if (deployment.jobs && !app.commands) throw new Error(`Suite App "${deployment.id}": jobs need registered commands.`);
    // Shared identity owns sign-in: an App's door offers only what the suite's one sign-in has.
    const suiteProviders = config.identity?.providers ?? ['email'];
    if (config.identity && (!app.app.auth || app.app.auth.providers.some((provider) => !suiteProviders.includes(provider)))) {
      throw new Error(
        `Suite App "${deployment.id}": with shared identity an App signs people in through the suite's providers (${suiteProviders.join(', ')}), and this App ${app.app.auth ? `names ${app.app.auth.providers.filter((provider) => !suiteProviders.includes(provider)).join(', ')}` : 'has no sign-in'}.`,
      );
    }
    if (!config.identity && app.app.auth && !app.app.auth.store && !deployment.environment.XDG_CONFIG_HOME) {
      throw new Error(`Suite App "${deployment.id}" must declare auth.store or map XDG_CONFIG_HOME explicitly.`);
    }
    // The App's config file is read as serve reads it: its connections, its services and its analytics.
    const connections = await loadConfig(deployment.config, CONFIG_SECTIONS);
    if (!connections || !connections.connections.length)
      throw new Error(`Suite App "${deployment.id}" needs database or HTTP connections.`);
    const federated = connections.services.find((service) => service.kind === 'oidc' || service.kind === 'saml');
    if (config.identity && federated) {
      throw new Error(
        `Suite App "${deployment.id}": an "${federated.kind}" service signs people in to one App, and the suite's shared identity owns sign-in; declare the provider under the suite identity's "providers".`,
      );
    }
    const problem = emailProblems(
      app.app,
      connections.services.some((service) => service.kind === 'email'),
    );
    if (problem) throw new Error(`Suite App "${deployment.id}": ${problem}`);
    if (connections.analytics && config.analytics) {
      throw new Error(
        `Suite App "${deployment.id}": its config file binds "analytics" and so does the suite; a suite's analytics store is one, so bind it in one place.`,
      );
    }
    apps.push({
      deployment,
      app,
      connections: connections.connections,
      services: connections.services,
      publicSurface,
      flagGraph,
      experimentConversions,
      ...(connections.analytics ? { analytics: connections.analytics } : {}),
    });
  }
  const analyticsApp = config.analytics && (config.analytics.app ?? config.apps[0].id);
  if (config.analytics) {
    const target = apps.find((each) => each.deployment.id === analyticsApp)!.app.app;
    if (isTenantApp(target)) throw new Error(`Suite App "${analyticsApp}": analytics for tenant Apps is not available yet.`);
    if (!target.analytics) throw new Error(`Suite analytics names App "${analyticsApp}", which declares no \`analytics\`.`);
  }
  // An App's own config file may bind its analytics, as it does for serve, by the same rules.
  for (const each of apps) {
    if (!each.analytics) continue;
    if (each.analytics.app !== undefined && each.analytics.app !== each.deployment.id)
      throw new Error(`Suite App "${each.deployment.id}": its "analytics" names App "${each.analytics.app}".`);
    if (isTenantApp(each.app.app)) throw new Error(`Suite App "${each.deployment.id}": analytics for tenant Apps is not available yet.`);
  }
  /* The public forms' budgets are one per process, for serve as here: with a
     cache named they are counted there, so every instance spends one budget.
     Two Apps naming two caches would split that one budget, which only a
     suite could do, so the caches its Apps name must be the same one. */
  const caches = apps.flatMap(({ deployment, services }) =>
    services.flatMap((service) => (service.kind === 'cache' ? [{ deployment, service }] : [])),
  );
  if (new Set(caches.map(({ deployment, service }) => expandEnv(service.url, deployment.environment))).size > 1) {
    throw new Error(
      'Suite Apps name different cache services; a suite counts its public-form budgets and sign-in lockouts in one, so every App that names a cache must name the same one.',
    );
  }
  const cacheOwner = caches.length ? new Registry({ environment: caches[0].deployment.environment }) : undefined;
  if (cacheOwner) {
    cacheOwner.addService(caches[0].service);
    const namespace = `suite:${config.identity?.id ?? apps.map((each) => each.deployment.id).join('+')}`;
    configurePublicFormLimits(cacheOwner.cache(), namespace);
    configureSignInState(cacheOwner.cache(), namespace);
  }
  const releaseCache = async () => {
    if (!cacheOwner) return;
    configurePublicFormLimits(undefined, '');
    configureSignInState(undefined, '');
    await cacheOwner.cache().close();
  };
  configureWriteOrder('keyed');
  // Each App's keyed form inputs hash under the key its own environment maps, never the process's (formKey.ts).
  const formKeys = apps.map(({ deployment }) => configureFormKey(deployment.id, deployment.environment));
  const releaseFormKeys = () => {
    for (const release of formKeys) release();
    return releaseCache();
  };
  const publicURL = config.publicOrigin ?? `http://127.0.0.1:${config.port}`;
  const identity = config.identity
    ? await openSuiteIdentity(config, [
        ...apps.map(({ deployment, app, connections }) => ({
          app,
          connections,
          environment: deployment.environment,
          basePath: appHome(mount, app.app.id).replace(/\/$/, ''),
        })),
        ...(consoleRegistration ? [consoleRegistration] : []),
      ])
    : undefined;
  const linkHosts = new Map<string, SuiteLinkHost>();
  let linkCatalog: SuiteLinkCatalog | undefined,
    linkActive = false;
  const routing = identity && {
    ...identity,
    route(req: Parameters<typeof identity.route>[0], res: Parameters<typeof identity.route>[1]) {
      let path: string;
      try {
        path = new URL(req.url ?? '/', publicURL).pathname;
      } catch {
        return undefined;
      }
      if (path === `${config.basePath}/api/suite/links/resolve` && linkCatalog)
        return suiteLinkHttp(req, res, {
          native: identity.native,
          catalog: linkCatalog,
          hosts: linkHosts,
          current: () => linkActive,
          bound: { host: '127.0.0.1', port: config.port, allowedHosts: config.publicOrigin ? [new URL(config.publicOrigin).hostname] : [] },
        });
      return identity.route(req, res);
    },
    close() {
      linkActive = false;
      identity.close();
    },
  };
  let suite: Awaited<ReturnType<typeof createSuite>>;
  try {
    suite = await createSuite(
      apps.map(({ deployment, app, connections, services: deploymentServices, publicSurface, analytics: own }) => ({
        id: deployment.id,
        public: publicSurface,
        open: async (basePath: string, { allowedHosts }: { allowedHosts: readonly string[] }) => {
          const publicPlacement = await placements?.forApp(app.app, deployment.policy, basePath);
          if (publicPlacement) await captureSuitePlacementPolicy(deployment.policy!, publicPlacement.policyRevision);
          if (isTenantApp(app.app)) {
            // The tenant App's services — its email for mail, its search engine — as `mistri tenant` has them; never its data.
            const configured = connections.map((connection) => ({
              ...connection,
              id: slug(connection.name, 'connection'),
              source: 'config' as const,
            }));
            const services = new Registry({ environment: deployment.environment });
            let child: Awaited<ReturnType<typeof openSuiteTenant>>;
            try {
              for (const connection of configured) services.add(connection);
              for (const service of deploymentServices) services.addService(service);
              assertAppSearch([app.app], services);
              child = await openSuiteTenant({
                registry: services,
                app,
                connections: configured,
                policyFile: deployment.policy!,
                jobsFile: deployment.jobs,
                environment: deployment.environment,
                basePath,
                publicURL,
                port: config.port,
                allowedHosts,
                suiteAuth: identity?.forApp(app, basePath),
                ...(identity ? { accountEmail: (accountId: string) => nativeAccountEmailOf(identity.native, accountId) } : {}),
              });
            } catch (error) {
              await services.closeAll();
              throw error;
            }
            if (child.links) linkHosts.set(deployment.id, child.links);
            return child;
          }
          const registry = new Registry({ environment: deployment.environment });
          try {
            for (const connection of connections) registry.add({ ...connection, source: 'config' });
            for (const service of deploymentServices) registry.addService(service);
            // A search names a search connection the config has, said at startup, as serve says it.
            assertAppSearch([app.app], registry);
            const owner = appEntrypoint({ app, pages: app.pages }, registry);
            if (!owner) throw new Error(`Suite App "${deployment.id}" has no entry connection.`);
            const resources = await loadAppRuntimeResources(registry, app.app, owner);
            const problems = [
              ...appProblems(app, resources.schema),
              ...mountClashes(appRoutes(app, resources.schema), segmentsTakenFrom(mount, app.app.id)),
            ];
            if (problems.length) throw new Error(problems.join('\n'));
            const locate = (id: string) => {
              const url = registry.configOf(id)?.url;
              return url === undefined ? undefined : expandEnv(url, deployment.environment);
            };
            // The App's commands, effects, jobs and inbound endpoints, hosted exactly as `mistri serve` hosts them.
            let flagRuntime: FlagRequestRuntime | undefined;
            let servedPolicy: HttpAppPolicy | undefined;
            let hosted: AppCommandHost | undefined;
            try {
              hosted =
                app.commands &&
                (await hostAppCommands({
                  app: app.app,
                  commands: app.commands.registry,
                  registry,
                  owner,
                  ...(deployment.policy ? { policy: () => servedPolicy } : {}),
                  jobsFile: deployment.jobs,
                  environment: deployment.environment,
                  locate,
                  current: () => app.app,
                  flagRuntime: () => flagRuntime,
                  ...decisionsDirectoryOf(app),
                }));
            } catch (error) {
              throw new Error(`Suite App "${deployment.id}": ${(error as Error).message}`, { cause: error });
            }
            const commands: CommandHosting | undefined = hosted?.commandHosting;
            const jobs = readinessOf(hosted?.jobHost, hosted?.effectHost),
              inbound = hosted?.inbound;
            const background = [hosted?.jobHost, hosted?.effectHost].filter((owner) => owner !== undefined);
            const analytics = config.analytics && analyticsApp === deployment.id ? config.analytics : own;
            // The Console's Operations room: this App's queues, workflows and store layouts, as its hosts hold them.
            const operations = {
              ...(hosted?.jobHost ? { jobs: hosted.jobHost.queue.jobs } : {}),
              ...(hosted?.jobHost?.workflows ? { workflows: hosted.jobHost.workflows } : {}),
              deliveries: [...(hosted?.jobHost?.queue.deliveries ?? []), ...(hosted?.effectHost?.deliveries ?? [])],
              stores: consoleStoreStatuses(() => [
                ...registry
                  .configs()
                  .filter((connection) => !connection.http)
                  .map((connection) => ({ name: connection.name, url: locate(connection.id) })),
                ...(analytics ? [{ name: 'analytics', url: analytics.store }] : []),
              ]),
              governance: suiteGovernance({
                app,
                book: appRoutes(app, resources.schema),
                bookFor: (roles) => appRoutes(app, resources.schema, undefined, roles),
                tables: resources.schema.tables,
                basePath,
                startedAt: Date.now(),
                audit: consoleCommandAudit(app.app.id, () =>
                  registry
                    .configs()
                    .filter((connection) => !connection.http)
                    .map((connection) => ({ name: connection.name, url: locate(connection.id) })),
                ),
                ...(identity
                  ? {
                      identity: {
                        native: identity.native,
                        grants: identity.grants,
                        authority: identity.authority,
                        basePath: config.basePath,
                      },
                    }
                  : {}),
              }),
            };
            const apiReads = deployment.api && {
              ...deployment.api,
              engine: assertApiReadStartupComposition([app], registry.configs(), Boolean(app.commands)),
            };
            const notifications = {
              mount: () => mount,
              ...(identity
                ? {
                    account: async (email: string) => {
                      // Shared identity: the suite's account, with the roles this App granted it, never the native account's own role.
                      const found = await nativeMailAccount(identity.native, email);
                      const granted = found && (await identity.grants.read(found.id, app.app.id)),
                        allowed = suiteAppRoles(app.app);
                      return found && granted?.roles.length && granted.roles.every((role) => allowed.includes(role))
                        ? { id: found.id, roles: granted.roles }
                        : null;
                    },
                  }
                : {}),
            };
            const child = await openSuiteApp({
              registry,
              app,
              commands,
              jobs,
              inbound,
              ...(background.length ? { background } : {}),
              basePath,
              publicURL,
              environment: deployment.environment,
              ...(apiReads ? { apiReads } : {}),
              notifications,
              operations,
              ...(analytics
                ? {
                    analytics: async ({ subject }) => {
                      const opened = new Map<string, Webhook>();
                      return (await import('../analytics/host.js')).openAnalyticsHost({
                        configuration: analytics,
                        app,
                        environment: analytics.deploymentId,
                        mount: basePath,
                        bound: { host: '127.0.0.1', port: config.port, allowedHosts },
                        subject,
                        variables: deployment.environment,
                        webhook: (name) => {
                          const service = opened.has(name) ? undefined : webhookConfigOf(registry, name);
                          if (service) opened.set(name, openWebhook(service));
                          return opened.get(name);
                        },
                        onSinkError: (sink, message) => console.error(`mistri: analytics sink "${sink}": ${message}`),
                      });
                    },
                  }
                : {}),
              onFlagRuntime: (runtime) => {
                flagRuntime = runtime;
              },
              linkCatalog: {
                app: app.app,
                pages: app.pages,
                surfaces: [{ realm: 'app', schema: resources.schema, book: appRoutes(app, resources.schema) }],
              },
              policyFile: deployment.policy,
              ...(hosted?.jobPrincipals.size ? { policyServices: hosted.jobPrincipals } : {}),
              onPolicy: (policy) => {
                servedPolicy = policy;
              },
              publicPlacement,
              bound: { host: '127.0.0.1', port: config.port, allowedHosts },
              suiteAuth: identity?.forApp(app, basePath),
            });
            if (child.links) linkHosts.set(deployment.id, child.links);
            return child;
          } catch (error) {
            await registry.closeAll();
            throw error;
          }
        },
      })),
      addresses,
      routing,
      config.flags
        ? {
            suiteId: config.identity!.id,
            store: config.flags.store,
            environment: config.flags.environment,
            deploymentId: config.flags.deploymentId,
            bound: {
              host: '127.0.0.1',
              port: config.port,
              allowedHosts: config.publicOrigin ? [new URL(config.publicOrigin).hostname] : [],
            },
            consoleEnabled: Boolean(consoleRegistration),
            ...(config.experiments
              ? {
                  experiments: {
                    store: config.experiments.store,
                    deploymentId: config.experiments.deploymentId,
                    assignmentKey: config.experiments.assignmentKey!,
                    sources: (config.experiments.sources ?? []).map((source) => {
                      const owner = apps.find((owner) => owner.app.app.id === source.appId);
                      if (!owner) throw new Error('Experiment source App is not deployed.');
                      return resolveExperimentSource(source, {
                        app: owner.app.app,
                        connections: owner.connections,
                        environment: owner.deployment.environment,
                      });
                    }),
                    secureCookies: config.publicOrigin?.startsWith('https:') ?? false,
                    targets: new Map(
                      apps
                        .filter((app) => app.experimentConversions)
                        .map((app) => [app.app.app.id, { graph: app.flagGraph, conversions: app.experimentConversions! }]),
                    ),
                  },
                }
              : {}),
            openConsole: consoleRegistration
              ? async ({ targets, operations }) => {
                  const owner = await openSuiteConsole({
                    registration: consoleRegistration,
                    suiteBase: config.basePath,
                    suiteAuth: identity!.forApp(consoleRegistration.app, consoleRegistration.basePath),
                    bound: {
                      host: '127.0.0.1',
                      port: config.port,
                      allowedHosts: config.publicOrigin ? [new URL(config.publicOrigin).hostname] : [],
                    },
                    targets,
                    operations,
                    guardedChange: (session, input, fence) => session.change(input, fence),
                  });
                  return {
                    start: owner.start,
                    stop: owner.stop,
                    close: owner.close,
                    route: (req, res) =>
                      new Promise<void>((resolve, reject) => {
                        const cleanup = () => {
                          res.off('finish', finish);
                          res.off('close', finish);
                          res.off('error', failed);
                        };
                        const finish = () => {
                          cleanup();
                          resolve();
                        };
                        const failed = (error: unknown) => {
                          cleanup();
                          reject(error);
                        };
                        res.once('finish', finish);
                        res.once('close', finish);
                        res.once('error', failed);
                        try {
                          owner.server.emit('request', req, res);
                        } catch (error) {
                          failed(error);
                        }
                      }),
                  };
                }
              : undefined,
          }
        : undefined,
    );
  } catch (error) {
    identity?.close();
    await releaseFormKeys();
    throw error;
  }
  try {
    linkCatalog = createSuiteLinkCatalog(
      [...linkHosts.values()].map((host) => host.catalog),
      mount,
    );
    linkActive = true;
    await new Promise<void>((resolve, reject) => {
      suite.server.once('error', reject);
      suite.server.listen(config.port, '127.0.0.1', () => {
        suite.server.off('error', reject);
        resolve();
      });
    });
    await suite.start();
    return {
      ...suite,
      publicURL,
      close: () => {
        linkActive = false;
        return suite.close().finally(releaseFormKeys);
      },
    };
  } catch (error) {
    linkActive = false;
    await suite.close().finally(releaseFormKeys);
    throw error;
  }
}

export async function runSuiteCommand(args: string[]): Promise<void> {
  if (args[0] === 'grant' || args[0] === 'revoke') return runSuiteGrantCommand(args);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(
      `${SUITE_USAGE}\nServe a local suite with per-App authorization.\nUse suite grant|revoke <suite.json> --app <id> --subject <id> --revision <number> [--roles <roles>] [--actor <name>] for explicit operator grants. See the suites guide.`,
    );
    return;
  }
  if (args.length !== 1 || args[0].startsWith('-')) throw new Error(`Expected ${SUITE_USAGE}`);
  let suite: Awaited<ReturnType<typeof startConfiguredSuite>>;
  try {
    suite = await startConfiguredSuite(args[0]);
  } catch (error) {
    // A store behind its layout is the one refusal with a command to say.
    const { storesBehind, storesUpCommand } = await import('../stores/storesCli.js');
    const behind = await storesBehind({
      registry: new Registry(),
      config: {} as never,
      schemas: [],
      suite: args[0],
      sections: CONFIG_SECTIONS,
    });
    if (behind.length) {
      throw new Error(
        `${(error as Error).message}\nStores behind their layout: ${behind.join('; ')}.\nBring them forward with: ${storesUpCommand({ suite: args[0] })}`,
      );
    }
    throw error;
  }
  const stop = () => {
    void suite
      .close()
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      })
      .finally(() => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  suite.server.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
    stop();
  });
  console.log(`Suite listening on ${suite.publicURL}${suite.mount.base}/`);
}
