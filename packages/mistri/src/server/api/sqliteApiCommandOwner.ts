/** Private ordinary SQLite command owner. No routes, cookie fallback or caller
 * supplied principal. Construction receives trusted serving composition objects;
 * AppHost itself is not a native authority brand. Retire before reload/close. */
import { prepareApiCommand, apiCommandPreparation } from './apiCommandPrepare.js';
import { isProxy } from 'node:util/types';
import { Registry } from '@mistriwork/engine/server/connections.js';
import { isSqliteVerifiedCommandSource, type SqliteAdapter } from '@mistriwork/engine/adapters/sqlite.js';
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { throwIfCancelled } from '@mistriwork/engine/adapters/statementControl.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import type { AppHost, LoadedApp } from '../app/apps.js';
import { appProblems } from '../app/apps.js';
import { homeSourceOf, logicalResource } from '../../shared/app.js';
import { commandKeyText } from '../../shared/command.js';
import { appSourceConnections, loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import type { CommandHosting } from '../http/appContext.js';
import { defineCommands } from '../commands/businessCommands.js';
import { bindVerifiedBusinessCommands } from '../commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../commands/businessCommandExecution.js';
import { recoverBusinessCommandReceipt } from '../commands/businessCommandRecovery.js';
import { BusinessCommandExecutionError, isBusinessCommandExecutionError } from '../commands/commandErrors.js';
import { acquireSqliteApiCommandTokenObservation, captureAppAuthRuntime, type AppAuthRuntime } from '../auth/auth.js';
import { ApiTokenStoreUnavailable } from '../auth/apiTokenStoreFailure.js';
import { commandProblem, projectApiCommandAnswer, refusalHeaders, REFUSAL_STATUS } from './apiCommandResponse.js';
import { createApiCommandRequestMapper } from './apiCommandRequest.js';
import type { ApiCommandRoute } from './apiCommandRoute.js';
import { narrowApiOpenApi, renderApiOpenApi } from './apiOpenApiDocument.js';
import { previewApiMcpReadTools } from './apiMcpReadTools.js';
import { projectApiMcpCommandTools } from './apiMcpCommandTools.js';
import { readApiApp } from './appApiValidation.js';
import { apiWrites, withApiWrites } from './apiGenericWrites.js';
import { AppAccessDenied } from '../app/appAccess.js';
import type { CaptureCommandFlags } from '../commands/commandFlags.js';
import { commandFlagsOnce } from '../commands/commandFlagCapture.js';
import { apiCommandLaneConnections, apiCommandLaneOf } from './apiSourceLanes.js';
import { apiCatalogOn } from './apiValueCodec.js';
import { commandsOf } from '../stores/commandStores.js';

const refuse = (): never => {
  throw new BusinessCommandExecutionError('temporarily_unavailable', 'unknown');
};
/** A credential that is missing, malformed, expired or revoked before any
 * business work ran: the one owner refusal a transport may answer as 401. */
export class ApiCommandUnauthenticated extends Error {
  constructor() {
    super('A valid API credential is required.');
    this.name = 'ApiCommandUnauthenticated';
  }
}
function own(value: object, name: string): unknown {
  if (!value || typeof value !== 'object' || isProxy(value)) return refuse();
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) return refuse();
  return descriptor.value;
}
/** The targets this request named, as the executor spells them. */
function requestedKeys(captured: object): Set<string> {
  const many = own(captured, 'keys'),
    single = own(captured, 'key');
  const keys = Array.isArray(many) ? many : single === undefined ? [] : [single];
  return new Set(keys.map(commandKeyText).filter((text) => text !== ''));
}
function hostState(host: AppHost) {
  if (own(host, 'unavailable') || own(host, 'loadError')) return refuse();
  const loaded = own(host, 'app') as LoadedApp,
    auth = own(host, 'auth') as AppAuthRuntime;
  if (!auth) return refuse();
  return { loaded, auth, app: captureTenantData(own(loaded, 'app')) as LoadedApp['app'] };
}

/** `wire` is fixed at construction by the trusted serving composition, never by
 * a request: `internal` keeps the executor's own result shape; `api-v1` answers
 * with the design's receipt envelopes and maps API routes, so it also needs the
 * explicit integer representation. Refusals are problem details in both. */
export async function createSqliteApiCommandOwner(
  registry: Registry,
  host: AppHost,
  hosting: CommandHosting,
  options: {
    readonly wire?: 'internal' | 'api-v1';
    readonly integers?: 'decimal-string' | 'number';
    readonly captureFlags?: CaptureCommandFlags;
  } = {},
) {
  const acquisitions: (() => void)[] = [];
  const acquisitionRelease = () => {
    for (const release of acquisitions.splice(0)) release();
  };
  let capability: ReturnType<typeof acquireSqliteApiCommandTokenObservation> | undefined;
  try {
    if (isProxy(registry) || !(registry instanceof Registry)) return refuse();
    const wire = own(options, 'wire') ?? 'internal',
      integers = own(options, 'integers');
    const captureFlags = own(options, 'captureFlags') as CaptureCommandFlags | undefined;
    if (captureFlags !== undefined && (typeof captureFlags !== 'function' || isProxy(captureFlags))) return refuse();
    if (wire !== 'internal' && wire !== 'api-v1') return refuse();
    if (wire === 'api-v1' ? integers !== 'decimal-string' && integers !== 'number' : integers !== undefined) return refuse();
    const initial = hostState(host),
      app = initial.app;
    if (!app.api || app.auth?.rows !== 'all' || !captureAppAuthRuntime(initial.auth).synchronous || own(hosting, 'appId') !== app.id)
      return refuse();
    // Exposure decides 403 against 404: an exposed command this token cannot
    // call is forbidden; any other name is not in this API at all.
    const exposed = new Set(app.api.commands.map((exposure) => exposure.command.id));
    const originalCommands = own(hosting, 'registry') as CommandHosting['registry'];
    const commands = defineCommands(originalCommands);
    const events = own(hosting, 'events') as CommandHosting['events'];
    const matches = app.connection
      ? registry.list().filter((entry) => entry.id === app.connection || entry.name === app.connection)
      : registry.list();
    const bindings = app.sources ? appSourceConnections(registry, app) : new Map(matches.length === 1 ? [['', matches[0].id]] : []);
    const connection = bindings.get(app.sources ? homeSourceOf(app)! : '');
    if (!connection) return refuse();
    /* One binding is the shape every one-source App had. With several, a
       command commits on its target's connection (its lane, apiSourceLanes.ts),
       and each lane must be writable; the home source need not be. */
    const single = bindings.size === 1;
    const configs = new Map([...new Set(bindings.values())].map((id) => [id, registry.configOf(id)]));
    if ([...configs.values()].some((config) => !config)) return refuse();
    if (single && configs.get(connection)!.writable !== true) return refuse();
    const definition = JSON.stringify(app),
      configuration = JSON.stringify([...configs.values()].map((config) => captureTenantData(config)));
    let retired = false,
      clearResults = () => {};
    const adapterCurrent = new Map<string, () => void>();
    const current = () => {
      try {
        const state = hostState(host);
        if (
          retired ||
          state.loaded !== initial.loaded ||
          state.auth !== initial.auth ||
          JSON.stringify(state.app) !== definition ||
          [...configs].some(([id, config]) => registry.configOf(id) !== config) ||
          JSON.stringify([...configs.values()].map((config) => captureTenantData(config))) !== configuration ||
          own(hosting, 'appId') !== app.id ||
          own(hosting, 'registry') !== originalCommands ||
          own(hosting, 'events') !== events
        )
          return refuse();
        const observed = defineCommands(originalCommands);
        if (
          Object.keys(observed).length !== Object.keys(commands).length ||
          Object.keys(commands).some((id) => observed[id] !== commands[id])
        )
          return refuse();
        captureAppAuthRuntime(initial.auth).assertCurrent();
        for (const check of adapterCurrent.values()) check();
      } catch {
        retired = true;
        clearResults();
        capability?.retire();
        return refuse();
      }
    };
    current();
    const open = async (lane: string) => {
      acquisitions.push(registry.lease(lane));
      const opened = await registry.open(lane),
        physical = opened.adapter;
      if (!isSqliteVerifiedCommandSource(physical)) return refuse();
      const lifetime = registry.captureAdapterLifetime(lane, physical),
        schemaLifetime = physical.captureSchemaLifetime(opened.schema);
      adapterCurrent.set(lane, () => {
        lifetime();
        schemaLifetime();
      });
      current();
      return physical as SqliteAdapter;
    };
    const physicals = new Map<string, SqliteAdapter>();
    if (single) physicals.set(connection, await open(connection));
    else acquisitions.push(registry.lease(connection));
    // Only loading uses this projection. Original App authority and command
    // declarations are checked by the command capability and shared binder.
    const resources = await loadAppRuntimeResources(registry, { ...app, api: { ...app.api, commands: [] } }, connection);
    current();
    // The API serves the App's commands and its generic writes (apiGenericWrites.ts):
    // the binding keeps the App itself, whose roles grant both.
    const served = withApiWrites(app, resources.schema, commands),
      apiApp = served.app,
      apiCommands = served.registry!;
    for (const write of apiWrites(app.api)) exposed.add(write.id);
    const lanes = single ? [connection] : apiCommandLaneConnections(app, apiCommands, resources, exposed);
    if (!lanes.length || lanes.some((lane) => configs.get(lane)?.writable !== true)) return refuse();
    for (const lane of lanes) if (!physicals.has(lane)) physicals.set(lane, await open(lane));
    for (const [lane, physical] of physicals) if ((await registry.open(lane)).adapter !== physical) return refuse();
    current();
    const targets = [...exposed].flatMap((id) =>
      Object.hasOwn(apiCommands, id) ? [logicalResource(app, apiCommands[id].source, apiCommands[id].target)] : [],
    );
    if (!apiCatalogOn(resources.schema, 'sqlite', targets) || appProblems(initial.loaded, resources.schema).length) return refuse();
    /* Every command connection is evidence, each judged by its own config: the
       authorizer binds the whole registry at once and keeps each command on
       one connection; the exposed ones run on their lanes. */
    const evidence = {
      connectionFor: resources.connectionFor,
      writableConnection: (id: string) => configs.has(id) && registry.configOf(id)?.writable === true,
      transactionalConnection: (id: string) => configs.has(id) && !!commandsOf(resources.forConnection(id)).commandTransaction,
    };
    capability = acquireSqliteApiCommandTokenObservation(initial.auth, apiApp, resources.schema, apiCommands, evidence);
    const auth = capability;
    // Built on the same logical schema and evidence the executor is bound to.
    const mapper =
      wire === 'api-v1'
        ? createApiCommandRequestMapper(apiApp, resources.schema, apiCommands, evidence, {
            integers: integers as 'decimal-string' | 'number',
          })
        : undefined;
    current();
    acquisitionRelease();
    type Observation = ReturnType<typeof auth.inspect>;
    type Buffered = {
      credential: unknown;
      observation: Observation;
      status: number;
      headers: Readonly<Record<string, string>>;
      body: string;
      bytes: number;
      signal?: AbortSignal;
    };
    const pending = new Set<Promise<unknown>>(),
      results = new Map<object, Buffered>();
    let bufferedBytes = 0;
    clearResults = () => {
      results.clear();
      bufferedBytes = 0;
    };
    const forget = (handle: object) => {
      const value = results.get(handle);
      if (value) {
        results.delete(handle);
        bufferedBytes -= value.bytes;
      }
      return value;
    };
    const fresh = (credential: unknown, expected: Observation, signal?: AbortSignal) => {
      if (signal) throwIfCancelled(signal);
      current();
      const handle = auth.observe(credential),
        observed = auth.inspect(handle);
      if (JSON.stringify(observed) !== JSON.stringify(expected)) return refuse();
      current();
      auth.inspect(handle);
    };
    const run = (
      mode: 'execute' | 'recover' | 'prepare' | 'spec' | 'tools',
      credential: unknown,
      request: unknown,
      signal?: AbortSignal,
      door: 'api' | 'mcp' = 'api',
    ) => {
      const work = Promise.resolve().then(async () => {
        let release: (() => void) | undefined;
        try {
          if (signal) throwIfCancelled(signal);
          current();
          // A document or a tool listing carries no envelope.
          const listing = mode === 'spec' || mode === 'tools';
          const captured = listing ? undefined : snapshot(request, 131072).value;
          const named = captured && typeof captured === 'object' && !Array.isArray(captured) ? own(captured, 'command') : undefined;
          if (!listing && typeof named !== 'string') return refuse();
          const command = named as string;
          // A command commits on its target's connection; a listing is served on the first lane.
          const lane = single ? connection : listing ? lanes[0] : (apiCommandLaneOf(app, apiCommands, resources, command) ?? lanes[0]);
          const physical = physicals.get(lane) ?? physicals.get(lanes[0])!;
          release = registry.lease(lane);
          let observation: ReturnType<typeof auth.inspect>;
          // Nothing has run yet; a transport may say so as 401 — unless the
          // token store itself could not be read, which says nothing about the
          // credential and refuses as 503 with the outcome unknown.
          try {
            observation = auth.inspect(auth.observe(credential));
          } catch (error) {
            if (error instanceof ApiTokenStoreUnavailable) return refuse();
            throw new ApiCommandUnauthenticated();
          }
          let answer: { status: number; headers?: Readonly<Record<string, string>>; value: unknown };
          if (mode === 'spec') {
            // The composed document for what this token may call now: fresh
            // native operation IDs narrow both halves, never request roles.
            if (!mapper) return refuse();
            current();
            if ((await registry.open(lane)).adapter !== physical) return refuse();
            current();
            const document = renderApiOpenApi(apiApp, resources.schema, apiCommands, evidence, {
              integers: integers as 'decimal-string' | 'number',
            }).document;
            answer = { status: 200, value: narrowApiOpenApi(document, observation.operations) };
          } else if (mode === 'tools') {
            // App MCP discovery from this one fresh observation, which holds the
            // token's read and command operations alike: one owner, one answer.
            if (!mapper) return refuse();
            current();
            if ((await registry.open(lane)).adapter !== physical) return refuse();
            current();
            const roles = [...observation.roles];
            const reads = previewApiMcpReadTools(
              readApiApp(app),
              resources.schema,
              { integers: integers as 'decimal-string' | 'number' },
              { operations: observation.operations.filter((id) => /^(?:item|list|view):/.test(id)), roles },
              'owner',
            );
            const runs = projectApiMcpCommandTools(
              apiApp,
              resources.schema,
              apiCommands,
              evidence,
              { integers: integers as 'decimal-string' | 'number' },
              { operations: observation.operations.filter((id) => id.startsWith('command:')), roles },
            );
            answer = { status: 200, value: { tools: [...reads.tools, ...runs.tools] } };
          } else if (!observation.operations.includes(`command:${command}`)) {
            // No business work ran, so nothing was applied.
            answer = {
              status: exposed.has(command) ? 403 : 404,
              value: commandProblem(exposed.has(command) ? 'forbidden' : 'not_found', 'not_applied'),
            };
          } else {
            current();
            if ((await registry.open(lane)).adapter !== physical) return refuse();
            current();
            const verify = () => fresh(credential, observation, signal);
            const binding = bindVerifiedBusinessCommands(
              { app, registry: apiCommands, resources, writableConnection: evidence.writableConnection, ...(events ? { events } : {}) },
              verify,
            );
            const actor = { id: observation.subject.id, appId: app.id, roles: [...observation.roles] };
            try {
              const authorized = binding.authorize(command, actor);
              const flags = mode === 'recover' ? undefined : await commandFlagsOnce(() => captureFlags?.(authorized.actor))();
              fresh(credential, observation, signal);
              // Never race abort against the native writer. Shared execution owns
              // statement/callback drain and the final verifier rolls back on abort.
              const result =
                mode === 'prepare'
                  ? await prepareApiCommand(binding, actor, captured, signal, flags)
                  : mode === 'execute'
                    ? await executeBusinessCommand(binding, actor, captured, { signal, door, flags })
                    : await recoverBusinessCommandReceipt(binding, actor, captured, { signal });
              // Recovered target keys answer in this API's integer representation.
              answer =
                mode === 'prepare'
                  ? apiCommandPreparation(result)
                  : wire === 'api-v1'
                    ? projectApiCommandAnswer(mode, result, (key) => mapper!.targetKey(command, key))
                    : { status: 200, value: result };
            } catch (cause) {
              const error =
                cause instanceof AppAccessDenied
                  ? new BusinessCommandExecutionError('forbidden', mode === 'recover' ? 'unknown' : 'not_applied')
                  : cause;
              // The executor already classified the failure and its outcome.
              // Cancellation and anything outside the table stay thrown.
              const code = isBusinessCommandExecutionError(error) ? error.code : undefined;
              if (!code || !Object.hasOwn(REFUSAL_STATUS, code)) throw error;
              const refusal = error as BusinessCommandExecutionError;
              const key = refusal.key && requestedKeys(captured as object).has(commandKeyText(refusal.key)) ? refusal.key : undefined;
              answer = {
                status: REFUSAL_STATUS[code]!,
                value: commandProblem(code, refusal.outcome, refusal.field, key),
                headers: refusalHeaders(code),
              };
            }
          }
          // A refusal is serialized and re-authorized exactly like a result: a
          // revocation before the final check yields no stale business answer.
          const body = snapshot(answer.value, listing ? 2_097_152 : 1024 * 1024).json;
          fresh(credential, observation, signal);
          for (const [handle, value] of results) if (value.observation.expiresAt <= Date.now()) forget(handle);
          const bytes = Buffer.byteLength(body);
          if (results.size >= 16 || bufferedBytes + bytes > 8 * 1024 * 1024) return refuse();
          const handle = Object.freeze(Object.create(null)) as object;
          results.set(handle, {
            credential,
            observation,
            status: answer.status,
            headers: Object.freeze({ ...(answer.headers ?? {}) }),
            body,
            bytes,
            signal,
          });
          bufferedBytes += bytes;
          return handle;
        } catch (error) {
          if (error instanceof ApiCommandUnauthenticated) throw error;
          // Even a local refusal may follow an earlier commit/retry. No result,
          // target or handler detail escapes; never falsely claim not_applied.
          return refuse();
        } finally {
          release?.();
        }
      });
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      return work;
    };
    return Object.freeze({
      prepare: (credential: unknown, request: unknown, signal?: AbortSignal) => run('prepare', credential, request, signal),
      /** `door` is `mcp` for App MCP's command tools (appMcpSession.ts): the handler is told which. */
      execute: (credential: unknown, request: unknown, signal?: AbortSignal, door?: 'mcp') =>
        run('execute', credential, request, signal, door),
      recover: (credential: unknown, request: unknown, signal?: AbortSignal) => run('recover', credential, request, signal),
      /** api-v1 only: the composed `$openapi` document, narrowed per token. */
      readSpec: (credential: unknown, signal?: AbortSignal) => run('spec', credential, undefined, signal),
      /** api-v1 only: App MCP `{tools}` — read and command — for this token now. */
      readTools: (credential: unknown, signal?: AbortSignal) => run('tools', credential, undefined, signal),
      /** Pure: the executor still validates everything the envelope says. */
      map: (route: ApiCommandRoute, headers: Readonly<{ expectedVersion?: number; idempotencyKey?: string }>, body: unknown) => {
        if (!mapper || retired) return refuse();
        return mapper.map(route, headers, body);
      },
      consumeResult: (handle: unknown) => {
        try {
          if (!handle || typeof handle !== 'object' || isProxy(handle)) return refuse();
          const result = forget(handle);
          if (!result) return refuse();
          fresh(result.credential, result.observation, result.signal);
          return Object.freeze({ status: result.status, headers: result.headers, body: result.body });
        } catch {
          return refuse();
        }
      },
      discardResult: (handle: unknown) => {
        if (handle && typeof handle === 'object' && !isProxy(handle)) forget(handle);
      },
      retire: async () => {
        retired = true;
        auth.retire();
        clearResults();
        await Promise.allSettled([...pending]);
      },
    });
  } catch {
    capability?.retire();
    return refuse();
  } finally {
    acquisitionRelease();
  }
}
