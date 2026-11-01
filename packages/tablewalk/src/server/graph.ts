/**
 * A graph of rows, inserted as one thing or not at all.
 *
 * Creating test data one row at a time is the shape the write tools already
 * had, and it is the wrong shape for what people actually create: an invoice
 * needs its customer, the customer needs its country. Ten separate calls that
 * fail at the seventh leave six rows and a dirty database — worse than
 * failing, because the database now holds something nobody designed and
 * nothing names, and the next run fails differently.
 *
 * So the whole graph arrives in one call and goes in one transaction. That is
 * also why this is not a session-scoped transaction handle: MCP calls are
 * independent, a handle would have to survive between them, and then the real
 * question becomes what happens when a client disappears holding one. Taking
 * the graph whole makes that question disappear rather than answering it.
 *
 * Neither direction is journaled: a graph is not one recorded write, so `revert`
 * cannot undo it and no `undoId` comes back. `insertGraph` hands back its own
 * inverse (`teardown`) instead; a `deleteGraph` cannot be taken back.
 *
 * ## Rows that point at rows
 *
 * The rows a fixture needs mostly do not know their own keys — `id` is the
 * database's to assign — so a child cannot name its parent by value. It names
 * it by *label*:
 *
 *     [{ table: 'country',  as: 'au', values: { code: 'AU', name: 'Australia' } },
 *      { table: 'customer', as: 'c1', values: { name: 'Dry Creek', country_code: { ref: 'au', column: 'code' } } },
 *      { table: 'invoice',              values: { customer_id: { ref: 'c1' }, total: 99.5 } }]
 *
 * A bare `{ ref }` means that row's primary key, which has to be a single
 * column to mean anything on its own; `column` names one of the stored row's
 * columns instead. Both read the row *as the database stored it*, so an
 * assigned key and a filled default are equally referable.
 *
 * Order is the caller's, not ours. It could be derived — `insertOrder` exists
 * — but a caller who lists rows in an order the schema cannot satisfy has a
 * misunderstanding worth reporting rather than silently correcting, and a
 * fixture whose order is stable is one whose failures are reproducible.
 */
import type { Adapter, InsertResult, WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';

/** A value that names another row in the same request. */
interface RowRef {
  ref: string;
  /** Which column of that row. Its primary key when left out. */
  column?: string;
}

export interface GraphRow {
  table: string;
  /** A label for this row, so a later one can point at it. */
  as?: string;
  values: Record<string, unknown>;
}

interface GraphInsertResult {
  inserted: Array<{
    table: string;
    as?: string;
    key: Record<string, string | number>;
    row?: Record<string, unknown>;
  }>;
  /**
   * The same rows, reversed and reduced to what a delete needs.
   *
   * Ready to hand straight back to `deleteGraph`: children before parents,
   * which is the only order a teardown can run in.
   */
  teardown: Array<{ table: string; key: Record<string, string | number> }>;
  rowsWritten: number;
}

interface GraphDeleteResult {
  removed: Array<{ table: string; key: Record<string, string | number>; affected: number }>;
  rowsDeleted: number;
}

/** A refusal that is about the request rather than about the database. */
class GraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphError';
  }
}

const isRef = (v: unknown): v is RowRef => typeof v === 'object' && v !== null && typeof (v as RowRef).ref === 'string';

/**
 * `fixture`'s shape, flattened into this one.
 *
 * The extractor answers `[{ table, rows: [...] }]` — a whole table at a time,
 * in insert order — because that is how it reads. Accepting it here is what
 * makes the pair a loop: take a real row out of development, put it into a
 * test database, without an agent hand-rewriting the shape in between.
 */
export function flattenTables(tables: Array<{ table: string; rows: Array<Record<string, unknown>> }>): GraphRow[] {
  return tables.flatMap(({ table, rows }) => rows.map((values) => ({ table, values })));
}

/**
 * Check what can be checked before anything is written.
 *
 * Every one of these is a mistake in the request rather than a refusal from
 * the database, and finding them here means the transaction is never opened —
 * so the answer to "did anything happen" is a flat no rather than a rollback
 * to reason about.
 */
function validate(schema: DatabaseSchema, rows: GraphRow[]): void {
  if (!rows.length) throw new GraphError('Nothing to insert. Give at least one row.');

  const seen = new Map<string, number>();
  rows.forEach((row, i) => {
    const at = `Row ${i + 1}`;
    if (!row || typeof row !== 'object') throw new GraphError(`${at} is not a row.`);
    if (!row.table) throw new GraphError(`${at} does not say which table it is for.`);
    if (!tableNamed(schema, row.table)) {
      /* Resolved the way `insert` resolves it, bare name included. A graph
         that refused `customer` where a single `insert` accepted it would be
         a difference an agent has to discover by wasting a call. */
      throw new GraphError(`${at}: no table called "${row.table}". Ask \`tables\` for what exists.`);
    }
    if (!row.values || typeof row.values !== 'object' || !Object.keys(row.values).length) {
      throw new GraphError(`${at} (${row.table}) has no values. Name at least one column.`);
    }
    if (row.as !== undefined) {
      if (typeof row.as !== 'string' || !row.as.trim()) {
        throw new GraphError(`${at} (${row.table}) has a label that is not a name.`);
      }
      if (seen.has(row.as)) {
        throw new GraphError(
          `${at}: "${row.as}" is already the label of row ${seen.get(row.as)! + 1}. Labels have to be unique to point at anything.`,
        );
      }
      seen.set(row.as, i);
    }

    for (const [column, value] of Object.entries(row.values)) {
      if (!isRef(value)) continue;
      const target = seen.get(value.ref);
      /* Earlier, strictly. A row can only point at a row that already exists,
         and the alternative — resolving forwards — would mean deciding an
         order the caller did not ask for. `order` is the tool that answers
         "what has to exist first". */
      if (target === undefined) {
        throw new GraphError(
          seen.size
            ? `${at} (${row.table}.${column}) points at "${value.ref}", which is not the label of any earlier row. Known so far: ${[...seen.keys()].join(', ')}.`
            : `${at} (${row.table}.${column}) points at "${value.ref}", but no row before it has a label.`,
        );
      }
    }
  });
}

/** What a `{ ref }` resolves to, once the row it names has been inserted. */
function resolveRef(ref: RowRef, made: Map<string, InsertResult>, where: string): unknown {
  const source = made.get(ref.ref);
  if (!source) throw new GraphError(`${where} points at "${ref.ref}", which was not inserted.`);

  if (ref.column) {
    if (!source.row || !(ref.column in source.row)) {
      throw new GraphError(`${where}: the row labelled "${ref.ref}" has no column "${ref.column}" to point at.`);
    }
    return source.row[ref.column];
  }

  const key = Object.entries(source.key);
  if (key.length > 1) {
    /* A composite key cannot stand in for one value. Named, because the fix
       is to pick one of them. */
    throw new GraphError(
      `${where}: "${ref.ref}" has a key of more than one column (${key.map(([c]) => c).join(', ')}), ` +
        `so it cannot be a single value. Say which: { ref: "${ref.ref}", column: "…" }.`,
    );
  }
  if (!key.length) {
    throw new GraphError(
      `${where}: the row labelled "${ref.ref}" came back without a key, so there is nothing to point at. ` +
        `Name a column instead: { ref: "${ref.ref}", column: "…" }.`,
    );
  }
  return key[0][1];
}

/**
 * Insert a graph of rows in one transaction.
 *
 * Every row goes through the adapter's ordinary `insert`, so every guard it
 * carries — real columns, values coerced to their declared types, NOT NULL
 * refused before the statement, the database's own words for everything else
 * — applies here unchanged. What this adds is the transaction around them and
 * the labels between them.
 */
export async function insertGraph(adapter: Adapter, schema: DatabaseSchema, rows: GraphRow[]): Promise<GraphInsertResult> {
  if (!adapter.insert) {
    throw new GraphError(`${schema.dialect} connections are read-only in this build.`);
  }
  if (!adapter.transaction) {
    /* Refused rather than degraded to a loop of independent inserts. Doing
       the work without the guarantee, under a name that promises it, is how a
       half-written fixture comes to look like a working one. */
    throw new GraphError(
      `${schema.dialect} connections cannot group writes into one transaction in this build, and a graph is only worth inserting as one.`,
    );
  }

  validate(schema, rows);

  return adapter.transaction(async (tx: WriteTransaction) => {
    const made = new Map<string, InsertResult>();
    const inserted: GraphInsertResult['inserted'] = [];

    for (const [i, row] of rows.entries()) {
      const where = `Row ${i + 1} (${row.table})`;
      /* Resolved to the schema's own id before the adapter sees it. On
         Postgres a bare `country` means `public.country` to the adapter and
         `tablewalk_pg_fixture.country` to the schema the caller is browsing —
         so passing the name through would write to a different table than the
         one that was validated. Every other write tool resolves first for the
         same reason. */
      const table = tableNamed(schema, row.table)!.id;
      const values: Record<string, string | number | boolean | null> = {};
      for (const [column, value] of Object.entries(row.values)) {
        values[column] = (isRef(value) ? resolveRef(value, made, `${where}.${column}`) : value) as string | number | boolean | null;
      }

      const result = await tx.insert({ table, values }).catch((err: Error) => {
        /* Named by position and table, because the message the database gives
           is about a statement and the caller is looking at a list. "Nothing
           was written" is the part worth being explicit about: the whole
           point of the transaction is that a failure here is not a mess to
           clean up. */
        throw new Error(`${where}: ${err.message}\nNothing was written — the whole graph was rolled back.`);
      });

      if (row.as) made.set(row.as, result);
      inserted.push({ table, as: row.as, key: result.key, row: result.row });
    }

    return {
      inserted,
      teardown: [...inserted].reverse().map(({ table, key }) => ({ table, key })),
      rowsWritten: inserted.length,
    };
  });
}

/**
 * Remove a graph of rows in one transaction.
 *
 * The other half, and the half that decides whether a fixture is usable
 * twice: a teardown that fails part way leaves exactly the mess the insert
 * was careful not to. Rows are removed in the order given — `insertGraph`
 * hands back that order already reversed — and each goes through the
 * adapter's ordinary `remove`, so the whole primary key is still required and
 * a key matching anything other than one row is still refused.
 */
export async function deleteGraph(
  adapter: Adapter,
  schema: DatabaseSchema,
  rows: Array<{ table: string; key: Record<string, string | number> }>,
): Promise<GraphDeleteResult> {
  if (!adapter.remove) {
    throw new GraphError(`${schema.dialect} connections cannot delete in this build.`);
  }
  if (!adapter.transaction) {
    throw new GraphError(`${schema.dialect} connections cannot group writes into one transaction in this build.`);
  }
  if (!rows.length) throw new GraphError('Nothing to delete. Give at least one row.');

  rows.forEach((row, i) => {
    if (!row?.table) throw new GraphError(`Row ${i + 1} does not say which table it is for.`);
    if (!tableNamed(schema, row.table)) {
      throw new GraphError(`Row ${i + 1}: no table called "${row.table}".`);
    }
    if (!row.key || !Object.keys(row.key).length) {
      throw new GraphError(`Row ${i + 1} (${row.table}) has no key, and a delete needs one.`);
    }
  });

  return adapter.transaction(async (tx: WriteTransaction) => {
    const removed: GraphDeleteResult['removed'] = [];
    for (const [i, row] of rows.entries()) {
      const table = tableNamed(schema, row.table)!.id;
      const result = await tx.remove({ table, key: row.key }).catch((err: Error) => {
        throw new Error(`Row ${i + 1} (${row.table}): ${err.message}\nNothing was removed — the whole teardown was rolled back.`);
      });
      removed.push({ table, key: row.key, affected: result.affected });
    }
    return { removed, rowsDeleted: removed.reduce((n, r) => n + r.affected, 0) };
  });
}
