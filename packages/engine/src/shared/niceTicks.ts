/**
 * The levels an axis is ruled at: round numbers that cover the figures. An
 * axis ruled at its own minimum, middle and maximum said "$0 / $2,039.50 /
 * $4,079" — exact, and unreadable at a glance; a reader takes in "$0 / $2K /
 * $4K" without reading it. The step is a one, two or five of a power of ten,
 * chosen for about `intervals` steps across the range (the 1-2-5 rule, after
 * d3's `ticks`), and the scale is widened to the step's multiples on either
 * side, so the highest figure never stands over the top rule.
 */
interface NiceScale {
  /** The scale's low end: a multiple of the step at or under the smallest figure. */
  min: number;
  /** The scale's high end: a multiple of the step at or over the largest figure. */
  max: number;
  step: number;
  /** Every level from `min` to `max`, a step apart. */
  levels: number[];
}

function niceStep(span: number, intervals = 2): number {
  const raw = span / Math.max(1, intervals);
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const error = raw / power;
  return power * (error >= Math.sqrt(50) ? 10 : error >= Math.sqrt(10) ? 5 : error >= Math.sqrt(2) ? 2 : 1);
}

/** The round steps of a time taken, in seconds: a minute, five, a quarter hour, half, an hour, two, three, six,
    twelve, a day, two, three, a week, two, thirty days. A duration axis is ruled at "2d / 4d / 6d", not at
    the decimal 1-2-5 steps of its seconds ("2d 7h"). */
export const DURATION_STEPS: readonly number[] = [
  60, 300, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 259200, 604800, 1209600, 2592000,
];

/** Round levels over `[low, high]`; a flat range is given a step of room above it. `steps`, where given, are the
    only steps an axis may take (DURATION_STEPS), the one covering the range most closely in two to four. */
export function niceScale(low: number, high: number, intervals = 2, steps?: readonly number[]): NiceScale {
  if (steps?.length && Number.isFinite(low) && Number.isFinite(high) && high > low) {
    let best: NiceScale | undefined;
    for (const step of steps) {
      const min = Math.floor(low / step) * step,
        max = Math.ceil(high / step) * step;
      const count = Math.round((max - min) / step);
      if (count < 2 || count > 4) continue;
      if (!best || max - min < best.max - best.min)
        best = { min, max, step, levels: Array.from({ length: count + 1 }, (_, i) => min + i * step) };
    }
    if (best) return best;
  }
  let min = Math.min(low, high),
    max = Math.max(low, high);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 1, levels: [0, 1] };
  if (min === max) {
    if (max === 0) return { min: 0, max: 1, step: 1, levels: [0, 1] };
    const step = niceStep(Math.abs(max), 1);
    return niceScale(Math.min(0, min), Math.max(0, max) + (max > 0 ? 0 : step), intervals);
  }
  const step = niceStep(max - min, intervals);
  /* A step's own decimals, so 0.1 + 0.2 is said 0.3 and not 0.30000000000000004. */
  const places = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const round = (v: number) => Number(v.toFixed(places));
  min = round(Math.floor(min / step) * step);
  max = round(Math.ceil(max / step) * step);
  const levels: number[] = [];
  for (let v = min, i = 0; v <= max + step / 2 && i < 50; v = round(min + step * ++i)) levels.push(v);
  return { min, max, step, levels };
}
