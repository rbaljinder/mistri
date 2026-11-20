/**
 * An index a store upgrade adds to a table that already exists, built without
 * the table lock `CREATE INDEX` holds for the whole build. An upgrade on a
 * store with millions of rows would otherwise stop every write to it for as
 * long as the build runs (a field report). The store runner (server/storeLayouts.ts)
 * builds these outside any transaction, on the connection that holds the store's session lock,
 * and only then runs the step's transactional rest.
 *
 * An index created in the same step as its table stays in that step's
 * transaction: nothing can be waiting on a table nobody has seen yet.
 */

/** The two calls this needs from the store runner's connection (a `MigrationDb` passes as one); adapters keep to their layer. */
interface IndexDb {
  all<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Row[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
}

export interface ConcurrentIndex {
  /** The index's name, as the catalog holds it (unquoted, case as folded). */
  readonly name: string;
  /** The table it is on, quoted and schema-qualified, as `runtimeTable` gives it. */
  readonly table: string;
  /** The plain `CREATE INDEX …` statement: the same text the table's own definition runs. */
  readonly create: string;
}

/** The statement that builds it without blocking writes; `IF NOT EXISTS` makes a rerun after a success a no-op. */
export const concurrentStatement = (index: ConcurrentIndex): string => {
  if (!index.create.startsWith('CREATE INDEX ')) throw new Error(`not a plain index definition: ${index.create}`);
  return index.create.replace('CREATE INDEX ', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS ');
};

/**
 * Build each index. An interrupted `CREATE INDEX CONCURRENTLY` (a crash, a
 * cancelled deploy, a deadlock) leaves the index in the catalog marked
 * invalid: it is maintained by every write and used by no query, and
 * `IF NOT EXISTS` would skip it forever. So an invalid one is dropped first
 * (also concurrently) and built again.
 */
export async function buildIndexesConcurrently(db: IndexDb, indexes: readonly ConcurrentIndex[]): Promise<void> {
  for (const index of indexes) {
    const found = await db.all<{ valid: boolean; schema: string }>(
      `SELECT i.indisvalid AS valid, n.nspname AS schema
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE i.indrelid = to_regclass(?) AND c.relname = ?`,
      [index.table, index.name],
    );
    if (found[0] && !found[0].valid)
      await db.run(`DROP INDEX CONCURRENTLY IF EXISTS "${found[0].schema.replace(/"/g, '""')}"."${index.name.replace(/"/g, '""')}"`);
    await db.run(concurrentStatement(index));
  }
}
