/**
 * `field.*`: a command's input fields, each the plain object it stands for —
 * `input: { applicant_email: field.email(), term_months: field.choice([36,
 * 48, 60], { each: n => `${n} months` }) }` — written in the command's own
 * definition, the one place its input is declared. A field is required unless
 * it says `optional: true`; its label is read from its key unless it gives
 * one; a pattern is kept as its source, so the declaration stays JSON the
 * server can send the browser; a choice's labels are written out here, once.
 */
import type {
  AppCommandChoice,
  CommandBooleanField,
  CommandChoiceField,
  CommandChoicesField,
  CommandDateField,
  CommandDateTimeField,
  CommandDefinedField,
  CommandGroupField,
  CommandInput,
  CommandLinesField,
  CommandMoneyField,
  CommandMonthField,
  CommandNumberField,
  CommandReferenceField,
  CommandRichTextField,
  CommandTextField,
} from '../../../schema/command.js';
import { vocabularyWord } from '@mistriwork/engine/shared/model.js';
import type { PickerGuard, ShowGuard } from '../../../schema/query.js';

type Optional<O> = (O extends { optional: true } ? { optional: true } : unknown) &
  (O extends { when: string } ? { when: O['when'] } : unknown);
type TextOptions = Omit<CommandTextField, 'type' | 'pattern'> & { pattern?: RegExp | string };
type FormatOptions = Omit<TextOptions, 'format'>;
const choiceWord = (value: unknown): string =>
  typeof value === 'string' && !/^[A-Z0-9_]+$/.test(value) ? vocabularyWord(value) : String(value);
type ChoiceValue<V> = V extends { value: infer X } ? X : V;

const spec = (type: string, options: Record<string, unknown> = {}): never => {
  const { pattern, ...rest } = options;
  if (pattern instanceof RegExp && pattern.flags) throw new TypeError('A field pattern takes no flags; declare case with `case`.');
  return { type, ...rest, ...(pattern === undefined ? {} : { pattern: pattern instanceof RegExp ? pattern.source : pattern }) } as never;
};

/* One choice or several: from written values, or from a table's rows (`{ from, label }`, its label column). */
function choiceSpec(
  type: 'choice' | 'choices',
  values: unknown,
  options: { each?: (value: never) => string } & Record<string, unknown>,
): never {
  if (!Array.isArray(values)) {
    const { label, ...rest } = values as Record<string, unknown>;
    return spec(type, { ...rest, labelColumn: label });
  }
  const { each, ...rest } = options;
  return spec(type, {
    ...rest,
    options: values.map((value: unknown) =>
      value && typeof value === 'object' ? value : { value, label: each ? String(each(value as never)) : choiceWord(value) },
    ),
  });
}

export const field: {
  /** A line of text: `min`/`max` characters, a `format`, a `pattern` (with the `message` a mismatch shows) and a `case`. */
  text<const O extends TextOptions = {}>(options?: O): CommandTextField & { type: 'text' } & Optional<O>;
  /** Text over several lines; tabs and line breaks are kept. */
  textarea<const O extends TextOptions = {}>(options?: O): CommandTextField & { type: 'textarea' } & Optional<O>;
  /** Formatted text — headings, lists, tasks, links, tables, @mentions, pictures — kept as sanitized HTML; an API or agent may send Markdown. */
  richText<const O extends Omit<CommandRichTextField, 'type'> = {}>(options?: O): CommandRichTextField & Optional<O>;
  /** An email address, at most 254 characters. */
  email<const O extends FormatOptions = {}>(options?: O): CommandTextField & { type: 'text' } & Optional<O>;
  /** A phone number: digits, spaces and + ( ) . -, at least seven digits. */
  phone<const O extends FormatOptions = {}>(options?: O): CommandTextField & { type: 'text' } & Optional<O>;
  /** A web address, http or https. */
  url<const O extends FormatOptions = {}>(options?: O): CommandTextField & { type: 'text' } & Optional<O>;
  /** A number: `min`, `max`, `integer`, a `step` it is rounded to, `below`/`above` a sibling. */
  number<const O extends Omit<CommandNumberField, 'type'> = {}>(options?: O): CommandNumberField & Optional<O>;
  /** An amount of money in the App's currency, from 0 unless `min` says less, in cents unless `step` says otherwise; `as: 'slider'` between `min` and `max`. */
  money<const O extends Omit<CommandMoneyField, 'type'> = {}>(options?: O): CommandMoneyField & Optional<O>;
  /** A month and its year, `YYYY-MM` (typed `MM/YYYY` in en-US): `min`, `max`, `below`/`above` a sibling month. */
  month<const O extends Omit<CommandMonthField, 'type'> = {}>(options?: O): CommandMonthField & Optional<O>;
  /** A calendar date, `YYYY-MM-DD`: `min`, `max`, `below`/`above` a sibling date. */
  date<const O extends Omit<CommandDateField, 'type'> = {}>(options?: O): CommandDateField & Optional<O>;
  /** A date and a time of day: the form asks in the App's time zone, the handler receives the UTC instant (`2026-10-12T13:30:00.000Z`); `min`, `max`, `below`/`above` a sibling datetime. */
  datetime<const O extends Omit<CommandDateTimeField, 'type'> = {}>(options?: O): CommandDateTimeField & Optional<O>;
  /** Yes or no; `accept: true` for a box that must be checked to send (consent, terms). */
  bool<const O extends Omit<CommandBooleanField, 'type'> = {}>(
    options?: O,
  ): CommandBooleanField & Optional<O> & (O extends { accept: true } ? { accept: true } : unknown);
  /** One of these values: `choice([36, 48, 60], { each: n => `${n} months` })`, or `{ value, label }` options. A bare string is said as words (`'wont_fix'` is "Wont fix"; an all-caps code stays as written). */
  choice<
    const V extends readonly (string | number | AppCommandChoice)[],
    const O extends Omit<CommandChoiceField, 'type' | 'options'> = {},
  >(
    values: V,
    options?: O & { each?: (value: Exclude<V[number], AppCommandChoice>) => string },
  ): Omit<CommandChoiceField, 'options'> & { options: readonly { value: ChoiceValue<V[number]>; label: string }[] } & Optional<O>;
  /** One of a table's rows, by key: `field.choice({ from: 'category', label: 'name' })` offers each row's `name` and
      sends its `id` (`by` names another key column). The rows are read as the form opens and again as it is sent. */
  choice<const O extends Omit<CommandChoiceField, 'type' | 'options' | 'from' | 'labelColumn'> & { from: string; label: string }>(
    source: O,
  ): CommandChoiceField & { from: O['from'] } & Optional<O>;
  /** Several of these values, or of a table's rows (`{ from, label }`): `min`/`max` how many, an `exclusive` value chosen alone (`'none'`). */
  choices<
    const V extends readonly (string | number | AppCommandChoice)[],
    const O extends Omit<CommandChoicesField, 'type' | 'options'> = {},
  >(
    values: V,
    options?: O & { each?: (value: Exclude<V[number], AppCommandChoice>) => string },
  ): Omit<CommandChoicesField, 'options'> & { options: readonly { value: ChoiceValue<V[number]>; label: string }[] } & Optional<O>;
  choices<const O extends Omit<CommandChoicesField, 'type' | 'options' | 'from' | 'labelColumn'> & { from: string; label: string }>(
    source: O,
  ): CommandChoicesField & { from: O['from'] } & Optional<O>;
  /** A picker over a resource: `field.reference('customer', { by: 'id', labelColumn: 'name' })`, its key column (`by`) and the column it is shown by; a `query` may name the target's own columns (`'sales_order_id = record.id'`). On a public form, over a resource `auth.public` opens: the visitor's choices are the rows it reads, by key and label. */
  reference<const R extends string, const O extends Omit<CommandReferenceField, 'type' | 'from'>>(
    from: R,
    options: O & NoInfer<PickerGuard<R, O>>,
  ): CommandReferenceField & { from: R } & O;
  /** Answers to questions that are rows of `from`, kept as one object: `field.defined('item_variable', { whose: 'item_id' })` asks a record the rows whose `item_id` is its own, and those with none. */
  defined<const R extends string, const O extends Omit<CommandDefinedField, 'type' | 'from'> = {}>(
    from: R,
    options?: O,
  ): CommandDefinedField & { from: R } & Optional<O>;
  /** A record's lines as the lines grid asks them: `field.lines('order_line', { show: ['variant_id', 'quantity'], min: 1 })`; the handler receives each line's columns as their kinds. The command writes the rows, so `from` is among its `write`. Never on a public form, nor in a group. */
  lines<const R extends string, const S extends readonly string[], const O extends Omit<CommandLinesField, 'type' | 'from' | 'show'> = {}>(
    from: R,
    options: O & { show: S & NoInfer<ShowGuard<R, S>> },
  ): { type: 'lines'; from: R; show: S } & O;
  /** A section of fields, or with `repeat` its rows. */
  group<const F extends CommandInput, const O extends Omit<CommandGroupField, 'type' | 'fields'> = {}>(
    fields: F,
    options?: O,
  ): { type: 'group'; fields: F } & O;
} = Object.freeze({
  text: (options?: object) => spec('text', options as Record<string, unknown>),
  textarea: (options?: object) => spec('textarea', options as Record<string, unknown>),
  richText: (options?: object) => spec('richText', options as Record<string, unknown>),
  email: (options?: object) => spec('text', { format: 'email', max: 254, ...options }),
  phone: (options?: object) => spec('text', { format: 'phone', max: 40, ...options }),
  url: (options?: object) => spec('text', { format: 'url', max: 2048, ...options }),
  number: (options?: object) => spec('number', options as Record<string, unknown>),
  money: (options?: object) => spec('money', options as Record<string, unknown>),
  month: (options?: object) => spec('month', options as Record<string, unknown>),
  date: (options?: object) => spec('date', options as Record<string, unknown>),
  datetime: (options?: object) => spec('datetime', options as Record<string, unknown>),
  bool: (options?: object) => spec('boolean', options as Record<string, unknown>),
  /* A bare value is said as words, as a display vocabulary says it: `wont_fix` is "Wont fix"; an all-caps code stays as written. */
  choice: (values: unknown, options: Record<string, unknown> = {}) => choiceSpec('choice', values, options),
  choices: (values: unknown, options: Record<string, unknown> = {}) => choiceSpec('choices', values, options),
  reference: (from: string, options: object) => spec('reference', { from, ...options }),
  defined: (from: string, options: object = {}) => spec('defined', { from, ...options }),
  lines: (from: string, options: object) => ({ type: 'lines', from, ...options }) as never,
  group: (fields: object, options: object = {}) => ({ type: 'group', ...options, fields }) as never,
});
