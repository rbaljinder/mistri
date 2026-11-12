import type { CommandChoiceSource, CommandFieldPresentation } from '@mistriwork/engine/schema/model.js';
import type {
  AppCommandChoice,
  AppCommandField,
  AppCommandReference,
  AppFormCommandReference,
  CommandFieldDefault,
  CommandRichTextMentions,
} from '../../schema/command.js';
import { columnKind, tableNamed, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { ANYONE, parseQuery, quoteValue } from '@mistriwork/engine/shared/query.js';
import { maskQuoted } from '@mistriwork/engine/shared/maskQuoted.js';
import { parseViewQuery } from '@mistriwork/engine/shared/view.js';
import { unknownKey } from '@mistriwork/engine/shared/suggest.js';
import { normalizeAppFlagGate } from './appFlagGates.js';
import type { FlagCatalog } from './appFlags.js';
import { TEXT_RULE_MOST as TEXT_INPUT_MOST } from '@mistriwork/engine/shared/textRules.js';
import { RICH_TEXT_MOST } from '@mistriwork/engine/shared/richText.js';
import { mentionLabelColumns } from '@mistriwork/engine/shared/mentionLabel.js';
import { commandFieldsDeep, isIsoDate } from '@mistriwork/engine/shared/commandWire.js';
import { isMessageRef } from '@mistriwork/engine/shared/appMessages.js';
import type { DraftRule } from './commandDraft.js';
export { BULK_LIMIT, commandFieldsDeep, commandKeyText, isIsoDate } from '@mistriwork/engine/shared/commandWire.js';

export type {
  Action,
  AppAction,
  AppUpdateAction,
  AppCommandAction,
  AppCommandChoice,
  AppCommandField,
  AppCommandGroup,
  AppCommandLines,
  AppCommandReference,
  AppFormCommandReference,
  AppFlagGate,
  CommandAction,
  CommandField,
  CommandInput,
  CommandInputOf,
  CommandInitialOf,
} from '../../schema/command.js';

/** A served reference without `targets` names one record. */
export const commandTargets = (reference: { targets?: 'one' | 'many' }): 'one' | 'many' => reference.targets ?? 'one';

const reserved = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const fail = (where: string, reason: string): never => {
  throw new Error(`${where}: ${reason}.`);
};

function record(raw: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![null, Object.prototype].includes(Object.getPrototypeOf(raw)))
    return fail(where, 'expected a plain data object');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string') return fail(where, 'unknown command metadata property');
    if (!keys.includes(key)) throw new Error(`${where} ${unknownKey(key, keys)}.`);
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) return fail(where, 'expected enumerable data properties');
    result[key] = descriptor.value;
  }
  return result;
}

function text(raw: unknown, where: string, limit = 500): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > limit)
    return fail(where, `expected nonempty text of at most ${limit} characters`);
  return raw.trim();
}

/* An input's words: text, or a `msg()` kept as it is written. The loader says each in the App's own words for the
   server and in each reader's for the form (businessCommands.ts withCommandWords, apps.ts); the browser parses only
   what was said. */
function caption(raw: unknown, where: string, limit = 500): string {
  return isMessageRef(raw) ? (raw as unknown as string) : text(raw, where, limit);
}

/* A mention's label: a column, or a template of the people's own columns ('{first_name} {last_name}', mentionLabel.ts). */
function mentionLabel(raw: unknown, where: string): string {
  if (typeof raw !== 'string' || !raw.includes('{')) return name(raw, where);
  const read = mentionLabelColumns(raw);
  if ('problem' in read) return fail(where, `label ${read.problem}`);
  for (const column of read.columns) name(column, `${where}, label "${raw}"`);
  return raw;
}

function name(raw: unknown, where: string, qualified = false): string {
  if (typeof raw !== 'string' || raw.length > 128) return fail(where, 'expected a logical identifier');
  const parts = raw.split('.');
  if (parts.length > (qualified ? 2 : 1) || parts.some((part) => !identifier.test(part) || reserved.has(part))) {
    return fail(where, 'expected a non-reserved logical identifier');
  }
  return raw;
}

/**
 * The caps a command's input declaration and its values live under. A list
 * of fields (the command's own, or a group's) holds at most `listFields`; the
 * whole declaration, groups and their members at every depth, at most
 * `totalFields`; a group may hold a group, and no deeper (`depth`). A
 * repeating group admits at most `repeatRows` rows, and on a public form at
 * most `publicRepeatRows`; a public submission's input is at most
 * `publicInputBytes` of JSON, inside the envelope bound every command has.
 */
export const COMMAND_INPUT_LIMITS = Object.freeze({
  listFields: 32,
  totalFields: 128,
  depth: 2,
  repeatRows: 50,
  publicRepeatRows: 10,
  choiceOptions: 100,
  publicInputBytes: 32_768,
  /** The most files one `field.files` takes, and its `max` where it says none. */
  files: 20,
  filesDefault: 10,
});

/** A held file's id as a form sends it: 32 random bytes, base64url (server/commands/stagedFiles.ts). Only its hash is kept. */
export const STAGED_FILE_ID = /^[A-Za-z0-9_-]{43}$/;

/** A media type `accept` takes: `image/*` or `application/pdf`, lower case. */
const MEDIA_PATTERN = /^[a-z0-9][a-z0-9.+-]{0,63}\/(?:\*|[a-z0-9][a-z0-9.+-]{0,63})$/;

/** Whether a file's media type is one an `accept` list takes; an absent list takes every type. */
export function acceptsMedia(accept: readonly string[] | undefined, type: string): boolean {
  if (!accept?.length) return true;
  const media = type.toLowerCase();
  return accept.some((pattern) => (pattern.endsWith('/*') ? media.startsWith(pattern.slice(0, -1)) : media === pattern));
}

/* A moment, as ISO 8601 says one: a date, a time to the minute or finer, and a zone — `Z` or an offset. The
   separator may be the `T` or a space, as Postgres writes a timestamptz (`2026-10-12 19:16:00-04`). */
const INSTANT = /^(\d{4}-\d{2}-\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,9}))?)?(Z|[+-](?:0\d|1[0-4])(?::?[0-5]\d)?)$/;

/**
 * A moment as one spelling: the UTC instant `YYYY-MM-DDTHH:MM:SS.sssZ` it names, or undefined. A value with no zone
 * is not one — the same wall time is a different moment in every zone — and a `Date` is read as the moment it holds.
 * Beyond milliseconds a fraction is dropped, as a JavaScript date keeps it.
 */
export function isoInstant(value: unknown): string | undefined {
  let time: number;
  if (value instanceof Date) time = Date.prototype.getTime.call(value);
  else {
    if (typeof value !== 'string' || value.length > 40) return undefined;
    const match = INSTANT.exec(value);
    if (!match || !isIsoDate(match[1])) return undefined;
    const [, date, hour, minute, seconds = '00', fraction = '', zone] = match;
    const digits = zone.replace(':', '');
    const offset = zone === 'Z' ? 0 : (zone[0] === '-' ? -1 : 1) * (Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5) || 0));
    time = Date.parse(`${date}T${hour}:${minute}:${seconds}.${fraction.padEnd(3, '0').slice(0, 3)}Z`) - offset * 60_000;
  }
  if (!Number.isFinite(time)) return undefined;
  const at = new Date(time);
  return at.getUTCFullYear() >= 0 && at.getUTCFullYear() <= 9999 ? at.toISOString() : undefined;
}

/** Dense, plain list items, each a data property. */
function items(raw: unknown, where: string, what: string, max: number, noun: string): unknown[] {
  if (
    !Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Array.prototype ||
    raw.length > max ||
    Reflect.ownKeys(raw).length !== raw.length + 1
  )
    return fail(where, `${what} must be a dense list of at most ${max} ${noun}`);
  const result: unknown[] = [];
  for (let index = 0; index < raw.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) return fail(where, `${what} must contain only enumerable data ${noun}`);
    result.push(descriptor.value);
  }
  return result;
}

/** The names a field's `when` reads — the input's fields, the record's columns or paths, the tenant's shared
 * profile columns — or a throw where it does not parse. */
type ConditionNames = (text: string, where: string) => { fields: string[]; record: string[]; tenant: string[] };

/** The most references a `record.<path>` follows from the target (`record.customer_id.region_id.code` is two):
 * each hop is a read, and a longer chain is the handler's to walk. */
export const RECORD_HOPS = 2;

interface FieldRules {
  depth: number;
  publicForm: boolean;
  count: { fields: number };
  /* The condition compiler's reading of a `when` (commandDraft.ts draftNames), handed in by parseCommandInput
     (commandInputParse.ts): this module is in every page's module graph, the browser never parses a declaration,
     and a static import here put the compiler on every public page's first paint. */
  names: ConditionNames;
}

/** An App icon's name, as a choice's icon is: what a `msg()` icon must say too. */
const choiceIcon = (raw: unknown): boolean => typeof raw === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(raw);

/** A `msg()` icon said as something no App icon is named, in a command's input said in one language: refused as a
 * written one is. The loader asks it of the source words and of each reader's (apps.ts). */
export function saidIconProblem(fields: readonly AppCommandField[], where: string): string | undefined {
  for (const { field, path } of commandFieldsDeep(fields))
    for (const option of 'options' in field && Array.isArray(field.options) ? (field.options as AppCommandChoice[]) : [])
      if (option.icon !== undefined && !choiceIcon(option.icon))
        return `${where}: "${path}" says the icon "${String(option.icon)}"; a choice's icon is an App icon's name, such as 'shield-check'.`;
  return undefined;
}

function choiceOption(raw: unknown, where: string): AppCommandChoice {
  const o = record(raw, ['value', 'label', 'icon', 'help'], where);
  const value = o.value;
  if (!(typeof value === 'string' && value.trim() && value.length <= 120) && !(typeof value === 'number' && Number.isFinite(value))) {
    return fail(where, 'a choice value must be nonempty text of at most 120 characters or a finite number');
  }
  if (o.icon !== undefined && !isMessageRef(o.icon) && !choiceIcon(o.icon))
    return fail(where, "a choice's icon is an App icon's name, such as 'shield-check'");
  return {
    value: value as string | number,
    label: caption(o.label, where, 120),
    ...(o.icon === undefined ? {} : { icon: o.icon as string }),
    ...(o.help === undefined ? {} : { help: caption(o.help, where, 200) }),
  };
}

/** A field's label when it gives none, read from its key: `applicant_email` is "Applicant email", `reviewerId` "Reviewer id". */
export function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A declared pattern, matched whole: what the browser and the server both test a value against. */
export const fieldPattern = (source: string): RegExp => new RegExp(`^(?:${source})$`);

const FORMATS = new Set(['email', 'url', 'phone']);

/** A rich text input's most characters of stored HTML, unless it says otherwise: room for a long note with a table in it. */
const RICH_TEXT_FIELD_DEFAULT = 65_536;

/* What a field starts as. A literal, today, now and the record's own value
   are the browser's or prepare's to fill in, so only the shape is judged
   here; whether a literal passes the field's own checks is the server's,
   where the command is defined (businessCommands.ts). */
const START_WORDS: Record<string, readonly string[]> = { today: ['date'], now: ['datetime'], me: ['text'] };
function fieldStart(raw: unknown, made: AppCommandField, where: string, rules: FieldRules): CommandFieldDefault {
  const at = `${where}: default`;
  if (made.type === 'group') return fail(where, 'a group starts as its fields do; give each of them its default');
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const start = raw as Record<string, unknown>;
    const word =
      Object.keys(start).length === 1
        ? (start.auto ?? (typeof start.record === 'string' ? 'record' : typeof start.tenant === 'string' ? 'tenant' : undefined))
        : undefined;
    if (word === 'record' || word === 'me' || word === 'tenant') {
      if (rules.publicForm) return fail(at, 'a public form has no record, no reader and no member to start a field from');
      if (rules.depth)
        return fail(at, `${word === 'me' ? 'me' : `{ ${word as string} }`} fills a field of the input itself, not one inside a group`);
    }
    if (word === 'record') {
      // A column of the record, or one its references reach (`customer_id.default_rate`), judged against them where bound.
      const path = String(start.record).split('.');
      if (path.length > RECORD_HOPS + 1)
        return fail(at, `{ record: '${String(start.record)}' } follows more than ${RECORD_HOPS} references; read a nearer column`);
      for (const part of path) name(part, at);
      return { record: start.record as string };
    }
    if (word === 'tenant') return { tenant: name(start.tenant, at) };
    if (typeof word === 'string' && START_WORDS[word]?.includes(made.type)) return { auto: word as 'today' | 'now' | 'me' };
    return fail(
      at,
      'is a literal, today (a date field), now (a datetime field), me (a text field), { record: column } or { tenant: column }',
    );
  }
  if (typeof raw === 'string' || typeof raw === 'boolean' || (typeof raw === 'number' && Number.isFinite(raw))) return raw;
  return fail(
    at,
    'is a literal, today (a date field), now (a datetime field), me (a text field), { record: column } or { tenant: column }',
  );
}

/* An input asked only while a condition over the draft holds: a bare name is another field of this input, and
   `record.<column>` the target's own. Its words are read here;
   the names it reads are judged beside its siblings (fieldList) and, for the record's, against the target where
   the command is bound (businessCommandAuthorization.ts), rollups and computed columns included. */
function fieldWhen(f: Record<string, unknown>, where: string, rules: FieldRules): string {
  const at = `${where}: when`;
  if (typeof f.when !== 'string' || !f.when.trim() || f.when.length > 1000)
    return fail(at, "is a condition over the draft, as text: another field's name (trade_in = true) or record.<column>");
  if (f.type === 'group') return fail(at, "is a single field's: a group is asked whole");
  if (rules.depth) return fail(at, 'asks a field of the input itself, not one inside a group');
  let names: { fields: string[]; record: string[]; tenant: string[] };
  try {
    names = rules.names(f.when.trim(), at);
  } catch (error) {
    return fail(at, (error as Error).message.replace(/^.*?: /, '').replace(/\.$/, ''));
  }
  if (names.record.length && rules.publicForm) return fail(at, `reads record.${names.record[0]}, and a public form has no record`);
  if (names.tenant.length && rules.publicForm) return fail(at, `reads tenant.${names.tenant[0]}, and a public form has no member`);
  return f.when.trim();
}

/* A mask: `0` a digit, `a` a letter, `*` either, anything else a character drawn as written. It is the value's
   pattern too, over what its places hold. */
const MASK = /^[^\p{Cc}]{1,64}$/u;
export function maskPattern(mask: string): string {
  return [...mask].map((c) => (c === '0' ? '\\d' : c === 'a' ? '[A-Za-z]' : c === '*' ? '[A-Za-z0-9]' : '')).join('');
}
/** How many characters a mask's places hold. */
const maskPlaces = (mask: string): number => [...mask].filter((c) => c === '0' || c === 'a' || c === '*').length;

const KEEPS = ['last4', 'hash', 'none', 'handler'] as const;
const PRESENTATIONS: Record<string, readonly string[]> = {
  number: ['slider', 'rating'],
  text: ['scan', 'color'],
  money: ['slider'],
  boolean: ['buttons'],
  choice: ['cards', 'buttons', 'select', 'radios'],
  choices: ['cards', 'select'],
};
const LIVE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const COMPONENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;

/* A month, `YYYY-MM`. */
export const isIsoMonth = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
/* A time of day, `HH:MM` on a 24-hour clock: one spelling, so bounds and siblings compare as text. */
export const isIsoTime = (value: unknown): value is string => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
/** A color as a text field asks it (`as: 'color'`): `#` and six hex digits, as a column's color format keeps one. */
export const isHexColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
/** A rating's stars when it says none, and its bounds, as a column's rating takes them (appValidation's outOf). */
const RATING = { outOf: 5, least: 3, most: 10 } as const;

/* Choices read from a table: its rows by key, shown by a column, in the order of that column unless `sort` says one. */
function choiceSource(f: Record<string, unknown>, where: string): CommandChoiceSource {
  if (f.options !== undefined) return fail(where, 'names its options or a table to read them from (from), not both');
  if (f.labelColumn === undefined)
    return fail(
      where,
      `reads its choices from "${String(f.from)}" and needs labelColumn: the column each is shown by` +
        (typeof f.label === 'string' ? " (label is the field's own title, and no longer names that column)" : ''),
    );
  let sort: CommandChoiceSource['sort'];
  if (f.sort !== undefined) {
    const said = record(f.sort, ['column', 'direction'], `${where}, sort`);
    if (said.direction !== undefined && said.direction !== 'asc' && said.direction !== 'desc')
      return fail(where, "sort.direction is 'asc' or 'desc'");
    sort = { column: name(said.column, `${where}, sort.column`), direction: (said.direction as 'asc' | 'desc' | undefined) ?? 'asc' };
  }
  return {
    from: name(f.from, `${where}, from`, true),
    by: f.by === undefined ? 'id' : name(f.by, `${where}, by`),
    labelColumn: name(f.labelColumn, `${where}, labelColumn`),
    ...(sort ? { sort } : {}),
  };
}

/* `as`: how the field is drawn, one its kind can be drawn as. */
function presentation(f: Record<string, unknown>, where: string): { as?: CommandFieldPresentation } {
  if (f.as === undefined) return {};
  const allowed = PRESENTATIONS[String(f.type)] ?? [];
  if (typeof f.as !== 'string' || !allowed.includes(f.as))
    return fail(
      where,
      allowed.length
        ? `as is how a ${String(f.type)} field is drawn: ${allowed.map((a) => `'${a}'`).join(', ')}`
        : `a ${String(f.type)} field is drawn one way; it takes no as`,
    );
  return { as: f.as as CommandFieldPresentation };
}

/* `input`: the App's own input component, by its name in `ui.inputs`. A public form's page draws it too: the code is
   served to a visitor like a public page's components, and the value is still the field's kind's to judge. */
function componentName(raw: unknown, where: string): string {
  if (typeof raw !== 'string' || !COMPONENT_NAME.test(raw))
    return fail(where, "input names one of the App's input components (ui.inputs) by its name");
  return raw;
}

/* `live`: lines said under a number as it is typed — expressions over the input's numbers, read where the siblings
   are known (fieldList), never sent. */
function liveLines(raw: unknown, where: string): Record<string, string> {
  const lines = record(raw, Object.keys(raw && typeof raw === 'object' ? raw : {}), `${where}, live`);
  const entries = Object.entries(lines);
  if (!entries.length || entries.length > 4) return fail(where, "live says one to four lines: { monthly: 'biweekly_gross * 26 / 12' }");
  for (const [word, expression] of entries) {
    if (!LIVE_NAME.test(word)) return fail(where, `live "${word}" is a short word, said after the figure`);
    if (typeof expression !== 'string' || !expression.trim() || expression.length > 500)
      return fail(where, `live "${word}" is an expression over this input's numbers, at most 500 characters`);
  }
  return Object.fromEntries(entries.map(([word, expression]) => [word, (expression as string).trim()]));
}

/** The input names a live line reads: the identifiers in its expression. */
const liveNames = (expression: string): string[] =>
  [...new Set(expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])].filter((word) => !/^(?:and|or|not|true|false|null)$/.test(word));

function field(key: string, raw: unknown, where: string, rules: FieldRules): AppCommandField {
  const made = fieldShape(key, raw, where, rules);
  const start = (raw as { default?: unknown }).default;
  return start === undefined ? made : ({ ...made, default: fieldStart(start, made, where, rules) } as AppCommandField);
}

function fieldShape(key: string, raw: unknown, where: string, rules: FieldRules): AppCommandField {
  if (++rules.count.fields > COMMAND_INPUT_LIMITS.totalFields) {
    return fail(where, `a command declares at most ${COMMAND_INPUT_LIMITS.totalFields} fields, groups and their members included`);
  }
  /* A reference picker's words before 1.0, refused with the ones that replaced them. */
  for (const [old, now] of [
    ['resource', '"from": the resource the picker offers'],
    ['value', '"by": the key column a pick stores'],
  ] as const) {
    if (raw && typeof raw === 'object' && Object.hasOwn(raw, old)) throw new Error(`${where} has "${old}", which is now ${now}.`);
  }
  const f = record(
    raw,
    [
      'type',
      'label',
      'help',
      'placeholder',
      'optional',
      'min',
      'max',
      'format',
      'pattern',
      'message',
      'case',
      'integer',
      'step',
      'below',
      'above',
      'by',
      'labelColumn',
      'sort',
      'query',
      'options',
      'fields',
      'repeat',
      'keyed',
      'accept',
      'description',
      'mentions',
      'images',
      'default',
      'when',
      'from',
      'whose',
      'show',
      'copy',
      'mask',
      'sensitive',
      'live',
      'minor',
      'currency',
      'statement',
      'exclusive',
      'as',
      'input',
      'outOf',
      'tree',
    ],
    where,
  );
  if (f.keyed !== undefined)
    throw new Error(`${where} has "keyed", which is now sensitive: { keep: 'hash' }: one way to keep a value the App must not hold.`);
  if (f.optional !== undefined && typeof f.optional !== 'boolean') return fail(where, 'optional must be true or false');
  // Required unless it says otherwise: a form asks for what its command needs.
  // A group says its words as `description`, as a form's groups do; `help` stays under a single input.
  if (f.type === 'group' && f.help !== undefined)
    throw new Error(`${where} (a group field) ${unknownKey('help', ['type', 'label', 'optional', 'fields', 'repeat', 'description'])}.`);
  if (f.type === 'lines' && f.help !== undefined)
    throw new Error(
      `${where} (a lines field) ${unknownKey('help', ['type', 'label', 'from', 'show', 'copy', 'query', 'min', 'max', 'description'])}.`,
    );
  /* Example text inside an empty box: only a box has one, as a resource form's field takes it. */
  if (f.placeholder !== undefined) {
    if (!(['text', 'textarea', 'number', 'money'] as unknown[]).includes(f.type) || f.as === 'rating' || f.as === 'slider')
      return fail(
        where,
        `placeholder is example text inside an empty text, number or money box; a ${String(f.as ?? f.type)} field has none`,
      );
  }
  const base = {
    name: key,
    label: f.label === undefined ? fieldLabel(key) : caption(f.label, where, 120),
    ...(f.help === undefined ? {} : { help: caption(f.help, where) }),
    ...(f.placeholder === undefined ? {} : { placeholder: caption(f.placeholder, where, 256) }),
    ...((f.type === 'group' || f.type === 'lines') && f.description !== undefined ? { help: caption(f.description, where) } : {}),
    ...(f.optional === true ? {} : { required: true }),
    ...(f.when === undefined ? {} : { when: fieldWhen(f, where, rules) }),
    ...presentation(f, where),
    ...(f.input === undefined ? {} : { input: componentName(f.input, where) }),
  };
  const common = ['type', 'label', 'help', 'optional', 'default', 'when', 'as', 'input'];
  const extra = Object.keys(f).filter((key) => !common.includes(key));
  const only = (allowed: string[]) => {
    const stray = extra.find((key) => !allowed.includes(key));
    if (stray !== undefined) throw new Error(`${where} (a ${String(f.type)} field) ${unknownKey(stray, [...common, ...allowed])}.`);
  };
  const sibling = (key: 'below' | 'above') => (f[key] === undefined ? {} : { [key]: name(f[key], where) });
  if (f.type === 'text' || f.type === 'textarea') {
    only(['placeholder', 'min', 'max', 'format', 'pattern', 'message', 'case', 'mask', 'sensitive']);
    /* A code the camera reads is typed through no mask and never hidden: what was read is shown, to be corrected. A
       color is its own format, `#rrggbb`, which the picker writes and nothing else needs to say. */
    if (base.as === 'scan' && (f.mask !== undefined || f.sensitive !== undefined))
      return fail(where, "as: 'scan' shows the code it read, to be corrected by hand; it takes no mask and is not sensitive");
    if (base.as === 'color') {
      const stray = ['min', 'max', 'format', 'pattern', 'message', 'case', 'mask', 'sensitive'].find((key) => f[key] !== undefined);
      if (stray !== undefined) return fail(where, `as: 'color' is its own format, #rrggbb; it takes no ${stray}`);
    }
    if (f.mask !== undefined) {
      if (f.type !== 'text' || typeof f.mask !== 'string' || !MASK.test(f.mask) || !maskPlaces(f.mask))
        return fail(
          where,
          "mask is the shape a text's value is typed in: 0 a digit, a a letter, * either ('000-00-0000'), on a text field",
        );
      if (f.pattern !== undefined || f.format !== undefined)
        return fail(where, 'a mask is its own pattern; give a mask, a pattern or a format');
    }
    let sensitive: { keep: (typeof KEEPS)[number] } | undefined;
    if (f.sensitive !== undefined) {
      const said = record(f.sensitive, ['keep'], `${where}, sensitive`);
      if (f.type !== 'text' || !(KEEPS as readonly unknown[]).includes(said.keep))
        return fail(where, "sensitive is { keep: 'last4' | 'hash' | 'none' | 'handler' }, on a text field");
      if (f.default !== undefined) return fail(where, 'a sensitive field is never prefilled; it takes no default');
      if (said.keep === 'handler' && rules.depth)
        return fail(where, "keep: 'handler' is a field of the input itself, not one inside a group");
      sensitive = { keep: said.keep as (typeof KEEPS)[number] };
    }
    for (const bound of ['min', 'max'] as const) {
      if (f[bound] !== undefined && (!Number.isSafeInteger(f[bound]) || Number(f[bound]) < 1 || Number(f[bound]) > TEXT_INPUT_MOST)) {
        return fail(where, `${bound} must be a number of characters from 1 to ${TEXT_INPUT_MOST}`);
      }
    }
    if (f.min !== undefined && f.max !== undefined && Number(f.min) > Number(f.max)) return fail(where, 'min must not exceed max');
    if (f.format !== undefined && (f.type !== 'text' || !FORMATS.has(f.format as string)))
      return fail(where, 'format is "email", "url" or "phone", on a text field');
    if (f.pattern !== undefined) {
      if (typeof f.pattern !== 'string' || !f.pattern || f.pattern.length > 500)
        return fail(where, "pattern must be a regular expression's source, at most 500 characters");
      try {
        fieldPattern(f.pattern);
      } catch {
        return fail(where, 'pattern is not a regular expression');
      }
    }
    // A mask is a pattern too, and its sentence is the author's to word ("Enter the 5 digits of your ZIP").
    if (f.message !== undefined && f.pattern === undefined && f.format === undefined && f.mask === undefined)
      return fail(where, 'message is what a pattern, format or mask says; give one');
    if (f.case !== undefined && f.case !== 'upper' && f.case !== 'lower') return fail(where, 'case is "upper" or "lower"');
    return {
      ...base,
      type: f.type,
      ...(f.min === undefined ? {} : { minLength: f.min as number }),
      ...(f.max === undefined ? {} : { maxLength: f.max as number }),
      ...(f.format === undefined ? {} : { format: f.format as 'email' | 'url' | 'phone' }),
      ...(f.pattern === undefined ? {} : { pattern: f.pattern as string }),
      ...(f.message === undefined ? {} : { message: text(f.message, where, 200) }),
      ...(f.case === undefined ? {} : { case: f.case as 'upper' | 'lower' }),
      ...(f.mask === undefined ? {} : { mask: f.mask as string }),
      ...(sensitive ? { sensitive } : {}),
    };
  }
  if (f.type === 'richText') {
    only(['min', 'max', 'mentions', 'images']);
    if (rules.publicForm && (f.mentions !== undefined || f.images !== undefined))
      return fail(where, `input "${base.name}" offers mentions or images; a public form may not read a directory or keep files`);
    if (f.max !== undefined && (!Number.isSafeInteger(f.max) || Number(f.max) < 1 || Number(f.max) > RICH_TEXT_MOST))
      return fail(where, `max must be a number of characters from 1 to ${RICH_TEXT_MOST}`);
    // The words a reader sees, not the markup kept: a body of 20 characters is 20 characters of text.
    if (f.min !== undefined && (!Number.isSafeInteger(f.min) || Number(f.min) < 1 || Number(f.min) > 16384))
      return fail(where, 'min must be a number of characters of text from 1 to 16384');
    let mentions: CommandRichTextMentions | undefined;
    if (f.mentions !== undefined) {
      for (const said of [f.mentions, (f.mentions as Record<string, unknown> | null)?.groups])
        if (said && typeof said === 'object' && Object.hasOwn(said, 'label'))
          throw new Error(`${where}, mentions has "label", which is now "labelColumn": the column a person is shown by.`);
      const m = record(f.mentions, ['from', 'by', 'labelColumn', 'groups'], `${where}, mentions`);
      /* The teams an @ names as well, as a display rule's `mentions.groups`: a command's
         reply or work note reached only people, though the conversation draws and tells a team. */
      const g =
        m.groups === undefined ? undefined : record(m.groups, ['from', 'by', 'labelColumn', 'through'], `${where}, mentions.groups`);
      mentions = {
        from: name(m.from, `${where}, mentions`, true),
        by: name(m.by, `${where}, mentions`),
        ...(m.labelColumn === undefined ? {} : { labelColumn: mentionLabel(m.labelColumn, `${where}, mentions`) }),
        ...(g
          ? {
              groups: {
                from: name(g.from, `${where}, mentions.groups`, true),
                by: name(g.by, `${where}, mentions.groups`),
                ...(g.labelColumn === undefined ? {} : { labelColumn: mentionLabel(g.labelColumn, `${where}, mentions.groups`) }),
                /* The link rows that put a person in a team, as a display rule's: a team no row
                   names has nobody to tell, so the editor does not offer it. */
                ...(g.through === undefined ? {} : { through: name(g.through, `${where}, mentions.groups`, true) }),
              },
            }
          : {}),
      };
    }
    return {
      ...base,
      type: 'richText',
      ...(f.min === undefined ? {} : { minLength: f.min as number }),
      maxLength: (f.max as number | undefined) ?? RICH_TEXT_FIELD_DEFAULT,
      ...(mentions ? { mentions } : {}),
      ...(f.images === undefined ? {} : { images: name(f.images, `${where}, images`, true) }),
    };
  }
  if (f.type === 'number' || f.type === 'money') {
    only(
      f.type === 'money'
        ? ['placeholder', 'min', 'max', 'step', 'minor', 'currency', 'below', 'above', 'live']
        : ['placeholder', 'min', 'max', 'integer', 'step', 'below', 'above', 'live', 'outOf'],
    );
    /* Stars: a whole number from one to the scale, which is its bounds, so it is said once (`outOf`) and the parser
       below holds it to them as it holds any integer field. */
    if (f.outOf !== undefined && base.as !== 'rating') return fail(where, "outOf is a rating's scale; give as: 'rating' too");
    if (base.as === 'rating') {
      const stray = ['min', 'max', 'step', 'integer', 'live'].find((key) => f[key] !== undefined);
      if (stray !== undefined) return fail(where, `a rating's bounds are its stars, 1 to outOf; it takes no ${stray}`);
      const outOf = f.outOf ?? RATING.outOf;
      if (!Number.isSafeInteger(outOf) || Number(outOf) < RATING.least || Number(outOf) > RATING.most)
        return fail(where, `outOf is a whole number of stars from ${RATING.least} to ${RATING.most}`);
      return {
        ...base,
        type: 'number',
        integer: true,
        min: 1,
        max: outOf as number,
        outOf: outOf as number,
        ...sibling('below'),
        ...sibling('above'),
      } as AppCommandField;
    }
    if (f.minor !== undefined && typeof f.minor !== 'boolean') return fail(where, 'minor must be boolean');
    if (f.currency !== undefined && (typeof f.currency !== 'string' || !/^[A-Z]{3}$/.test(f.currency)))
      return fail(where, "currency must be an ISO 4217 code such as 'EUR'");
    if (f.minor === true && f.step !== undefined)
      return fail(where, 'a minor-unit amount takes its precision from the currency, not a step');
    if (f.type === 'money' && f.step === undefined && f.minor !== true) f.step = 0.01;
    if (f.type === 'money' && f.min === undefined) f.min = 0;
    for (const key of ['min', 'max'] as const)
      if (f[key] !== undefined && (typeof f[key] !== 'number' || !Number.isFinite(f[key]))) fail(where, `${key} must be finite`);
    if (f.min !== undefined && f.max !== undefined && Number(f.min) > Number(f.max)) return fail(where, 'min must not exceed max');
    if (f.integer !== undefined && typeof f.integer !== 'boolean') return fail(where, 'integer must be boolean');
    if (
      f.step !== undefined &&
      (typeof f.step !== 'number' ||
        !Number.isFinite(f.step) ||
        f.step <= 0 ||
        f.step > 1e9 ||
        (f.integer === true && !Number.isSafeInteger(f.step)))
    )
      return fail(where, 'step must be a positive number, whole on an integer field');
    if (base.as === 'slider' && (f.min === undefined || f.max === undefined))
      return fail(where, "a slider runs between its ends: give min and max, or leave out as: 'slider'");
    return {
      ...base,
      type: f.type,
      ...(f.min === undefined ? {} : { min: f.min as number }),
      ...(f.max === undefined ? {} : { max: f.max as number }),
      ...(f.integer === undefined ? {} : { integer: f.integer as boolean }),
      ...(f.step === undefined ? {} : { step: f.step as number }),
      ...(f.minor === true ? { minor: true } : {}),
      ...(f.currency === undefined ? {} : { currency: f.currency as string }),
      ...sibling('below'),
      ...sibling('above'),
      ...(f.live === undefined ? {} : { live: liveLines(f.live, where) }),
    } as AppCommandField;
  }
  if (f.type === 'boolean') {
    only(['accept', 'statement']);
    if (f.accept !== undefined && f.accept !== true) return fail(where, 'accept must be true when it is given');
    // A box that must be checked is never left out: optional would make it a yes or a no again.
    if (f.accept === true && f.optional === true) return fail(where, 'a field that must be accepted cannot also be optional');
    // A statement is the words a checkbox stands beside, whether it must be checked or may be left: a consent to texts
    // is as long as the one to a credit check. A yes or a no drawn as two buttons has no box to stand beside.
    if (f.statement !== undefined && base.as === 'buttons')
      return fail(where, "statement is the words a checkbox stands beside; as: 'buttons' asks a yes or a no, and has none");
    if (f.accept === true && base.as === 'buttons')
      return fail(where, "a box that must be checked is a checkbox; as: 'buttons' asks a yes or a no");
    return {
      ...base,
      type: 'boolean',
      ...(f.accept === true ? { accept: true as const } : {}),
      ...(f.statement === undefined ? {} : { statement: text(f.statement, `${where}, statement`, 2000) }),
    };
  }
  if (f.type === 'month') {
    only(['min', 'max', 'below', 'above']);
    for (const key of ['min', 'max'] as const)
      if (f[key] !== undefined && !isIsoMonth(f[key])) fail(where, `${key} must be a month, YYYY-MM`);
    if (f.min !== undefined && f.max !== undefined && String(f.min) > String(f.max)) return fail(where, 'min must not be after max');
    return {
      ...base,
      type: 'month',
      ...(f.min === undefined ? {} : { min: f.min as string }),
      ...(f.max === undefined ? {} : { max: f.max as string }),
      ...sibling('below'),
      ...sibling('above'),
    };
  }
  if (f.type === 'time') {
    only(['min', 'max', 'below', 'above']);
    for (const key of ['min', 'max'] as const)
      if (f[key] !== undefined && !isIsoTime(f[key])) fail(where, `${key} must be a time of day, HH:MM on a 24-hour clock`);
    if (f.min !== undefined && f.max !== undefined && String(f.min) > String(f.max)) return fail(where, 'min must not be after max');
    return {
      ...base,
      type: 'time',
      ...(f.min === undefined ? {} : { min: f.min as string }),
      ...(f.max === undefined ? {} : { max: f.max as string }),
      ...sibling('below'),
      ...sibling('above'),
    };
  }
  if (f.type === 'date') {
    only(['min', 'max', 'below', 'above']);
    for (const key of ['min', 'max'] as const)
      if (f[key] !== undefined && !isIsoDate(f[key])) fail(where, `${key} must be an ISO date, YYYY-MM-DD`);
    if (f.min !== undefined && f.max !== undefined && String(f.min) > String(f.max)) return fail(where, 'min must not be after max');
    return {
      ...base,
      type: 'date',
      ...(f.min === undefined ? {} : { min: f.min as string }),
      ...(f.max === undefined ? {} : { max: f.max as string }),
      ...sibling('below'),
      ...sibling('above'),
    };
  }
  /* A moment: what a person types as a date and a wall time, in the App's time zone, arrives as the UTC instant. */
  if (f.type === 'datetime') {
    only(['min', 'max', 'below', 'above']);
    const bound = (key: 'min' | 'max') => {
      if (f[key] === undefined) return {};
      const at = isoInstant(f[key]);
      return at === undefined || typeof f[key] !== 'string'
        ? fail(where, `${key} must be an ISO 8601 date and time with its zone, such as 2026-10-12T09:00:00Z`)
        : { [key]: at };
    };
    const min = bound('min'),
      max = bound('max');
    if (min.min !== undefined && max.max !== undefined && min.min > max.max) return fail(where, 'min must not be after max');
    return { ...base, type: 'datetime', ...min, ...max, ...sibling('below'), ...sibling('above') };
  }
  if (f.type === 'choice' || f.type === 'choices') {
    only(
      f.type === 'choices'
        ? ['options', 'from', 'by', 'labelColumn', 'sort', 'min', 'max', 'exclusive']
        : ['options', 'from', 'by', 'labelColumn', 'sort'],
    );
    const source = f.from === undefined ? undefined : choiceSource(f, where);
    if (!source && (f.by !== undefined || f.labelColumn !== undefined || f.sort !== undefined))
      return fail(where, 'by, labelColumn and sort read choices from a table: give from');
    const options = source
      ? []
      : items(f.options, where, 'options', COMMAND_INPUT_LIMITS.choiceOptions, 'options').map((option, index) =>
          choiceOption(option, `${where}, option ${index + 1}`),
        );
    if (!source && !options.length) return fail(where, 'a choice needs at least one option');
    if (new Set(options.map((option) => `${typeof option.value}:${option.value}`)).size !== options.length)
      return fail(where, 'duplicate choice value');
    if (f.type === 'choice') return { ...base, type: 'choice', options, ...(source ? { source } : {}) };
    const cap = COMMAND_INPUT_LIMITS.choiceOptions;
    for (const bound of ['min', 'max'] as const)
      if (
        f[bound] !== undefined &&
        (!Number.isSafeInteger(f[bound]) || Number(f[bound]) < (bound === 'max' ? 1 : 0) || Number(f[bound]) > cap)
      )
        return fail(where, `${bound} must be a whole number of choices up to ${cap}`);
    if (f.min !== undefined && f.max !== undefined && Number(f.min) > Number(f.max)) return fail(where, 'min must not exceed max');
    if (f.min !== undefined && Number(f.min) > 0 && f.optional === true)
      return fail(where, 'a field that must have a choice (min) is not optional');
    let exclusive: (string | number)[] | undefined;
    if (f.exclusive !== undefined) {
      exclusive = items(f.exclusive, `${where}, exclusive`, 'exclusive', cap, 'values') as (string | number)[];
      if (!exclusive.length) return fail(where, 'exclusive names one or more of the options that stand alone');
      if (!source && exclusive.some((value) => !options.some((option) => option.value === value)))
        return fail(where, 'exclusive names a value that is not one of the options');
    }
    return {
      ...base,
      type: 'choices',
      options,
      ...(source ? { source } : {}),
      ...(f.min === undefined ? {} : { min: f.min as number }),
      ...(f.max === undefined ? {} : { max: f.max as number }),
      ...(exclusive ? { exclusive } : {}),
    };
  }
  /* On a public form too: its choices are what `auth.public` opens, read signed out, and the App's public grant is
     judged against it where both are known (forms/savedFormChecks.ts, [public-form-picker]). */
  if (f.type === 'reference') {
    only(['from', 'by', 'labelColumn', 'query', 'tree']);
    const by = name(f.by, where);
    const labelColumn = name(f.labelColumn, where);
    const tree = f.tree === undefined ? undefined : name(f.tree, `${where}, tree`);
    /* The parent column names another row by its key: the key or the name itself would make every row its own parent. */
    if (tree !== undefined && (tree === by || tree === labelColumn))
      return fail(where, `tree names the column that holds each row's parent, not "${tree}", its ${tree === by ? 'key' : 'label'}`);
    return {
      ...base,
      type: 'reference',
      from: name(f.from, where, true),
      by,
      labelColumn,
      ...(f.query === undefined ? {} : { query: text(f.query, where, 2000) }),
      ...(tree === undefined ? {} : { tree }),
    };
  }
  /* Answers to questions that are rows: the rows of `from` an administrator edits while the App runs,
     those `whose` names the record by and those that name none. One object of answers, judged against those rows
     where the command runs; the form draws them once prepare has read them. A public form has no reader to read
     them for, and a group's rows would each ask the same questions again. */
  if (f.type === 'defined') {
    only(['from', 'whose']);
    if (rules.publicForm) return fail(where, `input "${base.name}" asks questions defined in rows; a public form may not read them`);
    if (rules.depth) return fail(where, 'questions defined in rows are a field of the input itself, not one inside a group');
    // Its rows say what each answer starts as and whether it is asked; the field itself is always one object.
    if (f.default !== undefined || f.when !== undefined)
      return fail(where, 'questions defined in rows take no default and no when; their rows say what is asked');
    return {
      ...base,
      type: 'defined',
      from: name(f.from, `${where}, from`, true),
      ...(f.whose === undefined ? {} : { whose: name(f.whose, `${where}, whose`) }),
    };
  }
  /* A record's lines, as the lines grid asks them (CommandLinesField): rows of a resource the command writes, each
     the columns it shows, read as their kinds where the command runs. The grid reads the catalog and offers pickers,
     which a public form has neither of; and a line is already a row, so it sits in no group. */
  if (f.type === 'lines') {
    only(['from', 'show', 'copy', 'query', 'min', 'max', 'description']);
    if (f.optional !== undefined || f.default !== undefined || f.when !== undefined)
      return fail(where, 'lines take no optional, default or when; a min of 0 lets the form send none');
    if (rules.publicForm) return fail(where, `input "${base.name}" asks lines; a public form may not read a directory`);
    if (rules.depth) return fail(where, 'lines are a field of the input itself, not one inside a group');
    const show = items(f.show, `${where}, show`, 'show', 12, 'columns').map((column) => name(column, `${where}, show`));
    if (!show.length || new Set(show).size !== show.length) return fail(where, "show names one to 12 of the row's columns, each once");
    let copy: Record<string, string> | undefined;
    if (f.copy !== undefined) {
      const c = f.copy;
      if (!c || typeof c !== 'object' || Array.isArray(c) || ![null, Object.prototype].includes(Object.getPrototypeOf(c)))
        return fail(where, "copy is an object of a line's column → the reference it is copied through and that record's column");
      const entries = Object.entries(c);
      if (!entries.length || entries.length > 8) return fail(where, 'copy fills one to 8 columns');
      copy = {};
      for (const [column, path] of entries) {
        name(column, `${where}, copy`);
        const [via, read, more] = typeof path === 'string' ? path.split('.') : [];
        if (more !== undefined || !via || !read || !identifier.test(via) || !identifier.test(read))
          return fail(
            `${where}, copy "${column}"`,
            "is a reference the line shows and the column of the record it names: 'variant_id.price_amount'",
          );
        if (!show.includes(via)) return fail(`${where}, copy "${column}"`, `is copied through "${via}", which the line does not show`);
        if (show.includes(column)) return fail(`${where}, copy "${column}"`, 'is asked in show; a copied column is filled, not typed');
        copy[column] = path as string;
      }
    }
    let query: Record<string, string> | undefined;
    if (f.query !== undefined) {
      const q = f.query;
      if (!q || typeof q !== 'object' || Array.isArray(q) || ![null, Object.prototype].includes(Object.getPrototypeOf(q)))
        return fail(where, "query is an object of a shown reference → the rows its picker offers: { variant_id: 'active = true' }");
      const entries = Object.entries(q);
      if (!entries.length) return fail(where, 'query narrows one or more of the shown references');
      query = {};
      for (const [column, condition] of entries) {
        if (!show.includes(column)) return fail(`${where}, query "${column}"`, 'names a column the line does not show');
        const said = text(condition, `${where}, query "${column}"`, 2000);
        /* A line has no one record to read: the form's lines are asked before there is one. */
        if (recordColumnsIn(said).length)
          return fail(`${where}, query "${column}"`, 'reads record.<column>; a line has no one record to read it from');
        query[column] = said;
      }
    }
    const cap = COMMAND_INPUT_LIMITS.repeatRows;
    for (const bound of ['min', 'max'] as const)
      if (
        f[bound] !== undefined &&
        (!Number.isSafeInteger(f[bound]) || Number(f[bound]) < (bound === 'max' ? 1 : 0) || Number(f[bound]) > cap)
      )
        return fail(where, `${bound} must be a whole number of lines up to ${cap}`);
    if (f.min !== undefined && f.max !== undefined && Number(f.min) > Number(f.max)) return fail(where, 'min must not exceed max');
    return {
      name: base.name,
      label: base.label,
      ...(base.help === undefined ? {} : { help: base.help }),
      type: 'lines',
      from: name(f.from, where, true),
      show,
      ...(copy ? { copy } : {}),
      ...(query ? { query } : {}),
      ...(f.min === undefined ? {} : { min: f.min as number }),
      max: (f.max as number | undefined) ?? cap,
    };
  }
  /* Files, sent as they are picked and held for the command (server/commands/stagedFiles.ts): the value is their ids,
     and the handler receives the files. A held file is the person's who sent it and this field's: in a group, the
     field's path, `attachments[].file` (heldFileFields), never a row's index, so adding, removing or reordering rows
     leaves every hold its field's. A signature is the signer's mark on the whole submission, so it stays a field of
     the input itself; and nothing starts as either. */
  if (f.type === 'files' || f.type === 'signature') {
    only(f.type === 'files' ? ['from', 'min', 'max', 'accept'] : ['from']);
    if (f.type === 'signature' && rules.depth) return fail(where, 'a signature is a field of the input itself, not one inside a group');
    const stray = (['default', 'as', 'input'] as const).find((key) => f[key] !== undefined);
    if (stray !== undefined) return fail(where, `${f.type === 'files' ? 'files take' : 'a signature takes'} no ${stray}`);
    const from = name(f.from, `${where}, from`, true);
    if (f.type === 'signature') return { ...base, type: 'signature', from };
    const cap = COMMAND_INPUT_LIMITS.files;
    for (const bound of ['min', 'max'] as const)
      if (f[bound] !== undefined && (!Number.isSafeInteger(f[bound]) || Number(f[bound]) < 1 || Number(f[bound]) > cap))
        return fail(where, `${bound} must be a whole number of files from 1 to ${cap}`);
    const max = (f.max as number | undefined) ?? Math.max(COMMAND_INPUT_LIMITS.filesDefault, (f.min as number | undefined) ?? 1);
    if (f.min !== undefined && Number(f.min) > max) return fail(where, 'min must not exceed max');
    let accept: string[] | undefined;
    if (f.accept !== undefined) {
      const said = typeof f.accept === 'string' ? [f.accept] : items(f.accept, `${where}, accept`, 'accept', 16, 'media types');
      accept = said.map((each) => (typeof each === 'string' ? each.trim().toLowerCase() : ''));
      if (!accept.length || accept.some((each) => !MEDIA_PATTERN.test(each)))
        return fail(where, "accept is a media type or a list of them: 'image/*', 'application/pdf'");
    }
    return {
      ...base,
      type: 'files',
      from,
      ...(f.min === undefined ? {} : { min: f.min as number }),
      max,
      ...(accept ? { accept: [...new Set(accept)] } : {}),
    };
  }
  if (f.type === 'group') {
    only(['fields', 'repeat', 'description']);
    // A group is always present — rows, or an object — so what may be absent is its members.
    if (f.optional !== undefined) return fail(where, 'a group is never optional; its fields are, or its repeat has no min');
    if (rules.depth >= COMMAND_INPUT_LIMITS.depth) return fail(where, `groups nest at most ${COMMAND_INPUT_LIMITS.depth} deep`);
    let repeat: { min?: number; max: number } | undefined;
    if (f.repeat !== undefined) {
      const r = record(f.repeat, ['min', 'max'], `${where}, repeat`);
      const cap = rules.publicForm ? COMMAND_INPUT_LIMITS.publicRepeatRows : COMMAND_INPUT_LIMITS.repeatRows;
      if (!Number.isSafeInteger(r.max) || Number(r.max) < 1 || Number(r.max) > cap) {
        return fail(where, `repeat max must be an integer from 1 to ${cap}${rules.publicForm ? ' on a public form' : ''}`);
      }
      if (r.min !== undefined && (!Number.isSafeInteger(r.min) || Number(r.min) < 0 || Number(r.min) > Number(r.max))) {
        return fail(where, 'repeat min must be an integer from 0 to its max');
      }
      repeat = { ...(r.min === undefined ? {} : { min: r.min as number }), max: r.max as number };
    }
    const fields = fieldList(f.fields, where, { ...rules, depth: rules.depth + 1 });
    if (!fields.length) return fail(where, 'a group needs at least one field');
    return {
      name: base.name,
      label: base.label,
      ...(base.help === undefined ? {} : { help: base.help }),
      type: 'group',
      fields,
      ...(repeat ? { repeat } : {}),
    };
  }
  return fail(where, 'unknown command input type');
}

/* Fields keyed by name, in the order written: the object's own keys, each a
   plain data property. A field below or above another names a sibling of
   its own kind, beside it in this list. */
function fieldList(raw: unknown, where: string, rules: FieldRules): AppCommandField[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![null, Object.prototype].includes(Object.getPrototypeOf(raw))) {
    return fail(where, 'input must be an object of fields keyed by name');
  }
  const keys = Reflect.ownKeys(raw);
  if (keys.length > COMMAND_INPUT_LIMITS.listFields) return fail(where, `input holds at most ${COMMAND_INPUT_LIMITS.listFields} fields`);
  const list = keys.map((key) => {
    const descriptor = typeof key === 'string' ? Object.getOwnPropertyDescriptor(raw, key) : undefined;
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor))
      return fail(where, 'input must contain only enumerable data fields');
    return field(name(key, where), descriptor.value, `${where}, input "${key}"`, rules);
  });
  const byName = new Map(list.map((item) => [item.name, item]));
  const sensitiveField = (named: string) => {
    const other = byName.get(named);
    return other?.type === 'text' && other.sensitive !== undefined;
  };
  for (const item of list) {
    if (item.type !== 'group' && item.type !== 'lines' && item.when !== undefined) {
      for (const named of rules.names(item.when, where).fields) {
        const other = byName.get(named);
        if (other === item) return fail(where, `input "${item.name}" is asked when "${named}"…, which is itself`);
        if (!other) {
          /* Before rc.1 a bare name was the record's column; now it is a field of the input. Said with the rewrite. */
          const unknown = rules.names(item.when, where).fields.filter((word) => !byName.has(word));
          const rewrite = unknown.reduce(
            (text, word) => text.replace(new RegExp(`(?<![\\w.'"])${word}(?![\\w'"])`, 'g'), `record.${word}`),
            item.when,
          );
          return fail(
            where,
            `input "${item.name}" is asked when "${named}"…, which is not a field of this input. A bare name in a field's when is ` +
              `another field of the input; the record's own column is record.${named}: when: ${JSON.stringify(rewrite)}`,
          );
        }
        if (sensitiveField(named))
          return fail(where, `input "${item.name}" is asked when "${named}"…, a sensitive field; nothing reads a sensitive value`);
        if (
          other.type === 'group' ||
          other.type === 'lines' ||
          other.type === 'richText' ||
          other.type === 'choices' ||
          other.type === 'defined' ||
          other.type === 'files' ||
          other.type === 'signature'
        )
          return fail(where, `input "${item.name}" is asked when "${named}"…, a ${other.type} field a condition cannot compare`);
      }
    }
    if ((item.type === 'number' || item.type === 'money') && item.live) {
      for (const [word, expression] of Object.entries(item.live)) {
        for (const named of liveNames(expression)) {
          const other = byName.get(named);
          if (!other || (other.type !== 'number' && other.type !== 'money'))
            return fail(where, `input "${item.name}" live "${word}" reads "${named}", which is not a number field of this input`);
        }
      }
    }
    for (const rule of ['below', 'above'] as const) {
      const other = (item as { below?: string; above?: string })[rule];
      if (other === undefined) continue;
      const sibling = list.find((candidate) => candidate.name === other);
      if (
        !sibling ||
        sibling === item ||
        (sibling.type !== item.type && !(['number', 'money'].includes(sibling.type) && ['number', 'money'].includes(item.type)))
      ) {
        return fail(where, `input "${item.name}" is ${rule} "${other}", which must be another ${item.type} field beside it`);
      }
    }
  }
  return list;
}

/** The field parser behind parseCommandInput (commandInputParse.ts), which hands it the condition compiler's reading. */
export function parseCommandFields(
  raw: unknown,
  where: string,
  options: { publicForm?: boolean; names: ConditionNames },
): AppCommandField[] {
  return fieldList(raw, where, { depth: 0, publicForm: options.publicForm === true, count: { fields: 0 }, names: options.names });
}

/**
 * What the server knows of a command, for an App that names it: its
 * registration's contract, as the browser is served it. The App writes the
 * name alone (`command: 'assignReviewer'`); the definition lives in the
 * server-only commands module, and loading the App fills each name in from
 * here — so an input is declared once, where the handler reads it.
 */
export interface CommandCatalogEntry {
  readonly enabledBy?: import('../../schema/command.js').AppFlagGate;
  /** The contract's version: authority.lock's, 1 until a breaking change is bumped. */
  readonly version: number;
  /** The logical resource it acts on, or inserts into when it names no record. */
  readonly target: string;
  /** How many existing records a request names: one, a selection, or none (a form's command). */
  readonly targets: 'one' | 'many' | 'none';
  readonly realm?: 'tenant' | 'platform';
  /** Run by a public form, and by nothing else. */
  readonly public?: true;
  /** What must hold of the record, in the query language: the command's own `when`, which its actions carry. */
  readonly when?: string;
  readonly input: readonly AppCommandField[];
  /** Its rules over the draft (`rules`), which a form checks step by step and the server again as it runs. */
  readonly rules?: readonly DraftRule[];
  /** A form's command whose form prepares its starting values (`initial`, or `default: me`). */
  readonly prepares?: true;
  /** What the command's form and button are called (`defineCommand({ label })`); left out, its name said as words. */
  readonly label?: string;
}
export type CommandCatalog = ReadonlyMap<string, CommandCatalogEntry>;

/* The catalog the App being parsed names its commands from. Parsing is
   synchronous and one App at a time, so the loader sets it around the parse
   (withCommandCatalog) rather than threading it through every block's parser. */
let catalog: CommandCatalog | undefined;

/** Whether a word names one of the App's commands, in the catalog the App is being parsed with. */
export const isRegisteredCommand = (name: string): boolean => Boolean(catalog?.has(name));

/** A registered command's catalog entry, or undefined for a name the catalog lacks. */
export const registeredCommand = (name: string): CommandCatalogEntry | undefined => catalog?.get(name);

/** Check every registered command, including commands not drawn in this App. */
export function checkCommandCatalogFlagGates(flags: FlagCatalog): void {
  for (const entry of catalog?.values() ?? []) {
    const gate = commandGate(entry);
    if (gate.enabledBy) normalizeAppFlagGate(gate.enabledBy, flags);
  }
}

function commandGate(entry: CommandCatalogEntry): Pick<AppCommandReference, 'enabledBy'> {
  if (!entry || typeof entry !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(entry)))
    throw new Error('Command catalog entries require plain data.');
  const descriptor = Object.getOwnPropertyDescriptor(entry, 'enabledBy');
  if (!descriptor) return {};
  if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Command enabledBy must be an own data property.');
  return { enabledBy: normalizeAppFlagGate(descriptor.value) };
}

/** Run `parse` with the App's commands to resolve names from; a name met with none loaded is refused, naming the flag. */
export function withCommandCatalog<T>(commands: CommandCatalog | undefined, parse: () => T): T {
  const before = catalog;
  catalog = commands;
  try {
    return parse();
  } finally {
    catalog = before;
  }
}

/** The catalog entry an authored name stands for, or the refusal that says why there is none. */
function registered(raw: unknown, where: string): [string, CommandCatalogEntry] {
  if (typeof raw !== 'string') {
    return fail(where, "names its command by name, as the commands module registers it: command: 'assignReviewer'");
  }
  if (!catalog) {
    return fail(
      where,
      `names the command "${raw}", and no commands module is loaded. Give the App its commands module with --commands <file>, ` +
        "or keep it as commands.ts beside the App's manifest",
    );
  }
  const entry = catalog.get(raw);
  if (!entry) {
    const known = [...catalog.keys()];
    return fail(
      where,
      `names the command "${raw}", which the commands module does not register${known.length ? ` (${unknownKey(raw, known).replace(/^has no "[^"]*"\.\s*/, '')})` : ''}`,
    );
  }
  return [raw, entry];
}

const served = (input: readonly AppCommandField[]): AppCommandField[] => structuredClone(input) as AppCommandField[];

/** A command an action or an import runs on an existing record: its name, resolved to what the browser is served. */
export function parseCommandReference(raw: unknown, where: string): AppCommandReference {
  const [id, entry] = registered(raw, where);
  if (entry.targets === 'none')
    return fail(where, `names "${id}", which names no existing record (it is a form's command); run it from commandForm`);
  return {
    id,
    version: entry.version,
    target: entry.target,
    ...(entry.targets === 'many' ? { targets: 'many' as const } : {}),
    ...(entry.realm === undefined ? {} : { realm: entry.realm }),
    ...commandGate(entry),
    input: served(entry.input),
    ...(entry.rules?.length ? { rules: structuredClone(entry.rules) as DraftRule[] } : {}),
  };
}

/** A command an API exposes, by name: one on a record, or a signed-in form's, as its registration says. */
export function parseExposedCommandReference(raw: unknown, where: string): AppCommandReference | AppFormCommandReference {
  const [, entry] = registered(raw, where);
  return entry.targets === 'none' ? parseFormCommandReference(raw, where, false) : parseCommandReference(raw, where);
}

/**
 * The command a form runs, by name: one that names no existing record. A
 * public form's must be registered `public: true`, and a signed-in form's
 * must not: a public command runs only for whoever submits a public form.
 */
export function parseFormCommandReference(raw: unknown, where: string, publicForm: boolean): AppFormCommandReference {
  const [id, entry] = registered(raw, where);
  if (entry.targets !== 'none')
    return fail(
      where,
      `names "${id}", which acts on an existing record; a form's command creates records and names none (targets: 'none')`,
    );
  if (publicForm && entry.public !== true) return fail(where, `is public and names "${id}", which is not registered with public: true`);
  if (!publicForm && entry.public === true) {
    return fail(
      where,
      `is signed in and names "${id}", which is registered with public: true. A public command runs only from a public form (public: true)`,
    );
  }
  return {
    id,
    version: entry.version,
    ...commandGate(entry),
    input: served(entry.input),
    ...(entry.rules?.length ? { rules: structuredClone(entry.rules) as DraftRule[] } : {}),
    ...(entry.prepares ? { prepares: true } : {}),
  };
}

/** Schema authoring checks; command registration and permission checks are server-owned. */
export function commandReferenceProblem(command: AppCommandReference, owner: string, schema: DatabaseSchema): string | undefined {
  const target = tableNamed(schema, command.target);
  if (!target || target.id !== owner) return 'Command target must match the action’s owning resource.';
  if (target.isView || !target.columns.some((column) => column.primaryKey)) return 'Command target must be a table with a primary key.';
  return commandInputProblem(command.input, schema, { table: target, many: command.targets === 'many' });
}

/* `record.<column>` in a picker's query: the column of the record the command
   acts on, the word a timeline's `side` already reads it by. */
const RECORD_WORD = /(?<![\w$.])record\.([A-Za-z_]\w*)/g;

/** The record's columns a reference input's query names (`sales_order_id = record.id`). */
export const recordColumnsIn = (query: string): string[] => [...maskQuoted(query).matchAll(RECORD_WORD)].map((m) => m[1]);

/**
 * A picker's query with the record's values in place of its `record.<column>`
 * words, as prepare serves it: null when one of them is empty (or not the
 * reader's to see), which offers nothing rather than every row.
 */
export function boundRecordQuery(query: string, row: Readonly<Record<string, unknown>>): string | null {
  let out = query;
  for (const m of [...maskQuoted(query).matchAll(RECORD_WORD)].reverse()) {
    const value = row[m[1]];
    if (value === null || value === undefined) return null;
    out = `${out.slice(0, m.index)}${quoteValue(value)}${out.slice(m.index + m[0].length)}`;
  }
  return out;
}

/* A value of the column's kind, so a query that names the record is judged as it will read once bound. */
const SAMPLE = { number: 1, boolean: true, date: '2000-01-01', text: 'x', other: 'x' } as const;

/* Questions defined in rows: rows with the columns a row-defined field's have, and `whose` a column of
   them that holds the record's one key. */
function definedInputProblem(
  f: Extract<AppCommandField, { type: 'defined' }>,
  schema: DatabaseSchema,
  target: { table: TableMeta; many: boolean } | undefined,
): string | undefined {
  const from = tableNamed(schema, f.from);
  if (!from) return `Command input "${f.name}" asks the questions in "${f.from}", which is not a resource the command reads.`;
  const missing = ['key', 'label', 'type'].filter((name) => !from.columns.some((column) => column.name === name));
  if (missing.length)
    return `Command input "${f.name}": "${f.from}" has no ${missing.map((name) => `"${name}"`).join(', ')}; a question row has key, label and type (and may have options, required, help and position).`;
  if (f.whose === undefined) return undefined;
  if (!from.columns.some((column) => column.name === f.whose))
    return `Command input "${f.name}": "${f.from}" has no column "${f.whose}" for whose.`;
  if (!target || target.many) return `Command input "${f.name}" picks its questions by the record (whose), and a form's command has none.`;
  if (target.table.columns.filter((column) => column.primaryKey).length !== 1)
    return `Command input "${f.name}" picks its questions by the record's key, and ${target.table.id} has no single-column key.`;
  return undefined;
}

/* A record's lines: rows of a resource in this catalog, each column one a form writes, and each copy through a
   reference the line shows to a column of the record it names. */
function linesInputProblem(f: Extract<AppCommandField, { type: 'lines' }>, schema: DatabaseSchema): string | undefined {
  const from = tableNamed(schema, f.from);
  if (!from) return `Command input "${f.name}" asks lines of "${f.from}", which is not a resource the command writes.`;
  for (const column of [...f.show, ...Object.keys(f.copy ?? {})]) {
    if (!from.columns.some((c) => c.name === column)) return `Command input "${f.name}": "${column}" is not a column of ${from.id}.`;
    /* Not the column's `writable`: a reader's catalog says that of a table this reader may not write, and the
       lines are written under the command's grant, not the reader's. Only what the App works out is never asked. */
    if (f.show.includes(column) && (from.computed?.[column] || from.rollups?.[column]))
      return `Command input "${f.name}": "${column}" is worked out, not written by a form.`;
  }
  for (const [column, path] of Object.entries(f.copy ?? {})) {
    const [via, read] = path.split('.');
    const target = from.columns.find((c) => c.name === via)?.references;
    const record = target && tableNamed(schema, target.table);
    if (!record) return `Command input "${f.name}" copies "${column}" through "${via}", which is not a reference of ${from.id}.`;
    if (!record.columns.some((c) => c.name === read))
      return `Command input "${f.name}" copies "${column}" from "${read}", which is not a column of ${record.id}.`;
  }
  for (const [column, condition] of Object.entries(f.query ?? {})) {
    const target = from.columns.find((c) => c.name === column)?.references;
    const record = target && tableNamed(schema, target.table);
    if (!record) return `Command input "${f.name}" narrows "${column}", which is not a reference of ${from.id}.`;
    /* Read as the picker reads it: a plain query, else a view (a path or a rollup), as a reference's query is. */
    const plain = parseQuery(`${record.id} ${condition}`, { schema, me: ANYONE });
    const view = plain.errors.length ? parseViewQuery(schema, record.id, condition, undefined, { me: ANYONE }) : undefined;
    if (view?.errors.length) return `Command input "${f.name}" query "${column}": ${view.errors[0].message}`;
  }
  return undefined;
}

/** The reference inputs a command asks, against the catalog: a form's command has only these to check. */
export function commandInputProblem(
  input: readonly AppCommandField[],
  schema: DatabaseSchema,
  target?: { table: TableMeta; many: boolean },
): string | undefined {
  for (const { field: f } of commandFieldsDeep(input)) {
    const start = f.type === 'group' ? undefined : f.default;
    // A path's first step is the record's own column; the hops past it are judged where the command is bound.
    if (
      start &&
      typeof start === 'object' &&
      'record' in start &&
      target &&
      !target.table.columns.some((c) => c.name === start.record.split('.')[0])
    )
      return `Command input "${f.name}" starts from record.${start.record}, which is not a column of ${target.table.id}.`;
    if (f.type === 'defined') {
      const problem = definedInputProblem(f, schema, target);
      if (problem) return problem;
      continue;
    }
    if (f.type === 'lines') {
      const problem = linesInputProblem(f, schema);
      if (problem) return problem;
      continue;
    }
    if ((f.type === 'choice' || f.type === 'choices') && f.source) {
      const from = tableNamed(schema, f.source.from);
      if (!from)
        return `Command input "${f.name}" offers the rows of "${f.source.from}", which is not a resource the command reads: add it to \`read\`.`;
      for (const column of [f.source.by, f.source.labelColumn, ...(f.source.sort ? [f.source.sort.column] : [])])
        if (!from.columns.some((c) => c.name === column)) return `Command input "${f.name}": "${f.source.from}" has no column "${column}".`;
      continue;
    }
    if (f.type !== 'reference') continue;
    const resource = tableNamed(schema, f.from);
    if (!resource || !resource.columns.some((column) => column.name === f.labelColumn))
      return (
        `Command input "${f.name}" has an unresolved reference resource or label column. ` +
        (resource
          ? `"${f.from}" has no column "${f.labelColumn}": name one it has.`
          : `Most likely "${f.from}" is not in the command's \`read\` (a picker reads only the tables the command reads): add "${f.from}" to \`read\`, or check the name.`)
      );
    const keys = resource.columns.filter((column) => column.primaryKey);
    if (keys.length !== 1 || keys[0].name !== f.by) return `Command input "${f.name}" must select a single primary key.`;
    if (f.tree) {
      const parent = resource.columns.find((column) => column.name === f.tree);
      if (!parent)
        return `Command input "${f.name}": tree names "${f.tree}", which is not a column of "${f.from}": name the column that holds each row's parent.`;
      /* The hierarchy is the column's own: it must refer to the rows the picker offers, or a branch would open onto another table's keys. */
      const to =
        parent.references?.table ??
        schema.foreignKeys.find((key) => key.from.table === resource.id && key.from.columns.length === 1 && key.from.columns[0] === f.tree)
          ?.to.table;
      if (to !== resource.id)
        return `Command input "${f.name}": tree "${f.tree}" ${to ? `refers to "${to}"` : 'refers to nothing'}; a tree's column names a parent row of "${f.from}" itself.`;
    }
    if (f.query) {
      const named = recordColumnsIn(f.query);
      if (named.length && (!target || target.many))
        return `Command input "${f.name}" query names record.${named[0]}, but ${target ? "a command that acts on many records (targets: 'many')" : "a form's command"} has no one record to read it from.`;
      const columns = named.map((name) => target!.table.columns.find((column) => column.name === name));
      const unknown = named.find((_, i) => !columns[i]);
      if (unknown) return `Command input "${f.name}" query names record.${unknown}, which is not a column of ${target!.table.id}.`;
      const asked = named.length
        ? boundRecordQuery(f.query, Object.fromEntries(columns.map((column) => [column!.name, SAMPLE[columnKind(column!.type)]])))!
        : f.query;
      /* The picker's read takes the query as a view where it is not a plain
         one (the /api/run fall-through), so a path or a rollup — "released
         = 0" on an order — is judged as that read will judge it. */
      // Judged before any request: the picker's read asks it as the reader, so `me` here is anyone's.
      const query = parseQuery(`${resource.id} ${asked}`, { schema, me: ANYONE });
      const view = query.errors.length ? parseViewQuery(schema, resource.id, asked, undefined, { me: ANYONE }) : undefined;
      if (view?.errors.length) return `Command input "${f.name}" query: ${view.errors[0].message}`;
    }
  }
  return undefined;
}
