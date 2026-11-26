/**
 * Scoped SQL Common Table Expressions (`db.with({ ... }, (cte) => ...)`) for commands & page loaders.
 *
 * Each CTE step is built from ordinary `db.<table>.where(...).select(...)` or
 * `db.<table>.where(...).groupBy(...).aggregate(...)` queries and joined via
 * `db.<table>.join(cte.<name>, { on, kind })`.
 *
 * When the transaction supports `tx.cte` (SQLite, PostgreSQL, ScopedReads, scoped transactions),
 * the entire pipeline compiles into one parameterized SQL `WITH ... AS (...) SELECT ...` statement
 * with automatic tenant isolation and row policy enforcement inside every CTE.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  CteJoin,
  CteQuerySpec,
  CteRequest,
  CteSelect,
  CteStep,
  Filter,
  WriteTransaction,
} from '@mistriwork/engine/adapters/adapter.js';
import type { CteGroupKey } from '@mistriwork/engine/shared/cte.js';
import type { AggregateMeasure } from '@mistriwork/engine/shared/aggregate.js';
import { authorFault } from '@mistriwork/engine/shared/refusal.js';
import { BusinessCommandExecutionError } from './commandErrors.js';

function authorMistake(message: string): never {
  throw authorFault(new BusinessCommandExecutionError('invalid_result'), message);
}

/** Internal symbol attached to `Query` and `Grouped` instances so `cte(...)` can extract their compiled CTE plan. */
export const CTE_SPEC = Symbol('mistri.cte.spec');

import type { CteRef as PublicCteRef, CteRunner, JoinedQuery } from './commandDb.js';

interface InternalCteRef<Name extends string = string, Row = Readonly<Record<string, unknown>>> extends PublicCteRef<Name, Row> {
  readonly __steps?: readonly CteStep[];
}

export interface CteSourceSpec {
  readonly buildSpec: () => CteQuerySpec;
}

interface PendingJoin {
  readonly target: string;
  readonly alias: string;
  readonly kind: 'inner' | 'left';
  readonly on: readonly [string, string];
  readonly steps?: readonly CteStep[];
}

export interface CteContext {
  readonly steps: readonly CteStep[];
  readonly tx: Pick<WriteTransaction, 'query' | 'count' | 'aggregate' | 'cte'>;
  readonly defaultCap: number;
  readonly compileFilter: (tableName: string, where: Record<string, unknown>, aliasMap: ReadonlyMap<string, string>) => Filter;
}

const cteStorage = new AsyncLocalStorage<CteContext>();

export function currentCteContext(): CteContext | undefined {
  return cteStorage.getStore();
}

/** Extracts a `CteQuerySpec` from a Mistri `Query` or `Grouped` handle. */
export function extractCteSpec(name: string, step: unknown): CteStep {
  if (!step || (typeof step !== 'object' && typeof step !== 'function') || !(CTE_SPEC in step)) {
    authorMistake(`cte("${name}") expects a db.<table>.where(...) or .groupBy(...).aggregate(...) query.`);
  }
  const spec = (step as CteSourceSpec & { [CTE_SPEC]: () => CteQuerySpec })[CTE_SPEC]();
  return { name, ...spec };
}

/** Creates a lazy `JoinedQuery` starting from `baseTable` joined to `firstTarget`. */
export function createJoinedQuery(
  baseTable: string,
  firstTarget: InternalCteRef,
  firstOptions: { readonly on: readonly [string, string]; readonly kind?: 'inner' | 'left'; readonly alias?: string },
  compileBaseFilter: (where: Record<string, unknown>, knownAliases: ReadonlySet<string>) => Filter,
  defaultCap: number,
  tx: Pick<WriteTransaction, 'query' | 'count' | 'aggregate' | 'cte'>,
): JoinedQuery<Record<string, unknown>> {
  const joins: PendingJoin[] = [
    {
      target: firstTarget.__cteName,
      alias: firstOptions.alias ?? firstTarget.__cteName,
      kind: firstOptions.kind ?? 'inner',
      on: firstOptions.on,
      steps: firstTarget.__steps,
    },
  ];
  const whereParts: Record<string, unknown>[] = [];
  let selectedCols: CteSelect[] | undefined;
  const orderBy: { column: string; direction: 'asc' | 'desc' }[] = [];
  let cap: number | undefined;

  const buildSpec = (limitOverride?: number): CteQuerySpec => {
    const knownAliases = new Set([baseTable, ...joins.map((j) => j.alias)]);
    const groups = whereParts.flatMap((part) => compileBaseFilter(part, knownAliases).groups);
    const filter: Filter | undefined = groups.length ? { groups: [groups.flat()] } : undefined;
    const bound = limitOverride ?? cap;
    return {
      from: baseTable,
      joins: joins.map((j): CteJoin => ({
        target: j.target,
        alias: j.alias,
        kind: j.kind,
        on: j.on,
      })),
      ...(filter ? { filter } : {}),
      ...(selectedCols ? { select: selectedCols } : {}),
      ...(orderBy.length ? { orderBy } : {}),
      limit: bound ?? defaultCap + 1,
    };
  };

  const collectSteps = (): readonly CteStep[] => {
    const ctx = currentCteContext();
    if (ctx?.steps.length) return ctx.steps;
    const seen = new Set<string>();
    const merged: CteStep[] = [];
    for (const join of joins) {
      for (const step of join.steps ?? []) {
        if (!seen.has(step.name)) {
          seen.add(step.name);
          merged.push(step);
        }
      }
    }
    return merged;
  };

  const execute = async (limitOverride?: number): Promise<Record<string, unknown>[]> => {
    const ctx = currentCteContext();
    const steps = collectSteps();
    const activeTx = ctx?.tx ?? tx;
    if (typeof activeTx.cte !== 'function') {
      authorMistake(`${baseTable}: this command's source does not support SQL CTE queries.`);
    }
    const spec = buildSpec(limitOverride);
    const request: CteRequest = { with: steps, query: spec };
    const result = await activeTx.cte(request);
    const bound = limitOverride ?? cap;
    if (bound === undefined && result.rows.length > defaultCap) {
      authorMistake(`${baseTable}: CTE query returned more than ${defaultCap} rows; say how many with .limit(n).`);
    }
    return result.rows.map((row) => Object.freeze({ ...row }));
  };

  const joined: JoinedQuery<Record<string, unknown>> & { [CTE_SPEC]: () => CteQuerySpec } = {
    [CTE_SPEC]: () => buildSpec(),
    join(target, options) {
      const ref = target as InternalCteRef;
      joins.push({
        target: ref.__cteName,
        alias: options.alias ?? ref.__cteName,
        kind: options.kind ?? 'inner',
        on: options.on,
        steps: ref.__steps,
      });
      return joined as never;
    },
    where(conditions) {
      if (conditions && typeof conditions === 'object') whereParts.push(conditions);
      return joined;
    },
    select(...columns) {
      const seenOut = new Set<string>();
      selectedCols = columns.map((col) => {
        const dot = col.indexOf('.');
        const leaf = dot > 0 ? col.slice(dot + 1) : col;
        const alias = seenOut.has(leaf) ? col.replace(/\./g, '_') : leaf;
        seenOut.add(alias);
        return { column: col, alias };
      });
      return joined as never;
    },
    orderBy(column, direction = 'asc') {
      orderBy.push({ column, direction: direction === 'desc' ? 'desc' : 'asc' });
      return joined;
    },
    limit(count) {
      if (!Number.isSafeInteger(count) || count < 1) authorMistake(`${baseTable}: limit must be a positive whole number.`);
      cap = count;
      return joined;
    },
    first: async () => (await execute(1))[0],
    // eslint-disable-next-line unicorn/no-thenable -- lazy query evaluated when awaited, matching Query.
    then: (resolve, reject) => execute().then(resolve as never, reject),
  };
  return joined;
}

/** Creates the `cte(steps, run)` runner bound to a command/loader transaction. */
export function createCteRunner(
  tx: Pick<WriteTransaction, 'query' | 'count' | 'aggregate' | 'cte'>,
  defaultCap: number,
  compileFilter: CteContext['compileFilter'],
): CteRunner {
  return async function withCtes(steps, run) {
    if (!steps || typeof steps !== 'object' || Array.isArray(steps)) {
      authorMistake('cte(steps, run) expects an object of named CTE queries.');
    }
    const parentSteps = currentCteContext()?.steps ?? [];
    const builtSteps: CteStep[] = [...parentSteps];
    const refs: Record<string, InternalCteRef> = {};
    for (const [name, step] of Object.entries(steps)) {
      builtSteps.push(extractCteSpec(name, step));
    }
    const frozenSteps = Object.freeze([...builtSteps]);
    for (const name of Object.keys(steps)) {
      refs[name] = Object.freeze({ __cteName: name, __steps: frozenSteps });
    }
    const ctx: CteContext = { steps: frozenSteps, tx, defaultCap, compileFilter };
    return cteStorage.run(ctx, () => Promise.resolve(run(Object.freeze(refs) as never)));
  };
}

/** Builds a `CteQuerySpec` for a grouped aggregate query so `db.with({ stats: db.t.groupBy(...).aggregate(...) })` works seamlessly. */
export function buildGroupedCteSpec(
  table: string,
  filter: Filter | undefined,
  by: readonly CteGroupKey[],
  measures: readonly AggregateMeasure[],
  orderBy: readonly { readonly column: string; readonly direction: 'asc' | 'desc' }[],
  limit: number | undefined,
): CteQuerySpec {
  return {
    from: table,
    ...(filter?.groups.length ? { filter } : {}),
    ...(by.length ? { by } : {}),
    measures,
    ...(orderBy.length ? { orderBy } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}
