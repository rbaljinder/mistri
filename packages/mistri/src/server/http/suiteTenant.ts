/** A mounted tenant App retains the dedicated tenant runtime. */
import type { LoadedApp } from '../app/apps.js';
import { isFormView, isPublicForm } from '../../shared/app.js';
import { createAppAuth, assertAppAuthStoreSeparation, type AppAuthRuntime } from '../auth/auth.js';
import { captureAuthStoreExclusion } from '../auth/authStoreSeparation.js';
import type { ConnectionConfig, Registry } from '@mistriwork/engine/server/connections.js';
import { prepareTenantStartup } from '../tenant/tenantStartup.js';
import { createTenantAuthenticatedHttpServer } from '../tenant/tenantAuthenticatedHttp.js';
import type { SuiteHost } from './suite.js';
import { captureAppFlagCatalog } from '../flags/appCatalog.js';
import { createFlagRequestRuntime, type FlagRequestRuntime } from '../flags/requestRuntime.js';
import { bindFlagHttpServer } from '../flags/httpRuntime.js';
import { captureTenantFlagOwner } from '../tenant/tenantFlagRuntime.js';

export async function openSuiteTenant(options: {
  app: LoadedApp;
  connections: readonly ConnectionConfig[];
  policyFile: string;
  jobsFile?: string;
  environment: NodeJS.ProcessEnv;
  basePath: string;
  publicURL: string;
  port: number;
  suiteAuth?: AppAuthRuntime;
  allowedHosts?: readonly string[];
  /** The App's email and search services, as `mistri tenant` passes them; closed with the App. */
  registry?: Registry;
  /** A suite account's email, for the Console's Governance room to name members by. */
  accountEmail?: (accountId: string) => Promise<string | null>;
}): Promise<Omit<SuiteHost, 'id'>> {
  const { app, connections, policyFile, jobsFile, environment, basePath, publicURL, port } = options;
  const flagCatalog = captureAppFlagCatalog(app.app, app.commands?.registry),
    flagAppId = app.app.id;
  const prepared = await prepareTenantStartup({ loaded: app, connections, policyFile, ...(jobsFile ? { jobsFile } : {}) }, environment);
  const policy = prepared.enrollment.policy;
  if (policy.intake && !Object.values(app.app.views).filter(isFormView).some(isPublicForm)) {
    throw new Error(`Suite App "${app.app.id}": tenant intake currently requires a public form.`);
  }
  // Use the attested locations, after this App's environment references were resolved.
  const resolved = [prepared.enrollment.source, ...(prepared.enrollment.platformSources ?? [])];
  if (options.suiteAuth)
    await assertAppAuthStoreSeparation(
      options.suiteAuth,
      resolved.flatMap((source) => (source.existingPath === undefined ? [] : [captureAuthStoreExclusion(source.existingPath)])),
      resolved.map((source) => ({ url: source.url ?? source.existingPath! })),
      environment,
    );
  const auth =
    options.suiteAuth ??
    (await createAppAuth(app, {
      baseURL: `${publicURL}${basePath}`,
      trustedOrigins: [publicURL, `http://localhost:${port}`],
      // A suite listens on loopback alone, behind its proxy (cli/suiteCommand.ts).
      listenHost: '127.0.0.1',
      environment,
      ...(prepared.authStoreExclusion ? { excludeStore: prepared.authStoreExclusion } : {}),
      excludeConnections: resolved.map((source) => ({ url: source.url ?? source.existingPath! })),
    }));
  try {
    const owner = await createTenantAuthenticatedHttpServer({
      loaded: app,
      auth,
      enrollment: prepared.enrollment,
      browser: true,
      sourceClient: false,
      bound: { host: '127.0.0.1', port, ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}) },
      mount: { base: basePath, apps: { [app.app.id]: '' } },
      ...(options.registry ? { registry: options.registry } : {}),
      publicURL,
    });
    let stopping = false;
    let flags: FlagRequestRuntime | undefined;
    let flagCurrent = () => {};
    const assertCurrent = () => {
      flagCurrent();
      if (stopping) throw new Error('App is stopping.');
    };
    bindFlagHttpServer(owner.server, () => flags, auth, assertCurrent);
    // Only availability crosses this boundary; discovery and contexts stay with the owner.
    const tenant = owner.linkAccess;
    return {
      experimentConversionAuthority: owner.experimentConversionAuthority,
      server: owner.server,
      flagName: app.app.name,
      flagScopeProof: owner.flagScopeProof,
      flagScopes: owner.flagScopes,
      attachFlagRuntime(port, current = () => {}) {
        assertCurrent();
        if (flags) throw new Error('Flag runtime already attached.');
        flagCurrent = current;
        flags = createFlagRequestRuntime({
          app: app.app,
          auth,
          readPort: port,
          environment: port.environment,
          observeMembership: captureTenantFlagOwner,
          assertCurrent,
        });
        owner.attachFlagRuntime(flags);
      },
      flagTargetFactory: () => ({
        appId: flagAppId,
        auth,
        tenantApp: true,
        catalog: flagCatalog.authorityCatalog,
        roles: flagCatalog.roles,
        observeMembership: owner.flagAccess,
        assertCurrent() {
          if (stopping) throw new Error('App is stopping.');
        },
      }),
      links: { catalog: { app: app.app, pages: app.pages, surfaces: prepared.linkSurfaces }, auth, tenant, current: () => !stopping },
      /* The Console's Governance room reads this App's accounts through its own membership administration, and
         points to the App's own screens for support sessions and API tokens, read on the leases that admit them. */
      ...(options.suiteAuth && owner.administrationReads
        ? {
            consoleOperations: Object.freeze({
              name: app.app.name,
              app: () => app.app,
              auth,
              governance: Object.freeze({
                tenantAccounts: Object.freeze({
                  ...owner.administrationReads,
                  href: `${basePath}/`,
                  supportSessions: Object.values(app.app.auth?.roles ?? {}).some((role) => role.supportAudit === true),
                  apiTokens: app.app.api !== undefined,
                }),
                ...(options.accountEmail ? { email: options.accountEmail } : {}),
              }),
            }),
          }
        : {}),
      ...(owner.jobs ? { start: owner.jobs.start } : {}),
      stop: () => {
        stopping = true;
        return owner.retire();
      },
      close: async () => {
        await options.registry?.closeAll();
      },
    };
  } catch (error) {
    await auth.close();
    throw error;
  }
}
