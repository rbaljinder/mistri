/** Startup for one independently configured App inside a suite. The caller
 * supplies an already loaded definition and a dedicated registry; neither
 * App code nor secrets are installed into the process environment. */
import { isDeepStrictEqual } from 'node:util';
import { createAppAuth, captureAppAuthRuntime, assertAppAuthStoreSeparation, type AppAuthRuntime } from '../auth/auth.js';
import { signInOf } from '../../shared/app.js';
import type { AppHost, LoadedApp } from '../app/apps.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../policy/appPolicyHttp.js';
import { ensureAppRecordHistory, historyRules } from '../recordHistory.js';
import { ensureAppLive } from '../live/liveBinding.js';
import { closeDevClientHmr, retireDevClient } from '@mistriwork/engine/server/devclient.js';
import { apiReadLifetimes, commandOperations, createApp } from './server.js';
import type { SuiteHost } from './suite.js';
import type { SuiteLinkApp } from '../app/suiteLinks.js';
import { captureAppFlagCatalog } from '../flags/appCatalog.js';
import { captureHttpPublicPlacement, type HttpPublicPlacementOptions } from './publicPlacement.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AnalyticsHost } from '../analytics/host.js';
import { createFlagRequestRuntime, type FlagRequestRuntime } from '../flags/requestRuntime.js';
import { bindFlagHttpServer, flagHttpRequest, withFlagHttpRequest } from '../flags/httpRuntime.js';
import { getTenantHostIntent } from './tenantHosts.js';
import { HttpError } from '@mistriwork/engine/server/http/reply.js';
import { appEntrypoint } from '../app/appEntrypoint.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { experimentPublicSelection } from '../experiments/publicSelection.js';
import { isPublicForm } from '../../shared/app.js';
import { resolveAppAccess } from '../../shared/app.js';
import { appKeepsInbox, ensureAppInbox } from '../inbox.js';
import { appSendsEmail, createEmailOutbox, type MailAccount } from '../email/outbox.js';
import { appEmailsContacts, contactMailPlaces, openContactMail } from '../email/contactMail.js';
import { UNSUBSCRIBE_PATH } from '../email/unsubscribe.js';
import { expandEnv, expandEnvReferences } from '@mistriwork/engine/server/auth/credentials.js';
import { sqliteAuthExclusions } from '../auth/sqliteStoreIdentity.js';
import { contactEmailFindings } from '../integrations/integrationChecks.js';
import type { AddressMount } from '@mistriwork/engine/shared/mount.js';
import type { ConsoleOperationsOwner } from '../console/operations.js';
import { emailConfigOf, emailOf, identityProvidersOf, oauthServerOf } from '../serviceConnections.js';

type AppOptions = Parameters<typeof createApp>[0];

export async function openSuiteApp(
  options: Omit<AppOptions, 'apps' | 'addresses' | 'policy' | 'ready' | 'sourceClient'> & {
    app: LoadedApp;
    basePath: string;
    publicURL: string;
    environment: NodeJS.ProcessEnv;
    policyFile?: string;
    /** The jobs module's principals the row policy must name, and where the jobs learn the policy they run under. */
    policyServices?: ReadonlyMap<string, readonly string[]>;
    onPolicy?: (policy: HttpAppPolicy) => void;
    publicPlacement?: HttpPublicPlacementOptions;
    /** App-scoped projection of the suite's native session, owned by this child. */
    suiteAuth?: AppAuthRuntime;
    linkCatalog?: SuiteLinkApp;
    background?: ReadonlyArray<{ start(): void; stop(): Promise<void> }>;
    /** Behavior analytics for this App, opened once its session owner exists (packages/mistri/src/server/analytics/host.ts). */
    analytics?: (own: { subject: (req: IncomingMessage) => Promise<string | null> }) => Promise<AnalyticsHost>;
    onFlagRuntime?: (runtime: FlagRequestRuntime) => void;
    /** What the Console's Operations room reaches of this App: its hosts' queues and workflows, and its store layouts. */
    operations?: Omit<ConsoleOperationsOwner, 'appId' | 'name' | 'app' | 'auth' | 'analytics'>;
    /** Where the App's mailed notifications link to, and who an address signs in as when the suite owns sign-in. */
    notifications?: {
      mount: () => AddressMount;
      account?: (email: string) => Promise<MailAccount | null>;
    };
  },
): Promise<Omit<SuiteHost, 'id'>> {
  const {
    app,
    registry,
    basePath,
    publicURL,
    environment,
    policyFile,
    policyServices,
    onPolicy,
    publicPlacement,
    suiteAuth,
    linkCatalog,
    background: givenBackground = [],
    onFlagRuntime,
    analytics: openAnalytics,
    notifications,
    operations,
    ...http
  } = options;
  const background = [...givenBackground];
  let analyticsBeacon: AnalyticsHost['beacon'] | undefined, analyticsStore: AnalyticsHost['store'] | undefined;
  const placement = publicPlacement && captureHttpPublicPlacement(publicPlacement);
  const flagCatalog = captureAppFlagCatalog(app.app, app.commands?.registry),
    flagAppId = app.app.id;
  const host: AppHost = { app, pages: app.pages };
  let server: ReturnType<typeof createApp> | undefined;
  let policy: HttpAppPolicy | undefined;
  let stopping = false,
    stopped: Promise<void> | undefined,
    closed: Promise<void> | undefined;
  let flags: FlagRequestRuntime | undefined, values: ReturnType<FlagRequestRuntime['valuesHttp']> | undefined;
  let flagCurrent = () => {};
  const assertCurrent = () => {
    flagCurrent();
    if (stopping) throw new HttpError(503, 'App is stopping.');
  };
  const stop = () => {
    stopping = true;
    return (stopped ??= Promise.resolve().then(async () => {
      const results = await Promise.allSettled(
        [
          ...background.map((owner) => () => owner.stop()),
          () => policy?.retire(),
          () => server && apiReadLifetimes.get(server)?.retire(),
          () => server && closeDevClientHmr(server),
        ].map((work) => Promise.resolve().then(work)),
      );
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, 'App retirement failed.');
    }));
  };
  const close = () =>
    (closed ??= Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      const attempt = async (work: () => unknown) => {
        try {
          await work();
        } catch (error) {
          errors.push(error);
        }
      };
      await attempt(stop);
      if (server) {
        await Promise.allSettled([...(commandOperations.get(server) ?? [])]);
        await attempt(() => retireDevClient(server!));
      }
      await attempt(() => host.auth?.close());
      await attempt(() => registry.closeAll());
      if (errors.length) throw new AggregateError(errors, 'App cleanup failed.');
    }));
  try {
    if (placement && !policyFile) throw new Error('Public placement requires a policy file.');
    if (app.app.auth) {
      if (suiteAuth) {
        const binding = captureAppAuthRuntime(suiteAuth);
        if (binding.appId !== app.app.id || !isDeepStrictEqual(signInOf(binding.spec), signInOf(app.app.auth))) {
          throw new Error('Suite authentication must belong to the mounted App.');
        }
      }
      const oauth = oauthServerOf(registry);
      if (oauth?.apps.includes(app.app.id)) {
        throw new Error(
          `The config file's OAuth authorization server "${oauth.name}" issues tokens for "${app.app.id}", which a suite does not serve: serve the App on its own (mistri serve --api-reads).`,
        );
      }
      const origin = new URL(publicURL).origin;
      const excludeStores = sqliteAuthExclusions(registry);
      if (suiteAuth) await assertAppAuthStoreSeparation(suiteAuth, excludeStores, registry.configs(), environment);
      host.auth =
        suiteAuth ??
        (await createAppAuth(app, {
          baseURL: `${origin}${basePath}`,
          trustedOrigins: [...new Set([origin, `http://localhost:${http.bound.port}`, `http://127.0.0.1:${http.bound.port}`])],
          listenHost: http.bound.host,
          environment,
          excludeStores,
          excludeConnections: registry.configs(),
          identity: identityProvidersOf(registry),
          mail: emailOf(registry),
        }));
    }
    if (openAnalytics) {
      const sessions = host.auth && captureAppAuthRuntime(host.auth);
      const analytics = await openAnalytics({
        async subject(req) {
          // A tenant host has no App-level session, and a signed-out request is nobody to follow.
          const proof = !getTenantHostIntent(req) && sessions ? await sessions.sessionInstance(req).catch(() => null) : null;
          return proof ? proof.identity.id : null;
        },
      });
      analyticsBeacon = analytics.beacon;
      analyticsStore = analytics.store;
      background.push({
        start: () => analytics.start(),
        stop: () => analytics.close(),
      });
    }
    if (policyFile) {
      if (!host.auth) throw new Error('An App policy requires authentication.');
      policy = await loadHttpAppPolicy({
        registry,
        app: app.app,
        file: policyFile,
        publicPlacement: placement,
        components: () => host.app.components,
        commands: http.commands?.registry,
        ...(http.commands?.events ? { events: http.commands.events } : {}),
        ...(policyServices?.size ? { services: policyServices } : {}),
        verifySession: (request) => (getTenantHostIntent(request) ? Promise.resolve(null) : host.auth!.session(request)),
      });
      onPolicy?.(policy);
    }
    if (historyRules(app.app, app.pages).size > 0) {
      await ensureAppRecordHistory(registry, host);
    }
    // Notifications as serve keeps them: the App's inbox store, attested before the first write, and its own outbox.
    if (appKeepsInbox(app.app)) await ensureAppInbox(registry, host);
    ensureAppLive(registry, host);
    if (appSendsEmail(app.app)) {
      const transport = emailOf(registry);
      if (!transport || !notifications)
        throw new Error(`${app.app.name}: a notify rule says email: true, and this App has no email service.`);
      const account = notifications.account;
      const outbox = createEmailOutbox({
        registry,
        hosts: () => [host],
        transport,
        baseURL: publicURL,
        mount: notifications.mount,
        ...(account ? { account: (_host, email) => account(email) } : {}),
        ...(policy ? { policy: () => policy } : {}),
      });
      background.push({
        start: () => outbox.start(),
        stop: () => outbox.stop(),
      });
    }
    /* Mail to an address a record holds (`notify.via` email), as serve keeps it: the store beside the rules' records,
       the loop that sends what the writes queued, and the link that stops it, answered before any gate under this
       App's own mount (email/contactMail.ts). */
    let inbound = http.inbound;
    if (appEmailsContacts(app.app)) {
      const service = emailConfigOf(registry);
      const places = await contactMailPlaces(registry, host, (id) => {
        const url = registry.configOf(id)?.url;
        return url === undefined ? undefined : expandEnv(url, environment);
      });
      const commands = http.commands?.registry ?? app.commands?.registry;
      const findings = contactEmailFindings(app.app, {
        email: service ? { links: Boolean(service.links?.secret) } : undefined,
        ...(commands ? { commands } : {}),
        connectionOf: places.connectionOf,
      });
      for (const warning of findings.warnings) console.warn(`mistri: warning: ${app.app.name}: ${warning}`);
      if (findings.problems.length || !places.target)
        throw new Error(`${app.app.name}: ${findings.problems[0] ?? "its notify rules' records are not in SQLite or PostgreSQL."}`);
      const mail = await openContactMail({
        apps: [{ id: app.app.id, name: app.app.name, target: places.target }],
        transport: emailOf(registry)!,
        // The secret is a reference, read in this App's own environment as its connections are.
        secret: expandEnvReferences(service!.links!.secret, environment),
        address: `${new URL(publicURL).origin}${basePath}${UNSUBSCRIBE_PATH}`,
      });
      background.push(mail);
      const inner = inbound;
      inbound = Object.freeze({
        handle: async (req: IncomingMessage, res: ServerResponse, url: URL) =>
          (await mail.handle(req, res, url)) || (inner ? inner.handle(req, res, url) : false),
      });
    }
    server = createApp({
      ...http,
      ...(inbound ? { inbound } : {}),
      pages: http.pages ?? host.pages,
      registry,
      sourceClient: false,
      drainRequests: true,
      apps: [host],
      addresses: { base: basePath },
      policy,
      commands: policy ? undefined : http.commands,
      ready: () => !stopping,
    });
    await apiReadLifetimes.get(server)?.prepare();
    bindFlagHttpServer(
      server,
      () => flags,
      host.auth,
      assertCurrent,
      async (req, res) => {
        if (analyticsBeacon && (await analyticsBeacon(req, res))) return true;
        return values ? values(req, res) : false;
      },
    );
    const flagAuth = host.auth;
    // Only an App with its own sign-in has grants to answer the Console with.
    const consoleOperations =
      flagAuth && (operations || analyticsStore)
        ? {
            name: app.app.name,
            app: () => app.app,
            auth: flagAuth,
            ...operations,
            ...(analyticsStore ? { analytics: () => (stopping ? undefined : analyticsStore) } : {}),
          }
        : undefined;
    return {
      server,
      flagName: app.app.name,
      ...(consoleOperations ? { consoleOperations } : {}),
      attachFlagRuntime(port, current = () => {}) {
        assertCurrent();
        if (flags) throw new Error('Flag runtime already attached.');
        flagCurrent = current;
        flags = createFlagRequestRuntime({
          app: app.app,
          auth: flagAuth,
          environment: port.environment,
          readPort: port,
          assertCurrent,
        });
        values = flags.valuesHttp({
          bound: http.bound,
          mount: basePath,
          async withRequest(req, res, guard, use) {
            await withFlagHttpRequest(flags, req, res, flagAuth, assertCurrent, async () => {
              guard();
              const scope = flagHttpRequest()!;
              const selection = experimentPublicSelection(req);
              if (selection.form && [...new URL(req.url!, 'http://localhost').searchParams.keys()].some((key) => key !== 'app'))
                throw new HttpError(400, 'Public form takes no tenant selector.');
              if (selection.address !== undefined || (selection.form !== undefined && !isPublicForm(app.app.views[selection.form])))
                throw new HttpError(403, 'Public form unavailable.');
              if (selection.form && !policy) {
                if (req.headers['x-mistri-account'] !== undefined) throw new HttpError(403, 'Public form requires public ownership.');
                await use(await scope.public(selection.form));
              } else if (policy) {
                await policy.withContext(req, async (context) => {
                  const capture =
                    context.principal.kind === 'public'
                      ? await scope.public(selection.form, getTenantHostIntent(req)?.tenant)
                      : await scope.native();
                  await use(capture);
                });
              } else {
                const proof = !getTenantHostIntent(req) && flagAuth && (await captureAppAuthRuntime(flagAuth).sessionInstance(req));
                guard();
                const entry = appEntrypoint(host, registry);
                if (!entry) throw new HttpError(503, 'App unavailable.');
                const resources = await loadAppRuntimeResources(registry, app.app, entry);
                const access = resolveAppAccess(
                  app.app,
                  resources.schema,
                  proof ? (proof.identity.role ?? '').split(',').filter(Boolean) : [],
                  proof ? undefined : 'public',
                );
                if (!access.readable.size) throw new HttpError(403, 'App read refused.');
                await use(proof ? await scope.native() : await scope.public());
              }
              guard();
              assertCurrent();
            });
          },
        });
        onFlagRuntime?.(flags);
      },
      flagValuesRoute: (req, res) => (values ? values(req, res) : Promise.resolve(false)),
      ...(flagAuth
        ? {
            flagTargetFactory: () => ({
              appId: flagAppId,
              auth: flagAuth,
              tenantApp: false,
              catalog: flagCatalog.authorityCatalog,
              roles: flagCatalog.roles,
              assertCurrent() {
                if (stopping) throw new Error('App is stopping.');
                captureAppAuthRuntime(flagAuth).assertCurrent();
              },
            }),
          }
        : {}),
      ...(linkCatalog
        ? {
            links: {
              catalog: linkCatalog,
              auth: host.auth,
              current: () => !stopping,
            },
          }
        : {}),
      ...(policy?.publicPlacement
        ? {
            publicPlacementRoute: (req, res) =>
              withFlagHttpRequest(flags, req, res, flagAuth, assertCurrent, () => policy!.publicPlacement!.handle(req, res)),
          }
        : {}),
      start: () => {
        if (stopping) throw new Error('App is stopping.');
        for (const owner of background) owner.start();
      },
      stop,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'App startup failed.');
    }
    throw error;
  }
}
