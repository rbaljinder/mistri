/**
 * The dashboard's further chart shapes: a scatter for how two measures of the
 * same groups go together, a heat map for where a measure gathers across two keys
 * (weekday by hour), a waterfall for how rises and falls make a total, and a
 * treemap for how a whole divides when it has too many parts for a donut.
 *
 * A part on demand (ChartFigure.tsx): only a dashboard that draws one of these
 * fetches this module and its sheet. They keep Chart.tsx's grammar: one
 * series' color for one measure (a waterfall's falls in the second, which the
 * theme validator holds apart from the first for color-blind readers), a
 * categorical key in its vocabulary's order, levels in a gutter of their own,
 * words in the ink, a pill that names the point under the pointer, and every
 * value also a row of a table assistive technology reads; a treemap's tiles
 * are one hue in steps, not a colour each. Nothing moves (motion rule 8).
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { axisMarks, periodTick } from './Chart.js';
import { orderGroups } from './dashboardModel.js';
import { formatPercent as percentOf } from '../locale.js';
import { say as sayCopy } from '../copy/dashboards/components/ChartShapes.js';
import { textMeasure } from './textMeasure.js';
import { niceScale } from '@mistriwork/engine/shared/niceTicks.js';
import './ChartShapes.css';

/** How a figure is said; its `tick` is how an axis says a round level (Chart.tsx). */
type Say = ((value: unknown) => string) & { tick?: ((value: unknown) => string) & { steps?: readonly number[] } };
const tickSay = (say: Say) => say.tick ?? say;

export type ExtraShape = 'scatter' | 'heatmap' | 'waterfall' | 'treemap';

interface Answer {
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
}

interface ChartShapeProps {
  shape: ExtraShape;
  answer: Answer;
  /** The measure, as its reader says it. */
  say: Say;
  /** A scatter's `x` measure, as its reader says it. */
  sayX?: Say;
  /** A scatter's two measures by their words ("count", "sum amount"). */
  names?: { x: string; y: string };
  /** The first key's value as its reader says it, and the second's for a heat map. */
  label: (key: unknown) => string;
  seriesLabel?: (key: unknown) => string;
  vocabulary?: readonly string[];
  seriesVocabulary?: readonly string[];
  wide: number;
  high?: number;
  limit?: number;
  target?: number;
}

const pct = (share: number) => percentOf(share, { maximumFractionDigits: 0 });
const f1 = (n: number) => n.toFixed(1);
/** A period the grammar buckets by ("2026-08", "2026-Q3"), which keeps the calendar's order. */
const PERIOD = /^\d{4}(-\d{2}(-\d{2})?|-Q[1-4])?$/;
/** The width a tick's words take at the axis's 11px, budgeted as Chart.tsx budgets it. */
const tickWidth = (text: string) => text.length * 6.6 + 4;
const finite = (value: unknown) => Number.isFinite(Number(value)) && value !== null && value !== '';

/** One key's values in a fixed order: numbers and periods ascending, a vocabulary's words in its order, the rest as read. */
function keyOrder(keys: unknown[], vocabulary?: readonly string[]): string[] {
  const seen = [...new Set(keys.map((key) => (key == null ? '' : String(key))))];
  if (seen.every((key) => key !== '' && Number.isFinite(Number(key)))) {
    const sorted = seen.sort((a, b) => Number(a) - Number(b));
    /* A run of whole numbers — an hour or a weekday bucket — keeps its empty steps, so 8 AM with no moves is a
       pale column between 7 and 9, not a gap the eye cannot see. Spelled as the answer spells them ("08"). */
    const first = Number(sorted[0]),
      last = Number(sorted[sorted.length - 1]);
    if (sorted.every((key) => Number.isInteger(Number(key))) && last - first < 48) {
      const width = sorted[0].length;
      return Array.from({ length: last - first + 1 }, (_, i) => String(first + i).padStart(width, '0'));
    }
    return sorted;
  }
  if (seen.every((key) => PERIOD.test(key))) return seen.sort();
  const rank = new Map((vocabulary ?? []).map((word, at) => [word, at]));
  return seen
    .map((key, at) => ({ key, at, place: rank.get(key) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.place - b.place || a.at - b.at)
    .map((entry) => entry.key);
}

/** The levels a scale is ruled at: its ends and its middle. */
/** The levels a scale is ruled at: round ones covering it (shared/niceTicks.ts). */
const levelsOf = (min: number, max: number, steps?: readonly number[]) => niceScale(min, max, 2, steps);

/** The table every drawing is also read as. */
function DataTable({ head, rows }: { head?: string[]; rows: string[][] }) {
  return (
    <div className="visually-hidden">
      <table className="chart-data">
        {head && (
          <thead>
            <tr>
              {head.map((cell, i) => (
                <th key={i} scope="col">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <th scope="row">{row[0]}</th>
              {row.slice(1).map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The pill over the pointed-at mark, as a bar chart's: kept inside the figure. */
function Tip({ text, at, top, wide }: { text: string; at: number; top: number; wide: number }) {
  const width = tickWidth(text) + 12;
  const left = Math.min(Math.max(at - width / 2, 0), wide - width);
  return (
    <g className="chart-bar-tip" aria-hidden="true">
      <rect x={f1(left)} y={f1(Math.max(2, top))} width={f1(width)} height={20} />
      <text x={f1(left + width / 2)} y={f1(Math.max(2, top) + 14)} textAnchor="middle">
        {text}
      </text>
    </g>
  );
}

/* ---------- scatter ---------- */

function Scatter({ answer, say, sayX = say, names, label, wide, high }: ChartShapeProps) {
  const [key, xs, ys] = answer.columns ?? [];
  const dots = (answer.rows ?? [])
    .filter((row) => finite(row[xs]) && finite(row[ys]))
    .map((row) => ({ key: row[key], x: Number(row[xs]), y: Number(row[ys]) }));
  const [near, setNear] = useState<number | null>(null);
  if (!dots.length) return null;
  const W = wide;
  const H = high ? Math.max(160, Math.round(high)) : Math.max(200, Math.min(Math.round(W / 2.2), 320));
  const yScale = levelsOf(Math.min(0, ...dots.map((d) => d.y)), Math.max(...dots.map((d) => d.y)) || 1, say.tick?.steps),
    xScale = levelsOf(Math.min(0, ...dots.map((d) => d.x)), Math.max(...dots.map((d) => d.x)) || 1, sayX.tick?.steps);
  const [minX, maxX, minY, maxY] = [xScale.min, xScale.max, yScale.min, yScale.max];
  const yLevels = yScale.levels,
    xLevels = xScale.levels;
  const gutter = Math.max(...yLevels.map((v) => tickWidth(tickSay(say)(v)))) + 6;
  const PAD = { top: 28, right: Math.max(...xLevels.map((v) => tickWidth(tickSay(sayX)(v)))) / 2 + 4, bottom: 24, left: gutter };
  const x = (v: number) => PAD.left + ((v - minX) / (maxX - minX || 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - minY) / (maxY - minY || 1)) * (H - PAD.top - PAD.bottom);
  const pick = (event: ReactPointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width) return;
    // screen-px: the pointer's ruler, mapped into viewBox units by the ratio.
    const px = ((event.clientX - box.left) / box.width) * W,
      py = ((event.clientY - box.top) / box.height) * H;
    let best = 0;
    dots.forEach((d, i) => {
      if (Math.hypot(x(d.x) - px, y(d.y) - py) < Math.hypot(x(dots[best].x) - px, y(dots[best].y) - py)) best = i;
    });
    setNear(best);
  };
  const active = near === null ? undefined : dots[near];
  return (
    <>
      <svg
        className="chart-scatter"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={sayCopy('scatterSummary', { count: dots.length, x: names?.x ?? '', y: names?.y ?? '' })}
        onPointerMove={pick}
        onPointerLeave={() => setNear(null)}
      >
        {yLevels.map((v) => (
          <g key={`y${v}`}>
            <line className="chart-grid" x1={PAD.left} x2={W - PAD.right} y1={f1(y(v))} y2={f1(y(v))} />
            <text className="chart-tick chart-y-tick" x={f1(PAD.left - 6)} y={f1(y(v) + 4)} textAnchor="end">
              {tickSay(say)(v)}
            </text>
          </g>
        ))}
        {xLevels.map((v) => (
          <text key={`x${v}`} className="chart-tick chart-x-tick" x={f1(x(v))} y={H - 6} textAnchor="middle">
            {tickSay(sayX)(v)}
          </text>
        ))}
        {dots.map((d, i) => (
          <circle key={i} className={`chart-scatter-dot${i === near ? ' is-active' : ''}`} cx={f1(x(d.x))} cy={f1(y(d.y))} r={4.5}>
            <title>{`${label(d.key)}: ${sayX(d.x)}, ${say(d.y)}`}</title>
          </circle>
        ))}
        {active && (
          <Tip text={`${label(active.key)} · ${sayX(active.x)} · ${say(active.y)}`} at={x(active.x)} top={y(active.y) - 30} wide={W} />
        )}
      </svg>
      <DataTable head={['', names?.x ?? '', names?.y ?? '']} rows={dots.map((d) => [label(d.key), sayX(d.x), say(d.y)])} />
    </>
  );
}

/* ---------- heat map ---------- */

/** A cell's shade: one of five steps of the first series over the surface, so a step reads apart from the next. */
const HEAT_STEPS = [14, 30, 46, 64, 82];

/**
 * Every how many columns a heat map names its column, so that every name it shows is whole: a row of hours at a
 * half width read "10 …", "11 …". Each name is measured at the head's 11px against a column's share of the grid,
 * after the row names' 8ch and the cells' 2px spacing; a name that is not shown stays for a reader.
 */
function headEvery(names: readonly string[], wide: number, measure = textMeasure('400 11px system-ui, sans-serif')): number {
  if (!names.length || !wide) return 1;
  const column = (wide - 88) / names.length - 2;
  const widest = Math.max(...names.map((name) => (measure ? measure(name) : name.length * 6)));
  return column > 0 ? Math.max(1, Math.ceil((widest + 4) / column)) : 1;
}

function Heatmap({ answer, say, label, seriesLabel = String, vocabulary, seriesVocabulary, wide }: ChartShapeProps) {
  const [rowKey, colKey, value] = answer.columns ?? [];
  const rowsIn = answer.rows ?? [];
  const [near, setNear] = useState<{ row: string; col: string } | null>(null);
  if (!rowsIn.length) return null;
  const rowKeys = keyOrder(
    rowsIn.map((row) => row[rowKey]),
    vocabulary,
  );
  const colKeys = keyOrder(
    rowsIn.map((row) => row[colKey]),
    seriesVocabulary,
  );
  const cells = new Map<string, number>();
  for (const row of rowsIn) cells.set(`${row[rowKey] ?? ''}\u0000${row[colKey] ?? ''}`, Number(row[value]) || 0);
  const values = [...cells.values()];
  const max = Math.max(...values, 0);
  const min = Math.min(...values.filter((v) => v > 0), max);
  let peak = { row: rowKeys[0], col: colKeys[0], value: -Infinity };
  for (const [at, v] of cells) if (v > peak.value) peak = { row: at.split('\u0000')[0], col: at.split('\u0000')[1], value: v };
  const step = (v: number) => (v <= 0 || max <= 0 ? -1 : Math.min(HEAT_STEPS.length - 1, Math.floor((v / max) * HEAT_STEPS.length - 1e-9)));
  const hovered = near ? cells.get(`${near.row}\u0000${near.col}`) : undefined;
  const every = headEvery(
    colKeys.map((col) => seriesLabel(col)),
    wide,
  );
  const summary = sayCopy('heatSummary', {
    rows: rowKeys.length,
    columns: colKeys.length,
    highest: say(peak.value),
    where: `${label(peak.row)}, ${seriesLabel(peak.col)}`,
  });
  return (
    <div className="chart-heat">
      {/* The grid may scroll in its own box (a phone's card): a keyboard reaches it, as a pointer does. */}
      <div className="chart-heat-scroll" data-scrolls="" role="region" aria-label={summary} tabIndex={0}>
        <table
          className="chart-heat-grid"
          style={{ '--heat-cols': colKeys.length } as CSSProperties}
          aria-label={summary}
          onPointerLeave={() => setNear(null)}
        >
          <thead>
            <tr>
              <td />
              {colKeys.map((col, i) => (
                <th key={col} scope="col" className={`chart-heat-col${every > 1 && i === colKeys.length - 1 ? ' is-end' : ''}`}>
                  {i % every === 0 ? seriesLabel(col) : <span className="visually-hidden">{seriesLabel(col)}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowKeys.map((row) => (
              <tr key={row}>
                <th scope="row" className="chart-heat-row">
                  {label(row)}
                </th>
                {colKeys.map((col) => {
                  const v = cells.get(`${row}\u0000${col}`) ?? 0;
                  const shade = step(v);
                  return (
                    <td
                      key={col}
                      className={`chart-heat-cell${near?.row === row && near.col === col ? ' is-active' : ''}`}
                      style={shade < 0 ? undefined : ({ '--heat': `${HEAT_STEPS[shade]}%` } as CSSProperties)}
                      onPointerEnter={() => setNear({ row, col })}
                    >
                      <span className="visually-hidden">{say(v)}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="chart-heat-foot">
        <p className="chart-heat-said" aria-hidden="true">
          {near ? `${label(near.row)} · ${seriesLabel(near.col)} — ${say(hovered ?? 0)}` : ' '}
        </p>
        <span className="chart-heat-legend" aria-hidden="true">
          {sayCopy('low')} {say(min)}
          {HEAT_STEPS.map((shade) => (
            <span key={shade} className="chart-heat-key" style={{ '--heat': `${shade}%` } as CSSProperties} />
          ))}
          {say(max)} {sayCopy('high')}
        </span>
      </div>
    </div>
  );
}

/* ---------- waterfall ---------- */

function Waterfall({ answer, say, label, vocabulary, wide, high, limit, target }: ChartShapeProps) {
  const [key, value] = answer.columns ?? [];
  const rowsIn = answer.rows ?? [];
  const periods = rowsIn.length > 0 && rowsIn.every((row) => row[key] != null && PERIOD.test(String(row[key])));
  const ordered = (
    periods ? [...rowsIn].sort((a, b) => String(a[key]).localeCompare(String(b[key]))) : orderGroups(rowsIn, key, value, vocabulary)
  ).slice(0, limit);
  const [near, setNear] = useState<number | null>(null);
  if (!ordered.length) return null;
  let running = 0;
  const steps = ordered.map((row) => {
    const change = Number(row[value]) || 0;
    const from = running;
    running += change;
    return { key: row[key], change, from, to: running, total: false };
  });
  const bars = [...steps, { key: null, change: running, from: 0, to: running, total: true }];
  const names = bars.map((bar, i) =>
    bar.total ? sayCopy('total') : periods ? periodTick(String(bar.key), i ? String(bars[i - 1].key) : undefined) : label(bar.key),
  );
  const W = wide;
  const H = high ? Math.max(120, Math.round(high)) : Math.max(180, Math.min(Math.round(W / 3), 260));
  const goal = target !== undefined && Number.isFinite(target) ? target : undefined;
  const max = Math.max(0, goal ?? 0, ...bars.map((bar) => Math.max(bar.from, bar.to)));
  const min = Math.min(0, ...bars.map((bar) => Math.min(bar.from, bar.to)));
  const scale = levelsOf(min, max, say.tick?.steps);
  const levels = scale.levels;
  const span = scale.max - scale.min || 1;
  const PAD = { top: 30, right: 6, bottom: 24, left: Math.max(...levels.map((v) => tickWidth(tickSay(say)(v)))) + 6 };
  const band = (W - PAD.left - PAD.right) / bars.length;
  const barWide = Math.max(2, Math.min(48, band * 0.64));
  const mid = (i: number) => PAD.left + band * (i + 0.5);
  const y = (v: number) => PAD.top + (1 - (v - scale.min) / span) * (H - PAD.top - PAD.bottom);
  const marks = axisMarks(names, mid, { centered: true });
  const active = near ?? bars.length - 1;
  const said = (bar: (typeof bars)[number]) =>
    bar.total
      ? `${sayCopy('total')} · ${say(bar.to)}`
      : `${names[bars.indexOf(bar)]} · ${bar.change >= 0 ? '+' : '−'}${say(Math.abs(bar.change))}`;
  return (
    <>
      <svg
        className="chart-waterfall"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={sayCopy('waterfallSummary', { count: steps.length, total: say(running) })}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          if (!box.width) return;
          // screen-px: the pointer's ruler, mapped into viewBox units by the ratio.
          const px = ((event.clientX - box.left) / box.width) * W;
          setNear(Math.min(bars.length - 1, Math.max(0, Math.floor((px - PAD.left) / band))));
        }}
        onPointerLeave={() => setNear(null)}
      >
        {levels.map((v) => (
          <g key={`l${v}`}>
            <line className="chart-grid" x1={PAD.left} x2={W - PAD.right} y1={f1(y(v))} y2={f1(y(v))} />
            <text className="chart-tick chart-y-tick" x={f1(PAD.left - 6)} y={f1(y(v) + 4)} textAnchor="end">
              {tickSay(say)(v)}
            </text>
          </g>
        ))}
        {bars.map((bar, i) => {
          const top = y(Math.max(bar.from, bar.to)),
            bottom = y(Math.min(bar.from, bar.to));
          const kind = bar.total ? 'is-total' : bar.change >= 0 ? 'is-rise' : 'is-fall';
          return (
            <g key={i}>
              {i > 0 && (
                <line
                  className="chart-waterfall-join"
                  x1={f1(mid(i - 1) + barWide / 2)}
                  x2={f1(mid(i) - barWide / 2)}
                  y1={f1(y(bars[i - 1].to))}
                  y2={f1(y(bars[i - 1].to))}
                />
              )}
              <rect
                className={`chart-waterfall-bar ${kind}${i === active ? ' is-active' : ''}`}
                x={f1(mid(i) - barWide / 2)}
                y={f1(top)}
                width={f1(barWide)}
                height={f1(Math.max(1, bottom - top))}
              >
                <title>{said(bar)}</title>
              </rect>
            </g>
          );
        })}
        {goal !== undefined && (
          <g className="chart-target">
            <line className="chart-target-line" x1={PAD.left} x2={W - PAD.right} y1={f1(y(goal))} y2={f1(y(goal))} />
          </g>
        )}
        {marks.map(({ index }) => (
          <text
            key={`m${index}`}
            className={`chart-tick chart-x-tick${index === active ? ' is-active' : ''}`}
            x={f1(Math.min(Math.max(mid(index), tickWidth(names[index]) / 2), W - tickWidth(names[index]) / 2))}
            y={H - 6}
            textAnchor="middle"
          >
            {names[index]}
          </text>
        ))}
        <Tip text={said(bars[active])} at={mid(active)} top={y(Math.max(bars[active].from, bars[active].to)) - 26} wide={W} />
      </svg>
      <DataTable
        rows={bars.map((bar, i) => [names[i], bar.total ? say(bar.to) : `${bar.change >= 0 ? '+' : '−'}${say(Math.abs(bar.change))}`])}
      />
    </>
  );
}

/* ---------- treemap ---------- */

interface Tile {
  key: unknown;
  value: number;
  series: number;
  other?: boolean;
}
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Tiles laid out squarified (Bruls, Huizing and van Wijk): each row of tiles
 * along the shorter side takes the next largest while that keeps its worst
 * aspect ratio from getting worse, so tiles stay near square and a size is
 * read as an area. In units of the box, which is drawn at any width.
 */
export function squarify(values: readonly number[], box: Box): Box[] {
  const out: Box[] = [];
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return values.map(() => ({ x: box.x, y: box.y, w: 0, h: 0 }));
  const scale = (box.w * box.h) / total;
  let { x, y, w, h } = box;
  let at = 0;
  const worst = (row: number[], side: number) => {
    const sum = row.reduce((s, v) => s + v, 0) * scale;
    const most = Math.max(...row) * scale,
      least = Math.min(...row) * scale;
    return Math.max((side * side * most) / (sum * sum), (sum * sum) / (side * side * least));
  };
  while (at < values.length) {
    const side = Math.min(w, h);
    const row = [values[at]];
    while (at + row.length < values.length && worst([...row, values[at + row.length]], side) <= worst(row, side))
      row.push(values[at + row.length]);
    const area = row.reduce((s, v) => s + v, 0) * scale;
    if (w >= h) {
      const across = area / h;
      let down = y;
      for (const v of row) {
        const tall = (v * scale) / across;
        out.push({ x, y: down, w: across, h: tall });
        down += tall;
      }
      x += across;
      w -= across;
    } else {
      const tall = area / w;
      let along = x;
      for (const v of row) {
        const across = (v * scale) / tall;
        out.push({ x: along, y, w: across, h: tall });
        along += across;
      }
      y += tall;
      h -= tall;
    }
    at += row.length;
  }
  return out;
}

/* A tile's name: 500 12px on 1.25 lines, inside 8px by 6px of padding and a 2px border; its figure a 15px line under a 2px gap. */
const TILE_X = 20;
const TILE_Y = 16;
const TILE_VALUE = 17;

/**
 * How a tile says its name, or null where it cannot say it whole: on one
 * line in 12px; else on two (three in a tall tile), broken between words;
 * else the same at 11px;
 * else not at all, and the tile's tooltip and the data table carry it.
 * Cut with an ellipsis, Depot's tiles read "Slee…" and "Tires …" — a name
 * that names nothing. `measure` gives a text's width at 12px.
 */
export function tileLabel(
  name: string,
  w: number,
  h: number,
  measure: (text: string) => number,
): { size: 12 | 11; lines: number; value: boolean } | null {
  const room = w - TILE_X;
  const high = h - TILE_Y;
  for (const size of [12, 11] as const) {
    const width = (text: string) => (measure(text) * size) / 12;
    const line = size * 1.25;
    if (high < line) continue;
    const value = (lines: number) => high >= lines * line + TILE_VALUE;
    if (width(name) <= room) return { size, lines: 1, value: value(1) };
    if (high < 2 * line) continue;
    const words = name.split(/\s+/).filter(Boolean);
    if (words.some((word) => width(word) > room)) continue;
    let lines = 1;
    let current = '';
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (width(next) <= room) current = next;
      else {
        lines += 1;
        current = word;
      }
    }
    if (lines <= Math.min(3, Math.floor(high / line))) return { size, lines, value: value(lines) };
  }
  return null;
}

/** At most this many tiles; the rest are one tile in the quiet ink. */
const TILES = 8;

/* One hue in steps, the largest deepest: a tile's size is read as its area, so a colour per tile said nothing more
   and five pastels made the treemap the loudest thing on its page. From 88% of the first series down to 24%, so the
   largest reads as the accent itself; a tile from DEEP_TILE up says its words in the ground's colour. */
const tileStep = (i: number, count: number) => Math.round(88 - (count > 1 ? (64 * i) / (count - 1) : 0));
const DEEP_TILE = 56;

type Rgb = readonly [number, number, number];
/** The colours a tile is mixed from and said in, as the page resolves them. */
interface TileInks {
  series: Rgb;
  surface: Rgb;
  text: Rgb;
  ground: Rgb;
}

/** A colour as the page computes it: `rgb(…)`, or `color(srgb …)` in 0–1. */
function rgbOf(said: string): Rgb | undefined {
  const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(said);
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255];
  const rgb = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(said);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : undefined;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/**
 * A tile's step and ink: the ground's colour where it reads on the step at 4.5:1, else the ink; where neither does
 * — a mid step of a deep hue, between the two — the step is lightened until the ink reads. Without the page's colours
 * (before the first paint), the plain threshold.
 */
function tileInk(step: number, inks: TileInks | null): { step: number; deep: boolean } {
  if (!inks) return { step, deep: step >= DEEP_TILE };
  const mixed = (share: number): Rgb =>
    [0, 1, 2].map((c) => (inks.series[c] * share + inks.surface[c] * (100 - share)) / 100) as unknown as Rgb;
  if (contrast(mixed(step), inks.ground) >= 4.5) return { step, deep: true };
  let lighter = step;
  while (lighter > 0 && contrast(mixed(lighter), inks.text) < 4.5) lighter -= 2;
  return { step: Math.max(0, lighter), deep: false };
}

function Treemap({ answer, say, label, wide, high, limit }: ChartShapeProps) {
  const [key, value] = answer.columns ?? [];
  const groups = (answer.rows ?? [])
    .map((row) => ({ key: row[key], value: Number(row[value]) || 0 }))
    .filter((group) => group.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit ?? undefined);
  const [near, setNear] = useState<number | null>(null);
  /* The tiles' names are measured in the face they are set in, once it is known. */
  const map = useRef<HTMLDivElement>(null);
  const [face, setFace] = useState<string | null>(null);
  const [inks, setInks] = useState<TileInks | null>(null);
  useLayoutEffect(() => {
    const host = map.current;
    if (!host) return;
    setFace(getComputedStyle(host).fontFamily || null);
    /* Each colour resolved as the page has it, through a probe: the tokens may be any CSS colour, and a look sets them. */
    const probe = document.createElement('span');
    probe.hidden = true;
    host.append(probe);
    const read = (color: string) => {
      probe.style.color = color;
      return rgbOf(getComputedStyle(probe).color);
    };
    const [series, surface, text, ground] = ['var(--chart-1, var(--accent))', 'var(--surface)', 'var(--ink)', 'var(--ground)'].map(read);
    probe.remove();
    if (series && surface && text && ground) setInks({ series, surface, text, ground });
  }, []);
  if (!groups.length) return null;
  const measured = face ? textMeasure(`500 12px ${face}`) : undefined;
  const measure = measured ?? ((text: string) => text.length * 6.6);
  const kept: Tile[] = groups.slice(0, groups.length > TILES ? TILES - 1 : TILES).map((group, i) => ({ ...group, series: i + 1 }));
  const rest = groups.slice(kept.length);
  if (rest.length) kept.push({ key: null, value: rest.reduce((sum, group) => sum + group.value, 0), series: 0, other: true });
  const W = wide;
  const H = high ? Math.max(160, Math.round(high)) : Math.max(200, Math.min(Math.round(W / 2), 320));
  const boxes = squarify(
    kept.map((tile) => tile.value),
    { x: 0, y: 0, w: W, h: H },
  );
  const whole = kept.reduce((sum, tile) => sum + tile.value, 0);
  const name = (tile: Tile) => (tile.other ? `${sayCopy('others')} (${rest.length})` : label(tile.key));
  return (
    <>
      <div
        ref={map}
        className="chart-treemap"
        style={{ aspectRatio: `${W} / ${H}` }}
        role="img"
        aria-label={sayCopy('treemapSummary', { count: groups.length, largest: `${label(groups[0].key)} ${say(groups[0].value)}` })}
        onPointerLeave={() => setNear(null)}
      >
        {kept.map((tile, i) => {
          const box = boxes[i];
          const said = tileLabel(name(tile), box.w, box.h, measure);
          const ink = tile.other ? undefined : tileInk(tileStep(i, kept.length - (rest.length ? 1 : 0)), inks);
          return (
            <div
              key={i}
              className={`chart-tile${tile.other ? ' is-other' : ''}${ink?.deep ? ' is-deep' : ''}${said?.size === 11 ? ' is-small' : ''}${near === i ? ' is-active' : ''}`}
              style={
                {
                  left: `${(box.x / W) * 100}%`,
                  top: `${(box.y / H) * 100}%`,
                  width: `${(box.w / W) * 100}%`,
                  height: `${(box.h / H) * 100}%`,
                  ...(ink ? { '--tile-step': `${ink.step}%` } : {}),
                } as CSSProperties
              }
              title={`${name(tile)}: ${say(tile.value)} (${pct((tile.value / whole) * 100)})`}
              onPointerEnter={() => setNear(i)}
            >
              {said && (
                <>
                  <span className="chart-tile-name">{name(tile)}</span>
                  {said.value && <span className="chart-tile-value">{say(tile.value)}</span>}
                </>
              )}
            </div>
          );
        })}
      </div>
      <p className="chart-heat-said" aria-hidden="true">
        {near === null ? ' ' : `${name(kept[near])} — ${say(kept[near].value)} · ${pct((kept[near].value / whole) * 100)}`}
      </p>
      <DataTable rows={kept.map((tile) => [name(tile), say(tile.value), pct((tile.value / whole) * 100)])} />
    </>
  );
}

/** The drawing for one of the further shapes, or nothing where the answer has nothing it can draw. */
export function ChartShape(props: ChartShapeProps) {
  const Shape = { scatter: Scatter, heatmap: Heatmap, waterfall: Waterfall, treemap: Treemap }[props.shape];
  return <Shape {...props} />;
}
