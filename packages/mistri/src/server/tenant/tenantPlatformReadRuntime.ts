/**
 * The platform context's reads. Its row scope is composed from the policy's
 * `resolvePlatformRows` (a table the policy does not name is denied), it reads
 * every tenant's rows with their owner column, and it writes nothing: the
 * platform changes records through its commands (tenantPlatformCommands.ts)
 * and its own rows through its generic edit (tenantPlatformWriteRuntime.ts),
 * which the capabilities offer. Each read is revalidated against the platform
 * membership it was opened under.
 *
 * It is also the one owner that reads the App's platform-only sources
 * (tenantPlatformSource.ts): their tables join its catalog under their
 * qualified names, the policy's rows for them go to that source, and every
 * read goes to the source that holds its table — a query or a count by its
 * table, a view by its base, a breakdown by its base. No key crosses between
 * sources, so no path, join or reference does.
 */
import { isPromise } from 'node:util/types';
import type { Adapter, ScopedReads } from '@mistriwork/engine/adapters/adapter.js';
import { declaredReferences, physicalBindings, resolveAppAccess, tenantAppShape, type AppDef } from '../../shared/app.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { assertScopeCatalog, captureScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { authorizeResources } from '../app/appAccess.js';
import { appResourceCatalog } from '../app/appResources.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import type { Identity } from '../auth/auth.js';
import { assertStructuredReadFilter } from '@mistriwork/engine/server/resourceReadOperations.js';
import type { TenantCapabilities } from './tenantCapabilities.js';
import {
  captureTenantData,
  denyTenant,
  denyTenantFor,
  TenantContextError,
  tenantIdentifier,
  tenantOptions,
  tenantRecord,
} from '@mistriwork/engine/server/evidence.js';
import { checkTenantInvocation, revalidateTenantInvocation, type TenantInvocationGuard } from './tenantInvocation.js';
import { createPlatformMembershipIssuer, type PlatformMembershipEvidence } from './tenantPlatform.js';
import {
  captureTenantPlatformSources,
  composePlatformSourceScope,
  withPlatformSources,
  type TenantPlatformSource,
} from './tenantPlatformSource.js';
import { composePlatformReadScope } from './tenantReadScope.js';
import { captureTenantReadSource, type TenantReadSource } from './tenantReadSource.js';
import { tenantRuntimeClock } from './tenantRuntimeClock.js';
import { tenantVisibleFields } from './tenantVisibleFields.js';
import type { AdmissionCache } from './tenantAdmissionCache.js';
import { bindTenantFlagOwner } from './tenantFlagRuntime.js';

export interface PlatformReadContext {
  readonly principal: PlatformMembershipEvidence;
  readonly schema: DatabaseSchema;
  readonly data: ScopedReads;
  /** What the browser may offer here: the platform realm's granted commands, and the edits its own rows take. */
  readonly capabilities?: TenantCapabilities;
  /** Never read: the platform realm spans tenants, so its first row of a zone column would be some tenant's. It keeps the App's own. */
  readonly zone?: undefined;
  /** Never read, for the same reason: the platform's people read the App's own locale. */
  readonly locale?: undefined;
}
export type PlatformInvocationGuard = TenantInvocationGuard<PlatformMembershipEvidence>;
export interface PlatformReadRuntimeOptions<Request> {
  /** The whole App, its platform-only sources included. */
  readonly app: AppDef;
  /** The deployment's genuine read source; this binding never closes it. */
  readonly source: TenantReadSource;
  /** The App's platform-only sources, in its order; this binding never closes them. */
  readonly platformSources?: readonly TenantPlatformSource[];
  readonly deployment: string;
  /** The platform realm's roles only: a tenant role never admits here. */
  readonly roles: readonly string[];
  readonly maxLifetimeMs: number;
  readonly verifySession: (request: Request) => Identity | null | Promise<Identity | null>;
  readonly resolvePlatformRows: (principal: PlatformMembershipEvidence) => RowScope | Promise<RowScope>;
  /** Presentation from the admitted principal and its permitted schema; grants no authority. */
  readonly presentation?: (principal: PlatformMembershipEvidence, schema: DatabaseSchema) => TenantCapabilities;
  readonly now?: () => number;
  /** The deployment's kept admissions (tenantAdmissionCache.ts). */
  readonly admissions?: AdmissionCache;
}

/** Capture synchronous transfers immediately, asynchronous ones on native delivery. */
function delivered<T>(value: T | Promise<T>): T | Promise<T> {
  return isPromise(value)
    ? (Promise.prototype.then.call(
        value,
        (result: T) => captureTenantData(result),
        (error: unknown) => denyTenantFor(error),
      ) as Promise<T>)
    : captureTenantData(value);
}
/** Compiler diagnostics carry private predicates and physical names. */
function withoutDiagnostics<T extends { sql: unknown }>(result: T): T {
  return { ...result, sql: { text: '', params: [] } };
}

const optionKeys = [
  'app',
  'source',
  'platformSources',
  'deployment',
  'roles',
  'maxLifetimeMs',
  'verifySession',
  'resolvePlatformRows',
  'presentation',
  'now',
  'admissions',
];

/**
 * The platform context's read owner: the twin of bindTenantReadRuntime, kept
 * apart so the proved tenant owner stays exactly as it is. The same admission,
 * revalidation around every read, drain and retirement. What differs is who is
 * admitted (a platform membership, holding platform roles only), the scope
 * (the platform policy's rows across every tenant; a table it does not name is
 * denied) and what is visible (the ownership column readable, nothing
 * writable through a read: the platform realm writes through its commands
 * and its generic edit, each its own owner).
 */
export function bindPlatformReadRuntime<Request>(options: PlatformReadRuntimeOptions<Request>) {
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
  // The App's own tables, then each platform-only source's, by qualified name.
  const outside = captureTenantPlatformSources(raw.platformSources, app);
  const schemaOf = withPlatformSources(
    ownership.schema,
    outside.map((platformSource) => platformSource.schema),
  );
  const holder = new Map<string, TenantPlatformSource>();
  for (const platformSource of outside) for (const table of platformSource.schema.tables) holder.set(table.id, platformSource);
  resolveAppAccess(app, schemaOf, []);
  if (
    typeof raw.verifySession !== 'function' ||
    typeof raw.resolvePlatformRows !== 'function' ||
    (raw.presentation !== undefined && typeof raw.presentation !== 'function') ||
    (raw.now !== undefined && typeof raw.now !== 'function')
  )
    return denyTenant();
  const verify = raw.verifySession as PlatformReadRuntimeOptions<Request>['verifySession'];
  const platformRows = raw.resolvePlatformRows as PlatformReadRuntimeOptions<Request>['resolvePlatformRows'];
  const presentation = raw.presentation as PlatformReadRuntimeOptions<Request>['presentation'];
  const now = tenantRuntimeClock((raw.now ?? Date.now) as () => number);
  const issuer = createPlatformMembershipIssuer({
    ownership,
    deployment: raw.deployment as string,
    roles: raw.roles as readonly string[],
    maxLifetimeMs: raw.maxLifetimeMs as number,
    verifySession: verify,
    membership: { source: ownership.source, read: source.readPlatformMembership },
    now,
    ...(raw.admissions === undefined ? {} : { admissions: raw.admissions as AdmissionCache }),
  });
  /** Each source's part of a scope: the App's own tables, and each platform-only source's. */
  const split = (scope: RowScope) => {
    const own: Record<string, RowScope[string]> = Object.create(null);
    const parts = new Map(outside.map((platformSource) => [platformSource, Object.create(null) as Record<string, RowScope[string]>]));
    for (const [id, rule] of Object.entries(scope)) {
      const held = holder.get(id);
      if (held) parts.get(held)![id] = rule;
      else own[id] = rule;
    }
    return { own, parts };
  };
  let retired = false;
  let retirement: Promise<void> | undefined;
  const pendingRequests = new Set<Promise<void>>();

  return Object.freeze({
    /** Stop synchronously and drain accepted requests. This binding does not close. */
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
      callback: (context: PlatformReadContext) => T | Promise<T>,
      guard?: PlatformInvocationGuard,
    ): Promise<T> {
      if (retired || typeof callback !== 'function') return denyTenant();
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      pendingRequests.add(held);
      try {
        return await issuer.withMembership(
          request,
          async (principal) => {
            let active = true,
              accepting = true,
              failed = false,
              /* The first failure, kept so the answer can tell a database that did not answer from a denial
                 (tenantReadRuntime.ts keeps it the same way). */
              failure: unknown;
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
             `bind`), and the release fence below asks once more after the
             last read has settled. Asking in a snapshot of its own after
             every read as well, and at the scope bind, cost a PostgreSQL
             snapshot each and proved nothing those two do not, as the
             tenant owner found (tenantReadRuntime.ts). */
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
              await source.assertPlatformCurrent(principal);
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
                  const captured = captureTenantData(input);
                  validate(captured);
                  await revalidateSession();
                  const value = await work(captured);
                  const snapshot = captureTenantData(value);
                  await revalidateSession();
                  return snapshot;
                } catch (error) {
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
              const policyResult = delivered(platformRows(principal));
              const policy = isPromise(policyResult) ? await policyResult : policyResult;
              assertActive();
              // Each source composes its own part; a name no source holds is refused there.
              const named = split(policy);
              const rows: RowScope = Object.freeze({
                ...composePlatformReadScope(ownership, principal, named.own),
                ...Object.assign(
                  {},
                  ...outside.map((platformSource) => composePlatformSourceScope(platformSource.schema, named.parts.get(platformSource)!)),
                ),
              });
              // No snapshot yet: whatever reads next, an operation or the release fence, revalidates the membership first.
              await revalidateSession();
              const access = resolveAppAccess(app, schemaOf, [...principal.roles]);
              const adapter: Adapter = Object.freeze({
                dialect: 'sqlite',
                introspect: async () => schemaOf,
                close: async () => {},
                query: denyTenant,
                count: denyTenant,
                scopeReads: async (scope: RowScope) => {
                  const { own, parts } = split(scope);
                  const reads = await source.bindPlatformReads(principal, own);
                  if (!outside.length) return reads;
                  /* The own source admits the context. An outside source is only
                   * admitted when an operation actually reaches one of its tables:
                   * its scope bind has its own fresh membership proof, and the
                   * bound read revalidates again before its attested source
                   * snapshot. The promise is
                   * request-local so concurrent first reads share that one bind. */
                  const bound = new Map<TenantPlatformSource, Promise<ScopedReads>>();
                  const on = (table: string): Promise<ScopedReads> => {
                    const platformSource = holder.get(table);
                    if (!platformSource)
                      return Object.hasOwn(ownership.resources, table) ? Promise.resolve(reads) : Promise.reject(new TenantContextError());
                    let scoped = bound.get(platformSource);
                    if (!scoped) {
                      scoped = platformSource.scopeReads(source, principal, parts.get(platformSource)!);
                      bound.set(platformSource, scoped);
                    }
                    return scoped;
                  };
                  return Object.freeze<ScopedReads>({
                    query: (input) => on(input.table).then((reader) => reader.query(input)),
                    count: (table, filter, limit) => on(table).then((reader) => reader.count(table, filter, limit)),
                    runView: (view, offset) => on(view.base).then((reader) => reader.runView(view, offset)),
                    countView: (view, limit) => on(view.base).then((reader) => reader.countView(view, limit)),
                    runBreakdown: (definition, offset) => on(definition.base).then((reader) => reader.runBreakdown(definition, offset)),
                    countBreakdown: (definition, limit) => on(definition.base).then((reader) => reader.countBreakdown(definition, limit)),
                  });
                },
              });
              const connection = ownership.source.connection;
              const connectionOf = new Map<string, string>([
                ...Object.keys(ownership.resources).map((id) => [id, connection] as const),
                ...[...holder].map(([id, platformSource]) => [id, platformSource.declaration.source.connection] as const),
              ]);
              const connections = [connection, ...outside.map((platformSource) => platformSource.declaration.source.connection)];
              const resource = (id: string) => {
                if (!connectionOf.has(id)) return denyTenant();
                return id;
              };
              const resources: RuntimeResources = {
                adapter,
                schema: schemaOf,
                connections,
                toPhysical: (id) => (Object.hasOwn(ownership.resources, resource(id)) ? ownership.resources[id] : denyTenant()),
                toLogical: catalog.toLogical,
                connectionFor: (id) => connectionOf.get(resource(id))!,
                toLogicalAt: (id, owner) => {
                  if (owner !== connection) return denyTenant();
                  return catalog.toLogical(id);
                },
                forConnection: (owner) => {
                  if (!connections.includes(owner)) return denyTenant();
                  return adapter;
                },
              };
              const visible = tenantVisibleFields(ownership, { ...access, rows, writable: new Set() }, 'platform');
              // A platform-only source's tables are the platform's to read within
              // their column ceilings; nothing of them is ever writable.
              const fields = new Map(visible.fields);
              for (const [id] of holder) {
                if (!visible.readable.has(id)) continue;
                const table = schemaOf.tables.find((each) => each.id === id)!,
                  allowed = access.fields?.get(id);
                fields.set(id, {
                  read: new Set(table.columns.filter((column) => allowed?.read.has(column.name) ?? true).map((column) => column.name)),
                  write: new Set(),
                });
              }
              const guarded = authorizeResources(resources, { ...visible, fields }, assertActive);
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
                countView: (view) =>
                  track(
                    view,
                    (value) => reader.countView!(value),
                    (value) => assertStructuredReadFilter(value.filter, 'path'),
                  ),
                runBreakdown: (definition, offset) =>
                  track(
                    { definition, offset },
                    async (value) => withoutDiagnostics(await reader.runBreakdown!(value.definition, value.offset)),
                    (value) => assertStructuredReadFilter(value.definition.filter, 'path'),
                  ),
                countBreakdown: (definition) =>
                  track(
                    definition,
                    (value) => reader.countBreakdown!(value),
                    (value) => assertStructuredReadFilter(value.filter, 'path'),
                  ),
              });
              const schema = captureScopeCatalog(guarded.schema);
              const capabilities = presentation ? captureTenantData(presentation(principal, schema)) : undefined;
              assertActive();
              const context = Object.freeze({ principal, schema, data, ...(capabilities === undefined ? {} : { capabilities }) });
              releaseFlags = bindTenantFlagOwner(request, principal, revalidate, assertActive);
              let output: T | undefined,
                callbackFailed = false;
              try {
                const result = delivered(callback(context));
                output = isPromise(result) ? await result : result;
              } catch (error) {
                callbackFailed = true;
                failure ??= error;
              }
              accepting = false;
              await Promise.allSettled([...pending]);
              if (callbackFailed || failed) return denyTenantFor(failure);
              await revalidate();
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
        return denyTenantFor(error);
      } finally {
        pendingRequests.delete(held);
        finish();
      }
    },
  });
}
