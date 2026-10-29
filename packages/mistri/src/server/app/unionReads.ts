/**
 * A union's reads (shared/appUnions.ts): one list over several tables, in one
 * order and one page, asked of each branch through the reader it is given —
 * so each branch is read under that reader's grants, row policy and hidden
 * columns, as a read of the table alone would be — and merged here. No
 * statement names two tables, so this works the same on every engine and in a
 * tenant's context, and a branch is never read past what its reader may.
 *
 * A page is `offset + limit` rows from each branch, merged by the order and
 * cut: the first rows of a merge depend only on the rows before them, so page
 * two never repeats or skips a row of page one, whatever the engines' text
 * collations. Ties go to the earlier branch; with no order, a union reads
 * its branches one after another.
 *
 * What a union cannot answer — a path through a reference, a summary, a
 * breakdown — is refused as a question asked wrongly (PathError), never sent
 * to the database as a table it does not have.
 */
import type { Adapter, CountItem, QueryRequest, ViewResult } from '@mistriwork/engine/adapters/adapter.js';
import { UNION_FROM, UNION_KEY, type UnionTable } from '../../shared/appUnions.js';
import type { Condition, Filter } from '@mistriwork/engine/shared/filter.js';
import type { QueryResult } from '@mistriwork/engine/shared/reads.js';
import { findTable, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { PathError, type ViewCondition, type ViewDef, type ViewFilter, type ViewOrder } from '@mistriwork/engine/shared/viewPaths.js';

type Branch = UnionTable['branches'][number];
type Row = Record<string, unknown>;

const refuse = (union: string, path: string, why: string): never => {
  throw new PathError(`"${union}" is a union: ${why}`, path, path, 0);
};

/** A union column as this branch names it; `from` is answered here and never asked. */
function local(union: string, branch: Branch, column: string): string {
  if (column === UNION_KEY) return branch.key;
  const named = branch.as[column];
  if (named === undefined) return refuse(union, column, `it reads its own columns, and "${column}" is not one of them.`);
  return named;
}

/** Whether `from` holds for this branch: the one column a union answers itself. */
function fromHolds(union: string, branch: Branch, condition: { op: string; value?: unknown }): boolean {
  const value = condition.value;
  if (condition.op === '=') return value === branch.from;
  if (condition.op === '!=') return value !== branch.from;
  if (condition.op === 'in' && Array.isArray(value)) return value.includes(branch.from);
  return refuse(union, UNION_FROM, `"${UNION_FROM}" is compared with =, != or in.`);
}

/**
 * A filter as one branch asks it: `null` when no row of the branch could
 * match (every group says another `from`), undefined when every row could.
 */
function branchGroups<C extends { op: string; value?: unknown; other?: string }>(
  union: string,
  branch: Branch,
  groups: readonly (readonly C[])[] | undefined,
  name: (condition: C) => string,
  rename: (condition: C, to: string) => C,
): C[][] | null | undefined {
  if (!groups?.length) return undefined;
  const kept: C[][] = [];
  for (const group of groups) {
    let holds = true;
    const asked: C[] = [];
    for (const given of group) {
      let condition = given;
      const column = name(condition);
      if (column === UNION_FROM) {
        holds &&= fromHolds(union, branch, condition);
        continue;
      }
      if (condition.other !== undefined) {
        if (condition.other === UNION_FROM) refuse(union, UNION_FROM, `"${UNION_FROM}" is compared with a value.`);
        condition = { ...condition, other: local(union, branch, condition.other) };
      }
      asked.push(rename(condition, local(union, branch, column)));
    }
    if (!holds) continue;
    if (!asked.length) return undefined;
    kept.push(asked);
  }
  return kept.length ? kept : null;
}

function filterFor(union: string, branch: Branch, filter: Filter | undefined): Filter | null | undefined {
  const groups = branchGroups<Condition>(
    union,
    branch,
    filter?.groups,
    (condition) => condition.column,
    (condition, column) => ({ ...condition, column }),
  );
  return groups && { groups };
}

function viewFilterFor(union: string, branch: Branch, filter: ViewFilter | undefined): ViewFilter | null | undefined {
  const groups = branchGroups<ViewCondition>(
    union,
    branch,
    filter?.groups,
    (condition) => condition.path,
    (condition, path) => ({ ...condition, path }),
  );
  return groups && { groups };
}

/* Null first, as SQLite sorts it; numbers by value, the rest by text. */
function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = String(a),
    y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The rows `offset` to `offset + limit` of the branches' rows merged by `order`, each branch already in it. */
function merged(answers: Row[][], order: readonly { column: string; direction: 'asc' | 'desc' }[], offset: number, limit: number): Row[] {
  const at = answers.map(() => 0);
  const out: Row[] = [];
  while (out.length < offset + limit) {
    let best = -1;
    for (let i = 0; i < answers.length; i++) {
      if (at[i]! >= answers[i]!.length) continue;
      if (best < 0) {
        best = i;
        continue;
      }
      const a = answers[i]![at[i]!]!,
        b = answers[best]![at[best]!]!;
      for (const { column, direction } of order) {
        const c = compare(a[column], b[column]) * (direction === 'desc' ? -1 : 1);
        if (c < 0) best = i;
        if (c !== 0) break;
      }
    }
    if (best < 0) break;
    out.push(answers[best]![at[best]!++]!);
  }
  return out.slice(offset);
}

/** A branch's row as the union's: its columns renamed, its branch and key beside them. */
function unionRow(branch: Branch, row: Row, columns: readonly string[]): Row {
  const out: Row = {};
  for (const column of columns) {
    if (column === UNION_FROM) out[column] = branch.from;
    else if (column === UNION_KEY) out[column] = row[branch.key];
    else out[column] = row[branch.as[column]!];
  }
  return out;
}

function unionOf(schema: DatabaseSchema, table: string): TableMeta | undefined {
  const found = findTable(schema, table);
  return found?.union ? found : undefined;
}

/**
 * `adapter`, with every read of a union in `schema` answered by its branches.
 * Without a union, `adapter` itself.
 */
export function unionReads(adapter: Adapter, schema: DatabaseSchema): Adapter {
  if (!schema.tables.some((table) => table.union)) return adapter;
  const delegate: Record<string, unknown> = {};
  for (let o: object | null = adapter; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Object.getOwnPropertyNames(o)) {
      if (key === 'constructor' || key in delegate) continue;
      const value = (adapter as unknown as Record<string, unknown>)[key];
      delegate[key] = typeof value === 'function' ? value.bind(adapter) : value;
    }
  }
  const base = delegate as unknown as Adapter;

  const query = async (request: QueryRequest): Promise<QueryResult> => {
    const table = unionOf(schema, request.table);
    if (!table) return base.query(request);
    const union = table.id;
    const columns = request.columns?.length ? request.columns : table.columns.map((column) => column.name);
    /* `from` orders the branches themselves: each branch is one value of it, so it is never asked. */
    const order = request.orderBy ?? [];
    const asks = order.filter((by) => by.column !== UNION_FROM);
    const started = performance.now();
    const answers = await Promise.all(
      table.union!.branches.map(async (branch) => {
        const filter = filterFor(union, branch, request.filter);
        if (filter === null) return [];
        const asked = [
          ...new Set([
            branch.key,
            ...columns.filter((c) => c !== UNION_FROM && c !== UNION_KEY).map((c) => local(union, branch, c)),
            ...asks.map((by) => local(union, branch, by.column)),
          ]),
        ];
        const got = await base.query({
          table: branch.from,
          columns: asked,
          ...(filter ? { filter } : {}),
          ...(asks.length ? { orderBy: asks.map((by) => ({ column: local(union, branch, by.column), direction: by.direction })) } : {}),
          limit: request.offset + request.limit,
          offset: 0,
        });
        return got.rows.map((row) => unionRow(branch, row, [...new Set([...columns, ...order.map((by) => by.column)])]));
      }),
    );
    const rows = merged(answers, order, request.offset, request.limit).map((row) =>
      Object.fromEntries(columns.map((column) => [column, row[column]])),
    );
    return {
      columns: [...columns],
      rows,
      ms: Math.round(performance.now() - started),
      sql: { text: `-- ${union}: one read per branch, merged`, params: [] },
    };
  };

  const count = async (name: string, filter?: Filter, limit?: number): Promise<number> => {
    const table = unionOf(schema, name);
    if (!table) return base.count(name, filter, limit);
    const counts = await Promise.all(
      table.union!.branches.map((branch) => {
        const asked = filterFor(table.id, branch, filter);
        return asked === null ? 0 : base.count(branch.from, asked, limit);
      }),
    );
    const total = counts.reduce((sum, n) => sum + n, 0);
    return limit === undefined ? total : Math.min(total, limit);
  };

  /* A view of a union is its own columns, each as a branch names it: nothing past them. */
  const viewFor = (view: ViewDef, branch: Branch, table: TableMeta, outputs: readonly string[]): ViewDef | null => {
    const filter = viewFilterFor(table.id, branch, view.filter);
    if (filter === null) return null;
    const asks = (view.orderBy ?? []).filter((by) => by.path !== UNION_FROM);
    return {
      id: view.id,
      name: view.name,
      base: branch.from,
      columns: [
        { path: branch.key, alias: `${UNION_KEY}` },
        ...outputs
          .filter((name) => name !== UNION_FROM && name !== UNION_KEY)
          .map((name) => ({ path: local(table.id, branch, name), alias: name })),
      ],
      ...(filter ? { filter } : {}),
      ...(asks.length ? { orderBy: asks.map((by) => ({ path: local(table.id, branch, by.path), direction: by.direction })) } : {}),
    };
  };
  const viewOutputs = (view: ViewDef, table: TableMeta): string[] => {
    if (view.aggregates?.length) refuse(table.id, view.aggregates[0]!.alias ?? 'aggregate', 'it reads its own columns, not summaries.');
    for (const by of view.orderBy ?? []) {
      if (by.alias || by.near !== undefined) refuse(table.id, by.path, 'it is ordered by its own columns.');
    }
    const outputs = view.columns.map((column) => {
      if (column.path.includes('.') || !table.columns.some((c) => c.name === column.path))
        refuse(table.id, column.path, `it reads its own columns, and "${column.path}" is not one of them.`);
      return column.path;
    });
    return [...new Set([...outputs, ...(view.orderBy ?? []).map((by) => by.path)])];
  };

  const runView = async (view: ViewDef, offset = 0): Promise<ViewResult> => {
    const table = unionOf(schema, view.base);
    if (!table) return base.runView!(view, offset);
    const outputs = viewOutputs(view, table);
    const limit = view.limit ?? 50;
    const started = performance.now();
    const answers = await Promise.all(
      table.union!.branches.map(async (branch) => {
        const asked = viewFor(view, branch, table, outputs);
        if (!asked) return [];
        const got = await base.runView!({ ...asked, limit: offset + limit }, 0);
        return got.rows.map((row) => ({ ...row, [UNION_FROM]: branch.from }));
      }),
    );
    const order = (view.orderBy ?? []).map((by: ViewOrder) => ({ column: by.path, direction: by.direction }));
    const shown = view.columns.map((column) => column.alias ?? column.path);
    const rows = merged(answers, order, offset, limit).map((row) =>
      Object.fromEntries(view.columns.map((column) => [column.alias ?? column.path, row[column.path]])),
    );
    return {
      columns: shown,
      rows,
      ms: Math.round(performance.now() - started),
      sql: { text: `-- ${table.id}: one read per branch, merged`, params: [] },
      resolved: view.columns.map((column) => {
        const meta = table.columns.find((c) => c.name === column.path)!;
        return {
          path: column.path,
          name: column.alias ?? column.path,
          table: table.id,
          column: meta.name,
          type: meta.type,
          nullable: meta.nullable,
          primaryKey: meta.primaryKey,
          hops: 0,
        };
      }),
      joins: [],
    };
  };

  const countView = async (view: ViewDef, limit?: number): Promise<number> => {
    const table = unionOf(schema, view.base);
    if (!table) return base.countView!(view, limit);
    const outputs = viewOutputs(view, table);
    const counts = await Promise.all(
      table.union!.branches.map((branch) => {
        const asked = viewFor(view, branch, table, outputs);
        return asked ? base.countView!(asked, limit) : 0;
      }),
    );
    const total = counts.reduce((sum, n) => sum + n, 0);
    return limit === undefined ? total : Math.min(total, limit);
  };

  return {
    ...base,
    query,
    count,
    ...(base.runView ? { runView } : {}),
    ...(base.countView ? { countView } : {}),
    ...(base.estimateCount
      ? { estimateCount: (name: string) => (unionOf(schema, name) ? Promise.resolve(undefined) : base.estimateCount!(name)) }
      : {}),
    ...(base.countEach
      ? {
          countEach: async (items: readonly CountItem[], limit?: number) =>
            items.some((item) => unionOf(schema, item.table))
              ? Promise.all(items.map((item) => count(item.table, item.filter, limit)))
              : base.countEach!(items, limit),
        }
      : {}),
    ...(base.runBreakdown
      ? {
          runBreakdown: (definition: Parameters<NonNullable<Adapter['runBreakdown']>>[0], offset?: number) =>
            unionOf(schema, definition.base)
              ? refuse(definition.base, definition.base, 'it is listed, not broken down.')
              : base.runBreakdown!(definition, offset),
        }
      : {}),
  };
}
