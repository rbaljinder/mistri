/**
 * A command's input, read against its declaration: the one parser the
 * server runs before a command's own `validate`, and the browser runs to
 * say which field needs attention before anything is sent. It is derived
 * from the field list alone — required, lengths, formats, patterns, case,
 * bounds, whole numbers and steps, dates and moments, a field below or above its
 * sibling, choices, nesting, repeat limits and reference shape — so a
 * command declares its input once, in a browser-safe module both sides import.
 *
 * What comes back is a fresh plain object in the declaration's order: text
 * trimmed and in its declared case, a number on its step, an optional field
 * left empty absent, every group present (an object, or its rows). A key the
 * declaration does not name is refused. A refusal names the field it is
 * about by path — `reason`, `applicant.email`, `vehicles[1].stock` — and
 * never echoes a value.
 */
import type { AppCommandField } from './command.js';
import { COMMAND_INPUT_LIMITS, fieldPattern, isIsoDate, isIsoMonth, isoInstant, maskPattern } from './command.js';
import { RICH_TEXT_MOST, richTextPlain } from '@mistriwork/engine/shared/richText.js';
import { DEFINED_KEY, DEFINITIONS_MOST } from '@mistriwork/engine/shared/definedFields.js';

export type CommandInputReason =
  | 'shape'
  | 'required'
  | 'type'
  | 'text'
  | 'too_short'
  | 'too_long'
  | 'format'
  | 'pattern'
  | 'below_min'
  | 'above_max'
  | 'integer'
  | 'not_below'
  | 'not_above'
  | 'choice'
  | 'too_few'
  | 'too_many'
  | 'exclusive';

/** One problem: `path` is empty when it is the input's shape as a whole, such as a key nobody declared. */
type CommandInputProblem = { path: string; reason: CommandInputReason };

/** The first problem, as the server's parser meets it. */
export class CommandInputRefusal extends Error {
  constructor(
    readonly path: string,
    readonly reason: CommandInputReason,
  ) {
    super('The command input is invalid.');
    this.name = 'CommandInputRefusal';
  }
}

interface ReadOptions {
  /** A public form's submission: repeats are held to the public cap whatever the declaration says. */
  publicForm?: boolean;
  /** Starting values (`initial`): nothing is required and no repeat has a minimum; every value is still checked. */
  partial?: boolean;
  /**
   * The server's reading of a rich text value — Markdown or HTML in, sanitized
   * HTML out (server/richText.ts `readRichTextInput`), throwing a refusal with
   * a `reason`. The browser has none: it checks the shape and the size, and
   * the server's reading is the one that is kept.
   */
  richText?: (value: unknown, most: number) => string;
  /**
   * A line's cell read as its column's kind (`lineCell`), where the reader has
   * the catalog: the server where the command runs, the browser from the one it
   * is served. Without one a cell is judged by its shape alone.
   */
  cell?: (table: string, column: string, value: string | number | boolean) => { value: unknown } | CommandInputReason;
  /**
   * Whether a value is one of a table's rows, for a choice read from one (`field.choice({ from })`): the server's
   * reading against the rows the reader may read, the browser's against the options it was served. Without one a
   * value is judged by its shape alone, and the server judges it again.
   */
  sourced?: (field: { name: string; source: { from: string; by: string; labelColumn: string } }, value: string | number) => boolean;
}

interface State extends ReadOptions {
  problems?: CommandInputProblem[];
}

// eslint-disable-next-line no-control-regex -- One line of text holds no control characters.
const CONTROL = /[\x00-\x1f\x7f]/;
// eslint-disable-next-line no-control-regex -- A textarea keeps tabs and line breaks, and nothing else below space.
const CONTROL_MULTILINE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/* The formats a text field may declare. Shape checks, not verification:
   nothing here sends mail, opens the address or dials the number. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ().-]{7,32}$/;
const FORMATS: Record<'email' | 'url' | 'phone', (value: string) => boolean> = {
  email: (value) => EMAIL.test(value),
  url: (value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:') && !!url.hostname;
    } catch {
      return false;
    }
  },
  phone: (value) => PHONE.test(value) && value.replace(/\D/g, '').length >= 7,
};

/** A number on its step: `0.01` keeps cents, and the rounding leaves no binary tail behind. */
function onStep(value: number, step: number): number {
  const text = String(step);
  const places = text.includes('e-') ? Number(text.split('e-')[1]) : (text.split('.')[1]?.length ?? 0);
  return Number((Math.round(value / step) * step).toFixed(Math.min(places, 20)));
}

const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));
const at = (within: string, name: string): string => (within ? `${within}.${name}` : name);

function refuse(state: State, path: string, reason: CommandInputReason): void {
  if (!state.problems) throw new CommandInputRefusal(path, reason);
  state.problems.push({ path, reason });
}

function readValue(
  field: Exclude<AppCommandField, { type: 'group' | 'lines' }>,
  value: unknown,
  path: string,
  state: State,
): { value?: unknown } {
  const blank =
    value === undefined || value === null || value === '' || (typeof value === 'string' && field.type !== 'choice' && !value.trim());
  /* Questions defined in rows always arrive as an object, answered or not: the rows say which answers are required. */
  if (blank && field.type === 'defined') return state.partial ? {} : { value: {} };
  if (blank) {
    /* A field asked only where its `when` holds is required there: the server judges it against the record. */
    if (field.required && !state.partial && field.when === undefined) refuse(state, path, 'required');
    return {};
  }
  const problem = (reason: CommandInputReason) => {
    refuse(state, path, reason);
    return {};
  };
  switch (field.type) {
    case 'text':
    case 'textarea': {
      if (typeof value !== 'string') return problem('type');
      const trimmed = value.trim();
      // A masked value is what its places hold (`123456789`), and the mask is its pattern.
      if (field.type === 'text' && field.mask !== undefined) {
        if (CONTROL.test(trimmed)) return problem('text');
        return fieldPattern(maskPattern(field.mask)).test(trimmed) ? { value: trimmed } : problem('pattern');
      }
      const cased = field.case === 'upper' ? trimmed.toUpperCase() : field.case === 'lower' ? trimmed.toLowerCase() : trimmed;
      if ((field.type === 'text' ? CONTROL : CONTROL_MULTILINE).test(cased)) return problem('text');
      if (field.minLength !== undefined && cased.length < field.minLength) return problem('too_short');
      if (field.maxLength !== undefined && cased.length > field.maxLength) return problem('too_long');
      if (field.format !== undefined && !FORMATS[field.format](cased)) return problem('format');
      if (field.pattern !== undefined && !fieldPattern(field.pattern).test(cased)) return problem('pattern');
      return { value: cased };
    }
    case 'number':
    case 'money': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return problem('type');
      if (field.type === 'number' && field.integer && !Number.isSafeInteger(value)) return problem('integer');
      const stepped = field.step === undefined ? value : onStep(value, field.step);
      if (field.min !== undefined && stepped < field.min) return problem('below_min');
      if (field.max !== undefined && stepped > field.max) return problem('above_max');
      return { value: stepped };
    }
    case 'boolean':
      if (typeof value !== 'boolean') return problem('type');
      // A box that must be checked, unchecked, is a required answer not given.
      return field.accept && !value && !state.partial && field.when === undefined ? problem('required') : { value };
    case 'date': {
      if (!isIsoDate(value)) return problem('type');
      if (field.min !== undefined && value < field.min) return problem('below_min');
      if (field.max !== undefined && value > field.max) return problem('above_max');
      return { value };
    }
    case 'month': {
      if (!isIsoMonth(value)) return problem('type');
      if (field.min !== undefined && value < field.min) return problem('below_min');
      if (field.max !== undefined && value > field.max) return problem('above_max');
      return { value };
    }
    case 'datetime': {
      // One spelling, the UTC instant, so bounds and siblings compare as text and the handler reads one form.
      const at = isoInstant(value);
      if (at === undefined) return problem('type');
      if (field.min !== undefined && at < field.min) return problem('below_min');
      if (field.max !== undefined && at > field.max) return problem('above_max');
      return { value: at };
    }
    case 'choice':
      if (field.source)
        return sourced(field as typeof field & { source: NonNullable<typeof field.source> }, value, state) ? { value } : problem('choice');
      return field.options.some((option) => option.value === value) ? { value } : problem('choice');
    case 'choices': {
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return problem('type');
      if (value.length > COMMAND_INPUT_LIMITS.choiceOptions) return problem('too_many');
      const picked: (string | number)[] = [];
      for (const item of value) {
        const known = field.source
          ? sourced(field as typeof field & { source: NonNullable<typeof field.source> }, item, state)
          : field.options.some((option) => option.value === item);
        if (!known) return problem('choice');
        if (!picked.includes(item as string | number)) picked.push(item as string | number);
      }
      // None chosen is no answer: the field's required, or its min, says whether that is enough.
      if (!picked.length) {
        if (field.required && !state.partial && field.when === undefined) refuse(state, path, 'required');
        return {};
      }
      if (field.exclusive?.some((alone) => picked.includes(alone)) && picked.length > 1) return problem('exclusive');
      if (!state.partial && field.min !== undefined && picked.length < field.min) return problem('too_few');
      if (field.max !== undefined && picked.length > field.max) return problem('too_many');
      return { value: picked };
    }
    case 'richText': {
      const said =
        typeof value === 'string'
          ? value
          : plain(value) &&
              Object.keys(value).length === 2 &&
              (value.format === 'markdown' || value.format === 'html') &&
              typeof value.text === 'string'
            ? value.text
            : undefined;
      if (said === undefined) return problem('type');
      const most = field.maxLength ?? RICH_TEXT_MOST;
      let html = said;
      if (state.richText) {
        try {
          html = state.richText(value, most);
        } catch (error) {
          return problem((error as { reason?: unknown }).reason === 'too_long' ? 'too_long' : 'type');
        }
      }
      // A value with no words and no picture — an empty paragraph the editor leaves — is no answer.
      if (!richTextPlain(html) && !/<img\b/i.test(html)) {
        if (field.required && !state.partial && field.when === undefined) refuse(state, path, 'required');
        return {};
      }
      /* Unread, the text is judged as the reader judges what arrives (four times the kept size): what is kept is only known once it is cleaned. */
      if (html.length > (state.richText ? most : most * 4)) return problem('too_long');
      if (field.minLength !== undefined && richTextPlain(html).trim().length < field.minLength) return problem('too_short');
      return { value: html };
    }
    case 'reference': {
      if (typeof value === 'number') return Number.isSafeInteger(value) ? { value } : problem('type');
      if (typeof value !== 'string' || value.trim().length > 256) return problem('type');
      return { value: value.trim() };
    }
    /* Answers keyed by the questions' keys: only their shape is the declaration's. Which questions there are, and
       what each one takes, are rows, judged where the command runs (businessCommandExecution.ts); an answer left
       empty is left out. */
    case 'defined': {
      if (!plain(value)) return problem('type');
      const answers: Record<string, unknown> = {};
      const entries = Object.entries(value);
      if (entries.length > DEFINITIONS_MOST) return problem('too_many');
      for (const [key, answer] of entries) {
        if (!DEFINED_KEY.test(key)) return problem('shape');
        if (answer === null || answer === undefined || (typeof answer === 'string' && !answer.trim())) continue;
        const fits =
          (typeof answer === 'string' && answer.length <= 10000) ||
          (typeof answer === 'number' && Number.isFinite(answer)) ||
          typeof answer === 'boolean' ||
          (Array.isArray(answer) && answer.length <= 100 && answer.every((item) => typeof item === 'string' && item.length <= 1000));
        if (!fits) return problem('type');
        if (Array.isArray(answer) && !answer.length) continue;
        answers[key] = Array.isArray(answer) ? [...answer] : answer;
      }
      return { value: answers };
    }
  }
}

/* A table's row, by key: a key's shape here, and its row the reader's `sourced` judgement where there is one. */
function sourced(
  field: { name: string; source: { from: string; by: string; labelColumn: string } },
  value: unknown,
  state: State,
): boolean {
  const shaped =
    (typeof value === 'string' && value.trim() !== '' && value.length <= 256) || (typeof value === 'number' && Number.isSafeInteger(value));
  return shaped && (state.sourced ? state.sourced(field, value as string | number) : true);
}

function readList(fields: readonly AppCommandField[], raw: unknown, within: string, state: State): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const given = raw === undefined || raw === null ? {} : raw;
  if (!plain(given)) {
    refuse(state, within, 'shape');
    return result;
  }
  const known = new Set(fields.map((field) => field.name));
  // A key nobody declared is named by no path: what arrived is not echoed back.
  if (Object.keys(given).some((key) => !known.has(key))) refuse(state, '', 'shape');
  for (const field of fields) {
    const path = at(within, field.name);
    const value = Object.hasOwn(given, field.name) ? given[field.name] : undefined;
    if (field.type === 'lines') {
      if (state.partial && value === undefined) continue;
      result[field.name] = readLines(field, value, path, state);
      continue;
    }
    if (field.type !== 'group') {
      const read = readValue(field, value, path, state);
      if ('value' in read) result[field.name] = read.value;
      continue;
    }
    if (state.partial && value === undefined) continue;
    if (!field.repeat) {
      result[field.name] = readList(field.fields, value, path, state);
      continue;
    }
    const rows = value === undefined || value === null ? [] : value;
    if (!Array.isArray(rows)) {
      refuse(state, path, 'shape');
      continue;
    }
    const max = state.publicForm ? Math.min(field.repeat.max, COMMAND_INPUT_LIMITS.publicRepeatRows) : field.repeat.max;
    if (rows.length > max) {
      refuse(state, path, 'too_many');
      continue;
    }
    if (!state.partial && rows.length < (field.repeat.min ?? 0)) refuse(state, path, 'too_few');
    result[field.name] = rows.map((row, index) => readList(field.fields, row, `${path}[${index}]`, state));
  }
  // A field below or above its sibling: judged on the values as read, only when both were given.
  for (const field of fields) {
    if (
      (field.type !== 'number' && field.type !== 'money' && field.type !== 'date' && field.type !== 'month' && field.type !== 'datetime') ||
      !Object.hasOwn(result, field.name)
    )
      continue;
    const mine = result[field.name] as number | string;
    if (field.below !== undefined && Object.hasOwn(result, field.below) && !(mine < (result[field.below] as number | string))) {
      refuse(state, at(within, field.name), 'not_below');
    }
    if (field.above !== undefined && Object.hasOwn(result, field.above) && !(mine > (result[field.above] as number | string))) {
      refuse(state, at(within, field.name), 'not_above');
    }
  }
  return result;
}

/* A record's lines (`field.lines`): one to `max` rows, each the columns the field shows and no other, every one given. */
function readLines(field: Extract<AppCommandField, { type: 'lines' }>, raw: unknown, path: string, state: State): unknown[] {
  const rows = raw === undefined || raw === null ? [] : raw;
  if (!Array.isArray(rows)) {
    refuse(state, path, 'shape');
    return [];
  }
  if (rows.length > field.max) {
    refuse(state, path, 'too_many');
    return [];
  }
  if (!state.partial && rows.length < (field.min ?? 0)) refuse(state, path, 'too_few');
  return rows.map((row, index) => {
    const at = `${path}[${index}]`;
    const line: Record<string, unknown> = {};
    if (!plain(row) || Object.keys(row).some((key) => !field.show.includes(key))) {
      refuse(state, at, 'shape');
      return line;
    }
    for (const column of field.show) {
      const value = row[column];
      const cell = `${at}.${column}`;
      if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
        if (!state.partial) refuse(state, cell, 'required');
        continue;
      }
      if (
        !(typeof value === 'string' && value.length <= 10_000 && !CONTROL.test(value)) &&
        !(typeof value === 'number' && Number.isFinite(value)) &&
        typeof value !== 'boolean'
      ) {
        refuse(state, cell, 'type');
        continue;
      }
      const read = state.cell ? state.cell(field.from, column, value) : { value: typeof value === 'string' ? value.trim() : value };
      if (typeof read === 'string') refuse(state, cell, read);
      else line[column] = read.value;
    }
    return line;
  });
}

/** The server's reading: the parsed input, or a CommandInputRefusal naming the first problem. */
export function readCommandInput(fields: readonly AppCommandField[], raw: unknown, options: ReadOptions = {}): Record<string, unknown> {
  if (!plain(raw)) throw new CommandInputRefusal('', 'shape');
  return readList(fields, raw, '', { ...options });
}

/** Every problem at once, for a form that marks each field that needs attention. */
export function commandInputProblems(
  fields: readonly AppCommandField[],
  raw: unknown,
  options: Pick<ReadOptions, 'cell' | 'sourced'> = {},
): Array<{ path: string; reason: CommandInputReason }> {
  const state: State = { ...options, problems: [] };
  if (!plain(raw)) return [{ path: '', reason: 'shape' }];
  readList(fields, raw, '', state);
  return state.problems!;
}

/** The declared field a path names, with the rows it sits in read through: `vehicles[1].stock` is `vehicles` → `stock`. */
export function commandFieldAt(fields: readonly AppCommandField[], path: string): AppCommandField | undefined {
  let list: readonly AppCommandField[] = fields;
  let found: AppCommandField | undefined;
  for (const part of path.split('.')) {
    const name = part.replace(/\[\d+\]$/, '');
    found = list.find((field) => field.name === name);
    if (!found) return undefined;
    list = found.type === 'group' ? found.fields : [];
  }
  return found;
}
