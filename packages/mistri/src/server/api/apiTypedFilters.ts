/** Typed data only, not SQL or principal/row-scope authorization. */
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { resolvePath } from '@mistriwork/engine/shared/view.js';
import { apiDialectOf, apiIntegerRepresentation, apiValueCodec } from './apiValueCodec.js';
import type { checkApiReadCatalog } from './apiReadCatalog.js';
import type { parseApiListParams } from './apiListParams.js';

type Value = string | number | boolean;
type Predicate =
  | { readonly field: string; readonly kind: 'equals'; readonly value: Value }
  | { readonly field: string; readonly kind: 'in'; readonly values: readonly Value[] }
  | { readonly field: string; readonly kind: 'range'; readonly min?: Value; readonly max?: Value };
const fail = (): never => {
  throw new TypeError('API filter value is unsupported or invalid for its exposed field.');
};

export function validateApiFilters(
  input: ReturnType<typeof parseApiListParams>['filters'],
  operation: ReturnType<typeof checkApiReadCatalog>['operations'][number],
  schema: DatabaseSchema,
  options: { integers: 'decimal-string' | 'number' },
) {
  const integers = apiIntegerRepresentation(options);
  // The lexical stage bounds input too; capture again so mutable/accessor
  // input cannot change a typed predicate or run code while it is inspected.
  const filters = snapshot(input, 16_384).value as unknown as typeof input;
  if (!Array.isArray(filters) || filters.length > 64) return fail();
  const allowed = new Set(operation.filters),
    fields = new Set(operation.fields),
    seen = new Set<string>();
  if ([...allowed].some((field) => !fields.has(field))) return fail();
  const predicates: Predicate[] = filters.map((filter) => {
    if (
      !filter ||
      Object.keys(filter).length !== 2 ||
      !Object.hasOwn(filter, 'field') ||
      !Object.hasOwn(filter, 'value') ||
      typeof filter.field !== 'string' ||
      !allowed.has(filter.field) ||
      seen.has(filter.field)
    )
      return fail();
    seen.add(filter.field);
    const resolved = resolvePath(schema, operation.resource, filter.field);
    const codec = apiValueCodec(resolved.column, apiDialectOf(schema, resolved.table.id), integers);
    const lexeme = (value: unknown): Value => {
      if (typeof value !== 'string' || !value.length) return fail();
      if (codec.kind === 'boolean') return codec.encode(value === 'true' ? true : value === 'false' ? false : fail());
      if (codec.kind === 'number') {
        if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$(?![\s\S])/.test(value)) return fail();
        const number = Number(value);
        if (number === 0 && /[1-9]/.test(value)) return fail(); // Do not underflow a nonzero boundary into zero.
        return codec.encode(number);
      }
      // Integers retain their exact digits until the shared chosen encoder;
      // a text column never interprets numeric-looking text as a number.
      return codec.encode(value);
    };
    const value = filter.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    if (value.kind === 'values') {
      if (Object.keys(value).length !== 2 || !Array.isArray(value.values) || !value.values.length || value.values.length > 100)
        return fail();
      const values = Object.freeze([...new Set(value.values.map(lexeme))]);
      return values.length === 1
        ? Object.freeze({ field: filter.field, kind: 'equals' as const, value: values[0] })
        : Object.freeze({ field: filter.field, kind: 'in' as const, values });
    }
    if (
      value.kind !== 'range' ||
      Object.keys(value).some((key) => !['kind', 'min', 'max'].includes(key)) ||
      (!Object.hasOwn(value, 'min') && !Object.hasOwn(value, 'max')) ||
      !['integer', 'number', 'date'].includes(codec.kind)
    )
      return fail();
    const min = Object.hasOwn(value, 'min') ? lexeme(value.min) : undefined;
    const max = Object.hasOwn(value, 'max') ? lexeme(value.max) : undefined;
    if (
      min !== undefined &&
      max !== undefined &&
      (codec.kind === 'integer'
        ? BigInt(String(min)) > BigInt(String(max))
        : codec.kind === 'date'
          ? String(min) > String(max)
          : Number(min) > Number(max))
    )
      return fail();
    return Object.freeze({
      field: filter.field,
      kind: 'range' as const,
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
    });
  });
  return Object.freeze({ stage: 'typed-read-filters' as const, authorization: 'pending' as const, predicates: Object.freeze(predicates) });
}
