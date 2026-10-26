/**
 * The platform realm's generic edit: provider staff fixing a typo
 * on an account, with Save, New and Delete on the platform's own rows, under
 * the grants a platform role names (appTenancy.ts says which it may name).
 *
 * The twin of bindTenantWriteRuntime, over the platform request owner
 * (tenantPlatformCommands.ts): the same admission, session bracketing, one
 * owned transaction, drain and retirement, and the App's own rules — its
 * validation, its machines, its field ceilings. What differs is what may be
 * written. Two layers decide it, either of them enough:
 *
 * - here, the access each request is judged by: only platform-owned tables
 *   the role writes (tenantVisibleFields), the profile's held columns
 *   (platformHeldColumns) never, no New on the profile (platformInsertable)
 *   and no Delete on a table any key refers to (platformDeletable);
 * - beneath, the writer's platform transaction without a journal, whose
 *   managed transaction refuses a tenant's row, the profile's birth or end,
 *   and any key column, whatever this layer asked (tenantManagedTransaction.ts).
 *
 * There is no Undo and no command receipt: a platform edit's trail is the
 * record's own history, kept beneath the writer like every other write, with
 * no owner and the account that saved it. A tenant's rows still change only
 * through commands, which say what they do and are journaled.
 */
import { isPromise } from 'node:util/types';
import {
  TransactionOperations,
  TransactionOutcomeUnknown,
  type DeleteRequest,
  type Filter,
  type InsertRequest,
  type InsertResult,
  type UpdateRequest,
  type UpdateResult,
} from '@mistriwork/engine/adapters/adapter.js';
import { appDeletable, resolveAppAccess } from '../../shared/app.js';
import { authorizeTransaction, type ResourceAccess } from '../app/appAccess.js';
import { compileAppTransitions } from '../app/appTransitions.js';
import { AppValidationDenied } from '../app/appValidationDenied.js';
import { compileAppDefinitionValidation } from '../app/appValidation.js';
import { captureTenantData, denyTenant, TenantContextError, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { writeLines, type LineCollection, type LineWriter } from '@mistriwork/engine/server/recordWriteOperations.js';
import { assertStructuredReadFilter } from '@mistriwork/engine/server/resourceReadOperations.js';
import type { PlatformRequestRuntime } from './tenantPlatformCommands.js';
import type { PlatformInvocationGuard } from './tenantPlatformReadRuntime.js';
import { platformDeletable, platformInsertable, tenantVisibleFields } from './tenantVisibleFields.js';
import { TenantWriteFailure } from './tenantWriteKindContract.js';

/** A new record's lines (formLinesWrite.ts), judged by the route on the lease's own catalog. */
type WithLines<T> = T & { lines?: readonly LineCollection[] };

const keyFilter = (key: Record<string, string | number>): Filter => ({
  groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=', value }))],
});

/**
 * The access a platform member's generic edit is judged by, from its roles:
 * what it reads, as its reads are; what it writes, the platform's own tables
 * alone with the held columns kept out; New where platformInsertable says.
 * The served schema and the capabilities are drawn from the same answer, so
 * the page offers exactly what the write accepts.
 */
function platformEditAccess(
  runtime: Pick<PlatformRequestRuntime<unknown>, 'app' | 'ownership'>,
  roles: readonly string[],
  held: ReadonlySet<string>,
): ResourceAccess {
  const { app, ownership } = runtime;
  const visible = tenantVisibleFields(ownership, resolveAppAccess(app, ownership.schema, [...roles]), 'platform', held);
  const creatable = new Set([...visible.writable].filter((id) => platformInsertable(ownership, visible, id)));
  return {
    readable: visible.readable,
    writable: visible.writable,
    creatable,
    ...(visible.fields ? { fields: visible.fields } : {}),
  };
}

/** The tables a platform member may remove a row of, by the App's `delete` and the structure (platformDeletable). */
function platformRemovable(runtime: Pick<PlatformRequestRuntime<unknown>, 'app' | 'ownership'>, access: ResourceAccess): Set<string> {
  const deletes = appDeletable(runtime.app, runtime.ownership.schema);
  return new Set([...access.writable].filter((id) => deletes.has(id) && platformDeletable(runtime.ownership, access, id)));
}

export function bindPlatformWriteRuntime<Request>(runtime: PlatformRequestRuntime<Request>, held: ReadonlySet<string>) {
  const { app, ownership } = runtime;
  const kept = new Set(captureTenantData([...held]));
  const validation = compileAppDefinitionValidation(ownership.schema, app);
  /* A machine's column moves only through its actions, here as everywhere. */
  const transitions = compileAppTransitions(ownership.schema, app);
  type Edit = {
    readonly data: {
      query: LineWriter['query'];
      insert(request: InsertRequest): Promise<InsertResult>;
      update(request: UpdateRequest): Promise<UpdateResult>;
    };
    /** Whether a row of this table may be removed by this member at all, before it is read. */
    removable(table: string): boolean;
    remove(request: DeleteRequest): Promise<{ affected: number }>;
  };
  const edit = <T>(request: Request, callback: (context: Edit) => Promise<T>, guard?: PlatformInvocationGuard): Promise<T> =>
    runtime.run(
      request,
      (scope) => {
        const access = platformEditAccess(runtime, scope.principal.roles, kept);
        const judged: ResourceAccess = {
          ...access,
          ...(validation ? { validation } : {}),
          ...(transitions ? { transitions } : {}),
        };
        const removable = platformRemovable(runtime, access);
        return scope.transaction(async (records) => {
          const authorized = authorizeTransaction(ownership.schema, judged, records);
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
                await scope.session();
                const result = captureTenantData(await work(captured));
                await scope.session();
                return result;
              } catch (error) {
                if (error instanceof TransactionOutcomeUnknown) throw error;
                // The App's rules refusing the record: the person's to fix, said by field name.
                if (error instanceof AppValidationDenied) throw error;
                return denyTenant();
              }
            });
          };
          const project = <V>(table: string, data: Record<string, V>): Record<string, V> =>
            Object.fromEntries(Object.entries(data).filter(([column]) => access.fields?.get(table)?.read.has(column) ?? true));
          const context: Edit = Object.freeze({
            data: Object.freeze({
              query: (input: Parameters<LineWriter['query']>[0]) =>
                invoke(
                  input,
                  async (value) => ({
                    ...(await authorized.query(value)),
                    sql: { text: '', params: [] },
                  }),
                  (value) => assertStructuredReadFilter(value.filter, 'column'),
                ),
              insert: (input: InsertRequest) =>
                invoke(input, async (value) => {
                  const result = await authorized.insert(value);
                  return {
                    key: project(value.table, result.key),
                    applied: project(value.table, result.applied),
                    ...(result.row ? { row: project(value.table, result.row) } : {}),
                    sql: { text: '', params: [] },
                  };
                }),
              update: (input: UpdateRequest) =>
                invoke(input, async (value) => {
                  const result = await authorized.update(value);
                  return {
                    affected: result.affected,
                    applied: project(value.table, result.applied),
                    sql: { text: '', params: [] },
                  };
                }),
            }),
            removable: (table: string) => typeof table === 'string' && removable.has(table),
            remove: (input: DeleteRequest) =>
              invoke(input, async (value) => {
                tenantRecord(value, ['table', 'key']);
                if (!removable.has(value.table)) return denyTenant();
                const result = await authorized.remove(value);
                if (result.affected !== 1) return denyTenant();
                return { affected: 1 };
              }),
          });
          let result!: T;
          try {
            const returned = callback(context);
            result = isPromise(returned)
              ? ((await Promise.prototype.then.call(
                  returned,
                  (value: T) => {
                    accepting = false;
                    return captureTenantData(value);
                  },
                  (error: unknown) => {
                    accepting = false;
                    throw error;
                  },
                )) as T)
              : captureTenantData(returned);
          } catch (error) {
            callbackFailure = { error };
          }
          accepting = false;
          let failed: { error: unknown } | undefined;
          try {
            await operations.finish();
          } catch (error) {
            failed = { error };
          }
          if (callbackFailure?.error instanceof TransactionOutcomeUnknown) throw callbackFailure.error;
          if (callbackFailure?.error instanceof TenantWriteFailure && callbackFailure.error.outcome === 'unknown')
            throw new TransactionOutcomeUnknown(callbackFailure.error);
          /* A refusal the callback restated — a record's line named by its place — is the same refusal. */
          if (failed && !(failed.error instanceof AppValidationDenied && callbackFailure?.error instanceof AppValidationDenied))
            throw failed.error;
          if (callbackFailure) throw callbackFailure.error;
          return result;
        });
      },
      guard,
    );
  /* Lines are written as this member could write each row alone; a line's removal is a Delete's. */
  const lineWriter = (context: Edit): LineWriter => ({
    query: (request) => context.data.query(request),
    insert: (request) => context.data.insert(request),
    update: (request) => context.data.update(request),
    remove: (request) => context.remove(request),
  });
  const writable = (lines: readonly LineCollection[]) => lines.map((line) => ({ ...line }));
  const keyOf = (table: string, value: unknown): Record<string, string | number> => {
    tenantRecord(value);
    const primary = ownership.schema.tables.find((item) => item.id === table)?.columns.filter((column) => column.primaryKey) ?? [];
    if (
      !primary.length ||
      Object.keys(value).length !== primary.length ||
      primary.some((column) => !Object.hasOwn(value, column.name)) ||
      Object.values(value).some((item) => typeof item !== 'string' && !(typeof item === 'number' && Number.isFinite(item)))
    )
      return denyTenant();
    return value as Record<string, string | number>;
  };
  return Object.freeze({
    update(request: Request, value: UpdateRequest, guard?: PlatformInvocationGuard): Promise<{ result: UpdateResult }> {
      return edit(
        request,
        async (context) => {
          const input = captureTenantData(value);
          tenantRecord(input, ['table', 'key', 'values', 'expected']);
          tenantRecord(input.values);
          if (typeof input.table !== 'string' || !Object.keys(input.values).length) return denyTenant();
          keyOf(input.table, input.key);
          return { result: await context.data.update(input) };
        },
        guard,
      );
    },
    insert(request: Request, value: WithLines<InsertRequest>, guard?: PlatformInvocationGuard): Promise<{ result: InsertResult }> {
      return edit(
        request,
        async (context) => {
          const captured = captureTenantData(value);
          tenantRecord(captured, ['table', 'values', 'lines']);
          const { lines, ...input } = captured;
          tenantRecord(input.values);
          const result = await context.data.insert(input);
          if (lines !== undefined) await writeLines(lineWriter(context), writable(lines), { ...result.row, ...result.key });
          return { result };
        },
        guard,
      );
    },
    remove(request: Request, value: DeleteRequest, guard?: PlatformInvocationGuard): Promise<{ result: { affected: number } }> {
      return edit(
        request,
        async (context) => {
          const input = captureTenantData(value);
          tenantRecord(input, ['table', 'key']);
          return {
            result: await context.remove({
              table: input.table,
              key: keyOf(input.table, input.key),
            }),
          };
        },
        guard,
      );
    },
    /** Whether Delete would be accepted, without removing a row: the same eligibility and the row there to remove. */
    previewRemove(request: Request, value: DeleteRequest, guard?: PlatformInvocationGuard) {
      return edit(
        request,
        async (context) => {
          const input = captureTenantData(value);
          tenantRecord(input, ['table', 'key']);
          if (!context.removable(input.table)) return denyTenant();
          const key = keyOf(input.table, input.key);
          const found = await context.data.query({
            table: input.table,
            columns: Object.keys(key),
            filter: keyFilter(key),
            limit: 2,
            offset: 0,
          });
          if (found.rows.length !== 1) return denyTenant();
          return { impact: [] as [], deleted: false as const };
        },
        guard,
      );
    },
  });
}
