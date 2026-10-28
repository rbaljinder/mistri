/**
 * A record's row, read once in full through the row scope by its key, and
 * every later read of that record by the same key, in the same transaction
 * and under the same scope, answered from it: the columns it asks for, in its
 * order, from the row already read.
 *
 * A command reads its target by key several times before it writes — whether
 * it is visible, its revision, the columns its machine moves, the before image
 * its audit keeps, the guard the write checks — each a round trip of its own,
 * each the same row. Read under the row lock the transaction takes first
 * (postgres.ts sends both ahead, behind its BEGIN), the row cannot move
 * underneath it, and a row scope's visibility is decided by the row's own
 * columns (shared/rowScope.ts), so the projection is what each read would
 * have answered.
 *
 * Only while the transaction has sent nothing that could change it: a row is
 * kept with the transaction's statement generation (postgresTransactionHandle
 * generationOf), which moves with every statement that is not a read or a
 * lock — its own write, a savepoint, a rollback, a failure — and a row kept
 * under an older generation answers nothing. Only reads that name the
 * table's primary key by equality, from the first row, with no order, are
 * answered; anything else is asked in its turn. A read that also names other
 * columns by equality (a guard: the record, and only in the state it moves
 * from) is answered only where the kept row holds exactly the value asked,
 * identical in type and content: identical values are equal under any
 * collation or type the server compares them by, so that answer is the
 * server's. Where they differ (a numeric's text, a citext's case, a bytea),
 * the read is asked in its turn rather than answered with no row.
 */
import { clampLimit, type Filter, type QueryRequest, type QueryResult, type ScopedReads, type SqlFragment } from '../adapter.js';
import type { DatabaseSchema, TableMeta } from '../../shared/schema.js';
import type { RowScope } from '../../shared/rowScope.js';

type Row = Record<string, unknown>;
type Reads = Pick<ScopedReads, 'query'> & Partial<ScopedReads>;

interface Kept {
  readonly generation: number;
  readonly rows: Promise<readonly Row[] | undefined>;
  /** Told each read it answers (postgresTransactionHandle holdAhead). */
  readonly take?: () => void;
}

export class KeyRows {
  readonly #entries = new Map<string, Kept>();
  readonly #scopes = new WeakMap<object, number>();
  #next = 0;

  constructor(
    /** The transaction's statement generation now; undefined where it has none (nothing is kept). */
    private readonly generation: () => number | undefined,
  ) {}

  /** Keep nothing more and answer nothing from what was kept (the catalog the rows were read under is not the transaction's). */
  forget(): void {
    this.#entries.clear();
  }

  #scope(scope: RowScope): number {
    let id = this.#scopes.get(scope);
    if (id === undefined) this.#scopes.set(scope, (id = this.#next++));
    return id;
  }

  /** The key a read of `table` by `filter` is kept under: undefined unless the filter is exactly the primary key by equality. */
  #keyOf(scope: RowScope, table: TableMeta, filter: Filter | undefined): string | undefined {
    const found = this.#guarded(scope, table, filter);
    return found && !found.also.length ? found.key : undefined;
  }

  /** The key of a read by the primary key by equality, and the other columns it names by equality (`also`). */
  #guarded(
    scope: RowScope,
    table: TableMeta,
    filter: Filter | undefined,
  ):
    | {
        key: string;
        values: Readonly<Record<string, string | number>>;
        also: ReadonlyArray<{ column: string; value: string | number | boolean }>;
      }
    | undefined {
    const pk = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
    const group = filter?.groups.length === 1 ? filter.groups[0] : undefined;
    if (!pk.length || !group || group.length < pk.length) return undefined;
    const values: Record<string, string | number> = {};
    const also: Array<{ column: string; value: string | number | boolean }> = [];
    for (const condition of group) {
      if (condition.op !== '=' || Object.keys(condition).length !== 3) return undefined;
      if (pk.includes(condition.column)) {
        if (typeof condition.value !== 'string' && typeof condition.value !== 'number') return undefined;
        if (Object.hasOwn(values, condition.column)) return undefined;
        values[condition.column] = condition.value;
        continue;
      }
      const column = table.columns.find((candidate) => candidate.name === condition.column);
      // json has no equality operator: the server refuses that read, so it is sent for the server to say so.
      if (!column || /^json$/i.test(column.type)) return undefined;
      if (typeof condition.value !== 'string' && typeof condition.value !== 'number' && typeof condition.value !== 'boolean')
        return undefined;
      also.push({ column: condition.column, value: condition.value });
    }
    if (Object.keys(values).length !== pk.length) return undefined;
    return { key: JSON.stringify([this.#scope(scope), table.id, pk.map((column) => values[column])]), values, also };
  }

  /** Keep the rows a full read of `table` by its key will answer (`rows`, the driver's own, unconverted). */
  keep(scope: RowScope, table: TableMeta, filter: Filter, rows: Promise<readonly Row[]>, take?: () => void): void {
    const generation = this.generation(),
      key = this.#keyOf(scope, table, filter);
    if (generation === undefined || key === undefined) return;
    this.#entries.set(key, {
      generation,
      // A failed read answers nothing: each read is then asked in its turn.
      rows: rows.then(
        (found) => found,
        () => undefined,
      ),
      take,
    });
  }

  /**
   * `reads`, with every read by key answered from a kept row where one is
   * kept. `statementOf` says the statement the read would have sent (its
   * `sql`); `format` turns a driver row into the read's own (binary or not, as
   * the read's executor would). With `keeps`, a full read by key that is asked
   * in its turn is kept for those after it (a guard's read: its rows are the
   * driver's own). With `widen`, a read by key of a row the transaction holds
   * locked (`held`), with nothing kept of it since the transaction last
   * changed something, is sent as a full read through `widen.reads` (whose
   * rows are the driver's own) and kept, and answered from it: the row cannot
   * move while the lock is held, so the reads of it that follow — the guard
   * reads of the write it is read for — are answered from it too, rather
   * than each asked in its turn.
   */
  over<R extends Reads>(
    reads: R,
    scope: RowScope,
    schema: DatabaseSchema,
    statementOf: (request: QueryRequest) => SqlFragment | undefined,
    format: (row: Row, request: QueryRequest) => Row,
    keeps: boolean,
    widen?: {
      held(table: TableMeta, key: Readonly<Record<string, string | number>>): boolean;
      reads: Pick<ScopedReads, 'query'>;
    },
  ): R {
    const query = async (request: QueryRequest): Promise<QueryResult> => {
      const table = schema.tables.find((candidate) => candidate.id === request?.table);
      const guarded =
        table && !request.orderBy?.length && !request.offset && clampLimit(request.limit) >= 1
          ? this.#guarded(scope, table, request.filter)
          : undefined;
      const key = guarded && !guarded.also.length ? guarded.key : undefined;
      // Asked again after a statement that moved the generation, of a column the row does not carry, or of a value it does not hold exactly: in its turn.
      const answer = async (kept: Kept): Promise<QueryResult | undefined> => {
        const rows = await kept.rows;
        const names = request.columns?.length ? request.columns : table!.columns.map((column) => column.name);
        const sql = statementOf(request);
        if (
          !rows ||
          !sql ||
          kept.generation !== this.generation() ||
          !rows.every((row) => names.every((name) => Object.hasOwn(row, name))) ||
          !rows.every((row) =>
            guarded!.also.every((condition) => Object.hasOwn(row, condition.column) && row[condition.column] === condition.value),
          )
        )
          return undefined;
        kept.take?.();
        return {
          columns: [...names],
          rows: rows
            .slice(0, clampLimit(request.limit))
            .map((row) => format(Object.fromEntries(names.map((name) => [name, row[name]])), request)),
          ms: 0,
          sql,
        };
      };
      const current = this.generation();
      const kept = guarded === undefined ? undefined : this.#entries.get(guarded.key);
      if (kept && kept.generation === current) {
        const answered = await answer(kept);
        if (answered) return answered;
      } else if (key !== undefined && current !== undefined && widen?.held(table!, guarded!.values)) {
        const sent = widen.reads.query({ table: request.table, filter: request.filter, limit: 2, offset: 0 });
        /* Its generation is the one it was sent under: what waited for the COMMIT leaves in front of it, in its flight
           (postgresTransactionHandle), moving the generation as it goes, and the row it reads is after that. Kept
           under the generation before it was sent, it would answer nothing after it. Reads are sent as they are
           asked (createScopedReads compiles before it executes), so this is that moment. */
        const generation = this.generation();
        // A failure is the read's own: thrown as it would have been asked.
        const full = await sent;
        const read: Kept = { generation: generation ?? current, rows: Promise.resolve(full.rows) };
        this.#entries.set(key, read);
        const answered = await answer(read);
        if (answered) return answered;
      }
      if (!keeps || key === undefined || request.columns?.length) return reads.query(request);
      const generation = this.generation();
      const result = await reads.query(request);
      if (generation !== undefined && generation === this.generation())
        this.#entries.set(key, { generation, rows: Promise.resolve(result.rows) });
      return result;
    };
    return Object.freeze({ ...reads, query });
  }
}
