import { restatesConstraint } from '../app/appDataRules.js';
import { isPromise } from 'node:util/types';
import {
  TransactionOperations,
  TransactionOutcomeUnknown,
  type InsertRequest,
  type InsertResult,
  type WriteTransaction,
} from '@mistriwork/engine/adapters/adapter.js';
import { CommandTransactionFailure } from '../../adapters/commands/commandJournal.js';
import type { AppDef } from '../../shared/app.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import type { TenantRowsContext } from '../policy/appTenantPolicy.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { captureScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import { appActionGrants } from '../../shared/appAccess.js';
import { accessibleSchema, authorizeTransaction, markStableGrant, type ResourceAccess } from '../app/appAccess.js';
import { actingPrincipal } from './tenantApiRequest.js';
import { compileAppTransitions } from '../app/appTransitions.js';
import { compileAppStamps, stampInsert, stampUpdate, type StampMoment } from '../app/appStamps.js';
import { lookupTenantPerson } from '../app/appMe.js';
import { clockNow } from '@mistriwork/engine/server/http/clock.js';
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
  readonly resolveRows: (principal: TenantMembershipEvidence, context: TenantRowsContext) => RowScope | Promise<RowScope>;
  /** Private historical-record policy, not ordinary owner-field write authority. */
  readonly authorizeDeletedRecord?: TenantDeletedRecordPolicy;
  readonly now?: () => number;
  /** The deployment's kept admissions (tenantAdmissionCache.ts). */
  readonly admissions?: AdmissionCache;
}

const WRITE_GRANTS = 256;
const inverseImages = new WeakMap<TenantWriteContext, TenantInverseImages>();
const batchInserters = new WeakMap<TenantWriteContext, (inputs: readonly InsertRequest[]) => Promise<InsertResult[]>>();
/** Only a live genuine context can reach the bounded image operations. No raw
 * handle, registration function, caller evidence or public context property. */
export function tenantInverseImages(context: TenantWriteContext): TenantInverseImages {
  return inverseImages.get(context) ?? denyTenant();
}
/** Internal batch-insert capability for bulk imports when the underlying writer supports insertMany. */
export function tenantBatchInsert(
  context: TenantWriteContext,
): ((inputs: readonly InsertRequest[]) => Promise<InsertResult[]>) | undefined {
  return batchInserters.get(context);
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
  /* An action's `me`/`now`, a New form's default and a file rule's stamps, by the same rules as a single App's
     (appStamps.ts): the person is the admitted account's row of the tenant's own people table, the moment the
     server's clock. A people table that is not the tenant's holds nobody's row here (appMe.ts lookupTenantPerson). */
  const stamps = compileAppStamps(ownership.schema, runtime.app);
  const me = runtime.app.auth?.me;
  const peopleOwned = !!me && ownership.ownership[me.from]?.kind === 'tenant';
  /* A role set's write grant and captured catalog depend only on the App, this catalog and the roles (all fixed here),
     never on the tenant or member: kept per role pair and marked stable so `authorizeTransaction` and `accessibleSchema`
     reuse them by identity instead of cloning the full catalog on every update/insert/delete. */
  const writeGrants = new Map<
    string,
    {
      readonly fields: Map<string, { read: ReadonlySet<string>; write: ReadonlySet<string> }>;
      readonly baseAccess: ResourceAccess;
      readonly schema: DatabaseSchema;
    }
  >();
  const writeTemplate = (actingRoles: readonly string[], principalRoles: readonly string[], grants: ResourceAccess) => {
    const key = JSON.stringify([actingRoles, principalRoles]);
    const kept = writeGrants.get(key);
    if (kept) return kept;
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
    /* A fixed action a member's role is granted without write: the member's verb, so only this writer kind
       holds it. The facade admits exactly the action (its `when` read through the tenant's rows, its stamps
       the server's clock and this member's person); the tenant column stays out of every write set. */
    const granted = appActionGrants(runtime.app, ownership.schema, [...principalRoles]);
    const actions = granted.size ? granted : undefined;
    // Visible, not granted: a platform-owned table is no tenant resource.
    const baseAccess: ResourceAccess = markStableGrant({
      readable: visibleGrants.readable,
      writable,
      fields,
      ...(grants.creatable ? { creatable: grants.creatable } : {}),
      ...(grants.appendOnly ? { appendOnly: grants.appendOnly } : {}),
      // A file's object and hash: written by an upload's insert, named by no request.
      ...(grants.internal ? { internal: grants.internal } : {}),
      ...(validation ? { validation } : {}),
      ...(transitions ? { transitions } : {}),
      ...(actions ? { actions } : {}),
    });
    const visible = accessibleSchema(ownership.schema, { ...baseAccess, rows: {} });
    const schema = captureScopeCatalog({ ...visible, tables: visible.tables.map((table) => ({ ...table, deletable: false })) });
    const entry = { fields, baseAccess, schema };
    if (writeGrants.size >= WRITE_GRANTS) writeGrants.delete(writeGrants.keys().next().value!);
    writeGrants.set(key, entry);
    return entry;
  };
  return Object.freeze({
    /** `operation` names which of the host's operations ran, for a writer kind
     * that records one; it is the host's own fact, never a request's. */
    transaction<T>(
      request: Request,
      selectors: readonly string[],
      callback: (context: TenantWriteContext) => T | Promise<T>,
      guard?: TenantInvocationGuard,
      operation?: TenantWriteOperation,
      /** Awaited once the request is admitted and before its transaction begins: what must wait for this principal
       * waits here, holding no connection (tenantRecordHistory.ts, its history partition). Run again for each
       * admission, should the request be admitted afresh. */
      admitted?: (principal: TenantMembershipEvidence) => Promise<void>,
    ): Promise<T> {
      if (typeof callback !== 'function') return Promise.reject(new TenantWriteFailure('not_applied'));
      return runtime.run(
        request,
        selectors,
        async (scope) => {
          if (admitted) await admitted(scope.principal);
          const { principal, grants, session } = scope;
          const acting = actingPrincipal(request, principal);
          const { fields, baseAccess, schema } = writeTemplate(acting.roles, principal.roles, grants);
          /* Read as the write runs, through its own transaction (authorizeTransaction passes it): nothing the
             request says becomes a stamp. */
          const moment = (reader: Parameters<typeof lookupTenantPerson>[4]): StampMoment => ({
            now: clockNow(),
            who: scope.who(),
            person: async () =>
              (await lookupTenantPerson(runtime.app, ownership.schema, scope.who(), peopleOwned ? principal.accountId : undefined, reader))
                .person?.key ?? null,
          });
          const access: ResourceAccess = {
            ...baseAccess,
            /* The writer as a `when` reads them, `tenant.<column>` included: a machine's step is judged for a member
               who holds write as much as an action is for one granted only the verb. Looked up only when a `when`
               names them. */
            me: (reader) =>
              lookupTenantPerson(
                runtime.app,
                ownership.schema,
                scope.who(),
                peopleOwned ? principal.accountId : undefined,
                reader,
                scope.tenant,
              ),
            ...(stamps?.rules.size ? { stamp: (request, reader) => stampUpdate(stamps, request, moment(reader)) } : {}),
            ...(stamps?.defaults ? { fill: (request, reader) => stampInsert(stamps, request, moment(reader)) } : {}),
          };
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
                  /* Every other refusal is the same value-free denial to the caller, with what refused it kept for
                     the operator: dropped here, a member's refused fixed action logged nothing but "the tenant
                     context could not be verified" (a field report). */
                  return denyTenant(error);
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
            if (authorized.insertMany) {
              batchInserters.set(context, (inputs) =>
                invoke(inputs, async (values) => {
                  const results = await authorized.insertMany!(values);
                  return results.map((result, index) => {
                    const table = values[index]!.table;
                    return {
                      key: project(table, result.key),
                      applied: project(table, result.applied),
                      ...(result.row ? { row: project(table, result.row) } : {}),
                      sql: { text: '', params: [] },
                    };
                  });
                }),
              );
            }
            let result!: T;
            const release = () => {
              accepting = false;
              inverseImages.delete(context);
              batchInserters.delete(context);
            };
            const completed = (value: T): T => {
              release();
              return captureTenantData(value);
            };
            try {
              const returned = callback(context);
              result = isPromise(returned)
                ? ((await Promise.prototype.then.call(returned, completed, (error: unknown) => {
                    release();
                    throw error;
                  })) as T)
                : completed(returned);
            } catch (error) {
              callbackFailure = { error };
            }
            release();
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
            if (
              failed &&
              !(failed.error instanceof AppValidationDenied && callbackFailure?.error instanceof AppValidationDenied) &&
              !restatesConstraint(failed.error, callbackFailure?.error)
            )
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
