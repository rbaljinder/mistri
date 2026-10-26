/** Private parameter schema, not a raw-query validator or caller authority. */
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { resolvePath } from '@mistriwork/engine/shared/view.js';
import type { checkApiReadCatalog } from './apiReadCatalog.js';
import { apiDialectOf, apiIntegerRepresentation, apiValueCodec } from './apiValueCodec.js';
import { parseApiListParams } from './apiListParams.js';

export function createApiFilterParameter(
  field: string,
  operation: ReturnType<typeof checkApiReadCatalog>['operations'][number],
  schema: DatabaseSchema,
  options: { integers: 'number' | 'decimal-string' },
) {
  // Reuse the lexical boundary's metadata/reserved-control rules.
  parseApiListParams('', operation);
  if (!operation.fields.includes(field) || !operation.filters.includes(field)) throw new TypeError('Filter is not explicitly exposed.');
  const resolved = resolvePath(schema, operation.resource, field);
  const codec = apiValueCodec(resolved.column, apiDialectOf(schema, resolved.table.id), apiIntegerRepresentation(options));
  const values = Object.freeze({ type: 'array', minItems: 1, maxItems: 100, items: codec.schema });
  const numeric = codec.kind === 'integer' || codec.kind === 'number';
  const ranged = numeric || codec.kind === 'date';
  const endpoint =
    codec.kind === 'date'
      ? '[0-9]{4}-[0-9]{2}-[0-9]{2}'
      : codec.kind === 'integer'
        ? '(?:0|[1-9][0-9]*|-[1-9][0-9]*)'
        : '-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?';
  // At least one bound; decimal dots must not consume the range separator.
  // This is lexical only: the shared encoder still checks each endpoint's
  // bounds/enum/underflow and the typed stage checks their relative order.
  const range = Object.freeze({ type: 'string', pattern: `^(?:${endpoint}\\.\\.(?:${endpoint})?|\\.\\.${endpoint})$(?![\\s\\S])` });
  return Object.freeze({
    name: field,
    in: 'query',
    required: false,
    style: 'form',
    explode: false,
    schema: ranged ? Object.freeze({ anyOf: Object.freeze([values, range]) }) : values,
    description:
      'Comma-separated values (one value means equality). Array items describe decoded typed values, not raw query text. ' +
      (ranged ? 'Alternatively min..max, min.. or ..max; endpoints obey the same scalar schema and must be ordered. ' : '') +
      (numeric
        ? 'Numeric lexemes are canonical decimals without exponent notation. '
        : codec.kind === 'date'
          ? 'Dates are real Gregorian YYYY-MM-DD values in years 0001 through 9999, never instants. '
          : '') +
      'Null is not a filter value. Text is exact, but commas, range separators and empty/whitespace-only members cannot be expressed. ' +
      'Raw duplicate parameters, malformed UTF-8, control characters and byte limits are checked by the request parser, not this schema.',
    ...(ranged ? { 'x-mistri-range-endpoint-schema': codec.schema } : {}),
    'x-mistri-runtime-validation': Object.freeze(['raw-query', ...(ranged ? ['range-endpoint-values', 'range-order'] : [])]),
  });
}
