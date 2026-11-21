/**
 * Whether a row, as a page holds it, plainly meets a condition written in the query language: what the browser asks
 * of a record to draw it read-only when its resource declares `frozen` (appModel.ts). The server judges the same
 * condition of the stored row on every write and refuses (409 `frozen`); this is only the reading that keeps an edit
 * affordance from being offered, so it fails open: a condition it cannot judge exactly (two columns compared, a path,
 * a pattern, a column the row does not carry) is not met, and the server's refusal stands as the answer.
 */
import type { Condition } from './filter.js';
import { ANYONE, parseQuery } from './query.js';
import { columnKind, type DatabaseSchema, type TableMeta } from './schema.js';

type Cell = string | number | boolean | null | undefined;

const parsed = new WeakMap<DatabaseSchema, Map<string, readonly (readonly Condition[])[] | null>>();

/** The condition's groups (ORed, each ANDed), or null where it does not parse over the table. */
function groupsOf(schema: DatabaseSchema, table: TableMeta, text: string): readonly (readonly Condition[])[] | null {
  let known = parsed.get(schema);
  if (!known) parsed.set(schema, (known = new Map()));
  const at = `${table.id} ${text}`;
  if (known.has(at)) return known.get(at)!;
  const result = parseQuery(at, { schema, columnValues: true, me: ANYONE });
  const groups = result.errors.length || !result.query ? null : result.query.filter.groups;
  known.set(at, groups);
  return groups;
}

const truthy = (value: unknown) => value === true || value === 1 || /^(1|true|t|yes|y)$/i.test(String(value));

function met(table: TableMeta, row: Readonly<Record<string, Cell>>, condition: Condition): boolean {
  if (condition.other !== undefined || condition.any !== undefined || condition.within !== undefined || condition.column.includes('.'))
    return false;
  if (!Object.hasOwn(row, condition.column)) return false;
  const column = table.columns.find((candidate) => candidate.name === condition.column);
  if (!column) return false;
  const value = row[condition.column];
  const empty = value === null || value === undefined;
  if (condition.op === 'isNull') return empty;
  if (condition.op === 'isNotNull') return !empty;
  if (empty) return false;
  const kind = columnKind(column.type);
  const same = (given: unknown): boolean =>
    given !== null &&
    given !== undefined &&
    (kind === 'number'
      ? Number(value) === Number(given)
      : kind === 'boolean'
        ? truthy(value) === truthy(given)
        : String(value) === String(given));
  const given = condition.value;
  switch (condition.op) {
    case '=':
      return !Array.isArray(given) && same(given);
    case '!=':
      return !Array.isArray(given) && given !== null && given !== undefined && !same(given);
    case 'in':
      return Array.isArray(given) && given.some(same);
    case '>':
    case '>=':
    case '<':
    case '<=': {
      if (Array.isArray(given) || given === null || given === undefined) return false;
      const [left, right] = kind === 'number' ? [Number(value), Number(given)] : [String(value), String(given)];
      if (kind !== 'number' && kind !== 'date') return false;
      if (typeof left === 'number' && Number.isNaN(left)) return false;
      return condition.op === '>'
        ? left > right
        : condition.op === '>='
          ? left >= right
          : condition.op === '<'
            ? left < right
            : left <= right;
    }
    default:
      return false;
  }
}

/** True when `row` plainly meets the condition `text` over `tableId`; false wherever that cannot be said exactly. */
export function rowMeetsCondition(
  schema: DatabaseSchema | undefined,
  tableId: string,
  text: string,
  row: Readonly<Record<string, Cell>>,
): boolean {
  const table = schema?.tables.find((candidate) => candidate.id === tableId);
  if (!schema || !table) return false;
  const groups = groupsOf(schema, table, text);
  return groups !== null && groups.some((group) => group.length > 0 && group.every((condition) => met(table, row, condition)));
}
