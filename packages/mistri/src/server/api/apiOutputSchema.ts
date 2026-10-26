/** Exact, intentionally bounded structural subset. No API activation. */
import { reservedKeys } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { describeShape } from '../commands/commandShapes.js';
import { COMMAND_DATE_PATTERN } from './apiDateCodec.js';

type Descriptor = ReturnType<typeof describeShape>;
type Schema = boolean | { [key: string]: unknown };
const refuse = (path: string, reason: string): never => {
  throw new Error(`Command output ${path}: ${reason}.`);
};
/* A JSON Schema pattern is ECMA-262, unanchored like RegExp#test, and read with Unicode semantics. A `u` pattern means
   the same there; one without flags does too unless it holds what reads a surrogate pair as two characters — a dot,
   a negated class, \S, \W or \D. Any other flag (i, m, s, v) has no JSON Schema spelling. */
const wirePattern = (pattern: Readonly<{ source: string; flags: string }>): boolean => {
  if (pattern.flags !== '' && pattern.flags !== 'u') return false;
  try {
    new RegExp(pattern.source, 'u');
  } catch {
    return false;
  }
  return pattern.flags === 'u' || !/(?:^|[^\\])(?:\\\\)*(?:\.|\[\^|\\[SWD])/.test(pattern.source);
};
const undefinedCapable = (d: Descriptor): boolean =>
  d.kind === 'optional' ||
  (d.kind === 'nullable' && undefinedCapable(d.item)) ||
  (d.kind === 'anyOf' && d.alternatives.some(undefinedCapable));
const scalar = (d: Descriptor, depth = 0): boolean =>
  depth <= 32 &&
  (['text', 'integer', 'number', 'boolean', 'literal', 'date'].includes(d.kind) ||
    (d.kind === 'nullable' && scalar(d.item, depth + 1)) ||
    (d.kind === 'anyOf' && d.alternatives.every((item) => scalar(item, depth + 1))));

/** Describes serialized, projected output, NOT the raw handler return value.
 * Built-in provenance is read without invoking output.parse. Unknown parsers
 * refuse. Byte/node/depth envelope limits still require the canonical runtime
 * validator; this result alone is not a publication or execution contract.
 */
export function renderApiOutputSchema(output: unknown) {
  let nodes = 0;
  const render = (d: Descriptor, path: string, property = false, depth = 0): Schema => {
    if (++nodes > 1024 || depth > 32) return refuse(path, 'descriptor complexity exceeds this renderer');
    const child = (value: Descriptor, at: string, prop = false) => render(value, at, prop, depth + 1);
    switch (d.kind) {
      case 'opaque':
        return refuse(path, 'opaque output parser');
      case 'text':
        if (d.pattern && !wirePattern(d.pattern)) {
          return refuse(
            path,
            `pattern /${d.pattern.source}/${d.pattern.flags} cannot be said to a JSON Schema reader, which reads a pattern ` +
              'with no flags and Unicode semantics: write it with the u flag alone, and without i, m or s',
          );
        }
        /* `max` counts UTF-16 units and maxLength code points: a text the handler may return has at most `max` of
           either, so the bound holds for every output, and is exact for text without astral characters. */
        return {
          type: 'string',
          ...(d.max === undefined ? {} : { maxLength: d.max }),
          ...(d.pattern ? { pattern: d.pattern.source } : {}),
        };
      // The calendar, year 0000 included, as a pattern; `format` says it to an OpenAPI reader that knows the word.
      case 'date':
        return { type: 'string', format: 'date', minLength: 10, maxLength: 10, pattern: COMMAND_DATE_PATTERN };
      case 'boolean':
        return { type: 'boolean' };
      case 'integer':
        return { type: 'integer', minimum: d.min, maximum: d.max };
      case 'number':
        return {
          type: 'number',
          minimum: Math.max(-Number.MAX_VALUE, d.min ?? -Number.MAX_VALUE),
          maximum: Math.min(Number.MAX_VALUE, d.max ?? Number.MAX_VALUE),
        };
      case 'literal':
        return { enum: [...new Set(d.values)] };
      case 'optional':
        if (!property) return refuse(path, 'undefined is unsupported at the root or in a list');
        return child(d.item, path, true);
      case 'nullable':
        return { anyOf: [child(d.item, path, property), { type: 'null' }] };
      case 'list':
        for (const bound of [d.min, d.max])
          if (bound !== undefined && (!Number.isSafeInteger(bound) || bound < 0)) {
            return refuse(path, 'list bounds must be nonnegative safe integers');
          }
        return {
          type: 'array',
          items: child(d.item, `${path}[]`),
          ...(d.min === undefined ? {} : { minItems: d.min }),
          ...(d.max === undefined ? {} : { maxItems: d.max }),
        };
      case 'anyOf':
        if (!d.alternatives.every((item) => scalar(item)))
          return refuse(path, 'first-match projecting or undefined alternatives require a dedicated wire rule');
        return { anyOf: d.alternatives.map((item, i) => child(item, `${path}|${i}`)) };
      case 'object': {
        const properties: Record<string, Schema> = {},
          required: string[] = [];
        for (const [key, value] of Object.entries(d.fields)) {
          if (reservedKeys.has(key)) return refuse(`${path}.${key}`, 'reserved property is refused by canonical output');
          properties[key] = child(value, `${path}.${key}`, true);
          if (!undefinedCapable(value)) required.push(key);
        }
        return { type: 'object', properties, required, additionalProperties: false };
      }
    }
  };
  const schema = render(describeShape(output), '$');
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  freeze(schema);
  return Object.freeze({ stage: 'output-structure-schema' as const, envelopeValidation: 'pending' as const, schema });
}
