/** Typed keyset boundary data; not cursor authentication or a SQL executor. */
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { declaredOrder, type DatabaseSchema, type Order } from '@mistriwork/engine/shared/schema.js';
import type { checkApiReadCatalog } from './apiReadCatalog.js';
import { resolveApiListOrder } from './apiListOrder.js';
import { createApiReadRowCodec } from './apiReadRowCodec.js';
import { apiDialectOf, apiValueCodec } from './apiValueCodec.js';

type Operation = ReturnType<typeof checkApiReadCatalog>['operations'][number];
type Term =
  | Readonly<{ field: string; operator: '=' | '>' | '<'; value: string | number | boolean; collation?: 'binary' }>
  | Readonly<{ field: string; operator: 'in'; value: readonly string[] }>
  | Readonly<{ field: string; operator: 'isNull'; value?: undefined }>;

/** Callers must authenticate a cursor and reauthorize the current request
 * separately. Its typed boundary is only an additional AND constraint; these
 * OR branches cannot replace standing questions, refinements or row policy.
 * Collation is not inferred from wire types: a text column's terms compare by
 * bytes, and the view that orders by it must order by bytes too
 * (apiReadView), so the database's own collation never decides either.
 */
export function createApiReadBoundaryCodec(
  operation: Operation,
  schema: DatabaseSchema,
  givenOrder: readonly Order[],
  options: { integers: 'decimal-string' | 'number' },
) {
  const table = schema.tables.find((table) => table.id === operation.resource);
  if (!table || operation.kind === 'item') throw new TypeError('API boundary requires an exposed list table.');
  const captured = snapshot(givenOrder, 16384).value as unknown as Order[];
  const { order } = resolveApiListOrder(table, operation, [], captured);
  if (order.length !== captured.length) throw new TypeError('API boundary order must already include the complete primary key.');
  const fields = order.map((item) => item.column);
  const row = createApiReadRowCodec({ ...operation, fields }, schema, options);
  const encode = (value: unknown) => row.encodeRow(value);
  const text = new Set(
    fields.filter(
      (field) =>
        apiValueCodec(
          table.columns.find((column) => column.name === field)!,
          apiDialectOf(schema, table.id),
          options.integers,
        ).kind === 'text',
    ),
  );
  // A vocabulary orders as declared (apiReadView): past a value are the values after it, named.
  // A nullable sort runs its nulls last in either direction (apiReadView).
  const nullable = new Set(fields.filter((field) => table.columns.find((column) => column.name === field)!.nullable !== false));
  const declared = new Map(
    fields.flatMap((field) => {
      const values = declaredOrder(table.columns.find((column) => column.name === field));
      return values ? [[field, values] as const] : [];
    }),
  );
  return Object.freeze({
    stage: 'typed-read-boundary' as const,
    cursorVerification: 'pending' as const,
    authorization: 'pending' as const,
    collationValidation: 'binary-text' as const,
    schema: row.schema,
    order,
    encode,
    after(value: unknown): readonly (readonly Term[])[] {
      const boundary = encode(value);
      for (const [field, values] of declared)
        if (boundary[field] !== null && !values.includes(boundary[field] as string))
          throw new TypeError('API boundary value is outside its vocabulary.');
      for (const field of fields)
        if (boundary[field] === null && !nullable.has(field)) throw new TypeError('API boundary value is null in a nonnullable column.');
      // Lexicographic continuation: a strict comparison at one position,
      // preceded by equality at every earlier position. Complete keys make
      // the final branch strict even when all user-selected sort values tie.
      // A vocabulary's strict step names the values past it, and a branch
      // with none past it (the last value) is no branch.
      // Past a null are no values (nulls are last); past a value of a
      // nullable column are the values beyond it and every null.
      const strict = (item: Order): Term[] => {
        if (boundary[item.column] === null) return [];
        const beyond = after(item);
        return nullable.has(item.column) ? [...beyond, Object.freeze({ field: item.column, operator: 'isNull' as const })] : beyond;
      };
      const after = (item: Order): Term[] => {
        const values = declared.get(item.column),
          at = boundary[item.column] as string | number | boolean;
        if (!values)
          return [
            Object.freeze({
              field: item.column,
              operator: item.direction === 'asc' ? ('>' as const) : ('<' as const),
              value: at,
              ...(text.has(item.column) ? { collation: 'binary' as const } : {}),
            }),
          ];
        const rank = values.indexOf(at as string),
          past = item.direction === 'asc' ? values.slice(rank + 1) : values.slice(0, rank);
        return past.length ? [Object.freeze({ field: item.column, operator: 'in' as const, value: Object.freeze([...past]) })] : [];
      };
      return Object.freeze(
        order.flatMap((item, index) => {
          const same = order.slice(0, index).map((part): Term =>
            boundary[part.column] === null
              ? Object.freeze({ field: part.column, operator: 'isNull' as const })
              : Object.freeze({
                  field: part.column,
                  operator: '=' as const,
                  value: boundary[part.column] as string | number | boolean,
                  // Equality too: a nondeterministic collation can call two
                  // different strings equal, and the key would stop being strict.
                  ...(text.has(part.column) ? { collation: 'binary' as const } : {}),
                }),
          );
          return strict(item).map((last) => Object.freeze([...same, last]));
        }),
      );
    },
  });
}
