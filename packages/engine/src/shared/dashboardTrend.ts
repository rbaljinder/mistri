/**
 * A metric's trend, in the words it is asked: the window it is drawn over and the read that draws it. Apart from
 * dashboardAsks.ts because it reads the window's span through autoBucket.ts, which only a drawn dashboard needs:
 * held there, every App's first page carried the bucketing a chart and a trend use (scripts/bundle-budget.mjs).
 * Asked by the client's metric (client/components/Dashboard.tsx) and by the server for a first page
 * (server/http/firstPaintRooms.ts), in the same words.
 */
import { andQuery } from './query.js';
import { type AutoUnit, unitForSpan, windowDays, windowPhraseOf } from './autoBucket.js';
import type { AskedSection } from './dashboardAsks.js';

/**
 * The window a metric's trend is drawn over — the reader's, else the author's own on `over` — and the units it is
 * read and drawn in: the span's unit (autoBucket.ts), read as days under a week so a week is added up on the client
 * (`trendPoints`) and never handed whole to one month. Null where the metric has no window the date grammar bounds.
 */
export function sparkWindow(
  section: Pick<AskedSection, 'query' | 'over' | 'windowPhrase'>,
  now = new Date(),
): { phrase: string; read: AutoUnit; unit: AutoUnit } | null {
  if (!section.over) return null;
  const phrase = section.windowPhrase ?? windowPhraseOf(section.query, section.over);
  const days = phrase ? windowDays(phrase, now) : null;
  if (!phrase || !days) return null;
  /* "today" is one day: a trend of fewer than four points is no line, and no slot is held for it. */
  if (days < 4) return null;
  const unit = unitForSpan(days);
  return { phrase, unit, read: unit === 'week' ? 'day' : unit };
}

/** The most periods a windowed trend reads: 182 days, or months and quarters past them, with room to spare. */
const TREND_PERIODS = 400;

/**
 * A metric's trend. Over a window, the metric over that window in the span's unit, so "last 30 days" draws thirty
 * days and "last 12 months" twelve months: every windowed metric has one, beside its change, unless its author said
 * `spark: false`. With no window, the author's `spark: true` is the measure's last twelve months, bucketed monthly by
 * the section's own clock (`over`), composed with whatever the card is narrowed to by other than time. None without a
 * clock.
 */
export function sparkText(
  section: Pick<AskedSection, 'table' | 'query' | 'windowBase' | 'windowPhrase' | 'measure' | 'over' | 'spark'>,
): string | null {
  /* An authored false is heard over a window too: a card can be a figure alone, which it once could not say. */
  if (!section.over || section.spark === false) return null;
  const window = sparkWindow(section);
  if (window)
    return [section.table, section.query, `${section.measure ?? 'count'} by ${window.read} ${section.over}`, `limit ${TREND_PERIODS}`]
      .filter(Boolean)
      .join(' ');
  if (!section.spark) return null;
  const trendBase = section.windowBase ?? section.query;
  return `${section.table} ${andQuery(trendBase, `${section.over} = last 12 months`)} ${section.measure ?? 'count'} by month ${section.over}`;
}
