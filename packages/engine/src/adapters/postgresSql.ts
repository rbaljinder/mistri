/**
 * The three statements a person writes or asks about rather than the ones this
 * adapter builds: raw SQL (read-only by transaction, or on the write handle),
 * EXPLAIN, and the planner's statistics. They share nothing with the adapter's
 * catalog or write caches, only its connection pools, so they live apart from
 * postgres.ts, which had outgrown a file a person can hold.
 */
import {
  boundStatement,
  clampLimit,
  dedupe,
  looksWrappable,
  refuseAnalyze,
  refuseStacked,
  trimStatement,
  type ColumnProfile,
  type ExplainRequest,
  type ExplainResult,
  type ProfileResult,
  type SqlRequest,
  type SqlResult,
} from './adapter.js';
import type { PgConnectionManager, PgQuery } from './postgresPool.js';
import { postgresRowEstimate } from './postgresCatalogRows.js';
import { refusePostgresReserved, refuseReservedPlan, refuseReservedText } from './reservedSql.js';
import { statementCap } from './statementControl.js';
import { valueSafe } from './postgresValues.js';
import type { WriteLanes } from './writeLanes.js';

/**
 * Run a statement the user wrote.
 *
 * The session already carries `default_transaction_read_only = on`, and for
 * everything else in this adapter that is enough, because every statement is
 * one this file built. It is **not** enough here: `SET
 * default_transaction_read_only = off` is itself a statement, and a user who
 * typed it followed by a `DELETE` would get both.
 *
 * `BEGIN READ ONLY` is the version that holds, for one statement. Postgres
 * refuses `SET TRANSACTION READ WRITE` once the transaction has taken its
 * first snapshot, and one statement takes it before it runs. It does not hold
 * against several: `COMMIT; BEGIN READ WRITE; DELETE …` ends the read-only
 * transaction and opens a writable one. So the text goes on the extended
 * protocol (`queryMode: 'extended'`), where Postgres itself refuses a second
 * statement; refuseStacked is the earlier, clearer refusal, not the guard.
 * (node-postgres sends a query with an empty `values` on the simple protocol,
 * which runs every statement in the string.) The `ROLLBACK` afterwards also
 * discards any session state the statement set, so one run cannot change what
 * the next one means.
 *
 * The rollback runs in a `finally`: a statement that errors has still opened
 * a transaction, and leaving it open would leave the connection in an aborted
 * state where every later query fails with "current transaction is aborted".
 *
 * `write: true` is the other half, and it is a different request rather than
 * a relaxation of this one: a separate handle, no READ ONLY transaction, and
 * a decision made further up about whether this connection may write at all.
 * The two paths share the statement text and nothing else.
 */
export async function runPostgresSql(connections: PgConnectionManager, writes: WriteLanes, request: SqlRequest): Promise<SqlResult> {
  const stacked = refuseStacked(request.text, 'postgres');
  if (stacked) throw new Error(stacked);
  if (request.refuseReserved) refusePostgresReserved(request.text, request.write);
  const limit = clampLimit(request.limit);
  /* A write is never wrapped in a bounding subquery: `UPDATE … RETURNING`
     inside `SELECT * FROM (…)` is a different statement, and one Postgres
     refuses outright. The caller asked for this text; it runs as typed. */
  const bounded = !request.write && looksWrappable(request.text);
  const text = bounded ? boundStatement(request.text, limit) : trimStatement(request.text);

  if (request.write) {
    /* On the write handle, and outside the READ ONLY transaction every other
       statement here gets — which is the whole difference. Whether this is
       allowed at all was decided before the request arrived: the connection
       has to be marked writable in the config, and that check does not live
       in the adapter.

       No wrapper transaction of our own. One statement is already atomic in
       Postgres, and a BEGIN/COMMIT around it would only add a way to leave a
       transaction open on a connection that outlives the request. */
    return writes.run('all', () =>
      connections.withWriteClient(async (write) => {
        const started = performance.now();
        // Extended protocol: one statement, as on the read path below.
        const result = await write.query({ text, values: [], rowMode: 'array', queryMode: 'extended' });
        return {
          /* A write that returns rows — `RETURNING` — is worth showing, and one
           that does not returns an empty grid rather than a fabricated one.
           Array rows, so two columns of one name keep both values. */
          columns: dedupe(result.fields?.map((f) => f.name) ?? []),
          rows: (result.rows ?? []).map((row) => row.map(valueSafe)),
          ms: Math.round(performance.now() - started),
          truncated: false,
          bounded: false,
          affected: Number(result.rowCount ?? 0),
          sql: { text, params: [] },
        };
      }, true),
    );
  }

  return connections.withReadClient(async (db) => {
    const started = performance.now();
    /* The statement's cap, set where it dies with the transaction, so the
       session's own is untouched — and statementCap's floor stops a caller
       asking for a timeout so low that even the fast path loses races to it. */
    const cap = statementCap(request.timeoutMs);
    const begin = () => db.query('BEGIN READ ONLY').then(() => db.query(`SET LOCAL statement_timeout = ${cap}`));
    await begin();
    try {
      if (request.refuseReserved) await refuseReservedPlan(db, request.text, []);
      /* `rowMode: 'array'` so two output columns of the same name keep both
         values; the default object rows would let the second overwrite the
         first. `queryMode: 'extended'` is what carries exactly one statement:
         an empty `values` alone leaves node-postgres on the simple protocol,
         which would run a stacked COMMIT and a write after it. */
      let wrapped = bounded;
      const result = await db.query({ text, values: [], rowMode: 'array', queryMode: 'extended' }).catch(async (err: Error) => {
        /* The wrap is an optimisation that is allowed to fail — not every
             legal statement survives being made a derived table. Run as
             written and reported as unbounded. The transaction has to be
             restarted: a failed statement aborts it, and every later query in
             it would fail with "current transaction is aborted". A statement
             that was stopped — cancelled, or past its cap (57014) — is not a
             wrap that failed, and running it again would spend the cap twice. */
        if (!bounded || (err as { code?: string }).code === '57014') throw err;
        wrapped = false;
        await db.query('ROLLBACK');
        await begin();
        return db.query({ text: trimStatement(request.text), values: [], rowMode: 'array', queryMode: 'extended' });
      });
      const truncated = result.rows.length > limit;
      return {
        columns: dedupe(result.fields.map((f) => f.name)),
        rows: (truncated ? result.rows.slice(0, limit) : result.rows).map((row) => row.map(valueSafe)),
        ms: Math.round(performance.now() - started),
        truncated,
        bounded: wrapped,
        sql: { text: wrapped ? text : trimStatement(request.text), params: [] },
      };
    } finally {
      await db.query('ROLLBACK').catch(() => {
        /* The connection is already unusable if this fails; the original error
           is the one worth reporting. */
      });
    }
  }, true);
}

/**
 * EXPLAIN, plain — never the analysing variant that executes to time.
 *
 * `runSql`'s bounding wrap is precisely wrong here: a statement made a
 * derived table is a different statement, with a different plan. The text
 * goes to the planner as written, inside the same READ ONLY transaction
 * every user statement gets — so even a smuggled write is only ever
 * planned, and an execution attempt is the transaction's to refuse, not a
 * string check's.
 */
export async function explainPostgresSql(connections: PgConnectionManager, request: ExplainRequest): Promise<ExplainResult> {
  const stacked = refuseStacked(request.text, 'postgres');
  if (stacked) throw new Error(stacked);
  const analyze = refuseAnalyze(request.text);
  if (analyze) throw new Error(analyze);
  if (request.refuseReserved) refuseReservedText(request.text, 'postgres');
  return connections.withReadClient(async (db) => {
    const started = performance.now();
    await db.query('BEGIN READ ONLY');
    try {
      /* Planning runs nothing, but planning a wide join still takes time. */
      await db.query(`SET LOCAL statement_timeout = ${statementCap()}`);
      if (request.refuseReserved) await refuseReservedPlan(db, request.text, (request.params ?? []) as unknown[]);
      const result = await db.query({
        text: `EXPLAIN ${trimStatement(request.text)}`,
        values: (request.params ?? []) as unknown[],
        rowMode: 'array',
        // One statement, whether or not there are parameters: see runSql.
        queryMode: 'extended',
      });
      return {
        plan: result.rows.map((r) => String(r[0])),
        ms: Math.round(performance.now() - started),
      };
    } finally {
      await db.query('ROLLBACK').catch(() => {});
    }
  }, true);
}

/**
 * The planner's own statistics, read rather than computed.
 *
 * `pg_stats` already holds the null share, the distinct estimate, the most
 * common values with their frequencies, and the histogram — ANALYZE paid
 * for them, reading them touches no user table. The numbers are
 * sample-based and stale until the next ANALYZE, which is what
 * `source: 'statistics'` tells the caller; a column ANALYZE has never
 * visited simply has no numbers, which beats invented ones.
 */
export async function profilePostgresTable(table: string, schema: string, name: string, db: PgQuery): Promise<ProfileResult> {
  const started = performance.now();

  const rel = await db.query(
    `SELECT CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples END AS approx_rows
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, name],
  );
  const approx = rel.rows[0]?.approx_rows;
  const rows = postgresRowEstimate(approx);

  /* Every live column, with its stats row where ANALYZE has made one.
     `most_common_vals` and `histogram_bounds` are `anyarray`, which the
     driver has no parser for; the ::text::text[] two-step turns them into
     the text array it can parse. */
  const stats = await db.query(
    `SELECT a.attname::text AS column,
            format_type(a.atttypid, a.atttypmod) AS type,
            s.null_frac,
            s.n_distinct,
            s.most_common_vals::text::text[] AS common_values,
            s.most_common_freqs AS common_freqs,
            s.histogram_bounds::text::text[] AS bounds
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_stats s ON s.schemaname = n.nspname AND s.tablename = c.relname AND s.attname = a.attname
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, name],
  );

  const columns: ColumnProfile[] = (
    stats.rows as Array<{
      column: string;
      type: string;
      null_frac: number | null;
      n_distinct: number | null;
      common_values: string[] | null;
      common_freqs: number[] | null;
      bounds: string[] | null;
    }>
  ).map((r) => {
    /* Negative n_distinct is a ratio — "-0.3 of the rows are distinct" —
       which only converts when a row estimate exists to multiply by. */
    const distinct =
      r.n_distinct == null
        ? undefined
        : Number(r.n_distinct) >= 0
          ? Math.round(Number(r.n_distinct))
          : rows === undefined
            ? undefined
            : Math.round(-Number(r.n_distinct) * rows);
    const common =
      r.common_values?.length && r.common_freqs?.length
        ? r.common_values.map((v, i) => ({ value: v, frac: Number(r.common_freqs?.[i] ?? 0) }))
        : undefined;
    return {
      column: r.column,
      type: r.type,
      nullFrac: r.null_frac == null ? undefined : Number(r.null_frac),
      distinct,
      /* The histogram's outer edges, as text from the sample. A column too
         uniform to earn a histogram gets no min/max — its common values
         sorted lexically would call 9 larger than 10. */
      min: r.bounds?.length ? r.bounds[0] : undefined,
      max: r.bounds?.length ? r.bounds[r.bounds.length - 1] : undefined,
      common,
    };
  });

  return { table, rows, columns, source: 'statistics', ms: Math.round(performance.now() - started) };
}
