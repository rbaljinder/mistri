/**
 * A list's filters as a rail of facets beside the rows — `filterBar: 'rail'`.
 *
 * The bar asks one value per column; a rail is for the list a reader works
 * through by narrowing, where the question is "open or done, mine, due this
 * week" and the answer is how many of each. So a vocabulary or a reference
 * is a checklist of its values with live counts, a flag a toggle, a date its
 * presets and a range. Any other column shows as what its values are: a
 * number with many values a Min/Max range, one with a few (a priority, a
 * model year) a checklist, text with a few dozen values a checklist and more
 * a contains box — judged once, over the rows the view stands on
 * (filterRailModel `autoShape`). The name column is the rail's search box; in a column's
 * own picker (the filter popover) it is judged like the rest, so a name with a few values
 * lists them with their counts.
 * Every facet writes a condition tail into the same question the bar's boxes
 * do (filterRailModel says how), so a selection is a URL, a chip and a
 * refinement of the tab like any other.
 *
 * Controlled: the rail reads `refinement` and hands a new one to `onChange`.
 * Beside the list that navigates at once; in the phone sheet it edits a
 * draft, applied by the sheet's own button, because each navigation redraws
 * the list the sheet is covering.
 */
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import { api, columnDisplay, findTable, labelColumn, state } from '../core.js';
import { batchedBreakdown } from '../breakdownBatch.js';
import { defaultCurrency, formatLocale, formatNumber, formatTimezone } from '../locale.js';
import { DateField } from './DateField.js';
import { Button } from '@mistriwork/ui/Button.js';
import { Field } from '@mistriwork/ui/Field.js';
import { isPickerDate } from '@mistriwork/ui/internal/datePickerModel.js';
import { columnKind, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { andQuery } from '@mistriwork/engine/shared/query.js';
import { vocabularyWord } from '@mistriwork/engine/shared/model.js';
import { centsAmong, dressFor, wordFor, type DisplayRule } from './valueModel.js';
import { minorToMajor } from '@mistriwork/engine/shared/money.js';
import { majorToMinor } from '@mistriwork/engine/shared/moneyEntry.js';
import { WHOLE, conditionTail, holdsCondition, squeeze, unquote, withCondition } from '../filterbar.js';
import { boxTail, type Box } from './FilterBoxes.js';
import { useArrived } from './onDemand.js';
import { SuggestBox } from './suggestPart.js';
import {
  CHECKLIST_MOST,
  MORE_LABELS,
  datePresets,
  autoShape,
  clearFacets,
  facetActive,
  facetCountText,
  facetKind,
  facetShapeText,
  hasCountText,
  hasValuesText,
  moreConditions,
  moreOf,
  moreTail,
  numberRangeOf,
  numberRangeTail,
  rangeOf,
  rangeTail,
  selectedTags,
  selectedValues,
  tagsTail,
  takesText,
  valuesTail,
  type AutoShape,
  type MoreCondition,
} from './filterRailModel.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import { useConditionWords } from './useConditionWords.js';
import { say } from '../copy/filters/components/FilterRail.js';

/** A checklist shows this many values before "Show all": five keeps the
    next facet in sight (at eight, Make and Model pushed Price off the first
    screen). A list only one or two longer is shown whole: a "Show all 6"
    that reveals one value is a click that buys nothing. */
const SHORT = 5;
const SLACK = 2;
/** And never asks for more than this many; a column with more is a search, not a list. */
const MOST = CHECKLIST_MOST;

/* Through locale.ts's kept formatter: a rail says a count per value, and
   built afresh each was a formatter per count on every draw. */
const counted = (n: number) => formatNumber(n);

/** How a range says its column's figures: a currency before them, a unit after. */
export interface FacetUnit {
  currency?: string;
  unit?: string;
}

interface RailProps {
  table: TableMeta;
  boxes: Box[];
  /** The question the facets read, without the table name or the plumbing. */
  refinement: string;
  /** The lit tab's own query: its conditions are the tab's, so Clear all leaves them. */
  tabQuery?: string;
  /** The view's standing condition (`status != sold`): not the reader's to see or clear, but every count stands on it. */
  standing?: string;
  /** A column's currency or unit, said beside a range's boxes. */
  unitOf?: (column: string) => FacetUnit | undefined;
  /** Beside a list whose chips carry their own Clear all, the rail's would be a second one. */
  clearAll?: boolean;
  onChange: (refinement: string) => void;
  /** What the list matches now, said politely to a screen reader as it changes. */
  status?: string;
}

export function FilterRail({
  table,
  boxes,
  refinement,
  tabQuery = '',
  standing = '',
  unitOf,
  clearAll = true,
  onChange,
  status,
}: RailProps) {
  const columns = boxes.map((box) => box.column);
  const any = columns.some((column) => facetActive(refinement, column, tabQuery));
  const set = (column: string, tail: string) => onChange(withCondition(refinement, column, tail));
  return (
    <div className="filter-rail-body">
      <div className="filter-rail-head">
        <h2 className="filter-rail-title">{say('common.filtersButton')}</h2>
        {clearAll && any && (
          <button type="button" className="filter-rail-clear" onClick={() => onChange(clearFacets(refinement, columns, tabQuery))}>
            {say('list.clearAll')}
          </button>
        )}
      </div>
      {boxes.map((box) => (
        <FacetFor
          key={box.column}
          box={box}
          table={table}
          refinement={refinement}
          standing={standing}
          unit={unitOf?.(box.column)}
          set={(next) => set(box.column, next)}
        />
      ))}
      <p className="visually-hidden" role="status">
        {status ?? ''}
      </p>
    </div>
  );
}

/**
 * One column's facet over a question: what the rail draws for each of its
 * columns, and what an App list's filter bar opens alone in a popover
 * (ListFilterBar.tsx). `set` hears the column's new tail; `onEnter`, where
 * given, hears Enter in a box once its value is set, so a popover applies
 * on the key a reader expects to apply rather than on a second one.
 */
export function FacetFor({
  box,
  table,
  refinement,
  standing = '',
  unit,
  set,
  onEnter,
  picking = false,
}: {
  box: Box;
  table: TableMeta;
  refinement: string;
  standing?: string;
  unit?: FacetUnit;
  set: (tail: string) => void;
  onEnter?: () => void;
  /** A column's own picker (the filter popover): its name column is a column like another, not the rail's search box. */
  picking?: boolean;
}) {
  const tail = squeeze(conditionTail(refinement, box.column));
  /* The rows that point at the record are asked by what they hold, and counted as the list's records. */
  if (box.has) {
    const props = { box, tail, table, refinement, standing, set, onEnter };
    return box.has.segment ? <HasSegmentFacet {...props} /> : <HasValuesFacet {...props} />;
  }
  const kind = facetKind(box.kind);
  /* The rarer conditions sit behind one quiet disclosure in every facet, so
     the rail and a column menu's Filter… say them alike. */
  const more = kind === 'tags' ? null : <MoreConditions box={box} tail={tail} set={set} onEnter={onEnter} facet={kind} />;
  const props = { box, tail, table, refinement, standing, set, onEnter, more };
  if (kind === 'values') return <ValuesFacet {...props} />;
  if (kind === 'tags') return <TagsFacet {...props} />;
  if (kind === 'flag') return <FlagFacet {...props} />;
  if (kind === 'date') return <DateFacet {...props} />;
  /* The name is what a reader searches by; a source that takes whole
     values only (an API) cannot be counted or ranged. Anything else
     shows as what its values are. Keyed by its tail, so a condition
     changed elsewhere redraws the box with it. */
  /* In the rail the name is the search box. In a column's own picker it is judged like any column: a
     name with a few dozen values (a make, a department) is offered as those values with their counts, a
     longer one as the contains box, and a contains already asked stays the box that asked it. */
  const asked = /^contains\s/i.test(tail);
  if (box.exact || (box.column === labelColumn(table) && (!picking || asked))) return <TextFacet key={tail} {...props} />;
  return <AutoFacet {...props} unit={unit} bare={box.column === labelColumn(table)} />;
}

interface FacetProps {
  box: Box;
  tail: string;
  table: TableMeta;
  refinement: string;
  standing: string;
  set: (tail: string) => void;
  onEnter?: () => void;
  more?: ReactNode;
}

/* A facet's name and its own way out. A group of inputs is a fieldset, so
   each checkbox or radio is announced with the facet it belongs to. */
function Facet({
  box,
  tail,
  set,
  more,
  group = true,
  busy = false,
  children,
}: Pick<FacetProps, 'box' | 'tail' | 'set' | 'more'> & { group?: boolean; busy?: boolean; children: ReactNode }) {
  const clear = tail ? (
    <button type="button" className="facet-clear" aria-label={say('common.clear2', { label: box.label })} onClick={() => set('')}>
      {say('common.clear')}
    </button>
  ) : null;
  if (!group)
    return (
      <div className="facet" data-column={box.column}>
        {children}
        {clear}
        {more}
      </div>
    );
  return (
    <fieldset className="facet" data-column={box.column} aria-busy={busy || undefined}>
      <legend className="facet-label">{box.label}</legend>
      {clear}
      {children}
      {more}
    </fieldset>
  );
}

/* A condition this facet has no control for — `!= open`, `= false`, typed
   in Advanced — is said rather than drawn as nothing, and kept until the
   reader picks. */
function Unshown({ box, table, tail }: { box: Box; table: TableMeta; tail: string }) {
  // In the App's words, "Status is not Open"; the Workbench has no rail.
  const { speaker, sayTails } = useConditionWords(table, [`${box.column} ${tail}`]);
  return moreOf(tail) ? null : <p className="facet-note">{sayTails(speaker, box.column, [tail])}</p>;
}

/**
 * The conditions a facet has no everyday control for — starts with, a
 * pattern, empty, not empty — behind one quiet disclosure, open while one of
 * them is what the column asks. A choice that needs no text applies as it is
 * picked; one that takes text applies on Enter or leaving the box, as a
 * range does.
 */
function MoreConditions({
  box,
  tail,
  set,
  onEnter,
  facet,
}: Pick<FacetProps, 'box' | 'tail' | 'set' | 'onEnter'> & { facet: Exclude<ReturnType<typeof facetKind>, 'tags'> }) {
  const id = useId();
  const said = moreOf(tail);
  const [open, setOpen] = useState(Boolean(said));
  const [picked, setPicked] = useState<MoreCondition | null>(said?.condition ?? null);
  const [text, setText] = useState(said?.text ?? '');
  const box$ = useRef<HTMLInputElement>(null);
  const focusText = useRef(false);
  useEffect(() => {
    setPicked(said?.condition ?? null);
    setText(said?.text ?? '');
    if (said) setOpen(true);
  }, [tail]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!focusText.current) return;
    focusText.current = false;
    box$.current?.focus();
  });
  const offered = moreConditions(facet, box.meta, box.exact);
  /* A condition typed elsewhere is shown here even where it would not be offered. */
  if (said && !offered.includes(said.condition)) offered.push(said.condition);
  if (!offered.length) return null;
  const choose = (condition: MoreCondition) => {
    setPicked(condition);
    if (!takesText(condition)) set(moreTail(condition));
    else if (text.trim()) set(moreTail(condition, text));
    else focusText.current = true;
  };
  const commit = () => {
    if (!picked || !takesText(picked)) return;
    const next = moreTail(picked, text);
    if (next && next !== tail) set(next);
  };
  return (
    <div className="facet-more-conditions">
      <button type="button" className="facet-more" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {say('moreConditions')}
      </button>
      {open && (
        <div id={id} role="group" aria-label={say('moreConditionsOn', { label: box.label })} className="facet-values">
          {offered.map((condition) => (
            <Fragment key={condition}>
              <label className="facet-option">
                <input type="radio" name={id} data-value={condition} checked={picked === condition} onChange={() => choose(condition)} />
                <span className="facet-option-label">{MORE_LABELS[condition]}</span>
              </label>
              {takesText(condition) && picked === condition && (
                <div className="form-field form-field-compact">
                  <input
                    ref={box$}
                    type="text"
                    className="field-control facet-input"
                    aria-label={MORE_LABELS[condition]}
                    data-value={`${condition}-text`}
                    value={text}
                    placeholder={condition === 'like' ? say('common.patternEGWh') : say('text')}
                    title={condition === 'like' ? say('standsForAnyRun') : undefined}
                    onChange={(e) => setText(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commit();
                        onEnter?.();
                      }
                    }}
                  />
                </div>
              )}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

interface Count {
  value: string;
  label?: string;
  count: number;
}

/** A facet's values and how many rows each would add, under everything else the list asks. */
function useCounts(table: TableMeta, refinement: string, column: string, labelPath: string | undefined, standing: string) {
  const text = facetCountText(table.id, refinement, column, labelPath, standing);
  return useQuery<Count[]>({
    /* In the list's own query family, so a write that refreshes the rows refreshes the counts. */
    queryKey: ['run', state.activeConnection ?? '', 'facet', text],
    queryFn: async () => {
      /* With the rail's other facets, in one request (breakdownBatch.ts):
         a rail of eleven facets was eleven requests queued on one connection. */
      const data = (await batchedBreakdown({ text, limit: MOST })) as {
        columns?: string[];
        rows?: Array<Record<string, unknown>>;
        errors?: unknown[];
      };
      if (data.errors?.length || !data.columns?.length) throw new Error(say('couldNotCountTheValues'));
      const keys = data.columns;
      return (data.rows ?? []).flatMap((row) => {
        const value = row[keys[0]];
        const n = Number(row[keys[keys.length - 1]]);
        if (value == null || !Number.isFinite(n)) return [];
        const label = labelPath ? row[keys[1]] : undefined;
        return [{ value: String(value), count: n, ...(label == null ? {} : { label: String(label) }) }];
      });
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** The label path a reference's values are said by: its target's label column. */
function labelPathOf(box: Box): string | undefined {
  const target = box.meta?.references ? (findTable(box.meta.references.table) as TableMeta | undefined) : undefined;
  const label = target ? (labelColumn(target) as string | undefined) : undefined;
  return label ? `${box.column}.${label}` : undefined;
}

const numericColumn = (box: Box) => (box.meta ? columnKind(box.meta.type) === 'number' : false);

function ValuesFacet({ box, tail, table, refinement, standing, set, more }: FacetProps) {
  const [all, setAll] = useState(false);
  const labelPath = box.kind === 'ref' ? labelPathOf(box) : undefined;
  const counts = useCounts(table, refinement, box.column, labelPath, standing);
  const byValue = new Map((counts.data ?? []).map((c) => [c.value, c]));
  const selected = selectedValues(tail);
  const ticked = selected ?? [];
  /* A vocabulary is listed whole, in its own order — a value with no rows
     is still a value, and says 0. A reference lists the targets that have
     rows, the most first; so does text, and a number lists its values in
     their own order (1, 2, 3; 2016 to 2024). A ticked value is always
     listed, rows or none. */
  const allowed = (box.meta as { allowed?: string[] } | undefined)?.allowed;
  const rule = columnDisplay(table.id, box.column) as DisplayRule | null;
  const listed: Count[] = allowed?.length ? allowed.map((value) => byValue.get(value) ?? { value, count: 0 }) : [...(counts.data ?? [])];
  for (const value of ticked) if (!listed.some((c) => c.value === value)) listed.push({ value, count: 0 });
  if (!allowed?.length && box.kind !== 'ref' && numericColumn(box)) listed.sort((a, b) => Number(a.value) - Number(b.value));
  const shown = all || listed.length <= SHORT + SLACK ? listed : listed.filter((c, i) => i < SHORT || ticked.includes(c.value));
  /* Money is said as the cards say it ($1,795), whatever unit it is kept in; the tick still asks for the stored value. */
  const money =
    rule?.format === 'money'
      ? centsAmong(
          rule,
          listed.map((c) => c.value),
        )
      : null;
  const figure = (value: string) => {
    const dress = money ? dressFor(money, value) : null;
    return dress?.kind === 'money' ? dress.text : undefined;
  };
  const known = counts.isSuccess;
  const toggle = (value: string, on: boolean) => {
    const next = on ? [...ticked, value] : ticked.filter((v) => v !== value);
    const order = listed.map((c) => c.value);
    set(valuesTail(next.sort((a, b) => order.indexOf(a) - order.indexOf(b))));
  };
  return (
    <Facet box={box} tail={tail} set={set} more={more}>
      {selected === null && <Unshown box={box} table={table} tail={tail} />}
      {counts.isError && <p className="facet-note">{say('countsUnavailable')}</p>}
      <ul className="facet-values">
        {shown.map((c) => {
          /* A vocabulary's value is a word to its reader (`in_progress` says "In progress"),
             as its chip says it, and in the display rule's own word where it gives one
             (`values`, `humanize`); any other value is said exactly. */
          const said = c.label ?? wordFor(rule, c.value) ?? figure(c.value) ?? (allowed?.length ? vocabularyWord(c.value) : c.value);
          return (
            <li key={c.value}>
              <label className="facet-option" title={c.label ? `${box.column} = ${c.value}` : undefined}>
                <input
                  type="checkbox"
                  data-value={c.value}
                  checked={ticked.includes(c.value)}
                  onChange={(e) => toggle(c.value, e.target.checked)}
                />
                <span className="facet-option-label">{said}</span> {/* Blank until known, never a guessed zero. */}
                <span className="facet-count">{known ? counted(c.count) : ''}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {!all && listed.length > shown.length && (
        <button type="button" className="facet-more" onClick={() => setAll(true)}>
          {say('showAll', { listedCount: listed.length })}
        </button>
      )}
    </Facet>
  );
}

/* One count of the list's records, asked of a breakdown in the rail's batch; null until known. */
const recordCount = (text: string) => ({
  queryKey: ['run', state.activeConnection ?? '', 'facet', text],
  queryFn: async (): Promise<number> => {
    const data = (await batchedBreakdown({ text, limit: 1 })) as {
      columns?: string[];
      rows?: Array<Record<string, unknown>>;
      errors?: unknown[];
    };
    if (data.errors?.length || !data.columns?.length) throw new Error(say('couldNotCountTheValues'));
    const n = Number(data.rows?.[0]?.[data.columns[data.columns.length - 1]] ?? 0);
    return Number.isFinite(n) ? n : 0;
  },
  staleTime: 60_000,
  placeholderData: keepPreviousData,
  retry: false,
});

/*
 * A value of the rows that point at the record (shared/listFilters.ts) —
 * `any opportunity where stage in (won, lost)`: a checklist of what those
 * rows hold, a vocabulary whole and in its order, anything else the values
 * held the most first, a reference by its record's name. Each value says how
 * many of the list's records one of their rows holding it would show — the
 * records, once each, under everything else the list asks.
 */
function HasValuesFacet({ box, tail, table, refinement, standing, set }: FacetProps) {
  const [all, setAll] = useState(false);
  const has = box.has!;
  const allowed = (box.meta as { allowed?: string[] } | undefined)?.allowed;
  const target = box.meta?.references ? (findTable(box.meta.references.table) as TableMeta | undefined) : undefined;
  const naming = target ? (labelColumn(target) as string | undefined) : undefined;
  const labelPath = box.kind === 'ref' && naming ? `${has.asks}.${naming}` : undefined;
  const text = hasValuesText(has.child, has.asks, labelPath);
  const held = useQuery<Count[]>({
    queryKey: ['run', state.activeConnection ?? '', 'facet', text],
    enabled: !allowed?.length,
    queryFn: async () => {
      const data = (await batchedBreakdown({ text, limit: MOST })) as {
        columns?: string[];
        rows?: Array<Record<string, unknown>>;
        errors?: unknown[];
      };
      if (data.errors?.length || !data.columns?.length) throw new Error(say('couldNotCountTheValues'));
      const keys = data.columns;
      return (data.rows ?? []).flatMap((row) => {
        const value = row[keys[0]];
        if (value == null || value === '') return [];
        const label = labelPath ? row[keys[1]] : undefined;
        return [{ value: String(value), count: 0, ...(label == null ? {} : { label: String(label) }) }];
      });
    },
    staleTime: 60_000,
    retry: false,
  });
  const selected = selectedValues(tail);
  const ticked = selected ?? [];
  const listed: Count[] = allowed?.length ? allowed.map((value) => ({ value, count: 0 })) : [...(held.data ?? [])];
  for (const value of ticked) if (!listed.some((c) => c.value === value)) listed.push({ value, count: 0 });
  const shown = all || listed.length <= SHORT + SLACK ? listed : listed.filter((c, i) => i < SHORT || ticked.includes(c.value));
  const counts = useQueries({ queries: shown.map((c) => recordCount(hasCountText(table.id, refinement, box.column, standing, c.value))) });
  const rule = columnDisplay(has.child, has.asks) as DisplayRule | null;
  const toggle = (value: string, on: boolean) => {
    const next = on ? [...ticked, value] : ticked.filter((v) => v !== value);
    const order = listed.map((c) => c.value);
    set(valuesTail(next.sort((a, b) => order.indexOf(a) - order.indexOf(b))));
  };
  return (
    <Facet box={box} tail={tail} set={set}>
      {selected === null && <Unshown box={box} table={table} tail={tail} />}
      {(held.isError || counts.some((count) => count.isError)) && <p className="facet-note">{say('countsUnavailable')}</p>}
      <ul className="facet-values">
        {shown.map((c, i) => {
          const said = c.label ?? wordFor(rule, c.value) ?? (allowed?.length ? vocabularyWord(c.value) : c.value);
          const n = counts[i]?.data;
          return (
            <li key={c.value}>
              <label className="facet-option" title={c.label ? `${has.asks} = ${c.value}` : undefined}>
                <input
                  type="checkbox"
                  data-value={c.value}
                  checked={ticked.includes(c.value)}
                  onChange={(e) => toggle(c.value, e.target.checked)}
                />
                <span className="facet-option-label">{said}</span> {/* Blank until known, never a guessed zero. */}
                <span className="facet-count">{typeof n === 'number' ? counted(n) : ''}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {!all && listed.length > shown.length && (
        <button type="button" className="facet-more" onClick={() => setAll(true)}>
          {say('showAll', { listedCount: listed.length })}
        </button>
      )}
    </Facet>
  );
}

/* One of their segments (`any opportunity where open`): a yes, as a flag's facet is, with how many records it shows. */
function HasSegmentFacet({ box, table, refinement, standing, set }: FacetProps) {
  const count = useQuery(recordCount(hasCountText(table.id, refinement, box.column, standing)));
  const on = holdsCondition(refinement, box.column);
  return (
    <div className="facet" data-column={box.column}>
      <label className="facet-option facet-flag">
        <input type="checkbox" data-value="true" checked={on} onChange={(e) => set(e.target.checked ? WHOLE : '')} />
        <span className="facet-option-label">{box.label}</span>{' '}
        <span className="facet-count">{typeof count.data === 'number' ? counted(count.data) : ''}</span>
      </label>
    </div>
  );
}

/*
 * A record's tags (tagLists.ts): every tag, by name, ticked for any of them —
 * `tags has (bug, docs)`. The names are the tag table's, read as the rail
 * reads any values, through this reader's grants; a tag is listed whether
 * or not a record in view has it, as a vocabulary's value is.
 */
function TagsFacet({ box, tail, table, set }: FacetProps) {
  const tags = table.tags;
  // A list its definition spells out (a row-defined `choices` field, DefinedFields.tsx) offers those options, uncounted.
  const options = (box.meta as { allowed?: readonly string[] } | undefined)?.allowed;
  const text = tags ? `${tags.to} count by ${tags.label} sort ${tags.label}` : '';
  const listing = useQuery<string[]>({
    queryKey: ['run', state.activeConnection ?? '', 'facet', text],
    enabled: Boolean(tags) && !options,
    queryFn: async () => {
      const data = (await batchedBreakdown({ text, limit: MOST })) as {
        columns?: string[];
        rows?: Array<Record<string, unknown>>;
        errors?: unknown[];
      };
      if (data.errors?.length || !data.columns?.length) throw new Error(say('couldNotCountTheValues'));
      const key = data.columns[0];
      return (data.rows ?? []).flatMap((row) => (row[key] == null || row[key] === '' ? [] : [String(row[key])]));
    },
    staleTime: 60_000,
    retry: false,
  });
  const selected = selectedTags(tail);
  const ticked = selected ?? [];
  const listed = [...(options ?? listing.data ?? [])];
  for (const value of ticked) if (!listed.includes(value)) listed.push(value);
  const toggle = (value: string, on: boolean) => {
    const next = on ? [...ticked, value] : ticked.filter((v) => v !== value);
    set(tagsTail(next.sort((a, b) => listed.indexOf(a) - listed.indexOf(b))));
  };
  return (
    <Facet box={box} tail={tail} set={set}>
      {selected === null && <Unshown box={box} table={table} tail={tail} />}
      {listing.isError && <p className="facet-note">{say('countsUnavailable')}</p>}
      <ul className="facet-values">
        {listed.map((value) => (
          <li key={value}>
            <label className="facet-option">
              <input
                type="checkbox"
                data-value={value}
                checked={ticked.includes(value)}
                onChange={(e) => toggle(value, e.target.checked)}
              />
              <span className="facet-option-label">{value}</span>
            </label>
          </li>
        ))}
      </ul>
    </Facet>
  );
}

const truthy = (value: string) => value === '1' || value.toLowerCase() === 'true';

function FlagFacet({ box, tail, table, refinement, standing, set, more }: FacetProps) {
  const counts = useCounts(table, refinement, box.column, undefined, standing);
  const yes = counts.isSuccess ? (counts.data ?? []).filter((c) => truthy(c.value)).reduce((n, c) => n + c.count, 0) : null;
  const on = tail === '= true';
  return (
    /* Ticked, the box is its own Clear; a second one would only push the
       count out of line with every other facet's. */
    <Facet box={box} tail={on ? '' : tail} set={set} group={false} more={more}>
      {tail && !on && <Unshown box={box} table={table} tail={tail} />}
      <label className="facet-option facet-flag">
        <input type="checkbox" data-value="true" checked={on} onChange={(e) => set(e.target.checked ? '= true' : '')} />
        <span className="facet-option-label">{box.label}</span> <span className="facet-count">{yes === null ? '' : counted(yes)}</span>
      </label>
    </Facet>
  );
}

function DateFacet({ box, tail, table, set, onEnter, more }: FacetProps) {
  const name = useId();
  const range = rangeOf(tail);
  /* What the column is decides what it is asked: a stamp its past windows, a deadline what is overdue (filterRailModel.ts). */
  const presets = datePresets(box.meta);
  const preset = presets.find(([, t]) => t === tail);
  /* The ends are typed into a draft and applied on Enter or leaving the
     box: a date input reports every keystroke of a year as a whole date. */
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  useEffect(() => {
    setFrom(range.from);
    setTo(range.to);
  }, [range.from, range.to]);
  const commit = () => {
    if ((from && !isPickerDate(from)) || (to && !isPickerDate(to))) return false;
    if (from !== range.from || to !== range.to) set(rangeTail(from, to));
    return true;
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (commit()) onEnter?.();
    }
  };
  return (
    <Facet box={box} tail={tail} set={set} more={more}>
      {tail && !preset && !range.from && !range.to && <Unshown box={box} table={table} tail={tail} />}
      <div className="facet-values">
        {presets.map(([label, value]) => (
          <label key={value} className="facet-option">
            <input type="radio" name={name} data-value={value} checked={preset?.[1] === value} onChange={() => set(value)} />
            <span className="facet-option-label">{label}</span>
          </label>
        ))}
      </div>
      <div className="facet-range facet-date-range">
        <div className="facet-range-end">
          <label htmlFor={`${name}-from`}>{say('from')}</label>
          <DateField
            id={`${name}-from`}
            aria-label={say('from')}
            className="facet-input"
            value={from}
            max={isPickerDate(to) ? to : undefined}
            locale={formatLocale()}
            timezone={formatTimezone()}
            onChange={setFrom}
            onBlur={commit}
            onKeyDown={onKey}
          />
        </div>
        <div className="facet-range-end">
          <label htmlFor={`${name}-to`}>{say('to')}</label>
          <DateField
            id={`${name}-to`}
            aria-label={say('to')}
            className="facet-input"
            value={to}
            min={isPickerDate(from) ? from : undefined}
            locale={formatLocale()}
            timezone={formatTimezone()}
            onChange={setTo}
            onBlur={commit}
            onKeyDown={onKey}
          />
        </div>
      </div>
    </Facet>
  );
}

/** The shape a plain column's facet takes, judged once from its values over the view's standing rows. */
function useFacetShape(table: TableMeta, column: string, standing: string, numeric: boolean, bare = false) {
  const text = facetShapeText(table.id, column, standing);
  return useQuery<AutoShape>({
    queryKey: ['run', state.activeConnection ?? '', 'facet-shape', text, bare],
    queryFn: async () => {
      const data = (await batchedBreakdown({ text, limit: MOST + 1 })) as { rows?: unknown[]; errors?: unknown[] };
      if (data.errors?.length) throw new Error(say('couldNotCountTheValues'));
      const distinct = data.rows?.length ?? 0;
      /* A name with nothing to list has no checklist to offer: it stays the box that searches it. */
      if (bare && distinct === 0) return 'text';
      return autoShape(numeric, distinct, distinct <= MOST);
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

function AutoFacet(props: FacetProps & { unit?: FacetUnit; bare?: boolean }) {
  const { box, tail, table, standing, set, more, bare } = props;
  const numeric = numericColumn(box);
  const shape = useFacetShape(table, box.column, standing, numeric, bare);
  const settled = shape.isError ? (numeric ? 'range' : 'text') : shape.data;
  /* Until the shape is known the facet is its name alone — never a box that
     turns into a list under the reader's pointer. */
  if (!settled)
    return (
      <Facet box={box} tail={tail} set={set} more={more} busy>
        {tail ? <Unshown box={box} table={table} tail={tail} /> : null}
      </Facet>
    );
  if (settled === 'values') return <ValuesFacet {...props} />;
  if (settled === 'range') return <RangeFacet {...props} />;
  return <TextFacet key={tail} {...props} />;
}

/* What a reader types as a figure, without its dressing: "$15,000" is 15000. */
const plain = (text: string) => text.replace(/[\s,$€£]/g, '');

function currencySymbol(currency: string): string | undefined {
  try {
    return new Intl.NumberFormat(formatLocale(), { style: 'currency', currency }).formatToParts(0).find((part) => part.type === 'currency')
      ?.value;
  } catch {
    return undefined;
  }
}

/**
 * A range over money kept in minor units is typed and read in the major unit, as the cards say it: the question
 * keeps the stored figure (179500), the boxes hold what a person means by it (1795). Any other column is as it is.
 */
function minorRange(rule: DisplayRule | null, currency: string | undefined) {
  if (!rule?.minor || rule.format !== 'money') return null;
  const code = rule.currency || currency || defaultCurrency();
  return {
    /* "1795.00" is typed as 1795: the cents are said only where there are some. */
    toMajor: (stored: string) => minorToMajor(stored, code)?.replace(/\.0+$/, '') ?? stored,
    /* A figure that is no amount in this currency (too many decimals) is left as typed, and ignored by the range. */
    toMinor: (typed: string) => {
      const minor = typed === '' ? undefined : majorToMinor(typed, code);
      return minor === undefined ? typed : String(minor);
    },
  };
}

function RangeFacet({ box, tail, table, set, unit, onEnter, more }: FacetProps & { unit?: FacetUnit }) {
  const kept = numberRangeOf(tail);
  const minor = minorRange(columnDisplay(table.id, box.column) as DisplayRule | null, unit?.currency);
  const range = minor ? { min: minor.toMajor(kept.min), max: minor.toMajor(kept.max) } : kept;
  /* Applied on Enter or leaving the box, as a date's range is: a figure
     typed a digit at a time is not a new question at every digit. */
  const [min, setMin] = useState(range.min);
  const [max, setMax] = useState(range.max);
  useEffect(() => {
    setMin(range.min);
    setMax(range.max);
  }, [range.min, range.max]);
  const commit = () => {
    const ends = minor ? [minor.toMinor(plain(min)), minor.toMinor(plain(max))] : [plain(min), plain(max)];
    const next = numberRangeTail(ends[0], ends[1]);
    if (next !== numberRangeTail(kept.min, kept.max)) set(next);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      onEnter?.();
    }
  };
  const symbol = unit?.currency ? currencySymbol(unit.currency) : undefined;
  /* Each end is a compact Field, so the rail's boxes are the filter bar's
     fields in every look. The input is named by the word alone: the symbol
     and the unit beside it stay out of the label, and "Min$" is not a name. */
  const end = (which: 'min' | 'max', value: string, change: (value: string) => void) => (
    <Field size="compact" className="facet-range-end" label={which === 'min' ? say('min') : say('max')}>
      {(control) => (
        <span className="facet-affix">
          {symbol && (
            <span className="facet-affix-text" aria-hidden="true">
              {symbol}
            </span>
          )}
          <input
            {...control}
            type="text"
            inputMode="decimal"
            className="field-control facet-input"
            data-value={which}
            value={value}
            placeholder={say('common.any')}
            onChange={(e) => change(e.target.value)}
            onBlur={commit}
            onKeyDown={onKey}
          />
          {unit?.unit && (
            <span className="facet-affix-text" aria-hidden="true">
              {unit.unit}
            </span>
          )}
        </span>
      )}
    </Field>
  );
  return (
    <Facet box={box} tail={tail} set={set} more={more}>
      {tail && !range.min && !range.max && <Unshown box={box} table={table} tail={tail} />}
      <div className="facet-range">
        {end('min', min, setMin)}
        {end('max', max, setMax)}
      </div>
    </Facet>
  );
}

/* Keyed by its tail, so a condition changed elsewhere redraws the box with it. */
function TextFacet({ box, tail, table, standing, set, onEnter, more }: FacetProps) {
  const id = useId();
  const fuzzy = box.meta ? columnKind(box.meta.type) === 'text' : false;
  const initial = tail.startsWith('contains ')
    ? unquote(tail.slice('contains '.length))
    : tail.startsWith('= ')
      ? `${fuzzy ? '=' : ''}${unquote(tail.slice(2))}`
      : '';
  const [text, setText] = useState(initial);
  const suggesting = useArrived(SuggestBox, Boolean(box.suggest?.length));
  const commit = (raw = text) => {
    if (raw !== initial) set(boxTail(box, { raw }, tail));
  };
  const inputProps = {
    id,
    type: 'search',
    className: 'field-control facet-input',
    'data-value': 'text',
    placeholder: fuzzy ? say('contains') : say('equals'),
    title: fuzzy ? say('common.matchesAnywhereInTheValue') : undefined,
    onBlur: () => commit(),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
        onEnter?.();
      }
    },
  };
  return (
    <Facet box={box} tail={tail} set={set} group={false} more={more}>
      <label className="facet-label" htmlFor={id}>
        {box.label}
      </label>
      {tail && !initial && <Unshown box={box} table={table} tail={tail} />}
      {/* In a compact field's dress: the facet's name above is its label. */}
      <div className="form-field form-field-compact">
        {suggesting && box.suggest ? (
          <SuggestBox
            table={table.id}
            columns={box.suggest}
            standing={standing}
            text={text}
            onText={setText}
            onPick={(value) => {
              commit(value);
              onEnter?.();
            }}
            inputProps={inputProps}
          />
        ) : (
          <input {...inputProps} value={text} onChange={(e) => setText(e.target.value)} />
        )}
      </div>
    </Facet>
  );
}

/**
 * How many rows a draft question shows — what the sheet's button and a list
 * bar's picker say before they apply it. Under the view's standing condition,
 * as the list itself is: without it "Show 55" counted the sold cars the list
 * never shows.
 */
export function useDraftCount(table: TableMeta, standing: string, draft: string): number | null | undefined {
  const q = squeeze(`${table.id} ${andQuery(standing, draft)}`);
  return useQuery<number | null>({
    queryKey: ['count', state.activeConnection ?? '', q],
    queryFn: async () => {
      const data = await api('/api/run', { q, limit: 1 });
      return 'total' in data && !data.errors?.length && typeof data.total === 'number' ? data.total : null;
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  }).data;
}

interface SheetProps extends Omit<RailProps, 'onChange' | 'status'> {
  onApply: (refinement: string) => void;
  onClose: () => void;
}

/**
 * The rail on a phone: the same facets in a sheet over the list, edited as
 * a draft — the counts follow the draft — and applied by one button that
 * says what it will show.
 */
export function FilterSheet({ refinement, onApply, onClose, ...rail }: SheetProps) {
  const [draft, setDraft] = useState(refinement);
  const n = useDraftCount(rail.table, rail.standing ?? '', draft);
  return (
    <Modal className="filter-sheet" fullscreen="mobile" ariaLabel={say('common.filtersButton')} onClose={onClose}>
      <FilterRail {...rail} refinement={draft} onChange={setDraft} status={typeof n === 'number' ? `${counted(n)} match` : undefined} />
      <div className="filter-sheet-foot">
        <Button onClick={onClose}>{say('common.cancel')}</Button>
        <Button intent="primary" onClick={() => onApply(draft)}>
          {typeof n === 'number' ? say('showCount', { count: counted(n) }) : say('common.showResults')}
        </Button>
      </div>
    </Modal>
  );
}
