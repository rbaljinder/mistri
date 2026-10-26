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
import { useState, type AriaAttributes, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dropdown } from '@mistriwork/kit/client/components/Dropdown.js';
import { CheckCards } from '@mistriwork/ui/Choices.js';
import { run, type ChoiceSource } from './CommandReference.js';
import '@mistriwork/kit/client/formControls.css';
import './IntakeControls.css';
import type { AppCommandField } from '../../shared/command.js';
import type { CommandValue } from '../commandState.js';
import { formatLocale } from '@mistriwork/kit/client/locale.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import { isAppIcon } from '@mistriwork/engine/shared/appIcons.js';
import { say } from '../copy/forms/components/IntakeControls.js';
import { amountIn, maskShown, moneySymbol, PLACE } from './fieldShown.js';

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
}

/** At most this many rows are offered by a choice from a table; past it the form is a reference's to ask. */
const SOURCED_MOST = 200;
/** Cards for a few, the listbox past this many. */
const CARDS_MOST = 6;

/* A choice from a table's rows: read once per form through the reader's own read (a visitor's, on a public form,
   answers only what `auth.public` opens), each row's key its value and its label column its words. */
function useSourced(field: Field, source: ChoiceSource | undefined): readonly Choice[] | undefined {
  const from = (field.type === 'choice' || field.type === 'choices') && field.source ? field.source : undefined;
  /* A public form is served its rows with it (server forms/formChoices.ts, tenantPublicChoices.ts), under the form's own
     ETag: nothing to read. `served` says the list is the whole answer, so an empty one offers nothing rather than
     reading — a tenant's visitor on the shared host has no read of its own to ask. */
  const served =
    from && (field.type === 'choice' || field.type === 'choices') && (from.served || field.options.length) ? field.options : undefined;
  const read = useQuery({
    queryKey: ['command-choices', typeof source === 'string' ? source : source?.visitor, from?.from, from?.by, from?.labelColumn],
    enabled: from !== undefined && source !== undefined && served === undefined,
    staleTime: 60_000,
    queryFn: async () => {
      const columns = [...new Set([from!.by, from!.labelColumn])].join(', ');
      const data = await run(source!, {
        q: `${from!.from} show ${columns} sort ${from!.labelColumn}`,
        limit: SOURCED_MOST,
        offset: 0,
        count: 'none',
      });
      const rows = Array.isArray(data.rows) ? (data.rows as Record<string, unknown>[]) : [];
      return rows.flatMap((row) => {
        const value = row[from!.by];
        return typeof value === 'string' || typeof value === 'number' ? [{ value, label: String(row[from!.labelColumn] ?? value) }] : [];
      });
    },
  });
  return from ? (served ?? read.data) : undefined;
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

/** A month typed `MM/YYYY` as the `YYYY-MM` the reader reads; anything short of one is handed on as typed. */
function monthValue(typed: string): string {
  const digits = typed.replace(/\D/g, '').slice(0, 6);
  return digits.length === 6 ? `${digits.slice(2)}-${digits.slice(0, 2)}` : digits;
}
const monthShown = (value: string): string => {
  const iso = /^(\d{4})-(\d{2})$/.exec(value);
  const digits = iso ? `${iso[2]}${iso[1]}` : value.replace(/\D/g, '');
  return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
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
  const sourced = useSourced(props.field, props.source);
  const { field, id, value, disabled, onChange } = props;
  if (field.type !== 'choice' && field.type !== 'choices') return null;
  if (!sourced) return null;
  const options = sourced;
  const drawn = { ...field, options, source: undefined } as typeof field;
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
          ...(chosen < 0 ? [{ value: '', label: say('choosePlaceholder', { label: field.label.toLowerCase() }) }] : []),
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

export function IntakeControl(props: IntakeControlProps) {
  const { field, id, value, disabled, onChange } = props;
  const aria = { 'aria-describedby': props['aria-describedby'], 'aria-invalid': props['aria-invalid'] };
  const [shown, setShown] = useState(false);
  const [typing, setTyping] = useState(false);

  if (field.type === 'money' && field.as !== 'slider') {
    /* The symbol stands inside the box, over its start, hidden from a screen reader so it hears the amount alone; the
       box's words start after it, by the sign's length in the box's own digits (a "CHF" takes three). */
    const symbol = moneySymbol(props.currency);
    return (
      <div className="intake-money">
        <span className="intake-money-symbol" aria-hidden="true">
          {symbol}
        </span>
        <input
          {...aria}
          id={id}
          className="field-control"
          style={{ paddingInlineStart: `calc(var(--money-pad) + ${symbol.length}ch + var(--space-2))` }}
          type="text"
          inputMode={field.step !== undefined && Number.isInteger(field.step) ? 'numeric' : 'decimal'}
          enterKeyHint="next"
          autoComplete="off"
          disabled={disabled}
          required={field.required}
          value={typing ? String(value ?? '') : amountShown(value)}
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
          onChange={(event) => onChange(event.target.value.replace(/[^\d.-]/g, ''))}
        />
      </div>
    );
  }
  if (field.type === 'month') {
    return (
      <input
        {...aria}
        id={id}
        className="field-control intake-month"
        type="text"
        inputMode="numeric"
        enterKeyHint="next"
        autoComplete="off"
        placeholder={say('monthPlaceholder')}
        disabled={disabled}
        required={field.required}
        value={monthShown(typeof value === 'string' ? value : '')}
        onChange={(event) => onChange(monthValue(event.target.value))}
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
        <output className="field-control field-readout" htmlFor={id} aria-hidden="true">
          {said}
        </output>
        <input
          {...aria}
          id={id}
          type="range"
          className="field-range"
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
      <div className="field-with-action">
        <input
          {...aria}
          id={id}
          className={`field-control${shown ? '' : ' field-hidden'}`}
          type={shown ? 'text' : 'password'}
          inputMode={field.mask ? maskKeys(field.mask) : 'text'}
          enterKeyHint="next"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          disabled={disabled}
          required={field.required}
          value={drawn}
          onChange={(event) => onChange(field.mask ? maskRaw(field.mask, event.target.value) : event.target.value)}
        />
        <button type="button" className="btn btn-quiet" aria-controls={id} aria-pressed={shown} onClick={() => setShown(!shown)}>
          {shown ? say('hideValue') : say('showValue')}
        </button>
      </div>
    );
  }
  if (field.type === 'text' && field.mask) {
    const mask = field.mask;
    return (
      <input
        {...aria}
        id={id}
        className="field-control"
        type="text"
        inputMode={maskKeys(mask)}
        enterKeyHint="next"
        autoComplete="off"
        placeholder={mask.replace(/[0a*]/g, '_')}
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
        <div className="choice-pair" role="radiogroup" id={id} aria-labelledby={`${id}-label`} {...aria}>
          {([true, false] as const).map((answer) => (
            <label key={String(answer)} className={`choice-pick${value === answer ? ' is-on' : ''}`}>
              <input
                type="radio"
                name={id}
                className="choice-input"
                checked={value === answer}
                disabled={disabled}
                onChange={() => onChange(answer)}
              />
              {answer ? say('yesWord') : say('noWord')}
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
          className="command-check field-check"
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
        className={buttons ? 'choice-pair intake-buttons' : 'choice-cards'}
        data-fit={buttons ? undefined : cardFit(field.options)}
        role={several ? 'group' : 'radiogroup'}
        id={id}
        aria-labelledby={`${id}-label`}
        aria-required={(!several && field.required) || undefined}
        {...aria}
      >
        {field.options.map((option) => {
          const on = chosen.includes(option.value);
          return (
            <label key={optionKey(option)} className={`${buttons ? 'choice-pick' : 'choice-card'}${on ? ' is-on' : ''}`}>
              {option.icon && !buttons && isAppIcon(option.icon) ? (
                <span className="choice-card-icon" aria-hidden="true">
                  <Icon name={option.icon} />
                </span>
              ) : null}
              <span className="choice-card-label">
                {option.label}
                {option.help && !buttons ? <span className="intake-choice-help">{option.help}</span> : null}
              </span>
              <input
                type={several ? 'checkbox' : 'radio'}
                name={several ? undefined : id}
                className="choice-input"
                checked={on}
                disabled={disabled}
                onChange={(event) => toggle(option, event.target.checked)}
              />
              {buttons ? null : <span className="choice-box" aria-hidden="true" />}
            </label>
          );
        })}
      </div>
    );
  }
  return null;
}
