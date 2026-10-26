/**
 * A support session's reads ("enter as dealer"): the dealer's own rows, read
 * under the one dealer role the session holds, on a source fenced by the support
 * row itself.
 *
 * This is the platform realm's shape (tenantPlatformReadRuntime.ts) with one
 * deliberate difference: it creates no membership issuer. A support session is
 * admitted by the support owner's own fence — the support row, its parent
 * platform membership, `@platform`, the dealer and the audit session of that
 * very native login — so evidence arrives already minted, and re-admitting it
 * here through a membership lookup would look for a member row an operator
 * inside a dealer does not have. What this runtime does instead is revalidate
 * that evidence against the store on every operation, through
 * `source.assertSupportCurrent`, which is the same fence the compiled reader
 * re-runs before each read.
 *
 * The row scope comes from the App's existing `resolveMembershipRows` and
 * `resolveRows`, on a member view of the support evidence. One policy rule then
 * governs a dealer's rows for its own members and for an operator inside it. A
 * second rule for support would be a rule that can disagree with the first, and
 * a disagreement there surfaces as a session reading rows the policy meant to
 * withhold — not as a failing test.
 *
 * Nothing here opens a door: a support lease is still refused by every request
 * family (tenantContexts.ts), so the only caller that reaches this holds issued
 * support evidence.
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
import type { TenantMembershipEvidence } from './tenantMembership.js';
import { composeTenantReadScope } from './tenantReadScope.js';
import { captureTenantReadSource, type TenantReadSource } from './tenantReadSource.js';
import { tenantRuntimeClock } from './tenantRuntimeClock.js';
import { isSupportEvidence, type SupportMembershipEvidence } from './tenantSupportLease.js';
import { supportAsMember } from './tenantSupportMembership.js';
import { tenantVisibleFields } from './tenantVisibleFields.js';

export interface SupportReadContext {
  readonly principal: SupportMembershipEvidence;
  readonly schema: DatabaseSchema;
  readonly data: ScopedReads;
  /** Presentation only; the read adapter remains incapable of writing. */
  readonly capabilities?: TenantCapabilities;
}
/** The contexts layer names one: its support read family passes a guard, as the
 * platform read family does. */
export type SupportInvocationGuard = TenantInvocationGuard<SupportMembershipEvidence>;
export interface SupportReadRuntimeOptions<Request> {
  readonly app: AppDef;
  /** A dedicated genuine source. Ownership transfers only on successful creation. */
  readonly source: TenantReadSource;
  readonly deployment: string;
  readonly verifySession: (request: Request) => Identity | null | Promise<Identity | null>;
  /** The App's own rules for a dealer's rows, read on a member view of the
   * session's evidence: one rule, never a second that could disagree. */
  readonly resolveMembershipRows: (principal: TenantMembershipEvidence) => RowScope | Promise<RowScope>;
  readonly resolveRows: (principal: TenantMembershipEvidence) => RowScope | Promise<RowScope>;
  readonly presentation?: (principal: TenantMembershipEvidence, schema: DatabaseSchema) => TenantCapabilities;
  readonly now?: () => number;
}

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
const optionKeys = ['app', 'source', 'deployment', 'verifySession', 'resolveMembershipRows', 'resolveRows', 'presentation', 'now'];

/** Internal non-owning binding: its retire stops admission and drains requests,
 * and never closes the source it was handed. */
export function bindSupportReadRuntime<Request>(options: SupportReadRuntimeOptions<Request>) {
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
  resolveAppAccess(app, ownership.schema, []);
  if (
    typeof raw.verifySession !== 'function' ||
    typeof raw.resolveMembershipRows !== 'function' ||
    typeof raw.resolveRows !== 'function' ||
    (raw.presentation !== undefined && typeof raw.presentation !== 'function') ||
    (raw.now !== undefined && typeof raw.now !== 'function')
  )
    return denyTenant();
  tenantIdentifier(raw.deployment);
  const deployment = raw.deployment as string;
  const verify = raw.verifySession as SupportReadRuntimeOptions<Request>['verifySession'];
  const membershipRows = raw.resolveMembershipRows as SupportReadRuntimeOptions<Request>['resolveMembershipRows'];
  const authoredRows = raw.resolveRows as SupportReadRuntimeOptions<Request>['resolveRows'];
  const presentation = raw.presentation as SupportReadRuntimeOptions<Request>['presentation'];
  const now = tenantRuntimeClock((raw.now ?? Date.now) as () => number);
  let retired = false,
    retirement: Promise<void> | undefined;
  const pendingRequests = new Set<Promise<void>>();

  return Object.freeze({
    retire(): Promise<void> {
      if (retirement) return retirement;
      retired = true;
      retirement = (async () => {
        try {
          await Promise.allSettled([...pendingRequests]);
        } catch {
          return denyTenant();
        }
      })();
      void retirement.catch(() => {});
      return retirement;
    },
    /** One request on an already-admitted session. `principal` must be evidence
     * the support owner minted: a structural copy admits nothing. */
    async withContext<T>(
      request: Request,
      principal: SupportMembershipEvidence,
      callback: (context: SupportReadContext) => T | Promise<T>,
      guard?: SupportInvocationGuard,
    ): Promise<T> {
      if (retired || typeof callback !== 'function') return denyTenant();
      // Only the support owner's own evidence, recognised by identity, so a
      // spread, a copy or a proxy of it reaches no rows.
      if (
        !isSupportEvidence(principal) ||
        principal.appId !== ownership.appId ||
        principal.source.id !== ownership.source.id ||
        principal.source.connection !== ownership.source.connection ||
        principal.deployment !== deployment
      )
        return denyTenant();
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      pendingRequests.add(held);
      try {
        let active = true,
          accepting = true,
          failed = false;
        let failure: unknown;
        let lastTime = principal.verifiedAt;
        const pending = new Set<Promise<void>>();
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
        const revalidate = async () => {
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
          // The support row, its parent, `@platform` and the dealer — never a
          // member membership, which this principal does not hold.
          await source.assertSupportCurrent(principal);
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
              await revalidate();
              const value = await work(captured);
              const snapshot = captureTenantData(value);
              await revalidate();
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
          const view = supportAsMember(principal);
          const membershipResult = delivered(membershipRows(view));
          const member = isPromise(membershipResult) ? await membershipResult : membershipResult;
          assertActive();
          const authoredResult = delivered(authoredRows(view));
          const authored = isPromise(authoredResult) ? await authoredResult : authoredResult;
          assertActive();
          await revalidate();
          const access = resolveAppAccess(app, ownership.schema, [...principal.roles]);
          const adapter: Adapter = Object.freeze({
            dialect: 'sqlite',
            introspect: async () => ownership.schema,
            close: async () => {},
            query: denyTenant,
            count: denyTenant,
            // The source recomposes the dealer's scope itself and fences on the
            // support row: whatever is passed here, a table the policy does not
            // name stays denied.
            scopeReads: (scope: RowScope) => source.scopeSupportReads(principal, scope),
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
          /* Composed, not merged. A spread would let whichever resolver ran last
             decide a table the two disagree about, which is how a scope quietly
             widens; composeTenantReadScope intersects them under the tenant
             predicate, exactly as a member's read does. The source recomposes
             from the member view as well, but a scope must not depend on a
             downstream save for its correctness. */
          const rows = composeTenantReadScope(ownership, view, member, authored);
          const guarded = authorizeResources(
            resources,
            tenantVisibleFields(ownership, { ...access, rows, writable: new Set() }),
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
          const capabilities = presentation ? captureTenantData(presentation(supportAsMember(principal), schema)) : undefined;
          assertActive();
          const context = Object.freeze({ principal, schema, data, ...(capabilities === undefined ? {} : { capabilities }) });
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
          active = false;
        }
      } finally {
        pendingRequests.delete(held);
        finish();
      }
    },
  });
}

/* There is no owning variant. A deployment binds this runtime over a source it
   already holds, as it binds the tenant and platform ones, so a variant that
   closed the source would have no caller — and an export with no caller is a
   claim about a shape nobody has had to make work. */
