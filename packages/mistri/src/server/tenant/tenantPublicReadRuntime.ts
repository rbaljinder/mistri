/**
 * A visitor's reads in a tenant App (`auth.public`): the twin of the platform
 * read owner (tenantPlatformReadRuntime.ts), kept apart so the proved owners
 * stay exactly as they are. There is no session to verify and no membership
 * to admit: the visitor is placed with one tenant by that tenant's public
 * address or by an operator's mapped host (tenantPublicRead.ts), and every
 * read re-resolves that placement in its own snapshot before its SQL
 * (tenantReadSource.ts `bindPublicReads`), and once more after the last read
 * has settled.
 *
 * What a visitor may read is the App's public grant (`auth.public`, resolved
 * as a visitor's: resolveAppAccess's `'public'`), seen as a tenant reads it
 * (tenantVisibleFields: the owner column and every platform-owned table
 * left out), under the policy's `resolvePublicRows` narrowed to the placed
 * tenant. Nothing is writable.
 */
import { isPromise } from 'node:util/types';
import type { Adapter, ScopedReads } from '@mistriwork/engine/adapters/adapter.js';
import { declaredReferences, physicalBindings, resolveAppAccess, tenantAppShape, type AppDef } from '../../shared/app.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { assertScopeCatalog, captureScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { PathError } from '@mistriwork/engine/shared/viewPaths.js';
import { authorizeResources } from '../app/appAccess.js';
import { appResourceCatalog } from '../app/appResources.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import {
  captureTenantData,
  denyTenant,
  denyTenantFor,
  recordRefusalCause,
  TenantContextError,
  TenantRequestFault,
  tenantIdentifier,
  tenantOptions,
} from '@mistriwork/engine/server/evidence.js';
import { assertStructuredReadFilter, ResourceReadError } from '@mistriwork/engine/server/resourceReadOperations.js';
import { intakeAddressQuery } from './tenantIntakeModel.js';
import { parseTenantSelector } from './tenantMembership.js';
import { publicAddress, type TenantPublicEvidence } from './tenantPublicRead.js';
import { composePublicReadScope } from './tenantReadScope.js';
import { captureTenantReadSource, type TenantReadSource } from './tenantReadSource.js';
import { tenantRuntimeClock } from './tenantRuntimeClock.js';
import { tenantVisibleFields } from './tenantVisibleFields.js';

/** What a visitor's read is handed: the placed tenant, its permitted catalog and its scoped reader. Holds no role. */
export interface PublicReadContext {
  readonly principal: TenantPublicEvidence & { readonly roles: readonly string[] };
  readonly schema: DatabaseSchema;
  readonly data: ScopedReads;
  /** Never read: a visitor reads no tenant's zone or locale; the App's own are said. */
  readonly zone?: undefined;
  readonly locale?: undefined;
}
/** Where a visitor is placed: the address it carried, or the tenant an operator's mapped host names. */
export type PublicPlacement = { readonly address: string } | { readonly tenant: string };

/** An address that places nobody — unknown, two rows' at once, a tenant or
 * `@platform` that is not active, or not an address at all. One refusal for
 * every reason, answered as a missing page. */
export class TenantPublicNotFound extends Error {
  readonly code = 'not_found';
  constructor() {
    super('Not found.');
    this.name = 'TenantPublicNotFound';
  }
}

export interface PublicReadRuntimeOptions {
  /** The App as its own source sees it (tenantBusinessApp). */
  readonly app: AppDef;
  /** The deployment's genuine read source; this binding never closes it. */
  readonly source: TenantReadSource;
  readonly deployment: string;
  /** The policy's `public.address`: the profile column each tenant's address is in. */
  readonly column: string;
  readonly resolvePublicRows: (visitor: TenantPublicEvidence) => RowScope | Promise<RowScope>;
  /** How long one placement is good for: the window a request's reads must finish in. */
  readonly maxLifetimeMs: number;
  readonly now?: () => number;
}

/** Capture synchronous transfers immediately, asynchronous ones on native delivery. */
function delivered<T>(value: T | Promise<T>): T | Promise<T> {
  return isPromise(value)
    ? (Promise.prototype.then.call(
        value,
        (result: T) => captureTenantData(result),
        () => denyTenant(),
      ) as Promise<T>)
    : captureTenantData(value);
}
/** Compiler diagnostics carry private predicates and physical names. */
function withoutDiagnostics<T extends { sql: unknown }>(result: T): T {
  return { ...result, sql: { text: '', params: [] } };
}
/* A read asked wrongly is the request's, as on a member's lease (tenantReadRuntime.ts requestFault). */
function requestFault(error: unknown): TenantRequestFault | undefined {
  if (error instanceof TenantRequestFault) return error;
  if (error instanceof ResourceReadError && error.status === 400)
    return recordRefusalCause(new TenantRequestFault(error.status, 'invalid_read'), error);
  if (error instanceof PathError) return recordRefusalCause(new TenantRequestFault(400, 'invalid_read'), error);
  return undefined;
}

const optionKeys = ['app', 'source', 'deployment', 'column', 'resolvePublicRows', 'maxLifetimeMs', 'now'];

export function bindPublicReadRuntime(options: PublicReadRuntimeOptions) {
  const raw = tenantOptions(options, optionKeys);
  const source = captureTenantReadSource(raw.source as TenantReadSource);
  const ownership = source.ownership;
  const app = captureTenantData(raw.app as AppDef);
  if (!app || !tenantAppShape(app, ownership) || !app.auth?.public) return denyTenant();
  tenantIdentifier(raw.deployment);
  tenantIdentifier(raw.column);
  // The column's rules are intake's: text on the profile, never a key (assertIntakeColumn).
  intakeAddressQuery(ownership, raw.column as string);
  const catalog = appResourceCatalog(
    ownership.physicalSchema,
    physicalBindings(app, ownership.source.id),
    declaredReferences(app, ownership.source.id),
  );
  assertScopeCatalog(ownership.schema, catalog.schema);
  for (const id of Object.keys(ownership.resources)) {
    if (catalog.toPhysical(id) !== ownership.resources[id]) return denyTenant();
  }
  if (
    typeof raw.resolvePublicRows !== 'function' ||
    (raw.now !== undefined && typeof raw.now !== 'function') ||
    typeof raw.maxLifetimeMs !== 'number' ||
    !Number.isSafeInteger(raw.maxLifetimeMs) ||
    raw.maxLifetimeMs < 1
  )
    return denyTenant();
  const publicRows = raw.resolvePublicRows as PublicReadRuntimeOptions['resolvePublicRows'];
  const now = tenantRuntimeClock((raw.now ?? Date.now) as () => number);
  const lifetime = raw.maxLifetimeMs as number;
  // A visitor's grant, as the App resolves one: the same for every visitor.
  const access = resolveAppAccess(app, ownership.schema, [], 'public');
  let retired = false;
  let retirement: Promise<void> | undefined;
  const pendingRequests = new Set<Promise<void>>();

  return Object.freeze({
    /** Stop synchronously and drain accepted requests. This binding does not close the source. */
    retire(): Promise<void> {
      if (retirement) return retirement;
      retired = true;
      retirement = Promise.allSettled([...pendingRequests]).then(() => {});
      return retirement;
    },
    async withContext<T>(placement: PublicPlacement, callback: (context: PublicReadContext) => T | Promise<T>): Promise<T> {
      if (retired || typeof callback !== 'function') return denyTenant();
      // A placement that is not one is not found, like an address that names nobody.
      const asked = captureTenantData(placement) as Record<string, unknown>;
      let address: string | null = null,
        tenant: string | null = null;
      try {
        if (Object.hasOwn(asked, 'address') && Object.keys(asked).length === 1) {
          address = publicAddress(asked.address) ?? null;
          if (address === null) throw new TenantPublicNotFound();
        } else if (Object.hasOwn(asked, 'tenant') && Object.keys(asked).length === 1) {
          tenant = parseTenantSelector([asked.tenant as string]);
        } else throw new TenantPublicNotFound();
      } catch {
        throw new TenantPublicNotFound();
      }
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      pendingRequests.add(held);
      try {
        const verifiedAt = now();
        const resolved = await source.resolvePublic({
          appId: ownership.appId,
          source: ownership.source,
          deployment: raw.deployment as string,
          column: raw.column as string,
          address,
          tenant,
        });
        if (retired) return denyTenant();
        if (resolved === null) throw new TenantPublicNotFound();
        const principal: TenantPublicEvidence = Object.freeze({
          realm: 'public' as const,
          appId: ownership.appId,
          source: ownership.source,
          deployment: raw.deployment as string,
          tenantId: resolved.tenantId,
          tenantVersion: resolved.tenantVersion,
          platformVersion: resolved.platformVersion,
          column: raw.column as string,
          address,
          verifiedAt,
          validUntil: verifiedAt + lifetime,
        });
        let active = true,
          accepting = true,
          failed = false;
        let lastTime = verifiedAt;
        const pending = new Set<Promise<void>>();
        const assertActive = () => {
          if (retired || !active || failed) return denyTenant();
          const instant = now();
          if (!Number.isSafeInteger(instant) || instant < lastTime || instant >= principal.validUntil) denyTenant();
          lastTime = instant;
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
              assertActive();
              const value = await work(captured);
              const snapshot = captureTenantData(value);
              assertActive();
              return snapshot;
            } catch (error) {
              if (error instanceof PathError) throw recordRefusalCause(new TenantRequestFault(400, 'invalid_read'), error);
              failed = true;
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
          const policyResult = delivered(publicRows(principal));
          const policy = isPromise(policyResult) ? await policyResult : policyResult;
          assertActive();
          // Composed here to refuse a malformed answer before anything reads; the source recomposes it itself.
          const rows = composePublicReadScope(ownership, principal, policy);
          const adapter: Adapter = Object.freeze({
            dialect: 'sqlite',
            introspect: async () => ownership.schema,
            close: async () => {},
            query: denyTenant,
            count: denyTenant,
            // The source composes the visitor's scope again from what it is handed, the tenant predicate its own.
            scopeReads: (scope: RowScope) => source.bindPublicReads(principal, scope),
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
          const guarded = authorizeResources(
            resources,
            tenantVisibleFields(ownership, { ...access, rows, writable: new Set(), creatable: new Set() }),
            assertActive,
          );
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
          assertActive();
          const context: PublicReadContext = Object.freeze({ principal: Object.freeze({ ...principal, roles: [] }), schema, data });
          let output: T | undefined,
            callbackFailed = false,
            fault: TenantRequestFault | undefined;
          try {
            const kept = (error: unknown): T => {
              fault = requestFault(error);
              if (fault) return undefined as T;
              throw error;
            };
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
          } catch {
            callbackFailed = true;
          }
          accepting = false;
          await Promise.allSettled([...pending]);
          if (callbackFailed || failed) return denyTenant();
          // The release fence: the placement once more, in a snapshot of its own, after every read has settled.
          await source.assertPublicCurrent(principal);
          assertActive();
          if (fault) throw fault;
          return output as T;
        } finally {
          accepting = false;
          await Promise.allSettled([...pending]);
          active = false;
        }
      } catch (error) {
        if (error instanceof TenantPublicNotFound || error instanceof TenantRequestFault) throw error;
        return denyTenantFor(error);
      } finally {
        pendingRequests.delete(held);
        finish();
      }
    },
  });
}
