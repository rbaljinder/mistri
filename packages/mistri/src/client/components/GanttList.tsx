/**
 * Records as bars across time: each from its start to its end (both days
 * counted), on a row of its own or on its group's row, against a ruler of
 * weeks or months and a line at today. The list's own question is asked once
 * for the whole span, up to LIMIT records, sorted by start, and the chart
 * says when there are more. A record with no end is a mark on its start.
 *
 * The keyboard reads it as a list (one Tab stop, the bar last visited): Up
 * and Down step between bars in reading order, Home and End to the ends, and
 * Enter opens the record. Each bar says its dates in words, so the chart is
 * readable without the picture. Dragging a bar to move its dates is not here
 * yet; the record's own form changes them.
 */
import './GanttList.css';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, keyOf, openRecord, state } from '@mistriwork/kit/client/core.js';
import { formatLocale, formatNumber } from '@mistriwork/kit/client/locale.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { splitQuery } from '@mistriwork/kit/client/clauses.js';
import { primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { AppGanttList } from '@mistriwork/engine/shared/listPresentations.js';
import { listPresentationColumns } from '@mistriwork/engine/shared/appListColumns.js';
import { namedCell } from '@mistriwork/kit/client/components/listColumn.js';
import type { ModalRecord } from './RecordModal.js';
import type { TableEntry } from '@mistriwork/kit/client/components/TableView.js';
import { say as sayCopy } from '../copy/lists/components/GanttList.js';

/** A chart is read whole; past this it says so rather than drawing a part as if it were all. */
const LIMIT = 500;
const DAY = 86_400_000;

/** A date or timestamp as its calendar day (days since 1970, UTC), or null when it is not one. */
export function dayOf(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const text = value instanceof Date ? value.toISOString() : String(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return null;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY);
}

interface GanttBar {
  id: string;
  key: Record<string, unknown>;
  title: string;
  first: number;
  /** The last day the bar covers; equal to `first` for a mark. */
  last: number;
  mark: boolean;
  /** 0–100, where the list names a progress column and the record has one. */
  done?: number;
}

interface GanttRow {
  name: string;
  /** The group this row stands under, drawn once as a band over its rows; unset where the list is not grouped. */
  band?: string;
  bars: Array<GanttBar & { lane: number }>;
  /** How many lanes the row stacks its bars in, so two that overlap never cover each other. */
  lanes: number;
}

/**
 * The rows in reading order. Ungrouped, a row per bar. Grouped, a band per group in the order each first starts
 * and under it a row per name (a home's leases share its row, one after the other); a row takes its bars' first
 * lane free by their start (a bar's last day and the next one's first may not share a lane), so a row is as tall
 * as the most that overlap at once.
 */
export function rowsOf(bars: Array<GanttBar & { group?: string }>, grouped: boolean): GanttRow[] {
  const sorted = [...bars].sort((a, b) => a.first - b.first || a.last - b.last || a.title.localeCompare(b.title));
  if (!grouped) return sorted.map((bar) => ({ name: bar.title, bars: [{ ...bar, lane: 0 }], lanes: 1 }));
  const groups = new Map<string, Map<string, GanttRow & { ends: number[] }>>();
  for (const bar of sorted) {
    const band = bar.group ?? '';
    const rows = groups.get(band) ?? new Map<string, GanttRow & { ends: number[] }>();
    const row = rows.get(bar.title) ?? { name: bar.title, band, bars: [], lanes: 0, ends: [] };
    let lane = row.ends.findIndex((end) => end < bar.first);
    if (lane < 0) lane = row.ends.length;
    row.ends[lane] = bar.last;
    row.lanes = Math.max(row.lanes, lane + 1);
    row.bars.push({ ...bar, lane });
    rows.set(bar.title, row);
    groups.set(band, rows);
  }
  return [...groups.values()].flatMap((rows) => [...rows.values()].map(({ ends: _ends, ...row }) => row));
}

/** The ruler's lower tier: a mark at each month's first (or each Monday, for a span under ten weeks). */
function ticksOf(from: number, to: number): Array<{ day: number; month: boolean; index: number }> {
  const out: Array<{ day: number; month: boolean; index: number }> = [];
  if (to - from < 70) {
    /* 1970-01-01 was a Thursday, so a Monday is a day ≡ 4 (mod 7). */
    for (let day = from + ((4 - (from % 7) + 7) % 7); day <= to; day += 7) out.push({ day, month: false, index: out.length });
    return out;
  }
  const start = new Date(from * DAY);
  for (let at = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1); at / DAY <= to;) {
    const d = new Date(at);
    out.push({ day: at / DAY, month: true, index: d.getUTCMonth() });
    at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return out;
}

/** The ruler's upper tier: each calendar year the span touches, from where it enters the span. */
function yearsOf(from: number, to: number): Array<{ day: number; year: number }> {
  const out: Array<{ day: number; year: number }> = [];
  for (let year = new Date(from * DAY).getUTCFullYear(); Date.UTC(year, 0, 1) / DAY <= to; year++) {
    out.push({ day: Math.max(from, Date.UTC(year, 0, 1) / DAY), year });
  }
  return out;
}

/** Every how many months a label fits: one if there is room for each, else a quarter, a half year, a year. */
function monthStep(width: number, months: number): number {
  if (!width || months <= 1) return 1;
  return [1, 2, 3, 6, 12].find((step) => (width / months) * step >= 36) ?? 12;
}

interface GanttListProps {
  table: TableMeta;
  spec: AppGanttList;
  entry: TableEntry;
  interactive?: boolean;
  label?: string;
  referenceLabels?: Record<string, string>;
  /** Today, as a day number; a test holds it still. */
  today?: number;
}

export function GanttList({ table, spec, entry, interactive = true, label, referenceLabels, today }: GanttListProps) {
  const connection = state.activeConnection ?? null;
  const columns = [...new Set([...primaryKey(table), ...listPresentationColumns(spec), ...Object.values(referenceLabels ?? {})])];
  const filter = splitQuery(entry.query).filter;
  const text = `${table.id}${filter ? ` ${filter}` : ''} sort ${spec.start} show ${columns.join(', ')}`;
  const answer = useQuery({
    queryKey: ['run', connection ?? '', 'gantt', text],
    queryFn: async () => {
      const data = (await api('/api/run', {
        q: text,
        limit: LIMIT,
        offset: 0,
        count: 'none',
        ...(connection ? ownedBy(connection) : {}),
      })) as {
        rows?: Array<Record<string, unknown>>;
        errors?: Array<{ message: string }>;
        more?: boolean;
      };
      if (data.errors?.length) throw new Error(data.errors[0].message);
      return { rows: data.rows ?? [], more: Boolean(data.more) };
    },
  });
  const rows = useMemo(() => {
    const bars: Array<GanttBar & { group?: string }> = [];
    for (const row of answer.data?.rows ?? []) {
      const first = dayOf(row[spec.start]);
      const key = keyOf(table, row) as Record<string, unknown> | null;
      if (first === null || !key) continue;
      const end = dayOf(row[spec.end]);
      const last = end === null || end < first ? first : end;
      const raw = spec.progress === undefined ? null : row[spec.progress];
      const done =
        raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw))
          ? undefined
          : Math.min(100, Math.max(0, Number(raw)));
      const named = spec.by === undefined ? undefined : namedCell(table, spec.by, row, referenceLabels).value;
      bars.push({
        id: JSON.stringify(key),
        key,
        title: String(namedCell(table, spec.primary, row, referenceLabels).value ?? sayCopy('untitled')),
        first,
        last,
        mark: end === null,
        ...(done === undefined ? {} : { done }),
        ...(spec.by === undefined
          ? {}
          : { group: named === null || named === undefined || named === '' ? sayCopy('noGroup') : String(named) }),
      });
    }
    return rowsOf(bars, spec.by !== undefined);
  }, [answer.data, spec, table, referenceLabels]);
  const bars = rows.flatMap((row) => row.bars);
  /* A band over its rows, each group its own block so the band holds the top only while its rows are in view. */
  const groups = useMemo(() => {
    const out: Array<{ band?: string; rows: GanttRow[] }> = [];
    for (const row of rows) {
      const last = out[out.length - 1];
      if (last && last.band === row.band && row.band !== undefined) last.rows.push(row);
      else out.push({ band: row.band, rows: [row] });
    }
    return out;
  }, [rows]);
  const now = today ?? Math.floor(Date.now() / DAY);
  /* The span is every bar's with a day's margin each side; today is in it when it is near. */
  const from = Math.min(...bars.map((bar) => bar.first)) - 1;
  const to = Math.max(...bars.map((bar) => bar.last)) + 2;
  const span = Math.max(1, to - from);
  const at = (day: number) => `${(((day - from) / span) * 100).toFixed(3)}%`;
  const locale = formatLocale();
  const dayName = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const monthName = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  const weekName = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const said = (bar: GanttBar) =>
    bar.mark
      ? sayCopy('onDay', { title: bar.title, day: dayName.format(bar.first * DAY) })
      : sayCopy('fromTo', { title: bar.title, from: dayName.format(bar.first * DAY), to: dayName.format(bar.last * DAY) }) +
        (bar.done === undefined ? '' : sayCopy('done', { share: formatNumber(Math.round(bar.done)) }));

  /* The track's width, to thin the month labels to what fits; unknown (0) until measured, and then all are drawn. */
  const ruler = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  const measured = !!answer.data && bars.length > 0;
  useEffect(() => {
    const node = ruler.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => setWidth(node.clientWidth));
    watch.observe(node);
    setWidth(node.clientWidth);
    return () => watch.disconnect();
  }, [measured]);
  const [active, setActive] = useState<string>();
  const current = bars.find((bar) => bar.id === active) ?? bars[0];
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const records: ModalRecord[] = bars.map((bar) => ({ table: table.id, key: bar.key, label: bar.title }));
  const go = (bar: GanttBar | undefined) => {
    if (!bar) return;
    setActive(bar.id);
    buttons.current.get(bar.id)?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!current) return;
    const index = bars.indexOf(current);
    const moves: Record<string, () => void> = {
      ArrowDown: () => go(bars[index + 1]),
      ArrowRight: () => go(bars[index + 1]),
      ArrowUp: () => go(bars[index - 1]),
      ArrowLeft: () => go(bars[index - 1]),
      Home: () => go(bars[0]),
      End: () => go(bars[bars.length - 1]),
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    move();
  };

  if (answer.isError) return <p className="gantt-note">{(answer.error as Error).message}</p>;
  if (!answer.data) return <div className="gantt" aria-busy="true" />;
  if (!bars.length) return <p className="gantt-note">{sayCopy('nothingHere')}</p>;
  const all = ticksOf(from, to);
  const step = all[0]?.month ? monthStep(width, all.length) : 1;
  const ticks = all.filter((tick) => !tick.month || tick.index % step === 0);
  const years = yearsOf(from, to);
  const yearName = new Intl.NumberFormat(locale, { useGrouping: false });
  return (
    <div className="gantt">
      <div className="gantt-chart" role="list" aria-label={label ?? table.name} onKeyDown={onKey}>
        <div className="gantt-ruler" aria-hidden="true">
          <span className="gantt-name" />
          <span className="gantt-track" ref={ruler}>
            {years.map((year) => (
              <span key={year.year} className="gantt-year" style={{ insetInlineStart: at(year.day) }}>
                {yearName.format(year.year)}
              </span>
            ))}
            {ticks.map((tick) => (
              <span key={tick.day} className="gantt-tick" style={{ insetInlineStart: at(tick.day) }}>
                {(tick.month ? monthName : weekName).format(tick.day * DAY)}
              </span>
            ))}
          </span>
        </div>
        {groups.map((group) => (
          <div key={group.band ?? group.rows[0].bars[0].id} className="gantt-group">
            {group.band !== undefined && (
              <div className="gantt-band" role="presentation">
                {group.band}
              </div>
            )}
            {group.rows.map((row) => (
              <div
                key={row.name + row.bars[0].id}
                className="gantt-row"
                role="listitem"
                style={{ '--lanes': row.lanes } as Record<string, number>}
              >
                <span className="gantt-name" title={row.name}>
                  {row.name}
                </span>
                <span className="gantt-track">
                  {ticks.map((tick) => (
                    <span key={tick.day} className="gantt-grid" style={{ insetInlineStart: at(tick.day) }} aria-hidden="true" />
                  ))}
                  {now >= from && now <= to && (
                    <span className="gantt-today" style={{ insetInlineStart: at(now + 0.5) }} aria-hidden="true" />
                  )}
                  {row.bars.map((bar) => (
                    <button
                      key={bar.id}
                      ref={(element) => {
                        if (element) buttons.current.set(bar.id, element);
                        else buttons.current.delete(bar.id);
                      }}
                      type="button"
                      className={`gantt-bar${bar.mark ? ' is-mark' : ''}`}
                      style={{
                        insetInlineStart: at(bar.first),
                        top: `${bar.lane * 26 + 16}px`,
                        ...(bar.mark ? {} : { width: at(bar.last + 1 - bar.first + from) }),
                        ...(bar.done === undefined ? {} : ({ '--done': `${bar.done}%` } as Record<string, string>)),
                      }}
                      tabIndex={bar === current ? 0 : -1}
                      aria-label={said(bar)}
                      title={said(bar)}
                      disabled={!interactive}
                      onFocus={() => setActive(bar.id)}
                      onClick={() => void openRecord(table.id, bar.key, bar.title, 'push', { records })}
                    ></button>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
      {answer.data.more && <p className="gantt-note">{sayCopy('firstOnly', { count: formatNumber(LIMIT) })}</p>}
    </div>
  );
}
