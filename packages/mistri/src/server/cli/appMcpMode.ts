/**
 * `--app-mcp`: one authenticated App's API as MCP tools on stdio, for an agent's
 * client to spawn. No HTTP listener and no browser session: the process loads
 * the App as serving does, takes the scoped API token from MISTRI_API_TOKEN
 * (never argv, where other processes can read it), and answers through the
 * same owners `--api-reads` uses, which observe the token natively on every
 * discovery and every call. The session keeps no roles or scope of its own.
 * stdout is the protocol, so every startup line was sent to stderr first.
 */
import { startupReport } from '@mistriwork/engine/shared/refusal.js';
import type { IncomingMessage } from 'node:http';
import type { Options } from '@mistriwork/engine/server/cli/args.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { AppHost, LoadedApp } from '../app/apps.js';
import { homeSourceOf, isRowPolicyApp, isTenantApp } from '../../shared/app.js';
import { createAppAuth, type AppAuthRuntime } from '../auth/auth.js';
import { nativeAccountEmailOf } from '../auth/authAccounts.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { readApiApp } from '../api/appApiValidation.js';
import { apiExposesCommands } from '../../shared/appApi.js';
import {
  createAppMcpSession,
  postgresAppMcpCommands,
  postgresAppMcpReads,
  sqliteAppMcpCommands,
  sqliteAppMcpReads,
  tenantAppMcpCommands,
  tenantAppMcpReads,
} from '../api/appMcpSession.js';
import { createTenantApiOwner } from '../api/tenantApiReadOwner.js';
import { createPolicyApiOwner } from '../api/policyApiOwner.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../policy/appPolicyHttp.js';
import { ApiReadFailure } from '../api/apiReadFailure.js';
import { isBusinessCommandExecutionError } from '../commands/commandErrors.js';
import { createTenantEnrollment, type TenantEnrollment } from '../tenant/tenantEnrollment.js';
import { withTenantApiRequests } from '../tenant/tenantApiRequest.js';
import { createSqliteApiReadOwner } from '../api/sqliteApiReadOwner.js';
import { createPostgresApiReadOwner } from '../api/postgresApiReadOwner.js';
import { createSqliteApiCommandOwner } from '../api/sqliteApiCommandOwner.js';
import { createPostgresApiCommandOwner } from '../api/postgresApiCommandOwner.js';
import { hostCommands, type CommandHost } from './commandHost.js';
import { ensureAppRecordHistory, historyRules } from '../recordHistory.js';
import { ensureAppLive } from '../live/liveBinding.js';
import { appKeepsInbox, ensureAppInbox } from '../inbox.js';
// The mode's own flags and its token are read in startupOptions.ts, before this loads.
import { APP_MCP_TOKEN_VARIABLE } from '@mistriwork/engine/server/cli/startupOptions.js';
import { commandsOf } from '../stores/commandStores.js';

type Session = Readonly<{ credential: string; integers: 'decimal-string' | 'number'; engine: 'sqlite' | 'postgres'; version: string }>;
const NOT_CURRENT = `${APP_MCP_TOKEN_VARIABLE} is not a current API token for this App: it is revoked, expired, unknown or issued for another App.`;
const STORE_DOWN = `${APP_MCP_TOKEN_VARIABLE} could not be checked: the App's sign-in database did not answer, so nothing is known about the token. Try again when it does.`;
/** The owners' one "authority was never decided" answer, whichever half
 * refused: the token may be perfectly good, so the message must not say it is
 * not. Neither message has ever held the token itself. */
const storeUnreachable = (error: unknown): boolean =>
  error instanceof ApiReadFailure
    ? error.code === 'temporarily_unavailable'
    : isBusinessCommandExecutionError(error) && error.code === 'temporarily_unavailable';

/** A command's write records its history and tells whom a `notify` rule names
 * inside its own transaction, whichever door it came through: the stores are
 * bound to the adapters here as serving binds them at startup (serve.ts). */
async function bindWriteStores(registry: Registry, loadedApps: LoadedApp[]): Promise<void> {
  for (const loaded of loadedApps) {
    const host: AppHost = { app: loaded, pages: [] };
    if (historyRules(loaded.app, loaded.pages).size) await ensureAppRecordHistory(registry, host);
    if (appKeepsInbox(loaded.app)) await ensureAppInbox(registry, host);
    // And live sync's change row, so a page open on a server elsewhere hears what an agent changed.
    ensureAppLive(registry, host);
  }
}

export async function serveAppMcp(opts: Options, registry: Registry, loadedApps: LoadedApp[], session: Session): Promise<void> {
  if (isTenantApp(loadedApps[0].app)) return serveTenantAppMcp(opts, registry, loadedApps[0], session);
  if (isRowPolicyApp(loadedApps[0].app)) return serveRowPolicyAppMcp(opts, registry, loadedApps, session);
  const loaded = loadedApps[0],
    app = loaded.app,
    host: AppHost = { app: loaded, pages: [] };
  const owners: Array<{ retire(): Promise<void> }> = [];
  let hosted: CommandHost | undefined, stopping: Promise<void> | undefined;
  const stop = (status: number) =>
    (stopping ??= (async () => {
      // Owners first: nothing may answer once their stores begin to close.
      for (const owner of owners.reverse()) {
        try {
          await owner.retire();
        } catch {
          status = 1;
        }
      }
      // Opened (and so attested) by the command host; publishing is the HTTP
      // server's work, so it is stopped here without ever having started.
      try {
        await hosted?.effectHost?.stop();
      } catch {
        status = 1;
      }
      try {
        host.auth?.close();
      } catch {
        status = 1;
      }
      try {
        await registry.closeAll();
      } catch {
        status = 1;
      }
      // Every answer already written reaches the client before the process ends.
      await new Promise<void>((done) => process.stdout.write('', () => done()));
      process.exit(status);
    })());
  const signal = () => {
    void stop(0);
  };
  process.on('SIGINT', signal);
  process.on('SIGTERM', signal);
  try {
    // A read-only session loads no command code. The command host refuses,
    // and exits, on a registry that does not fit the App.
    if (opts.commands !== undefined || loadedApps.some((loaded) => loaded.commands))
      hosted = await hostCommands(opts, registry, loadedApps);
    if (hosted) await bindWriteStores(registry, loadedApps);
    const hosting = hosted?.commandHosting,
      exposes = apiExposesCommands(app.api);
    if (exposes && !hosting) throw new Error('This App exposes API commands: --app-mcp needs --commands <file>.');
    // No cookie, callback or origin is ever served here; the runtime is the
    // App's native store, which the owners observe tokens through. Without
    // sessions it needs, and holds, no BETTER_AUTH_SECRET.
    host.auth = await createAppAuth(loaded, {
      baseURL: 'http://127.0.0.1',
      trustedOrigins: ['http://127.0.0.1'],
      excludeConnections: registry.configs(),
      sessions: false,
    });
    const reference = app.sources ? app.sources[homeSourceOf(app)!]?.connection : app.connection;
    const matches = registry
      .list()
      .filter((connection) => reference === undefined || connection.id === reference || connection.name === reference);
    if (matches.length !== 1) throw new Error("The App's entry connection is unavailable or ambiguous.");
    // Routing only (tool names, key codecs); every call is the owners' to authorize.
    const resources = await loadAppRuntimeResources(registry, readApiApp(app), matches[0].id);
    const evidence = {
      connectionFor: resources.connectionFor,
      writableConnection: (id: string) => registry.configOf(id)?.writable === true,
      transactionalConnection: (id: string) => !!commandsOf(resources.forConnection(id)).commandTransaction,
    };
    const wire = { wire: 'api-v1' as const, integers: session.integers };
    let deliver: Parameters<typeof createAppMcpSession>[0]['deliver'];
    let commands: Parameters<typeof createAppMcpSession>[0]['commands'];
    if (session.engine === 'sqlite') {
      const reader = await createSqliteApiReadOwner(registry, host, session.integers);
      owners.push(reader);
      deliver = sqliteAppMcpReads(reader);
      if (exposes) {
        const owner = await createSqliteApiCommandOwner(registry, host, hosting!, wire);
        owners.push(owner);
        commands = { registry: hosting!.registry, evidence, deliver: sqliteAppMcpCommands(owner) };
      }
    } else {
      const reader = await createPostgresApiReadOwner(registry, host, session.integers);
      owners.push(reader);
      deliver = postgresAppMcpReads(reader);
      if (exposes) {
        const owner = await createPostgresApiCommandOwner(registry, host, hosting!, wire);
        owners.push(owner);
        commands = { registry: hosting!.registry, evidence, deliver: postgresAppMcpCommands(owner) };
      }
    }
    // Once at startup, through the owner that answers tools/list: a revoked,
    // expired, unknown or other-App token stops here, before a client sees a
    // tool. Every later call is still authorized on its own.
    let accepted = false,
      refusal: unknown;
    await (commands?.deliver ?? deliver)(session.credential, { tools: true }, new AbortController().signal, () => {
      accepted = true;
    }).catch((error: unknown) => {
      refusal = error;
    });
    if (!accepted) throw new Error(storeUnreachable(refusal) ? STORE_DOWN : NOT_CURRENT);
    const mcp = createAppMcpSession({
      input: process.stdin,
      output: process.stdout,
      credential: session.credential,
      version: session.version,
      app,
      schema: resources.schema,
      integers: session.integers,
      deliver,
      ...(commands ? { commands } : {}),
    });
    console.log(`mistri: "${app.name}" API as MCP tools on stdio (${session.engine}, ${commands ? 'reads and commands' : 'reads'})`);
    await mcp.done;
    await stop(0);
  } catch (error) {
    // Owner refusals carry no detail, and nothing here ever held the token in a message.
    console.error(
      `App MCP startup error: ${error instanceof Error && error.message ? startupReport(error) : 'the App API could not be prepared.'}`,
    );
    await stop(1);
  }
}

/** A tenant App's session. The deployment is enrolled here, under its
 * --policy, exactly as the tenant host enrolls it — except that no browser
 * session exists, so only App API requests answer — and one tenant API owner
 * answers reads and commands alike, each call bound to the token's one
 * membership. Its command registry is the deployment's, from --commands. */
async function serveTenantAppMcp(opts: Options, registry: Registry, loaded: LoadedApp, session: Session): Promise<void> {
  let auth: AppAuthRuntime | undefined, enrollment: TenantEnrollment<IncomingMessage> | undefined;
  let owner: Awaited<ReturnType<typeof createTenantApiOwner>> | undefined, stopping: Promise<void> | undefined;
  const stop = (status: number) =>
    (stopping ??= (async () => {
      // The owner first, then the deployment it answers through, then the stores.
      try {
        await owner?.retire();
      } catch {
        status = 1;
      }
      try {
        await enrollment?.retire();
      } catch {
        status = 1;
      }
      try {
        auth?.close();
      } catch {
        status = 1;
      }
      try {
        await registry.closeAll();
      } catch {
        status = 1;
      }
      await new Promise<void>((done) => process.stdout.write('', () => done()));
      process.exit(status);
    })());
  const signal = () => {
    void stop(0);
  };
  process.on('SIGINT', signal);
  process.on('SIGTERM', signal);
  try {
    if (!opts.policy) throw new Error("A tenant App's --app-mcp needs its --policy <file>.");
    const { prepareTenantStartup } = await import('../tenant/tenantStartup.js');
    const prepared = await prepareTenantStartup({
      loaded,
      connections: registry.configs(),
      policyFile: opts.policy,
      ...(opts.commands ? { commandsFile: opts.commands } : {}),
    });
    // As for any App's session: the native store only, no sessions, no secret.
    auth = await createAppAuth(loaded, {
      baseURL: 'http://127.0.0.1',
      trustedOrigins: ['http://127.0.0.1'],
      excludeConnections: registry.configs(),
      ...(prepared.authStoreExclusion ? { excludeStore: prepared.authStoreExclusion } : {}),
      sessions: false,
    });
    enrollment = await createTenantEnrollment({
      ...prepared.enrollment,
      app: loaded.app,
      pages: loaded.pages,
      verifySession: withTenantApiRequests<IncomingMessage>(async () => null),
      // A notice to a person (a tenant App's people hold account ids) is kept at the account's email.
      accountEmail: (accountId: string) => nativeAccountEmailOf(auth!, accountId),
    });
    owner = await createTenantApiOwner({ enrollment, auth, integers: session.integers });
    const active = owner,
      routing = owner.routing;
    const deliver = tenantAppMcpReads(active);
    const commands = routing.commands
      ? { registry: routing.registry!, evidence: routing.evidence, deliver: tenantAppMcpCommands(active) }
      : undefined;
    // Once at startup, as for any App: a token that is not current, or whose
    // membership no longer acts, stops here, before a client sees a tool.
    let accepted = false,
      refusal: unknown;
    await (commands?.deliver ?? deliver)(session.credential, { tools: true }, new AbortController().signal, () => {
      accepted = true;
    }).catch((error: unknown) => {
      refusal = error;
    });
    if (!accepted) {
      throw new Error(storeUnreachable(refusal) ? STORE_DOWN : `${NOT_CURRENT.slice(0, -1)}, or its tenant membership no longer acts.`);
    }
    const mcp = createAppMcpSession({
      input: process.stdin,
      output: process.stdout,
      credential: session.credential,
      version: session.version,
      app: loaded.app,
      schema: routing.schema,
      integers: session.integers,
      deliver,
      tenant: { reads: routing.reads, ...(routing.commands ? { commands: routing.commands } : {}) },
      ...(commands ? { commands } : {}),
    });
    console.log(
      `mistri: "${loaded.app.name}" API as MCP tools on stdio (${session.engine}, tenant, ${commands ? 'reads and commands' : 'reads'})`,
    );
    await mcp.done;
    await stop(0);
  } catch (error) {
    console.error(
      `App MCP startup error: ${error instanceof Error && error.message ? startupReport(error) : 'the App API could not be prepared.'}`,
    );
    await stop(1);
  }
}

/** A row-policy App's session. Its policy is loaded here, under --policy, as
 * serving loads it — except that no browser session exists, so only App API
 * requests answer — and one owner answers reads and commands alike, each call
 * in the deployment's context for the token's account (policyApiOwner.ts).
 * Its commands are the deployment's, from --commands. */
async function serveRowPolicyAppMcp(opts: Options, registry: Registry, loadedApps: LoadedApp[], session: Session): Promise<void> {
  const loaded = loadedApps[0],
    app = loaded.app;
  let auth: AppAuthRuntime | undefined, policy: HttpAppPolicy | undefined, hosted: CommandHost | undefined;
  let owner: Awaited<ReturnType<typeof createPolicyApiOwner>> | undefined, stopping: Promise<void> | undefined;
  const stop = (status: number) =>
    (stopping ??= (async () => {
      // The owner first, then the deployment it answers through, then the stores.
      try {
        await owner?.retire();
      } catch {
        status = 1;
      }
      try {
        await policy?.retire();
      } catch {
        status = 1;
      }
      try {
        await hosted?.effectHost?.stop();
      } catch {
        status = 1;
      }
      try {
        auth?.close();
      } catch {
        status = 1;
      }
      try {
        await registry.closeAll();
      } catch {
        status = 1;
      }
      await new Promise<void>((done) => process.stdout.write('', () => done()));
      process.exit(status);
    })());
  const signal = () => {
    void stop(0);
  };
  process.on('SIGINT', signal);
  process.on('SIGTERM', signal);
  try {
    if (!opts.policy) throw new Error("A row-policy App's --app-mcp needs its --policy <file>.");
    if (opts.commands !== undefined || loadedApps.some((candidate) => candidate.commands))
      hosted = await hostCommands(opts, registry, loadedApps);
    if (hosted) await bindWriteStores(registry, loadedApps);
    if (apiExposesCommands(app.api) && !hosted?.commandHosting)
      throw new Error('This App exposes API commands: --app-mcp needs --commands <file>.');
    // As for any App's session: the native store only, no sessions, no secret.
    auth = await createAppAuth(loaded, {
      baseURL: 'http://127.0.0.1',
      trustedOrigins: ['http://127.0.0.1'],
      excludeConnections: registry.configs(),
      sessions: false,
    });
    policy = await loadHttpAppPolicy({
      app,
      registry,
      file: opts.policy,
      ...(hosted?.commandHosting ? { commands: hosted.commandHosting.registry } : {}),
      verifySession: withTenantApiRequests<IncomingMessage>(async () => null),
    });
    owner = await createPolicyApiOwner({ policy, app, auth, registry, integers: session.integers });
    const active = owner,
      routing = owner.routing;
    const deliver = tenantAppMcpReads(active);
    const commands = routing.commands
      ? { registry: routing.registry!, evidence: routing.evidence, deliver: tenantAppMcpCommands(active) }
      : undefined;
    // Once at startup, as for any App: a token that is not current stops here, before a client sees a tool.
    let accepted = false,
      refusal: unknown;
    await (commands?.deliver ?? deliver)(session.credential, { tools: true }, new AbortController().signal, () => {
      accepted = true;
    }).catch((error: unknown) => {
      refusal = error;
    });
    if (!accepted) throw new Error(storeUnreachable(refusal) ? STORE_DOWN : NOT_CURRENT);
    const mcp = createAppMcpSession({
      input: process.stdin,
      output: process.stdout,
      credential: session.credential,
      version: session.version,
      app,
      schema: routing.schema,
      integers: session.integers,
      deliver,
      tenant: { reads: routing.reads, ...(routing.commands ? { commands: routing.commands } : {}) },
      ...(commands ? { commands } : {}),
    });
    console.log(
      `mistri: "${app.name}" API as MCP tools on stdio (${session.engine}, row policy, ${commands ? 'reads and commands' : 'reads'})`,
    );
    await mcp.done;
    await stop(0);
  } catch (error) {
    console.error(
      `App MCP startup error: ${error instanceof Error && error.message ? startupReport(error) : 'the App API could not be prepared.'}`,
    );
    await stop(1);
  }
}
