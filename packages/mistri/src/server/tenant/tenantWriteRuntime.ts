import { isPromise } from 'node:util/types';
import { TransactionOperations, TransactionOutcomeUnknown, type WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { CommandTransactionFailure } from '../../adapters/commands/commandJournal.js';
import type { AppDef } from '../../shared/app.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { captureScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import { accessibleSchema, authorizeTransaction, type ResourceAccess } from '../app/appAccess.js';
import { compileAppTransitions } from '../app/appTransitions.js';
import { AppValidationDenied } from '../app/appValidationDenied.js';
import { compileAppDefinitionValidation } from '../app/appValidation.js';
import type { Identity } from '../auth/auth.js';
import { captureTenantData, denyTenant, TenantContextError, tenantOptions } from '@mistriwork/engine/server/evidence.js';
import type { TenantMembershipEvidence } from './tenantMembership.js';
import type { TenantReadSource } from './tenantReadSource.js';
import { captureTenantRequestRuntime, createTenantRequestRuntime, type TenantRequestRuntime } from './tenantRequestRuntime.js';
import { TenantWriteFailure, type TenantWriteSource } from './tenantWriteSource.js';
import { tenantWriteFailed } from './tenantWriteKindContract.js';
import type { TenantWriteOperation } from './tenantWriteKindContract.js';
import { assertStructuredReadFilter } from '@mistriwork/engine/server/resourceReadOperations.js';
import { createTenantInverseImages, type TenantDeletedRecordPolicy, type TenantInverseImages } from './tenantInverseImages.js';
import type { TenantInvocationGuard } from './tenantInvocation.js';
import { tenantVisibleFields } from './tenantVisibleFields.js';
import type { AdmissionCache } from './tenantAdmissionCache.js';

/** Ordinary callbacks retain four methods. Additional inverse authority stays
 * behind a genuine-context private accessor and explicit server policy. */
export type TenantRequestTransaction = Pick<WriteTransaction, 'query' | 'count' | 'insert' | 'update'>;
export interface TenantWriteContext {
  readonly principal: TenantMembershipEvidence;
  readonly schema: DatabaseSchema;
  readonly data: TenantRequestTransaction;
}
export interface TenantWriteRuntimeOptions<Request> {
  readonly app: AppDef;
  /** Dedicated sources; ownership transfers only after successful creation. */
  readonly reader: TenantReadSource;
  readonly writer: TenantWriteSource;
  readonly deployment: string;
  readonly roles: readonly string[];
  readonly maxLifetimeMs: number;
  readonly verifySession: (request: Request) => Identity | null | Promise<Identity | null>;
  readonly resolveMembershipRows: (principal: TenantMembershipEvidence) => RowScope | Promise<RowScope>;
  readonly resolveRows: (principal: TenantMembershipEvidence) => RowScope | Promise<RowScope>;
  /** Private historical-record policy, not ordinary owner-field write authority. */
  readonly authorizeDeletedRecord?: TenantDeletedRecordPolicy;
  readonly now?: () => number;
  /** The deployment's kept admissions (tenantAdmissionCache.ts). */
  readonly admissions?: AdmissionCache;
}

const inverseImages = new WeakMap<TenantWriteContext, TenantInverseImages>();
/** Only a live genuine context can reach the bounded image operations. No raw
 * handle, registration function, caller evidence or public context property. */
export function tenantInverseImages(context: TenantWriteContext): TenantInverseImages {
  return inverseImages.get(context) ?? denyTenant();
}

/** Ordinary record authority over the shared request owner. Command grants and
 * receipt operations have their own facade, never extra generic write methods. */
export function createTenantWriteRuntime<Request>(options: TenantWriteRuntimeOptions<Request>) {
  try {
    return createRuntime(options);
  } catch (error) {
    throw tenantWriteFailed('not_applied', error);
  }
}
function createRuntime<Request>(options: TenantWriteRuntimeOptions<Request>) {
  const raw = tenantOptions(options, [
    'app',
    'reader',
    'writer',
    'deployment',
    'roles',
    'maxLifetimeMs',
    'verifySession',
    'resolveMembershipRows',
    'resolveRows',
    'authorizeDeletedRecord',
    'now',
  ]);
  const deletedPolicy = raw.authorizeDeletedRecord as TenantDeletedRecordPolicy | undefined;
  const runtime = createTenantRequestRuntime(raw as unknown as TenantWriteRuntimeOptions<Request>);
  return Object.freeze({ ...bindTenantWriteRuntime(runtime, deletedPolicy), retire: runtime.retire });
}

/** Internal ordinary authority only, over one genuine shared request owner. */
export function bindTenantWriteRuntime<Request>(input: TenantRequestRuntime<Request>, deletedPolicy?: TenantDeletedRecordPolicy) {
  const runtime = captureTenantRequestRuntime(input);
  if (deletedPolicy !== undefined && typeof deletedPolicy !== 'function') return denyTenant();
  const ownership = runtime.ownership;
  const validation = compileAppDefinitionValidation(ownership.schema, runtime.app);
  /* A machine's column moves only through its actions here as in a single
     database App: an ordinary tenant write is judged by the same rules. */
  const transitions = compileAppTransitions(ownership.schema, runtime.app);
  return Object.freeze({
    /** `operation` names which of the host's operations ran, for a writer kind
     * that records one; it is the host's own fact, never a request's. */
    transaction<T>(
      request: Request,
      selectors: readonly string[],
      callback: (context: TenantWriteContext) => T | Promise<T>,
      guard?: TenantInvocationGuard,
      operation?: TenantWriteOperation,
    ): Promise<T> {
      if (typeof callback !== 'function') return Promise.reject(new TenantWriteFailure('not_applied'));
      return runtime.run(
        request,
        selectors,
        (scope) => {
          const { principal, grants, rows, session } = scope;
          // Ordinary values never receive managed-field authority, even under a
          // broad role. Globals are read-only. Keep all other field ceilings intact.
          const visibleGrants = tenantVisibleFields(ownership, grants);
          const fields = new Map<string, { read: ReadonlySet<string>; write: ReadonlySet<string> }>();
          const writable = new Set<string>();
          for (const table of ownership.schema.tables) {
            const rule = ownership.ownership[table.id],
              configured = visibleGrants.fields?.get(table.id);
            const read = new Set(configured?.read ?? table.columns.map((column) => column.name));
            const write = new Set(configured?.write ?? table.columns.map((column) => column.name));
            if (rule.kind === 'tenant') {
              write.delete(rule.column);
              if (grants.writable.has(table.id)) writable.add(table.id);
            } else write.clear();
            fields.set(table.id, { read, write });
          }
          // Visible, not granted: a platform-owned table is no tenant resource.
          const access: ResourceAccess = {
            readable: visibleGrants.readable,
            writable,
            fields,
            ...(grants.creatable ? { creatable: grants.creatable } : {}),
            // A file's object and hash: written by an upload's insert, named by no request.
            ...(grants.internal ? { internal: grants.internal } : {}),
            ...(validation ? { validation } : {}),
            ...(transitions ? { transitions } : {}),
          };
          const visible = accessibleSchema(ownership.schema, { ...access, rows });
          const schema = captureScopeCatalog({ ...visible, tables: visible.tables.map((table) => ({ ...table, deletable: false })) });
          return scope.transaction(async (records) => {
            const authorized = authorizeTransaction(ownership.schema, access, records);
            const operations = new TransactionOperations();
            let accepting = true,
              callbackFailure: { error: unknown } | undefined;
            const invoke = <A, R>(input: A, work: (captured: A) => Promise<R>, validate?: (captured: A) => void): Promise<R> => {
              if (!accepting) return Promise.reject(new TenantContextError());
              let captured!: A, invalid: { error: unknown } | undefined;
              try {
                captured = captureTenantData(input);
                validate?.(captured);
              } catch (error) {
                invalid = { error };
              }
              return operations.run(async () => {
                try {
                  if (callbackFailure) throw callbackFailure.error;
                  if (invalid) throw invalid.error;
                  await session();
                  const result = captureTenantData(await work(captured));
                  await session();
                  return result;
                } catch (error) {
                  if (error instanceof TransactionOutcomeUnknown) throw error;
                  // The App's rules refusing the record: the person's to fix, said by field name (tenantWriteFailed).
                  if (error instanceof AppValidationDenied) throw error;
                  return denyTenant();
                }
              });
            };
            const project = <V>(table: string, data: Record<string, V>): Record<string, V> =>
              Object.fromEntries(Object.entries(data).filter(([column]) => fields.get(table)?.read.has(column)));
            const data: TenantRequestTransaction = Object.freeze({
              query: (input) =>
                invoke(
                  input,
                  async (value) => {
                    const result = await authorized.query(value);
                    return { ...result, sql: { text: '', params: [] } };
                  },
                  (value) => assertStructuredReadFilter(value.filter, 'column'),
                ),
              count: (table, filter) =>
                invoke(
                  { table, filter },
                  (value) => authorized.count(value.table, value.filter),
                  (value) => assertStructuredReadFilter(value.filter, 'column'),
                ),
              insert: (input) =>
                invoke(input, async (value) => {
                  const result = await authorized.insert(value);
                  return {
                    key: project(value.table, result.key),
                    applied: project(value.table, result.applied),
                    ...(result.row ? { row: project(value.table, result.row) } : {}),
                    sql: { text: '', params: [] },
                  };
                }),
              update: (input) =>
                invoke(input, async (value) => {
                  const result = await authorized.update(value);
                  return { affected: result.affected, applied: project(value.table, result.applied), sql: { text: '', params: [] } };
                }),
            });
            const context = Object.freeze({ principal, schema, data });
            inverseImages.set(context, createTenantInverseImages(ownership, principal, access, records, deletedPolicy, invoke));
            let result!: T;
            const completed = (value: T): T => {
              accepting = false;
              inverseImages.delete(context);
              return captureTenantData(value);
            };
            try {
              const returned = callback(context);
              result = isPromise(returned)
                ? ((await Promise.prototype.then.call(returned, completed, (error: unknown) => {
                    accepting = false;
                    inverseImages.delete(context);
                    throw error;
                  })) as T)
                : completed(returned);
            } catch (error) {
              callbackFailure = { error };
            }
            accepting = false;
            inverseImages.delete(context);
            let failed: { error: unknown } | undefined;
            try {
              await operations.finish();
            } catch (error) {
              failed = { error };
            }
            if (callbackFailure?.error instanceof TransactionOutcomeUnknown) throw callbackFailure.error;
            // The lower source recognizes native uncertainty. Preserve a trusted
            // callback's already-unknown outcome before a known facade refusal can
            // replace it, without teaching the source about higher-level errors.
            if (
              (callbackFailure?.error instanceof TenantWriteFailure && callbackFailure.error.outcome === 'unknown') ||
              (callbackFailure?.error instanceof CommandTransactionFailure && callbackFailure.error.outcome === 'unknown')
            ) {
              throw new TransactionOutcomeUnknown(callbackFailure.error);
            }
            /* A refusal the callback restated — a record's line named by its place (recordWriteOperations.ts
               writeLines) — is the same refusal, said where the person can find it. */
            if (failed && !(failed.error instanceof AppValidationDenied && callbackFailure?.error instanceof AppValidationDenied))
              throw failed.error;
            if (callbackFailure) throw callbackFailure.error;
            return result;
          }, operation);
        },
        guard,
      );
    },
  });
}
