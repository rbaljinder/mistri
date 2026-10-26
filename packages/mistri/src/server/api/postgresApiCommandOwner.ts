/** Private ordinary PostgreSQL command owner: the SQLite owner's contract on
 * the PG verified command transaction. No routes, cookie fallback or caller
 * supplied principal. Native token observation is asynchronous here, so an
 * answer is delivered through the native handoff (as the PG read owner does),
 * never buffered for a later consume. Retire before reload/close. */
import { prepareApiCommand, apiCommandPreparation } from './apiCommandPrepare.js';
import { isAsyncFunction, isGeneratorFunction, isPromise, isProxy } from 'node:util/types';
import { Registry } from '@mistriwork/engine/server/connections.js';
import { isPostgresVerifiedCommandSource } from '@mistriwork/engine/adapters/postgres.js';
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
import { acquirePostgresApiCommandTokenObservation, captureAppAuthRuntime, type AppAuthRuntime } from '../auth/auth.js';
import { ApiTokenStoreUnavailable } from '../auth/apiTokenStoreFailure.js';
import { commandProblem, projectApiCommandAnswer, refusalHeaders, REFUSAL_STATUS } from './apiCommandResponse.js';
import { createApiCommandRequestMapper } from './apiCommandRequest.js';
import type { ApiCommandRoute } from './apiCommandRoute.js';
import { ApiCommandUnauthenticated } from './sqliteApiCommandOwner.js';
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
function own(value: object, name: string): unknown {
  if (!value || typeof value !== 'object' || isProxy(value)) return refuse();
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) return refuse();
  return descriptor.value;
}
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
type Answer = Readonly<{ status: number; headers: Readonly<Record<string, string>>; body: string }>;
type Send = (answer: Answer) => void;
const uncertain = () => Object.freeze({ stage: 'postgres-command-response' as const, outcome: 'uncertain' as const });

/** `wire` and `integers` are fixed at construction exactly as on SQLite. */
export async function createPostgresApiCommandOwner(
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
  let capability: Awaited<ReturnType<typeof acquirePostgresApiCommandTokenObservation>> | undefined;
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
    if (!app.api || app.auth?.rows !== 'all' || captureAppAuthRuntime(initial.auth).synchronous || own(hosting, 'appId') !== app.id)
      return refuse();
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
    // As on SQLite: one binding as before; with several, a lane per command connection.
    const single = bindings.size === 1;
    const configs = new Map([...new Set(bindings.values())].map((id) => [id, registry.configOf(id)]));
    if ([...configs.values()].some((config) => !config)) return refuse();
    if (single && configs.get(connection)!.writable !== true) return refuse();
    const definition = JSON.stringify(app),
      configuration = JSON.stringify([...configs.values()].map((config) => captureTenantData(config)));
    let retired = false;
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
        void capability?.retire();
        return refuse();
      }
    };
    current();
    const open = async (lane: string) => {
      acquisitions.push(registry.lease(lane));
      const opened = await registry.open(lane),
        physical = opened.adapter;
      if (!isPostgresVerifiedCommandSource(physical)) return refuse();
      const nativePrototype = Object.getPrototypeOf(physical);
      // As the PG read owner: adapter lifetime and native prototype. The PG
      // adapter has no schema-lifetime capture; the verified transaction
      // attests its journal and the executor re-reads the target inside it.
      const lifetime = registry.captureAdapterLifetime(lane, physical);
      adapterCurrent.set(lane, () => {
        lifetime();
        if (Object.getPrototypeOf(physical) !== nativePrototype) return refuse();
        for (let prototype = nativePrototype; prototype; prototype = Object.getPrototypeOf(prototype)) {
          if (isProxy(prototype)) return refuse();
        }
      });
      current();
      return physical as object;
    };
    const physicals = new Map<string, object>();
    if (single) physicals.set(connection, await open(connection));
    else acquisitions.push(registry.lease(connection));
    // Only loading uses this projection, exactly as on SQLite.
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
    if (!apiCatalogOn(resources.schema, 'postgres', targets) || appProblems(initial.loaded, resources.schema).length) return refuse();
    // As on SQLite: every command connection is evidence, judged by its own config.
    const evidence = {
      connectionFor: resources.connectionFor,
      writableConnection: (id: string) => configs.has(id) && registry.configOf(id)?.writable === true,
      transactionalConnection: (id: string) => configs.has(id) && !!commandsOf(resources.forConnection(id)).commandTransaction,
    };
    capability = await acquirePostgresApiCommandTokenObservation(initial.auth, apiApp, resources.schema, apiCommands, evidence);
    const auth = capability;
    const mapper =
      wire === 'api-v1'
        ? createApiCommandRequestMapper(apiApp, resources.schema, apiCommands, evidence, {
            integers: integers as 'decimal-string' | 'number',
          })
        : undefined;
    current();
    acquisitionRelease();
    type Observation = ReturnType<typeof auth.inspect>;
    const pending = new Set<Promise<unknown>>();
    // The async final check before COMMIT: a fresh native observation that
    // must equal the one this request was admitted with.
    const fresh = async (credential: unknown, expected: Observation, signal?: AbortSignal) => {
      if (signal) throwIfCancelled(signal);
      current();
      const handle = await auth.observe(credential);
      current();
      if (JSON.stringify(auth.inspect(handle)) !== JSON.stringify(expected)) return refuse();
    };
    const run = (
      mode: 'execute' | 'recover' | 'prepare' | 'spec' | 'tools',
      credential: unknown,
      request: unknown,
      send: Send,
      signal?: AbortSignal,
      door: 'api' | 'mcp' = 'api',
    ) => {
      // Validate the trusted callback before any native work.
      if (typeof send !== 'function' || isProxy(send) || isAsyncFunction(send) || isGeneratorFunction(send)) {
        return Promise.reject(new BusinessCommandExecutionError('temporarily_unavailable', 'unknown'));
      }
      let sendEntered = false;
      const work = Promise.resolve().then(async () => {
        let release: (() => void) | undefined;
        let answer: ReturnType<typeof uncertain> | Readonly<{ stage: 'postgres-command-response'; outcome: 'sent' }> | undefined;
        let failed = false,
          failure: unknown;
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
          let token: object, observation: Observation;
          // Nothing has run yet; a transport may say so as 401 — unless the
          // token store itself could not be read, which says nothing about the
          // credential and refuses as 503 with the outcome unknown.
          try {
            token = await auth.observe(credential);
            observation = auth.inspect(token);
          } catch (error) {
            if (error instanceof ApiTokenStoreUnavailable) return refuse();
            throw new ApiCommandUnauthenticated();
          }
          let outcome: { status: number; headers?: Readonly<Record<string, string>>; value: unknown };
          if (mode === 'spec') {
            // As on SQLite: fresh native operation IDs narrow both halves.
            if (!mapper) return refuse();
            current();
            if ((await registry.open(lane)).adapter !== physical) return refuse();
            current();
            const document = renderApiOpenApi(apiApp, resources.schema, apiCommands, evidence, {
              integers: integers as 'decimal-string' | 'number',
            }).document;
            outcome = { status: 200, value: narrowApiOpenApi(document, observation.operations) };
          } else if (mode === 'tools') {
            // As on SQLite: read and command tools from this one fresh observation.
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
            outcome = { status: 200, value: { tools: [...reads.tools, ...runs.tools] } };
          } else if (!observation.operations.includes(`command:${command}`)) {
            outcome = {
              status: exposed.has(command) ? 403 : 404,
              value: commandProblem(exposed.has(command) ? 'forbidden' : 'not_found', 'not_applied'),
            };
          } else {
            current();
            if ((await registry.open(lane)).adapter !== physical) return refuse();
            current();
            const binding = bindVerifiedBusinessCommands(
              { app, registry: apiCommands, resources, writableConnection: evidence.writableConnection, ...(events ? { events } : {}) },
              () => fresh(credential, observation, signal),
            );
            const actor = { id: observation.subject.id, appId: app.id, roles: [...observation.roles] };
            try {
              const authorized = binding.authorize(command, actor);
              const flags = mode === 'recover' ? undefined : await commandFlagsOnce(() => captureFlags?.(authorized.actor))();
              await fresh(credential, observation, signal);
              const result =
                mode === 'prepare'
                  ? await prepareApiCommand(binding, actor, captured, signal, flags)
                  : mode === 'execute'
                    ? await executeBusinessCommand(binding, actor, captured, { signal, door, flags })
                    : await recoverBusinessCommandReceipt(binding, actor, captured, { signal });
              outcome =
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
              const code = isBusinessCommandExecutionError(error) ? error.code : undefined;
              if (!code || !Object.hasOwn(REFUSAL_STATUS, code)) throw error;
              const refusal = error as BusinessCommandExecutionError;
              const key = refusal.key && requestedKeys(captured as object).has(commandKeyText(refusal.key)) ? refusal.key : undefined;
              outcome = {
                status: REFUSAL_STATUS[code]!,
                value: commandProblem(code, refusal.outcome, refusal.field, key),
                headers: refusalHeaders(code),
              };
            }
          }
          // Serialized before the native handoff re-authorizes it: a revocation
          // after COMMIT yields no stale business answer, and no downgrade.
          const body = snapshot(outcome.value, listing ? 2_097_152 : 1024 * 1024).json;
          const response: Answer = Object.freeze({ status: outcome.status, headers: Object.freeze({ ...(outcome.headers ?? {}) }), body });
          if (signal) throwIfCancelled(signal);
          current();
          const handoff = await auth.handoff(credential, token, () => {
            if (signal) throwIfCancelled(signal);
            current();
            auth.inspect(token);
            sendEntered = true;
            const returned: unknown = send(response);
            if (isPromise(returned)) void Promise.prototype.then.call(returned, undefined, () => {});
            if (returned !== undefined) return refuse();
          });
          if (!sendEntered) return refuse();
          answer =
            handoff.outcome === 'complete'
              ? Object.freeze({ stage: 'postgres-command-response' as const, outcome: 'sent' as const })
              : uncertain();
        } catch (error) {
          failed = true;
          failure = error;
        } finally {
          try {
            release?.();
          } catch (error) {
            failed = true;
            failure = error;
          }
        }
        if (failed) {
          // Once the transport was entered, only uncertainty may be reported.
          if (sendEntered) return uncertain();
          if (failure instanceof ApiCommandUnauthenticated) throw failure;
          // Even a local refusal may follow an earlier commit/retry; never
          // falsely claim not_applied and never leak handler detail.
          return refuse();
        }
        return answer ?? refuse();
      });
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      return work;
    };
    return Object.freeze({
      prepare: (credential: unknown, request: unknown, send: Send, signal?: AbortSignal) =>
        run('prepare', credential, request, send, signal),
      /** `door` is `mcp` for App MCP's command tools (appMcpSession.ts): the handler is told which. */
      execute: (credential: unknown, request: unknown, send: Send, signal?: AbortSignal, door?: 'mcp') =>
        run('execute', credential, request, send, signal, door),
      recover: (credential: unknown, request: unknown, send: Send, signal?: AbortSignal) =>
        run('recover', credential, request, send, signal),
      /** api-v1 only: the composed `$openapi` document, narrowed per token. */
      readSpec: (credential: unknown, send: Send, signal?: AbortSignal) => run('spec', credential, undefined, send, signal),
      /** api-v1 only: App MCP `{tools}` — read and command — for this token now. */
      readTools: (credential: unknown, send: Send, signal?: AbortSignal) => run('tools', credential, undefined, send, signal),
      /** Pure: the executor still validates everything the envelope says. */
      map: (route: ApiCommandRoute, headers: Readonly<{ expectedVersion?: number; idempotencyKey?: string }>, body: unknown) => {
        if (!mapper || retired) return refuse();
        return mapper.map(route, headers, body);
      },
      retire: async () => {
        retired = true;
        await Promise.allSettled([auth.retire(), ...pending]);
      },
    });
  } catch {
    await capability?.retire();
    return refuse();
  } finally {
    acquisitionRelease();
  }
}
