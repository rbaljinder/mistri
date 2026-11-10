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
export async function insertPlanned(plans: readonly InsertPlan[], write: PgQuery): Promise<InsertResult[]> {
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
  const results: UpdateResult[] = [];
  for (const chunk of chunked(plans, (plan) => pk.length * (Object.keys(plan.applied).length + 3) + 2 * Object.keys(plan.applied).length)) {
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
