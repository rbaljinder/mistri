/** Read-list encoding only. This cannot issue cursors or authorize a query. */
import { isProxy } from 'node:util/types';
import { createApiReadRowCodec } from './apiReadRowCodec.js';

function fail(): never {
  throw new TypeError('The API list envelope cannot be represented by this codec.');
}
function record(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    isProxy(raw) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(raw))
  )
    return fail();
  const data: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || ![...required, ...optional].includes(key)) return fail();
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return fail();
    data[key] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(data, key))) return fail();
  return data;
}

/** Checked operation and logical schema are the row codec's existing inputs.
 * countRequested/limit come from validated list parameters, not DB results.
 * Exact+capped means an exact bounded scan, matching readCount; it does NOT
 * claim the bounded value is the full total. Cursor contents remain opaque.
 */
export function createApiReadEnvelopeCodec(
  operation: Parameters<typeof createApiReadRowCodec>[0],
  schema: Parameters<typeof createApiReadRowCodec>[1],
  options: {
    integers: 'decimal-string' | 'number';
    limit?: number;
    countRequested?: boolean;
  },
) {
  const settings = record(options, ['integers'], ['limit', 'countRequested']);
  const limit = settings.limit === undefined ? 50 : settings.limit;
  const countRequested = settings.countRequested === undefined ? false : settings.countRequested;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 || typeof countRequested !== 'boolean')
    return fail();
  const rows = createApiReadRowCodec(operation, schema, { integers: settings.integers as 'decimal-string' | 'number' });
  const jsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: countRequested ? ['items', 'next', 'count'] : ['items', 'next'],
    properties: {
      items: { type: 'array', maxItems: limit, items: rows.schema },
      next: {
        anyOf: [
          { type: 'null' },
          {
            type: 'string',
            minLength: 1,
            'x-mistri-max-utf8-bytes': 4096,
            'x-mistri-unicode-scalar-values': true,
            'x-mistri-control-characters': 'forbidden',
          },
        ],
      },
      ...(countRequested
        ? {
            count: {
              type: 'object',
              additionalProperties: false,
              required: ['value', 'exact', 'capped'],
              properties: {
                value: { type: 'integer', minimum: 0, maximum: 10000 },
                exact: { type: 'boolean' },
                capped: { type: 'boolean' },
              },
              anyOf: [
                { properties: { capped: { const: false } } },
                {
                  properties: { capped: { const: true }, value: { const: 10000 }, exact: { const: true } },
                },
              ],
              'x-mistri-exact-uncapped-count': 'at-least-current-items-length',
            },
          }
        : {}),
    },
  };
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  freeze(jsonSchema);
  return Object.freeze({
    stage: 'read-list-envelope-codec' as const,
    cursorVerification: 'pending' as const,
    authorization: 'pending' as const,
    schema: jsonSchema,
    encode(raw: unknown) {
      const envelope = record(raw, countRequested ? ['items', 'next', 'count'] : ['items', 'next']);
      const source = envelope.items;
      if (
        !Array.isArray(source) ||
        isProxy(source) ||
        Object.getPrototypeOf(source) !== Array.prototype ||
        source.length > limit ||
        Reflect.ownKeys(source).length !== source.length + 1
      )
        return fail();
      const items = [];
      for (let index = 0; index < source.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return fail();
        items.push(rows.encodeRow(descriptor.value));
      }
      const next = envelope.next;
      if (next !== null) {
        if (typeof next !== 'string' || !next.length || new TextEncoder().encode(next).byteLength > 4096) return fail();
        try {
          encodeURIComponent(next);
        } catch {
          return fail();
        }
        if ([...next].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return fail();
      }
      let count: Readonly<{ value: number; exact: boolean; capped: boolean }> | undefined;
      if (countRequested) {
        const value = record(envelope.count, ['value', 'exact', 'capped']);
        if (
          typeof value.value !== 'number' ||
          !Number.isSafeInteger(value.value) ||
          value.value < 0 ||
          value.value > 10000 ||
          typeof value.exact !== 'boolean' ||
          typeof value.capped !== 'boolean'
        )
          return fail();
        if (value.capped && (value.value !== 10000 || !value.exact)) return fail();
        if (value.exact && !value.capped && value.value < items.length) return fail();
        count = Object.freeze({ value: value.value, exact: value.exact, capped: value.capped });
      }
      return Object.freeze({ items: Object.freeze(items), next, ...(count ? { count } : {}) });
    },
  });
}
