import type { AppForm, FormLines } from './app.js';
import { columnKind, isFlagColumn, type ColumnMeta, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { autoKey, formShownFields, isRequired } from '@mistriwork/engine/shared/form.js';
import { unknownKey } from '@mistriwork/engine/shared/suggest.js';
import { computedColumnMeta } from '@mistriwork/engine/shared/computed.js';
import {
  LOCAL_FIELD,
  RESERVED,
  columnNamed,
  compileCondition,
  comparisonResult,
  conditionResult,
  evaluateFormCondition,
  family,
  formDefaultWord,
  normalize,
  rowValue,
  scalar,
  type CompiledCondition,
  type FormCondition,
  type FormOperator,
  type FormScalar,
  type FormStep,
  type FormStyle,
} from '@mistriwork/engine/shared/formValues.js';
export {
  MAX_FORM_CONDITION,
  MAX_FORM_PREDICATES,
  evaluateFormCondition,
  formDefaultWord,
  inferredFormDefaults,
  type FormCondition,
  type FormScalar,
  type FormStep,
  type FormStyle,
} from '@mistriwork/engine/shared/formValues.js';
import type { AppFormField, FormChildGroup } from '@mistriwork/engine/shared/servedApp.js';
export type { AppFormField, FormChildGroup } from '@mistriwork/engine/shared/servedApp.js';

/** A validation rule: the record must meet `must`, a condition, wherever `when` (a condition too) holds. The
 *  message is shown at the first column `must` names. */
export interface FormRule {
  must: FormCondition;
  when?: FormCondition;
  message: string;
}

export const FORM_OPEN = ['drawer', 'page'] as const;
export const FORM_STYLES = ['stepper', 'intake'] as const;
/** How a vocabulary or a flag may be drawn on a New form (`fields.<column>.as`). */
const FORM_FIELD_AS = ['cards', 'buttons', 'radios', 'select'] as const;
export const FORM_FIELD_KEYS = ['label', 'help', 'placeholder', 'multiline', 'as', 'where'] as const;
/** A narrowed reference compares at most this many columns. */
export const MAX_FORM_WHERE = 4;
const MAX_FORM_DESCRIPTION = 500;

export const MAX_FORM_RULES = 128;
export const MAX_FORM_FIELDS = 256;
export const MAX_FORM_GROUPS = 32;
export const MAX_FORM_CHILDREN = 16;
export const MAX_FORM_CHILD_ROWS = 64;
const MAX_FORM_CHILD_ID = 64;
export const MAX_FORM_STEPS = 16;
export const MAX_FORM_STEP_FIELDS = 256;
const MAX_FORM_STEP_ID = 64;
export const FORM_UNRESOLVED_MESSAGE = 'This value could not be validated.';
// eslint-disable-next-line no-control-regex -- Resource names must exclude ASCII control characters.
const RESOURCE = /^\S(?:[^\x00-\x1f\x7f]*\S)?$/u;

function fail(where: string): never {
  // Never stringify rejected data: it may contain row values or executable hooks.
  throw new Error(`${where}: invalid form declaration.`);
}

function frozen<T extends object>(value: T): T {
  return Object.freeze(value);
}
function object(raw: unknown, where: string, keys?: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(where);
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) return fail(where);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).length !== Object.keys(descriptors).length) return fail(where);
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    /* An unknown key is named with the keys the place takes, as allowKeys
       names one everywhere else. A key is authored; the values are what
       fail() must never echo. */
    if (keys && !keys.includes(key) && !RESERVED.has(key)) throw new Error(`${where} ${unknownKey(key, keys)}.`);
    if (RESERVED.has(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || (keys && !keys.includes(key)))
      return fail(where);
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
  }
  return result;
}

function list(raw: unknown, where: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max || Object.getPrototypeOf(raw) !== Array.prototype) return fail(where);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).length !== raw.length + 1) return fail(where);
  const result: unknown[] = [];
  for (let i = 0; i < raw.length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return fail(where);
    result.push(descriptor.value);
  }
  return result;
}

function field(raw: unknown, where: string): string {
  if (typeof raw !== 'string' || !LOCAL_FIELD.test(raw) || RESERVED.has(raw)) return fail(where);
  return raw;
}

function text(raw: unknown, where: string): string {
  // eslint-disable-next-line no-control-regex -- Static labels/messages must not contain ASCII control characters.
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 256 || /[\x00-\x1f\x7f]/u.test(raw)) return fail(where);
  return raw;
}

function childId(raw: unknown, where: string): string {
  if (typeof raw !== 'string' || raw.length > MAX_FORM_CHILD_ID || !/^[a-z][a-z0-9_-]*$/u.test(raw)) return fail(where);
  return raw;
}

function stepId(raw: unknown, where: string): string {
  if (typeof raw !== 'string' || raw.length > MAX_FORM_STEP_ID || !/^[a-z][a-z0-9_-]*$/u.test(raw)) return fail(where);
  return raw;
}

/** The id `step()` gives a step: its label's slug. */
function stepSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/* A step written as an object may leave its id out, as `step()` does; the
   label's slug is its id then — a step that lists fields and one that saves
   through its own command alike (appSavedForms.ts), and a label with no slug that can be one
   (`'1. Basics'`) says what to write rather than failing opaquely. */
export function stepIdOf(s: Record<string, unknown>, label: string, where: string): string {
  if (Object.hasOwn(s, 'id')) return stepId(s.id, where);
  const slug = stepSlug(label);
  if (!/^[a-z][a-z0-9_-]*$/u.test(slug) || slug.length > MAX_FORM_STEP_ID) {
    throw new Error(`${where}: step "${label}" needs an "id" — lowercase letters, digits, "_" and "-", starting with a letter.`);
  }
  return slug;
}

/** Author prose that is not a row value: one sentence or a few, plain text. */
function sentence(raw: unknown, where: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- Static copy must not contain ASCII control characters.
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max || /[\x00-\x1f\x7f]/u.test(raw)) {
    throw new Error(`${where} is not plain text of at most ${max} characters.`);
  }
  return raw.trim();
}

function parseFormField(raw: unknown, name: string, where: string): AppFormField {
  const here = `${where}, fields "${name}"`;
  const f = object(raw, here, FORM_FIELD_KEYS);
  const result: AppFormField = {};
  for (const key of ['label', 'help', 'placeholder'] as const) {
    if (Object.hasOwn(f, key)) result[key] = sentence(f[key], `${here}, "${key}"`, 256);
  }
  if (Object.hasOwn(f, 'multiline')) {
    if (typeof f.multiline !== 'boolean') throw new Error(`${here}, "multiline" is true or false.`);
    result.multiline = f.multiline;
  }
  if (Object.hasOwn(f, 'as')) {
    if (typeof f.as !== 'string' || !FORM_FIELD_AS.includes(f.as as (typeof FORM_FIELD_AS)[number])) {
      throw new Error(`${here}, "as" is one of ${FORM_FIELD_AS.map((w) => `"${w}"`).join(', ')}.`);
    }
    result.as = f.as as (typeof FORM_FIELD_AS)[number];
  }
  if (Object.hasOwn(f, 'where')) {
    const pairs = Object.entries(object(f.where, `${here}, "where"`));
    if (!pairs.length || pairs.length > MAX_FORM_WHERE) {
      throw new Error(`${here}, "where" names one to ${MAX_FORM_WHERE} columns: { project_id: 'project_id' }.`);
    }
    result.where = frozen(Object.fromEntries(pairs.map(([target, local]) => [field(target, here), field(local, here)])));
  }
  return frozen(result);
}

/** A condition, checked as the query language and kept as its text. */
export function parseFormCondition(raw: unknown, where = 'Condition', paths = false): FormCondition {
  compileCondition(raw, where, undefined, 'record', paths);
  return (raw as string).trim();
}

export function parseFormRules(raw: unknown, where = 'Validation'): FormRule[] {
  return frozen(
    list(raw, where, MAX_FORM_RULES).map((rawRule) => {
      const r = object(rawRule, where, ['must', 'when', 'message']);
      if (!Object.hasOwn(r, 'must')) return fail(where);
      return frozen({
        must: parseFormCondition(r.must, `${where}, "must"`, true),
        message: text(r.message, where),
        ...(Object.hasOwn(r, 'when') ? { when: parseFormCondition(r.when, `${where}, "when"`, true) } : {}),
      });
    }),
  );
}

/** The column a rule's message is shown at: the first one its `must` compares, or the reference it reads through. */
function ruleField(rule: FormRule): string {
  return compileCondition(rule.must, 'Validation', undefined, 'record', true)[0][0].field.split('.')[0];
}

export function parseAppValidation(raw: unknown, where = 'Validation'): Record<string, FormRule[]> {
  const declarations = object(raw, where);
  if (Object.keys(declarations).length > MAX_FORM_FIELDS) return fail(where);
  return frozen(
    Object.fromEntries(
      Object.entries(declarations).map(([resource, rules]) => {
        if (!RESOURCE.test(resource) || resource.length > 256) return fail(where);
        return [resource, parseFormRules(rules, where)];
      }),
    ),
  );
}

/** The most fields side by side in one row. */
const MAX_FORM_ROW = 3;
const STEP_WORDS = { title: 160, lead: 500, next: 40, skip: 40 } as const;
/** The keys a step takes beside its id, label and fields. */
const STEP_WORD_KEYS = Object.keys(STEP_WORDS) as readonly (keyof typeof STEP_WORDS)[];

/** A step's own words for the intake style: its heading, the sentence under it, and its button's. */
export function parseStepWords(
  s: Record<string, unknown>,
  where: string,
  keys: readonly (keyof typeof STEP_WORDS)[] = STEP_WORD_KEYS,
): Pick<FormStep, 'title' | 'lead' | 'next' | 'skip'> {
  const result: Pick<FormStep, 'title' | 'lead' | 'next' | 'skip'> = {};
  for (const key of keys) if (Object.hasOwn(s, key)) result[key] = sentence(s[key], `${where}, "${key}"`, STEP_WORDS[key]);
  return result;
}

/**
 * Fields as authored, for a step, a group or the form's `show`: names, and inner lists that are rows
 * (`[['first_name', 'last_name'], 'dob']`). The fields are the names read through, in order, the list everything
 * else reads; `rows` is kept beside them only where some row holds more than one.
 */
function parseRowFields(raw: unknown, where: string, max: number, min: number): { fields: string[]; rows?: string[][] } {
  const rows = list(raw, where, max, min).map((entry, i): string[] => {
    if (!Array.isArray(entry)) return [field(entry, where)];
    const at = `${where}, field ${i + 1}`;
    if (!entry.length) throw new Error(`${at} is an empty row. A row holds one to ${MAX_FORM_ROW} fields.`);
    if (entry.length > MAX_FORM_ROW)
      throw new Error(
        `${at} is a row of ${entry.length} fields; a row holds at most ${MAX_FORM_ROW}, side by side. Split it into two rows.`,
      );
    if (entry.some((member) => Array.isArray(member)))
      throw new Error(`${at} nests a row inside a row. A row is one list of field names: [['first_name', 'last_name'], 'dob'].`);
    return list(entry, at, MAX_FORM_ROW, 1).map((member) => field(member, where));
  });
  const fields = rows.flat();
  if (fields.length > max) return fail(where);
  const twice = fields.find((name, i) => fields.indexOf(name) !== i);
  if (twice !== undefined) throw new Error(`${where} names "${twice}" twice; a field stands in one place on the form.`);
  return {
    fields: frozen(fields),
    ...(rows.some((row) => row.length > 1) ? { rows: frozen(rows.map((row) => frozen(row))) } : {}),
  };
}

/**
 * A list read again from a parsed model: its flat `fields` and the `rows` kept beside them, which must say the same
 * names in the same order. Authored, the rows are the list itself.
 */
function rowFields(
  raw: Record<string, unknown>,
  key: string,
  rowsKey: string,
  where: string,
  parsed: boolean,
  max: number,
  min: number,
): { fields: string[]; rows?: string[][] } {
  if (!parsed || !Object.hasOwn(raw, rowsKey)) return parseRowFields(raw[key], where, max, min);
  const read = parseRowFields(raw[rowsKey], where, max, min);
  const flat = list(raw[key], where, max, min);
  if (flat.length !== read.fields.length || flat.some((name, i) => name !== read.fields[i])) return fail(where);
  return read;
}

/** The keys an authored resource form takes (children stay behind the shared parser). */
const FORM_KEYS = [
  'show',
  'defaults',
  'derived',
  'groups',
  'when',
  'steps',
  'style',
  'description',
  'open',
  'fields',
  'lines',
  'live',
] as const;
/** What an author writes: `derived` is read out of `defaults` (`{ from: 'service_id.price' }`), never said itself. */
export const AUTHORED_FORM_KEYS = FORM_KEYS.filter((key) => key !== 'derived');
/** A value taken from a referenced record: one reference of this table, then a column of the table it names. */
const DERIVED_PATH = /^[A-Za-z_][A-Za-z0-9_]{0,127}\.[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The most collections of child rows one New form asks, and the most names it says live. */
const MAX_FORM_LINES = 4;
const MAX_FORM_LIVE = 16;
const LINE_KEYS = ['label', 'from', 'whose', 'show', 'order', 'min', 'max'] as const;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * A New form's child rows — an order's lines, a bundle's items — asked as a
 * grid under the record's fields and inserted with it, in its transaction:
 * `lines: [{ label: 'Items', from: 'order_line', whose: 'order_id', show: ['product_id', 'qty', 'unit_price'] }]`.
 * The words are a related list's (`related(title, from, whose, { show })`), and its caption is a `label` as a group's is;
 * the catalog checks them where the form meets it (formLines.ts).
 */
function parseFormLines(raw: unknown, where: string): FormLines[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_FORM_LINES)
    throw new Error(
      `${where}: form.lines is a list of one to ${MAX_FORM_LINES} collections of child rows, each { label, from, whose, show }.`,
    );
  const seen = new Set<string>();
  return frozen(
    raw.map((entry, i) => {
      const at = `${where}: form.lines ${i + 1}`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${at} is not { label, from, whose, show }.`);
      const l = entry as Record<string, unknown>;
      if (l.title !== undefined) throw new Error(`${at} has "title", which is now "label", as a group's caption is.`);
      const extra = Object.keys(l).find((key) => !(LINE_KEYS as readonly string[]).includes(key));
      if (extra !== undefined) throw new Error(`${at} ${unknownKey(extra, LINE_KEYS)}.`);
      if (typeof l.label !== 'string' || !l.label.trim() || l.label.length > 80)
        throw new Error(`${at} needs a "label" of at most 80 characters.`);
      for (const key of ['from', 'whose'] as const)
        if (typeof l[key] !== 'string' || !IDENT.test(l[key] as string))
          throw new Error(
            `${at} needs "${key}": ${key === 'from' ? 'the resource of the rows' : 'the column of those rows that points at this record'}.`,
          );
      if (
        !Array.isArray(l.show) ||
        !l.show.length ||
        l.show.length > 12 ||
        l.show.some((column) => typeof column !== 'string' || !IDENT.test(column)) ||
        new Set(l.show).size !== l.show.length
      )
        throw new Error(`${at} needs "show": one to 12 of the row's own columns, each once.`);
      if (l.order !== undefined && (typeof l.order !== 'string' || !IDENT.test(l.order)))
        throw new Error(`${at} has an "order" that is not a column of the rows: the number each row's place is kept in.`);
      const bound = (key: 'min' | 'max') => {
        const v = l[key];
        if (v === undefined) return undefined;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < (key === 'max' ? 1 : 0) || v > MAX_FORM_CHILD_ROWS)
          throw new Error(`${at} has a "${key}" that is not a whole number of rows up to ${MAX_FORM_CHILD_ROWS}.`);
        return v;
      };
      const min = bound('min'),
        max = bound('max');
      if (min !== undefined && max !== undefined && min > max) throw new Error(`${at} has a "min" above its "max".`);
      if (seen.has(l.from as string))
        throw new Error(`${at} asks the rows of "${l.from as string}" a second time; one collection per resource.`);
      seen.add(l.from as string);
      return frozen({
        label: l.label.trim(),
        from: l.from as string,
        whose: l.whose as string,
        show: frozen([...(l.show as string[])]),
        ...(l.order === undefined ? {} : { order: l.order as string }),
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
      });
    }),
  );
}

/** The resource's computed columns and rollups a New form says as its fields and lines are typed: `live: ['subtotal', 'total']`. */
function parseFormLive(raw: unknown, where: string): string[] {
  if (
    !Array.isArray(raw) ||
    !raw.length ||
    raw.length > MAX_FORM_LIVE ||
    raw.some((name) => typeof name !== 'string' || !IDENT.test(name)) ||
    new Set(raw).size !== raw.length
  )
    throw new Error(`${where}: form.live is a list of one to ${MAX_FORM_LIVE} of the resource's computed columns and rollups, each once.`);
  return frozen([...(raw as string[])]);
}

/** `parsed`: the form is a model already read (its `show` derived from its groups), not an authored one. */
function parseAppFormShape(raw: unknown, where: string, parsed = false): Omit<AppForm, 'children'> {
  /* A parsed model carries its rows beside its flat lists (`showRows`, a group's and a step's `rows`); an author writes
     them inside the lists. */
  const f = object(raw, where, parsed ? [...FORM_KEYS, 'showRows'] : FORM_KEYS);
  const result: AppForm = {};
  /* `show` is what the form asks. Its steps, or else its groups, are that list already, so saying both is two lists to keep
     alike: it is the one or the other. */
  if (Object.hasOwn(f, 'show')) {
    if (parsed && Object.hasOwn(f, 'groups') && !Object.hasOwn(f, 'steps')) {
      /* derived again below */
    } else if (Object.hasOwn(f, 'steps') || Object.hasOwn(f, 'groups')) {
      throw new Error(
        `${where} has "show" and ${Object.hasOwn(f, 'steps') ? 'steps' : 'groups'}: the form asks the fields of its ${Object.hasOwn(f, 'steps') ? 'steps' : 'groups'}. Keep one.`,
      );
    }
    const { fields, rows } = rowFields(f, 'show', 'showRows', where, parsed, MAX_FORM_FIELDS, 0);
    result.show = fields;
    if (rows) result.showRows = rows;
  }
  if (Object.hasOwn(f, 'defaults')) {
    const defaults = object(f.defaults, where);
    if (Object.keys(defaults).length > MAX_FORM_FIELDS) return fail(where);
    result.defaults = frozen(Object.fromEntries(Object.entries(defaults).map(([key, value]) => [field(key, where), scalar(value, where)])));
  }
  if (Object.hasOwn(f, 'derived')) {
    const derived = object(f.derived, where);
    if (Object.keys(derived).length > MAX_FORM_FIELDS) return fail(where);
    result.derived = frozen(
      Object.fromEntries(
        Object.entries(derived).map(([key, path]) => {
          if (typeof path !== 'string' || !DERIVED_PATH.test(path))
            throw new Error(
              `${where}: defaults "${key}" is from ${JSON.stringify(path)}; a value from a record is { from: 'reference.column' }.`,
            );
          if (Object.hasOwn(result.defaults ?? {}, key)) throw new Error(`${where}: defaults "${key}" is said twice.`);
          return [field(key, where), path];
        }),
      ),
    );
  }
  if (Object.hasOwn(f, 'groups')) {
    const seen = new Set<string>();
    result.groups = frozen(
      list(f.groups, where, MAX_FORM_GROUPS).map((rawGroup) => {
        const g = object(rawGroup, where, parsed ? ['label', 'description', 'fields', 'rows'] : ['label', 'description', 'fields']);
        const { fields, rows } = rowFields(g, 'fields', 'rows', where, parsed, MAX_FORM_FIELDS, 1);
        for (const name of fields) {
          if (seen.has(name)) return fail(where);
          seen.add(name);
        }
        const label = text(g.label, where);
        return frozen({
          label,
          ...(Object.hasOwn(g, 'description')
            ? { description: sentence(g.description, `${where}, group "${label}", "description"`, 256) }
            : {}),
          fields,
          ...(rows ? { rows } : {}),
        });
      }),
    );
  }
  /* The groups carve up what the form asks, in their order; with steps, the steps' fields are the list (formShownFields). */
  if (result.groups && !Object.hasOwn(f, 'steps')) {
    result.show = frozen(result.groups.flatMap((group) => [...group.fields]));
    /* Their rows are the form's, read in the same order; a group without rows is one field to a row. */
    if (result.groups.some((group) => group.rows))
      result.showRows = frozen(result.groups.flatMap((group) => group.rows ?? group.fields.map((name) => frozen([name]))));
  }
  if (Object.hasOwn(f, 'when')) {
    const conditions = object(f.when, where);
    if (Object.keys(conditions).length > MAX_FORM_FIELDS) return fail(where);
    result.when = frozen(
      Object.fromEntries(
        Object.entries(conditions).map(([key, value]) => {
          const name = field(key, where);
          if (result.show && !result.show.includes(name)) return fail(where);
          return [name, parseFormCondition(value, `${where}, when "${name}"`)];
        }),
      ),
    );
  }
  if (Object.hasOwn(f, 'steps')) {
    const seenIds = new Set<string>();
    const owned = new Set<string>();
    result.steps = frozen(
      list(f.steps, where, MAX_FORM_STEPS, 1).map((rawStep) => {
        const s = object(rawStep, where, ['id', 'label', 'fields', ...(parsed ? ['rows'] : []), ...STEP_WORD_KEYS]);
        const label = text(s.label, where);
        const id = stepIdOf(s, label, where);
        if (seenIds.has(id)) throw new Error(`${where}: two steps are "${id}"; give one an "id" of its own.`);
        seenIds.add(id);
        const { fields, rows } = rowFields(s, 'fields', 'rows', where, parsed, MAX_FORM_STEP_FIELDS, 1);
        if (fields.some((name) => owned.has(name))) return fail(where);
        fields.forEach((name) => owned.add(name));
        return frozen({ id, label, fields, ...(rows ? { rows } : {}), ...parseStepWords(s, `${where}, step "${id}"`) });
      }),
    );
    /* A row stands inside one group, as a group stands inside one step: the group's heading sits over the row, and
       the fields a group leaves out are drawn after every group. */
    if (result.groups) {
      const groupOf = new Map(result.groups.flatMap((group, at) => group.fields.map((name) => [name, at] as const)));
      for (const step of result.steps)
        for (const row of step.rows ?? []) {
          if (new Set(row.map((name) => groupOf.get(name) ?? -1)).size > 1)
            throw new Error(
              `${where}: step "${step.id}" puts ${row.map((name) => `"${name}"`).join(', ')} in one row across groups. A row stands inside one group.`,
            );
        }
    }
  }
  if (Object.hasOwn(f, 'style')) {
    if (!(FORM_STYLES as readonly unknown[]).includes(f.style)) throw new Error(`${where}, "style" is 'stepper' or 'intake'.`);
    if (!Object.hasOwn(f, 'steps')) throw new Error(`${where}, "style" draws steps, and this form has none.`);
    result.style = f.style as FormStyle;
  }
  if (Object.hasOwn(f, 'description')) result.description = sentence(f.description, `${where}, "description"`, MAX_FORM_DESCRIPTION);
  if (Object.hasOwn(f, 'open')) {
    if (!(FORM_OPEN as readonly unknown[]).includes(f.open)) throw new Error(`${where}, "open" is 'drawer' or 'page'.`);
    result.open = f.open as AppForm['open'];
  }
  if (Object.hasOwn(f, 'lines')) result.lines = parseFormLines(f.lines, where);
  if (Object.hasOwn(f, 'live')) result.live = parseFormLive(f.live, where);
  if (Object.hasOwn(f, 'fields')) {
    const declared = Object.entries(object(f.fields, `${where}, "fields"`));
    if (declared.length > MAX_FORM_FIELDS) return fail(where);
    result.fields = frozen(Object.fromEntries(declared.map(([name, value]) => [field(name, where), parseFormField(value, name, where)])));
  }
  return frozen(result);
}

function parseFormChildren(raw: unknown, where = 'Form, children'): FormChildGroup[] {
  const seen = new Set<string>();
  return frozen(
    list(raw, where, MAX_FORM_CHILDREN).map((rawChild) => {
      const c = object(rawChild, where, ['id', 'label', 'table', 'relation', 'min', 'max', 'form']);
      const id = childId(c.id, where);
      if (seen.has(id)) return fail(where);
      seen.add(id);
      const relation = object(c.relation, where, ['from', 'to']);
      const min = c.min === undefined ? 0 : c.min;
      const max = c.max;
      if (
        typeof min !== 'number' ||
        typeof max !== 'number' ||
        !Number.isInteger(min) ||
        min < 0 ||
        min > MAX_FORM_CHILD_ROWS ||
        !Number.isInteger(max) ||
        max < 1 ||
        max > MAX_FORM_CHILD_ROWS ||
        min > max
      )
        return fail(where);
      if (typeof c.table !== 'string' || !RESOURCE.test(c.table) || c.table.length > 256) return fail(where);
      const captured: FormChildGroup = {
        id,
        label: text(c.label, where),
        table: c.table,
        relation: { from: field(relation.from, where), to: field(relation.to, where) },
        ...(min ? { min } : {}),
        max,
        ...(c.form === undefined ? {} : { form: parseAppFormShape(c.form, `${where} "${id}", form`) }),
      };
      return frozen(captured);
    }),
  );
}

export function parseAppForm(raw: unknown, where = 'Form', parsed = false): AppForm {
  const input = object(raw, where, [...FORM_KEYS, ...(parsed ? ['showRows'] : []), 'children']);
  const shape = parseAppFormShape(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'children')), where, parsed);
  if (!Object.hasOwn(input, 'children')) return shape as AppForm;
  return frozen({ ...shape, children: parseFormChildren(input.children, `${where}, children`) });
}

export function referencedConditionFields(condition: FormCondition, paths = false): string[] {
  return [
    ...new Set(
      compileCondition(condition, 'Condition', undefined, 'record', paths)
        .flat()
        .map((p) => p.field),
    ),
  ];
}

export function referencedRuleFields(rules: readonly FormRule[]): string[] {
  return [
    ...new Set(
      parseFormRules(rules).flatMap((rule) => [
        ...compileCondition(rule.must, 'Validation', undefined, 'record', true)
          .flat()
          .flatMap((p) => [p.field, ...(p.other === undefined ? [] : [p.other])]),
        ...(rule.when ? referencedConditionFields(rule.when, true) : []),
      ]),
    ),
  ];
}

/** A record as a rule reads it: a text column holding only blanks is as empty as a missing one. */
function blanksAsEmpty(row: Readonly<Record<string, unknown>>, columns: readonly ColumnMeta[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const column of columns) {
    const value = rowValue(row, column.name);
    result[column.name] = typeof value === 'string' && !value.trim() && family(column) === 'text' ? null : value;
  }
  return result;
}

function comparisonProblem(column: ColumnMeta, op: FormOperator): boolean {
  const kind = family(column);
  return !kind || ((kind === 'text' || kind === 'boolean') && op !== 'eq' && op !== 'ne');
}

function conditionProblems(condition: FormCondition, table: TableMeta, paths = false): string[] {
  let compiled: CompiledCondition;
  try {
    compiled = compileCondition(
      condition,
      `Condition "${condition}"`,
      table.columns,
      /^\w+$/.test(table.name) ? table.name : undefined,
      paths,
    );
  } catch (error) {
    return [(error as Error).message];
  }
  return compiled.flat().flatMap((p) => {
    const column = columnNamed(table.columns, p.field);
    if (p.other !== undefined) {
      const other = columnNamed(table.columns, p.other);
      return !column || !other || family(column) !== family(other) || comparisonProblem(column, p.operator)
        ? [`Condition on "${p.field}" is not comparable with "${p.other}" in this schema.`]
        : [];
    }
    return !column ||
      comparisonProblem(column, p.operator) ||
      p.values.some((value) => normalize(column, value) === undefined || (value === null && p.operator !== 'eq' && p.operator !== 'ne'))
      ? [`Condition on "${p.field}" is not comparable with this schema.`]
      : [];
  });
}

/** The `reference.column` paths a validation reads through its references, each once. */
export function ruleReferencePaths(rules: readonly FormRule[]): string[] {
  return referencedRuleFields(rules).filter((field) => field.includes('.'));
}

/**
 * The columns a validation is judged against: the table's own, and each column it reads through a reference,
 * named by its path and typed as the referenced column is. `problems` says each path the catalog cannot follow.
 */
export function ruleColumns(
  rules: readonly FormRule[],
  table: TableMeta,
  schema: DatabaseSchema | undefined,
): { columns: ColumnMeta[]; problems: string[] } {
  const columns = [...table.columns];
  const problems: string[] = [];
  for (const path of ruleReferencePaths(rules)) {
    const source = derivedSource(path, table, schema);
    if ('problem' in source) problems.push(`Validation reads "${path}": ${source.problem}`);
    else columns.push({ ...source.column, name: path, primaryKey: false });
  }
  return { columns, problems };
}

export function validateFormRules(rules: readonly FormRule[], table: TableMeta, schema?: DatabaseSchema): string[] {
  const captured = parseFormRules(rules);
  // Without a catalog a path cannot be followed, and is left to the check that has one.
  if (!schema && ruleReferencePaths(captured).length) return [];
  const { columns, problems } = ruleColumns(captured, table, schema);
  if (problems.length) return problems;
  const judged = { ...table, columns };
  for (const rule of captured) {
    problems.push(...conditionProblems(rule.must, judged, true));
    if (rule.when) problems.push(...conditionProblems(rule.when, judged, true));
  }
  return [...new Set(problems)];
}

/** What a form is judged against beyond its own table: the catalog its references
 * point into, and who `me` can be — `null` for an App without sign-in, the
 * `auth.me` table's id (or undefined, email only) where people sign in. */
interface AppFormContext {
  schema?: DatabaseSchema;
  /** The catalog a value from a referenced record is read from: `schema` with its computed columns (app.ts storedComputed). */
  derivedFrom?: DatabaseSchema;
  person?: { table?: string } | null;
}

/** Use the current readable projection; this helper never grants field access. */
export function validateAppForm(
  form: AppForm,
  table: TableMeta,
  readableFields: readonly string[] = table.columns.map((c) => c.name),
  context: AppFormContext = {},
): string[] {
  const captured = parseAppForm(form, 'Form', true);
  const readable = new Set(readableFields);
  const stepFields = (captured.steps ?? []).flatMap((step) => step.fields);
  const shownFields = formShownFields(captured);
  const presentationFields = [
    ...(captured.show ?? []),
    ...Object.keys(captured.defaults ?? {}),
    ...(captured.groups ?? []).flatMap((group) => group.fields),
    ...Object.keys(captured.when ?? {}),
    ...stepFields,
    ...Object.keys(captured.fields ?? {}),
    ...Object.values(captured.fields ?? {}).flatMap((f) => Object.values(f?.where ?? {})),
  ];
  const problems: string[] = [];
  const defaults = captured.defaults ?? {};
  const named = [...(captured.show ?? []), ...Object.keys(defaults)].filter((name) => !columnNamed(table.columns, name));
  const assignedDefaults = table.columns.filter((c) => c.identity === 'always' && Object.hasOwn(defaults, c.name));
  const nullDefaults = table.columns.filter((c) => !c.nullable && Object.hasOwn(defaults, c.name) && defaults[c.name] === null);
  if (named.length) problems.push(`Form: "${table.name}" has no column ${named.map((name) => `"${name}"`).join(', ')}.`);
  if (assignedDefaults.length)
    problems.push(
      `Form: ${assignedDefaults.map((c) => `"${c.name}"`).join(', ')} is always assigned by the database and cannot have a form default.`,
    );
  if (nullDefaults.length) problems.push(`Form: ${nullDefaults.map((c) => `"${c.name}"`).join(', ')} cannot default to null (NOT NULL).`);
  for (const [name, path] of Object.entries(captured.derived ?? {}))
    problems.push(...derivedProblems(name, path, table, context.derivedFrom ?? context.schema));
  if (shownFields) {
    const shown = new Set([...shownFields, ...Object.keys(defaults), ...Object.keys(captured.derived ?? {})]);
    const assigned = autoKey(table);
    const starved = table.columns.filter((c) => isRequired(c, assigned) && !shown.has(c.name));
    if (starved.length)
      problems.push(
        `Form: "${table.name}" requires ${starved.map((c) => `"${c.name}"`).join(', ')} (NOT NULL, no default) — show it, or give it a default.`,
      );
  }
  if (captured.steps) {
    const shown = new Set(captured.show ?? stepFields);
    const owned = new Set(stepFields);
    const missingOwnership = [...shown].filter((name) => !owned.has(name));
    const unshown = [...owned].filter((name) => !shown.has(name));
    if (missingOwnership.length || unshown.length) {
      problems.push('Form steps must own exactly the fields in show.');
    }
    const owner = new Map<string, string>();
    for (const step of captured.steps) for (const name of step.fields) owner.set(name, step.id);
    for (const group of captured.groups ?? []) {
      const stepIds = new Set(group.fields.map((name) => owner.get(name)).filter((id): id is string => id !== undefined));
      if (stepIds.size > 1) problems.push(`Form group "${group.label}" cannot span multiple steps.`);
      if (group.fields.some((name) => !owner.has(name)))
        problems.push(`Form group "${group.label}" contains a field outside the form steps.`);
    }
  }
  for (const name of new Set(presentationFields)) {
    if (!columnNamed(table.columns, name) || !readable.has(name)) problems.push(`Form field "${name}" is unknown or hidden.`);
  }
  /* A field may be shown while a computed column holds: the form works it out from the draft as it is filled in
     (newRecordModel.ts), so the condition reads it as a column, as the browser does. */
  const computed = table.computed ?? {};
  const judged = Object.keys(computed).length
    ? { ...table, columns: [...table.columns, ...Object.entries(computed).map(([name, value]) => computedColumnMeta(name, value))] }
    : table;
  for (const condition of Object.values(captured.when ?? {})) {
    if (!condition) continue;
    problems.push(...conditionProblems(condition, judged));
    if (referencedConditionFields(condition).some((name) => !readable.has(name) && !Object.hasOwn(computed, name))) {
      problems.push('Form visibility depends on an unreadable field.');
    }
  }
  const shownNow = new Set(shownFields ?? table.columns.map((c) => c.name));
  for (const [name, dress] of Object.entries(captured.fields ?? {})) {
    const column = columnNamed(table.columns, name);
    if (!column || !dress) continue;
    if (!shownNow.has(name)) problems.push(`Form: fields "${name}" is not a field this form asks for; add it to show, or drop its dress.`);
    if (dress.multiline !== undefined && family(column) !== 'text')
      problems.push(`Form: fields "${name}" is ${column.type || 'untyped'}; only a text field is drawn on one line or several.`);
    if (dress.as !== undefined) {
      const vocabulary = Boolean(column.allowed?.length);
      if (!vocabulary && !isFlagColumn(column))
        problems.push(
          `Form: fields "${name}" is ${column.type || 'untyped'}; "as" draws a column with a vocabulary (an enum or a check-constrained text) or a flag.`,
        );
      else if (!vocabulary && (dress.as === 'cards' || dress.as === 'radios'))
        problems.push(
          `Form: fields "${name}" is a flag; "as: '${dress.as}'" needs a vocabulary, a flag is drawn as "buttons" or "select".`,
        );
    }
    if (dress.where) problems.push(...narrowingProblems(name, column, dress.where, table, context.schema));
  }
  for (const [name, value] of Object.entries(defaults)) {
    const column = columnNamed(table.columns, name);
    if (column) problems.push(...defaultWordProblems(name, column, value, context));
  }
  return [...new Set(problems)];
}

/* A narrowed picker is the reference's choices, where the referenced row
   agrees with this record on one to four columns. The server holds every
   write to it (appValidation.ts), so what it names must be real columns. */
function narrowingProblems(
  name: string,
  column: ColumnMeta,
  where: Record<string, string>,
  table: TableMeta,
  schema?: DatabaseSchema,
): string[] {
  if (!column.references)
    return [`Form: fields "${name}" narrows with "where", which only a reference takes; "${name}" refers to nothing.`];
  const problems: string[] = [];
  for (const local of Object.values(where)) {
    if (local === name) problems.push(`Form: fields "${name}", "where" compares "${name}" with itself.`);
    else if (!columnNamed(table.columns, local))
      problems.push(`Form: fields "${name}", "where" names "${local}", which is not a column of ${table.name}.`);
  }
  if (!schema) return problems;
  const target = schema.tables.find((candidate) => candidate.id === column.references!.table);
  if (!target)
    return [
      ...problems,
      `Form: fields "${name}" refers to ${column.references.table}, which this catalog does not read, so its choices cannot be narrowed.`,
    ];
  for (const remote of Object.keys(where)) {
    if (!columnNamed(target.columns, remote))
      problems.push(`Form: fields "${name}", "where" names "${remote}", which is not a column of ${target.name}.`);
  }
  return problems;
}

function referencedTable(to: string | undefined, schema: DatabaseSchema | undefined): TableMeta | undefined {
  return to && schema
    ? (schema.tables.find((candidate) => candidate.id === to) ?? schema.tables.find((candidate) => candidate.name === to))
    : undefined;
}

/** The table a reference column of `table` names, where the catalog reads it. */
export function referenceTarget(via: string, table: TableMeta, schema: DatabaseSchema | undefined): TableMeta | undefined {
  const reference = columnNamed(table.columns, via);
  const fk = schema?.foreignKeys.find((key) => key.from.table === table.id && key.from.columns.length === 1 && key.from.columns[0] === via);
  return reference ? referencedTable(reference.references?.table ?? fk?.to.table, schema) : undefined;
}

/**
 * A value from a referenced record (`defaults: { labor_charge: { from: 'service_id.price' } }`): the first name
 * is a reference of this table, the second a column of the table it names, holding what this column holds.
 */
export function derivedSource(
  path: string,
  table: TableMeta,
  schema: DatabaseSchema | undefined,
): { via: ColumnMeta; target: TableMeta; column: ColumnMeta; key: string } | { problem: string } {
  const [via, name] = path.split('.');
  const reference = columnNamed(table.columns, via);
  if (!reference) return { problem: `"${table.name}" has no column "${via}".` };
  const fk = schema?.foreignKeys.find((key) => key.from.table === table.id && key.from.columns.length === 1 && key.from.columns[0] === via);
  const to = reference.references?.table ?? fk?.to.table;
  const target = referencedTable(to, schema);
  if (!to) return { problem: `"${via}" is no reference, so it names no record to take a value from.` };
  if (!target) return { problem: `"${via}" refers to ${to}, which this catalog does not read.` };
  const column = columnNamed(target.columns, name);
  if (!column) return { problem: `${target.name} has no column "${name}".` };
  const key = reference.references?.column ?? fk?.to.columns[0] ?? target.columns.find((candidate) => candidate.primaryKey)?.name;
  if (!key) return { problem: `${target.name} has no key "${via}" could name.` };
  return { via: reference, target, column, key };
}

function derivedProblems(name: string, path: string, table: TableMeta, schema: DatabaseSchema | undefined): string[] {
  const column = columnNamed(table.columns, name);
  if (!column) return [`Form: "${table.name}" has no column "${name}".`];
  if (!schema) return [];
  const source = derivedSource(path, table, schema);
  if ('problem' in source) return [`Form: defaults "${name}" is from "${path}": ${source.problem}`];
  if (columnKind(source.column.type) !== columnKind(column.type))
    return [
      `Form: defaults "${name}" is from "${path}", which is ${source.column.type || 'untyped'}; "${name}" is ${column.type || 'untyped'}.`,
    ];
  return [];
}

function defaultWordProblems(name: string, column: ColumnMeta, value: FormScalar, context: AppFormContext): string[] {
  if (value === 'today' || value === 'now') {
    return formDefaultWord(column, value)
      ? []
      : [
          `Form: defaults "${name}" is ${value}, which fills a date column; "${name}" is ${column.type || 'untyped'}` +
            " (a SQLite TEXT date is declared with types: { column: 'date' }).",
        ];
  }
  if (value !== 'me') return [];
  if (!formDefaultWord(column, value))
    return [
      `Form: defaults "${name}" is me, the signed-in person — a row of the auth.me table or an email; "${name}" is ${column.type || 'untyped'}.`,
    ];
  if (context.person === null) return [`Form: defaults "${name}" is me, and this App has no sign-in.`];
  if (context.person && column.references && column.references.table !== context.person.table) {
    return [
      `Form: defaults "${name}" is me, and "${name}" refers to ${column.references.table}, not to the table people are rows of (auth.me).`,
    ];
  }
  return [];
}

function tableId(table: TableMeta): string {
  return table.id;
}

/** Validate the child-group contract against a catalog before it is exposed.
 * This checks only shape, relation and field authority; it never creates a
 * child, infers a write grant, or treats a presentation form as permission. */
export function validateFormChildren(
  children: readonly FormChildGroup[],
  parent: TableMeta,
  schema: DatabaseSchema,
  readableFields: ReadonlyMap<string, readonly string[]> = new Map(),
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const child of parseFormChildren(children)) {
    if (seen.has(child.id)) problems.push(`Child group "${child.id}" is declared more than once.`);
    seen.add(child.id);
    const targets = schema.tables.filter((table) => table.id === child.table || table.name === child.table);
    const target = targets.length === 1 ? targets[0] : undefined;
    if (!target) {
      problems.push(`Child group "${child.id}" names an unknown or ambiguous table.`);
      continue;
    }
    const from = columnNamed(target.columns, child.relation.from);
    const to = columnNamed(parent.columns, child.relation.to);
    if (!from || !to) problems.push(`Child group "${child.id}" has an unknown relation column.`);
    const relation = schema.foreignKeys.filter(
      (fk) =>
        fk.from.table === tableId(target) &&
        fk.to.table === tableId(parent) &&
        fk.from.columns.length === 1 &&
        fk.to.columns.length === 1 &&
        fk.from.columns[0] === child.relation.from &&
        fk.to.columns[0] === child.relation.to,
    );
    if (relation.length !== 1) problems.push(`Child group "${child.id}" must name one declared foreign-key relation to its parent.`);
    const readable = readableFields.get(target.id) ?? target.columns.map((column) => column.name);
    if (child.form)
      problems.push(...validateAppForm(child.form, target, readable).map((problem) => `Child group "${child.id}": ${problem}`));
  }
  return [...new Set(problems)];
}

interface FormChildInput {
  /** Child rows keyed by the authored group ID; absent means an empty draft. */
  rows?: readonly Readonly<Record<string, unknown>>[];
}

interface FormChildrenResult {
  valid: boolean;
  errors: Record<string, string[]>;
  unresolved: string[];
}

function safeScalar(raw: unknown): FormScalar | undefined {
  if (raw === null) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw) && Math.abs(raw) <= Number.MAX_SAFE_INTEGER) return raw;
  return undefined;
}

/** Evaluate a bounded aggregate draft without persistence. The caller supplies
 * the already-authorized resource rules; unknown rows and relations remain
 * unresolved rather than becoming a false success. */
export function evaluateFormChildren(
  children: readonly FormChildGroup[],
  parentRow: Readonly<Record<string, unknown>>,
  inputs: Readonly<Record<string, FormChildInput | undefined>>,
  schema: DatabaseSchema,
  validation: ReadonlyMap<string, readonly FormRule[]> = new Map(),
): FormChildrenResult {
  const errors: Record<string, string[]> = {};
  const unresolved = new Set<string>();
  const add = (key: string, message: string) => {
    const list = errors[key] ?? (errors[key] = []);
    if (!list.includes(message)) list.push(message);
  };
  for (const child of parseFormChildren(children)) {
    const targets = schema.tables.filter((table) => table.id === child.table || table.name === child.table);
    const target = targets.length === 1 ? targets[0] : undefined;
    if (!target) {
      unresolved.add(child.id);
      continue;
    }
    const input = inputs[child.id];
    const rows = input?.rows ?? [];
    if (!Array.isArray(rows) || rows.length > child.max || rows.length < (child.min ?? 0)) {
      add(child.id, `Add between ${child.min ?? 0} and ${child.max} items.`);
      continue;
    }
    const parentValue = safeScalar(rowValue(parentRow, child.relation.to));
    const fk = columnNamed(target.columns, child.relation.from);
    if (!fk || parentValue === undefined) {
      unresolved.add(child.id);
      continue;
    }
    const rules = validation.get(target.id) ?? validation.get(target.name) ?? [];
    rows.forEach((row, index) => {
      const key = `${child.id}[${index}]`;
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        unresolved.add(key);
        return;
      }
      const childValue = rowValue(row, child.relation.from);
      const linked = comparisonResult({ field: child.relation.from, operator: 'eq', values: [parentValue] }, row, target.columns);
      if (linked === false) add(`${key}.${child.relation.from}`, 'This item belongs to a different parent.');
      else if (linked === 'unknown' || childValue === undefined) unresolved.add(`${key}.${child.relation.from}`);
      if (rules.length) {
        const result = evaluateFormRules(rules, row, target.columns, { mode: 'authoritative' });
        for (const [fieldName, messages] of Object.entries(result.errors)) {
          for (const message of messages) add(`${key}.${fieldName}`, message);
        }
        result.unresolved.forEach((fieldName) => unresolved.add(`${key}.${fieldName}`));
      }
    });
  }
  return { valid: !Object.keys(errors).length && !unresolved.size, errors, unresolved: [...unresolved] };
}

interface FormRuleResult {
  valid: boolean;
  errors: Record<string, string[]>;
  /** Rule target fields whose result is unknown, including incomplete drafts. */
  unresolved: string[];
}

/** Validate a complete candidate row, after trusted default resolution / update
 * merging. Does not read defaults, merge drafts, write, or grant authority.
 * Preview leaves unknown rules unresolved without showing premature field errors.
 * Authoritative mode rejects them with fixed safe messages. Both return valid:false.
 * Transport owners must also redact messages/field keys for unreadable targets.
 */
export function evaluateFormRules(
  rules: readonly FormRule[],
  row: Readonly<Record<string, unknown>>,
  columns: readonly ColumnMeta[],
  options?: { mode: 'authoritative' | 'preview' },
): FormRuleResult {
  const errors: Record<string, string[]> = {};
  const unresolved = new Set<string>();
  const add = (name: string, message: string) => {
    const messages = errors[name] ?? (errors[name] = []);
    if (!messages.includes(message)) messages.push(message);
  };
  const judged = blanksAsEmpty(row, columns);
  for (const rule of parseFormRules(rules)) {
    const applies = rule.when ? evaluateFormCondition(rule.when, row, columns, true) : true;
    if (applies === false) continue;
    const at = ruleField(rule);
    let result: boolean | 'unknown' = 'unknown';
    if (applies === true) {
      try {
        result = conditionResult(compileCondition(rule.must, 'Validation', columns, 'record', true), judged, columns);
      } catch {
        result = 'unknown';
      }
    }
    if (result === 'unknown') {
      unresolved.add(at);
      if (options?.mode !== 'preview') add(at, FORM_UNRESOLVED_MESSAGE);
    } else if (!result) add(at, rule.message);
  }
  return { valid: !Object.keys(errors).length && !unresolved.size, errors, unresolved: [...unresolved] };
}
