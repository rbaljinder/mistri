/**
 * A command's inputs, drawn: the controls the command modal and a command
 * form share. The declaration they draw is the one the server parses by —
 * one field list, in a browser-safe module — so what this checks before
 * anything is sent (`commandInput`, `commandProblems`, through the shared
 * reader) is what the server would refuse, in the person's words.
 *
 * A group is a section, headed by its label; a repeating group is its rows,
 * each added and removed here between the declared minimum and maximum; a
 * choice is radios when it has a few options and the tool's listbox when it
 * has more; a date is the date input the record editor uses, and a date
 * and time the same input with its clock, read in the App's time zone.
 * Questions defined in rows (`field.defined`) are a section of one control
 * per question, as prepare read them. A record's lines (`field.lines`) are the
 * lines grid (CommandLines.tsx), each cell read as its column's kind.
 */
import { Fragment, useRef, useState, type ReactElement } from 'react';
import type { AppCommandField } from '../../shared/command.js';
import type { DraftRule } from '../../shared/commandDraft.js';
import {
  CommandInputRefusal,
  commandFieldAt,
  commandInputProblems,
  heldFilePath,
  readCommandInput,
  type CommandInputReason,
} from '../../shared/commandInput.js';
import { toast } from '@mistriwork/kit/client/core.js';
import type { LineDraft } from './FormLines.js';
import { RichTextField, mentionSearch, pictureKeeper } from '@mistriwork/kit/client/components/RichTextField.js';
import type { CommandValue } from '../commandState.js';
import { Dropdown, readsAsName } from '@mistriwork/kit/client/components/Dropdown.js';
import { DateField } from '@mistriwork/kit/client/components/DateField.js';
import { appNow, defaultCurrency, formatLocale, formatTimezone } from '@mistriwork/kit/client/locale.js';
import { onDemand, useArrived } from '@mistriwork/kit/client/components/onDemand.js';
import { Button } from '@mistriwork/ui/Button.js';
import { Field, type AnswerKind } from '@mistriwork/ui/Field.js';
import { InputSlot, builtInInputId } from '@mistriwork/kit/client/components/inputRenderers.js';
import { appWord } from '@mistriwork/kit/client/messages.js';
import { say } from '../copy/forms/components/CommandFields.js';
import { ChoiceRadios } from './ChoiceRadios.js';
import type { DefinedField } from '@mistriwork/engine/shared/definedFields.js';
import type { HeldTarget } from './HeldFiles.js';
import { forgetHeldFile } from '../heldFileNames.js';

/** A form's values while it is filled in: one per field, an object per group, rows per repeating group, a grid's lines. */
export type CommandValues = { [name: string]: CommandValue | CommandValues | CommandValues[] | LineDraft[] | undefined };

export type ValueField = Exclude<AppCommandField, { type: 'group' | 'lines' }>;
type GroupField = Extract<AppCommandField, { type: 'group' }>;
export type ReferenceField = Extract<AppCommandField, { type: 'reference' }>;

/** Each `field.defined` input's questions, by input name, as prepare read them. */
export type CommandQuestions = Readonly<Record<string, readonly DefinedField[]>>;

/* A date and a time: its zone arithmetic is fetched the first time one is drawn, never by a public form's first page. */
const DateTimeInput = onDemand(() => import('./DateTimeInput.js'), 'DateTimeInput', { quiet: true });
/* The newer vocabulary — money, a month, a mask, a sensitive number, cards, buttons, several choices, a slider, a
   consent's statement — with the form controls' stylesheet: fetched the first time a form asks one. */
const IntakeControl = onDemand(() => import('./IntakeControls.js'), 'IntakeControl', { quiet: true });
export const CommandLive = onDemand(() => import('./CommandLive.js'), 'CommandLive', { quiet: true });
/* The draft's logic — a `when` over the answers so far and the command's `rules`, judged by the condition compiler
   and the query language's comparisons (commandDraft.ts, formValues.ts) — fetched the first time a form asks it, so
   a public page whose form asks none (the landing, sign-in, a one-page form) carries none of it. A host that knows
   its form asks it has it here before drawing (FormSurface's formArrives, CommandForm's prepare); CommandFields
   draws nothing until it is, rather than questions that would vanish as it lands. Before it is here, nothing is
   hidden and no rule is said, which the server judges again in any case. */
let drafting: typeof import('../../shared/commandDraft.js') | undefined;
let draftArriving: Promise<void> | undefined;
const loadDraftLogic = (): Promise<void> =>
  (draftArriving ??= import('../../shared/commandDraft.js').then(
    (module) => {
      drafting = module;
    },
    (error: unknown) => {
      draftArriving = undefined;
      throw error;
    },
  ));
export const draftLogic = {
  ready: () => loadDraftLogic().catch(() => {}),
  here: () => drafting !== undefined,
};
/** Whether a form's fields — or the command's rules — ask the draft's logic: a `when` anywhere, or a rule. */
export function asksDraftLogic(fields: readonly AppCommandField[], rules?: readonly unknown[]): boolean {
  if (rules?.length) return true;
  return fields.some((field) => whenOf(field) !== undefined || (field.type === 'group' && asksDraftLogic(field.fields)));
}
/** Whether a condition reads the record (`record.<path>`) or the tenant (`tenant.<column>`), which prepare judges:
 * exact once the logic is here, a plain reading before. */
const readsRecord = (when: string): boolean => (drafting ? drafting.readsRecord(when) : /(?<![\w.])(?:record|tenant)\./.test(when));

/* The fields a prepared form is asked. A `when` that reads the record or the tenant waits for prepare: left out where
   that part never holds, a plain field where it always does, and otherwise the draft's part prepare left to judge as
   it is typed. A `when` over the draft alone is the form's own to judge (commandDraft.ts). The browser is told only
   these truths, never the values behind them. */
export function askedFields(
  input: readonly AppCommandField[],
  prepared: { withheld?: string[]; when?: Record<string, string> } | undefined,
): readonly AppCommandField[] {
  if (!input.some((field) => field.type !== 'group' && field.type !== 'lines' && field.when !== undefined && readsRecord(field.when)))
    return input;
  return input.flatMap((field): AppCommandField[] => {
    if (field.type === 'group' || field.type === 'lines' || field.when === undefined || !readsRecord(field.when)) return [field];
    if (!prepared || prepared.withheld?.includes(field.name)) return [];
    const { when: _when, ...plain } = field;
    const left = prepared.when?.[field.name];
    return [(left === undefined ? plain : { ...plain, when: left }) as AppCommandField];
  });
}
/* A record's lines: the grid, with the catalog's cells and the words for a cell, fetched the first time a form asks
   lines. A public form cannot ask them, so its first page carries none of it. The cells are judged here by kind once it
   has arrived, which it has by the time a grid is drawn; before then, and in any case, the server reads them again. */
let lining: typeof import('./CommandLines.js') | undefined;
/** The lines module, fetched once: the grid is drawn from it, and a form's checks read a line's cells with it. */
export const loadLines = () =>
  import('./CommandLines.js').then((module) => {
    lining = module;
    return module;
  });
const CommandLines = onDemand(loadLines, 'CommandLines');

const asksLines = (fields: readonly AppCommandField[]): boolean =>
  fields.some((field) => field.type === 'lines' || (field.type === 'group' && asksLines(field.fields)));
/**
 * What judging an input with no form drawn needs first: the draft's logic where a `when` or a rule asks it, and the
 * lines module where a field is a grid. A component's run judges an input before any form is drawn, and before these
 * have landed nothing is hidden: a question its condition hides was asked for, and its default sent (a field report).
 */
export function readyToJudge(fields: readonly AppCommandField[], rules?: readonly unknown[]): Promise<unknown> | undefined {
  const logic = asksDraftLogic(fields, rules) && !draftLogic.here();
  const lines = asksLines(fields) && !lining;
  // Nothing to wait for is no wait at all: a run that asks neither sends in the turn it was asked (its prepare first).
  if (!logic && !lines) return undefined;
  return Promise.all([logic ? draftLogic.ready() : undefined, lines ? loadLines().catch(() => {}) : undefined]);
}
const lineAt = (fields: readonly AppCommandField[], path: string) => lining?.lineAt(fields, path);
/* A typed amount is judged in the App's currency (a field's own `currency` first) and kept as typed, in its major units:
   the server reads it into the minor ones a handler receives. */
const cellReading = () => ({ currency: defaultCurrency(), wire: true, ...(lining ? { cell: lining.lineCellOf } : {}) });

/* A grid line's own name, kept across moves (FormLines' blankLine, without loading the grid to make one). */
let lastLine = 0;
const draftLine = (values: Record<string, string> = {}): LineDraft => ({ id: -++lastLine, values });
const isLines = (value: unknown): value is LineDraft[] =>
  Array.isArray(value) && value.every((row) => !!row && typeof row === 'object' && 'values' in row && 'id' in row);

/* A reference's picker (CommandReference.tsx) is drawn where there is somewhere to read its choices: a signed-in
   reader's connection, or a public form's App read signed out. Loaded when drawn, so a public form without one carries
   neither it nor the combobox. */
const CommandReferenceField = onDemand(() => import('./CommandReference.js'), 'CommandReferenceField', { quiet: true });

/* Files and a signature, each held for the command as it is sent (HeldFiles.tsx): the drop area and the pad are
   fetched the first time a form asks one, so no first page carries either. */
const HeldInput = onDemand(() => import('./HeldFiles.js'), 'HeldInput', { quiet: true });

/* Questions defined in rows, drawn and judged (CommandAnswers.tsx): only a signed-in record's command asks them, so a
   first page carries none of it. The answers are judged here once it has arrived, which it has by the time they are
   drawn; the server judges them again in any case. */
let answering: typeof import('./CommandAnswers.js') | undefined;
const DefinedAnswers = onDemand(
  () =>
    import('./CommandAnswers.js').then((module) => {
      answering = module;
      return module;
    }),
  'DefinedAnswers',
  { quiet: true },
);
const answerProblems = (fields: readonly AppCommandField[], values: CommandValues, questions?: CommandQuestions): [string, string][] =>
  questions && answering ? answering.answerProblems(fields, values, questions) : [];

/** A choice with this many options or fewer is radios, all of them in view; more is a listbox. */
const RADIO_CHOICES = 4;
/** Whether a choice is radios: as many as RADIO_CHOICES unless the field says `as: 'radios'` or `as: 'select'`. */
const asRadios = (field: { options: readonly unknown[]; as?: string }) =>
  field.as === 'radios' || (field.as !== 'select' && field.options.length <= RADIO_CHOICES);

/* Which fields IntakeControls draws: said here too, so knowing it never fetches the chunk (IntakeControls' drawnHere agrees). */
function drawnByIntake(field: AppCommandField): boolean {
  switch (field.type) {
    case 'money':
    case 'month':
    case 'choices':
      return true;
    case 'number':
      return field.as === 'slider';
    case 'text':
      return field.mask !== undefined || field.sensitive !== undefined;
    case 'boolean':
      return field.as === 'buttons' || field.statement !== undefined;
    case 'choice':
      return field.as === 'cards' || field.as === 'buttons' || field.source !== undefined;
    default:
      return false;
  }
}

/* A yes-or-no drawn as a box: unticked is its no. One asked as two buttons is a question like any other, unanswered
   until pressed, so it is required unless optional and says "(optional)" when it is. */
const isCheck = (field: AppCommandField): field is Extract<AppCommandField, { type: 'boolean' }> =>
  field.type === 'boolean' && field.as !== 'buttons';

const isValues = (value: unknown): value is CommandValues => !!value && typeof value === 'object' && !Array.isArray(value);

/** Where a form starts: yes/no unticked, each group its own values, each repeating group its minimum rows. */
export function blankCommandValues(fields: readonly AppCommandField[]): CommandValues {
  const values: CommandValues = {};
  for (const field of fields) {
    /* A field's own default, as the form opens: a literal, the day in the App's time zone, the minute. The record's
       value and the reader's arrive with prepare, as `initial()`'s do. */
    const start = field.type === 'group' ? undefined : field.default;
    if (start !== undefined && typeof start !== 'object') values[field.name] = start;
    else if (typeof start === 'object' && 'auto' in start && start.auto !== 'me')
      values[field.name] =
        start.auto === 'today'
          ? new Intl.DateTimeFormat('en-CA', { timeZone: formatTimezone() }).format(appNow())
          : new Date(Math.floor(appNow().getTime() / 60_000) * 60_000).toISOString();
    // A box unticked is an answer, no; a yes or a no asked as two buttons is unanswered until one is pressed, so a
    // question that waits on its no (`when: 'entry_ok = false'`) waits for it, and a required one is asked.
    else if (field.type === 'boolean' && field.as !== 'buttons') values[field.name] = false;
    else if (field.type === 'lines') values[field.name] = Array.from({ length: Math.max(field.min ?? 0, 1) }, () => draftLine());
    else if (field.type === 'group') {
      values[field.name] = field.repeat
        ? Array.from({ length: field.repeat.min ?? 0 }, () => blankCommandValues(field.fields))
        : blankCommandValues(field.fields);
    }
  }
  return values;
}

/** The blank form with the starting values the server served laid over it, field by field. */
export function prefilledCommandValues(fields: readonly AppCommandField[], initial: unknown): CommandValues {
  const values = blankCommandValues(fields);
  if (!isValues(initial)) return values;
  for (const field of fields) {
    if (!Object.hasOwn(initial, field.name)) continue;
    const value = initial[field.name];
    // A held file is sent from this page, never named by an address or a prepare: its id is its sender's alone.
    if (field.type === 'files' || field.type === 'signature') continue;
    if (field.type === 'defined') {
      if (isValues(value)) values[field.name] = { ...value };
    } else if (field.type === 'lines') {
      if (Array.isArray(value))
        values[field.name] = value.map((row) =>
          draftLine(
            Object.fromEntries(
              field.show.flatMap((column) => {
                const held = isValues(row) ? row[column] : undefined;
                return typeof held === 'string' || typeof held === 'number' || typeof held === 'boolean' ? [[column, String(held)]] : [];
              }),
            ),
          ),
        );
    } else if (field.type !== 'group') {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') values[field.name] = value;
    } else if (field.repeat) {
      if (Array.isArray(value)) values[field.name] = value.map((row) => prefilledCommandValues(field.fields, row));
    } else values[field.name] = prefilledCommandValues(field.fields, value);
  }
  return values;
}

/** The whole form a list of fields belongs to — a step's fields judge their `when` against every answer so far. */
interface CommandDraft {
  fields: readonly AppCommandField[];
  values: CommandValues;
}

/* A field's condition, where its kind takes one (a grid's lines take none). */
const whenOf = (field: AppCommandField): string | undefined => ('when' in field ? (field.when as string | undefined) : undefined);

/* A value as it is read, for a condition: a number typed as text is the number. */
function readValue(field: AppCommandField, value: Entry): unknown {
  if ((field.type === 'number' || field.type === 'money') && typeof value === 'string') return value.trim() ? Number(value) : '';
  return value;
}

/**
 * The fields of a list a draft's conditions hide (`when: 'entry_ok = false'`): each judged by the shared evaluator
 * (commandDraft.ts) against the answers so far, of the whole form where one is given. A `when` that still reads the
 * record has not been bound by prepare, so it is the server's to judge, and the field stays.
 */
export function draftHidden(fields: readonly AppCommandField[], values: CommandValues, whole?: CommandDraft): Set<string> {
  const hidden = new Set<string>();
  if (!fields.some((field) => whenOf(field) !== undefined)) return hidden;
  const all = whole ?? { fields, values };
  const read: Record<string, unknown> = {};
  for (const field of all.fields) read[field.name] = readValue(field, all.values[field.name]);
  for (const field of fields) read[field.name] = readValue(field, values[field.name]);
  const known = [...all.fields, ...fields.filter((field) => !all.fields.includes(field))];
  for (const field of fields) {
    const when = whenOf(field);
    if (when === undefined || readsRecord(when)) continue;
    if (drafting && !drafting.draftHolds(when, read, known)) hidden.add(field.name);
  }
  return hidden;
}

/**
 * The input a refusal named (`field`, by its path), said beside it for a component that draws its own fields: only one
 * the command declares and the values sent leave shown, so the server's words are never placed on a field the
 * component does not draw, nor on a name it made up. What no field can hold stays in the refusal's message.
 */
export function refusedFields(
  path: string | undefined,
  message: string,
  fields: readonly AppCommandField[],
  values: CommandValues,
): Readonly<Record<string, string>> | undefined {
  const name = path && /^[^.[]+/.exec(path)?.[0];
  if (!name || !fields.some((field) => field.name === name) || draftHidden(fields, values).has(name)) return undefined;
  return { [path]: message };
}

/** What is sent: a number typed as text read as a number, and nothing the declaration does not ask, nor a question its condition hides. */
function submitted(fields: readonly AppCommandField[], values: CommandValues, whole?: CommandDraft): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const hidden = draftHidden(fields, values, whole);
  for (const field of fields) {
    if (hidden.has(field.name)) continue;
    const value = values[field.name];
    if (field.type === 'lines') {
      // Only what a line asks is sent: a copied column is the form's to show, and the handler reads that record itself.
      result[field.name] = (isLines(value) ? value : []).map((row) =>
        Object.fromEntries(field.show.flatMap((column) => (row.values[column] ? [[column, row.values[column]]] : []))),
      );
    } else if (field.type === 'group') {
      result[field.name] = field.repeat
        ? (Array.isArray(value) ? value : []).map((row) => submitted(field.fields, isValues(row) ? row : {}))
        : submitted(field.fields, isValues(value) ? value : {});
    } else if ((field.type === 'number' || field.type === 'money') && typeof value === 'string' && !(field.type === 'money' && field.minor))
      result[field.name] = value.trim() ? Number(value) : '';
    else if (value !== undefined) result[field.name] = value;
  }
  return result;
}

const FORMAT_SENTENCES = { email: say('anEmailAddress'), url: say('aWebAddressStarting'), phone: say('aPhoneNumber') } as const;
/** A time's bound and a sibling time are said as a date's are: before, after, on or after. */
const dated = (type: string) => type === 'date' || type === 'datetime' || type === 'time';

/** A field's sentence for what is wrong with it: its own label, and the rule it did not meet; a sibling rule names the sibling. */
function sentence(fields: readonly AppCommandField[], path: string, reason: CommandInputReason): string {
  const line = lineAt(fields, path);
  if (line) {
    const label = line.label;
    return reason === 'required'
      ? say('isRequired', { label })
      : reason === 'choice'
        ? say('chooseLabel', { label })
        : reason === 'type'
          ? say('isNotInAForm', { label })
          : say('theFormHasAnInput');
  }
  const field = commandFieldAt(fields, path);
  if (!field) return say('theFormHasAnInput');
  const label = field.label;
  const date = dated(field.type);
  // A moment's bound is said in the App's time zone, as the field asks for it.
  const bound = (at: string | undefined) =>
    at && field.type === 'datetime'
      ? new Date(at).toLocaleString(formatLocale(), { timeZone: formatTimezone(), dateStyle: 'medium', timeStyle: 'short' })
      : (at ?? '');
  const text = field.type === 'text' || field.type === 'textarea' ? field : undefined;
  const most = text?.maxLength ?? (field.type === 'richText' ? field.maxLength : undefined);
  const sibling = (name: string | undefined) => {
    const within = path.includes('.') ? path.slice(0, path.lastIndexOf('.') + 1) : '';
    return (name && commandFieldAt(fields, `${within}${name}`)?.label) ?? name ?? '';
  };
  switch (reason) {
    // A box that must be checked is said at the box, which the reader is looking at.
    case 'required':
      return isCheck(field) ? say('checkThisBoxTo') : say('isRequired', { label });
    case 'too_short':
      return say('mustBeAtLeast', { label, minLength: text?.minLength ?? (field.type === 'richText' ? field.minLength : undefined) ?? '' });
    case 'too_long':
      return say('mustBeCharactersOrFewer', { label, maxLength: most ?? '' });
    case 'format':
      return (
        text?.message ??
        say('must', {
          label,
          value: text?.format ? FORMAT_SENTENCES[text.format] : text?.as === 'color' ? say('aColor') : say('inTheFormItTakes'),
        })
      );
    case 'pattern':
      return text?.message ?? say('isNotInTheForm', { label });
    case 'not_below': {
      const other = sibling((field as { below?: string }).below);
      return date ? say('mustBeBefore', { label, other }) : say('mustBeLessThan', { label, other });
    }
    case 'not_above': {
      const other = sibling((field as { above?: string }).above);
      return date ? say('mustBeAfter', { label, other }) : say('mustBeMoreThan', { label, other });
    }
    case 'text':
      return say('hasCharactersAForm', { label });
    case 'integer':
      return say('mustBeASafe', { label });
    case 'precision':
      return say('hasMoreDecimalsThanTheCurrency', { label });
    case 'below_min':
      return date
        ? say('mustBeOnOrAfter', { label, min: bound((field as { min?: string }).min) })
        : say('labelMustBeAt', { label, min: (field as { min?: number }).min ?? '' });
    case 'above_max':
      return date
        ? say('mustBeOnOrBefore', { label, max: bound((field as { max?: string }).max) })
        : say('mustBeAtMost', { label, max: (field as { max?: number }).max ?? '' });
    case 'choice':
      return say('chooseLabel', { label });
    case 'too_few': {
      if (field.type === 'files') return say('needsAtLeastFiles', { label, count: field.min ?? 1 });
      const min = field.type === 'group' ? (field.repeat?.min ?? 0) : field.type === 'lines' ? (field.min ?? 0) : 0;
      return say('needsAtLeastRows', { label, count: min });
    }
    case 'too_many':
      if (field.type === 'files') return say('takesAtMostFiles', { label, count: field.max });
      return say('takesAtMostRows', {
        label,
        max: (field.type === 'group' ? field.repeat?.max : field.type === 'lines' ? field.max : 0) ?? '',
      });
    case 'type':
      return field.type === 'number'
        ? say('mustBeANumber', { label })
        : field.type === 'boolean'
          ? say('mustBeYes', { label })
          : date
            ? say(field.type === 'datetime' ? 'mustBeADateAndTime' : field.type === 'time' ? 'mustBeATime' : 'mustBeADate', { label })
            : field.type === 'reference'
              ? say('chooseLabel', { label })
              : say('isNotInAForm', { label });
    case 'shape':
      return say('isNotInAForm', { label });
    case 'exclusive':
      return say('chooseAlone', { label });
  }
}

/**
 * The words for where a path is: `Phone`, or `Applicant, Email`, or
 * `Trade-ins, row 2, Stock`. Undefined for a path the declaration does not have.
 */
export function commandPathLabel(fields: readonly AppCommandField[], path: string): string | undefined {
  const words: string[] = [];
  let list: readonly AppCommandField[] = fields;
  for (const part of path.split('.')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?$/.exec(part);
    const field = match && list.find((item) => item.name === match[1]);
    if (!field) return undefined;
    words.push(field.label);
    if (match[2] !== undefined) words.push(say('rowMatch', { match: Number(match[2]) + 1 }));
    if (field.type === 'lines') {
      // A line's cell is a column of its row: the rest of the path is the column, said by its caption.
      const line = lineAt(fields, path);
      if (line && match[2] !== undefined) words.push(line.label);
      return line || !path.includes('.') ? words.join(', ') : undefined;
    }
    list = field.type === 'group' ? field.fields : [];
  }
  return words.join(', ');
}

/** How a list of fields is judged beyond itself: the whole form its `when`s read, and the command's rules. */
interface CommandJudging {
  whole?: CommandDraft;
  /** The command's rules (`rules`); each is said at its field where that field is in the list judged. */
  rules?: readonly DraftRule[];
}

/* A question its condition shows is required there, as the server judges it (judgeDraft); then each rule the
   answers break, at its field. Both by path, in the reader's words. */
function draftProblems(fields: readonly AppCommandField[], values: CommandValues, judging: CommandJudging): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const hidden = draftHidden(fields, values, judging.whole);
  for (const field of fields) {
    const when = whenOf(field);
    if (when === undefined || hidden.has(field.name) || readsRecord(when) || field.type === 'group' || field.type === 'lines') continue;
    const value = values[field.name];
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
    if (isCheck(field) ? field.accept === true && value !== true : field.required && empty)
      found.push([field.name, sentence(fields, field.name, 'required')]);
  }
  if (judging.rules?.length && drafting) {
    const all = judging.whole ?? { fields, values };
    const read = { ...submitted(all.fields, all.values), ...submitted(fields, values, judging.whole) };
    const names = new Set(fields.map((field) => field.name));
    for (const broken of drafting.brokenRules(judging.rules, read, [...all.fields, ...fields.filter((f) => !all.fields.includes(f))]))
      if (names.has(broken.field)) found.push([broken.field, broken.message]);
  }
  return found;
}

/** Every problem, by path, in the person's words: what a form marks beside each field. */
export function commandProblems(
  fields: readonly AppCommandField[],
  values: CommandValues,
  questions?: CommandQuestions,
  judging: CommandJudging = {},
): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const problem of commandInputProblems(fields, submitted(fields, values, judging.whole), cellReading())) {
    if (!Object.hasOwn(problems, problem.path)) problems[problem.path] = sentence(fields, problem.path, problem.reason);
  }
  for (const [path, said] of answerProblems(fields, values, questions)) if (!Object.hasOwn(problems, path)) problems[path] = said;
  for (const [path, said] of draftProblems(fields, values, judging)) if (!Object.hasOwn(problems, path)) problems[path] = said;
  return problems;
}

/** The input to send, parsed as the server will parse it, or an Error saying the first thing that needs attention. */
export function commandInput(
  fields: readonly AppCommandField[],
  values: CommandValues,
  questions?: CommandQuestions,
  judging: CommandJudging = {},
): Record<string, unknown> {
  let input: Record<string, unknown>;
  try {
    input = readCommandInput(fields, submitted(fields, values, judging.whole), cellReading());
  } catch (error) {
    if (!(error instanceof CommandInputRefusal)) throw error;
    const said = sentence(fields, error.path, error.reason);
    // A field inside a group says which section, and which row.
    const within = error.path.includes('.') ? commandPathLabel(fields, error.path.slice(0, error.path.lastIndexOf('.'))) : undefined;
    throw new Error(within ? `${within}: ${said}` : said);
  }
  const [unanswered] = answerProblems(fields, values, questions);
  if (unanswered) {
    const field = fields.find((candidate) => candidate.name === unanswered[0].slice(0, unanswered[0].indexOf('.')));
    throw new Error(field ? `${field.label}: ${unanswered[1]}` : unanswered[1]);
  }
  const [drafted] = draftProblems(fields, values, judging);
  if (drafted) throw new Error(drafted[1]);
  return input;
}

/**
 * One value input as a control: text, textarea, number, yes/no, date, date
 * and time, or choice. The command modal and a command form both draw
 * through this; a reference is the picker below instead, and only where
 * there is a connection to read its directory from.
 */
export function CommandFieldControl({
  field,
  id,
  describedBy,
  invalid,
  value,
  disabled,
  onChange,
  connection,
  visitor,
  record,
  valid,
  onLeave,
  answers,
}: {
  field: Exclude<ValueField, { type: 'reference' | 'defined' }>;
  /** The form's answers so far: a choice narrowed by the others (`where`) reads them. */
  answers?: CommandValues;
  /** The intake style's valid check on a text or number box: present, the box keeps room for the mark; true draws it. */
  valid?: boolean;
  /** Focus has left the control: where the valid check is kept, it is judged from then on. */
  onLeave?: () => void;
  /** A public form's App, read signed out: where a choice from a table reads its rows. */
  visitor?: CommandFieldsShared['visitor'];
  /** Where a rich text input reads its people and keeps its pictures. */
  connection?: string;
  record?: CommandFieldsShared['record'];
  id: string;
  describedBy?: string;
  /** A problem is said beside the field; the field says it holds one, so a reader landing on it hears which. */
  invalid?: boolean;
  value: CommandValue | undefined;
  disabled?: boolean;
  onChange: (value: CommandValue) => void;
}) {
  const common = {
    id,
    'aria-describedby': describedBy,
    'aria-invalid': invalid || undefined,
    required: field.required,
    className: 'field-control',
    disabled,
    ...(onLeave ? { onBlur: onLeave } : {}),
  };
  /* The mark at a box's inline end, in room the box keeps from the start, so its arriving moves no text. Decorative:
     validity is aria-invalid's to say (TextField's ValidMark, drawn in CSS). */
  const marked = (box: ReactElement, leaves = false) =>
    valid === undefined ? (
      box
    ) : (
      // A control drawn on demand takes no onBlur of its own; the box hears its input leave (focusout bubbles).
      <div className="field-box has-mark" {...(leaves && onLeave ? { onBlur: onLeave } : {})}>
        {box}
        {valid ? <span className="field-mark" aria-hidden="true" /> : null}
      </div>
    );
  if (drawnByIntake(field)) {
    return marked(
      <IntakeControl
        field={field}
        id={id}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        value={value}
        disabled={disabled}
        onChange={onChange}
        {...(connection !== undefined ? { source: connection } : visitor ? { source: { visitor } } : {})}
        {...(answers && (field.type === 'choice' || field.type === 'choices') && field.source?.match ? { answers } : {})}
      />,
      true,
    );
  }
  if (field.type === 'boolean') {
    return (
      <input
        {...common}
        required={field.accept === true}
        className="command-check"
        type="checkbox"
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  }
  /* Formatted text: the editor, fetched the first time one is drawn; the server sanitizes what it sends. */
  if (field.type === 'richText') {
    return (
      <RichTextField
        id={id}
        label={field.label}
        describedBy={describedBy}
        invalid={invalid}
        disabled={disabled}
        value={typeof value === 'string' ? value : ''}
        onChange={onChange}
        {...(field.mentions && connection !== undefined ? { mentions: mentionSearch(field.mentions, connection) } : {})}
        {...(field.images && connection !== undefined && record
          ? (() => {
              const keep = pictureKeeper(field.images, record, connection);
              return keep ? { pictures: keep, onProblem: (message: string) => toast(message, 'error') } : {};
            })()
          : {})}
      />
    );
  }
  if (field.type === 'textarea') {
    return (
      <textarea
        {...common}
        rows={3}
        maxLength={field.maxLength}
        placeholder={field.placeholder}
        value={String(value ?? '')}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  if (field.type === 'choice') {
    const chosen = field.options.findIndex((option) => option.value === value);
    if (asRadios(field)) {
      return (
        <ChoiceRadios
          id={id}
          options={field.options}
          value={value}
          describedBy={describedBy}
          required={field.required}
          invalid={invalid}
          disabled={disabled}
          onChange={onChange}
        />
      );
    }
    // The tool's listbox, by position: a value may be a number, and a listbox's values are text.
    return (
      <Dropdown
        /* Named by the field's caption, as a <label> names a textbox: the words a reader
           sees, "(required)" with them. An aria-label of the bare name dropped it. */
        id={id}
        ariaLabelledBy={`${id}-label`}
        ariaInvalid={invalid}
        ariaDescribedBy={describedBy}
        disabled={disabled}
        value={chosen < 0 ? '' : String(chosen)}
        valueClassName={chosen < 0 ? 'is-empty' : undefined}
        items={[
          ...(chosen < 0
            ? [
                {
                  value: '',
                  label: readsAsName(field.label) ? say('choosePlaceholder', { label: field.label.toLowerCase() }) : say('chooseOne'),
                },
              ]
            : []),
          ...field.options.map((option, index) => ({ value: String(index), label: option.label })),
        ]}
        onChange={(next) => {
          if (next !== '') onChange(field.options[Number(next)].value);
        }}
      />
    );
  }
  if (field.type === 'date') {
    return (
      <DateField
        {...common}
        aria-label={`${field.label}${field.required ? ' (required)' : ''}`}
        min={field.min}
        max={field.max}
        locale={formatLocale()}
        timezone={formatTimezone()}
        now={appNow()}
        value={String(value ?? '')}
        onChange={onChange}
      />
    );
  }
  if (field.type === 'datetime') {
    return (
      <DateTimeInput
        {...common}
        aria-label={`${field.label}${field.required ? ' (required)' : ''}`}
        min={field.min}
        max={field.max}
        value={typeof value === 'string' ? value : ''}
        onChange={onChange}
      />
    );
  }
  /* A time of day in the browser's own picker, as a column's time format is edited: the value is what it writes, HH:MM. */
  if (field.type === 'time') {
    return (
      <input
        {...common}
        className="field-control time-input"
        type="time"
        min={field.min}
        max={field.max}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  if (field.type === 'number') {
    const whole = field.integer || (field.step !== undefined && Number.isInteger(field.step));
    return marked(
      <input
        {...common}
        type="number"
        min={field.min}
        max={field.max}
        step={field.step ?? (field.integer ? 1 : 'any')}
        inputMode={whole ? 'numeric' : 'decimal'}
        placeholder={field.placeholder}
        value={String(value ?? '')}
        onChange={(event) => onChange(event.target.value)}
      />,
    );
  }
  if (field.type !== 'text') return null;
  // The format picks the keyboard; the shared reader still judges the value.
  const type = field.format === 'email' ? 'email' : field.format === 'url' ? 'url' : field.format === 'phone' ? 'tel' : 'text';
  return marked(
    <input
      {...common}
      type={type}
      minLength={field.minLength}
      maxLength={field.maxLength}
      placeholder={field.placeholder}
      {...(field.case === 'upper' ? { autoCapitalize: 'characters' } : {})}
      value={String(value ?? '')}
      onChange={(event) => onChange(event.target.value)}
    />,
  );
}

/** The short answers a field can take: a count, an amount, a day, a day and its time, a time of day. */
const answerKind = (field: AppCommandField): AnswerKind | undefined =>
  field.type === 'number' || field.type === 'money' || field.type === 'date' || field.type === 'datetime' || field.type === 'time'
    ? field.type
    : undefined;

/* A box the valid check stands in: a text or number box, an amount, a text typed through its mask. A sensitive value
   keeps its show button there, and a slider and every chooser say their state their own way. */
const markable = (field: AppCommandField): boolean =>
  ((field.type === 'money' || field.type === 'number') && field.as !== 'slider' && field.as !== 'rating') ||
  (field.type === 'text' && field.sensitive === undefined && field.as !== 'color' && field.as !== 'scan');

/**
 * The platform's own input a field is asked with where its kind is drawn as a column's format is — stars, a code
 * the camera reads, a color — the same component a record's form draws (builtInInputs.tsx), fetched the first time
 * one is drawn; the plain box stands in until it is here, and the shared reader judges what either sends.
 */
export function builtInInputName(field: AppCommandField): 'rating' | 'scan' | 'color' | undefined {
  if (field.type === 'number' && field.as === 'rating') return 'rating';
  if (field.type === 'text' && (field.as === 'scan' || field.as === 'color')) return field.as;
  return undefined;
}

/* Whether an answer given is one its field's own rules take: its kind, its pattern, its bounds — judged alone, so a
   condition on another answer (`when`) does not hide it from the judging. */
function ownRulesTake(field: AppCommandField, value: CommandValue | undefined): boolean {
  if (value === undefined || value === null || value === '') return false;
  const { when: _when, ...own } = field as AppCommandField & { when?: string };
  return (
    commandInputProblems([own as AppCommandField], submitted([own as AppCommandField], { [field.name]: value }), cellReading()).length === 0
  );
}

export interface CommandFieldsShared {
  idPrefix: string;
  /** By path; each is drawn beside its field. Absent, the host says problems itself. */
  problems?: Readonly<Record<string, string>>;
  disabled?: boolean;
  /** Signed in: the connection a reference reads its choices from. Without one, or a visitor, a reference is not drawn. */
  connection?: string;
  /** A public form's: its App, read signed out, where a reference's choices are what `auth.public` opens. */
  visitor?: { app: string; via?: string };
  identityEpoch: number;
  isCurrent: () => boolean;
  /** Input name → the App's own input component (an action's or a form's `inputs`); one in a group by its path, `trade.vin`,
      which stands in every row of a repeating group. */
  inputs?: Readonly<Record<string, { id: string }>>;
  /** The record the command acts on, where it names one: a rich text input's pictures are kept as its attachments. */
  record?: { table: string; key: Record<string, unknown> };
  /** The query prepare bound to the record for each picker that reads it (`record.id`), by declared path; null
      when the record holds nothing to narrow by, and such a picker offers nothing. */
  bound?: Readonly<Record<string, string | null>>;
  /** The questions prepare read for each `field.defined` input; until it has, such an input draws nothing. */
  questions?: CommandQuestions;
  /** How the form around the fields is drawn: the intake style turns the valid check on, the stepper leaves it off. */
  presentation?: 'stepper' | 'intake';
  /** Where a files or signature input's files are held: the command's, or a public form's. Absent, none can be sent. */
  held?: HeldTarget;
}

type Entry = CommandValues[string];

/** The fields of one list — a command's, or a group's — each changing its own value in `values`. */
export function CommandFields({
  fields,
  values,
  onChange,
  whole,
  ...shared
}: CommandFieldsShared & {
  fields: readonly AppCommandField[];
  values: CommandValues;
  /** The whole form, where these are one step's fields: their conditions read every answer so far. */
  whole?: CommandDraft;
  /** The whole next values, and the path of the field that changed: a host clears that field's problem. */
  onChange: (values: CommandValues, path: string) => void;
}) {
  const logic = useArrived(draftLogic, asksDraftLogic(whole?.fields ?? fields));
  const hidden = draftHidden(fields, values, whole);
  if (!logic && asksDraftLogic(whole?.fields ?? fields)) return null;
  return (
    <>
      {fields
        .filter((field) => !hidden.has(field.name))
        .map((field) => {
          const entry = (
            <FieldEntry
              key={field.name}
              field={field}
              path={field.name}
              value={values[field.name]}
              answers={whole?.values ?? values}
              shared={shared}
              onChange={(next, path) => onChange({ ...values, [field.name]: next }, path)}
            />
          );
          // A number's live lines (`live`), under it, read over every answer so far.
          if ((field.type !== 'number' && field.type !== 'money') || !field.live) return entry;
          return (
            <Fragment key={field.name}>
              {entry}
              <CommandLive
                field={field}
                fields={whole?.fields ?? fields}
                values={whole?.values ?? values}
                id={`${shared.idPrefix}-live-${field.name}`}
              />
            </Fragment>
          );
        })}
    </>
  );
}

function FieldEntry({
  field,
  path,
  value,
  onChange,
  shared,
  answers,
}: {
  field: AppCommandField;
  path: string;
  value: Entry;
  /** The whole form's answers, where this is one of its own fields (a choice inside a group reads no `where`). */
  answers?: CommandValues;
  shared: CommandFieldsShared;
  onChange: (value: Entry, path: string) => void;
}) {
  // Under its own `-field-` namespace: the page names its heading, its done
  // and review sections as `${idPrefix}-title` and the like, so an input
  // called `title` must never land on one of those ids (it left the region
  // unnamed and the textbox without a label).
  const id = `${shared.idPrefix}-field-${path.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const problem = shared.problems?.[path];
  /* The intake style's valid check: judged once the box has been left, so it never cheers a half-typed answer. */
  const [left, setLeft] = useState(false);
  if (field.type === 'defined')
    return (
      <DefinedAnswers field={field} id={id} path={path} value={value} shared={shared} onChange={onChange} Control={CommandFieldControl} />
    );
  if (field.type === 'lines')
    return (
      <div className="command-lines">
        <CommandLines
          field={field}
          path={path}
          rows={isLines(value) ? value : []}
          problems={shared.problems}
          disabled={shared.disabled}
          onChange={(rows: LineDraft[], changed: string) => onChange(rows, changed)}
        />
        {shared.problems && (
          <span className="insert-missing" aria-live="polite" hidden={!problem}>
            {problem}
          </span>
        )}
      </div>
    );
  if (field.type === 'group') {
    const helpId = field.help ? `${id}-help` : undefined;
    const errorId = `${id}-error`;
    const describedBy = [helpId, problem ? errorId : undefined].filter(Boolean).join(' ') || undefined;
    return (
      <fieldset className={`command-group${field.repeat ? ' command-repeat' : ''}`} aria-describedby={describedBy}>
        <legend>{field.label}</legend>
        <div className="command-group-body">
          {field.help && (
            <span id={helpId} className="command-help">
              {field.help}
            </span>
          )}
          {field.repeat ? (
            <RepeatRows
              field={field}
              path={path}
              rows={Array.isArray(value) ? (value as CommandValues[]) : []}
              shared={shared}
              onChange={onChange}
            />
          ) : (
            <GroupFields field={field} path={path} values={isValues(value) ? value : {}} shared={shared} onChange={onChange} />
          )}
          {shared.problems && (
            <span id={errorId} className="insert-missing" aria-live="polite" hidden={!problem}>
              {problem}
            </span>
          )}
        </div>
      </fieldset>
    );
  }
  /* Several choices are the one list a value input holds; every other list or object is a group's or the grid's. */
  const scalar =
    field.type === 'choices'
      ? Array.isArray(value)
        ? (value as unknown as readonly (string | number)[])
        : undefined
      : isValues(value) || Array.isArray(value)
        ? undefined
        : (value as CommandValue | undefined);
  /* A yes-or-no is answered either way, so it is only "required" when it
     must be checked: a box that says required and takes no was a trap. */
  const needed = isCheck(field) ? field.accept === true : field.required;
  /* Required is said once to a sighted reader: the star (Field's `required`). The word stays in the label's text,
     hidden, so the control's name still carries it for a screen reader and a query by label. */
  const label = needed ? (
    <>
      {field.label}
      <span className="visually-hidden"> {appWord('mistri.form.required', say('requiredWord'))}</span>
    </>
  ) : (
    field.label
  );
  const radios = field.type === 'choice' && asRadios(field);
  const listbox = field.type === 'choice' && !radios;
  const held = field.type === 'files' || field.type === 'signature';
  /* One Field: the label over the control, the help and then the problem
     under it, wired into the control's description. Radios and a listbox's
     button are named by the caption rather than a <label>. */
  /* A checkbox is drawn with its label beside it, and the label checks it:
     the one control whose name reads as a sentence to agree to. An App's own
     input for it keeps the label above, as every other control has. */
  const declared = path.replace(/\[\d+\]/g, '');
  /* The form's own choice of component for this input first, then the field's (`input`, every form that asks it, a
     public one's too: its page loads the ones its payload says are served, sdk/publicInputs.ts). */
  const builtIn = builtInInputName(field);
  const custom =
    shared.inputs && Object.hasOwn(shared.inputs, declared)
      ? shared.inputs[declared]
      : 'input' in field && typeof field.input === 'string'
        ? { id: field.input }
        : builtIn
          ? { id: builtInInputId(builtIn) }
          : undefined;
  /* A consent beside its statement is drawn whole by its control, the box and the paragraph (IntakeControls): the label
     stays the box's name and the review's, read but not drawn, so it never stands as a narrow column beside them. */
  const stated = field.type === 'boolean' && field.statement !== undefined && !custom;
  const check = isCheck(field) && !custom && !stated;
  /* A yes or a no as two buttons is a question over its answers, named by its caption, as radios are. */
  const pair = field.type === 'boolean' && field.as === 'buttons' && !custom;
  /* A picker narrowed by the record reads the query prepare bound to it (the form opens once prepare answers). */
  const bound = shared.bound && Object.hasOwn(shared.bound, declared) ? shared.bound[declared] : undefined;
  /* A short answer is only as wide as it is long, and shares a row with the short answers beside it (forms.css, Field's
     `kind`). A slider, a rating or an App's own input draws its own width. */
  const answer = custom || ('as' in field && field.as !== undefined) ? undefined : answerKind(field);
  return (
    <Field
      label={label}
      required={needed === true}
      optional={isCheck(field) ? undefined : appWord('mistri.form.optional', say('optionalWord'))}
      id={id}
      hint={field.help}
      problem={problem}
      group={radios || listbox || pair || held}
      check={check}
      labelHidden={stated}
      kind={answer}
      className="command-field"
    >
      {(control) =>
        held ? (
          <HeldInput
            field={field}
            path={heldFilePath(path)}
            id={id}
            describedBy={control['aria-describedby']}
            labelledBy={control['aria-labelledby']}
            invalid={Boolean(problem)}
            disabled={shared.disabled === true}
            target={shared.held}
            value={value}
            onChange={(next: CommandValue | undefined) => onChange(next, path)}
          />
        ) : field.type === 'reference' ? (
          (shared.connection !== undefined || shared.visitor) && (
            <CommandReferenceField
              field={bound === undefined ? field : { ...field, query: bound ?? '' }}
              id={id}
              describedBy={control['aria-describedby']}
              invalid={Boolean(problem)}
              connection={shared.connection ?? { visitor: shared.visitor! }}
              identityEpoch={shared.identityEpoch}
              disabled={shared.disabled === true || bound === null}
              value={scalar}
              isCurrent={shared.isCurrent}
              onChange={(next) => onChange(next, path)}
            />
          )
        ) : (
          (() => {
            const marks = shared.presentation === 'intake' && markable(field);
            const platform = (
              <CommandFieldControl
                field={field}
                id={id}
                describedBy={control['aria-describedby']}
                invalid={Boolean(problem)}
                {...(marks
                  ? { valid: left && !problem && ownRulesTake(field, scalar as CommandValue | undefined), onLeave: () => setLeft(true) }
                  : {})}
                value={scalar}
                disabled={shared.disabled}
                onChange={(next) => onChange(next, path)}
                {...(shared.connection === undefined ? {} : { connection: shared.connection })}
                {...(shared.visitor ? { visitor: shared.visitor } : {})}
                {...(shared.record ? { record: shared.record } : {})}
                {...(answers ? { answers } : {})}
              />
            );
            /* The App's own input, where it names one for this input: the form still keeps, checks and sends the value. */
            return custom ? (
              <InputSlot
                component={custom.id}
                fallback={platform}
                value={Array.isArray(scalar) ? null : ((scalar as string | number | boolean | undefined) ?? null)}
                onChange={(next) => onChange(next as CommandValue, path)}
                id={id}
                describedBy={control['aria-describedby']}
                invalid={Boolean(problem)}
                disabled={shared.disabled === true}
                required={field.required === true}
                label={field.label}
                /* A built-in input reads its rule from the column it stands for; a command's field carries its own. */
                field={{ name: field.name, ...(field.type === 'number' && field.outOf ? { rule: { outOf: field.outOf } } : {}) }}
                context="command"
              />
            ) : (
              platform
            );
          })()
        )
      }
    </Field>
  );
}

function GroupFields({
  field,
  path,
  values,
  shared,
  onChange,
}: {
  field: GroupField;
  path: string;
  values: CommandValues;
  shared: CommandFieldsShared;
  onChange: (value: Entry, path: string) => void;
}) {
  const hidden = draftHidden(field.fields, values);
  return (
    <div className="command-fields">
      {field.fields
        .filter((member) => !hidden.has(member.name))
        .map((member) => (
          <FieldEntry
            key={member.name}
            field={member}
            path={`${path}.${member.name}`}
            value={values[member.name]}
            shared={shared}
            onChange={(next, changed) => onChange({ ...values, [member.name]: next }, changed)}
          />
        ))}
    </div>
  );
}

/** The held files' ids a group's value names, its rows' and inner groups' included. */
function heldIds(fields: readonly AppCommandField[], value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((row) => heldIds(fields, row));
  if (!value || typeof value !== 'object') return [];
  const values = value as Record<string, unknown>;
  return fields.flatMap((member) => {
    const held = values[member.name];
    if (member.type === 'group') return heldIds(member.fields, held);
    if (member.type === 'files') return Array.isArray(held) ? held.filter((id): id is string => typeof id === 'string') : [];
    return member.type === 'signature' && typeof held === 'string' ? [held] : [];
  });
}

/** A repeating group's rows, from its minimum to its maximum; each row is the group's fields again. */
function RepeatRows({
  field,
  path,
  rows,
  shared,
  onChange,
}: {
  field: GroupField;
  path: string;
  rows: CommandValues[];
  shared: CommandFieldsShared;
  onChange: (value: Entry, path: string) => void;
}) {
  // Rows are keyed by when they were added, not where they sit: removing one keeps the others' pickers and focus.
  const keys = useRef<number[]>([]);
  const next = useRef(0);
  while (keys.current.length < rows.length) keys.current.push(next.current++);
  if (keys.current.length > rows.length) keys.current.length = rows.length;
  const min = field.repeat?.min ?? 0,
    max = field.repeat?.max ?? 0;
  return (
    <>
      {rows.map((row, index) => (
        <div
          className="command-row"
          role="group"
          aria-label={say('groupRow', { label: field.label, index: index + 1 })}
          key={keys.current[index]}
        >
          <div className="command-row-head">
            <span className="command-row-number">
              {say('rowLabel')} {index + 1}
            </span>
            <Button
              intent="secondary"
              size="compact"
              disabled={shared.disabled || rows.length <= min}
              aria-label={say('removeRow', { index: index + 1, label: field.label })}
              onClick={() => {
                keys.current.splice(index, 1);
                // The row's held files leave with it: their ids are no longer in the input, and their previews are let go.
                for (const id of heldIds(field.fields, row)) forgetHeldFile(id);
                onChange(
                  rows.filter((_, other) => other !== index),
                  path,
                );
              }}
            >
              {say('common.remove')}
            </Button>
          </div>
          <GroupFields
            field={field}
            path={`${path}[${index}]`}
            values={row}
            shared={shared}
            onChange={(value, changed) =>
              onChange(
                rows.map((item, other) => (other === index ? (value as CommandValues) : item)),
                changed,
              )
            }
          />
        </div>
      ))}
      <div className="command-repeat-actions">
        <Button
          intent="secondary"
          disabled={shared.disabled || rows.length >= max}
          aria-label={say('addRowTo', { label: field.label })}
          onClick={() => onChange([...rows, blankCommandValues(field.fields)], path)}
        >
          {say('addRow')}
        </Button>
      </div>
    </>
  );
}
