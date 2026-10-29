/**
 * One real row, and everything it needs to exist.
 *
 * Test data is written by hand because getting it out of a real database
 * means walking the foreign keys by hand: an invoice needs its customer, the
 * customer needs its country, and a fixture missing any of them does not
 * load. That walk is the thing this tool already does, so extracting a
 * loadable fixture is the graph pointed at a different question.
 *
 * The rule the output has to satisfy: **inserted in the order given, nothing
 * dangles.** So every row reached from a row already in the set is reached
 * too — the parents of the children as well as the parents of the root — and
 * the tables come back in `insertOrder`'s order, with self-referencing tables
 * sorted inside themselves.
 *
 * Bounded, and it says where it stopped. A row two hops from `customer` in a
 * well-connected schema can reach most of the database, and a fixture that
 * quietly contains half of production is worse than one that says it was cut.
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { findTable, primaryKey, referencesFrom, referencesTo, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { insertOrder } from '@mistriwork/engine/shared/order.js';

interface FixtureOptions {
  /** How many reference hops to follow away from the row. */
  depth?: number;
  /** Include rows that point *at* the root, not only the rows it points at. */
  children?: boolean;
  /** How many children to take per relationship. */
  perChild?: number;
  /** A ceiling on the whole fixture. */
  max?: number;
}

interface FixtureResult {
  table: string;
  key: Record<string, unknown>;
  /** Tables in the order they must be inserted, each with its rows. */
  tables: Array<{ table: string; rows: Array<Record<string, unknown>> }>;
  /** The same order, as a list — the order a teardown reverses. */
  order: string[];
  /** Ready to paste. Values are literals, because this is a document. */
  sql: string;
  /** What was left out, and why. Absent when nothing was. */
  truncated?: string[];
  rowsRead: number;
}

const DEFAULTS = { depth: 3, perChild: 5, max: 100 };

export async function extractFixture(
  adapter: Adapter,
  schema: DatabaseSchema,
  tableId: string,
  key: Record<string, string | number>,
  options: FixtureOptions = {},
): Promise<FixtureResult> {
  const depth = Math.max(0, Math.min(6, options.depth ?? DEFAULTS.depth));
  const perChild = Math.max(1, Math.min(50, options.perChild ?? DEFAULTS.perChild));
  const max = Math.max(1, Math.min(500, options.max ?? DEFAULTS.max));

  const root = findTable(schema, tableId);
  if (!root) throw new Error(`Unknown table "${tableId}".`);

  /** table id → row identity → row. The identity keeps a row from being taken twice. */
  const collected = new Map<string, Map<string, Record<string, unknown>>>();
  const truncated: string[] = [];
  let rowsRead = 0;

  const identity = (table: string, row: Record<string, unknown>) => {
    const pk = primaryKey(findTable(schema, table)!);
    return pk.length
      ? JSON.stringify(pk.map((c) => row[c]))
      : /* A keyless table cannot be deduped by key, so the whole row is its
         own identity — which is right: two identical rows are one row as far
         as a fixture is concerned. */
        JSON.stringify(row);
  };

  const total = () => [...collected.values()].reduce((n, rows) => n + rows.size, 0);

  const take = (table: string, row: Record<string, unknown>) => {
    const rows = collected.get(table) ?? new Map();
    collected.set(table, rows);
    const id = identity(table, row);
    if (rows.has(id)) return false;
    if (total() >= max) {
      if (!truncated.includes(`the ${max}-row ceiling`)) truncated.push(`the ${max}-row ceiling`);
      return false;
    }
    rows.set(id, row);
    return true;
  };

  const fetch = async (table: string, filter: Array<{ column: string; value: string | number }>, limit: number) => {
    const found = await adapter.query({
      table,
      filter: { groups: [filter.map((c) => ({ column: c.column, op: '=' as const, value: c.value }))] },
      limit,
      offset: 0,
    });
    rowsRead += found.rows.length;
    return found.rows as Array<Record<string, unknown>>;
  };

  const rootRows = await fetch(
    root.id,
    primaryKey(root).map((c) => ({ column: c, value: key[c] })),
    1,
  );
  if (!rootRows.length) throw new Error(`No ${root.name} with that key.`);
  take(root.id, rootRows[0]);

  /* Children first, so that their parents are picked up by the same walk
     that resolves the root's — a child pointing at an employee nobody
     collected is a fixture that does not load. */
  const queue: Array<{ table: string; row: Record<string, unknown>; hop: number }> = [{ table: root.id, row: rootRows[0], hop: 0 }];

  if (options.children) {
    for (const fk of referencesTo(schema, root.id)) {
      if (total() >= max) break;
      const child = findTable(schema, fk.from.table);
      if (!child) continue;
      const rows = await fetch(
        child.id,
        fk.from.columns.map((column, i) => ({
          column,
          value: rootRows[0][fk.to.columns[i]] as string | number,
        })),
        perChild,
      );
      if (rows.length === perChild) truncated.push(`${child.name} at ${perChild} rows`);
      for (const row of rows) {
        if (take(child.id, row)) queue.push({ table: child.id, row, hop: 0 });
      }
    }
  }

  /* Then upwards from everything collected: the rows each one points at. */
  while (queue.length) {
    const { table, row, hop } = queue.shift()!;
    if (hop >= depth) continue;
    for (const fk of referencesFrom(schema, table)) {
      const values = fk.from.columns.map((c) => row[c]);
      if (values.some((v) => v === null || v === undefined)) continue;
      const parent = findTable(schema, fk.to.table);
      if (!parent) continue;
      const rows = await fetch(
        parent.id,
        fk.to.columns.map((column, i) => ({ column, value: values[i] as string | number })),
        1,
      );
      for (const found of rows) {
        if (take(parent.id, found)) queue.push({ table: parent.id, row: found, hop: hop + 1 });
      }
    }
  }

  const plan = insertOrder(schema, [...collected.keys()]);
  /* Anything the sort could not place still has to come out somewhere, and
     the end is the honest place for it — the cycle is named in `order`. */
  const ordered = [...plan.insert, ...plan.cycles.flat()];

  const tables = ordered
    .filter((id) => collected.has(id))
    .map((id) => ({
      table: id,
      rows: sortWithin(schema, id, [...collected.get(id)!.values()]),
    }));

  if (plan.cycles.length) {
    truncated.push(`a cycle between ${plan.cycles.flat().join(', ')} — those inserts need a nullable column set afterwards`);
  }

  return {
    table: root.id,
    key,
    tables,
    order: tables.map((t) => t.table),
    sql: toSql(schema, tables),
    truncated: truncated.length ? truncated : undefined,
    rowsRead,
  };
}

/**
 * Rows of a self-referencing table, parents before children.
 *
 * `work_order.parent_id → work_order` orders the rows inside the table
 * rather than the table against another one, and a fixture that inserts the
 * child first fails on exactly the constraint this whole function exists to
 * respect. Rows whose parent is not in the fixture are unconstrained and go
 * first.
 */
function sortWithin(schema: DatabaseSchema, tableId: string, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const self = referencesFrom(schema, tableId).filter((fk) => fk.to.table === tableId);
  if (!self.length || rows.length < 2) return rows;

  const table = findTable(schema, tableId)!;
  const pk = primaryKey(table);
  if (!pk.length) return rows;

  const idOf = (row: Record<string, unknown>) => JSON.stringify(pk.map((c) => row[c]));
  const present = new Map(rows.map((row) => [idOf(row), row]));
  const placed = new Set<string>();
  const out: Array<Record<string, unknown>> = [];

  const place = (row: Record<string, unknown>, seen: Set<string>) => {
    const id = idOf(row);
    if (placed.has(id) || seen.has(id)) return;
    seen.add(id);
    for (const fk of self) {
      const parentId = JSON.stringify(fk.from.columns.map((c) => row[c]));
      const parent = present.get(parentId);
      if (parent) place(parent, seen);
    }
    if (placed.has(id)) return;
    placed.add(id);
    out.push(row);
  };

  for (const row of rows) place(row, new Set());
  return out;
}

/**
 * The fixture as SQL.
 *
 * Values are written as literals rather than bound, which is the one place
 * in this codebase that happens — because this is a *document*, not a
 * statement the server runs. Nothing here reaches a database; it reaches a
 * file, a test, or a paste buffer, and a parameter list would make it
 * useless for all three.
 */
function toSql(schema: DatabaseSchema, tables: Array<{ table: string; rows: Array<Record<string, unknown>> }>): string {
  const lines: string[] = [];
  for (const { table, rows } of tables) {
    if (!rows.length) continue;
    const meta = findTable(schema, table);
    const columns = meta?.columns.map((c) => c.name) ?? Object.keys(rows[0]);
    lines.push(`-- ${table}`);
    for (const row of rows) {
      const present = columns.filter((c) => row[c] !== undefined);
      lines.push(
        `INSERT INTO ${quoteName(meta?.name ?? table)} (${present.map(quoteName).join(', ')}) ` +
          `VALUES (${present.map((c) => literal(row[c])).join(', ')});`,
      );
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

const quoteName = (id: string) => `"${id.replace(/"/g, '""')}"`;

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  /* Doubling the quote is the standard escape and the only one every dialect
     here agrees on. */
  return `'${String(value).replace(/'/g, "''")}'`;
}
