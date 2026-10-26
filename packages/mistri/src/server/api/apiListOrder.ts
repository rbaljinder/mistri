/** Deterministic metadata ordering, not a cursor or collation contract. */
import { primaryKey, resolveOrder, withKey, type Order, type TableMeta } from '@mistriwork/engine/shared/schema.js';

function refuse(reason: string): never {
  throw new Error(`API list order: ${reason}.`);
}
const identifier = (field: string) => /^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/.test(field);

/** Table is the logical catalog target. `fields` is the effective projection
 * after sparse-field narrowing; every ordering column and complete key must
 * remain present. Standing order has passed view validation but is checked
 * here against this operation's projection and local-only scope.
 */
export function resolveApiListOrder(
  table: TableMeta,
  exposure: { fields: readonly string[]; sorts: readonly string[] },
  requested: readonly { field: string; descending: boolean }[] = [],
  standing?: readonly Order[],
) {
  const fields = new Set(exposure.fields),
    allowed = new Set(exposure.sorts);
  const keys = primaryKey(table);
  if (table.isView || !keys.length || new Set(keys).size !== keys.length)
    refuse('a concrete table with a complete nonempty primary key is required');
  // A sort may be nullable (its nulls run last, apiReadView); the key that ends every order may not.
  const column = (field: string, key = false) => {
    if (typeof field !== 'string' || !identifier(field)) return refuse('joined or malformed ordering paths are unsupported');
    const found = table.columns.filter((item) => item.name === field);
    if (found.length !== 1 || (key && found[0].nullable !== false))
      return refuse('every ordering column must be present, and the key nonnullable');
    if (!fields.has(field)) return refuse('ordering column is absent from the exposed projection');
  };
  keys.forEach((key) => column(key, true));
  if (
    !Array.isArray(requested) ||
    requested.length > 256 ||
    Array.from(requested).some(
      (item) =>
        !item ||
        typeof item.field !== 'string' ||
        typeof item.descending !== 'boolean' ||
        Object.keys(item).sort().join(',') !== 'descending,field',
    )
  )
    refuse('malformed requested order');
  if (new Set(requested.map((item) => item.field)).size !== requested.length) refuse('duplicate requested sort field');
  const explicit: Order[] = requested.map((item) => {
    column(item.field);
    if (!allowed.has(item.field)) refuse('requested sort is not explicitly declared');
    return { column: item.field, direction: item.descending ? 'desc' : 'asc' };
  });
  if (
    standing !== undefined &&
    (!Array.isArray(standing) ||
      standing.length > 256 ||
      Array.from(standing).some((item) => !item || typeof item.column !== 'string' || !['asc', 'desc'].includes(item.direction)) ||
      new Set(standing.map((item) => item.column)).size !== standing.length)
  )
    refuse('malformed or duplicate standing order');
  const selected = explicit.length ? explicit : standing?.map((item) => ({ ...item }));
  const resolved = resolveOrder(table, selected);
  // Shared default heuristics may choose an indexed timestamp. The API does
  // not silently fall back when that timestamp is hidden; nullable, its nulls run last.
  const order = withKey(table, resolved.order);
  order.forEach((item) => column(item.column));
  return Object.freeze({
    stage: 'total-order' as const,
    source: explicit.length ? ('request' as const) : standing?.length ? ('standing' as const) : ('default' as const),
    cursorValidation: 'pending' as const,
    collationValidation: 'pending' as const,
    valueTyping: 'pending' as const,
    order: Object.freeze(order.map((item) => Object.freeze({ ...item }))),
  });
}
