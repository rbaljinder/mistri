/** Projection codec only: no transport, principal, query or publication
 * authority. A checked catalog operation is required; its facts are captured
 * here, not promoted into proof that a caller may read them. */
import { isProxy } from 'node:util/types';
import { primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { apiDialectOf, apiFieldCodec, apiIntegerRepresentation } from './apiValueCodec.js';
import { resolvePath } from '@mistriwork/engine/shared/view.js';
import type { checkApiReadCatalog } from './apiReadCatalog.js';

type Operation = ReturnType<typeof checkApiReadCatalog>['operations'][number];
type WireValue = string | number | boolean | null | Readonly<Record<string, unknown>>;
type JsonSchema = Readonly<Record<string, unknown>>;
const fail = (): never => {
  throw new TypeError('The API read row cannot be represented by this projection codec.');
};

export function createApiReadRowCodec(
  operation: Operation,
  logicalSchema: DatabaseSchema,
  options: { integers: 'decimal-string' | 'number' },
) {
  const integers = apiIntegerRepresentation(options);
  const table = logicalSchema.tables.find((table) => table.id === operation.resource);
  if (!table || !['sqlite', 'postgres', 'mysql'].includes(apiDialectOf(logicalSchema, table.id))) return fail();
  const key = primaryKey(table);
  if (!key.length || key.length !== operation.primaryKey.length || key.some((column) => !operation.primaryKey.includes(column)))
    return fail();
  if (
    !operation.fields.length ||
    new Set(operation.fields).size !== operation.fields.length ||
    key.some((column) => !operation.fields.includes(column))
  )
    return fail();
  const fields = operation.fields.map((name) => {
    const resolved = resolvePath(logicalSchema, operation.resource, name);
    const nullable = resolved.column.nullable || resolved.hops.length > 0;
    if (key.includes(name) && nullable) return fail();
    const codec = apiFieldCodec(resolved.column, apiDialectOf(logicalSchema, resolved.table.id), integers);
    const scalarSchema = codec.schema;
    const schema: JsonSchema = nullable
      ? Object.freeze({ anyOf: Object.freeze([scalarSchema, Object.freeze({ type: 'null' })]) })
      : scalarSchema;
    return Object.freeze({ name, nullable, schema, encode: codec.encode });
  });
  const schema = Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: Object.freeze(Object.fromEntries(fields.map((field) => [field.name, field.schema]))),
    required: Object.freeze(fields.map((field) => field.name)),
  });
  return Object.freeze({
    stage: 'read-row-wire-codec' as const,
    envelopeValidation: 'pending' as const,
    schema,
    encodeRow(row: unknown): Readonly<Record<string, WireValue>> {
      if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        isProxy(row) ||
        ![null, Object.prototype].includes(Object.getPrototypeOf(row))
      )
        return fail();
      const result: Record<string, WireValue> = Object.create(null);
      for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(row, field.name);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) return fail();
        const value: unknown = descriptor.value;
        result[field.name] = value === null ? (field.nullable ? null : fail()) : field.encode(value);
      }
      return Object.freeze(result);
    },
  });
}
