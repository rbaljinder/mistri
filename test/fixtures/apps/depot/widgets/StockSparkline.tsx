/**
 * On hand as a figure, and beside it in a grid the last thirty days of it as
 * a line: each day's closing count from the ledger (the highest on-hand a
 * movement left that day), carried across days nothing moved, ending at the
 * figure itself. A floor lead reads a falling line before the number is low.
 *
 * Presentation only, where the display rule stands (`display: { on_hand:
 * stockSparkline }`): sort, filter, totals and export keep the number. One
 * breakdown of the ledger answers every cell on the page — the same question
 * each cell asks, so the page's cache asks it once — and a cell with no row
 * to name its product (a record's field) draws the figure alone.
 */
import { useBreakdown, useFormat, type ValueProps } from '@mistriwork/mistri/ui';
import type { Rows } from '../mistri-schema.d.ts';
import './StockSparkline.css';

const DAYS = 30;
const WIDTH = 64;
const HEIGHT = 18;

/** The day `back` days before today, as the ledger's day buckets name it. */
const dayBefore = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);

/** Each of the last thirty days' closing count, carried across quiet days; undefined before the first movement seen. */
export function dailyOnHand(points: ReadonlyMap<string, number>, now: number): Array<number | undefined> {
  const days: Array<number | undefined> = [];
  let last: number | undefined;
  for (let back = DAYS - 1; back >= 0; back--) {
    const day = new Date(now - back * 86_400_000).toISOString().slice(0, 10);
    if (points.has(day)) last = points.get(day);
    days.push(last);
  }
  return days;
}

export default function StockSparkline({ value, row, compact }: ValueProps<number | string, Rows['product']>) {
  const format = useFormat();
  const ledger = useBreakdown('stock_movement', {
    by: 'product_id, day moved_at',
    measure: 'max on_hand_after',
    query: `moved_at >= ${dayBefore(DAYS - 1)}`,
    limit: 5000,
  });
  const figure = <span className="c-stock-sparkline-figure">{format.number(value)}</span>;
  const product = row?.id;
  if (!compact || product === undefined || !ledger.data) return figure;
  const points = new Map(
    ledger.data
      .filter((entry) => String(entry.product_id) === String(product))
      .map((entry) => [String(entry['day(moved_at)']), Number(entry['max(on_hand_after)'])] as const),
  );
  const days = dailyOnHand(points, Date.now());
  /* Today closes at what is on hand now, whatever the ledger's last movement said. */
  days[days.length - 1] = Number(value);
  const known = days
    .map((count, i) => ({ count, i }))
    .filter((day): day is { count: number; i: number } => day.count !== undefined && Number.isFinite(day.count));
  if (known.length < 2) return figure;
  const top = Math.max(1, ...known.map((day) => day.count));
  const x = (i: number) => ((i / (DAYS - 1)) * (WIDTH - 2) + 1).toFixed(1);
  const y = (count: number) => (HEIGHT - 1 - (count / top) * (HEIGHT - 2)).toFixed(1);
  const line = known.map((day) => `${x(day.i)},${y(day.count)}`).join(' ');
  const first = known[0].count;
  const falling = Number(value) < first;
  return (
    <span className="c-stock-sparkline" data-trend={falling ? 'down' : 'flat'}>
      <svg
        className="c-stock-sparkline-line"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width={WIDTH}
        height={HEIGHT}
        role="img"
        aria-label={`Last ${DAYS} days: from ${format.number(first)} to ${format.number(value)}`}
      >
        <polyline points={line} fill="none" />
      </svg>
      {figure}
    </span>
  );
}
