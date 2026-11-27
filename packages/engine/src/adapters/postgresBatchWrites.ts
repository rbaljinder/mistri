/** Several rows of one table written by one statement: the SQL behind the command `db`'s `insertMany` and `updateWhere`. */
import {
  POSTGRES_STYLE,
  Refusal,
  batchedRows,
  buildWhere,
  chunked,
  gathered,
  refuseUpdateMatches,
  runsOfColumns,
  sameTable,
  type InsertRequest,
  type InsertResult,
  type UpdateRequest,
  type UpdateResult,
  type WriteTransaction,
} from './adapter.js';
import type { Located, PgColumnRow } from './postgresCatalog.js';
import type { PgQuery } from './postgresPool.js';
import { qualified, toJsonSafe } from './postgresValues.js';
import { buildUpdateGuard } from './scoped/updateGuard.js';

type Applied = Record<string, string | number | boolean | null>;

/** What the adapter's insert refuses before it writes, already passed: the table and the values coerced to their columns. */
export interface InsertPlan {
  found: Located;
  meta: PgColumnRow[];
  applied: Applied;
}

/** An update's request beside what its refusals already passed. */
export interface UpdatePlan extends InsertPlan {
  request: UpdateRequest;
  pk: string[];
}

/**
 * Rows added inside a transaction, each as the adapter's single insert adds one: one multi-row
 * `INSERT … RETURNING *` for each run of rows naming the same columns, its rows matched back to the
 * requests that wrote them (batchedRows).
 */
export async function insertPlanned(plans: readonly InsertPlan[], write: PgQuery, scoped = false): Promise<InsertResult[]> {
  sameTable(plans.map((plan) => `${plan.found.schema}.${plan.found.name}`));
  const found = plans[0]!.found;
  const pk = plans[0]!.meta.filter((c) => c.is_pk).map((c) => c.name);
  const results: InsertResult[] = [];
  for (const run of runsOfColumns(plans)) {
    const columns = Object.keys(run[0]!.applied);
    /* DEFAULT VALUES is one row; rows that name no column are added one statement each. */
    for (const chunk of columns.length ? chunked(run, () => columns.length) : run.map((plan) => [plan])) {
      const params = chunk.flatMap((plan) => Object.values(plan.applied));
      const text =
        `INSERT INTO ${qualified(found)}` +
        (columns.length
          ? ` (${columns.map((c) => POSTGRES_STYLE.quote(c)).join(', ')}) VALUES ${chunk
              .map((_, row) => `(${columns.map((_, i) => POSTGRES_STYLE.placeholder(row * columns.length + i + 1)).join(', ')})`)
              .join(', ')}`
          : ' DEFAULT VALUES') +
        ' RETURNING *';
      const result = await write.query(text, params);
      batchedRows(
        chunk.map((plan) => plan.applied),
        result.rows as Array<Record<string, unknown>>,
      ).forEach((stored, index) => {
        /* A scope re-reads each stored row by its key, as the single insert's does (postgres.ts insertNow): a key that
           comes back as no text or number (a bytea's label) proves nothing, and is refused before it stands in. */
        if (
          scoped &&
          pk.some(
            (column) => !(typeof stored[column] === 'string' || (typeof stored[column] === 'number' && Number.isFinite(stored[column]))),
          )
        )
          throw new Refusal('The stored key cannot be checked in this row scope.');
        const row = toJsonSafe(stored) as Record<string, unknown>;
        const key: Record<string, string | number> = {};
        for (const c of pk) key[c] = row[c] as string | number;
        results.push({ key, row, applied: chunk[index]!.applied, sql: { text, params } });
      });
    }
  }
  return results;
}

/**
 * Rows changed inside a transaction, each as the adapter's single update changes one: each row's own values and
 * `expected`, one row a key. A `CASE` a column picks each row's value, the WHERE matches each key with its own
 * guard, and RETURNING says which requests matched, so a row whose key or guard missed refuses the batch as it
 * would have refused alone.
 */
/* Safe built-in PG scalar types whose JS arrays node-postgres binds cleanly to pg_catalog.unnest($n::<type>[]). */
const UNNEST_TYPE =
  /^(?:text|integer|bigint|smallint|boolean|real|double precision|uuid|date|numeric(?:\(\d+(?:,\d+)?\))?|character varying(?:\(\d+\))?|timestamp(?:\(\d+\))? (?:with|without) time zone)$/;

function tryUnnestUpdate(
  found: Located,
  pk: readonly string[],
  types: Record<string, string>,
  chunk: readonly UpdatePlan[],
): { text: string; params: unknown[] } | undefined {
  if (chunk.length < 2) return undefined;
  const columns = Object.keys(chunk[0]!.applied);
  if (!columns.length) return undefined;
  if (!chunk.every((plan) => Object.keys(plan.applied).length === columns.length && columns.every((c) => Object.hasOwn(plan.applied, c))))
    return undefined;
  const hasExpected = chunk[0]!.request.expected !== undefined;
  if (!chunk.every((plan) => (plan.request.expected !== undefined) === hasExpected)) return undefined;
  let expectedColumns: string[] = [];
  if (hasExpected) {
    for (const plan of chunk) buildUpdateGuard(plan.request, types, POSTGRES_STYLE, 'postgres', 1);
    expectedColumns = Object.keys(chunk[0]!.request.expected!);
    if (
      !chunk.every(
        (plan) =>
          Object.keys(plan.request.expected!).length === expectedColumns.length &&
          expectedColumns.every((c) => Object.hasOwn(plan.request.expected!, c)),
      )
    )
      return undefined;
  }
  for (const col of [...pk, ...columns, ...expectedColumns]) {
    if (!UNNEST_TYPE.test(types[col] ?? '')) return undefined;
  }
  const params: unknown[] = [chunk.map((_, index) => index)];
  const unnestArgs = ['pg_catalog.unnest($1::integer[])'];
  const aliases = [POSTGRES_STYLE.quote('mistri_batch_row')];
  const pushArray = (type: string, alias: string, values: unknown[]) => {
    params.push(values);
    unnestArgs.push(`pg_catalog.unnest($${params.length}::${type}[])`);
    aliases.push(POSTGRES_STYLE.quote(alias));
    return `mistri_v.${POSTGRES_STYLE.quote(alias)}`;
  };
  const pkMatches = pk.map((col, i) => {
    const ref = pushArray(
      types[col]!,
      `k${i}`,
      chunk.map((plan) => plan.request.key[col]),
    );
    return `mistri_t.${POSTGRES_STYLE.quote(col)} = ${ref}`;
  });
  const sets = columns.map((col, i) => {
    const ref = pushArray(
      types[col]!,
      `c${i}`,
      chunk.map((plan) => plan.applied[col]),
    );
    return `${POSTGRES_STYLE.quote(col)} = ${ref}`;
  });
  const guards = expectedColumns.map((col, i) => {
    const type = types[col]!;
    const ref = pushArray(
      type,
      `e${i}`,
      chunk.map((plan) => plan.request.expected![col] ?? null),
    );
    const tCol = `mistri_t.${POSTGRES_STYLE.quote(col)}`;
    if (/char|text|clob|citext/i.test(type)) {
      return `((${ref} IS NULL AND ${tCol} IS NULL) OR (${tCol}::text COLLATE "C" = ${ref}::text COLLATE "C"))`;
    }
    return `${tCol} IS NOT DISTINCT FROM ${ref}`;
  });
  const text =
    `UPDATE ${qualified(found)} AS mistri_t SET ${sets.join(', ')}` +
    ` FROM ROWS FROM(${unnestArgs.join(', ')}) AS mistri_v(${aliases.join(', ')})` +
    ` WHERE ${[...pkMatches, ...guards].join(' AND ')}` +
    ` RETURNING mistri_v.${POSTGRES_STYLE.quote('mistri_batch_row')}`;
  return { text, params };
}

export async function updatePlanned(plans: readonly UpdatePlan[], write: PgQuery): Promise<UpdateResult[]> {
  sameTable(plans.map((plan) => `${plan.found.schema}.${plan.found.name}`));
  const { found, pk } = plans[0]!;
  const types = Object.fromEntries(plans[0]!.meta.map((column) => [column.name, column.type]));
  const keys = new Set<string>();
  for (const { request } of plans) {
    const key = JSON.stringify(pk.map((column) => String(request.key[column])));
    if (keys.has(key)) throw new Refusal(`A batch changes each row of ${found.name} once; that key appears twice.`);
    keys.add(key);
  }
  const wholeUnnest = plans.length <= 5000 ? tryUnnestUpdate(found, pk, types, plans) : undefined;
  if (wholeUnnest) {
    const result = await write.query(wholeUnnest.text, wholeUnnest.params);
    const matched = new Set((result.rows as Array<Record<string, unknown>>).map((row) => Number(row.mistri_batch_row)));
    return plans.map((plan, index) => {
      if (!matched.has(index)) refuseUpdateMatches(plan.request, 0);
      return { affected: 1, applied: plan.applied, sql: wholeUnnest };
    });
  }
  const results: UpdateResult[] = [];
  for (const chunk of chunked(plans, (plan) => pk.length * (Object.keys(plan.applied).length + 3) + 2 * Object.keys(plan.applied).length)) {
    const unnest = tryUnnestUpdate(found, pk, types, chunk);
    if (unnest) {
      const result = await write.query(unnest.text, unnest.params);
      const matched = new Set((result.rows as Array<Record<string, unknown>>).map((row) => Number(row.mistri_batch_row)));
      chunk.forEach((plan, index) => {
        if (!matched.has(index)) refuseUpdateMatches(plan.request, 0);
        results.push({ affected: 1, applied: plan.applied, sql: unnest });
      });
      continue;
    }
    const params: unknown[] = [];
    const match = (request: UpdateRequest) => {
      const where = buildWhere(
        { groups: [pk.map((column) => ({ column, op: '=' as const, value: request.key[column] }))] },
        POSTGRES_STYLE,
        params.length + 1,
      );
      params.push(...where.params);
      return where.text.replace(/^ WHERE /, '');
    };
    const columns = [...new Set(chunk.flatMap((plan) => Object.keys(plan.applied)))];
    const assignments = columns.map((column) => {
      const cases = chunk
        .filter((plan) => Object.hasOwn(plan.applied, column))
        .map((plan) => {
          const key = match(plan.request);
          params.push(plan.applied[column]);
          return `WHEN ${key} THEN ${POSTGRES_STYLE.placeholder(params.length)}`;
        });
      const quoted = POSTGRES_STYLE.quote(column);
      return `${quoted} = CASE ${cases.join(' ')} ELSE ${quoted} END`;
    });
    const wheres = chunk.map((plan) => {
      const key = match(plan.request);
      const guard = buildUpdateGuard(plan.request, types, POSTGRES_STYLE, 'postgres', params.length + 1);
      params.push(...guard.params);
      return `(${key}${guard.text})`;
    });
    const which = chunk.map((plan, index) => `WHEN ${match(plan.request)} THEN ${index}`);
    const text =
      `UPDATE ${qualified(found)} SET ${assignments.join(', ')} WHERE ${wheres.join(' OR ')}` +
      ` RETURNING CASE ${which.join(' ')} END AS ${POSTGRES_STYLE.quote('mistri_batch_row')}`;
    const result = await write.query(text, params);
    const matched = new Set((result.rows as Array<Record<string, unknown>>).map((row) => Number(row.mistri_batch_row)));
    chunk.forEach((plan, index) => {
      if (!matched.has(index)) refuseUpdateMatches(plan.request, 0);
      results.push({ affected: 1, applied: plan.applied, sql: { text, params } });
    });
  }
  return results;
}

/** A transaction's batch writes, each run through `run` as its single writes are (a queue, a lock), when it has them. */
export function batchesThrough(
  writes: Pick<WriteTransaction, 'insertMany' | 'updateMany'>,
  run: <T>(work: () => Promise<T>) => Promise<T>,
): Pick<WriteTransaction, 'insertMany' | 'updateMany'> {
  const { insertMany, updateMany } = writes;
  if (!insertMany || !updateMany) return {};
  return { insertMany: (rs) => run(() => insertMany(rs)), updateMany: (rs) => run(() => updateMany(rs)) };
}

/** A transaction's batch writes with each row passed through `insert` or `update` as it is alone, around the one
 * statement (gathered): a before image read under its lock still waits for that row's read, and an after image
 * rides behind the batch's UPDATE as behind one row's. */
export function gatheredBatches(
  writes: Pick<WriteTransaction, 'insertMany' | 'updateMany'>,
  around: {
    insert(request: InsertRequest, write: (request: InsertRequest) => Promise<InsertResult>): Promise<InsertResult>;
    update(request: UpdateRequest, write: (request: UpdateRequest) => Promise<UpdateResult>): Promise<UpdateResult>;
  },
): Pick<WriteTransaction, 'insertMany' | 'updateMany'> {
  const { insertMany, updateMany } = writes;
  if (!insertMany || !updateMany) return {};
  return {
    insertMany: (rs) => gathered(rs, (r, write) => around.insert(r, write), insertMany),
    updateMany: (rs) => gathered(rs, (r, write) => around.update(r, write), updateMany),
  };
}
