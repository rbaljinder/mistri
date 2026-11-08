/**
 * One input of a command, bound for a component that draws its own control (`useField`), and the amount parse the
 * platform's money box reads with (`parseMoney`). Both read the declaration the platform's own form judges by, so a
 * custom control and the native one agree on what a value is before the server judges it again.
 */
import { useMemo, useState, useId } from 'react';
import { currencyDigits } from '@mistriwork/engine/shared/money.js';
import { majorToMinorText } from '@mistriwork/engine/shared/moneyEntry.js';
import { defaultCurrency, formatLocale } from '@mistriwork/kit/client/locale.js';
import { blankCommandValues, commandInput, commandProblems, type CommandValues } from '../CommandFields.js';
import { useCommandHandle, useViewer } from './hooks.js';
import type { UiCommandRef } from './context.js';
import type { AppCommandField } from '../../../shared/command.js';
import { say } from '../../copy/components/components/sdk/fields.js';

/** An amount as typed, read: whole minor units as text (exact past 2^53) and the major amount with a point, or why not. */
export type MoneyParse = { minor: string; major: string } | { problem: string };

/* The locale's own marks: its group and decimal separators, the currency's sign as it writes it. */
function marks(locale: string | undefined, currency: string): { group?: string; decimal: string; sign?: string } {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  const sign = new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(1).find((part) => part.type === 'currency');
  return {
    group: parts.find((part) => part.type === 'group')?.value,
    decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.',
    sign: sign?.value,
  };
}

/**
 * Text a person typed as an amount of `currency`, read as the platform's money box reads it: grouping and the
 * currency's sign dropped, the locale's decimal mark taken as the point, at most the currency's own decimal places
 * (19.999 dollars is a typo, never rounded), and a negative only where `negative` allows one, as a field allows one
 * only when its `min` is below zero. Text to text, never through a float, so an amount past 2^53 is exact.
 */
export function parseMoney(text: string, options: { currency: string; locale?: string; negative?: boolean }): MoneyParse {
  const { currency } = options;
  const { group, decimal, sign } = marks(options.locale ?? formatLocale(), currency);
  let typed = text.replace(/−/g, '-');
  for (const mark of [sign, currency]) if (mark) typed = typed.split(mark).join('');
  typed = typed.replace(/[\s  ]/g, '');
  if (group && group.trim()) typed = typed.split(group).join('');
  if (decimal !== '.') typed = typed.split(decimal).join('.');
  const shape = /^[-+]?(\d*)(?:\.(\d*))?$/.exec(typed);
  if (!shape || !(shape[1] || shape[2])) return { problem: say('enterAnAmount') };
  const digits = currencyDigits(currency);
  const minor = majorToMinorText(typed, currency);
  if (minor === undefined) return { problem: digits ? say('atMostDecimals', { digits }) : say('enterAWholeAmount') };
  if (minor.startsWith('-') && !options.negative) return { problem: say('zeroOrMore') };
  const below = minor.startsWith('-') ? '-' : '';
  const whole = minor.replace('-', '').padStart(digits + 1, '0');
  return { minor, major: digits ? `${below}${whole.slice(0, -digits)}.${whole.slice(-digits)}` : `${below}${whole}` };
}

/** What a control is handed, the `InputProps` an App's input component receives in a form (`ui.inputs`). */
interface UiFieldInputProps {
  value: string | number | boolean | null;
  onChange(value: string | number | boolean | null): void;
  id: string;
  describedBy?: string;
  invalid: boolean;
  disabled: boolean;
  required: boolean;
  label: string;
  field: { name: string; resource?: string };
  context: 'command';
}

/** One input of a command, bound (`useField`). */
export interface UiField {
  inputProps: UiFieldInputProps;
  /** What the control last handed back, as text. */
  text: string;
  /** The value as the platform's own form sends it (an amount as its major-unit text); null while there is none, or it is not one. */
  value: unknown;
  /** Whether the control has handed anything back. */
  touched: boolean;
  /** Whether the value is other than the one the field starts with. */
  dirty: boolean;
  /** What is wrong with it, in the person's words: said once `validate()` has run, and kept current from then on. */
  error: string | undefined;
  /** Judges it now and says what is wrong from here on; true when nothing is. */
  validate(): boolean;
}

const blank = (value: unknown) => value === undefined || value === null || value === '';
const same = (one: unknown, other: unknown) => (blank(one) && blank(other)) || Object.is(one, other);

/* A field for a command this reader is not served: drawn, disabled, and never judged. */
const unserved = (name: string): AppCommandField => ({ name, label: name, type: 'text' }) as AppCommandField;

/**
 * One input of a command, by name, for a control a component draws itself: `inputProps` is the contract an App's
 * input component receives in the platform's own form, and the value is judged by the same declaration — its kind,
 * `required`, bounds and format — so a custom control and the form agree. A money input reads what is typed with
 * `parseMoney` in the App's locale and the field's currency. Nothing is sent: the component hands `value` to
 * `useCommand(...).run`, where the server judges it again, and names a refusal's field from the outcome's `fields`.
 */
export function useField(command: UiCommandRef, name: string): UiField {
  const viewer = useViewer();
  const handle = useCommandHandle(command, viewer);
  const declared = handle.input?.(name);
  if (!declared && handle.granted) throw new Error(say('notAnInput', { command, name }));
  const field = declared ?? unserved(name);
  /* Only a reader who may run it is told what is wrong: for anyone else the control is a disabled picture of the field. */
  const served = handle.granted && declared;
  const start = useMemo(() => blankCommandValues([field])[name] ?? null, [field, name]);
  const [given, setGiven] = useState<string | number | boolean | null>(start as string | number | boolean | null);
  const [touched, setTouched] = useState(false);
  const [shown, setShown] = useState(false);
  const id = useId();
  /* What the form would hold: a typed amount read in the locale, so the declaration judges the figure, not the marks. */
  const money =
    field.type === 'money' && typeof given === 'string' && given.trim()
      ? parseMoney(given, { currency: field.currency ?? defaultCurrency(), negative: (field.min ?? 0) < 0 })
      : undefined;
  const held = money && 'major' in money ? money.major : given;
  const holding: CommandValues = { [name]: held ?? undefined };
  const problem = served
    ? ((money && 'problem' in money ? money.problem : undefined) ?? commandProblems([field], holding)[name])
    : undefined;
  let value: unknown = null;
  if (served && !problem) {
    try {
      value = commandInput([field], holding)[name] ?? null;
    } catch {
      value = null;
    }
  }
  const error = shown ? problem : undefined;
  return {
    inputProps: {
      value: given,
      onChange: (next) => {
        setGiven(next);
        setTouched(true);
      },
      id,
      describedBy: error ? `${id}-error` : undefined,
      invalid: Boolean(error),
      disabled: !handle.granted,
      required: Boolean(field.required),
      label: field.label,
      field: { name, ...(handle.resource ? { resource: handle.resource } : {}) },
      context: 'command',
    },
    text: given === null ? '' : String(given),
    value,
    touched,
    dirty: !same(held, start),
    error,
    validate: () => {
      setShown(true);
      return !problem;
    },
  };
}
