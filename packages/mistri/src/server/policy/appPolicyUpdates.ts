import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { assertTransitionInsert, assertTransitions, type AppTransitionRules } from '../app/appTransitions.js';
import { stampUpdate, type AppStamps, type StampMoment } from '../app/appStamps.js';
import type { QueryPerson } from '@mistriwork/engine/shared/query.js';
import {
  Refusal,
  TransactionOutcomeUnknown,
  type DeleteRequest,
  type Filter,
  type InsertRequest,
  type UpdateRequest,
  type WriteTransaction,
} from '@mistriwork/engine/adapters/adapter.js';
import { snapshotScopedData } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import { inRecordLane } from '@mistriwork/engine/adapters/writeLanes.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { ScopeRefusal } from '@mistriwork/engine/adapters/scoped/scopedTransaction.js';
import { recordRefusalCause, refusalSaid, sayRefusal } from '@mistriwork/engine/shared/refusal.js';
import type { AppPolicyContext } from './appPolicyContext.js';
import { writeFailureOutcome } from '@mistriwork/engine/server/constraints.js';
import { writeLines, type LineCollection, type LineWriter } from '@mistriwork/engine/server/recordWriteOperations.js';

/**
 * A row-policy App's generic writes: each one scoped transaction of the
 * policy's writer, which takes the row it checks FOR UPDATE, so two writes of
 * one record from anywhere — this process or another pod — are ordered by
 * the database. An App has no Undo, so nothing is journaled.
 */
export function createHttpPolicyUpdates(
  defaultSource: string | undefined,
  writable: (source: string) => boolean,
  deletes: (table: string) => boolean,
  transitions: (schema: DatabaseSchema) => AppTransitionRules | undefined = () => undefined,
  stamps: (schema: DatabaseSchema) => AppStamps | undefined = () => undefined,
  /** Who `me` is in an action's `when`: the stamp's person, as a row where the App says (appMe). */
  person?: (schema: DatabaseSchema, who: string | undefined, reader: WriteTransaction) => Promise<QueryPerson>,
) {
  // Without a default source every name is qualified, so a bare one names no source.
  const sourceFor = (table: string) => (table.includes('.') ? table.split('.')[0] : (defaultSource ?? ''));
  const transact = <R>(context: AppPolicyContext, table: string, work: (tx: WriteTransaction) => Promise<R>): Promise<R> =>
    context.transaction(sourceFor(table), work);
  const assertWritable = (context: AppPolicyContext, table: string) => {
    if (!context.writeFields[table]?.length || !writable(sourceFor(table))) throw new AppAccessDenied();
  };
  /* A table this principal writes, or runs granted fixed actions on: an
     update to the second is one of those actions, which the scoped writer's
     facade judges and stamps (appPolicyContext), or nothing. */
  const granted = (context: AppPolicyContext, table: string) => !context.writeFields[table]?.length && context.actions?.has(table) === true;
  const assertUpdatable = (context: AppPolicyContext, table: string) => {
    if (!(context.writeFields[table]?.length || granted(context, table)) || !writable(sourceFor(table))) throw new AppAccessDenied();
  };
  const canWriteRows = (context: AppPolicyContext, table: string) => {
    const meta = context.schema.tables.find((item) => item.id === table);
    return Boolean(
      meta &&
      !meta.isView &&
      meta.columns.some((column) => column.primaryKey) &&
      context.writeFields[table]?.length &&
      writable(sourceFor(table)),
    );
  };
  // `insertable: false` is the role's own word (`create: false`) or a row its columns cannot form.
  const canInsert = (context: AppPolicyContext, table: string) =>
    canWriteRows(context, table) && context.schema.tables.find((item) => item.id === table)?.insertable !== false;
  const canDelete = (context: AppPolicyContext, table: string) =>
    Boolean(
      context.authorizeDeletedRecord &&
      deletes(table) &&
      canWriteRows(context, table) &&
      context.schema.tables.find((item) => item.id === table)?.deletable === true,
    );
  const exactKey = (context: AppPolicyContext, table: string, value: unknown): Record<string, string | number> => {
    const primary = context.schema.tables
      .find((item) => item.id === table)
      ?.columns.filter((column) => column.primaryKey)
      .map((column) => column.name);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !primary?.length ||
      Object.keys(value).length !== primary.length ||
      primary.some((column) => !Object.hasOwn(value, column)) ||
      Object.values(value).some((item) => typeof item !== 'string' && !(typeof item === 'number' && Number.isFinite(item)))
    )
      throw new AppAccessDenied();
    return value as Record<string, string | number>;
  };
  const keyFilter = (key: Record<string, string | number>): Filter => ({
    groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=', value }))],
  });
  /* A column the database computes is written by nobody, on either engine: said here, by name, before PostgreSQL
     answers "can only be updated to DEFAULT" in words a write cannot tell from a lost connection. */
  const assertNotComputed = (context: AppPolicyContext, request: InsertRequest | UpdateRequest) => {
    const generated = context.computedFields?.[request.table] ?? [];
    const computed = Object.keys(request.values ?? {}).filter((name) => generated.includes(name));
    if (computed.length) {
      const said = `${computed.map((name) => `"${name}"`).join(', ')} ${computed.length === 1 ? 'is' : 'are'} generated by the database and cannot be written.`;
      throw sayRefusal(new Refusal(said), said);
    }
  };
  /* One row created, as this facade creates any: its declared starting state set. */
  const insertOne = (context: AppPolicyContext, tx: WriteTransaction, request: InsertRequest) => {
    assertNotComputed(context, request);
    const initial = assertTransitionInsert(transitions(context.schema), request, context.schema);
    return tx.insert(initial ? { ...request, values: { ...request.values, ...initial } } : request);
  };
  /* One row changed, judged on the row it replaces: a declared column moves only through an action. */
  const updateOne = async (context: AppPolicyContext, tx: WriteTransaction, request: UpdateRequest, moment: () => StampMoment) => {
    assertNotComputed(context, request);
    /* The row the transition is judged on. The lane orders this against
     every other save of the record in this process; the scoped writer
     then takes the row FOR UPDATE to write it. A form's `expected`
     values refuse a row another pod moved in between (WriteConflict). */
    const before = await tx.query({ table: request.table, limit: 2, offset: 0, filter: keyFilter(request.key) });
    if (before.rows.length !== 1) throw new AppAccessDenied();
    const since = await assertTransitions(
      tx,
      context.schema,
      transitions(context.schema),
      request,
      before.rows[0],
      undefined,
      person && (() => person(context.schema, moment().who, tx)),
    );
    // Judged on the words an action sets, then written as what they mean now (appStamps).
    // A granted action goes to the writer as its words, the move's own stamps too left out: its facade judges it on
    // them, then resolves the stamps (a grant that counted the server's stamp as a column the caller wrote refused it).
    if (granted(context, request.table)) return tx.update(request);
    const moved = since ? { ...request, values: { ...request.values, ...since } } : request;
    const said = moment();
    const people = person && (() => person(context.schema, said.who, tx).then((found) => found.person?.key ?? null));
    return tx.update(await stampUpdate(stamps(context.schema), moved, { ...said, ...(people ? { person: people } : {}) }));
  };
  /* One row removed, as the delete route removes one: the deletion policy asked of the row before and after. */
  const removeOne = async (context: AppPolicyContext, tx: WriteTransaction, table: string, key: Record<string, string | number>) => {
    const result = await tx.query({ table, filter: keyFilter(key), limit: 2, offset: 0 });
    if (result.rows.length !== 1) throw new AppAccessDenied();
    const row = { ...result.rows[0] } as Record<string, string | number | null>;
    const meta = context.schema.tables.find((item) => item.id === table)!;
    const actualKey = exactKey(
      context,
      table,
      Object.fromEntries(meta.columns.filter((column) => column.primaryKey).map((column) => [column.name, row[column.name]])),
    );
    const record = { table, key: actualKey, row };
    if (!(await context.authorizeDeletedRecord!(record))) throw new AppAccessDenied();
    await tx.remove({ table, key: actualKey });
    if (!(await context.authorizeDeletedRecord!(record))) throw new AppAccessDenied();
  };
  /* A record's lines, each row held to what the same row would be held to alone here (formLinesWrite.ts). */
  const lineWriter = (context: AppPolicyContext, tx: WriteTransaction, moment: () => StampMoment): LineWriter => ({
    query: (request) => tx.query(request),
    ...(tx.lockRecord ? { lockRecord: (request: DeleteRequest) => tx.lockRecord!(request) } : {}),
    insert: (request) => {
      if (!canInsert(context, request.table)) throw new AppAccessDenied();
      return insertOne(context, tx, request);
    },
    update: (request) => {
      assertWritable(context, request.table);
      return updateOne(context, tx, request, moment);
    },
    remove: (request) => {
      if (!canDelete(context, request.table)) throw new AppAccessDenied();
      return removeOne(context, tx, request.table, request.key);
    },
  });
  const operations = {
    canInsert,
    canDelete,
    async remove(context: AppPolicyContext, raw: Record<string, unknown>, signal: AbortSignal) {
      const body = snapshotScopedData(raw);
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !['app', 'table', 'key', 'confirm'].includes(key)) ||
        typeof body.table !== 'string' ||
        !canDelete(context, body.table) ||
        (body.confirm !== undefined && typeof body.confirm !== 'boolean')
      )
        throw new AppAccessDenied();
      const table = body.table;
      const key = exactKey(context, table, body.key);
      try {
        await inRecordLane(table, key, () =>
          transact(context, table, async (tx) => {
            assertWritable(context, table);
            if (signal.aborted) throw new AppAccessDenied();
            const result = await tx.query({ table, filter: keyFilter(key), limit: 2, offset: 0 });
            if (result.rows.length !== 1) throw new AppAccessDenied();
            const row = { ...result.rows[0] } as Record<string, string | number | null>;
            const meta = context.schema.tables.find((item) => item.id === table)!;
            const actualKey = exactKey(
              context,
              table,
              Object.fromEntries(meta.columns.filter((column) => column.primaryKey).map((column) => [column.name, row[column.name]])),
            );
            const record = { table, key: actualKey, row };
            if (!(await context.authorizeDeletedRecord!(record))) throw new AppAccessDenied();
            if (body.confirm === true) await tx.remove({ table, key: actualKey });
            if (!(await context.authorizeDeletedRecord!(record))) throw new AppAccessDenied();
            assertWritable(context, table);
            if (signal.aborted) throw new AppAccessDenied();
          }),
        );
        if (body.confirm !== true) return { impact: [], deleted: false as const };
        return { impact: [], deleted: true as const, affected: 1 };
      } catch (error) {
        if (!(error instanceof TransactionOutcomeUnknown) && writeFailureOutcome(error) === 'rejected') {
          throw recordRefusalCause(
            sayRefusal(
              new Refusal('Deletion was rejected under the current record constraints.'),
              'Deletion was rejected under the current record constraints.',
            ),
            error,
          );
        }
        throw error;
      }
    },
    /** `lines` are the record's, judged already (formLinesWrite.ts), and inserted with it in its transaction. */
    async insert(
      context: AppPolicyContext,
      raw: Record<string, unknown>,
      signal: AbortSignal,
      lines?: readonly LineCollection[],
      moment: () => StampMoment = () => ({ now: new Date() }),
    ) {
      const body = snapshotScopedData(raw);
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !['app', 'table', 'values'].includes(key)) ||
        typeof body.table !== 'string' ||
        !canInsert(context, body.table)
      )
        throw new AppAccessDenied();
      if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
        throw new Refusal('Insert values must be an object. Use {} explicitly for database defaults.');
      }
      const table = body.table;
      const request = { table, values: body.values } as InsertRequest;
      try {
        return await transact(context, table, async (tx) => {
          assertWritable(context, table);
          if (signal.aborted) throw new AppAccessDenied();
          // The scoped writer checks the actual defaulted/coerced stored row
          // and all FK parents before returning this field-projected result.
          const result = await insertOne(context, tx, request);
          if (lines?.length) await writeLines(lineWriter(context, tx, moment), lines, { ...result.row, ...result.key });
          assertWritable(context, table);
          if (signal.aborted) throw new AppAccessDenied();
          return { key: result.key, row: { ...result.row }, applied: result.applied };
        });
      } catch (error) {
        // A raw recognized constraint reaches here only after confirmed
        // rollback. Failed rollback/COMMIT instead carries explicit uncertainty;
        // never inspect that wrapper's cause to infer safe rejection.
        if (!(error instanceof TransactionOutcomeUnknown) && writeFailureOutcome(error) === 'rejected') {
          throw recordRefusalCause(
            sayRefusal(
              new Refusal('Creation was rejected under the current record constraints.'),
              'Creation was rejected under the current record constraints.',
            ),
            error,
          );
        }
        throw error;
      }
    },
    /** One row of an import, tried in the scoped writer and always rolled back:
     * what the policy refuses, it refuses here, and nothing is written. */
    async importTrial(context: AppPolicyContext, raw: InsertRequest, signal: AbortSignal): Promise<void> {
      const request = snapshotScopedData(raw);
      if (typeof request.table !== 'string' || !canInsert(context, request.table)) throw new AppAccessDenied();
      await context.trial(sourceFor(request.table), async (tx) => {
        assertWritable(context, request.table);
        if (signal.aborted) throw new AppAccessDenied();
        const initial = assertTransitionInsert(transitions(context.schema), request, context.schema);
        await tx.insert(initial ? { ...request, values: { ...request.values, ...initial } } : request);
      });
    },
    /** An import's rows in one scoped transaction. */
    async importCommit(context: AppPolicyContext, raws: readonly InsertRequest[], signal: AbortSignal) {
      const requests = raws.map((raw) => snapshotScopedData(raw));
      const table = requests[0]?.table;
      if (typeof table !== 'string' || requests.some((request) => request.table !== table) || !canInsert(context, table))
        throw new AppAccessDenied();
      try {
        const keys = await transact(context, table, async (tx) => {
          const written: Array<Record<string, unknown>> = [];
          for (const request of requests) {
            assertWritable(context, table);
            if (signal.aborted) throw new AppAccessDenied();
            const initial = assertTransitionInsert(transitions(context.schema), request, context.schema);
            written.push({ ...(await tx.insert(initial ? { ...request, values: { ...request.values, ...initial } } : request)).key });
          }
          return written;
        });
        return { keys };
      } catch (error) {
        if (!(error instanceof TransactionOutcomeUnknown) && writeFailureOutcome(error) === 'rejected') {
          throw recordRefusalCause(
            sayRefusal(
              new Refusal('Creation was rejected under the current record constraints.'),
              'Creation was rejected under the current record constraints.',
            ),
            error,
          );
        }
        throw error;
      }
    },
    /** `moment` is the request's clock and verified person, for an action's stamps; absent, 'me' is nobody. */
    async update(
      context: AppPolicyContext,
      raw: Record<string, unknown>,
      signal: AbortSignal,
      moment: () => StampMoment = () => ({ now: new Date() }),
    ) {
      const body = snapshotScopedData(raw);
      if (
        Object.keys(body).some((key) => !['app', 'table', 'key', 'values', 'column', 'value', 'expected'].includes(key)) ||
        typeof body.table !== 'string'
      )
        throw new AppAccessDenied();
      const table = body.table;
      assertUpdatable(context, table);
      const key = body.key;
      const primary = context.schema.tables
        .find((item) => item.id === table)
        ?.columns.filter((column) => column.primaryKey)
        .map((column) => column.name);
      if (
        !key ||
        typeof key !== 'object' ||
        Array.isArray(key) ||
        !primary?.length ||
        Object.keys(key).length !== primary.length ||
        primary.some((column) => !Object.hasOwn(key, column)) ||
        Object.values(key).some((value) => typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))
      ) {
        throw new AppAccessDenied();
      }
      const values = body.values ?? (typeof body.column === 'string' ? { [body.column]: body.value ?? null } : {});
      const request = {
        table,
        key: body.key,
        values,
        ...(body.expected === undefined ? {} : { expected: body.expected }),
      } as UpdateRequest;
      const result = await inRecordLane(table, request.key, () =>
        transact(context, table, async (tx) => {
          assertUpdatable(context, table);
          if (signal.aborted) throw new AppAccessDenied();
          // The adapter validates the exact key, values and expected fields.
          if (!request.key || typeof request.key !== 'object' || Array.isArray(request.key)) throw new AppAccessDenied();
          const updated = await updateOne(context, tx, request, moment);
          assertUpdatable(context, table);
          if (signal.aborted) throw new AppAccessDenied();
          return updated;
        }),
      );
      return { affected: result.affected, applied: result.applied };
    },
  };
  /* Which rule refused, said to the caller in words that name only what the request named (shared/refusal.ts
     sayRefusal): the connection, the role's grant of the table or of a column, or the row policy. A refusal that
     already says its own (a computed column, a constraint) keeps it. The reason beneath, with its rows and
     physical names, stays recorded for the operator. */
  const explain = (context: AppPolicyContext, raw: unknown, verb: 'create' | 'change' | 'delete', error: unknown): unknown => {
    if (!(error instanceof Refusal) || error instanceof TransactionOutcomeUnknown || refusalSaid(error)) return error;
    const body = (raw && typeof raw === 'object' ? raw : {}) as { table?: unknown; values?: unknown; column?: unknown };
    const table = typeof body.table === 'string' ? body.table : undefined;
    const meta = table === undefined ? undefined : context.schema.tables.find((item) => item.id === table);
    if (!(error instanceof AppAccessDenied) && !(error instanceof ScopeRefusal)) return error;
    if (!table || !meta) return sayRefusal(error, 'This App has no such table for this account to write.');
    const thing = `"${table}"`;
    if (!writable(sourceFor(table))) return sayRefusal(error, `${thing} is read-only on this server: its connection is not writable.`);
    const fields = context.writeFields[table] ?? [];
    if (!fields.length && !(verb === 'change' && granted(context, table)))
      return sayRefusal(error, `This account's role does not write ${thing}.`);
    if (verb === 'create' && meta.insertable === false) return sayRefusal(error, `This account's role does not create ${thing} records.`);
    if (verb === 'delete' && !canDelete(context, table))
      return sayRefusal(error, `${thing} records are not deleted here: the role or the row policy does not allow it.`);
    const values =
      body.values && typeof body.values === 'object' ? Object.keys(body.values) : typeof body.column === 'string' ? [body.column] : [];
    const ungranted = values.filter((name) => !fields.includes(name));
    if (ungranted.length && !granted(context, table))
      return sayRefusal(error, `This account's role does not write ${ungranted.map((name) => `"${name}"`).join(', ')} of ${thing}.`);
    /* A role that runs this table's actions without writing it: the change was not one of them as the row stands,
       or the row is not this account's. One sentence for both, so the answer does not say which rows exist. */
    if (verb === 'change' && granted(context, table))
      return sayRefusal(
        error,
        `This change is not one of the actions this account may run on this ${thing} record now, or the App's row policy does not let this account change it.`,
      );
    return sayRefusal(
      error,
      verb === 'create'
        ? `The App's row policy does not let this account create this ${thing} record, or point it at a record it cannot read.`
        : `The App's row policy does not let this account ${verb} this ${thing} record.`,
    );
  };
  return Object.freeze({
    ...operations,
    insert: (context: AppPolicyContext, raw: Record<string, unknown>, ...rest: OmitFirstTwo<typeof operations.insert>) =>
      operations.insert(context, raw, ...rest).catch((error: unknown) => {
        throw explain(context, raw, 'create', error);
      }),
    update: (context: AppPolicyContext, raw: Record<string, unknown>, ...rest: OmitFirstTwo<typeof operations.update>) =>
      operations.update(context, raw, ...rest).catch((error: unknown) => {
        throw explain(context, raw, 'change', error);
      }),
    remove: (context: AppPolicyContext, raw: Record<string, unknown>, ...rest: OmitFirstTwo<typeof operations.remove>) =>
      operations.remove(context, raw, ...rest).catch((error: unknown) => {
        throw explain(context, raw, 'delete', error);
      }),
  });
}

type OmitFirstTwo<F> = F extends (a: never, b: never, ...rest: infer R) => unknown ? R : never;
