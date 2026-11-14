import { ArrowDown, ArrowUp, ChartBar, Minus, Table } from '@phosphor-icons/react';
import { type CSSProperties, type ReactNode, useMemo, useState } from 'react';
import { Scrub, ScrubTrack } from './behaviors/Scrub';
import { Button } from './Button';
import { useWidth } from './measure';
import { words } from './words';

/* What a dashboard is drawn with: a chart of series over categories, and the figures that are a number and not a
   chart at all. A chart here is read three ways and none of them is the colour: by passing over it (one readout
   for the place under the pointer, with every series in it), by the keyboard (the plot is one stop, arrows move
   along it and each place is said), and as a table (the same numbers in rows, a press away). The colours are the
   eight of theme/tokens.css, given in order to the series as they were handed in, so hiding one does not repaint
   the rest. */

export type ChartSeries = { id: string; label: string; values: (number | null)[] };

/* Round numbers along an axis: 1, 2, 2.5 or 5 times a power of ten, from at or under the least to at or over the most. */
export function niceTicks(min: number, max: number, about = 4): number[] {
  const high = max === min ? min + 1 : max;
  const raw = (high - min) / about;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((times) => times * power).find((candidate) => candidate >= raw) ?? 10 * power;
  const ticks: number[] = [];
  for (let value = Math.floor(min / step) * step; value <= Math.ceil(high / step) * step + step / 2; value += step) {
    ticks.push(Number(value.toPrecision(12)));
  }
  return ticks;
}

/* A number short enough for an axis or a tile: in full under ten thousand, then 12.9K, 4.2M. */
export function compact(value: number): string {
  return Math.abs(value) < 10_000
    ? value.toLocaleString(undefined, { maximumFractionDigits: 1 })
    : new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

const percent = (share: number): string => `${Math.round(share * 100)}%`;

const OTHER = '~other';
type Drawn = ChartSeries & { slot: number };

/* Eight colours can be told apart and a ninth cannot, so a ninth series is not given one: past eight, the first
   seven stand and the rest are one grey sum. */
function folded(series: ChartSeries[]): Drawn[] {
  if (series.length <= 8) return series.map((one, at) => ({ ...one, slot: at + 1 }));
  const rest = series.slice(7);
  const length = Math.max(...series.map((one) => one.values.length));
  const sum = Array.from({ length }, (_, at) => {
    const values = rest.map((one) => one.values[at]).filter((value): value is number => typeof value === 'number');
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  });
  return [
    ...series.slice(0, 7).map((one, at) => ({ ...one, slot: at + 1 })),
    { id: OTHER, label: words.otherSeries, values: sum, slot: 0 },
  ];
}

const colour = (slot: number): string => (slot === 0 ? 'var(--m-series-other)' : `var(--m-series-${slot})`);

/* A bar with its far end rounded and its near end square on the baseline. */
function bar(x: number, y: number, w: number, h: number, up: boolean): string {
  const r = Math.max(Math.min(4, w / 2, h), 0);
  return up
    ? `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
    : `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
}

export type ChartProps = {
  /* What the chart shows: its heading, and its name to a screen reader. */
  title: string;
  /* A line under the title: the period, the unit. */
  note?: ReactNode;
  /* The places along the bottom, and each series' value at each. A value that is not known is `null`, and is
     drawn as a gap and said as none. */
  categories: string[];
  series: ChartSeries[];
  /* `columns` side by side, `stacked` on one another, a `line`, or a line over a wash (`area`). */
  kind?: 'columns' | 'stacked' | 'line' | 'area';
  /* A value in full, for the readout and the table. */
  format?: (value: number) => string;
  /* A value on the axis; short. */
  axisFormat?: (value: number) => string;
  height?: number;
  /* A press, Enter or Space on a place: where a dashboard opens the records behind it. */
  onPick?: (at: number) => void;
  /* The numbers are being read again: the last drawing stays, dimmed, so nothing jumps. */
  loading?: boolean;
  actions?: ReactNode;
  headingLevel?: 2 | 3 | 4;
};

export function Chart({
  title,
  note,
  categories,
  series,
  kind = 'columns',
  format = (value) => value.toLocaleString(),
  axisFormat = compact,
  height = 220,
  onPick,
  loading,
  actions,
  headingLevel = 2,
}: ChartProps) {
  const [hidden, setHidden] = useState<string[]>([]);
  const [asTable, setAsTable] = useState(false);
  const [body, width] = useWidth(640);
  const all = useMemo(() => folded(series), [series]);
  const shown = all.filter((one) => !hidden.includes(one.id));
  const lines = kind === 'line' || kind === 'area';
  const stacked = kind === 'stacked';
  const count = categories.length;
  const Heading = `h${headingLevel}` as 'h3';

  const known = shown.flatMap((one) => one.values.slice(0, count)).filter((value): value is number => typeof value === 'number');
  const empty = count === 0 || known.length === 0;
  const totals = categories.map((_, at) => shown.reduce((total, one) => total + (one.values[at] ?? 0), 0));
  const ticks = niceTicks(Math.min(0, ...known), Math.max(0, ...(stacked ? totals : known)));
  const low = ticks[0] ?? 0;
  const high = ticks[ticks.length - 1] ?? 1;

  const said = (value: number | null | undefined): string => (typeof value === 'number' ? format(value) : words.noValue);
  const tickWords = ticks.map(axisFormat);
  const left = Math.max(...tickWords.map((word) => word.length)) * 6.4 + 14;
  const top = 10;
  const bottom = 24;
  const right = 10;
  const plotW = Math.max(width - left - right, 40);
  const plotH = height - top - bottom;
  const band = plotW / Math.max(count, 1);
  const y = (value: number): number => top + plotH * (1 - (value - low) / (high - low));
  const middle = (at: number): number => left + (at + 0.5) * band;
  // Along the bottom, as many names as fit beside one another, evenly taken.
  const every = Math.max(1, Math.ceil((Math.max(...categories.map((name) => name.length), 1) * 6.2 + 14) / band));

  const text = (at: number): string => {
    const each = shown.map((one) => (shown.length === 1 ? said(one.values[at]) : `${one.label} ${said(one.values[at])}`));
    return `${categories[at]}: ${each.join('; ')}`;
  };

  const toggle = (id: string) =>
    setHidden((now) => {
      if (now.includes(id)) return now.filter((other) => other !== id);
      // The last series standing stays: a chart of nothing answers nothing.
      return all.length - now.length > 1 ? [...now, id] : now;
    });

  const marks = (at: number | null) => {
    if (lines) {
      return shown.map((one) => {
        const runs: [number, number][][] = [];
        let run: [number, number][] = [];
        one.values.slice(0, count).forEach((value, index) => {
          if (typeof value === 'number') run.push([middle(index), y(value)]);
          else if (run.length) {
            runs.push(run);
            run = [];
          }
        });
        if (run.length) runs.push(run);
        const end = runs[runs.length - 1]?.at(-1);
        return (
          <g key={one.id} style={{ '--key': colour(one.slot) } as CSSProperties}>
            {runs.map((points, index) => {
              const path = points.map(([px, py], step) => `${step ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
              const first = points[0];
              const last = points[points.length - 1];
              return (
                <g key={index}>
                  {kind === 'area' && first && last && (
                    <path data-slot="chart-wash" d={`${path}L${last[0].toFixed(1)},${y(0)}L${first[0].toFixed(1)},${y(0)}Z`} />
                  )}
                  {points.length === 1 && first ? (
                    <circle data-slot="chart-dot" cx={first[0]} cy={first[1]} r={4} />
                  ) : (
                    <path data-slot="chart-line" d={path} />
                  )}
                </g>
              );
            })}
            {at === null && end && <circle data-slot="chart-dot" cx={end[0]} cy={end[1]} r={4} />}
            {at !== null && typeof one.values[at] === 'number' && (
              <circle data-slot="chart-dot" cx={middle(at)} cy={y(one.values[at] as number)} r={4.5} />
            )}
          </g>
        );
      });
    }
    if (stacked) {
      const w = Math.min(24, band * 0.6);
      return categories.map((_, index) => {
        let from = 0;
        const last = shown.findLast((one) => (one.values[index] ?? 0) > 0)?.id;
        return (
          <g key={index} data-at={at === index ? '' : undefined}>
            {shown.map((one) => {
              const value = Math.max(one.values[index] ?? 0, 0);
              if (value === 0) return null;
              const base = y(from);
              from += value;
              // Two pixels of the surface stand between a part and the one under it.
              const h = base - y(from) - (base === y(0) ? 0 : 2);
              if (h <= 0) return null;
              const x = middle(index) - w / 2;
              const yTop = y(from);
              return one.id === last ? (
                <path key={one.id} data-slot="chart-bar" d={bar(x, yTop, w, h, true)} fill={colour(one.slot)} />
              ) : (
                <rect key={one.id} data-slot="chart-bar" x={x} y={yTop} width={w} height={h} fill={colour(one.slot)} />
              );
            })}
          </g>
        );
      });
    }
    const w = Math.max(2, Math.min(24, (band * 0.72 - 2 * (shown.length - 1)) / Math.max(shown.length, 1)));
    const group = shown.length * w + (shown.length - 1) * 2;
    return categories.map((_, index) => (
      <g key={index} data-at={at === index ? '' : undefined}>
        {shown.map((one, place) => {
          const value = one.values[index];
          if (typeof value !== 'number' || value === 0) return null;
          const x = middle(index) - group / 2 + place * (w + 2);
          const zero = y(0);
          const tip = y(value);
          return (
            <path
              key={one.id}
              data-slot="chart-bar"
              d={value > 0 ? bar(x, tip, w, zero - tip, true) : bar(x, zero, w, tip - zero, false)}
              fill={colour(one.slot)}
            />
          );
        })}
      </g>
    ));
  };

  return (
    <figure data-slot="chart" data-loading={loading ? '' : undefined} aria-busy={loading || undefined}>
      <figcaption data-slot="chart-head">
        <div>
          <Heading data-slot="chart-title">{title}</Heading>
          {note && <p data-slot="chart-note">{note}</p>}
        </div>
        <div data-slot="chart-actions">
          {actions}
          {!empty && (
            <Button
              intent="quiet"
              size="sm"
              aria-pressed={asTable}
              aria-label={asTable ? words.showAsChart : words.showAsTable}
              title={asTable ? words.showAsChart : words.showAsTable}
              onClick={() => setAsTable((now) => !now)}
            >
              {asTable ? <ChartBar aria-hidden="true" /> : <Table aria-hidden="true" />}
            </Button>
          )}
        </div>
      </figcaption>
      {all.length > 1 && !empty && (
        <ul data-slot="chart-legend" aria-label={words.chartSeries}>
          {all.map((one) => (
            <li key={one.id}>
              <button type="button" aria-pressed={!hidden.includes(one.id)} onClick={() => toggle(one.id)}>
                <span data-slot="chart-key" data-shape={lines ? 'line' : 'box'} style={{ '--key': colour(one.slot) } as CSSProperties} />
                {one.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div data-slot="chart-body" ref={body} style={{ '--chart-h': `${height}px` } as CSSProperties}>
        {empty ? (
          <p data-slot="chart-empty">{words.nothingToChart}</p>
        ) : asTable ? (
          <div data-slot="chart-table">
            <table>
              <thead>
                <tr>
                  <td />
                  {all.map((one) => (
                    <th key={one.id} scope="col">
                      {one.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {categories.map((name, at) => (
                  <tr key={name}>
                    <th scope="row">{name}</th>
                    {all.map((one) => (
                      <td key={one.id}>{said(one.values[at])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Scrub count={count} text={text} onPick={onPick ? (at) => onPick(at) : undefined}>
            {(at) => (
              <>
                <svg width={width} height={height} aria-hidden="true" focusable="false">
                  {ticks.map((tick, index) => (
                    <g key={tick}>
                      <line
                        data-slot="chart-grid"
                        data-zero={tick === 0 ? '' : undefined}
                        x1={left}
                        x2={left + plotW}
                        y1={y(tick)}
                        y2={y(tick)}
                      />
                      <text data-slot="chart-tick" x={left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle">
                        {tickWords[index]}
                      </text>
                    </g>
                  ))}
                  {at !== null &&
                    (lines ? (
                      <line data-slot="chart-hair" x1={middle(at)} x2={middle(at)} y1={top} y2={top + plotH} />
                    ) : (
                      <rect data-slot="chart-band" x={left + at * band} y={top} width={band} height={plotH} />
                    ))}
                  {marks(at)}
                  {categories.map(
                    (name, index) =>
                      index % every === 0 && (
                        <text key={index} data-slot="chart-tick" x={middle(index)} y={height - 7} textAnchor="middle">
                          {name}
                        </text>
                      ),
                  )}
                </svg>
                <ScrubTrack
                  aria-label={title}
                  data-picks={onPick ? '' : undefined}
                  style={{ left, top, width: plotW, height: plotH + bottom } as CSSProperties}
                />
                {at !== null && (
                  <div
                    data-slot="chart-tip"
                    data-side={middle(at) > width / 2 ? 'before' : 'after'}
                    style={{ left: middle(at), top } as CSSProperties}
                    aria-hidden="true"
                  >
                    <strong>{categories[at]}</strong>
                    <dl>
                      {shown.map((one) => (
                        <div key={one.id}>
                          <dt>
                            <span data-slot="chart-key" data-shape="line" style={{ '--key': colour(one.slot) } as CSSProperties} />
                            {one.label}
                          </dt>
                          <dd>{said(one.values[at])}</dd>
                        </div>
                      ))}
                      {stacked && shown.length > 1 && (
                        <div data-total="">
                          <dt>{words.total}</dt>
                          <dd>{format(totals[at] ?? 0)}</dd>
                        </div>
                      )}
                    </dl>
                  </div>
                )}
              </>
            )}
          </Scrub>
        )}
      </div>
    </figure>
  );
}

/* A dozen points as a small line with no axis: the shape of a number's recent past, beside the number. On its
   own it says nothing to a screen reader unless it is given a label; the number beside it is the fact. */
export function Sparkline({
  values,
  label,
  width = 88,
  height = 28,
}: {
  values: number[];
  label?: string;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const pad = 4;
  const x = (at: number): number => pad + (at / (values.length - 1)) * (width - pad * 2);
  const y = (value: number): number => pad + (1 - (value - low) / (high - low || 1)) * (height - pad * 2);
  const last = values.length - 1;
  return (
    <svg
      data-slot="sparkline"
      width={width}
      height={height}
      style={{ width, height }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
    >
      <path d={values.map((value, at) => `${at ? 'L' : 'M'}${x(at).toFixed(1)},${y(value).toFixed(1)}`).join('')} />
      <circle cx={x(last)} cy={y(values[last] as number)} r={3} />
    </svg>
  );
}

export type MetricItem = {
  label: string;
  /* The figure as it is to be read: `$48,200`, `94%`. */
  value: string;
  /* How far it moved, as a share: 0.042 is up 4.2%. */
  delta?: number;
  /* Against what: `vs last month`. */
  against?: string;
  /* Whether more is the good direction (rent collected) or the bad one (repairs open). */
  upIsGood?: boolean;
  trend?: number[];
  note?: ReactNode;
  /* Where the figure's records are: the tile becomes a link, or a button. */
  href?: string;
  onOpen?: () => void;
};

/* Figures in a row of tiles: what it is, the number, how it moved and against what, and its recent shape. The
   movement is an arrow and a word as well as a colour, and the colour is whether it is good, not which way it
   went: fewer open repairs is green. */
export function Metrics({ label, items, loading }: { label: string; items: MetricItem[]; loading?: boolean }) {
  return (
    <ul data-slot="metrics" aria-label={label} aria-busy={loading || undefined} data-loading={loading ? '' : undefined}>
      {items.map((item) => {
        const moved = item.delta === undefined ? undefined : Math.abs(item.delta) < 0.0005 ? 'flat' : item.delta > 0 ? 'up' : 'down';
        const good = moved === 'flat' || moved === undefined ? undefined : (moved === 'up') === (item.upIsGood ?? true);
        const inside = (
          <>
            <span data-slot="metric-label">{item.label}</span>
            <span data-slot="metric-figure">
              <strong data-slot="metric-value">{item.value}</strong>
              {item.trend && <Sparkline values={item.trend} />}
            </span>
            {moved && (
              <span data-slot="metric-delta" data-good={good === true ? '' : undefined} data-bad={good === false ? '' : undefined}>
                {moved === 'up' ? (
                  <ArrowUp aria-hidden="true" weight="bold" />
                ) : moved === 'down' ? (
                  <ArrowDown aria-hidden="true" weight="bold" />
                ) : (
                  <Minus aria-hidden="true" weight="bold" />
                )}
                <span data-kind="visually-hidden">{moved === 'up' ? words.up : moved === 'down' ? words.down : words.noChange}</span>
                {moved !== 'flat' && <b>{`${(Math.abs(item.delta as number) * 100).toFixed(1)}%`}</b>}
                {item.against && <span>{item.against}</span>}
              </span>
            )}
            {item.note && <span data-slot="metric-note">{item.note}</span>}
          </>
        );
        return (
          <li key={item.label}>
            {item.href ? (
              <a data-slot="metric" href={item.href}>
                {inside}
              </a>
            ) : item.onOpen ? (
              <button data-slot="metric" type="button" onClick={item.onOpen}>
                {inside}
              </button>
            ) : (
              <div data-slot="metric">{inside}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export type Segment = { id: string; label: string; value: number };

/* One whole split into its parts, as a thin bar and a legend that says each part's amount and share, so nothing
   is read off the bar's lengths alone. A part at nothing draws nothing and is still named. */
export function SegmentBar({
  label,
  parts,
  format = (value) => value.toLocaleString(),
}: {
  label: string;
  parts: Segment[];
  format?: (value: number) => string;
}) {
  const whole = parts.reduce((total, part) => total + Math.max(part.value, 0), 0);
  const share = (part: Segment): string => percent(whole ? Math.max(part.value, 0) / whole : 0);
  return (
    <div data-slot="segments">
      <div
        data-slot="segment-bar"
        role="img"
        aria-label={`${label}: ${parts.map((part) => `${part.label} ${format(part.value)}, ${share(part)}`).join('; ')}`}
      >
        {parts.map(
          (part, at) =>
            part.value > 0 && <span key={part.id} style={{ flexGrow: part.value, '--key': colour((at % 8) + 1) } as CSSProperties} />,
        )}
      </div>
      <ul data-slot="segment-legend" aria-hidden="true">
        {parts.map((part, at) => (
          <li key={part.id}>
            <span data-slot="chart-key" data-shape="box" style={{ '--key': colour((at % 8) + 1) } as CSSProperties} />
            <span>{part.label}</span>
            <b>{format(part.value)}</b>
            <span data-slot="segment-share">{share(part)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type BarRow = { id: string; label: string; value: number; href?: string };

/* How a total breaks down by something: one row a thing, the largest first, each with its amount and a bar
   against the largest. The first few stand and the rest are a press away, so a long tail does not push the page
   down. A row that leads somewhere is a link or a button, whole. */
export function BarList({
  label,
  rows,
  format = (value) => value.toLocaleString(),
  most = 6,
  share,
  onPick,
}: {
  label: string;
  rows: BarRow[];
  format?: (value: number) => string;
  /* How many rows stand before the rest are folded. */
  most?: number;
  /* Say each row's share of the total as well. */
  share?: boolean;
  onPick?: (row: BarRow) => void;
}) {
  const [open, setOpen] = useState(false);
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const largest = Math.max(...sorted.map((row) => row.value), 0) || 1;
  const whole = sorted.reduce((total, row) => total + Math.max(row.value, 0), 0) || 1;
  const drawn = open ? sorted : sorted.slice(0, most);
  return (
    <div data-slot="bar-list">
      <ol aria-label={label}>
        {drawn.map((row) => {
          const inside = (
            <>
              <span data-slot="bar-list-words">
                <span>{row.label}</span>
                <span>
                  <b>{format(row.value)}</b>
                  {share && <span data-slot="segment-share">{percent(Math.max(row.value, 0) / whole)}</span>}
                </span>
              </span>
              <span data-slot="bar-list-track" aria-hidden="true">
                <span style={{ width: `${(Math.max(row.value, 0) / largest) * 100}%` }} />
              </span>
            </>
          );
          return (
            <li key={row.id}>
              {row.href ? (
                <a href={row.href}>{inside}</a>
              ) : onPick ? (
                <button type="button" onClick={() => onPick(row)}>
                  {inside}
                </button>
              ) : (
                <div>{inside}</div>
              )}
            </li>
          );
        })}
      </ol>
      {sorted.length > most && (
        <Button intent="quiet" size="sm" aria-expanded={open} onClick={() => setOpen((now) => !now)}>
          {open ? words.showFewer : words.showAll(sorted.length)}
        </Button>
      )}
    </div>
  );
}

export type FunnelStage = { id: string; label: string; value: number };

/* Steps that each keep some of the step before: every step's count, its bar against the first, and beside it how
   much of the step before came through, which is the number a funnel is read for. The last line says what came
   through end to end. */
export function Funnel({
  label,
  stages,
  format = (value) => value.toLocaleString(),
  onPick,
}: {
  label: string;
  stages: FunnelStage[];
  format?: (value: number) => string;
  onPick?: (stage: FunnelStage) => void;
}) {
  const first = stages[0]?.value || 1;
  const last = stages[stages.length - 1];
  return (
    <div data-slot="funnel">
      <ol aria-label={label}>
        {stages.map((stage, at) => {
          const before = stages[at - 1];
          const inside = (
            <>
              <span data-slot="bar-list-words">
                <span>{stage.label}</span>
                <span>
                  <b>{format(stage.value)}</b>
                  {before && (
                    <span data-slot="segment-share">{words.ofPrevious(percent(before.value ? stage.value / before.value : 0))}</span>
                  )}
                </span>
              </span>
              <span data-slot="bar-list-track" aria-hidden="true">
                <span style={{ width: `${Math.min(stage.value / first, 1) * 100}%` }} />
              </span>
            </>
          );
          return (
            <li key={stage.id}>
              {onPick ? (
                <button type="button" onClick={() => onPick(stage)}>
                  {inside}
                </button>
              ) : (
                <div>{inside}</div>
              )}
            </li>
          );
        })}
      </ol>
      {last && stages.length > 1 && <p data-slot="funnel-through">{words.endToEnd(percent(last.value / first))}</p>}
    </div>
  );
}

/* A dashboard's blocks side by side as the width allows; a block that asks for it takes two columns' worth. */
export function DashGrid({ children }: { children: ReactNode }) {
  return <div data-slot="dash-grid">{children}</div>;
}

export function DashBlock({
  title,
  wide,
  action,
  headingLevel = 2,
  children,
}: {
  title?: string;
  wide?: boolean;
  action?: ReactNode;
  headingLevel?: 2 | 3 | 4;
  children: ReactNode;
}) {
  const Heading = `h${headingLevel}` as 'h2';
  return (
    <section data-slot="dash-block" data-wide={wide ? '' : undefined} aria-label={title}>
      {title && (
        <header>
          <Heading>{title}</Heading>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}
