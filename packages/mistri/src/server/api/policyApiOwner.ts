/** A row-policy App's API — its reads and, when it exposes them, its commands —
 * through the App's own policy deployment: the scoped reader and writer the
 * web UI uses, under the same `resolveRows`, never a second connection and
 * never a table read whole.
 *
 * Per request, in this order:
 * 1. the bearer token is observed natively in the auth store: its account must
 *    be eligible, and the token's roles are narrowed to those the account
 *    holds now;
 * 2. the operation must be one the token's scope holds, and the request is
 *    planned against the App's catalog before any data is touched;
 * 3. the deployment builds the context for the token's account, as it does
 *    for a signed-in person: it asks the API request who is calling, the
 *    request observes the token again, and the policy resolves that
 *    principal's rows. The read or command runs in that context alone;
 * 4. after all business work, the token is observed once more and the answer
 *    is handed over: on SQLite on the same stack, on PostgreSQL inside the
 *    auth store's native handoff while its locks are held.
 *
 * The principal is the token's account by id, acting with the token's roles.
 * It names no email: a token is not a session, and a policy or a stamp that
 * matches a person by email finds nobody for it. A command is checked before
 * it runs and again before its answer; as for a browser session, a
 * revocation while its transaction is open does not roll it back — its
 * answer is then withheld, outcome unknown. Receipt recovery belongs to the
 * scoped binding's journal, which the shared recovery refuses: that route
 * answers 422, outcome unknown, as a tenant App's does. The event feed and
 * generic writes are not served (`policy-events-feed`,
 * `api-write-unsupported`): a journaled event is not re-read through the
 * policy, and a row-policy App writes through the commands it exposes. */
import { apiCommandPreparation } from './apiCommandPrepare.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isAsyncFunction, isGeneratorFunction, isPromise, isProxy } from 'node:util/types';
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { homeSourceOf, isRowPolicyApp, type AppDef } from '../../shared/app.js';
import { apiWrites } from '../../shared/appApi.js';
import { commandKeyText } from '../../shared/command.js';
import {
  acquirePostgresApiCommandTokenObservation,
  acquirePostgresApiTokenObservation,
  acquireSqliteApiCommandTokenObservation,
  acquireSqliteApiTokenObservation,
  captureAppAuthRuntime,
  type AppAuthRuntime,
  type Identity,
} from '../auth/auth.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { BusinessCommandExecutionError, isBusinessCommandExecutionError } from '../commands/commandErrors.js';
import { defineCommands } from '../commands/businessCommands.js';
import type { HttpAppPolicy } from '../policy/appPolicyHttp.js';
import type { AppPolicyContext } from '../policy/appPolicyContext.js';
import { createTenantApiRequest } from '../tenant/tenantApiRequest.js';
import { readApiApp } from './appApiValidation.js';
import { checkApiReadCatalog } from './apiReadCatalog.js';
import { checkApiCommandCatalog } from './apiCommandCatalog.js';
import { createApiReadView } from './apiReadView.js';
import { createApiCursorReadView } from './apiCursorReadView.js';
import { materializeApiReadResult } from './apiReadResult.js';
import { renderApiReadOpenApi } from './apiReadOpenApi.js';
import { narrowApiReadOpenApi } from './apiNarrowedReadOpenApi.js';
import { narrowApiOpenApi, renderApiOpenApi } from './apiOpenApiDocument.js';
import { previewApiMcpReadTools } from './apiMcpReadTools.js';
import { projectApiMcpCommandTools } from './apiMcpCommandTools.js';
import { createApiCommandRequestMapper } from './apiCommandRequest.js';
import type { ApiCommandRoute } from './apiCommandRoute.js';
import { commandProblem, projectApiCommandAnswer, refusalHeaders, REFUSAL_STATUS } from './apiCommandResponse.js';
import { ApiCommandUnauthenticated } from './sqliteApiCommandOwner.js';
import { ApiReadFailure } from './apiReadFailure.js';
import { ApiTokenStoreUnavailable } from '../auth/apiTokenStoreFailure.js';
import { commandsOf } from '../stores/commandStores.js';

type Answer = Readonly<{ status: 200 | 404; body: string }>;
type Send = (answer: Answer) => void;
type CommandAnswer = Readonly<{ status: number; headers: Readonly<Record<string, string>>; body: string }>;
type CommandSend = (answer: CommandAnswer) => void;
type Input = { key: string } | { query: string } | { spec: true } | { tools: true };
const refuse = (code: ConstructorParameters<typeof ApiReadFailure>[0] = 'temporarily_unavailable'): never => {
  throw new ApiReadFailure(code);
};
// After a command's owner has the request, only uncertainty may be reported.
const unknown = (): never => {
  throw new BusinessCommandExecutionError('temporarily_unavailable', 'unknown');
};
const callable = (send: unknown) => typeof send === 'function' && !isProxy(send) && !isAsyncFunction(send) && !isGeneratorFunction(send);
/** The targets a command request named, as the executor spells them. */
function requestedKeys(captured: object): Set<string> {
  const value = captured as { keys?: unknown; key?: unknown };
  const keys = Array.isArray(value.keys) ? value.keys : value.key === undefined ? [] : [value.key];
  return new Set(keys.map(commandKeyText).filter((text) => text !== ''));
}

export async function createPolicyApiOwner(input: {
  policy: HttpAppPolicy;
  /** The served App, as its host holds it: the deployment must match it. */
  app: AppDef;
  auth: AppAuthRuntime;
  /** The App's connections: its logical catalog, for planning and scope only. */
  registry: Registry;
  integers: 'decimal-string' | 'number';
}) {
  let capability: { retire(): unknown } | undefined;
  try {
    const { policy, app: served, registry, integers } = input;
    if (!['decimal-string', 'number'].includes(integers) || !served.api || !isRowPolicyApp(served) || !policy.matches(served))
      return refuse();
    // A row-policy App writes through its commands; its feed's events are not re-read through the policy.
    if (apiWrites(served.api).length || served.api.events?.length) return refuse();
    const exposesCommands = served.api.commands.length > 0;
    // Its commands run from the registry the deployment itself was built with.
    const declared = policy.commands;
    if (exposesCommands && !declared) return refuse();
    const app = readApiApp(served);
    /* The logical catalog, for planning and token scope only: no request
       reads through it. Rows are read only in the deployment's context. */
    const reference = served.sources ? served.sources[homeSourceOf(served)!]?.connection : served.connection;
    const matches = registry
      .list()
      .filter((connection) => reference === undefined || connection.id === reference || connection.name === reference);
    if (matches.length !== 1) return refuse();
    const resources = await loadAppRuntimeResources(registry, app, matches[0].id);
    const schema = resources.schema;
    const catalog = checkApiReadCatalog(app.api!, app, schema);
    /* With several connections, a read is served on its operation's source
       alone (apiSourceLanes.ts): the deployment's reader anchored there, so
       nothing the request does reaches a second database. One connection
       reads through the deployment's reader as it always has. */
    const lanes = resources.connections.length > 1;
    const evidence = Object.freeze({
      connectionFor: resources.connectionFor,
      writableConnection: (id: string) => registry.configOf(id)?.writable === true,
      transactionalConnection: (id: string) => !!commandsOf(resources.forConnection(id)).commandTransaction,
    });
    const registryOf = exposesCommands ? defineCommands(declared!) : undefined;
    const commands = registryOf ? checkApiCommandCatalog(served.api, served, schema, registryOf, evidence) : undefined;
    const mapper = commands ? createApiCommandRequestMapper(served, schema, registryOf!, evidence, { integers }, commands) : undefined;
    const exposed = new Set(served.api.commands.map((exposure) => exposure.command.id));
    const synchronous = captureAppAuthRuntime(input.auth).synchronous;
    const sqlite = synchronous
      ? registryOf
        ? acquireSqliteApiCommandTokenObservation(input.auth, served, schema, registryOf, evidence)
        : acquireSqliteApiTokenObservation(input.auth, app, schema)
      : undefined;
    const postgres = synchronous
      ? undefined
      : registryOf
        ? await acquirePostgresApiCommandTokenObservation(input.auth, served, schema, registryOf, evidence)
        : await acquirePostgresApiTokenObservation(input.auth, app, schema);
    capability = sqlite ?? postgres;
    type Observation = ReturnType<NonNullable<typeof sqlite>['inspect']>;
    const observe = async (credential: unknown): Promise<{ handle: object; observed: Observation }> => {
      try {
        const handle = sqlite ? sqlite.observe(credential) : await postgres!.observe(credential);
        return { handle, observed: (sqlite ?? postgres!).inspect(handle) as Observation };
      } catch (error) {
        // A token store that could not be read decided nothing about the
        // credential: 503, not the 401 that blames the token.
        if (error instanceof ApiTokenStoreUnavailable) return refuse('temporarily_unavailable');
        if (error instanceof ApiReadFailure) throw error;
        return refuse('unauthenticated');
      }
    };
    // The context the deployment built must be for the token's account, with the token's roles: nobody else's.
    const actsAs = (context: AppPolicyContext, observed: Observation) =>
      context.principal.kind === undefined &&
      context.principal.id === observed.subject.id &&
      context.principal.appId === served.id &&
      JSON.stringify([...context.principal.roles].sort()) === JSON.stringify([...observed.roles].sort());
    /* The token, re-observed each time the deployment asks who is calling:
       any change to it — revocation, expiry, scope — ends the request there.
       The deployment's verifier answers only for a request trusted
       composition made (tenantApiRequest.ts); a browser's keeps its session. */
    const requestFor = (credential: unknown, observed: Observation) =>
      createTenantApiRequest(async (): Promise<Identity> => {
        const again = await observe(credential);
        if (JSON.stringify(again.observed) !== JSON.stringify(observed)) return refuse('unauthenticated');
        return { id: observed.subject.id, who: observed.subject.id, role: observed.roles.join(','), emailUnproven: true };
      }, observed.roles) as never;
    /** The last token check, then the bytes: on SQLite on this same stack, on
     * PostgreSQL inside the native handoff while its locks are held. `stale`
     * answers a token that no longer observes. */
    const deliver = async <A>(
      credential: unknown,
      handle: object,
      observed: Observation,
      answer: A,
      send: (answer: A) => void,
      stale: () => never,
    ): Promise<'sent' | 'uncertain'> => {
      if (sqlite) {
        let final: Observation;
        // A store that could not answer is not a token that no longer
        // observes: it keeps its own 503 instead of becoming `stale`.
        try {
          final = (await observe(credential)).observed;
        } catch (error) {
          if (error instanceof ApiReadFailure && error.code === 'temporarily_unavailable') throw error;
          return stale();
        }
        if (JSON.stringify(final) !== JSON.stringify(observed)) return stale();
        const returned: unknown = send(answer);
        if (isPromise(returned)) void Promise.prototype.then.call(returned, undefined, () => {});
        return 'sent';
      }
      let entered = false;
      const handoff = await postgres!
        .handoff(credential, handle, () => {
          entered = true;
          send(answer);
        })
        .catch(() => {
          if (entered) return { outcome: 'uncertain' as const };
          return stale();
        });
      return handoff.outcome === 'complete' ? 'sent' : 'uncertain';
    };
    const cursorSecret = randomBytes(32),
      deploymentId = randomUUID();
    let retired = false;
    const pending = new Set<Promise<unknown>>();
    const track = <T>(work: Promise<T>) => {
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      return work;
    };

    const read = (credential: unknown, operationId: string, request: Input, send: Send) => {
      if (!callable(send)) return Promise.reject(new ApiReadFailure('temporarily_unavailable'));
      return track(
        (async (): Promise<'sent' | 'uncertain'> => {
          if (retired) return refuse();
          const { handle, observed } = await observe(credential);
          const spec = 'spec' in request,
            tools = 'tools' in request;
          if (!spec && !tools && !observed.operations.includes(operationId)) return refuse('forbidden');
          // Planned against the catalog before any data is read: a bad
          // request is the caller's, answered as such, never a policy refusal.
          const now = new Date();
          let planned: { checked: ReturnType<typeof createApiReadView>; cursor?: ReturnType<typeof createApiCursorReadView> } | undefined;
          try {
            if ('key' in request)
              planned = {
                checked: createApiReadView(app, schema, { operationId, query: '', key: request.key }, { integers }, now, catalog),
              };
            else if ('query' in request) {
              // A cursor is bound to this token's scope: its rows are its
              // principal's, and another token's cursor is not this one's.
              const cursor = createApiCursorReadView(
                app,
                schema,
                { operationId, query: request.query },
                { integers },
                {
                  secret: cursorSecret,
                  deploymentId,
                  catalogId: `${app.id}:policy`,
                  scopeFingerprint: createHash('sha256').update(JSON.stringify(observed)).digest('hex'),
                  ttlMs: 15 * 60 * 1000,
                },
                now,
                catalog,
              );
              planned = {
                cursor,
                checked: {
                  stage: 'checked-read-view' as const,
                  authorization: 'pending' as const,
                  execution: 'pending' as const,
                  plan: cursor.plan,
                  view: cursor.rows,
                } as unknown as ReturnType<typeof createApiReadView>,
              };
            }
          } catch {
            return refuse('invalid_request');
          }
          let answer: Answer;
          try {
            answer = await policy.withContext(requestFor(credential, observed), async (context) => {
              if (!actsAs(context, observed)) return refuse('forbidden');
              if (spec) {
                // With commands, the composed document; either way narrowed to
                // what this token may call now, never to request roles.
                const document = commands
                  ? narrowApiOpenApi(
                      renderApiOpenApi(served, schema, registryOf!, evidence, { integers }, { reads: catalog, commands }).document,
                      observed.operations,
                    )
                  : narrowApiReadOpenApi(renderApiReadOpenApi(app, schema, { integers }, catalog).document, observed.operations);
                return { status: 200 as const, body: JSON.stringify(document) };
              }
              if (tools) {
                const roles = [...observed.roles];
                const listed = previewApiMcpReadTools(
                  app,
                  schema,
                  { integers },
                  { operations: observed.operations.filter((id) => /^(?:item|list|view):/.test(id)), roles },
                  'owner',
                  catalog,
                ).tools;
                const runs = commands
                  ? projectApiMcpCommandTools(
                      served,
                      schema,
                      registryOf!,
                      evidence,
                      { integers },
                      { operations: observed.operations.filter((id) => id.startsWith('command:')), roles },
                      commands,
                    ).tools
                  : [];
                return { status: 200 as const, body: JSON.stringify({ tools: [...listed, ...runs] }) };
              }
              const { checked, cursor } = planned!;
              // The deployment's scoped reader: this principal's rows, as the web UI reads them.
              const source = catalog.operations.find((operation) => operation.id === operationId)?.source;
              if (lanes && source === undefined) return refuse();
              const reads = lanes ? context.readsAt(source!) : context.data;
              if (!reads.runView) return refuse();
              const rows = await reads.runView(checked.view);
              let count: number | undefined;
              if (cursor?.plan.count) {
                if (!reads.countView) return refuse();
                // Bounded, as on the ordinary owners: past 10,000 the answer says "more".
                count = Math.min(await reads.countView(cursor.count, 10001), 10001);
              }
              const wire = materializeApiReadResult(checked, rows, count);
              const status = wire.stage === 'item-read-result' && wire.status === 'not-found' ? (404 as const) : (200 as const);
              const body = JSON.stringify(
                wire.stage === 'item-read-result'
                  ? wire.status === 'not-found'
                    ? { error: { code: 'not_found', message: 'The API request could not be completed.' } }
                    : wire.item
                  : {
                      items: wire.items,
                      next: wire.more ? cursor!.sealNext(wire.boundary) : null,
                      ...(wire.count ? { count: wire.count } : {}),
                    },
              );
              if (Buffer.byteLength(body) > 8 * 1024 * 1024) return refuse();
              return { status, body };
            });
          } catch (error) {
            // A token that no longer observes is unauthenticated; anything the
            // deployment refused — its policy, its grants — is forbidden.
            try {
              await observe(credential);
            } catch (failure) {
              return refuse(
                failure instanceof ApiReadFailure && failure.code === 'temporarily_unavailable'
                  ? 'temporarily_unavailable'
                  : 'unauthenticated',
              );
            }
            if (error instanceof ApiReadFailure && error.code !== 'temporarily_unavailable') {
              return refuse(error.code === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
            }
            if (error instanceof AppAccessDenied) return refuse('forbidden');
            // Anything else decided nothing about authority: 503, not 403. Nothing was answered.
            return refuse('temporarily_unavailable');
          }
          if (retired) return refuse();
          return deliver(credential, handle, observed, answer, send, () => refuse('unauthenticated'));
        })(),
      );
    };

    const run = (
      mode: 'execute' | 'recover' | 'prepare',
      credential: unknown,
      request: unknown,
      send: CommandSend,
      signal?: AbortSignal,
      door: 'api' | 'mcp' = 'api',
    ) => {
      if (!callable(send)) return Promise.reject(new BusinessCommandExecutionError('temporarily_unavailable', 'unknown'));
      return track(
        (async (): Promise<'sent' | 'uncertain'> => {
          if (retired || !commands) return unknown();
          const captured = snapshot(request, 131072).value;
          const named =
            captured && typeof captured === 'object' && !Array.isArray(captured) ? (captured as { command?: unknown }).command : undefined;
          if (typeof named !== 'string') return unknown();
          let token: { handle: object; observed: Observation };
          // Nothing has run yet; a transport may say so as 401 — unless the token
          // store could not be read, which decides nothing and is 503 unknown.
          try {
            token = await observe(credential);
          } catch (error) {
            if (error instanceof ApiReadFailure && error.code === 'temporarily_unavailable') return unknown();
            throw new ApiCommandUnauthenticated();
          }
          const { handle, observed } = token;
          let outcome: { status: number; headers?: Readonly<Record<string, string>>; value: unknown };
          if (!observed.operations.includes(`command:${named}`)) {
            // No business work ran, so nothing was applied.
            outcome = {
              status: exposed.has(named) ? 403 : 404,
              value: commandProblem(exposed.has(named) ? 'forbidden' : 'not_found', 'not_applied'),
            };
          } else if (mode === 'recover') {
            // Never the earlier request's outcome: a scoped binding's receipts are not recoverable here.
            outcome = { status: 422, value: commandProblem('invalid_input', 'unknown') };
          } else {
            // Set once the deployment admitted the token's account: before that, nothing ran.
            let admitted = false;
            try {
              const result = await policy.withContext(requestFor(credential, observed), async (context) => {
                if (!actsAs(context, observed) || !context.commands) throw new AppAccessDenied();
                admitted = true;
                return mode === 'prepare'
                  ? context.commands.prepare(captured, signal ? { signal } : {})
                  : context.commands.execute(captured, { ...(signal ? { signal } : {}), door });
              });
              outcome = mode === 'prepare' ? apiCommandPreparation(result) : projectApiCommandAnswer('execute', result);
            } catch (error) {
              const code = isBusinessCommandExecutionError(error) ? error.code : undefined;
              if (code && code !== 'temporarily_unavailable' && Object.hasOwn(REFUSAL_STATUS, code)) {
                // The executor classified it, outcome and all.
                const refusal = error as BusinessCommandExecutionError;
                const key = refusal.key && requestedKeys(captured as object).has(commandKeyText(refusal.key)) ? refusal.key : undefined;
                outcome = {
                  status: REFUSAL_STATUS[code]!,
                  value: commandProblem(code, refusal.outcome, refusal.field, key),
                  headers: refusalHeaders(code),
                };
              } else {
                // The token is checked first: a token gone says nothing about the policy.
                try {
                  await observe(credential);
                } catch (failure) {
                  if (failure instanceof ApiReadFailure && failure.code === 'temporarily_unavailable') return unknown();
                  if (!admitted) throw new ApiCommandUnauthenticated();
                  return unknown();
                }
                // Refused before any work is not applied; anything after admission is unknown.
                outcome =
                  !admitted && (error instanceof AppAccessDenied || (error instanceof ApiReadFailure && error.code === 'forbidden'))
                    ? { status: 403, value: commandProblem('forbidden', 'not_applied') }
                    : { status: 503, value: commandProblem('temporarily_unavailable', 'unknown') };
              }
            }
          }
          // Serialized, then re-authorized exactly like a result: a token revoked
          // after the work yields no answer but an uncertain one.
          const body = snapshot(outcome.value, 1024 * 1024).json;
          const answer: CommandAnswer = Object.freeze({
            status: outcome.status,
            headers: Object.freeze({ ...(outcome.headers ?? {}) }),
            body,
          });
          if (retired) return unknown();
          return deliver(credential, handle, observed, answer, send, unknown);
        })(),
      );
    };

    return Object.freeze({
      readItem: (credential: unknown, operationId: string, key: string, send: Send) => read(credential, operationId, { key }, send),
      readList: (credential: unknown, operationId: string, query: string, send: Send) => read(credential, operationId, { query }, send),
      /** The `$openapi` document — composed when the App exposes commands — narrowed per token. */
      readSpec: (credential: unknown, send: Send) => read(credential, '$openapi', { spec: true }, send),
      /** App MCP `{tools}` — read and command — for this token now. */
      readTools: (credential: unknown, send: Send) => read(credential, '$tools', { tools: true }, send),
      prepare: (credential: unknown, request: unknown, send: CommandSend, signal?: AbortSignal) =>
        run('prepare', credential, request, send, signal),
      /** `door` is `mcp` for App MCP's command tools (appMcpSession.ts): the handler is told which. */
      execute: (credential: unknown, request: unknown, send: CommandSend, signal?: AbortSignal, door?: 'mcp') =>
        run('execute', credential, request, send, signal, door),
      recover: (credential: unknown, request: unknown, send: CommandSend, signal?: AbortSignal) =>
        run('recover', credential, request, send, signal),
      /** Pure: the deployment's executor still validates everything the envelope says. */
      map: (route: ApiCommandRoute, headers: Readonly<{ expectedVersion?: number; idempotencyKey?: string }>, body: unknown) => {
        if (!mapper || retired) return unknown();
        return mapper.map(route, headers, body);
      },
      /** Routing for trusted composition (an App MCP session's tool names and
       * key codecs, the public document): declaration data, never authority —
       * every call is still this owner's to authorize. */
      routing: Object.freeze({ schema, reads: catalog, commands, evidence, registry: registryOf }),
      retire: async () => {
        retired = true;
        await Promise.allSettled([capability?.retire(), ...pending]);
      },
    });
  } catch {
    await Promise.resolve(capability?.retire()).catch(() => {});
    return refuse();
  }
}
