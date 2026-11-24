/**
 * Dashboard donut chart and focus ring arc geometry: how a whole divides into
 * slices with an accessible legend and drillable slice arcs.
 */
import { useState } from 'react';
import { donutArcs, sliceRing } from '@mistriwork/ui/charts/core.js';
import { formatPercent } from '../locale.js';
import { say as sayCopy } from '../copy/dashboards/components/Chart.js';
import { keyWord, measureOf, rampInk, TONE_INK, type ChartRow, type Say } from './chartAxes.js';

/* The ring round a slice that holds the keyboard (design.md, Access) is arc geometry with no drawing in it, so it
   lives with the charts' shared rules; it is passed on here for the callers that took it from the donut. */
export { sliceRing };

/**
 * A donut with its legend: how the whole divides, said twice — arc length
 * and a labelled figure. Past six slices the tail is gathered into "others".
 */
export function DonutChart({
  rows,
  say = String,
  sayLegend,
  label = keyWord,
  onPick,
  total,
  ordered,
  tone,
}: {
  rows: ChartRow[];
  say?: Say;
  sayLegend?: (totals: readonly number[]) => (value: unknown) => string;
  label?: (key: unknown) => string;
  /** A slice's display tone, where its column has them: slices wear the ink their dot and badge wear when every one has its own. */
  tone?: (key: unknown) => string | undefined;
  onPick?: ((value: unknown) => void) | null;
  /** What the figure in the middle is: "Total visitors", said under it. */
  total?: string;
  /** The slices are steps of a scale, in its order: drawn in steps of one hue (rampInk), not in categorical ones. */
  ordered?: boolean;
}) {
  /* The slice's stroke as the look draws it (.chart-slice: 7 units, 4.5 in Lumen's line charts), read as a slice takes
     the keyboard, the moment its ring is drawn: a look is picked while the page is open, and a stylesheet says it. */
  const [sliceWidth, setSliceWidth] = useState(7);
  const all = rows.flatMap((r) => {
    const measure = measureOf(r.value);
    return measure && measure.value > 0 ? [{ key: label(r.key), raw: r.key, ...measure }] : [];
  });
  if (!all.length) return <p className="note">{sayCopy('nothingToDivide')}</p>;
  const MAX_SLICES = 6;
  const slices: Array<{ key: string; raw?: unknown; value: number; exact?: string }> = all.slice(0, MAX_SLICES);
  const rest = all.slice(MAX_SLICES);
  if (rest.length) slices.push({ key: `others (${rest.length})`, value: rest.reduce((n, p) => n + p.value, 0) });
  const whole = slices.reduce((n, p) => n + p.value, 0);
  const sayFigure = sayLegend ? sayLegend([whole, ...slices.map((p) => p.value)]) : say;
  /* A slice's figure from its own digits where a number would round them, as every chart says a measure. */
  const saySlice = (p: { value: number; exact?: string }) => sayFigure(p.exact ?? p.value);
  const R = 15.9155; /* circumference 100, so dasharray speaks percent. */
  const C = 21;
  /* A step of the ramp rides in a property of its own, which the slice and its swatch both paint with. */
  /* A legend that names two slices in one ink says nothing, so slices wear their tones only where each is distinct. */
  const inks = ordered || rest.length || !tone ? undefined : slices.map((p) => TONE_INK[tone(p.raw) ?? '']);
  const toned = !!inks && inks.every(Boolean) && new Set(inks).size === inks.length;
  const color = (i: number) => (ordered ? 'var(--ramp)' : toned ? inks![i]! : `var(--chart-${i + 1}, var(--accent))`);
  const ramp = (i: number) => (ordered ? { ['--ramp' as string]: rampInk(i, slices.length) } : {});
  const opacity = (i: number) =>
    ordered || toned ? '1' : `var(--chart-series-opacity, ${(1 - i * (0.75 / Math.max(slices.length - 1, 1))).toFixed(2)})`;
  let at = 25; /* Start at 12 o'clock: dasharray's zero is 3 o'clock. */
  /* A hairline of the ground between slices, so neighbours of one hue read as two; a slice too thin to spare it keeps
     its whole arc. One slice is a ring, with nothing to part. */
  const GAP = slices.length > 1 ? 0.8 : 0;
  /* How the whole divides round the ring is the shared rule (donutArcs): in hundredths here, the circumference. */
  const arcs = donutArcs(
    slices.map((p) => p.value),
    100,
    GAP,
  );
  const rings = slices.map((p, i) => {
    const share = arcs[i].sweep;
    const drawn = arcs[i].length;
    /* A slice is a door where the legend's button is: the same raw value,
       the same "others" exclusion. A circle is not a button by itself, so
       a drillable slice carries the button's role, name and keyboard
       behaviour, and the legend button stays as the second way in. */
    const drillable = onPick && p.raw != null && !(rest.length && i === slices.length - 1);
    const said = `${p.key}: ${saySlice(p)} (${formatPercent(share, { maximumFractionDigits: 0 })})`;
    const arc = (
      <circle
        key={i}
        className={`chart-slice${drillable ? ' chart-slice-drill' : ''}`}
        cx={C}
        cy={C}
        r={R}
        strokeDasharray={`${drawn.toFixed(2)} ${(100 - drawn).toFixed(2)}`}
        strokeDashoffset={at.toFixed(2)}
        style={{ ...ramp(i), stroke: color(i), opacity: opacity(i) }}
      >
        {!drillable && <title>{said}</title>}
      </circle>
    );
    /* The door is the slice and its ring together: the ring is drawn (and read by grade) only while the door holds the
       keyboard's focus. The dash starts at -offset along a path that begins at 3 o'clock. */
    const door = drillable ? (
      <g
        key={i}
        className="chart-slice-door"
        role="button"
        tabIndex={0}
        aria-label={said}
        onClick={() => onPick!(p.raw)}
        onFocus={(event: React.FocusEvent<SVGGElement>) => {
          const slice = event.currentTarget.querySelector('.chart-slice');
          const width = slice ? parseFloat(getComputedStyle(slice).strokeWidth) : NaN;
          if (width > 0 && width !== sliceWidth) setSliceWidth(width);
        }}
        onKeyDown={(event: React.KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onPick!(p.raw);
          }
        }}
      >
        <title>{said}</title>
        {arc}
        <path className="chart-slice-ring" data-focus-ring="" d={sliceRing(C, R, -at, drawn, sliceWidth)} />
      </g>
    ) : (
      arc
    );
    at -= share;
    return door;
  });
  /* A picture must not hold buttons: where any slice drills, the figure
     is a group holding buttons, not an image — axe's nested-interactive
     fails a button inside role="img", and a screen reader would meet the
     slices as the picture's unnamed parts. Where nothing drills it stays
     an image, as before. */
  const anyDrillable = onPick && slices.some((p, i) => p.raw != null && !(rest.length && i === slices.length - 1));
  return (
    <div className={`chart-donut-wrap${ordered ? ' is-ordered' : ''}`}>
      <svg
        className="chart-donut"
        viewBox={`0 0 ${C * 2} ${C * 2}`}
        role={anyDrillable ? 'group' : 'img'}
        aria-label={sayCopy('inAll', { whole: sayFigure(whole), map: slices.map((p) => `${p.key} ${saySlice(p)}`).join(', ') })}
      >
        {rings}
        <text className="chart-donut-total" x={C} y={total ? C : C + 1.5} textAnchor="middle">
          {sayFigure(whole)}
        </text>
        {total && (
          <text className="chart-donut-caption" x={C} y={C + 4.5} textAnchor="middle">
            {total}
          </text>
        )}
      </svg>
      <ul className="chart-legend">
        {slices.map((p, i) => {
          const parts = (
            <>
              <span className="chart-swatch" style={{ ...ramp(i), background: color(i), opacity: opacity(i) }} />
              <span className="chart-legend-key">{p.key}</span>
              <span className="chart-legend-value">{saySlice(p)}</span>
              <span className="chart-legend-share">{formatPercent(arcs[i].sweep, { maximumFractionDigits: 0 })}</span>
            </>
          );
          const drillable = onPick && p.raw != null && !(rest.length && i === slices.length - 1);
          return (
            <li key={i}>
              {drillable ? (
                <button type="button" className="chart-legend-drill" onClick={() => onPick!(p.raw)}>
                  {parts}
                </button>
              ) : (
                parts
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
