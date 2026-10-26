/** Strict lexical foundation only: no SQL, type coercion or cursor authority. */
import { addressFilterValue, addressSortValue } from '@mistriwork/engine/shared/addressParams.js';
import { reservedKeys } from '@mistriwork/engine/adapters/commands/canonicalJson.js';

const CONTROLS = new Set(['limit', 'cursor', 'fields', 'sort', 'count', 'segment', 'q', 'offset', 'where', 'totals']);
const LIMITS = { bytes: 16384, parameters: 64, cursorBytes: 4096, values: 100 } as const;
function fail(reason: string): never {
  throw new Error(`API list parameters: ${reason}.`);
}
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const path = (value: string) => value.split('.').every((part) => /^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/.test(part) && !reservedKeys.has(part));

/** Metadata comes from a checked exposure, never from the request. An omitted
 * tabs list means this is not a tab-selectable view; a view's tab is chosen by `segment`. Complete keys are always
 * retained, in declared exposure order, when fields narrows the projection.
 * Caps: 16KiB raw query, 64 parameters, 100 comma values/filter, 4KiB cursor.
 * A cursor remains opaque text: signature/request binding is a later stage.
 */
export function parseApiListParams(
  rawQuery: string,
  exposure: {
    fields: readonly string[];
    filters: readonly string[];
    sorts: readonly string[];
    primaryKey: readonly string[];
    tabs?: readonly string[];
    /** A resource list's segments by name (apiReadCatalog): absent (and no tabs), `segment` is no parameter of it. */
    segments?: readonly string[];
  },
) {
  if (typeof rawQuery !== 'string' || bytes(rawQuery) > LIMITS.bytes || rawQuery.includes('#')) fail('invalid or oversized raw query');
  const decode = (raw: string): string => {
    try {
      const decoded = decodeURIComponent(raw.replace(/\+/g, ' '));
      encodeURIComponent(decoded); // Refuse literal lone surrogates as well as malformed escaped UTF-8.
      if ([...decoded].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
        return fail('control character');
      return decoded;
    } catch {
      return fail('invalid percent encoding or UTF-8');
    }
  };
  for (const values of [exposure.fields, exposure.filters, exposure.sorts, exposure.primaryKey]) {
    if (
      !Array.isArray(values) ||
      values.length > 256 ||
      new Set(values).size !== values.length ||
      Array.from(values).some((value) => typeof value !== 'string' || !path(value))
    )
      fail('invalid exposure field metadata');
  }
  const fields = new Set(exposure.fields),
    filters = new Set(exposure.filters),
    sorts = new Set(exposure.sorts);
  if (!fields.size || !exposure.primaryKey.length || [...filters, ...sorts, ...exposure.primaryKey].some((field) => !fields.has(field)))
    fail('exposure must contain every filter, sort and complete key');
  if ([...filters].some((field) => CONTROLS.has(field))) fail('filter name collides with a reserved parameter');
  if (
    exposure.tabs &&
    (exposure.tabs.length > 256 ||
      new Set(exposure.tabs).size !== exposure.tabs.length ||
      Array.from(exposure.tabs).some(
        (tab) => typeof tab !== 'string' || !/^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*(?![\s\S])/.test(tab) || reservedKeys.has(tab),
      ))
  )
    fail('invalid tab metadata');
  const query = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;
  const parts = query ? query.split('&') : [];
  if (parts.length > LIMITS.parameters) fail('too many parameters');
  const parameters = new Map<string, string>();
  for (const part of parts) {
    const equals = part.indexOf('=');
    if (equals <= 0) fail('every parameter needs a name and value');
    const name = decode(part.slice(0, equals)),
      value = decode(part.slice(equals + 1));
    if (parameters.has(name)) fail('repeated parameter');
    if (reservedKeys.has(name) || (!filters.has(name) && !['limit', 'cursor', 'fields', 'sort', 'count', 'segment'].includes(name)))
      fail('unknown or unsupported parameter');
    parameters.set(name, value);
  }
  const comma = (value: string): string[] => {
    const values = value.split(',');
    if (values.some((item) => !item.trim())) fail('empty comma member');
    return values;
  };
  const limitText = parameters.get('limit');
  if (limitText !== undefined && !/^[1-9][0-9]{0,2}(?![\s\S])/.test(limitText)) fail('limit must be a canonical positive integer');
  const limit = limitText === undefined ? 50 : Number(limitText);
  if (limit > 500) fail('limit exceeds 500');
  const count = parameters.get('count');
  if (count !== undefined && count !== 'true' && count !== 'false') fail('count must be true or false');
  const cursor = parameters.get('cursor');
  if (cursor !== undefined && (!cursor.length || bytes(cursor) > LIMITS.cursorBytes)) fail('invalid or oversized cursor');
  /* One parameter selects the slice: a resource list's segment, or the tab of a view, which is its segment's name. */
  const segment = parameters.get('segment');
  if (segment !== undefined && !exposure.segments?.includes(segment) && !exposure.tabs?.includes(segment))
    fail('segment is not one this list offers');
  const requestedFields = parameters.has('fields') ? comma(parameters.get('fields')!) : [...fields];
  if (new Set(requestedFields).size !== requestedFields.length || requestedFields.some((field) => !fields.has(field)))
    fail('projection contains duplicate or unexposed fields');
  const projection = exposure.fields.filter((field) => requestedFields.includes(field) || exposure.primaryKey.includes(field));
  const order = parameters.has('sort') ? addressSortValue(parameters.get('sort')!) : [];
  if (!order || new Set(order.map((item) => item.field)).size !== order.length || order.some((item) => !sorts.has(item.field)))
    fail('sort contains malformed, duplicate or unexposed fields');
  const predicates: Array<{ field: string; value: NonNullable<ReturnType<typeof addressFilterValue>> }> = [];
  for (const [field, raw] of parameters)
    if (filters.has(field)) {
      if (comma(raw).length > LIMITS.values) fail('too many filter values');
      // API-only DATE range spelling. The browser grammar is unchanged and the
      // scalar codec, not this lexical recognition, proves calendar validity.
      const dateRange = /^(\d{4}-\d{2}-\d{2})?\.\.(\d{4}-\d{2}-\d{2})?$(?![\s\S])/.exec(raw);
      const value =
        dateRange && (dateRange[1] || dateRange[2])
          ? { kind: 'range' as const, ...(dateRange[1] ? { min: dateRange[1] } : {}), ...(dateRange[2] ? { max: dateRange[2] } : {}) }
          : addressFilterValue(raw);
      if (!value || (raw.includes('..') && value.kind !== 'range')) fail('malformed or unsupported range syntax');
      // The browser grammar trims presentation-friendly values. An API equality
      // must preserve decoded text exactly, or padded text silently targets a
      // different value. Numeric/boolean whitespace is the typed stage's refusal.
      if (value.kind === 'range' && raw !== raw.trim()) fail('padded range syntax');
      predicates.push({ field, value: value.kind === 'values' ? { kind: 'values', values: raw.split(',') } : value });
    }
  return {
    stage: 'list-parameter-lexemes' as const,
    typeValidation: 'pending' as const,
    cursorVerification: 'pending' as const,
    orderKeyCompletion: 'pending' as const,
    limit,
    count: count === 'true',
    fields: projection,
    order,
    filters: predicates,
    ...(cursor === undefined ? {} : { cursor }),
    ...(segment === undefined ? {} : { segment }),
  };
}
