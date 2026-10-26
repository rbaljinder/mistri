/**
 * The diagram's geometry, as numbers: which columns a node lists and how
 * tall that makes it, where the neighbourhood's three columns sit, and
 * the dependency-depth layout of the whole schema. Pure, so the drawing
 * can be tested without drawing.
 */
import { labelColumn } from '../core.js';
import type { ColumnMeta, TableMeta } from '@mistriwork/engine/shared/schema.js';

export interface Fk {
  name: string;
  from: { table: string; columns: string[] };
  to: { table: string; columns: string[] };
}
export interface Schema {
  label?: string;
  tables: TableMeta[];
  foreignKeys: Fk[];
}

export const NODE_W = 216;
export const HEAD_H = 30;
export const FIELD_H = 17;
export const NODE_PAD = 5;
const ROW_GAP = 18;
export const COL_GAP = 156;
export const PREVIEW_FIELDS = 5;
/** Characters an edge label can carry before it would reach a node. */
export const EDGE_LABEL_BUDGET = 22;
export const NAME_BUDGET = 18;
const TYPE_BUDGET = 12;
export const S_COL_GAP = 96;
const S_ROW_GAP = 18;
export const DENSE_SCHEMA = 24;
/** How many of a dense schema's tables the overview opens with. */
export const HUB_TABLES = 12;

/** Key, references, the label column, then the rest, each in declared order. */
export function orderedColumns(table: TableMeta): ColumnMeta[] {
  const label = labelColumn(table) as string | undefined;
  const rank = (c: ColumnMeta) => (c.primaryKey ? 0 : c.references ? 1 : c.name === label ? 2 : 3);
  return [...table.columns]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map(({ c }) => c);
}

const TYPE_ALIAS = new Map([
  ['timestamp with time zone', 'timestamptz'],
  ['timestamp without time zone', 'timestamp'],
  ['time with time zone', 'timetz'],
  ['time without time zone', 'time'],
  ['character varying', 'varchar'],
  ['character', 'char'],
  ['double precision', 'float8'],
  ['integer', 'int'],
  ['boolean', 'bool'],
]);

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function shortType(type?: string): string {
  if (!type) return '';
  const lower = type.toLowerCase();
  const alias = TYPE_ALIAS.get(lower) ?? TYPE_ALIAS.get(lower.replace(/\(.*\)$/, '').trim());
  return clip(alias ?? type, TYPE_BUDGET);
}

export function nodeHeight(table: TableMeta | undefined, open: boolean, preview = PREVIEW_FIELDS): number {
  if (!table?.columns.length) return HEAD_H;
  const total = table.columns.length;
  const shown = open ? total : Math.min(preview, total);
  const more = shown < total || open ? 1 : 0;
  if (!shown && !more) return HEAD_H;
  return HEAD_H + NODE_PAD + (shown + more) * FIELD_H + NODE_PAD;
}

interface Neighbour {
  table: string;
  columns: string[];
}
interface NeighbourhoodLayout {
  left: Array<Neighbour & { top: number }>;
  right: Array<Neighbour & { top: number }>;
  self: Fk[];
  width: number;
  height: number;
  leftX: number;
  midX: number;
  rightX: number;
  focusTop: number;
  focusAnchor: number;
  drawn: Set<string>;
}

/** One table and what it touches, laid out from measured heights rather than a fixed row pitch. */
export function neighbourhoodLayout(schema: Schema, tableId: string, heightOf: (id: string) => number): NeighbourhoodLayout | null {
  const out = schema.foreignKeys.filter((fk) => fk.from.table === tableId && fk.to.table !== tableId);
  const back = schema.foreignKeys.filter((fk) => fk.to.table === tableId && fk.from.table !== tableId);
  const self = schema.foreignKeys.filter((fk) => fk.from.table === tableId && fk.to.table === tableId);
  /* Several keys can join the same pair of tables; one node per table, with the columns collected onto the edge. */
  const group = (keys: Fk[], side: 'out' | 'in'): Neighbour[] => {
    const byTable = new Map<string, Neighbour>();
    for (const fk of keys) {
      const other = side === 'out' ? fk.to.table : fk.from.table;
      const entry = byTable.get(other) ?? { table: other, columns: [] };
      entry.columns.push(fk.from.columns.join(', '));
      byTable.set(other, entry);
    }
    return [...byTable.values()];
  };
  const left = group(out, 'out');
  const right = group(back, 'in');
  if (!left.length && !right.length && !self.length) return null;
  const stack = (nodes: Neighbour[]) => {
    const heights = nodes.map((n) => heightOf(n.table));
    const total = heights.reduce((a, b) => a + b, 0) + Math.max(0, nodes.length - 1) * ROW_GAP;
    let offset = 0;
    const tops = heights.map((h) => {
      const at = offset;
      offset += h + ROW_GAP;
      return at;
    });
    return { total, tops };
  };
  const l = stack(left);
  const r = stack(right);
  const focusHeight = heightOf(tableId);
  const selfRoom = self.length ? 46 : 0;
  const extent = Math.max(l.total, r.total, focusHeight);
  const height = extent + selfRoom + 30;
  const columns = 1 + (left.length ? 1 : 0) + (right.length ? 1 : 0);
  const width = NODE_W * columns + COL_GAP * (columns - 1);
  const top = (blockTotal: number) => selfRoom + 15 + (extent - blockTotal) / 2;
  const midX = left.length ? NODE_W + COL_GAP : 0;
  const focusTop = top(focusHeight);
  return {
    left: left.map((n, i) => ({ ...n, top: top(l.total) + l.tops[i] })),
    right: right.map((n, i) => ({ ...n, top: top(r.total) + r.tops[i] })),
    self,
    width,
    height,
    leftX: 0,
    midX,
    rightX: midX + NODE_W + COL_GAP,
    focusTop,
    /* Edges meet a node at its header, which stays put as the body grows. */
    focusAnchor: focusTop + HEAD_H / 2,
    drawn: new Set([tableId, ...out.map((fk) => fk.to.table), ...back.map((fk) => fk.from.table)]),
  };
}

/** Longest chain of references out of each table, capped against cycles. */
export function dependencyDepth(tables: TableMeta[], keys: Fk[]): Map<string, number> {
  const out = new Map(tables.map((t) => [t.id, [] as string[]]));
  for (const fk of keys) {
    if (fk.from.table === fk.to.table) continue; // a self-reference adds no depth
    out.get(fk.from.table)?.push(fk.to.table);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const walk = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    /* A cycle has no well-defined depth; breaking it at 0 keeps the layout stable. */
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const targets = out.get(id) ?? [];
    const d = targets.length ? 1 + Math.max(...targets.map(walk)) : 0;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const t of tables) walk(t.id);
  return depth;
}

/** The most-connected tables, name as the tiebreak so the same schema always opens on the same picture. */
function hubTables(tables: TableMeta[], foreignKeys: Fk[]): TableMeta[] {
  const degree = new Map<string, number>();
  const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1);
  for (const fk of foreignKeys) {
    bump(fk.from.table);
    if (fk.to.table !== fk.from.table) bump(fk.to.table);
  }
  return [...tables].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id)).slice(0, HUB_TABLES);
}

/** The focused tables and one hop out from each. */
export function inScope(tables: TableMeta[], foreignKeys: Fk[], focused: Set<string>): TableMeta[] {
  if (!focused.size) return tables;
  const keep = new Set(focused);
  for (const fk of foreignKeys) {
    if (focused.has(fk.from.table)) keep.add(fk.to.table);
    if (focused.has(fk.to.table)) keep.add(fk.from.table);
  }
  return tables.filter((t) => keep.has(t.id));
}

interface SchemaLayout {
  tables: TableMeta[];
  foreignKeys: Fk[];
  pos: Map<string, { x: number; top: number; y: number }>;
  width: number;
  height: number;
  levels: number;
  preview: number;
  trimmed: boolean;
}

/**
 * Every table at once, ranked by dependency depth: tables that reference
 * nothing in the first column, tables that reference only those in the
 * second, and so on. Reading left to right is the order you would insert in.
 */
export function schemaLayout(
  schema: Schema,
  focused: Set<string>,
  showEverything: boolean,
  heightOf: (table: TableMeta, preview: number) => number,
): SchemaLayout | null {
  const { tables: allTables, foreignKeys: allKeys } = schema;
  if (!allTables.length) return null;
  /* Dense and unfocused opens on the hubs, not the hairball. */
  const trimmed = !focused.size && !showEverything && allTables.length > DENSE_SCHEMA;
  const tables = trimmed ? hubTables(allTables, allKeys) : inScope(allTables, allKeys, focused);
  const visible = new Set(tables.map((t) => t.id));
  const foreignKeys = allKeys.filter((fk) => visible.has(fk.from.table) && visible.has(fk.to.table));
  const preview = tables.length > DENSE_SCHEMA ? 0 : PREVIEW_FIELDS;
  const depth = dependencyDepth(tables, foreignKeys);
  const columns = new Map<number, TableMeta[]>();
  for (const t of tables) {
    const d = depth.get(t.id) ?? 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(t);
  }
  const order = [...columns.keys()].sort((a, b) => a - b);
  for (const d of order) columns.get(d)!.sort((a, b) => a.id.localeCompare(b.id));
  const heights = new Map(tables.map((t) => [t.id, heightOf(t, preview)]));
  const columnTotal = (list: TableMeta[]) =>
    list.reduce((sum, t) => sum + heights.get(t.id)!, 0) + Math.max(0, list.length - 1) * S_ROW_GAP;
  const tallest = Math.max(...order.map((d) => columnTotal(columns.get(d)!)));
  const width = order.length * NODE_W + (order.length - 1) * S_COL_GAP;
  const height = tallest + 24;
  const pos = new Map<string, { x: number; top: number; y: number }>();
  order.forEach((d, col) => {
    const list = columns.get(d)!;
    let top = 12 + (tallest - columnTotal(list)) / 2;
    for (const t of list) {
      pos.set(t.id, { x: col * (NODE_W + S_COL_GAP), top, y: top + HEAD_H / 2 });
      top += heights.get(t.id)! + S_ROW_GAP;
    }
  });
  return { tables, foreignKeys, pos, width, height, levels: order.length, preview, trimmed };
}
