import {
  TransactionOutcomeUnknown,
  type DeleteRequest,
  type Filter,
  type InsertRequest,
  type UpdateRequest,
  type UpdateResult,
} from '@mistriwork/engine/adapters/adapter.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantOptions, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { createTenantHistoryPartitions, TenantHistoryBusy, type TenantHistoryLease } from './tenantHistoryPartitions.js';
import { journalFieldsMatch, latestRevertible, summarise, type JournalEntry, type WriteStep } from '@mistriwork/engine/server/journal.js';
import { runRecordedTransaction, type HistoryDraft, type PreparedWrite } from '@mistriwork/engine/server/recordHistoryOperations.js';
import type { TenantReadSource } from './tenantReadSource.js';
import { TenantWriteFailure, type TenantWriteSource } from './tenantWriteSource.js';
import { tenantWriteFailed } from './tenantWriteKindContract.js';
import {
  bindTenantWriteRuntime,
  tenantInverseImages,
  type TenantWriteContext,
  type TenantWriteRuntimeOptions,
} from './tenantWriteRuntime.js';
import type { TenantDeletedRecordPolicy, TenantHistoryImage } from './tenantInverseImages.js';
import { bindTenantRequestRuntime, captureTenantRequestRuntime, type TenantRequestRuntime } from './tenantRequestRuntime.js';
import { tenantRetirement } from './tenantRetirement.js';
import type { TenantInvocationGuard } from './tenantInvocation.js';
import { writeLines, type LineCollection, type LineWriter } from '@mistriwork/engine/server/recordWriteOperations.js';

/** A new record's lines (formLinesWrite.ts), judged by the route on the lease's own catalog. */
type WithLines<T> = T & { lines?: readonly LineCollection[] };

type Kind = 'update' | 'insert' | 'delete';

const failed = (error: unknown, committed = false): TenantWriteFailure => {
  const outcome =
    committed || error instanceof TransactionOutcomeUnknown || (error instanceof TenantWriteFailure && error.outcome === 'unknown')
      ? 'unknown'
      : 'not_applied';
  /* A record the App's rules refused, before anything was applied: the person's to fix, so its fields are said. The
     error is kept as its cause, for the owner: a database that did not answer is told apart from a refusal by it. */
  return tenantWriteFailed(outcome, error);
};
const keyFilter = (key: Record<string, string | number>): Filter => ({
  groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=', value }))],
});
function keyFor(context: TenantWriteContext, table: string, value: unknown): Record<string, string | number> {
  tenantRecord(value);
  const primary = context.schema.tables.find((item) => item.id === table)?.columns.filter((column) => column.primaryKey) ?? [];
  if (
    !primary.length ||
    Object.keys(value).length !== primary.length ||
    primary.some((column) => !Object.hasOwn(value, column.name)) ||
    Object.values(value).some((item) => typeof item !== 'string' && !(typeof item === 'number' && Number.isFinite(item)))
  )
    return denyTenant();
  return value as Record<string, string | number>;
}
function requestUpdate(value: UpdateRequest): UpdateRequest {
  const input = captureTenantData(value);
  tenantRecord(input, ['table', 'key', 'values', 'expected']);
  tenantRecord(input.key);
  tenantRecord(input.values);
  if (typeof input.table !== 'string' || !Object.keys(input.values).length) return denyTenant();
  return input;
}
/** A record's lines written in the lease's own transaction: each row as this member could write it alone —
 * stamped with the tenant, held to the grants, and removed only as a Delete removes a row. */
const lineWriter = (context: TenantWriteContext): LineWriter => ({
  query: (request) => context.data.query(request),
  insert: (request) => context.data.insert(request),
  update: (request) => context.data.update(request),
  remove: (request) => tenantInverseImages(context).removeCurrent(request),
});
/* Captured evidence is frozen; the writer notes what it wrote on its own copy. */
const writable = (lines: readonly LineCollection[]) => lines.map((line) => ({ ...line }));
const label = (kind: Kind) => (kind === 'insert' ? 'Creation' : kind === 'delete' ? 'Deletion' : 'Update');
const unavailable = (kind: Kind = 'update'): HistoryDraft => ({
  kind,
  summary: `${label(kind)} has no safe Undo.`,
  reason: 'A lossless, authorized inverse is not available for this change.',
  revertible: false,
  blocksUndo: true,
  steps: [],
});
const uncertainty = (kind: Kind): HistoryDraft & { revertible: false; undoState: 'unknown' } => ({
  kind,
  summary: `${label(kind)} outcome or history unconfirmed.`,
  reason: 'Refresh and reconcile before further editing.',
  revertible: false,
  undoState: 'unknown',
  steps: [],
});

/** Every value-bearing history entry must still have a visible row and readable,
 * writable inverse fields. An unavailable newer entry is a barrier, never a
 * reason to search another tenant, membership version or an older hidden entry. */
async function visibleEntries(context: TenantWriteContext, lease: TenantHistoryLease): Promise<JournalEntry[]> {
  const visible: JournalEntry[] = [];
  for (const entry of lease.history()) {
    if (
      !['update', 'insert', 'delete'].includes(entry.kind) ||
      entry.app !== context.principal.appId ||
      entry.principal !== context.principal.accountId
    )
      break;
    if (!entry.steps.length && !entry.revertible && (entry.blocksUndo || entry.undoState === 'unknown')) {
      visible.push(entry);
      break;
    }
    if (entry.steps.length !== 1) break;
    const step = entry.steps[0],
      table = context.schema.tables.find((item) => item.id === step.table);
    if (entry.kind !== 'update') {
      const row = entry.kind === 'insert' ? step.after : step.before;
      if (!table || !step.wholeRow || !step.key || !row) break;
      const image = { table: step.table, key: step.key, row } as TenantHistoryImage;
      if (!(await tenantInverseImages(context).visible(image, entry.kind === 'delete'))) break;
      visible.push(entry);
      if (entry.undoState || entry.blocksUndo || !entry.revertible) break;
      continue;
    }
    if (!table || !step.exactFields || !step.before || !step.after || !step.key) break;
    const fields = new Map(table.columns.map((column) => [column.name, column]));
    if (
      [...Object.keys(step.before), ...Object.keys(step.after)].some((column) => !fields.get(column)?.writable) ||
      Object.keys(step.before).length !== Object.keys(step.after).length ||
      Object.keys(step.before).some((column) => !Object.hasOwn(step.after!, column))
    )
      break;
    // History was privately captured, but current primary-key/field metadata is
    // authoritative; an incompatible deployment cannot reinterpret old keys.
    const primary = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
    if (!primary.length || Object.keys(step.key).length !== primary.length || primary.some((column) => !Object.hasOwn(step.key!, column)))
      break;
    const key = keyFor(context, step.table, step.key);
    const current = await context.data.query({ table: step.table, columns: primary, filter: keyFilter(key), limit: 2, offset: 0 });
    if (current.rows.length !== 1 || Object.entries(key).some(([column, value]) => current.rows[0][column] !== value)) break;
    visible.push(entry);
    if (entry.undoState || entry.blocksUndo || !entry.revertible) break;
  }
  return visible;
}
// Global journal sequence IDs are private implementation details. Tokens are
// scoped to this exact partition; another tenant's expectedId cannot alias ours.
const summary = (entry: JournalEntry, lease: TenantHistoryLease) => ({
  id: lease.token(entry.id),
  kind: entry.kind,
  at: entry.at,
  summary: entry.summary,
});

/** Dedicated private history owner. It accepts requests/selectors, never supplied
 * principals or history images. Create/delete inverses require additional
 * server policy; no command receipt, public route or browser binding. */
export function createTenantRecordHistory<Request>(options: TenantWriteRuntimeOptions<Request>) {
  try {
    return createHistory(options);
  } catch {
    throw new TenantWriteFailure('not_applied');
  }
}
function createHistory<Request>(options: TenantWriteRuntimeOptions<Request>) {
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
  const requests = bindTenantRequestRuntime(raw as unknown as TenantWriteRuntimeOptions<Request>);
  const history = bindTenantRecordHistory(requests, raw.authorizeDeletedRecord as TenantDeletedRecordPolicy | undefined);
  return Object.freeze({
    ...history,
    retire: tenantRetirement(
      [history.retire, requests.retire],
      [(raw.reader as TenantReadSource).close, (raw.writer as TenantWriteSource).close],
    ),
  });
}

/** Internal history publication owner. It drains and disposes its partitions,
 * but never retires a sibling request family or closes shared sources. */
export function bindTenantRecordHistory<Request>(input: TenantRequestRuntime<Request>, deletedPolicy?: TenantDeletedRecordPolicy) {
  const requests = captureTenantRequestRuntime(input);
  const partitions = createTenantHistoryPartitions(requests.identity, requests.deployment);
  const runtime = bindTenantWriteRuntime(requests, deletedPolicy);
  let closed = false,
    retirement: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  const owned = async <T>(run: () => Promise<T>): Promise<T> => {
    if (closed) throw new TenantWriteFailure('not_applied');
    let complete!: () => void;
    const held = new Promise<void>((resolve) => {
      complete = resolve;
    });
    pending.add(held);
    try {
      return await run();
    } catch (error) {
      throw failed(error);
    } finally {
      pending.delete(held);
      complete();
    }
  };
  const mutate = <A, R>(
    request: Request,
    selectors: readonly string[],
    input: A,
    kind: Kind,
    work: (context: TenantWriteContext, captured: A) => Promise<PreparedWrite<R>>,
    guard?: TenantInvocationGuard,
  ): Promise<{ result: R; undoId?: string }> =>
    owned(async () => {
      const captured = captureTenantData(input);
      let lease: TenantHistoryLease | undefined,
        completed = false;
      try {
        const result = await runRecordedTransaction<TenantWriteContext, R>({
          mode: 'write',
          transaction: (work) =>
            runtime.transaction(
              request,
              selectors,
              (context) => {
                if (!lease) return denyTenant();
                return work(context);
              },
              guard,
              undefined,
              /* The person's history partition, waited for before the transaction begins: two saves of theirs sent
                 together run one after the other, as the partition requires, instead of the second being refused. */
              async (principal) => {
                lease?.release();
                lease = undefined;
                lease = await partitions.acquire(principal);
              },
            ),
          work: (context) => work(context, captured),
          history: {
            publish: (entry) => {
              if (!lease || (closed && entry.undoState !== 'unknown')) return denyTenant();
              return lease.publish(entry);
            },
            quarantine: () => lease?.quarantine(),
          },
          uncertainty: uncertainty(kind),
          isRejection: (error) => error instanceof TenantWriteFailure && error.outcome === 'not_applied',
        });
        completed = true;
        if (closed) {
          lease?.quarantine();
          throw new TenantWriteFailure('unknown');
        }
        return captureTenantData({
          result: result.result,
          ...(result.undoId === undefined ? {} : { undoId: lease!.token(result.undoId) }),
        });
      } catch (error) {
        if (completed) lease?.quarantine();
        throw failed(error, completed);
      } finally {
        lease?.release();
      }
    });
  return Object.freeze({
    retire(): Promise<void> {
      if (retirement) return retirement;
      closed = true;
      retirement = (async () => {
        // Publication and inverse-state settlement outlive the runtime's source
        // callback. Drain the service as well before clearing only its journals.
        await Promise.allSettled([...pending]);
        partitions.dispose();
      })();
      void retirement.catch(() => {});
      return retirement;
    },
    update(
      request: Request,
      selectors: readonly string[],
      value: UpdateRequest,
      guard?: TenantInvocationGuard,
    ): Promise<{ result: UpdateResult; undoId?: string }> {
      return mutate(
        request,
        selectors,
        value,
        'update',
        async (context, captured) => {
          const input = requestUpdate(captured);
          const key = keyFor(context, input.table, input.key),
            touched = Object.keys(input.values);
          const columns = [...new Set([...Object.keys(key), ...touched])];
          const beforeRow = await context.data.query({ table: input.table, columns, filter: keyFilter(key), limit: 2, offset: 0 });
          if (beforeRow.rows.length !== 1) return denyTenant();
          const original = beforeRow.rows[0];
          const actualKey = keyFor(context, input.table, Object.fromEntries(Object.keys(key).map((column) => [column, original[column]])));
          const before = Object.fromEntries(touched.map((column) => [column, original[column]]));
          const losslessBefore = await journalFieldsMatch(context.data, input.table, actualKey, before);
          // Keep caller ownership evidence intact until the managed writer
          // validates it. SQL-equivalent case/padding aliases must not gain
          // permission merely because preflight found a canonical row.
          const result = await context.data.update(input);
          const afterRow = await context.data.query({
            table: input.table,
            columns: touched,
            filter: keyFilter(actualKey),
            limit: 2,
            offset: 0,
          });
          const after = afterRow.rows.length === 1 ? afterRow.rows[0] : undefined;
          if (
            !losslessBefore ||
            result.affected !== 1 ||
            !after ||
            !(await journalFieldsMatch(context.data, input.table, actualKey, after))
          )
            return { result, entry: unavailable() };
          const steps: WriteStep[] = [{ table: input.table, key: actualKey, before, after, exactFields: true }];
          return { result, entry: { kind: 'update', summary: summarise('update', steps), revertible: true, steps } };
        },
        guard,
      );
    },
    insert(request: Request, selectors: readonly string[], value: WithLines<InsertRequest>, guard?: TenantInvocationGuard) {
      return mutate(
        request,
        selectors,
        value,
        'insert',
        async (context, captured) => {
          tenantRecord(captured, ['table', 'values', 'lines']);
          const { lines, ...input } = captured;
          tenantRecord(input.values);
          const result = await context.data.insert(input);
          if (lines !== undefined) {
            await writeLines(lineWriter(context), writable(lines), { ...result.row, ...result.key });
            return { result, entry: unavailable('insert') };
          }
          const image = await tenantInverseImages(context).capture({ table: input.table, key: result.key });
          if (!image) return { result, entry: unavailable('insert') };
          const steps: WriteStep[] = [{ table: image.table, key: image.key, after: image.row, wholeRow: true }];
          return { result, entry: { kind: 'insert', summary: summarise('insert', steps), revertible: true, steps } };
        },
        guard,
      );
    },
    remove(request: Request, selectors: readonly string[], value: DeleteRequest, guard?: TenantInvocationGuard) {
      return mutate(
        request,
        selectors,
        value,
        'delete',
        async (context, input) => {
          tenantRecord(input, ['table', 'key']);
          tenantRecord(input.key);
          const image = await tenantInverseImages(context).removeCurrent(input);
          const steps: WriteStep[] = [{ table: image.table, key: image.key, before: image.row, wholeRow: true }];
          return { result: { affected: 1 }, entry: { kind: 'delete', summary: summarise('delete', steps), revertible: true, steps } };
        },
        guard,
      );
    },
    /**
     * A CSV import's rows (app/appImport.ts), in the member's own context: its
     * ownership injected and its scope and field grants applied to every row,
     * as for one insert. `trial` tries one row and rolls it back; otherwise
     * every row lands in one transaction or none does. No Undo is published:
     * an import is undone row by row, as its records.
     */
    importRows(
      request: Request,
      selectors: readonly string[],
      value: { inserts: InsertRequest[]; trial: boolean },
      guard?: TenantInvocationGuard,
    ) {
      return owned(async () => {
        const input = captureTenantData(value);
        tenantRecord(input, ['inserts', 'trial']);
        if (
          !Array.isArray(input.inserts) ||
          !input.inserts.length ||
          typeof input.trial !== 'boolean' ||
          (input.trial && input.inserts.length !== 1)
        )
          return denyTenant();
        for (const insert of input.inserts) {
          tenantRecord(insert, ['table', 'values']);
          tenantRecord(insert.values);
        }
        let tried = false;
        try {
          return await runtime.transaction(
            request,
            selectors,
            async (context) => {
              for (const insert of input.inserts) await context.data.insert(insert);
              // A trial's row was accepted: it goes back, and the answer is that it would land.
              if (input.trial) {
                tried = true;
                throw new TenantWriteFailure('not_applied');
              }
              return { applied: input.inserts.length };
            },
            guard,
            'write',
          );
        } catch (error) {
          if (tried) return { applied: 0 };
          throw error;
        }
      });
    },
    previewRemove(request: Request, selectors: readonly string[], value: DeleteRequest, guard?: TenantInvocationGuard) {
      return owned(async () => {
        const input = captureTenantData(value);
        tenantRecord(input, ['table', 'key']);
        tenantRecord(input.key);
        return runtime.transaction(
          request,
          selectors,
          async (context) => {
            // The same inverse eligibility/full-image policy as confirmed Delete,
            // without removing a row or publishing an Undo entry.
            if (!(await tenantInverseImages(context).capture(input))) return denyTenant();
            return { impact: [] as [], deleted: false as const };
          },
          guard,
        );
      });
    },
    preview(request: Request, selectors: readonly string[], input: { limit?: number } = {}, guard?: TenantInvocationGuard) {
      return owned(async () => {
        const body = captureTenantData(input);
        tenantRecord(body, ['limit']);
        const limit = body.limit ?? 10;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) return denyTenant();
        let lease: TenantHistoryLease | undefined;
        try {
          const result = await runtime.transaction(
            request,
            selectors,
            async (context) => {
              if (!lease) return denyTenant();
              const entries = await visibleEntries(context, lease),
                next = latestRevertible(entries);
              return {
                writes: entries.slice(0, limit).map((entry) => ({
                  ...summary(entry, lease!),
                  revertible: entry.revertible,
                  ...(entry.reason ? { reason: entry.reason } : {}),
                  ...(entry.undoState ? { undoState: entry.undoState } : {}),
                  ...(entry.blocksUndo ? { blocksUndo: true } : {}),
                })),
                ...(next ? { next: summary(next, lease!) } : {}),
              };
            },
            guard,
            undefined,
            async (principal) => {
              lease?.release();
              lease = undefined;
              lease = await partitions.acquire(principal);
            },
          );
          if (closed) return denyTenant();
          return result;
        } finally {
          lease?.release();
        }
      });
    },
    undo(request: Request, selectors: readonly string[], input: { expectedId: string }, guard?: TenantInvocationGuard) {
      return owned(async () => {
        const body = captureTenantData(input);
        tenantRecord(body, ['expectedId']);
        tenantIdentifier(body.expectedId, 128);
        let lease: TenantHistoryLease | undefined,
          attempted: number | undefined,
          committed = false,
          busy = false;
        try {
          const result = await runtime.transaction(
            request,
            selectors,
            async (context) => {
              try {
                lease = partitions.enter(context.principal);
              } catch (error) {
                busy = error instanceof TenantHistoryBusy;
                throw error;
              }
              const expected = lease.resolve(body.expectedId);
              if (expected === undefined) return denyTenant();
              const entries = await visibleEntries(context, lease);
              if (entries.some((entry) => entry.id === expected && entry.undoState)) {
                busy = true;
                return denyTenant();
              }
              const next = latestRevertible(entries);
              if (!next || next.id !== expected) return denyTenant();
              lease.beginUndo(next.id);
              attempted = next.id;
              const step = next.steps[0];
              if (next.kind === 'update') {
                const key = keyFor(context, step.table, step.key);
                if (!(await journalFieldsMatch(context.data, step.table, key, step.after))) return denyTenant();
                const updated = await context.data.update({
                  table: step.table,
                  key,
                  values: step.before as UpdateRequest['values'],
                  expected: step.after as UpdateRequest['values'],
                });
                if (updated.affected !== 1 || !(await journalFieldsMatch(context.data, step.table, key, step.before))) return denyTenant();
              } else {
                const images = tenantInverseImages(context);
                const image = {
                  table: step.table,
                  key: step.key,
                  row: next.kind === 'insert' ? step.after : step.before,
                } as TenantHistoryImage;
                if (next.kind === 'insert') await images.removeCreated(image);
                else if (next.kind === 'delete') await images.restoreDeleted(image);
                else return denyTenant();
              }
              return { reverted: true as const, outcome: 'applied' as const, undone: summary(next, lease) };
              // 'undo' is stated here because this is the method that undoes: a
              // recording writer kind labels its entries from what ran, never
              // from anything the request carried.
            },
            guard,
            'undo',
          );
          committed = true;
          if (closed) throw new TenantWriteFailure('unknown');
          // Unlike calling generic revert inside the owned callback, this cannot
          // forget the canonical entry before the actual database COMMIT settles.
          lease!.finishUndo(attempted!);
          return result;
        } catch (error) {
          const failure = failed(error, committed || busy);
          if (attempted !== undefined) {
            try {
              lease!.failUndo(attempted, failure.outcome === 'unknown');
            } catch {
              lease?.quarantine();
            }
          }
          throw failure;
        } finally {
          lease?.release();
        }
      });
    },
  });
}
