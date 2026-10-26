import type { ColumnValue } from './query.js';
import type {
  AppCommandChoice, AppMessageRef, AppUpdateAction, CommandActionBase, CommandFieldDefault, CommandFieldPresentation, CommandLiveLines,
  CommandRichTextMentions, CommandSensitive, CommandTextFormat,
} from '@mistriwork/engine/schema/model.js';
/* The served shapes of an action and its command are the engine's too (model.d.ts); they are named from here as before. */
export type {
  AppAction, AppCommandAction, AppCommandChoice, AppCommandField, AppCommandGroup, AppCommandLines, AppCommandReference, AppFlagGate,
  AppFormCommandReference, AppUpdateAction, CommandChoiceSource, CommandFieldDefault, CommandFieldPresentation, CommandLiveLines,
  CommandRichTextMentions, CommandSensitive, CommandTextFormat,
} from '@mistriwork/engine/schema/model.js';

/**
 * A command's input, declared once, in its `defineCommand` on the server; the
 * server sends the parsed field list to the browser with the App, so a form
 * draws what the handler reads. It is an object keyed by field name, in the
 * order the form asks, each field required unless it says `optional: true`;
 * `field.*` from @mistriwork/mistri/commands writes one concisely. The rules it states
 * — lengths, formats, patterns, case, bounds, steps, a field below or above
 * another — run in the browser, before anything is sent, and again on the
 * server, by one parser. The command adds only its business rules
 * (`validate`, and `handle`).
 */
interface FieldBase {
  /** The field's label; omitted, it is read from the key: `applicant_email` is "Applicant email". */
  label?: string;
  help?: string;
  /** A field is required unless it says `optional: true`; an optional field left empty is absent. */
  optional?: boolean;
  /** What the field starts as; see CommandFieldDefault. An `initial()` value for the field stands over it. */
  default?: CommandFieldDefault;
  /**
   * Asked only while this condition holds, judged over the draft as it is typed: a bare name is another field of this
   * input (`when: 'trade_in = true'`), and on a command that targets one record `record.<column>` is the target's own
   * value, its rollups and computed columns included (`when: 'record.open_children > 0'`). The browser hides the
   * field while it does not hold; the server refuses a value for a hidden field, and requires a shown one unless it
   * says `optional: true`. The handler's input has it optional. A field of the input itself, never one in a group,
   * and never naming a sensitive field.
   */
  when?: string;
  /** How the field is drawn, over its kind's default: `'slider'` (a number or an amount with `min` and `max`),
      `'cards'` (a choice, one or several), `'buttons'` (a yes or a no; a choice's few), `'select'`, `'radios'`. */
  as?: CommandFieldPresentation;
  /** The App's own input component that draws this field in every form that asks it, by its name in `ui.inputs`.
      What the value must be is still the field's kind's to judge, on the server. */
  input?: string;
}

export interface CommandTextField extends FieldBase {
  type: 'text' | 'textarea';
  /** Fewest characters, after trimming. */
  min?: number;
  /** Most characters, after trimming: at most 16384. */
  max?: number;
  /** An email address, a web address (http or https), or a phone number. */
  format?: CommandTextFormat;
  /** A regular expression the whole value must match, as its source text: `field.text({ pattern: /[A-Z]+/ })` stores it so. */
  pattern?: string;
  /** What the form says when the format, pattern or mask is not met. */
  message?: string;
  /** Upper or lower case, applied before any rule is checked. */
  case?: 'upper' | 'lower';
  /** A mask the value is typed through: `0` a digit, `a` a letter, `*` either, anything else drawn as written
      (`mask: '000-00-0000'`). The value is what the mask's places hold (`123456789`); the mask is its pattern. */
  mask?: string;
  /**
   * A value the App must not hold in the clear — an SSN, an account number. Its own rules (the mask, the pattern) read
   * the whole value; then the server keeps only what `keep` says before `validate`, the rules, the handler, the
   * idempotency fingerprint, the journal, the audit, events, flags or a log see it: `'last4'` its last four
   * characters, `'hash'` a keyed hash under `MISTRI_FORM_KEY` (one a status check can confirm), `'none'` nothing,
   * and `'handler'` the whole value for the handler alone, once, in memory (the rest still hold its hash). Drawn
   * masked, with Show beside it; never prefilled, never in an address, never in a `when`, a `live` or a rule. Text only.
   */
  sensitive?: CommandSensitive;
}
export interface CommandNumberField extends FieldBase {
  type: 'number';
  min?: number;
  max?: number;
  /** A whole number, or refused. */
  integer?: boolean;
  /** Rounded to this step: `0.01` keeps cents. */
  step?: number;
  /** Strictly less than this sibling number field, when both are given. */
  below?: string;
  /** Strictly more than this sibling number field, when both are given. */
  above?: string;
  /** Lines said under the field as it is typed, each an expression over this input's numbers in the field's
      format: `live: { monthly: 'biweekly_gross * 26 / 12' }` reads "$5,417 monthly". Display only, never sent. */
  live?: CommandLiveLines;
}
/** An amount in the App's currency (`ui.currency`): typed as `$2,500`, received as a number on its `step` (cents). */
export interface CommandMoneyField extends FieldBase {
  type: 'money';
  min?: number;
  max?: number;
  step?: number;
  below?: string;
  above?: string;
  live?: CommandLiveLines;
}
/** A month and its year, `YYYY-MM`, typed `MM/YYYY` in en-US: `min` and `max` are months too. */
export interface CommandMonthField extends FieldBase {
  type: 'month';
  min?: string;
  max?: string;
  below?: string;
  above?: string;
}
export interface CommandBooleanField extends FieldBase {
  type: 'boolean';
  /**
   * A box that must be checked to send: consent, terms, "I have read the
   * rules". Drawn as a checkbox with its label beside it; left unchecked, the
   * form says "Check this box to continue." before anything is sent, and the
   * server refuses it before the command runs, so the handler receives `true`.
   * Without it a boolean is a yes or a no, and either is an answer.
   */
  accept?: true;
  /** The words a checkbox stands beside when they are longer than a label: a consent's whole paragraph, at most 2,000
      characters, on a box that must be checked (`accept`) or one that may be left. The label stays the short name (the
      review's). Not with `as: 'buttons'`, which has no box. */
  statement?: string;
}
/** An ISO calendar date, `YYYY-MM-DD`; `min` and `max` are dates too. */
export interface CommandDateField extends FieldBase {
  type: 'date';
  min?: string;
  max?: string;
  /** Before this sibling date field, when both are given. */
  below?: string;
  /** After this sibling date field, when both are given. */
  above?: string;
}
/**
 * A moment: a date and a time of day together. The form asks for them as a wall time in the App's `ui.timezone`
 * (the zone its times are shown in) and sends the UTC instant; the handler receives ISO 8601, always
 * `YYYY-MM-DDTHH:MM:SS.sssZ`. An agent or the API sends ISO 8601 with its zone (`Z` or an offset such as
 * `-04:00`); a time with no zone is refused, since it names a different moment in every zone. `min` and `max`
 * are instants too.
 */
export interface CommandDateTimeField extends FieldBase {
  type: 'datetime';
  min?: string;
  max?: string;
  /** Before this sibling datetime field, when both are given. */
  below?: string;
  /** After this sibling datetime field, when both are given. */
  above?: string;
}
/**
 * Rich text: an editor with bold, italic and strike, headings, bullet, numbered
 * and task lists, links, a quote, code, simple tables, @-mentions and pictures,
 * stored as sanitized HTML (shared/richText.ts holds the allowlist). An agent
 * or the API may send Markdown instead: a string that does not start with a
 * tag is read as Markdown, and `{ format: 'markdown' | 'html', text }` says
 * which. The handler receives the sanitized HTML.
 */
export interface CommandRichTextField extends FieldBase {
  type: 'richText';
  /** Fewest characters of text, the words a reader sees (markup and pictures are not counted): at most 16384. */
  min?: number;
  /** Most characters of the stored HTML: at most 200000, and 65536 when unsaid. */
  max?: number;
  /** @-mentions: typing `@` offers the records of `from` (the people), by their handle column `by`, shown by
      `labelColumn` where it is given. The value keeps `@handle`, which a `notify` rule's `mentions` finds. */
  mentions?: CommandRichTextMentions;
  /** Pictures pasted, dropped or picked in the editor: kept as rows of this file resource (`file` on the resource),
      attached to the record the editor is on through its reference to that record's table, and drawn from there
      under each reader's grants. Without a record to attach to (a New form), the editor takes no pictures. */
  images?: string;
}
/** One of the options, drawn as radios when there are a few and a select otherwise. At most 100. Or, with `from`,
    one of a table's rows by its key (`by`, the primary key; `id` unless said), shown by `labelColumn`: read under
    the reader's grants (a public form's, what `auth.public` opens) and checked against the table where it runs. */
export interface CommandChoiceField extends FieldBase { type: 'choice'; options?: readonly AppCommandChoice[]; from?: string; by?: string; labelColumn?: string }
/** Several of the options (or of a table's rows, `from`): at least `min` (0 unless said) and at most `max`; an
    `exclusive` option (`'none'`) is chosen alone. Drawn as checks for a few and a select with checks past six. */
export interface CommandChoicesField extends FieldBase {
  type: 'choices';
  options?: readonly AppCommandChoice[];
  from?: string;
  by?: string;
  labelColumn?: string;
  min?: number;
  max?: number;
  exclusive?: readonly (string | number)[];
}
/** A picker over a resource: its key column and the column it is shown by. Never on a public form.
    `query` narrows the rows offered; `record.<column>` in it is the target record's value (`'sales_order_id = record.id'`). */
export interface CommandReferenceField extends FieldBase { type: 'reference'; from: string; by: string; labelColumn: string; query?: string }
/**
 * Answers to questions that are rows of `from`, which an administrator adds and
 * edits while the App runs (`field.defined('item_variable', { whose: 'item_id' })`).
 * The rows have the columns a row-defined field's do (`key`, `label`, `type`,
 * and `options`, `required`, `help`, `position` where the table has them). On a
 * command over one record, `whose` names the column of `from` that holds the
 * record's key: the record is asked the rows that name it and those that name
 * none. The rows are read through the command's own reads, in the reader's
 * tenant, when the form is prepared, and again where the command runs, which
 * refuses an answer that breaks one (`answers.os`). The handler receives one
 * object, keyed by each row's `key`. Never on a public form, nor in a group.
 */
export interface CommandDefinedField extends FieldBase {
  type: 'defined';
  /** The resource whose rows are the questions; the command declares it among its `read`. */
  from: string;
  /** The column of `from` that names the command's record; absent, every row is asked. */
  whose?: string;
}
/**
 * A section of the form: its fields are asked together, under its label.
 * Its value is an object of its fields; with `repeat`, a list of such rows
 * people add and remove, from `min` (default 0) to `max`. A group may hold a
 * group, and no deeper, and is never optional: its fields are.
 */
export interface CommandGroupField {
  type: 'group';
  label?: string;
  /** A line under the group's label, as a form's groups say theirs. */
  description?: string;
  fields: CommandInput;
  /** At most 50 rows; at most 10 on a public form. */
  repeat?: { min?: number; max: number };
}
/**
 * A record's lines — an order's items, a pay run's lines — asked as the lines
 * grid a New form's `form.lines` draws: `field.lines('order_line', { show:
 * ['variant_id', 'quantity'], min: 1 })`. Each line is the columns `show` names
 * of a row of `from`, drawn as the column is (a reference with its photo and
 * second line, money in its currency, a count), with the line's computed
 * columns worked out beside it and the money ones added up under the grid.
 * The handler receives the lines in their order, each column read as its kind
 * (a number, text, a day, yes or no) and every one given; it writes the rows
 * itself, so `from` is among the command's `write`, and the grant to write them
 * is the command's, not the table's. `copy` fills a column of the line from the
 * record a reference names as it is picked (`{ unit_price_amount:
 * 'variant_id.price_amount' }`): shown, never sent, since the handler reads that
 * record itself. Never on a public form, nor in a group.
 */
export interface CommandLinesField {
  type: 'lines';
  label?: string;
  /** A line under the label, as a group's says it. */
  description?: string;
  /** The resource of the rows; the command declares it among its `write`. */
  from: string;
  /** The row's columns asked, in order: one to 12. */
  show: readonly string[];
  /** A column of the line → the reference it is copied through and that record's column, one hop: `'variant_id.price_amount'`. */
  copy?: Readonly<Record<string, string>>;
  /** A shown reference → the rows its picker offers, as `field.reference`'s `query` (`{ variant_id: 'active = true' }`).
      It narrows what is offered; the handler still judges what is sent. */
  query?: Readonly<Record<string, string>>;
  /** At least this many lines (default 0). */
  min?: number;
  /** At most 50 lines (the default). */
  max?: number;
}

/** One field as it is authored. */
export type CommandField = CommandTextField | CommandRichTextField | CommandNumberField | CommandMoneyField | CommandBooleanField
  | CommandDateField | CommandMonthField | CommandDateTimeField | CommandChoiceField | CommandChoicesField | CommandReferenceField
  | CommandDefinedField | CommandGroupField | CommandLinesField;

/** A rule over the whole draft, as a resource's validation says one: the input must meet `must` wherever `when`
    holds, and `message` is said at the first field `must` names. Pure conditions over this input's own fields
    (with `today` and `now`), no reads: a form checks each one before leaving the step that asks its last field. */
export interface CommandRule { must: string; when?: string; message: string }
/** A command's input: its fields keyed by name, in the order the form asks them. */
export type CommandInput = { readonly [name: string]: CommandField };

type FieldValue<F> =
  F extends { type: 'lines'; from: infer R extends string; show: readonly (infer C extends string)[] } ? { [K in C]: ColumnValue<R, K> }[]
  : F extends { type: 'group'; fields: infer G extends CommandInput; repeat: object } ? CommandInputOf<G>[]
  : F extends { type: 'group'; fields: infer G extends CommandInput } ? CommandInputOf<G>
  : F extends { type: 'text' | 'textarea' | 'richText' | 'date' | 'month' | 'datetime' } ? string
  : F extends { type: 'number' | 'money' } ? number
  : F extends { type: 'boolean'; accept: true } ? true
  : F extends { type: 'boolean' } ? boolean
  : F extends { type: 'choice'; options: readonly (infer O)[] } ? (O extends { value: infer V } ? V : never)
  : F extends { type: 'choice' } ? string | number
  : F extends { type: 'choices'; options: readonly (infer O)[] } ? (O extends { value: infer V } ? V : never)[]
  : F extends { type: 'choices' } ? (string | number)[]
  : F extends { type: 'reference' } ? string | number
  : F extends { type: 'defined' } ? Record<string, string | number | boolean | string[]>
  : never;
/* A field asked only where its `when` holds may be absent, as an optional one may. */
type Optional<F> = F extends { optional: true } ? true : F extends { when: string } ? true
  : F extends { sensitive: { keep: 'none' } } ? true : false;
type Flat<T> = { [K in keyof T]: T[K] } & {};

/**
 * The value a declaration's parser hands a command: each required field and
 * every group present, an optional field that was left empty absent. Text
 * arrives trimmed and in its declared case, a number on its step.
 */
export type CommandInputOf<I extends CommandInput> = string extends keyof I
  // A declaration whose names are not known (typed wide, not written out) says nothing about its value.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ? Record<string, any>
  : Flat<{ [K in keyof I & string as Optional<I[K]> extends true ? never : K]: FieldValue<I[K]> }
    & { [K in keyof I & string as Optional<I[K]> extends true ? K : never]?: FieldValue<I[K]> }>;

/** What `initial` may return: any part of the input, shaped as the input is. */
export type CommandInitialOf<I extends CommandInput> = string extends keyof I
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ? Record<string, any> : {
  [K in keyof I & string]?: I[K] extends { type: 'group'; fields: infer G extends CommandInput; repeat: object } ? CommandInitialOf<G>[]
    : I[K] extends { type: 'group'; fields: infer G extends CommandInput } ? CommandInitialOf<G>
    : FieldValue<I[K]>;
};


/**
 * A value a fixed action's `set` writes: a literal, or a value the server
 * works out inside the write. The constants from `@mistriwork/mistri/app` (`{ auto:
 * 'now' }` in JSON): `now` is the moment, written to a DATE column as the day
 * in `ui.timezone` (UTC without one), to a column that holds no zone
 * (TIMESTAMP, DATETIME, SQLite's text) as the wall-clock time in that zone,
 * and to a zoned one (`timestamptz`) as the instant; `today` is that day, to
 * a DATE column; `me` is the
 * signed-in account's email, written to a text column of an App with `auth`.
 * Or a constant expression in the computed-column grammar —
 * `computed.date('today + 14 days')`, `computed.date('now + 1 week')`,
 * `computed.number('3 * 7')` — worked out as the write runs; it reads no
 * column (a value from the record is a command handler's) and its type fits
 * the column's. On a column that cannot hold the value, the App refuses to
 * load; a literal text "now", "today" or "me", or text starting with "=", is
 * refused too, since it would read as one. The generated schema types name
 * columns, not their kinds, so which column may hold which is the load
 * check's to judge.
 */
export type ActionSetValue = string | number | boolean | null | { readonly auto: 'now' | 'today' | 'me' }
  | { readonly type: 'date' | 'number' | 'boolean'; readonly value: string };

/** A command action as it is authored: the command by its name, which the generated mistri-commands.d.ts types. */
export interface CommandAction<Name extends string = string, Label extends string | AppMessageRef = string | AppMessageRef> extends CommandActionBase<Label> {
  command: Name;
  /** The command's own `when` decides where its button is offered; say it once, in `defineCommand`. */
  when?: never;
}

/** A resource action as it is authored. A fixed action's `set` also takes a column held `undefined`, which is
    how TypeScript reads a list of them: `[{ set: { status: 'resolved', resolved_on: now } }, { set: { status: 'open' } }]`
    becomes one type in which the second leaves `resolved_on?: undefined`. Refused, that surfaced as "Property
    'command' is missing", the other kind of action, when nothing was wrong. */
export type Action<Name extends string = string, Label extends string | AppMessageRef = string | AppMessageRef> =
  | (Omit<AppUpdateAction<Label>, 'set' | 'id'> & { set: { readonly [column: string]: ActionSetValue | undefined } })
  | CommandAction<Name, Label>;
