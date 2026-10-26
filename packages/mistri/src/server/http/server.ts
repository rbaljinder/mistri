/**
 * The App framework's HTTP server: the engine's server (serverCore.ts) with
 * what an App deployment adds before its dispatcher (handler.ts) — the App
 * API's transports and its OAuth documents, the inbound endpoints, a test
 * host's controls, the embed's protocol check, the dev observer — and an
 * App's failures said in its words. cli/serve.ts listens on it, as a suite's
 * Apps and the Console do.
 */
import { homeSourceOf, isRowPolicyApp, isTenantApp } from '../../shared/app.js';
import type { Server, ServerResponse } from 'node:http';
import { Registry } from '@mistriwork/engine/server/connections.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import type { AppHost } from '../app/apps.js';
import type { ConfigLayout } from '@mistriwork/engine/shared/recordview.js';
import { AppSourceUnavailable } from '../app/appRuntimeResources.js';
import { assertHttpRowPolicyApp, type HttpAppPolicy } from '../policy/appPolicyHttp.js';
import type { ViewDef } from '@mistriwork/engine/shared/view.js';
import type { SavedQuery } from '@mistriwork/engine/shared/sqlsaved.js';
import type { RequestDiagnostics } from '@mistriwork/engine/server/operations/diagnostics.js';
import { appError } from '../app/appErrors.js';
import { reportRefusal } from '@mistriwork/engine/server/http/refusalReport.js';
import { businessCommandHttpError, isBusinessCommandPath } from '../commands/businessCommandHttp.js';
import { handle, type CommandHosting } from './handler.js';
import type { JobsReadiness } from './appContext.js';
import { HttpError, send } from '@mistriwork/engine/server/http/reply.js';
import { doorRefusal, writes, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { createSqliteApiReadHttp } from '../api/sqliteApiReadHttp.js';
import { createSqliteApiCommandHttp } from '../api/sqliteApiCommandHttp.js';
import { createPostgresApiReadHttp } from '../api/postgresApiReadHttp.js';
import { createPostgresApiCommandHttp } from '../api/postgresApiCommandHttp.js';
import { apiAdmission } from '../api/apiHttpAdmission.js';
import { createApiPublicSpec, renderAppApiOpenApi } from '../api/apiPublicSpec.js';
import { createAppMcpHttp } from '../api/appMcpHttp.js';
import {
  postgresAppMcpCommands,
  postgresAppMcpReads,
  sqliteAppMcpCommands,
  sqliteAppMcpReads,
  tenantAppMcpCommands,
  tenantAppMcpReads,
  type createAppMcpSession,
} from '../api/appMcpSession.js';
import { createPolicyApiOwner } from '../api/policyApiOwner.js';
import { createApiReadHandoffHttp } from '../api/postgresApiReadHttp.js';
import { createApiCommandHttp } from '../api/apiCommandHttp.js';
import type { AppAuthRuntime } from '../auth/auth.js';
import { readApiApp } from '../api/appApiValidation.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { runtimeVersion } from '@mistriwork/engine/server/packageVersion.js';
import { apiExposesCommands } from '../../shared/appApi.js';
import { appMounts, NO_MOUNT, type AddressMount } from '@mistriwork/engine/shared/mount.js';
import { consoleDispatchOwners } from './appContext.js';
import { listen } from '@mistriwork/engine/server/http/serverCore.js';
import { embedBoot } from '../embed/boot.js';
import { embedDoorFor } from '../embed/crossOrigin.js';
import type { InboundHost } from '../jobs/inboundHost.js';
import type { TestControl } from './testControl.js';
import { observerRoute } from '../observe/mount.js';
import { themeBenchRoute } from '../themeBench/mount.js';
import { answerOAuthWellKnown, bearerChallenge } from '../auth/oauthResource.js';

/** Which App a request is for, as far as its address says: the only one
    served, the App its inside path names, or the one its `?app=` names. */
function requestApp(hosts: readonly AppHost[], url: URL): string | undefined {
  const ids = hosts.map((host) => host.app.app.id);
  if (ids.length <= 1) return ids[0];
  let first: string | undefined;
  try {
    first = decodeURIComponent(url.pathname.split('/')[1] ?? '');
  } catch {
    first = undefined;
  }
  const asked = url.searchParams.get('app');
  return first !== undefined && ids.includes(first) ? first : asked !== null && ids.includes(asked) ? asked : undefined;
}

/* Where they were read before the engine's server held them; a caller still imports them from here. */
export { commandOperations } from '@mistriwork/engine/server/http/serverCore.js';

/** The App API's one lifetime: its read transport and, for an App that exposes
 * commands, its command transport, prepared and retired together. */
export const apiReadLifetimes = new WeakMap<Server, Readonly<{ prepare(): Promise<void>; retire(): Promise<void> }>>();

/**
 * The server, wired but not listening.
 *
 * This used to be four lines inside `main`, which meant the only way to reach
 * an endpoint was to run the process — so nothing tested a status code, and
 * the two error vocabularies (`{error}` for infrastructure, `{errors}` for a
 * mistake in the language) were only ever agreed to by convention. A test that
 * rebuilt this wiring for itself would prove the wiring it wrote rather than
 * the wiring that ships, so it is pulled out whole and `main` calls it.
 *
 * `bound` is read on every request instead of copied, so a caller listening on
 * port 0 can fill the port in once the kernel has chosen one. That matters
 * because `doorRefusal` compares the `Host` header against it, and a
 * bound record that disagrees with the socket refuses every write.
 */
export function createApp(options: {
  registry: Registry;
  /** A suite owns the source client and HMR at its shared listener. */
  sourceClient?: false;
  /** A suite must drain even disconnected form submissions before closing its App registry. */
  drainRequests?: true;
  views?: ViewDef[];
  /** The file this session read its connections from, and writes them back to. */
  configPath?: string;
  queries?: SavedQuery[];
  pages?: PageDef[];
  layouts?: ConfigLayout[];
  apps?: AppHost[];
  commands?: CommandHosting;
  policy?: HttpAppPolicy;
  policyUnavailable?: boolean | string;
  diagnostics?: RequestDiagnostics;
  /** The `--jobs` host: its readiness joins the operator reads. */
  jobs?: JobsReadiness;
  /** The jobs module's verified inbound endpoints (`/api/inbound/{name}`), its integrations' signed webhooks among
   * them (integrationInbound.ts), answered before any gate. */
  inbound?: InboundHost;
  /** A test host's setup and job runs (testControl.ts): present only in a process startTestApp started. */
  testControl?: TestControl;
  /** Explicit App API opt-in. CLI/default policy and other engines are
   * separate; no cookies or browser routes acquire bearer authority.
   * `network`: the operator listens beyond loopback — honoured only for an
   * App whose api declares `network: true`. */
  apiReads?: {
    integers: 'decimal-string' | 'number';
    requestsPerMinute: number;
    engine?: 'sqlite' | 'postgres';
    network?: true;
  };
  bound: Bound;
  /**
   * Where the Apps are served and under what path (shared/mount.ts): one App
   * at the root, several under their ids, unless `mounts` says otherwise.
   * Read per request, like the Apps: a reload keeps its App's place.
   */
  addresses?: { base?: string; mounts?: Readonly<Record<string, string>> };
  /** Whether the server should take traffic now: false while it starts, reloads its policy or shuts down (`/readyz`). */
  ready?: () => boolean;
}): Server {
  if (options.apps?.some((host) => isTenantApp(host.app.app))) {
    throw new Error('Tenant applications are not enabled in public transports.');
  }
  if (options.policy || options.apps?.some((host) => isRowPolicyApp(host.app.app))) {
    const hosts = options.apps ?? [];
    if (hosts.length !== 1 || !hosts[0].auth || options.commands || !options.policy?.matches(hosts[0].app.app)) {
      throw new Error(
        'A policy application requires a matching deployment and its own authenticated HTTP server; register commands only through that deployment.',
      );
    }
    assertHttpRowPolicyApp(hosts[0].app.app, options.policy.commands !== undefined);
  }
  /* A row-policy App's API runs through its policy deployment (policyApiOwner.ts),
     checked above to be this App's; an ordinary App's through the engine owners. */
  const policyApi = options.apiReads !== undefined && options.policy !== undefined;
  if (options.apiReads && (options.apps?.length !== 1 || !options.apps[0].auth || isRowPolicyApp(options.apps[0].app.app) !== policyApi)) {
    throw new Error('The App API requires one authenticated application: an ordinary one, or a row-policy one under its policy.');
  }
  const apiHost = options.apiReads ? options.apps![0] : undefined;
  const exposesCommands = apiExposesCommands(apiHost?.app.app.api);
  if (exposesCommands && (policyApi ? !options.policy!.commands : options.commands?.appId !== apiHost!.app.app.id)) {
    throw new Error("The command API requires the application's registered commands.");
  }
  const apiApp = apiHost?.app.app;
  // Both must choose the network: the App in its authority-locked api, the operator by where it listens.
  if (options.apiReads?.network !== undefined && (options.apiReads.network !== true || apiApp?.api?.network !== true)) {
    throw new Error('The App API serves beyond loopback only for an App whose api declares network: true.');
  }
  // One admission for the whole App API, whichever transport answers: the same budgets.
  const admission = options.apiReads
    ? apiAdmission(options.apiReads.requestsPerMinute, { network: options.apiReads.network === true })
    : undefined;
  // The engine startup checked; each owner still refuses a store of the other.
  const postgres = options.apiReads?.engine === 'postgres';
  /* The App's runtime resources, for what the owners do not hold: the MCP's
     routing and the published document. Kept per opened catalog, so a
     refreshed schema is read afresh. Routing only — every call is still the
     owners' to authorize. */
  const apiResources = async () => {
    const app = apiApp!;
    const reference = app.sources ? app.sources[homeSourceOf(app)!]?.connection : app.connection;
    const matches = options.registry
      .list()
      .filter((connection) => reference === undefined || connection.id === reference || connection.name === reference);
    if (matches.length !== 1) throw new Error("The App's entry connection is unavailable or ambiguous.");
    return loadAppRuntimeResources(options.registry, readApiApp(app), matches[0].id);
  };
  const apiEvidence = (resources: Awaited<ReturnType<typeof apiResources>>) => ({
    connectionFor: resources.connectionFor,
    writableConnection: (id: string) => options.registry.configOf(id)?.writable === true,
    transactionalConnection: (id: string) => !!resources.forConnection(id).commandTransaction,
  });
  /* A row-policy App: one owner over its deployment for reads, commands and
     MCP alike, built once on first use from the deployment serving now.
     Retired with the transports; an App reload retires them as it does an
     ordinary App's. */
  let policyOwner: ReturnType<typeof createPolicyApiOwner> | undefined;
  const acquirePolicyOwner = () => {
    if (!policyOwner) {
      policyOwner = createPolicyApiOwner({
        policy: options.policy!,
        app: apiApp!,
        auth: apiHost!.auth as AppAuthRuntime,
        registry: options.registry,
        integers: options.apiReads!.integers,
      });
      void policyOwner.catch(() => {});
    }
    return policyOwner;
  };
  const publicSpec =
    options.apiReads && apiApp?.api?.publicSpec
      ? createApiPublicSpec(async () => {
          if (policyApi) {
            const routing = (await acquirePolicyOwner()).routing;
            return {
              from: routing,
              document: () =>
                renderAppApiOpenApi(apiApp, routing.schema, {
                  integers: options.apiReads!.integers,
                  ...(routing.registry ? { commands: routing.registry, evidence: routing.evidence } : {}),
                }),
            };
          }
          const resources = await apiResources();
          return {
            from: resources,
            document: () =>
              renderAppApiOpenApi(apiApp, resources.schema, {
                integers: options.apiReads!.integers,
                ...(exposesCommands ? { commands: options.commands!.registry, evidence: apiEvidence(resources) } : {}),
              }),
          };
        })
      : undefined;
  const api = options.apiReads && {
    bound: options.bound,
    integers: options.apiReads.integers,
    requestsPerMinute: options.apiReads.requestsPerMinute,
    admission,
    ...(publicSpec ? { publicSpec } : {}),
  };
  const apiCommands =
    !api || !exposesCommands
      ? undefined
      : policyApi
        ? createApiCommandHttp(apiHost!, api, {
            acquire: acquirePolicyOwner,
            async deliver(owner, kind, credential, envelope, signal, write) {
              const send = (answer: Readonly<{ status: number; headers?: Readonly<Record<string, string>>; body: string }>) =>
                write({ status: answer.status, headers: answer.headers ?? {}, body: answer.body });
              await (kind === 'spec'
                ? owner.readSpec(credential, send)
                : kind === 'prepare'
                  ? owner.prepare(credential, envelope, send, signal)
                  : kind === 'recover'
                    ? owner.recover(credential, envelope, send, signal)
                    : owner.execute(credential, envelope, send, signal));
            },
          })
        : postgres
          ? createPostgresApiCommandHttp(options.registry, apiHost!, options.commands!, api)
          : createSqliteApiCommandHttp(options.registry, apiHost!, options.commands!, api);
  // The App's commands describe its feed's events in the AsyncAPI document the reads serve.
  const reads = api && { ...api, ...(options.commands?.appId === apiHost!.app.app.id ? { commands: options.commands.registry } : {}) };
  const apiReads = !reads
    ? undefined
    : policyApi
      ? createApiReadHandoffHttp(apiHost!, reads, acquirePolicyOwner)
      : postgres
        ? createPostgresApiReadHttp(options.registry, apiHost!, reads)
        : createSqliteApiReadHttp(options.registry, apiHost!, reads);
  /* The same API as MCP tools over HTTP (`…/$mcp`): the transports' own
     owners, never a second connection, each fetched per call so a retired
     one refuses rather than answers. Mounted first: the reads claim the
     namespace. */
  const apiMcp =
    api && apiApp?.api
      ? createAppMcpHttp({
          appId: apiApp.id,
          version: apiApp.api.version,
          bound: options.bound,
          admission: admission!,
          app: apiApp,
          challenge: (presented: boolean) => bearerChallenge(apiHost!.auth, 'mcp', presented),
          session: async (): Promise<Omit<Parameters<typeof createAppMcpSession>[0], 'input' | 'output' | 'credential'>> => {
            if (policyApi) {
              // Routing from the owner's own catalogs; every call is still the owner's to authorize.
              const owner = await acquirePolicyOwner(),
                routing = owner.routing;
              return {
                version: runtimeVersion(),
                app: apiApp,
                schema: routing.schema,
                integers: options.apiReads!.integers,
                deliver: tenantAppMcpReads(owner),
                tenant: { reads: routing.reads, ...(routing.commands ? { commands: routing.commands } : {}) },
                ...(routing.commands
                  ? { commands: { registry: routing.registry!, evidence: routing.evidence, deliver: tenantAppMcpCommands(owner) } }
                  : {}),
              };
            }
            const resources = await apiResources();
            const reads = apiReads!;
            type Deliver = Parameters<typeof createAppMcpSession>[0]['deliver'];
            type CommandDeliver = NonNullable<Parameters<typeof createAppMcpSession>[0]['commands']>['deliver'];
            const deliver: Deliver = postgres
              ? async (...call) => postgresAppMcpReads(await (reads as ReturnType<typeof createPostgresApiReadHttp>).owner())(...call)
              : async (...call) => sqliteAppMcpReads(await (reads as ReturnType<typeof createSqliteApiReadHttp>).owner())(...call);
            const runs: CommandDeliver | undefined = !apiCommands
              ? undefined
              : postgres
                ? async (...call) =>
                    postgresAppMcpCommands(await (apiCommands as ReturnType<typeof createPostgresApiCommandHttp>).owner())(...call)
                : async (...call) =>
                    sqliteAppMcpCommands(await (apiCommands as ReturnType<typeof createSqliteApiCommandHttp>).owner())(...call);
            return {
              version: runtimeVersion(),
              app: apiApp,
              schema: resources.schema,
              integers: options.apiReads!.integers,
              deliver,
              ...(runs ? { commands: { registry: options.commands!.registry, evidence: apiEvidence(resources), deliver: runs } } : {}),
            };
          },
        })
      : undefined;
  const apiLifetime =
    apiReads &&
    Object.freeze({
      // Commands first: that transport also claims the composed `$openapi`.
      prepare: async () => {
        await apiCommands?.prepare();
        await apiReads.prepare();
      },
      // Both revoke synchronously, before either awaits: no queued work outlives it.
      retire: async () => {
        await Promise.all([apiCommands?.retire(), apiReads.retire()]);
      },
    });
  const mountOf = (): AddressMount => {
    const ids = (options.apps ?? []).map((host) => host.app.app.id);
    if (!ids.length && !options.addresses?.base) return NO_MOUNT;
    /* Startup checked the mounts against the Apps it loaded (cli/serve.ts);
       an App that since stopped answering to a mounted id keeps the default. */
    try {
      return appMounts(ids, options.addresses);
    } catch {
      return appMounts(ids, { base: options.addresses?.base });
    }
  };
  const inbounds = (url: URL) =>
    options.inbound !== undefined && (url.pathname.startsWith('/api/inbound/') || url.pathname === '/api/mail/unsubscribe');
  const server: Server = listen(options, {
    mount: mountOf,
    /* The OAuth documents a client discovers the API's authorization server by
       (auth/oauthResource.ts): their suffix follows the origin, so they are
       read before the base path is. Only where the API is served. */
    outside: (req, res, url) => Boolean(apiHost && answerOAuthWellKnown(apiHost.auth, req, res, url.pathname)),
    served: (url) => requestApp(options.apps ?? [], url),
    // An embed's protocol check, the dev observer and theme bench, before any gate: none is an App's.
    ahead: (req, res, url, mount) =>
      embedBoot(req, res, url, {
        origins: embedDoorFor(options.apps?.find((host) => host.auth)?.auth?.embed, options.bound.embedOrigins)?.origins,
        deferred: Boolean(options.apps?.length),
      }) ||
      (!consoleDispatchOwners.has(server) && (observerRoute(req, res, url, mount) || themeBenchRoute(req, res, url, mount))),
    answer: async (req, res, url, mount) => {
      if (options.testControl && (await options.testControl.handle(req, res, url))) return;
      /* A signed delivery from outside carries no session: it proves itself, and answers before the browser gate.
         The Host is still this deployment's, as the tenant server holds it; the Origin and the body's type are not
         asked, as a provider posts from no page of ours and a link is followed from a mail client. */
      if (inbounds(url)) {
        const refused = doorRefusal(req, options.bound, { writing: writes(req), origin: 'none', json: false });
        if (refused) return send(res, 403, { error: refused.error });
      }
      if (options.inbound && (await options.inbound.handle(req, res, url))) return;
      // Dedicated namespace owns malformed aliases as well as valid routes,
      // before the browser gate can inspect a cookie or proxy identity.
      if (apiMcp && (await apiMcp.handle(req, res))) return;
      if (apiCommands && (await apiCommands.handle(req, res))) return;
      if (apiReads && (await apiReads.handle(req, res))) return;
      const dispatch = (reply: ServerResponse) =>
        handle(req, reply, url, {
          registry: options.registry,
          views: options.views,
          configPath: options.configPath,
          bound: options.bound,
          queries: options.queries,
          pages: options.pages,
          layouts: options.layouts,
          apps: options.apps,
          commands: options.policy?.commands ? { appId: options.policy.appId, registry: options.policy.commands } : options.commands,
          policy: options.policy,
          policyUnavailable: options.policyUnavailable,
          diagnostics: options.diagnostics,
          jobs: options.jobs,
          mount,
        });
      const consoleDispatch = consoleDispatchOwners.get(server);
      if (consoleDispatch) await consoleDispatch(req, res, dispatch);
      else await dispatch(res);
    },
    /* A command's outcome is its own record: it keeps its report even when
       its client left, in the shape its client reads. */
    failed: (err, req, res, url) => {
      if (!isBusinessCommandPath(url.pathname)) return false;
      const failure = businessCommandHttpError(err, url.pathname === '/api/commands/status');
      if (failure.retryAfter !== undefined && !res.headersSent) res.setHeader('retry-after', String(failure.retryAfter));
      const cause = reportRefusal(req, failure.status, failure.body.code, failure.body.message, err);
      send(res, failure.status, { ...failure.body, ...(cause ? { cause } : {}) });
      return true;
    },
    status: (err) => (err instanceof AppSourceUnavailable ? 503 : undefined),
    /* An App never says a driver's words: its failures are said by code (appErrors.ts). */
    said: (err, req, res, status) => {
      if (!options.apps?.length || err instanceof HttpError || err instanceof AppSourceUnavailable) return false;
      const failure = appError(err);
      const cause = reportRefusal(req, status, failure.code, failure.message, err);
      send(res, status, {
        error: failure.message,
        code: failure.code,
        ...(failure.columns ? { columns: failure.columns } : {}),
        ...(cause ? { cause } : {}),
      });
      return true;
    },
    drains: (url) => Boolean(options.policy || isBusinessCommandPath(url.pathname) || inbounds(url) || apiReads),
  });
  if (apiLifetime) {
    apiReadLifetimes.set(server, apiLifetime);
    // Composition owners must still await retirement before closing auth/DB;
    // this also sweeps unused local hosts when a caller only closes its server.
    server.once('close', () => {
      void apiLifetime.retire().catch(() => {});
    });
  }
  return server;
}
