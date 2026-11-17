/**
 * The controls of the newer field vocabulary, drawn: an amount of money, a month, a text typed through its mask, a
 * sensitive number kept out of sight, a choice as cards or buttons, several choices, a yes-or-no as two buttons, a
 * consent beside its statement, and a number on a slider. A chunk of its own (CommandFields.tsx), fetched the first
 * time a form asks one, with the form controls' stylesheet: a form of plain boxes carries none of it.
 *
 * Each draws the control alone; the Field around it (CommandFields.tsx) is the label, the help and the problem. The
 * value each hands back is the one the shared reader (commandInput.ts) reads: an amount and a slider's number as
 * typed text or a number, a month as `YYYY-MM`, a masked text as the characters its places hold, choices as a list of
 * option values. A sensitive value lives in the form's state alone: nothing here keeps, logs or prefills it.
 */
import { useEffect, useState, type AriaAttributes, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dropdown, readsAsName } from '@mistriwork/kit/client/components/Dropdown.js';
import { Button } from '@mistriwork/ui/Button.js';
import { CheckCards } from '@mistriwork/ui/Choices.js';
import { run, type ChoiceSource } from './CommandReference.js';
import '@mistriwork/kit/client/formControls.css';
import './IntakeControls.css';
import {
  boundChoiceMatch,
  choiceAnswers,
  choiceLabelColumn,
  choiceMatchText,
  choiceOptions,
  choiceRowHolds,
  type AppCommandField,
} from '../../shared/command.js';
import type { CommandValue } from '../commandState.js';
import { defaultCurrency, formatLocale } from '@mistriwork/kit/client/locale.js';
import { currencyDigits } from '@mistriwork/engine/shared/money.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import { isAppIcon } from '@mistriwork/engine/shared/appIcons.js';
import { appWord } from '@mistriwork/kit/client/messages.js';
import { say } from '../copy/forms/components/IntakeControls.js';
import { amountIn, maskShown, moneySymbol, PLACE } from './fieldShown.js';
import { ChoiceRadios } from './ChoiceRadios.js';

type Field = AppCommandField;
type Choice = Extract<Field, { type: 'choice' | 'choices' }>['options'][number];

interface IntakeControlProps {
  field: Field;
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  value: CommandValue | undefined;
  disabled?: boolean;
  onChange: (value: CommandValue) => void;
  /** The App's currency, ISO 4217; an amount is said in it. */
  currency?: string;
  /** Where a choice from a table reads its rows: the reader's connection, or a public form's App as its visitor. */
  source?: ChoiceSource;
  /** The form's answers so far: what a choice narrowed by the others (`where`) reads. */
  answers?: Readonly<Record<string, unknown>>;
}

/** At most this many rows are offered by a choice from a table; past it the form is a reference's to ask. */
const SOURCED_MOST = 200;
/** Cards for a few, the listbox past this many. */
const CARDS_MOST = 6;

/* A choice from a table's rows: read once per form through the reader's own read (a visitor's, on a public form,
   answers only what `auth.public` opens), each row's key its value and its label column its words — the reader's
   locale's column where the field names one (`labelColumns`), else `labelColumn`. A choice narrowed by the form's other
   answers (`where`) offers nothing until those are given; then a served list is narrowed here, each row carrying the
   columns its `where` compares, with no read of its own, and a read list is read again with the `where` bound, once per
   change of the answers it reads. */
function useSourced(
  field: Field,
  source: ChoiceSource | undefined,
  answers: Readonly<Record<string, unknown>> | undefined,
): readonly Choice[] | undefined {
  const from = (field.type === 'choice' || field.type === 'choices') && field.source ? field.source : undefined;
  const match = from?.match;
  const bound = match ? boundChoiceMatch(match, answers ?? {}) : undefined;
  const narrowedBy = match && bound ? choiceMatchText(bound) : undefined;
  /* A public form is served its rows with it (server forms/formChoices.ts, tenantPublicChoices.ts), under the form's own
     ETag: nothing to read. `served` says the list is the whole answer, so an empty one offers nothing rather than
     reading — a tenant's visitor on the shared host has no read of its own to ask. */
  const served =
    from && (field.type === 'choice' || field.type === 'choices') && (from.served || field.options.length) ? field.options : undefined;
  const local = from ? choiceLabelColumn(from, formatLocale()) : undefined;
  const read = useQuery({
    queryKey: [
      'command-choices',
      typeof source === 'string' ? source : source?.visitor,
      from?.from,
      from?.by,
      from?.labelColumn,
      from?.sort?.column,
      from?.sort?.direction,
      local?.column,
      ...(match ? choiceAnswers(match).map((name) => answers?.[name] ?? null) : []),
    ],
    enabled: from !== undefined && source !== undefined && served === undefined && (!match || bound !== undefined),
    staleTime: 60_000,
    queryFn: async () => {
      const columns = [...new Set([from!.by, from!.labelColumn, ...(local ? [local.column] : [])])].join(', ');
      const data = await run(source!, {
        q: `${from!.from}${narrowedBy ? ` ${narrowedBy}` : ''} show ${columns} sort ${from!.sort ? `${from!.sort.column} ${from!.sort.direction}` : from!.labelColumn}`,
        limit: SOURCED_MOST,
        offset: 0,
        count: 'none',
      });
      const rows = Array.isArray(data.rows) ? (data.rows as Record<string, unknown>[]) : [];
      const keyed = rows.filter((row) => typeof row[from!.by] === 'string' || typeof row[from!.by] === 'number');
      return choiceOptions(keyed, from!, local);
    },
  });
  if (!from) return undefined;
  if (match && !bound) return [];
  if (served && match) return served.filter((option) => choiceRowHolds(bound!, option.row));
  return served ?? read.data;
}

/* A pick the narrowed list no longer offers — its parent answer changed — is cleared, so the form never sends a pairing
   it did not offer (the server refuses one all the same). Only a narrowed choice: a plain one keeps a prefilled key
   past its first rows. */
function useStalePickCleared(props: IntakeControlProps, offered: readonly Choice[] | undefined): void {
  const { field, value, onChange } = props;
  const narrowed = (field.type === 'choice' || field.type === 'choices') && field.source?.match !== undefined;
  const keys = offered?.map((option) => String(option.value)).join('\u0000');
  useEffect(() => {
    if (!narrowed || !offered) return;
    const held = new Set(offered.map((option) => String(option.value)));
    if (Array.isArray(value)) {
      const kept = value.filter((pick) => held.has(String(pick)));
      if (kept.length !== value.length) onChange(kept);
    } else if (value !== undefined && value !== '' && !held.has(String(value))) onChange('');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- judged again when what is offered or picked changes
  }, [narrowed, keys, value]);
}

/** Whether the field is one this module draws (the rest are CommandFields' own). */
export function drawnHere(field: Field): boolean {
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

/** The characters `typed` holds that the mask's places take, in order, as many as it has places. */
function maskRaw(mask: string, typed: string): string {
  const places = [...mask].filter((c) => PLACE.test(c));
  let out = '';
  for (const ch of typed) {
    const place = places[out.length];
    if (!place) break;
    if (place === '0' ? /\d/.test(ch) : place === 'a' ? /[A-Za-z]/.test(ch) : /[A-Za-z0-9]/.test(ch)) out += ch;
  }
  return out;
}

/** The keyboard a mask asks for: digits alone are the number pad. */
const maskKeys = (mask: string): 'numeric' | 'text' => ([...mask].every((c) => !PLACE.test(c) || c === '0') ? 'numeric' : 'text');

/** How the reader's locale writes a month and a year ("MM/YYYY" in en-US, "YYYY-MM" in Swedish): the order of the two
    parts, their separator, and the hint that says so — the one pattern the box shows, reads and is described by. */
function monthMask(locale: string | undefined): { order: ('month' | 'year')[]; sep: string; hint: string } {
  let parts: Intl.DateTimeFormatPart[] = [];
  try {
    parts = new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', timeZone: 'UTC', calendar: 'gregory' }).formatToParts(
      Date.UTC(2006, 10, 22),
    );
  } catch {
    /* An unknown locale reads as the default below. */
  }
  const order = parts.flatMap((part) => (part.type === 'month' || part.type === 'year' ? [part.type] : []));
  if (order.length !== 2) return { order: ['month', 'year'], sep: '/', hint: 'MM/YYYY' };
  const sep = parts.find((part) => part.type === 'literal')?.value.trim() || '/';
  return { order, sep, hint: order.map((type) => (type === 'month' ? 'MM' : 'YYYY')).join(sep) };
}

/** A month typed in the locale's order as the `YYYY-MM` the reader reads; anything short of one is handed on as typed. */
function monthValue(typed: string, locale: string | undefined): string {
  const digits = typed.replace(/\D/g, '').slice(0, 6);
  if (digits.length !== 6) return digits;
  return monthMask(locale).order[0] === 'year' ? `${digits.slice(0, 4)}-${digits.slice(4)}` : `${digits.slice(2)}-${digits.slice(0, 2)}`;
}
const monthShown = (value: string, locale: string | undefined): string => {
  const { order, sep } = monthMask(locale);
  const iso = /^(\d{4})-(\d{2})$/.exec(value);
  const digits = iso ? (order[0] === 'year' ? `${iso[1]}${iso[2]}` : `${iso[2]}${iso[1]}`) : value.replace(/\D/g, '');
  const first = order[0] === 'year' ? 4 : 2;
  return digits.length > first ? `${digits.slice(0, first)}${sep}${digits.slice(first)}` : digits;
};

const optionKey = (option: Choice) => `${typeof option.value}:${option.value}`;

/* How short a set of cards' words are. A wide page sets short ones side by side (structure.css) rather than stretching
   "Tile" across 40rem; a phone and a dialog keep one card a row whatever this says. Lengths are characters because
   the measure is the column, not a font: a label of 14 fits a third of it beside its icon and its mark, one of 24 and
   a line of 40 a half. */
const SHORT_LABEL = 14;
const BRIEF_LABEL = 24;
const BRIEF_HELP = 40;
function cardFit(options: readonly Choice[]): 'short' | 'brief' | undefined {
  if (options.length < 3 || options.some((option) => option.label.length > BRIEF_LABEL)) return undefined;
  if (options.every((option) => !option.help && option.label.length <= SHORT_LABEL)) return 'short';
  return options.every((option) => (option.help?.length ?? 0) <= BRIEF_HELP) ? 'brief' : undefined;
}

/* A choice from a table: its rows read (the one control here that reads anything), then drawn as written choices. */
function SourcedControl(props: IntakeControlProps) {
  const sourced = useSourced(props.field, props.source, props.answers);
  useStalePickCleared(props, sourced);
  const { field, id, value, disabled, onChange } = props;
  if (field.type !== 'choice' && field.type !== 'choices') return null;
  if (!sourced) return null;
  const options = sourced;
  const drawn = { ...field, options, source: undefined } as typeof field;
  /* Radios when the field says so, as a written choice's are (CommandFields), whatever the rows number. */
  if (field.type === 'choice' && field.as === 'radios')
    return (
      <ChoiceRadios
        id={id}
        options={options}
        value={value}
        describedBy={props['aria-describedby']}
        required={field.required}
        invalid={props['aria-invalid'] === true || props['aria-invalid'] === 'true'}
        disabled={disabled}
        onChange={onChange}
      />
    );
  // A few rows are cards; more are the listbox (one) or checks (several), unless the field says how.
  if (field.type === 'choice' && field.as !== 'cards' && field.as !== 'buttons' && (field.as === 'select' || options.length > CARDS_MOST)) {
    const chosen = options.findIndex((option) => option.value === value);
    return (
      <Dropdown
        id={id}
        ariaLabelledBy={`${id}-label`}
        ariaInvalid={props['aria-invalid'] === true || props['aria-invalid'] === 'true'}
        ariaDescribedBy={props['aria-describedby']}
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
          ...options.map((option, index) => ({ value: String(index), label: option.label })),
        ]}
        onChange={(next) => {
          if (next !== '') onChange(options[Number(next)].value);
        }}
      />
    );
  }
  return <IntakeControl {...props} field={drawn} />;
}

/* An amount as it is read once typed, grouped in the App's locale (`2,500`); while it is typed, the digits alone, so the
   caret never jumps over a separator that arrived under it. */
function amountShown(value: unknown): string {
  const raw = String(value ?? '');
  const amount = Number(raw);
  return raw.trim() && Number.isFinite(amount) ? amount.toLocaleString(formatLocale(), { maximumFractionDigits: 20 }) : raw;
}

/* A minor-unit amount as it is read once typed: grouped, and always to the currency's own places ($12.50, ¥1,500), the
   decimal text handed to Intl whole so a figure past 2^53 is not rounded by a float on the way. */
function minorShown(value: unknown, digits: number): string {
  const raw = String(value ?? '');
  if (!/^-?\d*\.?\d*$/.test(raw.trim()) || !/\d/.test(raw)) return raw;
  try {
    return new Intl.NumberFormat(formatLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(
      raw.trim() as unknown as number,
    );
  } catch {
    return raw;
  }
}

/* What a person types into a minor-unit box: digits and one point, at most the currency's places after it. */
function minorTyped(text: string, digits: number): string {
  const [whole, ...rest] = text.replace(/[^\d.-]/g, '').split('.');
  return digits && rest.length ? `${whole}.${rest.join('').slice(0, digits)}` : whole;
}

export function IntakeControl(props: IntakeControlProps) {
  const { field, id, value, disabled, onChange } = props;
  const aria = { 'aria-describedby': props['aria-describedby'], 'aria-invalid': props['aria-invalid'] };
  const [shown, setShown] = useState(false);
  const [typing, setTyping] = useState(false);

  if (field.type === 'money' && field.as !== 'slider') {
    /* The symbol stands inside the box, over its start, hidden from a screen reader so it hears the amount alone; the
       box's words start after it, by the sign's length in the box's own digits (a "CHF" takes three). */
    const currency = (field.currency || props.currency) ?? undefined;
    const symbol = moneySymbol(currency);
    const places = field.minor ? currencyDigits(currency || defaultCurrency()) : undefined;
    return (
      <div className="intake-money">
        <span className="intake-money-symbol" aria-hidden="true">
          {symbol}
        </span>
        <input
          {...aria}
          id={id}
          data-slot="input"
          style={{ paddingInlineStart: `calc(var(--money-pad) + ${symbol.length}ch + var(--space-2))` }}
          type="text"
          inputMode={
            (places === undefined ? field.step !== undefined && Number.isInteger(field.step) : places === 0) ? 'numeric' : 'decimal'
          }
          enterKeyHint="next"
          autoComplete="off"
          placeholder={field.placeholder}
          disabled={disabled}
          required={field.required}
          value={typing ? String(value ?? '') : places === undefined ? amountShown(value) : minorShown(value, places)}
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
          onChange={(event) =>
            onChange(places === undefined ? event.target.value.replace(/[^\d.-]/g, '') : minorTyped(event.target.value, places))
          }
        />
      </div>
    );
  }
  if (field.type === 'month') {
    return (
      <input
        {...aria}
        id={id}
        data-slot="input"
        className="intake-month"
        type="text"
        inputMode="numeric"
        enterKeyHint="next"
        autoComplete="off"
        placeholder={appWord('mistri.form.monthHint', monthMask(formatLocale()).hint)}
        disabled={disabled}
        required={field.required}
        value={monthShown(typeof value === 'string' ? value : '', formatLocale())}
        onChange={(event) => onChange(monthValue(event.target.value, formatLocale()))}
      />
    );
  }
  if ((field.type === 'number' || field.type === 'money') && field.as === 'slider') {
    const min = field.min ?? 0;
    const max = field.max ?? 100;
    const at = typeof value === 'number' ? value : value === undefined || value === '' ? min : Number(value);
    const share = max > min ? ((at - min) / (max - min)) * 100 : 0;
    // An amount reads as one, in the App's currency ($500); a number as the locale writes it.
    const saying = (n: number) => (field.type === 'money' ? amountIn(n, props.currency, field.step) : n.toLocaleString(formatLocale()));
    const said = saying(at);
    return (
      <div className="intake-slider">
        <output data-slot="slider-readout" htmlFor={id} aria-hidden="true">
          {said}
        </output>
        <input
          {...aria}
          id={id}
          type="range"
          data-slot="field-control"
          data-kind="range"
          min={min}
          max={max}
          step={field.step ?? (field.type === 'money' ? 1 : field.integer ? 1 : 'any')}
          value={at}
          disabled={disabled}
          aria-valuetext={said}
          style={{ '--range-share': `${share}%` } as CSSProperties}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        {/* The two ends, read off the track; the range's own min and max say them to a screen reader. */}
        <div className="intake-slider-ends" aria-hidden="true">
          <span>{saying(min)}</span>
          <span>{saying(max)}</span>
        </div>
      </div>
    );
  }
  if (field.type === 'text' && field.sensitive) {
    const raw = typeof value === 'string' ? value : '';
    const drawn = field.mask ? maskShown(field.mask, raw) : raw;
    return (
      <div data-slot="field-with-action">
        <input
          {...aria}
          id={id}
          data-slot="input"
          data-hidden={shown ? undefined : ''}
          type={shown ? 'text' : 'password'}
          inputMode={field.mask ? maskKeys(field.mask) : 'text'}
          enterKeyHint="next"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          placeholder={field.placeholder}
          disabled={disabled}
          required={field.required}
          value={drawn}
          onChange={(event) => onChange(field.mask ? maskRaw(field.mask, event.target.value) : event.target.value)}
        />
        <Button intent="quiet" aria-controls={id} aria-pressed={shown} onClick={() => setShown(!shown)}>
          {shown ? say('hideValue') : say('showValue')}
        </Button>
      </div>
    );
  }
  if (field.type === 'text' && field.mask) {
    const mask = field.mask;
    return (
      <input
        {...aria}
        id={id}
        data-slot="input"
        type="text"
        inputMode={maskKeys(mask)}
        enterKeyHint="next"
        autoComplete="off"
        placeholder={field.placeholder ?? mask.replace(/[0a*]/g, '_')}
        disabled={disabled}
        required={field.required}
        value={maskShown(mask, typeof value === 'string' ? value : '')}
        onChange={(event) => onChange(maskRaw(mask, event.target.value))}
      />
    );
  }
  if (field.type === 'boolean') {
    if (field.as === 'buttons') {
      return (
        <div data-slot="radio-group" data-kind="cards" data-fit="pair" role="radiogroup" id={id} aria-labelledby={`${id}-label`} {...aria}>
          {([true, false] as const).map((answer) => (
            <label key={String(answer)} data-slot="choice" data-checked={value === answer ? '' : undefined}>
              {/* The browser's own radio under the part's name: the stylesheet lays it over its card and reads which is on. */}
              <input
                type="radio"
                name={id}
                data-slot="radio"
                data-checked={value === answer ? '' : undefined}
                checked={value === answer}
                disabled={disabled}
                onChange={() => onChange(answer)}
              />
              {answer ? appWord('mistri.form.yes', say('yesWord')) : appWord('mistri.form.no', say('noWord'))}
            </label>
          ))}
        </div>
      );
    }
    // A consent: the statement is the box's own words, so the box is named by them.
    return (
      <span className="intake-consent">
        <input
          {...aria}
          id={id}
          type="checkbox"
          className="command-check"
          required={field.accept === true}
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="intake-statement">{field.statement}</span>
      </span>
    );
  }
  if ((field.type === 'choice' || field.type === 'choices') && field.source) return <SourcedControl {...props} />;
  if (field.type === 'choice' || field.type === 'choices') {
    const several = field.type === 'choices';
    const chosen: readonly unknown[] = several ? (Array.isArray(value) ? value : []) : value === undefined ? [] : [value];
    const exclusive = field.type === 'choices' ? (field.exclusive ?? []) : [];
    const toggle = (option: Choice, on: boolean) => {
      if (!several) return onChange(option.value);
      if (exclusive.includes(option.value)) return onChange(on ? [option.value] : []);
      const rest = chosen.filter((v) => v !== option.value && !exclusive.includes(v as string | number));
      onChange(field.options.map((o) => o.value).filter((v) => (on && v === option.value) || rest.includes(v)) as CommandValue);
    };
    const buttons = field.as === 'buttons';
    /* Several cards are one group to the keyboard, as one choice's radios are (CheckCards): one Tab stop, the arrows
       between them, Space to turn one on or off, each saying aria-checked. */
    if (several)
      return (
        <CheckCards
          id={id}
          aria-labelledby={`${id}-label`}
          aria-describedby={props['aria-describedby']}
          aria-invalid={props['aria-invalid']}
          disabled={disabled}
          fit={cardFit(field.options)}
          cards={field.options.map((option) => ({
            key: optionKey(option),
            label: option.label,
            icon: option.icon && isAppIcon(option.icon) ? <Icon name={option.icon} /> : undefined,
            help: option.help,
            on: chosen.includes(option.value),
          }))}
          onToggle={(index, on) => toggle(field.options[index], on)}
        />
      );
    return (
      <div
        data-slot="radio-group"
        data-kind="cards"
        className={buttons ? 'intake-buttons' : undefined}
        data-fit={buttons ? 'pair' : cardFit(field.options)}
        role={several ? 'group' : 'radiogroup'}
        id={id}
        aria-labelledby={`${id}-label`}
        aria-required={(!several && field.required) || undefined}
        {...aria}
      >
        {field.options.map((option) => {
          const on = chosen.includes(option.value);
          return (
            <label key={optionKey(option)} data-slot="choice" data-checked={on ? '' : undefined}>
              {option.icon && !buttons && isAppIcon(option.icon) ? (
                <span data-slot="choice-icon" aria-hidden="true">
                  <Icon name={option.icon} />
                </span>
              ) : null}
              <span data-slot="choice-label">
                {option.label}
                {option.help && !buttons ? <span className="intake-choice-help">{option.help}</span> : null}
              </span>
              <input
                type={several ? 'checkbox' : 'radio'}
                name={several ? undefined : id}
                data-slot="radio"
                data-checked={on ? '' : undefined}
                checked={on}
                disabled={disabled}
                onChange={(event) => toggle(option, event.target.checked)}
              />
            </label>
          );
        })}
      </div>
    );
  }
  return null;
}
