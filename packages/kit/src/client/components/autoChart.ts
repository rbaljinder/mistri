/**
 * A chart whose `by` says `auto` (shared/autoBucket.ts): the unit it is cut into, decided before the read from the
 * window and, where the window does not say, the data's own extent; then coarsened locally while the answer is sparse.
 *
 * The unit is decided once per window. A refresh that finds the data a little denser or sparser keeps the unit the
 * reader is looking at, because a chart that changes its bars under a pointer, on a timer, is the layout shift this
 * product refuses; a reader's own pick of a window chooses again.
 */
import { useRef } from 'react';
import {
  autoKeyOf,
  chooseUnit,
  coarsen,
  planMeasure,
  readUnit,
  spanDaysBetween,
  spanDaysOf,
  unitForSpan,
  withUnit,
  type AutoUnit,
  type MeasurePlan,
} from '@mistriwork/engine/shared/autoBucket.js';
import { localeWeekStart } from '@mistriwork/engine/shared/weekStart.js';
import { shell } from '../shellMode.js';
import type { Section } from './dashboardModel.js';

interface Answer {
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  names?: Record<string, Record<string, string>>;
}

/** What a read gives back that this needs: the answer, and whether it is the last window's held while the next loads. */
export interface Read {
  data?: Answer;
  isPlaceholderData?: boolean;
}

interface AutoDrawn {
  answer: Answer | undefined;
  /** The unit the bars or points are in, said under the title. Absent until there is one to say. */
  unit: AutoUnit | undefined;
  /** A line with too few filled buckets to draw a line through: its points stand alone. */
  dots: boolean;
}

interface AutoChart {
  /** The section to ask, in the unit chosen; null while the span is still being read from the data. */
  ask: Section | null;
  /** The read's answer as it is drawn: coarsened where it adds up, and the unit it came to. */
  draw(read: Read): AutoDrawn;
}

/** The fewest filled buckets a line is drawn through: two points are a segment, and a segment says nothing of a trend. */
const LINE_FROM = 3;

const numberOrNull = (value: unknown): number | null => {
  const n = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(n) ? null : n;
};

/**
 * The plan for a section, or null for a chart that does not say `auto`. Called every render of every chart, in the
 * same order, so the hooks it makes (the span's read, the kept unit) are the chart's own.
 *
 * `read` asks the server in the dashboard's way (its cache, its refresh), so this module holds no fetching of its own.
 */
export function useAutoChart(section: Section, read: (text: string | null) => Read): AutoChart | null {
  const auto = autoKeyOf(section.by);
  const plan = planMeasure(section.measure);
  /* A measure adds up again when the date is the first key: the answer is then a row per period (and per value of a
     second key, which the period is coarsened within). A date second has its rows grouped by another key first. */
  const keys = (section.by ?? '').split(',').length;
  const addsUp = plan !== null && auto?.index === 0 && keys <= 2;
  const weekStart = localeWeekStart((shell().app() as { ui?: { locale?: string } } | null)?.ui?.locale);

  /* The window the reader picked rides on `over`; a chart with none of its own is held to the window its query
     writes on the date it cuts. */
  const windowDays = auto ? spanDaysOf(section.query, section.over ?? auto.column, new Date()) : null;
  /* What a window is, and so when the unit is chosen again: the table and column, and the window's own phrase. A
     pick of another filter changes the section's query and not this. */
  const epoch = auto ? `${section.table}|${section.over ?? ''}|${auto.column}|${windowDays ?? 'data'}` : '';
  const kept = useRef<{ epoch: string; base?: AutoUnit; unit?: AutoUnit; drawn?: AutoDrawn }>({ epoch: '' });
  if (kept.current.epoch !== epoch) kept.current = { epoch, drawn: kept.current.drawn };

  /* Under no window the span is the data's own: its first and last date, as the one-row answer of two measures, the
     grammar's own `min` and `max` (a read with no `by` is one group). */
  const needsExtent = Boolean(auto) && windowDays === null && !kept.current.base;
  const extent = read(
    needsExtent && auto ? [section.table, section.query, `min ${auto.column}, max ${auto.column}`].filter(Boolean).join(' ') : null,
  );

  if (!auto) return null;

  let base = kept.current.base;
  if (!base && windowDays !== null) base = unitForSpan(windowDays);
  if (!base && extent.data && !extent.isPlaceholderData) {
    const [from, to] = extent.data.columns ?? [];
    const row = extent.data.rows?.[0];
    const days = row ? spanDaysBetween(row[from], row[to]) : null;
    /* A table with no dates has nothing to draw: the finest unit is as good as any. */
    base = days === null ? 'day' : unitForSpan(days);
  }
  if (base) kept.current.base = base;
  if (!base) {
    return {
      ask: null,
      draw: () => kept.current.drawn ?? { answer: undefined, unit: undefined, dots: false },
    };
  }

  const reading = readUnit(base, addsUp);
  const ask: Section = {
    ...section,
    by: withUnit(section.by ?? '', reading),
    ...(addsUp && plan ? { measure: plan.reads.join(', ') } : {}),
  };
  /* One line, of few filled buckets; several lines are drawn as they are. */
  const dotted = (filled: number) => (!section.shape || section.shape === 'line') && keys === 1 && filled > 0 && filled < LINE_FROM;

  const draw = ({ data, isPlaceholderData }: Read): AutoDrawn => {
    /* A held answer is the last window's, in the last window's unit: drawn as it was, and never the data the unit
       is chosen from. */
    if (!data || isPlaceholderData) return kept.current.drawn ?? { answer: undefined, unit: undefined, dots: false };
    const columns = data.columns ?? [];
    let drawn: AutoDrawn;
    if (addsUp && plan && columns.length === keys + plan.reads.length && !(data.rows ?? []).some((row) => row[columns[0]] == null)) {
      const buckets = (data.rows ?? []).map((row) => ({
        key: String(row[columns[0]]),
        ...(keys === 2 ? { series: String(row[columns[1]]) } : {}),
        terms: plan.reads.map((_, i) => numberOrNull(row[columns[keys + i]])),
      }));
      const unit = kept.current.unit ?? chooseUnit({ base, keys: buckets.map((b) => b.key), addsUp: true, weekStart }).unit;
      kept.current.unit = unit;
      const rows = coarsen(buckets, plan as MeasurePlan, unit, weekStart);
      drawn = {
        answer: {
          columns: [...columns.slice(0, keys), 'value'],
          rows: rows.map((r) => ({ [columns[0]]: r.key, ...(keys === 2 ? { [columns[1]]: r.series } : {}), value: r.value })),
        },
        unit,
        dots: dotted(rows.length),
      };
    } else {
      kept.current.unit = base;
      drawn = { answer: data, unit: base, dots: dotted((data.rows ?? []).length) };
    }
    kept.current.drawn = drawn;
    return drawn;
  };
  return { ask, draw };
}
