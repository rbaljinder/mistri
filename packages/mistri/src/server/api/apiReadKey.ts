/** Encoded item-key segments only; no route, lookup, principal or HTTP errors.
 * Callers pass the raw segment, never a router's already-decoded parameter.
 * Text and signed integer keys share the row scalar policy. Empty/control text,
 * single dot segments, floating, boolean, nullable and other key types
 * deliberately remain unsupported. */
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { apiDialectOf, apiIntegerRepresentation, apiValueCodec } from './apiValueCodec.js';
import type { checkApiReadCatalog } from './apiReadCatalog.js';

// Only the facts the codec reads, so a command target can name its key the same way.
type Operation = Pick<ReturnType<typeof checkApiReadCatalog>['operations'][number], 'resource' | 'primaryKey' | 'fields'>;
const fail = (): never => {
  throw new TypeError('The API item key is unsupported or invalid.');
};
const MAX_KEY_BYTES = 8192;
// JSON Schema patterns use Unicode regular expressions: a valid surrogate pair
// is one astral character, while unpaired surrogate code points are refused.
const TEXT_KEY_PATTERN = '^[^\\u0000-\\u001F\\u007F\\uD800-\\uDFFF]+$';
const bounded = (value: string) => {
  if (!value.length || Buffer.byteLength(value, 'utf8') > MAX_KEY_BYTES) return fail();
  return value;
};
const text = (value: string) => {
  if (!value.length || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return fail();
  try {
    encodeURIComponent(value);
  } catch {
    return fail();
  }
  return value;
};

export function createApiReadKeyCodec(operation: Operation, schema: DatabaseSchema, options: { integers: 'decimal-string' | 'number' }) {
  const integers = apiIntegerRepresentation(options);
  const table = schema.tables.find((table) => table.id === operation.resource);
  if (!table || table.isView) return fail();
  const names = primaryKey(table);
  if (
    !names.length ||
    names.length !== operation.primaryKey.length ||
    new Set(names).size !== names.length ||
    names.some((name) => !operation.primaryKey.includes(name) || !operation.fields.includes(name))
  )
    return fail();
  const fields = names.map((name) => {
    const columns = table.columns.filter((column) => column.name === name);
    if (columns.length !== 1 || columns[0].nullable !== false || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return fail();
    const codec = apiValueCodec(columns[0], apiDialectOf(schema, table.id), integers);
    if (codec.kind !== 'text' && codec.kind !== 'integer') return fail();
    const valueSchema =
      codec.kind === 'text'
        ? Object.freeze({
            ...codec.schema,
            minLength: 1,
            pattern: TEXT_KEY_PATTERN,
            ...(names.length === 1 ? { not: Object.freeze({ enum: Object.freeze(['.', '..']) }) } : {}),
          })
        : codec.schema;
    return { name, codec, valueSchema };
  });
  const keyColumns = Object.freeze(fields.map((field) => field.name));
  const decodedSchema = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: keyColumns,
    properties: Object.freeze(Object.fromEntries(fields.map((field) => [field.name, field.valueSchema]))),
  });
  const composite = fields.length > 1;
  const parameter = Object.freeze({
    schema: composite ? decodedSchema : fields[0].valueSchema,
    ...(composite ? { style: 'simple' as const, explode: true } : {}),
    description: composite
      ? 'Supply the decoded key object. Serialize with simple style and explode=true: column=value pairs joined by literal commas, percent-encoding each value independently. Every primary-key column must occur exactly once; pair order may vary. The server key codec receives the raw segment and splits before decoding each value exactly once; do not pre-encode object values.'
      : 'The schema describes the decoded key value. Percent-encode its scalar spelling as one path segment; decode exactly once. Empty text, controls, unpaired surrogates and single dot segments are refused. Do not pass a router-decoded segment to the key codec.',
    'x-mistri-key-columns': keyColumns,
    'x-mistri-decoded-key-schema': decodedSchema,
    // Neither budget is a character count. JSON Schema maxLength cannot model
    // percent-encoded bytes or the complete canonical key object's JSON bytes.
    'x-mistri-max-encoded-segment-utf8-bytes': MAX_KEY_BYTES,
    'x-mistri-max-canonical-key-json-utf8-bytes': MAX_KEY_BYTES,
    'x-mistri-runtime-validation': Object.freeze([
      'raw-item-key-codec',
      'complete-unique-key-columns',
      'percent-encoding-and-utf8',
      'scalar-key-policy',
      'encoded-segment-byte-limit',
      'canonical-key-json-byte-limit',
    ]),
  });
  const normalize = (raw: unknown): Readonly<Record<string, string | number>> => {
    const key = snapshot(raw, MAX_KEY_BYTES).value;
    if (!key || typeof key !== 'object' || Array.isArray(key) || Object.keys(key).length !== fields.length) return fail();
    const result: Record<string, string | number> = Object.create(null);
    for (const { name, codec } of fields) {
      if (!Object.hasOwn(key, name)) return fail();
      const value = codec.encode((key as Record<string, unknown>)[name]);
      if (typeof value !== 'string' && typeof value !== 'number') return fail();
      if (typeof value === 'string') {
        text(value);
        // WHATWG URL parsing removes even percent-encoded dot segments.
        if (fields.length === 1 && (value === '.' || value === '..')) return fail();
      }
      result[name] = value;
    }
    return Object.freeze(result);
  };
  return Object.freeze({
    stage: 'item-key-codec' as const,
    authorization: 'pending' as const,
    schema: decodedSchema,
    parameter,
    decode(segment: string) {
      if (typeof segment !== 'string' || /[/?#\\]/.test(segment)) return fail();
      bounded(segment);
      const key: Record<string, string> = Object.create(null);
      const decode = (value: string) => {
        try {
          return text(decodeURIComponent(value));
        } catch {
          return fail();
        }
      };
      if (fields.length === 1) key[fields[0].name] = decode(segment);
      else
        for (const pair of segment.split(',')) {
          const parts = pair.split('=');
          if (parts.length !== 2 || !fields.some((field) => field.name === parts[0]) || Object.hasOwn(key, parts[0])) return fail();
          key[parts[0]] = decode(parts[1]);
        }
      return normalize(key);
    },
    encode(raw: unknown) {
      const key = normalize(raw);
      const values = fields.map(({ name }) => `${fields.length === 1 ? '' : `${name}=`}${encodeURIComponent(String(key[name]))}`);
      return bounded(values.join(','));
    },
  });
}
