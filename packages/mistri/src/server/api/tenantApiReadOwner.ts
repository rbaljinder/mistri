/** A tenant App's API — its reads and, when it exposes them, its commands —
 * over its enrolled tenant deployment. Private: no route or CLI mounts it here.
 * Built from the deployment's own sources — one reader, one writer, never a
 * second connection — its own command registry, and the App's native auth.
 *
 * Per request, in this order:
 * 1. the bearer token is observed natively in the auth store: its account must
 *    be eligible, and it must be bound to one tenant membership;
 * 2. the operation must be one the token's scope holds, and the request is
 *    planned against the tenant catalog before any data is touched;
 * 3. the tenant runtime admits the token's account in the bound tenant — the
 *    membership it reads natively must be the bound one, at the bound
 *    version — applies the web UI's row scope for that membership, and
 *    re-reads the token and then the membership before and after the work (a
 *    command's membership fence holds until its COMMIT);
 * 4. after all business work, the token is observed once more and the answer
 *    is handed over: on SQLite on the same stack, on PostgreSQL inside the
 *    auth store's native handoff while its locks are held.
 * The membership (business database) and the token (auth database) are two
 * stores: each check is native and fresh, but the two are sequential, never
 * one atomic observation. The last membership check follows all business
 * work; the token's follows it.
 *
 * A tenant service token (api.service) binds a tenant and one service role,
 * not a membership. In step 3 it reads that tenant's anchors instead — an
 * active tenant on an active platform, read now — and runs through the
 * deployment's service binding (tenantServiceBinding.ts): its role's grants,
 * every row of its tenant in each granted table, the anchors fenced to the
 * reads and to a command's COMMIT, attributed to `service:<role>`. The
 * tenant is the token's, never the request's. It has no public-form verb, no
 * prepare and no `$scope`.
 *
 * A command's answer says only what is known. Refused by the tenant runtime
 * before any work — a revoked, changed or suspended membership — is 403, not
 * applied. A database that could not answer, or a failure whose cause cannot
 * be told, is 503 with the outcome unknown: the caller retries under the same
 * Idempotency-Key, which replays an applied receipt. A tenant token has no
 * receipt recovery: the runtime's receipts belong to the tenant, which the
 * shared recovery refuses, so that route answers 422, outcome unknown. */
import { apiCommandPreparation } from './apiCommandPrepare.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isAsyncFunction, isGeneratorFunction, isPromise, isProxy } from 'node:util/types';
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { isTenantApp, resolveAppAccess } from '../../shared/app.js';
import { appTime } from '@mistriwork/engine/server/http/clock.js';
import type { ScopedReads } from '@mistriwork/engine/adapters/adapter.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { executeBusinessCommand } from '../commands/businessCommandExecution.js';
import { commandFlagsOnce } from '../commands/commandFlagCapture.js';
import { serviceActor } from '../jobs/jobAuthorization.js';
import { parseTenantSelector } from '../tenant/tenantMembership.js';
import { commandKeyText } from '../../shared/command.js';
import {
  captureAppAuthRuntime,
  acquirePostgresApiTenantTokenObservation,
  acquireSqliteApiTenantTokenObservation,
  type AppAuthRuntime,
  type Identity,
} from '../auth/auth.js';
import { BusinessCommandExecutionError, isBusinessCommandExecutionError } from '../commands/commandErrors.js';
import { captureTenantEnrollment, type TenantEnrollment } from '../tenant/tenantEnrollment.js';
import { createTenantApiRequest } from '../tenant/tenantApiRequest.js';
import { captureTenantData, denyTenant, recordRefusalCause, TenantUnavailableError } from '@mistriwork/engine/server/evidence.js';
import { bindTenantDeploymentContext } from '../tenant/tenantDeployment.js';
import type { TenantMembershipEvidence } from '../tenant/tenantMembership.js';
import { tenantAuthoringSchema } from '../tenant/tenantVisibleFields.js';
import { tenantServiceLiveGrants, type TenantLiveGrants } from '../tenant/tenantLiveRoute.js';
import { readApiApp } from './appApiValidation.js';
import { checkApiTenantReadCatalog } from './apiTenantReadCatalog.js';
import type { ReadOperation } from './apiReadCatalog.js';
import { checkApiTenantCommandCatalog, tenantCommandEvidence } from './apiTenantCommandCatalog.js';
import { createApiReadView } from './apiReadView.js';
import { createApiCursorReadView } from './apiCursorReadView.js';
import { materializeApiReadResult } from './apiReadResult.js';
import { renderApiReadOpenApi } from './apiReadOpenApi.js';
import { narrowApiReadOpenApi } from './apiNarrowedReadOpenApi.js';
import { narrowApiOpenApi, renderApiOpenApi } from './apiOpenApiDocument.js';
import { currentReadRoute, withReadRoute } from '../readAudit.js';
import { previewApiMcpReadTools } from './apiMcpReadTools.js';
import { projectApiMcpCommandTools } from './apiMcpCommandTools.js';
import { createApiCommandRequestMapper } from './apiCommandRequest.js';
import type { ApiCommandRoute } from './apiCommandRoute.js';
import { commandProblem, projectApiCommandAnswer, refusalHeaders, REFUSAL_STATUS } from './apiCommandResponse.js';
import { ApiCommandUnauthenticated } from './sqliteApiCommandOwner.js';
import { ApiReadFailure } from './apiReadFailure.js';
import { createApiScopeMint } from './apiScopeMint.js';
import { ApiTokenStoreUnavailable } from '../auth/apiTokenStoreFailure.js';
import { apiPublicForm, shapeApiPublicResult, spendApiPublicBudget } from './apiPublicLane.js';

type Answer = Readonly<{ status: 200 | 404; body: string }>;
type Send = (answer: Answer) => void;
type CommandAnswer = Readonly<{ status: number; headers: Readonly<Record<string, string>>; body: string }>;
type CommandSend = (answer: CommandAnswer) => void;
type Outcome = { status: number; headers?: Readonly<Record<string, string>>; value: unknown };
type Input = { key: string } | { query: string } | { spec: true } | { tools: true };
const refuse = (code: ConstructorParameters<typeof ApiReadFailure>[0] = 'temporarily_unavailable'): never => {
  throw new ApiReadFailure(code);
};
/* A deployment that cannot serve its API refuses as any read would, with the
   reason recorded for the operator, never the caller. */
const unserved = (cause: unknown): never => {
  throw recordRefusalCause(new ApiReadFailure('temporarily_unavailable'), cause);
};
// After a command's owner has the request, only uncertainty may be reported.
const unknown = (): never => {
  throw new BusinessCommandExecutionError('temporarily_unavailable', 'unknown');
};
/** How long a service token's binding holds within one request: its reads or its command, never longer. */
const SERVICE_LIFETIME_MS = 60_000;
const callable = (send: unknown) => typeof send === 'function' && !isProxy(send) && !isAsyncFunction(send) && !isGeneratorFunction(send);
/** The targets a command request named, as the executor spells them. */
function requestedKeys(captured: object): Set<string> {
  const value = captured as { keys?: unknown; key?: unknown };
  const keys = Array.isArray(value.keys) ? value.keys : value.key === undefined ? [] : [value.key];
  return new Set(keys.map(commandKeyText).filter((text) => text !== ''));
}

/** One operation a tenant token's scope may name: a read, or an exposed command. */
type ScopeOperation = ReadOperation | ReturnType<typeof checkApiTenantCommandCatalog>['operations'][number];

/** The operations a tenant token's scope is drawn from — the reads and,
 * when the App exposes them, the commands — as issuance and the owner both
 * draw it. Throws when the deployment cannot serve its API. */
export function tenantApiScopeCatalog(value: TenantEnrollment<IncomingMessage>): { readonly operations: readonly ScopeOperation[] } {
  const { app: enrolled, ownership, registry } = captureTenantEnrollment(value);
  if (!enrolled.api || !isTenantApp(enrolled)) return refuse();
  const catalog = checkApiTenantReadCatalog(readApiApp(enrolled), ownership);
  const commands = enrolled.api.commands.length > 0 ? checkApiTenantCommandCatalog(enrolled, ownership, registry ?? refuse()) : undefined;
  return Object.freeze({ operations: Object.freeze([...catalog.operations, ...(commands?.operations ?? [])]) });
}

export async function createTenantApiOwner(input: {
  enrollment: TenantEnrollment<IncomingMessage>;
  auth: AppAuthRuntime;
  integers: 'decimal-string' | 'number';
  /** An answer's link refs said as the tenant's addresses; without it (MCP stdio has no origin) they stay refs. */
  renderLinks?: (value: unknown, tenantId: string) => Promise<unknown>;
}) {
  let capability: { retire(): unknown } | undefined;
  try {
    const { enrollment, app: enrolled, ownership, registry, services, resultReferences } = captureTenantEnrollment(input.enrollment);
    const integers = input.integers;
    if (!['decimal-string', 'number'].includes(integers)) return unserved(`--api-integers must be decimal-string or number.`);
    if (!enrolled.api || !isTenantApp(enrolled)) return unserved('The App declares no api, or is not a tenant App.');
    // Commands run from the registry the deployment itself was built with.
    const exposesCommands = enrolled.api.commands.length > 0;
    if (exposesCommands && !registry) return unserved("The App's api exposes commands, and the server was started without --commands.");
    const app = readApiApp(enrolled),
      catalog = checkApiTenantReadCatalog(app, ownership);
    const schema = tenantAuthoringSchema(ownership),
      deployment = enrollment.deployment;
    const commands = exposesCommands ? checkApiTenantCommandCatalog(enrolled, ownership, registry!) : undefined;
    const evidence = tenantCommandEvidence(ownership);
    const mapper = commands ? createApiCommandRequestMapper(enrolled, schema, registry!, evidence, { integers }, commands) : undefined;
    const exposed = new Set(enrolled.api.commands.map((exposure) => exposure.command.id));
    // A token's scope is drawn from both halves, as its issuance drew it.
    const scopeCatalog = Object.freeze({ operations: Object.freeze([...catalog.operations, ...(commands?.operations ?? [])]) });
    const synchronous = captureAppAuthRuntime(input.auth).synchronous;
    const sqlite = synchronous ? acquireSqliteApiTenantTokenObservation(input.auth, enrolled, scopeCatalog) : undefined;
    const postgres = synchronous ? undefined : await acquirePostgresApiTenantTokenObservation(input.auth, enrolled, scopeCatalog);
    capability = sqlite ?? postgres;
    type Observation = ReturnType<NonNullable<typeof sqlite>['inspect']>;
    const observe = async (credential: unknown): Promise<{ handle: object; observed: Observation }> => {
      try {
        const handle = sqlite ? sqlite.observe(credential) : await postgres!.observe(credential);
        const observed = (sqlite ?? postgres!).inspect(handle) as Observation;
        if (!observed.tenant) return refuse('unauthenticated');
        return { handle, observed };
      } catch (error) {
        // A token store that could not be read decided nothing about the
        // credential: 503, not the 401 that blames the token.
        if (error instanceof ApiTokenStoreUnavailable) return refuse('temporarily_unavailable');
        if (error instanceof ApiReadFailure) throw error;
        return refuse('unauthenticated');
      }
    };
    // The membership the runtime admitted is the one the token binds, at the
    // version it was issued against — not a later one.
    const bindsTo = (principal: TenantMembershipEvidence, observed: Observation) => {
      // A service token's binding names no membership, so it binds none.
      const bound = observed.tenant as Readonly<{ tenantId: string; membershipId?: string; membershipVersion?: string }>;
      return (
        bound.membershipId !== undefined &&
        observed.subject.kind === 'account' &&
        principal.accountId === observed.subject.id &&
        principal.tenantId === bound.tenantId &&
        principal.membershipId === bound.membershipId &&
        principal.membershipVersion === bound.membershipVersion
      );
    };
    /** A service token (api.service) has no membership to admit: its one role, in its one tenant, read now. The
     * tenant's anchors are read on every request, so a suspended or deleted tenant (or a retired platform) admits
     * nothing, and the writer and read source fence those versions as a job's attempt does. */
    const serviceOf = (observed: Observation) => (observed.subject.kind === 'service' ? observed.subject.id : undefined);
    const serviceAdmission = async (observed: Observation) => {
      const role = observed.subject.id;
      const tenant = parseTenantSelector([observed.tenant!.tenantId]);
      const anchors = captureTenantData(await services.reader.readServiceAnchors(tenant));
      if (retired || anchors.platformVersion === null || anchors.tenantVersion === null) return denyTenant();
      return Object.freeze({
        role,
        tenant,
        roles: Object.freeze([role]),
        access: resolveAppAccess(enrolled, ownership.schema, [role]),
        anchors: Object.freeze({ tenantVersion: anchors.tenantVersion, platformVersion: anchors.platformVersion }),
      });
    };
    // The token, re-observed each time the tenant runtime asks who is calling:
    // any change to it — revocation, expiry, scope — ends the request there.
    const requestFor = (credential: unknown, observed: Observation) =>
      createTenantApiRequest(
        async (): Promise<Identity> => {
          const again = await observe(credential);
          if (JSON.stringify(again.observed) !== JSON.stringify(observed)) return refuse('unauthenticated');
          return { id: observed.subject.id, who: observed.subject.id };
        },
        observed.roles,
        observed.scope,
      ) as unknown as IncomingMessage;
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
          const binding = observed.tenant!;
          const spec = 'spec' in request,
            tools = 'tools' in request;
          if (!spec && !tools && !observed.operations.includes(operationId)) return refuse('forbidden');
          // Planned against the tenant catalog before any data is read: a bad
          // request is the caller's, answered as such, never a tenant refusal.
          const now = new Date();
          let planned: { checked: ReturnType<typeof createApiReadView>; cursor?: ReturnType<typeof createApiCursorReadView> } | undefined;
          try {
            if ('key' in request)
              planned = {
                checked: createApiReadView(app, schema, { operationId, query: '', key: request.key }, { integers }, now, catalog),
              };
            else if ('query' in request) {
              // A cursor is bound to this token's scope and to the one membership
              // it acts through: another tenant's cursor is not this one's.
              const cursor = createApiCursorReadView(
                app,
                schema,
                { operationId, query: request.query },
                { integers },
                {
                  secret: cursorSecret,
                  deploymentId,
                  catalogId: `${app.id}:${binding.tenantId}`,
                  scopeFingerprint: createHash('sha256').update(JSON.stringify({ observed, binding })).digest('hex'),
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
          /** The answer over the reads this caller was admitted to; `reader` is who the read audit names. */
          const answerWith = async (
            data: Readonly<{ runView?: ScopedReads['runView']; countView?: ScopedReads['countView'] }>,
            reader: string,
          ): Promise<Answer> => {
            if (spec) {
              // With commands, the composed document; either way narrowed to
              // what this token may call now, never to request roles.
              const document = commands
                ? narrowApiOpenApi(
                    renderApiOpenApi(enrolled, schema, registry!, evidence, { integers }, { reads: catalog, commands }).document,
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
                    enrolled,
                    schema,
                    registry!,
                    evidence,
                    { integers },
                    { operations: observed.operations.filter((id) => id.startsWith('command:')), roles },
                    commands,
                  ).tools
                : [];
              return { status: 200 as const, body: JSON.stringify({ tools: [...listed, ...runs] }) };
            }
            const { checked, cursor } = planned!;
            if (!data.runView) return refuse();
            const runView = data.runView;
            /* The reader the read audit names, under the door its transport set (server/readAudit.ts). */
            const rows = await withReadRoute(currentReadRoute() === 'mcp' ? 'mcp' : 'api', () => runView(checked.view), reader);
            let count: number | undefined;
            if (cursor?.plan.count) {
              if (!data.countView) return refuse();
              // Bounded in the statement, as on the ordinary owners: past
              // 10,000 the answer says "more", so no count reads further.
              count = Math.min(await data.countView(cursor.count, 10001), 10001);
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
          };
          let answer: Answer;
          try {
            const service = serviceOf(observed);
            if (service !== undefined) {
              // The service's role in its token's tenant, never one the URL names: its grants, every row of that
              // tenant in each granted table, audited as `service:<role>`.
              const admitted = await serviceAdmission(observed);
              const bound = services.bindServiceReads({
                runAs: service,
                roles: admitted.roles,
                grants: admitted.access,
                tenantId: admitted.tenant,
                anchors: admitted.anchors,
                lifetimeMs: SERVICE_LIFETIME_MS,
                aborted: () => retired,
              });
              try {
                answer = await answerWith(bound.data, `service:${service}`);
              } finally {
                bound.release();
              }
            } else
              answer = await deployment.withContext(requestFor(credential, observed), [binding.tenantId], async (context) => {
                if (!bindsTo(context.principal, observed)) return refuse('forbidden');
                /* The token is the reader the read audit names. */
                return answerWith(context.data, `api-token:${observed.tokenId}`);
              });
          } catch (error) {
            // A token that no longer observes is unauthenticated; anything the
            // tenant runtime refused — the membership revoked, suspended,
            // changed, or not this token's — is forbidden.
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
            // The business database could not answer: authority was never
            // decided, so this is not a refusal (503, not 403). Nothing was read.
            if (error instanceof TenantUnavailableError) return refuse('temporarily_unavailable');
            return refuse('forbidden');
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
          const { handle, observed } = token,
            binding = observed.tenant!,
            apiRequest = requestFor(credential, observed);
          /** The runtime's own admission, with nothing written: whether this
           * membership, as the token binds it, may act now. */
          const admission = async (): Promise<'admitted' | 'refused' | 'unavailable' | 'unauthenticated'> => {
            try {
              return (await deployment.withContext(apiRequest, [binding.tenantId], (context) => bindsTo(context.principal, observed)))
                ? 'admitted'
                : 'refused';
            } catch (error) {
              if (error instanceof TenantUnavailableError) return 'unavailable';
              // The token is checked first on every runtime call; a token gone
              // says nothing about the membership.
              try {
                await observe(credential);
              } catch (failure) {
                return failure instanceof ApiReadFailure && failure.code === 'temporarily_unavailable' ? 'unavailable' : 'unauthenticated';
              }
              return 'refused';
            }
          };
          /** A public verb through the deployment's intake: its answer, or its refusal as the executor classified it. */
          const submitPublic = async (
            form: string,
          ): Promise<{ status: number; headers?: Readonly<Record<string, string>>; value: unknown }> => {
            const call = captured as {
              commandVersion?: unknown;
              key?: unknown;
              expectedVersion?: unknown;
              input?: unknown;
              idempotencyKey?: unknown;
            };
            try {
              if (call.commandVersion !== registry![named]!.version)
                throw new BusinessCommandExecutionError('command_version_mismatch', 'not_applied');
              if (
                !call.key ||
                typeof call.key !== 'object' ||
                Object.keys(call.key).length ||
                call.expectedVersion !== 0 ||
                typeof call.idempotencyKey !== 'string'
              )
                throw new BusinessCommandExecutionError('invalid_input', 'not_applied');
              const result = await deployment.submitIntake(
                {
                  form,
                  address: undefined,
                  input: call.input,
                  submission: call.idempotencyKey,
                  caller: { tokenId: observed.tokenId, tenantId: binding.tenantId },
                },
                { ...(signal ? { signal } : {}), entry: door },
              );
              const shaped = await shapeApiPublicResult(enrolled, undefined, result);
              return projectApiCommandAnswer('execute', input.renderLinks ? await input.renderLinks(shaped, binding.tenantId) : shaped);
            } catch (error) {
              const code = isBusinessCommandExecutionError(error) ? error.code : undefined;
              if (!code || !Object.hasOwn(REFUSAL_STATUS, code))
                return { status: 503, value: commandProblem('temporarily_unavailable', 'unknown') };
              const refusal = error as BusinessCommandExecutionError;
              return {
                status: REFUSAL_STATUS[code]!,
                value: commandProblem(code, refusal.outcome, refusal.field),
                headers: refusalHeaders(code),
              };
            }
          };
          /** A service token's command: its role in its token's tenant, bound as a job's delivery is — the tenant's
           * anchors read now and fenced to COMMIT, the role's grant — and attributed to `service:<role>`. */
          const serviceRun = async (service: string): Promise<Outcome> => {
            // A public form's verb is the door's, for someone signed out; preparing is a person's screen. Neither is a program's.
            if (publicForm !== undefined) return { status: 403, value: commandProblem('forbidden', 'not_applied') };
            if (mode === 'prepare') return { status: REFUSAL_STATUS.invalid_input!, value: commandProblem('invalid_input', 'not_applied') };
            const admit = async () => {
              const admitted = await serviceAdmission(observed);
              return services.bindService({
                runAs: service,
                place: 'tenant',
                roles: admitted.roles,
                grants: services.validation ? { ...admitted.access, validation: services.validation } : admitted.access,
                tenantId: admitted.tenant,
                zone: await services.zoneOf(admitted.tenant),
                anchors: admitted.anchors,
                lifetimeMs: SERVICE_LIFETIME_MS,
                commands: services.registry,
                aborted: () => retired || signal?.aborted === true,
                // The one command this request names, with the result references the deployment declares for it.
                extract: (id) => {
                  const extract =
                    id === named && resultReferences && Object.hasOwn(resultReferences, id) ? resultReferences[id] : undefined;
                  if (typeof extract !== 'function' || isProxy(extract)) return denyTenant();
                  return extract;
                },
              });
            };
            let bound: Awaited<ReturnType<typeof admit>>;
            try {
              bound = await admit();
            } catch (error) {
              // Nothing has run: a tenant that admits nothing is forbidden; a database that could not answer is not.
              return error instanceof TenantUnavailableError
                ? { status: 503, value: commandProblem('temporarily_unavailable', 'unknown') }
                : { status: 403, value: commandProblem('forbidden', 'not_applied') };
            }
            const actor = serviceActor(enrolled.id, service, [service]);
            try {
              bound.binding.authorize(named, actor);
              const flags = await commandFlagsOnce(() => bound.captureFlags?.(actor))();
              const result = await executeBusinessCommand(bound.binding, actor, captured, {
                ...(signal ? { signal } : {}),
                entry: door,
                flags,
                now: () => appTime(Date.now()),
              });
              return projectApiCommandAnswer('execute', input.renderLinks ? await input.renderLinks(result, binding.tenantId) : result);
            } catch (error) {
              if (error instanceof AppAccessDenied) return { status: 403, value: commandProblem('forbidden', 'not_applied') };
              const code = isBusinessCommandExecutionError(error) ? error.code : undefined;
              if (code && code !== 'temporarily_unavailable' && Object.hasOwn(REFUSAL_STATUS, code)) {
                const refusal = error as BusinessCommandExecutionError;
                const key = refusal.key && requestedKeys(captured as object).has(commandKeyText(refusal.key)) ? refusal.key : undefined;
                return {
                  status: REFUSAL_STATUS[code]!,
                  value: commandProblem(code, refusal.outcome, refusal.field, key),
                  headers: refusalHeaders(code),
                };
              }
              // As for a member: whether the tenant still admits this service says refusal from fault; what ran,
              // only the runtime's outcome says, and it is never upgraded.
              const ran = isBusinessCommandExecutionError(error) ? error.outcome : 'unknown';
              const still = await serviceAdmission(observed).then(
                () => 'admitted' as const,
                (failure: unknown) => (failure instanceof TenantUnavailableError ? ('unavailable' as const) : ('refused' as const)),
              );
              return still === 'refused'
                ? { status: 403, value: commandProblem('forbidden', ran) }
                : { status: 503, value: commandProblem('temporarily_unavailable', 'unknown') };
            } finally {
              bound.release();
            }
          };
          let outcome: Outcome;
          // A public form's command, named by this token, takes the door's lane (apiPublicLane.ts).
          const publicForm = apiPublicForm(enrolled, registry!, named);
          if (!observed.operations.includes(`command:${named}`)) {
            // No business work ran, so nothing was applied.
            outcome = {
              status: exposed.has(named) ? 403 : 404,
              value: commandProblem(exposed.has(named) ? 'forbidden' : 'not_found', 'not_applied'),
            };
          } else if (mode === 'recover') {
            // Never the earlier request's outcome: this route cannot see it.
            outcome = { status: 422, value: commandProblem('invalid_input', 'unknown') };
          } else if (serviceOf(observed) !== undefined) {
            outcome = await serviceRun(serviceOf(observed)!);
          } else {
            const before = await admission();
            if (before === 'unauthenticated') throw new ApiCommandUnauthenticated();
            if (before !== 'admitted') {
              // Nothing has run: a refused membership is forbidden and not
              // applied; a database that could not answer is unavailable.
              outcome =
                before === 'refused'
                  ? { status: 403, value: commandProblem('forbidden', 'not_applied') }
                  : { status: 503, value: commandProblem('temporarily_unavailable', 'unknown') };
            } else if (publicForm !== undefined) {
              /* The door's verb, in the token's own tenant (`token.tenant`) and no other: the intake lane, placed by
                 that tenant rather than an address, as the form's principal under the token's id. The membership was
                 admitted above, so a token outlives no member; its roles widen nothing the door grants. */
              outcome =
                mode === 'prepare'
                  ? { status: REFUSAL_STATUS.invalid_input!, value: commandProblem('invalid_input', 'not_applied') }
                  : ((await spendApiPublicBudget(observed.tokenId)) ?? (await submitPublic(publicForm)));
            } else {
              // The same binding, on the runtime's own admission of this call.
              // Its principal is fixed for the call, so a refusal here comes at
              // admission, before any work.
              let boundRefused = false;
              const guard = (principal: TenantMembershipEvidence) => {
                if (!bindsTo(principal, observed)) {
                  boundRefused = true;
                  denyTenant();
                }
              };
              try {
                const context = bindTenantDeploymentContext(deployment, guard);
                const result =
                  mode === 'prepare'
                    ? await context.prepare(apiRequest, [binding.tenantId], captured, signal ? { signal } : {})
                    : await context.execute(apiRequest, [binding.tenantId], captured, { ...(signal ? { signal } : {}), entry: door });
                outcome =
                  mode === 'prepare'
                    ? apiCommandPreparation(result)
                    : projectApiCommandAnswer('execute', input.renderLinks ? await input.renderLinks(result, binding.tenantId) : result);
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
                } else if (boundRefused) {
                  outcome = { status: 403, value: commandProblem('forbidden', 'not_applied') };
                } else {
                  // The runtime does not say refusal from fault. Whether the
                  // membership still acts decides that; what ran, only the
                  // runtime's outcome says, and it is never upgraded.
                  const ran = isBusinessCommandExecutionError(error) ? error.outcome : 'unknown';
                  outcome =
                    (await admission()) === 'refused'
                      ? { status: 403, value: commandProblem('forbidden', ran) }
                      : { status: 503, value: commandProblem('temporarily_unavailable', 'unknown') };
                }
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

    const readItem = (credential: unknown, operationId: string, key: string, send: Send) => read(credential, operationId, { key }, send);
    // The key is proven readable through this owner's own item read, as the parent token.
    // A service token is never a parent: a row scope narrows a member's tenant rows, and its child would be no one's.
    const mintScope = enrolled.api!.scopes
      ? createApiScopeMint({
          app: enrolled,
          auth: input.auth,
          observe: async (credential) => {
            const observed = await observe(credential);
            return serviceOf(observed.observed) === undefined ? observed : refuse('forbidden');
          },
          readItem,
        })
      : undefined;

    /** A service token's change stream (`/api/live`): its role's grants in its one tenant, as the first answer and
     * as every 30 s re-check reads them again. A member token has a person's stream on their lease instead. */
    const serviceLive = (credential: unknown) =>
      track(
        (async (): Promise<Readonly<{ actor: string; grants: TenantLiveGrants }>> => {
          if (retired) return refuse();
          const { observed } = await observe(credential);
          const role = serviceOf(observed);
          if (role === undefined) return refuse('forbidden');
          let admitted: Awaited<ReturnType<typeof serviceAdmission>>;
          try {
            admitted = await serviceAdmission(observed);
          } catch (error) {
            return refuse(error instanceof TenantUnavailableError ? 'temporarily_unavailable' : 'forbidden');
          }
          // The token is the stream's account: each one holds its own eight streams.
          const account = `api-token:${observed.tokenId}`;
          return Object.freeze({
            actor: `service:${role}`,
            grants: tenantServiceLiveGrants(enrolled, ownership, admitted.access, admitted.tenant, account),
          });
        })(),
      );

    return Object.freeze({
      readItem,
      ...(mintScope ? { mintScope } : {}),
      serviceLive,
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
      /** Pure: the runtime's executor still validates everything the envelope says. */
      map: (route: ApiCommandRoute, headers: Readonly<{ expectedVersion?: number; idempotencyKey?: string }>, body: unknown) => {
        if (!mapper || retired) return unknown();
        return mapper.map(route, headers, body);
      },
      /** Routing for trusted composition (an App MCP session's tool names and
       * key codecs): declaration data, never authority — every call is still
       * this owner's to authorize. */
      routing: Object.freeze({ schema, reads: catalog, commands, evidence, registry }),
      retire: async () => {
        retired = true;
        await Promise.allSettled([capability?.retire(), ...pending]);
      },
    });
  } catch (error) {
    await Promise.resolve(capability?.retire()).catch(() => {});
    if (error instanceof ApiReadFailure) throw error;
    return unserved(error);
  }
}
