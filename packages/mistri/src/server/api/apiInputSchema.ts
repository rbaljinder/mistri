/** Private raw-JSON declaration preview, not command admission or execution. */
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { isIsoDate } from '../../shared/command.js';
import { parseCommandInput } from '../../shared/commandInputParse.js';
import { DEFINED_KEY, DEFINITIONS_MOST } from '@mistriwork/engine/shared/definedFields.js';
import { RICH_TEXT_MOST } from '@mistriwork/engine/shared/richText.js';
import { apiDateCodec } from './apiDateCodec.js';

const refuse = (): never => {
  throw new Error('Command input schema preview requires a callback-free input declaration.');
};

// ECMAScript \s matches String.trim's whitespace. Controls may occur in
// trimmed-away edges, but never inside the nonempty trimmed text. The explicit
// end-of-input assertion keeps that boundary independent of multiline flags.
const REQUIRED_TEXT = '^\\s*[^\\s\\u0000-\\u001f\\u007f](?:[^\\u0000-\\u001f\\u007f]*[^\\s\\u0000-\\u001f\\u007f])?\\s*(?![\\s\\S])';
const REQUIRED_MULTILINE =
  '^\\s*[^\\s\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f](?:[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]*[^\\s\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f])?\\s*(?![\\s\\S])';

// SQL DATE intentionally excludes year zero; command dates do not. Enumerate
// just that bounded exceptional year through the actual command predicate,
// once, rather than introducing another calendar/leap-year implementation.
const YEAR_ZERO = Object.freeze(
  Array.from({ length: 12 }, (_, month) =>
    Array.from({ length: 31 }, (_, day) => `0000-${String(month + 1).padStart(2, '0')}-${String(day + 1).padStart(2, '0')}`),
  )
    .flat()
    .filter(isIsoDate),
);
const DATE = Object.freeze({ anyOf: Object.freeze([apiDateCodec().schema, Object.freeze({ enum: YEAR_ZERO })]) });
const OPTIONAL_DATE = Object.freeze({
  anyOf: Object.freeze([DATE, Object.freeze({ type: 'null' }), Object.freeze({ type: 'string', pattern: '^\\s*(?![\\s\\S])' })]),
});

/** The raw reader omits blank scalar values before type validation. Choice is
 * special: only the empty string is blank; whitespace is an exact enum value. */
function optionalScalar(schema: Readonly<Record<string, unknown>>, choice = false) {
  return Object.freeze({
    anyOf: Object.freeze([
      schema,
      Object.freeze({ type: 'null' }),
      choice ? Object.freeze({ const: '' }) : Object.freeze({ type: 'string', pattern: '^\\s*(?![\\s\\S])' }),
    ]),
  });
}

type Schema = Readonly<Record<string, unknown>>;
type Field = ReturnType<typeof parseCommandInput>[number];
/** An input the renderer could not describe: it is left open (any value) and named, so one input degrades itself, not its tool. */
type ApiInputUndescribed = Readonly<{ path: string; cause: string }>;

const BLANK = Object.freeze({ type: 'string', pattern: '^\\s*(?![\\s\\S])' });
const NULL = Object.freeze({ type: 'null' });
const SAFE_INTEGER = Object.freeze({ type: 'integer', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
const described = (schema: Schema, notes: readonly string[]): Schema =>
  notes.length ? Object.freeze({ ...schema, description: notes.join(' ') }) : schema;
const quoted = (value: string) => JSON.stringify(value);

/* A field the server judges against something JSON Schema cannot see — a pattern after trimming and casing, a
   sibling, the record a `when` reads, a row a reference names — is described in words beside the shape it takes.
   The schema says what a value looks like; admission stays the command reader's (shared/commandInput.ts). */
function textSchema(field: Extract<Field, { type: 'text' | 'textarea' }>, required: boolean): Schema {
  const pattern = field.type === 'text' ? REQUIRED_TEXT : REQUIRED_MULTILINE;
  const notes: string[] = [];
  const bounds: Record<string, unknown> = {};
  if (field.minLength !== undefined) bounds.minLength = field.minLength;
  if (field.maxLength !== undefined) bounds.maxLength = field.maxLength;
  if (field.minLength !== undefined || field.maxLength !== undefined) notes.push('Its length is counted after trimming.');
  if (field.format !== undefined)
    notes.push(field.format === 'email' ? 'An email address.' : field.format === 'url' ? 'A web address (URL).' : 'A phone number.');
  if (field.pattern !== undefined) notes.push(`Matches /${field.pattern}/ once trimmed${field.case ? ' and cased' : ''}.`);
  if (field.message !== undefined) notes.push(field.message);
  if (field.case !== undefined) notes.push(`Kept in ${field.case} case.`);
  if (field.mask !== undefined)
    notes.push(`The characters the mask ${quoted(field.mask)} holds, without its punctuation (0 a digit, a a letter, * either).`);
  if (field.sensitive !== undefined)
    notes.push(
      field.sensitive.keep === 'last4'
        ? 'Sensitive: only its last four characters are kept.'
        : field.sensitive.keep === 'none'
          ? 'Sensitive: it is checked and never kept.'
          : 'Sensitive: it is kept only as a keyed hash.',
    );
  const plain = field.minLength === undefined && field.maxLength === undefined;
  if (required) return described(Object.freeze({ type: 'string', pattern, ...bounds }), notes);
  if (plain)
    return described(
      Object.freeze({ anyOf: Object.freeze([NULL, Object.freeze({ type: 'string', pattern: `(?:${pattern})|(?:^\\s*(?![\\s\\S]))` })]) }),
      notes,
    );
  return described(Object.freeze({ anyOf: Object.freeze([NULL, BLANK, Object.freeze({ type: 'string', pattern, ...bounds })]) }), notes);
}

function scalarSchema(
  field: Exclude<Field, { type: 'group' | 'lines' }>,
  required: boolean,
  path: string,
  undescribed: ApiInputUndescribed[],
): Schema {
  const notes: string[] = [];
  const sibling = (rule: 'below' | 'above', other: string | undefined) => {
    if (other !== undefined) notes.push(`${rule === 'below' ? 'Less' : 'Greater'} than ${quoted(other)} when both are given.`);
  };
  if (field.type === 'text' || field.type === 'textarea') return textSchema(field, required);
  if (field.type === 'richText') {
    // HTML or Markdown, by its first character or by saying so; the server sanitizes either, so no pattern is advertised.
    const schema = Object.freeze({
      anyOf: Object.freeze([
        Object.freeze({ type: 'string' }),
        Object.freeze({
          type: 'object',
          additionalProperties: false,
          required: Object.freeze(['format', 'text']),
          properties: Object.freeze({
            format: Object.freeze({ enum: Object.freeze(['markdown', 'html']) }),
            text: Object.freeze({ type: 'string' }),
          }),
        }),
      ]),
    });
    if (field.minLength !== undefined) notes.push(`At least ${field.minLength} characters of text.`);
    notes.push(`At most ${field.maxLength ?? RICH_TEXT_MOST} characters once sanitized.`);
    return described(required ? schema : optionalScalar(schema), notes);
  }
  if (field.type === 'date') {
    if (field.min !== undefined) notes.push(`On or after ${field.min}.`);
    if (field.max !== undefined) notes.push(`On or before ${field.max}.`);
    sibling('below', field.below);
    sibling('above', field.above);
    return described(required ? DATE : OPTIONAL_DATE, notes);
  }
  if (field.type === 'datetime') {
    notes.push('An ISO 8601 date and time with its zone, such as 2026-10-12T09:00:00Z; kept as the UTC instant.');
    if (field.min !== undefined) notes.push(`At or after ${field.min}.`);
    if (field.max !== undefined) notes.push(`At or before ${field.max}.`);
    sibling('below', field.below);
    sibling('above', field.above);
    const schema = Object.freeze({ type: 'string', maxLength: 40 });
    return described(required ? schema : optionalScalar(schema), notes);
  }
  if (field.type === 'boolean') {
    // A box that must be checked is only ever true where it is asked unconditionally.
    if (field.accept && required) return Object.freeze({ const: true });
    if (field.accept) notes.push('Must be true where it is asked.');
    const schema = Object.freeze({ type: 'boolean' });
    return described(required ? schema : optionalScalar(schema), notes);
  }
  if (field.type === 'choice') {
    if (field.source) {
      const schema = Object.freeze({ anyOf: Object.freeze([SAFE_INTEGER, Object.freeze({ type: 'string', pattern: '\\S' })]) });
      notes.push(
        `The ${quoted(field.source.by)} of a ${quoted(field.source.from)} row, offered by its ${quoted(field.source.labelColumn)}.`,
      );
      return described(required ? schema : optionalScalar(schema, true), notes);
    }
    const schema = Object.freeze({ enum: Object.freeze(field.options.map((option) => option.value)) });
    return required ? schema : optionalScalar(schema, true);
  }
  if (field.type === 'choices') {
    const item = field.source
      ? Object.freeze({ anyOf: Object.freeze([SAFE_INTEGER, Object.freeze({ type: 'string', pattern: '\\S' })]) })
      : Object.freeze({ enum: Object.freeze(field.options.map((option) => option.value)) });
    if (field.source) notes.push(`Each the ${quoted(field.source.by)} of a ${quoted(field.source.from)} row.`);
    if (field.exclusive?.length) notes.push(`${field.exclusive.map((v) => quoted(String(v))).join(', ')} is chosen alone.`);
    const schema = Object.freeze({
      type: 'array',
      uniqueItems: true,
      items: item,
      ...(field.min !== undefined || required ? { minItems: Math.max(field.min ?? 0, required ? 1 : 0) } : {}),
      ...(field.max !== undefined ? { maxItems: field.max } : {}),
    });
    return described(required ? schema : Object.freeze({ anyOf: Object.freeze([NULL, schema]) }), notes);
  }
  if (field.type === 'month') {
    if (field.min !== undefined) notes.push(`On or after ${field.min}.`);
    if (field.max !== undefined) notes.push(`On or before ${field.max}.`);
    sibling('below', field.below);
    sibling('above', field.above);
    const schema = Object.freeze({ type: 'string', pattern: '^\\d{4}-(?:0[1-9]|1[0-2])$' });
    return described(required ? schema : optionalScalar(schema), notes);
  }
  if (field.type === 'money') {
    notes.push(`An amount of money; rounded to a multiple of ${field.step ?? 0.01}.`);
    if (field.min !== undefined) notes.push(`At least ${field.min} once rounded.`);
    if (field.max !== undefined) notes.push(`At most ${field.max} once rounded.`);
    sibling('below', field.below);
    sibling('above', field.above);
    const schema = Object.freeze({ type: 'number' });
    return described(required ? schema : optionalScalar(schema), notes);
  }
  if (field.type === 'number') {
    if (field.step !== undefined) notes.push(`Rounded to a multiple of ${field.step}.`);
    sibling('below', field.below);
    sibling('above', field.above);
    const limit = field.integer ? Number.MAX_SAFE_INTEGER : Number.MAX_VALUE;
    // A stepped value is judged after rounding, so its bounds are said rather than enforced on what is sent.
    const bounded = field.step === undefined;
    const schema = Object.freeze({
      type: field.integer ? 'integer' : 'number',
      minimum: Math.max(-limit, bounded ? (field.min ?? -limit) : -limit),
      maximum: Math.min(limit, bounded ? (field.max ?? limit) : limit),
    });
    if (!bounded && field.min !== undefined) notes.push(`At least ${field.min} once rounded.`);
    if (!bounded && field.max !== undefined) notes.push(`At most ${field.max} once rounded.`);
    return described(required ? schema : optionalScalar(schema), notes);
  }
  if (field.type === 'reference') {
    // The key a picker stores: a whole number, or text of at most 256 characters once trimmed.
    const schema = Object.freeze({ anyOf: Object.freeze([SAFE_INTEGER, Object.freeze({ type: 'string', pattern: '\\S' })]) });
    notes.push(
      `The ${quoted(field.by)} of a ${quoted(field.from)} row, which a person picks by its ${quoted(field.labelColumn)}.` +
        (field.query ? ` Among the rows where: ${field.query}.` : ''),
    );
    return described(required ? schema : optionalScalar(schema), notes);
  }
  if (field.type === 'defined') {
    const answer = Object.freeze({
      anyOf: Object.freeze([
        NULL,
        Object.freeze({ type: 'string', maxLength: 10000 }),
        Object.freeze({ type: 'number' }),
        Object.freeze({ type: 'boolean' }),
        Object.freeze({ type: 'array', maxItems: 100, items: Object.freeze({ type: 'string', maxLength: 1000 }) }),
      ]),
    });
    return Object.freeze({
      anyOf: Object.freeze([
        NULL,
        Object.freeze({
          type: 'object',
          maxProperties: DEFINITIONS_MOST,
          propertyNames: Object.freeze({ pattern: DEFINED_KEY.source }),
          additionalProperties: answer,
        }),
      ]),
      description: `Answers keyed by question: the questions are rows of ${quoted(field.from)}${
        field.whose ? `, those whose ${quoted(field.whose)} names the record and those that name none` : ''
      }. Which are asked and required, and what each takes, is judged where the command runs.`,
    });
  }
  const cause = `an input of type ${quoted(String((field as { type: unknown }).type))} has no JSON Schema description`;
  undescribed.push(Object.freeze({ path, cause }));
  return Object.freeze({ description: `Not described here (${cause}); the server judges it.` });
}

function listSchema(fields: readonly Field[], within: string, undescribed: ApiInputUndescribed[]): Schema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of fields) {
    const path = within ? `${within}.${field.name}` : field.name;
    // A field asked only where its `when` holds of the record: required there, which no fixed schema can say.
    const condition = (field as { when?: string }).when;
    const needed = (field as { required?: true }).required === true;
    const asked = needed && condition === undefined;
    const when = condition === undefined ? [] : [`Asked only where the record meets: ${condition}.${needed ? ' Required there.' : ''}`];
    try {
      if (field.type === 'group') {
        const members = listSchema(field.fields, path, undescribed);
        const full = field.fields.some((member) => (member as { required?: true }).required === true);
        const notes = field.help ? [field.help] : [];
        if (field.repeat) {
          const rows = Object.freeze({
            type: 'array',
            ...(field.repeat.min ? { minItems: field.repeat.min } : {}),
            maxItems: field.repeat.max,
            items: members,
          });
          properties[field.name] = described(field.repeat.min ? rows : Object.freeze({ anyOf: Object.freeze([NULL, rows]) }), notes);
          if (field.repeat.min) required.push(field.name);
        } else {
          properties[field.name] = described(full ? members : Object.freeze({ anyOf: Object.freeze([NULL, members]) }), notes);
          if (full) required.push(field.name);
        }
      } else if (field.type === 'lines') {
        const cell = Object.freeze({
          anyOf: Object.freeze([
            Object.freeze({ type: 'string', maxLength: 10000, pattern: REQUIRED_TEXT }),
            Object.freeze({ type: 'number' }),
            Object.freeze({ type: 'boolean' }),
          ]),
        });
        const line = Object.freeze({
          type: 'object',
          additionalProperties: false,
          properties: Object.freeze(Object.fromEntries(field.show.map((column) => [column, cell]))),
          required: Object.freeze([...field.show]),
        });
        const rows = Object.freeze({ type: 'array', ...(field.min ? { minItems: field.min } : {}), maxItems: field.max, items: line });
        properties[field.name] = described(field.min ? rows : Object.freeze({ anyOf: Object.freeze([NULL, rows]) }), [
          `Lines of ${quoted(field.from)}, each its ${field.show.map(quoted).join(', ')}, read as that resource's columns.`,
          ...(field.help ? [field.help] : []),
        ]);
        if (field.min) required.push(field.name);
      } else {
        const schema = scalarSchema(field, asked, path, undescribed);
        properties[field.name] = when.length
          ? described(schema, [...when, ...(typeof schema.description === 'string' ? [schema.description] : [])])
          : schema;
        if (asked) required.push(field.name);
      }
    } catch (error) {
      const cause = error instanceof Error ? error.message : 'it could not be described';
      undescribed.push(Object.freeze({ path, cause }));
      properties[field.name] = Object.freeze({ description: `Not described here (${cause}); the server judges it.` });
    }
  }
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: Object.freeze(properties),
    required: Object.freeze(required),
  });
}

/** Takes only {input: authored field declarations}. Command registrations,
 * callbacks, prefill and post-validation output are deliberately not inputs.
 * Every declared kind is described: its shape as JSON Schema, and what JSON
 * Schema cannot say (a pattern after trimming, a sibling, the record a `when`
 * reads, the row a reference names) in its `description`. The command reader
 * stays the judge of what is admitted; an input this cannot describe is left
 * open and named in `undescribed`, so it degrades itself, not the tool.
 */
export function renderApiInputSchema(declaration: unknown) {
  let fields: ReturnType<typeof parseCommandInput>;
  try {
    const captured = snapshot(declaration, 131072).value;
    if (
      !captured ||
      typeof captured !== 'object' ||
      Array.isArray(captured) ||
      Object.keys(captured).length !== 1 ||
      !Object.hasOwn(captured, 'input')
    )
      return refuse();
    fields = parseCommandInput((captured as Readonly<Record<string, unknown>>).input, 'Command input schema preview');
  } catch {
    return refuse();
  }
  const undescribed: ApiInputUndescribed[] = [];
  const schema = listSchema(fields, '', undescribed);
  return Object.freeze({
    stage: 'raw-command-input-schema-preview' as const,
    customValidation: 'unsupported' as const,
    execution: 'pending' as const,
    publication: 'pending' as const,
    undescribed: Object.freeze(undescribed),
    schema: schema as Readonly<{
      type: 'object';
      additionalProperties: false;
      properties: Readonly<Record<string, Schema>>;
      required: readonly string[];
    }>,
  });
}
