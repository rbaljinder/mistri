/**
 * Controls bound to a param of a free-form page (`@mistriwork/mistri/page`): `<Choose param>`, `<Search param>` and
 * `<DateRange param>`.
 *
 * The address is their state. Each reads its param through the page's frame and writes it back there, so a change
 * refines the place the reader is on (replace, not push: Back leaves the page, not the last keystroke), a pasted
 * address opens with the control set, Back and forward put it as the address was, and the control keeps no value of
 * its own beyond what is being typed. They are drawn from the kit's own pieces, the Segmented row, the listbox, the
 * house text box and calendar field, so every look dresses them.
 *
 * This module is a part loaded when a page first draws one (page.tsx); the box they stand in (`kit-param`) already
 * holds a control's height, so their arrival moves nothing.
 */
import { useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { DateField } from '@mistriwork/kit/client/components/DateField.js';
import { UiParamKindsContext } from './context.js';
import { useAddressState, useRows } from './hooks.js';
import { Dropdown, Loaded, Segmented } from './kit.js';
import { joinRange, splitRange } from './paramKinds.js';
import { TextField } from './pageControls.js';
import { say } from '../../copy/components/components/sdk/paramControls.js';

/** From this many options, or this many characters of them, a choice is a listbox rather than a row of segments. */
const SEGMENTS_MOST = 5;
const SEGMENTS_WIDTH = 48;

/** A value no option can carry, for the "all" choice. */
const ALL = '~all';

interface Option {
  value: string;
  label: string;
}

/** "class_session" as a caption: the control's accessible name where the page gives none. */
const captioned = (param: string): string => {
  const words = param.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

interface ChooseProps {
  /** One of the page's `params`. */
  param: string;
  /** The resource the options are read from; without it, the param's own words (`params: { view: ['list', 'board'] }`). */
  from?: string;
  where?: unknown;
  query?: string;
  sort?: string;
  limit?: number;
  /** The column that is the param's value, `id` unless said. */
  value?: string;
  /** What an option says: a column path, or a function of the row. A resource's key reads as itself when absent. */
  label?: string | ((row: Readonly<Record<string, unknown>>) => string | null | undefined);
  /** Names the control for assistive technology; the param's name when absent. */
  name?: string;
  /** Present, a first choice with this word that clears the param. A param is optional, so a control that may be left unset says so with it. */
  all?: string;
  empty?: ReactNode;
}

/** A label path is one of the paths the read shows (`warehouse_id.name`), and a row holds it by that name. */
function said(row: Readonly<Record<string, unknown>>, label: ChooseProps['label'], value: string): string {
  if (typeof label === 'function') return label(row) ?? '';
  const read = row[label ?? value];
  return read === undefined || read === null ? '' : String(read);
}

function Pick({
  name,
  options,
  chosen,
  all,
  onPick,
}: {
  name: string;
  options: Option[];
  chosen: string | undefined;
  all?: string;
  onPick(value: string | undefined): void;
}) {
  const items = all === undefined ? options : [{ value: ALL, label: all }, ...options];
  const value = chosen === undefined ? (all === undefined ? '' : ALL) : chosen;
  const pick = (next: string) => onPick(next === ALL ? undefined : next);
  const short = items.length <= SEGMENTS_MOST && items.reduce((width, item) => width + item.label.length, 0) <= SEGMENTS_WIDTH;
  return short ? (
    <Segmented label={name} value={value} options={items} onChange={pick} />
  ) : (
    // Dressed as a field box, as Select dresses it: the bare listbox is the grid's (mono, small, no control height),
    // and beside a param's search box, which is a TextField, it read as a small native select.
    <Dropdown
      items={items}
      value={value}
      onChange={pick}
      ariaLabel={name}
      placeholder={say('choose')}
      buttonClassName="field-control field-select"
    />
  );
}

function ChooseWords({ param, name, all }: { param: string; name: string; all?: string }) {
  const kinds = useContext(UiParamKindsContext);
  const [chosen, set] = useAddressState(param);
  const words = kinds[param];
  if (!Array.isArray(words)) throw new Error(say('chooseNeedsOptions', { param }));
  const options = (words as string[]).map((word) => ({ value: word, label: word }));
  return <Pick name={name} options={options} chosen={chosen} all={all} onPick={(next) => set(next)} />;
}

function ChooseRows({
  param,
  from,
  where,
  query,
  sort,
  limit = 50,
  value = 'id',
  label,
  name,
  all,
  empty,
}: ChooseProps & { from: string; name: string }) {
  const [chosen, set] = useAddressState(param);
  const rows = useRows(from, {
    /* A row holds the paths a read shows, and a label path through a reference is only there when asked for; a label
       written as a function reads every column instead. */
    ...(typeof label === 'string' ? { show: [...new Set([value, label])] } : {}),
    ...(where === undefined ? {} : { where }),
    ...(query ? { query } : {}),
    ...(sort ? { sort } : {}),
    limit,
  });
  // A label written inline is a new function on every draw; what it says is what keeps the listbox's items still.
  const options_ = rows.data?.map((row) => ({ value: String(row[value]), label: said(row, label, value) }));
  const key = JSON.stringify(options_);
  const options = useMemo(() => options_, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Loaded query={{ ...rows, data: options }} empty={empty} height="var(--control-h)">
      {(loaded) => <Pick name={name} options={loaded} chosen={chosen} all={all} onPick={(next) => set(next)} />}
    </Loaded>
  );
}

/**
 * One of a few, kept in a param: `<Choose param="class" from="class_session" sort="starts_at" label="title" />`. A row of
 * segments for up to five short options, the listbox past that. Without `from`, the options are the param's own words.
 */
export function Choose(props: ChooseProps) {
  const name = props.name ?? captioned(props.param);
  return props.from === undefined ? (
    <ChooseWords param={props.param} name={name} all={props.all} />
  ) : (
    <ChooseRows {...props} from={props.from} name={name} />
  );
}

/**
 * Text in a param, typed into a box: `<Search param="q" />`. What is typed reaches the address after a pause (`delay`,
 * 300 ms), or at once on leaving the box, replacing the entry rather than adding one; an address that changes by itself
 * (Back, a link) puts the box as it says.
 */
export function Search({ param, name, placeholder, delay = 300 }: { param: string; name?: string; placeholder?: string; delay?: number }) {
  const [current, set] = useAddressState(param);
  const [text, setText] = useState(current ?? '');
  const written = useRef(current ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commit = (next: string) => {
    clearTimeout(timer.current);
    if (next === written.current) return;
    written.current = next;
    set(next || undefined);
  };
  useEffect(() => {
    // The address moved by itself, not by this box's own write: the box says what it now says.
    if ((current ?? '') === written.current) return;
    written.current = current ?? '';
    setText(current ?? '');
  }, [current]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="kit-param-search">
      <TextField
        label={name ?? captioned(param)}
        labelHidden
        reserve={false}
        value={text}
        placeholder={placeholder ?? say('search')}
        inputMode="text"
        onChange={(next) => {
          setText(next);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => commit(next.trim()), delay);
        }}
        onBlur={() => commit(text.trim())}
      />
    </div>
  );
}

/**
 * A run of days in a param of kind `'date-range'` (`2026-11-01..2026-11-08`, either end open): `<DateRange param="period" />`.
 * Two date fields; a day reaches the address once it is a whole date on the calendar, or cleared.
 */
export function DateRange({ param, name }: { param: string; name?: string }) {
  const [current, set] = useAddressState(param);
  const ids = [useId(), useId()];
  const read = (raw: string | undefined) => splitRange(raw) ?? (['', ''] as const);
  const [draft, setDraft] = useState<readonly [string, string]>(() => read(current));
  const written = useRef(current);
  useEffect(() => {
    if (current === written.current) return;
    written.current = current;
    setDraft(read(current));
  }, [current]);
  const change = (end: 0 | 1, value: string) => {
    const next: [string, string] = [draft[0], draft[1]];
    next[end] = value;
    setDraft(next);
    // Only a whole day, or none: half a date typed is the box's, not the address's.
    const whole = (day: string) => day === '' || splitRange(`${day}..`) !== undefined;
    if (!whole(value)) return;
    const range = joinRange(next[0], next[1]);
    written.current = range;
    set(range);
  };
  const caption = name ?? captioned(param);
  return (
    <div className="kit-param-dates" role="group" aria-label={caption}>
      <DateField
        id={ids[0]}
        aria-label={`${caption}, ${say('dateFrom')}`}
        value={draft[0]}
        max={draft[1] || undefined}
        onChange={(day) => change(0, day)}
      />
      <span className="kit-param-dash" aria-hidden="true">
        –
      </span>
      <DateField
        id={ids[1]}
        aria-label={`${caption}, ${say('dateTo')}`}
        value={draft[1]}
        min={draft[0] || undefined}
        onChange={(day) => change(1, day)}
      />
    </div>
  );
}
