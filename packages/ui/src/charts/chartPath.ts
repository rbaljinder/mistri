/**
 * The shapes a chart draws, as path data and arc lengths, with no drawing in it: a line through points (straight or
 * a monotone curve), the area under it, a donut's arcs and the ring round one of them. Shared by the declarative
 * dashboard charts (the kit's) and the free-form page charts (`charts.ts`). No React and no DOM.
 */

/** A coordinate as path data says it: a tenth of a unit is finer than a dashboard chart at its own size can show. */
export const f1 = (n: number) => n.toFixed(1);

type PathPoint = readonly [x: number, y: number];

/**
 * A path through points: straight segments, or with `smooth` a monotone cubic (Fritsch–Carlson) — a curve that
 * never overshoots its points, so a smooth line still never says a value the data did not reach. Two points are a
 * straight segment either way, and one is a move with nothing drawn. `digits` is how finely a coordinate is
 * written: one place, or two where a drawing is small enough for a tenth to show (a spark 24px high).
 */
export function linePath(pts: ReadonlyArray<PathPoint>, smooth = false, digits = 1): string {
  const f = (n: number) => n.toFixed(digits);
  if (!smooth || pts.length < 3) return pts.map(([px, py], i) => `${i ? 'L' : 'M'}${f(px)},${f(py)}`).join(' ');
  const n = pts.length;
  const at = (i: number) => pts[i]!;
  const dx = (i: number) => at(i + 1)[0] - at(i)[0];
  const slope = Array.from({ length: n - 1 }, (_, i) => (at(i + 1)[1] - at(i)[1]) / (dx(i) || 1));
  const s = (i: number) => slope[i]!;
  const m = pts.map((_, i) => (i === 0 ? s(0) : i === n - 1 ? s(n - 2) : s(i - 1) * s(i) <= 0 ? 0 : (s(i - 1) + s(i)) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (s(i) === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / s(i),
      b = m[i + 1]! / s(i);
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * s(i);
      m[i + 1] = t * b * s(i);
    }
  }
  let d = `M${f(at(0)[0])},${f(at(0)[1])}`;
  for (let i = 0; i < n - 1; i++) {
    const third = dx(i) / 3;
    d += ` C${f(at(i)[0] + third)},${f(at(i)[1] + m[i]! * third)} ${f(at(i + 1)[0] - third)},${f(at(i + 1)[1] - m[i + 1]! * third)} ${f(at(i + 1)[0])},${f(at(i + 1)[1])}`;
  }
  return d;
}

/** The area between a line and a level (the zero line, the plot's floor): the line, then back along the level. */
export function areaPath(line: string, firstX: number, lastX: number, levelY: number, digits = 1): string {
  const f = (n: number) => n.toFixed(digits);
  return line ? `${line} L${f(lastX)},${f(levelY)} L${f(firstX)},${f(levelY)} Z` : '';
}

/** One slice of a donut, along a ring `circumference` units round. */
interface DonutArc {
  /** Its share of the whole, 0 to 1. A value that is not above zero has no share: a ring has no place for it. */
  share: number;
  /** Its full sweep along the ring, and where that starts, measured from the first slice's start. */
  sweep: number;
  start: number;
  /** The length drawn: the sweep less the gap that parts it from the next slice. */
  length: number;
}

/*
 * How a whole divides round a ring. Neighbours are parted by `gap` of the ground, so two slices of one hue read as
 * two; a slice too thin to spare the gap keeps its whole arc, because a slice that holds something is never drawn
 * as nothing. (The page charts took the gap from every slice once, and a share under half a percent vanished.)
 */
export function donutArcs(values: ReadonlyArray<number>, circumference: number, gap = 0): DonutArc[] {
  const held = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const whole = held.reduce((sum, value) => sum + value, 0);
  let start = 0;
  return held.map((value) => {
    const sweep = whole > 0 ? (circumference * value) / whole : 0;
    const arc = { share: whole > 0 ? value / whole : 0, sweep, start, length: sweep > gap * 2 ? sweep - gap : sweep };
    start += sweep;
    return arc;
  });
}

/** A point on a circle, `angle` in radians clockwise from 3 o'clock, as a drawing's y axis runs. */
function polarPoint(cx: number, cy: number, radius: number, angle: number): { x: number; y: number } {
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
}

/**
 * The outline of a donut slice's arc, for the focus ring round it (a shape takes no CSS outline): `from` and
 * `length` in hundredths of the circle from 3 o'clock, drawn 2px off a stroke `width` units wide. A widened stroke
 * was the ring once: the drawing's edge cut it, and on a pale slice it could not be told from the slice.
 */
export function sliceRing(center: number, radius: number, from: number, length: number, width = 7): string {
  const off = width / 2 + 1.05;
  const outer = radius + off;
  const inner = radius - off;
  const past = (100 * (1.05 / radius)) / (2 * Math.PI);
  const n = (value: number) => Number(value.toFixed(3));
  const point = (r: number, at: number) => {
    const { x, y } = polarPoint(center, center, r, (2 * Math.PI * at) / 100);
    return `${n(x)} ${n(y)}`;
  };
  const circle = (r: number) =>
    `M ${n(center + r)} ${center} A ${n(r)} ${n(r)} 0 1 1 ${n(center - r)} ${center} A ${n(r)} ${n(r)} 0 1 1 ${n(center + r)} ${center} Z`;
  /* A slice that is (nearly) the whole circle has no ends: its ring is two circles. */
  if (length + 2 * past >= 100) return `${circle(outer)} ${circle(inner)}`;
  const start = from - past;
  const end = from + length + past;
  const large = end - start > 50 ? 1 : 0;
  return `M ${point(outer, start)} A ${n(outer)} ${n(outer)} 0 ${large} 1 ${point(outer, end)} L ${point(inner, end)} A ${n(inner)} ${n(inner)} 0 ${large} 0 ${point(inner, start)} Z`;
}
