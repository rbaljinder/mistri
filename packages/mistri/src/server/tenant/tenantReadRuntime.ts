import { isPromise } from 'node:util/types';
import type { Adapter, ScopedReads } from '@mistriwork/engine/adapters/adapter.js';
import { declaredReferences, physicalBindings, resolveAppAccess, tenantAppShape, type AppDef } from '../../shared/app.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { assertScopeCatalog, captureScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { authorizeResources, markStableGrant, type ResourceAccess } from '../app/appAccess.js';
import { appResourceCatalog } from '../app/appResources.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import type { Identity } from '../auth/auth.js';
import {
  captureTenantData,
  denyTenant,
  denyTenantFor,
  recordRefusalCause,
  TenantContextError,
  TenantRequestFault,
  tenantIdentifier,
  tenantOptions,
  tenantRecord,
} from '@mistriwork/engine/server/evidence.js';
import { createTenantMembershipIssuer, type TenantMembershipEvidence } from './tenantMembership.js';
import { composeTenantReadScope } from './tenantReadScope.js';
import { captureTenantReadSource, type TenantReadSource } from './tenantReadSource.js';
import { assertStructuredReadFilter, ResourceReadError } from '@mistriwork/engine/server/resourceReadOperations.js';
import { PathError } from '@mistriwork/engine/shared/viewPaths.js';
import { tenantRuntimeClock } from './tenantRuntimeClock.js';
import { tenantRetirement } from './tenantRetirement.js';
import { checkTenantInvocation, isAdmittedAgain, revalidateTenantInvocation, type TenantInvocationGuard } from './tenantInvocation.js';
import type { TenantCapabilities } from './tenantCapabilities.js';
import { tenantVisibleFields } from './tenantVisibleFields.js';
import type { AdmissionCache } from './tenantAdmissionCache.js';
import { bindTenantFlagOwner } from './tenantFlagRuntime.js';
import { actingPrincipal } from './tenantApiRequest.js';
import { readZone } from '../app/readerZone.js';
import { readLocale } from '../app/readerLocale.js';

/* The row scope a context reads under, by the context: live sync asks it of a
   context it holds (tenantHttp.ts's /api/live), to judge a changed row as it
   stood. It cannot be reached from the context itself, which a callback can
   hand anywhere; only a holder of this module's function reads it. */
const liveRows = new WeakMap<object, RowScope>();

/** The row scope `context` reads under, for live sync's filter: undefined for anything this runtime did not make. */
/** Test-only: how many role-set read grants a runtime resolved rather than reused. */
export const tenantReadCounters = { grants: 0 };
const READ_GRANTS = 64;
export const tenantLiveRowsOf = (context: object): RowScope | undefined => liveRows.get(context);

export interface TenantReadContext {
  readonly principal: TenantMembershipEvidence;
  readonly schema: DatabaseSchema;
  readonly data: ScopedReads;
  /** Presentation only; the read adapter remains incapable of writing. */
  readonly capabilities?: TenantCapabilities;
  /** The zone this reader's days are counted in, where `ui.timezone` reads one (readerZone.ts); read through `appZone`. */
  readonly zone?: string;
  /** This member's own locale, where `ui.locale` reads one (readerLocale.ts); resolved with the tenant's and the App's. */
  readonly locale?: string;
  /** `work`, its reads of this context on one snapshot (tenantReadSource.ts `together`): for a request that asks
      many at once — a composed record page, a page's boot, a post-write refresh. */
  readonly together?: <T>(work: () => Promise<T>) => Promise<T>;
}
export interface TenantReadRuntimeOptions<Request> {
  readonly app: AppDef;
  /** A dedicated genuine source. Ownership transfers only on successful creation. */
  readonly source: TenantReadSource;
  readonly deployment: string;
  readonly roles: readonly string[];
  readonly maxLifetimeMs: number;
  readonly verifySession: (request: Request) => Identity | null | Promise<Identity | null>;
  readonly resolveMembershipRows: (principal: TenantMembershipEvidence) => RowScope | Promise<RowScope>;
  readonly resolveRows: (principal: TenantMembershipEvidence) => RowScope | Promise<RowScope>;
  readonly presentation?: (principal: TenantMembershipEvidence, schema: DatabaseSchema) => TenantCapabilities;
  readonly now?: () => number;
  /** The deployment's kept admissions (tenantAdmissionCache.ts). */
  readonly admissions?: AdmissionCache;
}

/** A callback's failure that is the request's and not the context's: the
 * page operations' not-found, and a read the resource reader refused as asked
 * (a column or path it does not have). Anything else is the context's. */
function requestFault(error: unknown): TenantRequestFault | undefined {
  if (error instanceof TenantRequestFault) return error;
  // The operator hears which; the caller, only that it was the read. Only a
  // request asked wrongly (400): a table or path the context does not have
  // (404) stays the context's refusal, as it ever was.
  if (error instanceof ResourceReadError && error.status === 400)
    return recordRefusalCause(new TenantRequestFault(error.status, 'invalid_read'), error);
  /* A question its compiler cannot write — a path it cannot walk, `has` of
     something that is not tags — is the request's too, as the single-App host
     answers it (http/handler.ts): answered as a denial, one bad filter in a
     rail's counts ended a session the person still held. */
  if (error instanceof PathError) return recordRefusalCause(new TenantRequestFault(400, 'invalid_read'), error);
  return undefined;
}

/** Capture synchronous transfers immediately, asynchronous ones on native
 * delivery. Custom thenables are data errors, not another provider protocol. */
function delivered<T>(value: T | Promise<T>): T | Promise<T> {
  return isPromise(value)
    ? (Promise.prototype.then.call(
        value,
        (result: T) => captureTenantData(result),
        (error: unknown) => denyTenantFor(error),
      ) as Promise<T>)
    : captureTenantData(value);
}

/** Compiler diagnostics contain private predicates and physical names. A read
 * grant authorizes projected data, not SQL/bindings from server-owned policy. */
function withoutDiagnostics<T extends { sql: unknown }>(result: T): T {
  return { ...result, sql: { text: '', params: [] } };
}

/** Private read-only deployment. No HTTP enrollment, generic writer, command,
 * raw SQL, history, browser tenant selector or cross-source capability is installed.
 * Callbacks are trusted server code and must buffer their response until return;
 * this owner cannot retract independent side effects or streamed output. */
export function createTenantReadRuntime<Request>(options: TenantReadRuntimeOptions<Request>) {
  try {
    const raw = tenantOptions(options, optionKeys);
    const binding = bindTenantReadRuntime(raw as unknown as TenantReadRuntimeOptions<Request>);
    const source = captureTenantReadSource(raw.source as TenantReadSource);
    const retire = tenantRetirement([binding.retire], [source.close]);
    let retirement: Promise<void> | undefined;
    return Object.freeze({
      withContext: binding.withContext,
      retire() {
        retirement ??= retire().catch(() => denyTenant());
        void retirement.catch(() => {});
        return retirement;
      },
    });
  } catch {
    return denyTenant();
  }
}

const optionKeys = [
  'app',
  'source',
  'deployment',
  'roles',
  'maxLifetimeMs',
  'verifySession',
  'resolveMembershipRows',
  'resolveRows',
  'presentation',
  'now',
  'admissions',
];
/** Internal read admission/draining only; source closure belongs to the outer
 * owner after every read, write and history publication has settled. */
export function bindTenantReadRuntime<Request>(options: TenantReadRuntimeOptions<Request>) {
  const raw = tenantOptions(options, optionKeys);
  const source = captureTenantReadSource(raw.source as TenantReadSource);
  const ownership = source.ownership;
  const app = captureTenantData(raw.app as AppDef);
  if (!app || !tenantAppShape(app, ownership)) return denyTenant();
  const catalog = appResourceCatalog(
    ownership.physicalSchema,
    physicalBindings(app, ownership.source.id),
    declaredReferences(app, ownership.source.id),
  );
  assertScopeCatalog(ownership.schema, catalog.schema);
  for (const id of Object.keys(ownership.resources)) {
    if (catalog.toPhysical(id) !== ownership.resources[id]) return denyTenant();
  }
  // Validate every authored role/field ceiling, including inactive roles. This
  // deployment deliberately projects read authority only, even for writer roles.
  resolveAppAccess(app, ownership.schema, []);
  if (
    typeof raw.verifySession !== 'function' ||
    typeof raw.resolveRows !== 'function' ||
    typeof raw.resolveMembershipRows !== 'function' ||
    (raw.now !== undefined && typeof raw.now !== 'function') ||
    (raw.presentation !== undefined && typeof raw.presentation !== 'function')
  )
    return denyTenant();
  const presentation = raw.presentation as TenantReadRuntimeOptions<Request>['presentation'];
  /* A role set's read grant, resolved once for this runtime and kept: every
     request resolved and filtered it afresh, though its answer depends on
     nothing but the App, this catalog and the roles, all fixed here — a field
     report's profile put it among the largest costs of a page. Keyed by the
     role set alone (sorted: a grant is a union, so order changes nothing),
     never by the person or the tenant: who reads which rows is the scope,
     composed per request and set beside the kept grant there, never kept in
     it. Marked stable, so pruning and checks over it are kept by identity
     too (columnGrants.ts); nothing changes these sets after they are made.
     Bounded, oldest out first: a role set is the App's, but a deployment
     can still be handed many. */
  const readGrants = new Map<string, ResourceAccess>();
  const readGrant = (roles: readonly string[]): ResourceAccess => {
    const set = [...new Set(roles)].sort();
    const key = JSON.stringify(set);
    const kept = readGrants.get(key);
    if (kept) return kept;
    tenantReadCounters.grants++;
    const grant = markStableGrant(
      tenantVisibleFields(ownership, { ...resolveAppAccess(app, ownership.schema, set), writable: new Set<string>() }),
    );
    if (readGrants.size >= READ_GRANTS) readGrants.delete(readGrants.keys().next().value!);
    readGrants.set(key, grant);
    return grant;
  };
  const verify = raw.verifySession as TenantReadRuntimeOptions<Request>['verifySession'];
  const membershipRows = raw.resolveMembershipRows as TenantReadRuntimeOptions<Request>['resolveMembershipRows'];
  const authoredRows = raw.resolveRows as TenantReadRuntimeOptions<Request>['resolveRows'];
  const now = tenantRuntimeClock((raw.now ?? Date.now) as () => number);
  const issuer = createTenantMembershipIssuer({
    ownership,
    deployment: raw.deployment as string,
    roles: raw.roles as readonly string[],
    maxLifetimeMs: raw.maxLifetimeMs as number,
    verifySession: verify,
    membership: { source: ownership.source, read: source.readMembership },
    now,
    ...(raw.admissions === undefined ? {} : { admissions: raw.admissions as AdmissionCache }),
  });
  let retired = false;
  let retirement: Promise<void> | undefined;
  const pendingRequests = new Set<Promise<void>>();

  return Object.freeze({
    /** Stop synchronously and drain accepted requests, including verification.
     * Never await retirement inside its request. This binding does not close. */
    retire(): Promise<void> {
      if (retirement) return retirement;
      retired = true;
      retirement = (async () => {
        try {
          await issuer.retire();
          await Promise.allSettled([...pendingRequests]);
        } catch {
          return denyTenant();
        }
      })();
      void retirement.catch(() => {});
      return retirement;
    },
    async withContext<T>(
      request: Request,
      selectors: readonly string[],
      callback: (context: TenantReadContext) => T | Promise<T>,
      guard?: TenantInvocationGuard,
    ): Promise<T> {
      if (retired || typeof callback !== 'function') return denyTenant();
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      // Reserve before authentication/clock/provider callbacks can retire us.
      pendingRequests.add(held);
      try {
        return await issuer.withMembership(
          request,
          selectors,
          async (principal) => {
            let active = true,
              accepting = true;
            let failed = false;
            // The first failure decides the answer: a database fault stays one
            // through every later denial it causes.
            let failure: unknown;
            let lastTime = principal.verifiedAt;
            const pending = new Set<Promise<void>>();
            let releaseFlags = () => {};
            const assertActive = () => {
              checkTenantInvocation(guard, principal);
              if (retired || !active || failed) return denyTenant();
              const instant = now();
              checkTenantInvocation(guard, principal);
              if (isPromise(instant)) void Promise.prototype.then.call(instant, undefined, () => {});
              if (
                retired ||
                !active ||
                failed ||
                typeof instant !== 'number' ||
                !Number.isSafeInteger(instant) ||
                instant < lastTime ||
                instant >= principal.validUntil
              )
                denyTenant();
              lastTime = instant;
            };
            /* The session and the invocation guard, around every accepted
             operation. The membership is not asked here: each operation's
             own snapshot revalidates it before its SQL (tenantReadSource.ts,
             `bind`), and asking again in a snapshot of its own, before and
             after, bought nothing but two more snapshots per read. */
            const revalidateSession = async () => {
              assertActive();
              const result = delivered(verify(request));
              const session = isPromise(result) ? await result : result;
              assertActive();
              tenantRecord(session, ['id', 'who', 'role']);
              tenantIdentifier(session.id, 1024);
              if (
                session.id !== principal.accountId ||
                typeof session.who !== 'string' ||
                (session.role !== undefined && typeof session.role !== 'string')
              )
                return denyTenant();
              const verified = revalidateTenantInvocation(guard, principal);
              if (isPromise(verified)) await verified;
              assertActive();
            };
            /* The release fence: the session, then the membership in a fresh
             snapshot of its own, after every accepted read has settled. */
            const revalidate = async () => {
              await revalidateSession();
              await source.assertCurrent(principal);
              assertActive();
            };
            const track = <A, R>(input: A, work: (captured: A) => Promise<R>, validate: (captured: A) => void): Promise<R> => {
              if (!accepting || !active || retired) return Promise.reject(new TenantContextError());
              let complete!: () => void;
              const reserved = new Promise<void>((resolve) => {
                complete = resolve;
              });
              pending.add(reserved);
              const operation = (async () => {
                try {
                  // Invalid accepted input poisons the invocation even if caught.
                  const captured = captureTenantData(input);
                  validate(captured);
                  await revalidateSession();
                  const value = await work(captured);
                  const snapshot = captureTenantData(value);
                  await revalidateSession();
                  return snapshot;
                } catch (error) {
                  /* A question the compiler could not write ran nothing: the
                     read is refused as the request's (requestFault), and the
                     context it was asked in stands. A denial still poisons. */
                  if (error instanceof PathError) throw recordRefusalCause(new TenantRequestFault(400, 'invalid_read'), error);
                  failed = true;
                  failure ??= error;
                  return denyTenantFor(error);
                }
              })();
              void operation.then(
                () => {
                  pending.delete(reserved);
                  complete();
                },
                () => {
                  pending.delete(reserved);
                  complete();
                },
              );
              return operation;
            };
            try {
              assertActive();
              const membershipResult = delivered(membershipRows(principal));
              const member = isPromise(membershipResult) ? await membershipResult : membershipResult;
              assertActive();
              // Granted to the roles this request acts under: a token's own (tenantApiRequest.ts).
              const acting = actingPrincipal(request, principal);
              const authoredResult = delivered(authoredRows(acting));
              const authored = isPromise(authoredResult) ? await authoredResult : authoredResult;
              assertActive();
              const rows = composeTenantReadScope(ownership, principal, member, authored);
              // No snapshot yet: whatever reads next, an operation or the release fence, revalidates the membership first.
              await revalidateSession();
              const adapter: Adapter = Object.freeze({
                dialect: 'sqlite',
                introspect: async () => ownership.schema,
                close: async () => {},
                query: denyTenant,
                count: denyTenant,
                scopeReads: (scope: RowScope) => source.bindReads(principal, scope),
              });
              const connection = ownership.source.connection;
              const resource = (id: string) => {
                if (!Object.hasOwn(ownership.resources, id)) return denyTenant();
                return id;
              };
              const resources: RuntimeResources = {
                adapter,
                schema: ownership.schema,
                connections: [connection],
                toPhysical: (id) => ownership.resources[resource(id)],
                toLogical: catalog.toLogical,
                connectionFor: (id) => {
                  resource(id);
                  return connection;
                },
                toLogicalAt: (id, owner) => {
                  if (owner !== connection) return denyTenant();
                  return catalog.toLogical(id);
                },
                forConnection: (owner) => {
                  if (owner !== connection) return denyTenant();
                  return adapter;
                },
              };
              const guarded = authorizeResources(resources, { ...readGrant([...acting.roles]), rows }, assertActive);
              const reader = guarded.adapter;
              const data = Object.freeze<ScopedReads>({
                query: (input) =>
                  track(
                    input,
                    async (value) => withoutDiagnostics(await reader.query(value)),
                    (value) => assertStructuredReadFilter(value.filter, 'column'),
                  ),
                count: (table, filter, limit) =>
                  track(
                    { table, filter, limit },
                    (value) => reader.count(value.table, value.filter, value.limit),
                    (value) => assertStructuredReadFilter(value.filter, 'column'),
                  ),
                runView: (view, offset) =>
                  track(
                    { view, offset },
                    async (value) => withoutDiagnostics(await reader.runView!(value.view, value.offset)),
                    (value) => assertStructuredReadFilter(value.view.filter, 'path'),
                  ),
                // The bound travels into the statement: a count that stops at
                // `limit` rows reads at most that many, however large the tenant.
                countView: (view, limit) =>
                  track(
                    { view, limit },
                    (value) => reader.countView!(value.view, value.limit),
                    (value) => assertStructuredReadFilter(value.view.filter, 'path'),
                  ),
                runBreakdown: (definition, offset) =>
                  track(
                    { definition, offset },
                    async (value) => withoutDiagnostics(await reader.runBreakdown!(value.definition, value.offset)),
                    (value) => assertStructuredReadFilter(value.definition.filter, 'path'),
                  ),
                countBreakdown: (definition, limit) =>
                  track(
                    { definition, limit },
                    (value) => reader.countBreakdown!(value.definition, value.limit),
                    (value) => assertStructuredReadFilter(value.definition.filter, 'path'),
                  ),
              });
              const schema = captureScopeCatalog(guarded.schema);
              const capabilities = presentation ? captureTenantData(presentation(principal, schema)) : undefined;
              /* This tenant's zone, read under this context's own scope: no other context can be handed it (readerZone.ts).
                 This member's own locale, read the same way: under this context's scope, from their row. Neither
                 reads the other's answer, so both are asked at once, and both are settled before either failure
                 is told: no read of this context is left running behind it. */
              const together = <R>(work: () => Promise<R>): Promise<R> => source.together(principal, work);
              /* On one snapshot between them, as they are asked at once. */
              const [zoneRead, localeRead] = await together(() =>
                Promise.allSettled([readZone(app.ui, schema, data.query), readLocale(app.ui, schema, data.query)]),
              );
              if (zoneRead.status === 'rejected') throw zoneRead.reason;
              if (localeRead.status === 'rejected') throw localeRead.reason;
              const zone = zoneRead.value,
                locale = localeRead.value;
              assertActive();
              const context = Object.freeze({
                principal,
                schema,
                data,
                together,
                ...(capabilities === undefined ? {} : { capabilities }),
                ...(zone === undefined ? {} : { zone }),
                ...(locale === undefined ? {} : { locale }),
              });
              liveRows.set(context, rows);
              releaseFlags = bindTenantFlagOwner(request, principal, revalidate, assertActive);
              let output: T | undefined,
                callbackFailed = false,
                fault: TenantRequestFault | undefined;
              try {
                /* A record no read here admits, or a read asked wrongly, is the
                 request's fault (TenantRequestFault): kept apart from every
                 other failure, which still denies the context. */
                const kept = (error: unknown): T => {
                  fault = requestFault(error);
                  if (fault) return undefined as T;
                  throw error;
                };
                // Called synchronously, as ever: admission closes when it returns.
                let returned: T | Promise<T>;
                try {
                  returned = callback(context);
                } catch (error) {
                  returned = kept(error);
                }
                const result = delivered(
                  isPromise(returned) ? (Promise.prototype.then.call(returned, undefined, kept) as Promise<T>) : returned,
                );
                output = isPromise(result) ? await result : result;
              } catch (error) {
                callbackFailed = true;
                failure ??= error;
              }
              // Reject newly submitted work, but drain everything accepted while
              // the callback was live before final revalidation/source release.
              accepting = false;
              await Promise.allSettled([...pending]);
              if (callbackFailed || failed) return denyTenantFor(failure);
              // A first admission its owner makes again (tenantInvocationAdmittedAgain): that one is the fence.
              if (isAdmittedAgain(guard)) await revalidateSession();
              else await revalidate();
              if (fault) throw fault;
              return output as T;
            } finally {
              releaseFlags();
              accepting = false;
              await Promise.allSettled([...pending]);
              active = false;
            }
            // A read writes nothing, so kept evidence that met a refusal is admitted afresh once.
          },
          { retry: true },
        );
      } catch (error) {
        if (error instanceof TenantRequestFault) throw error;
        return denyTenantFor(error);
      } finally {
        pendingRequests.delete(held);
        finish();
      }
    },
  });
}
