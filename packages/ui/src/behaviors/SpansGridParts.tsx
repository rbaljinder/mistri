/* The parts that draw a range for Spans (./SpansParts.tsx): the labels and lines of an axis, a line for the present,
   and a stretch that refuses what is carried into it. A day by the hour and a Gantt by the week are the same three
   things in different units, so each is told its numbers and nothing more.

     <Spans value={visits} onValueChange={setVisits} axis="y" min={7 * 60} max={19 * 60} step={30}>
       <SpansAxis step={60} format={(minute) => hours.format(clock(minute))} />
       <SpansRegion from={12 * 60} to={13 * 60}>Lunch</SpansRegion>
       <SpansNow value={() => minutesNow()} />
       {…tracks}
     </Spans>

   Each fills the element it is in (which stands where the range stands, and is the caller's to position: a Spans root
   or a track) and places itself along it by `axis`. Slots: `spans-axis` with `spans-axis-label` and
   `spans-axis-line`, `spans-now` and `spans-region`; all are `aria-hidden` but the region's label, since the
   stretches say where they are in their own names. */
import { type CSSProperties, type ReactNode, useContext, useEffect, useId, useRef, useState } from 'react';
import { type SpansRange, SpansRangeContext, share } from './spansRange.js';

const along = (range: Pick<SpansRange, 'axis'>, from: number, to?: number): CSSProperties =>
  range.axis === 'y'
    ? { top: `${from * 100}%`, ...(to === undefined ? {} : { height: `${(to - from) * 100}%` }) }
    : { left: `${from * 100}%`, ...(to === undefined ? {} : { width: `${(to - from) * 100}%` }) };

/**
 * Labels and lines at every `step` from the range's start to its end, the range's own `step` where none is given.
 * `format` says a value (an hour, a date); `labels` and `lines` turn either off, and `every` labels one tick in so many.
 */
export function SpansAxis({
  step,
  formatValue,
  format,
  labels = true,
  lines = true,
  every = 1,
  className,
}: {
  step: number;
  formatValue?: (value: number) => ReactNode;
  format?: (value: number) => ReactNode;
  labels?: boolean;
  lines?: boolean;
  every?: number;
  className?: string;
}) {
  const formatTick = formatValue ?? format ?? String;
  const range = useContext(SpansRangeContext);
  const ticks: number[] = [];
  if (step > 0) for (let value = range.min; value <= range.max; value += step) ticks.push(value);
  return (
    <div data-slot="spans-axis" data-axis={range.axis} className={className} aria-hidden="true">
      {ticks.map((value, at) => (
        <span key={value}>
          {lines && <i data-slot="spans-axis-line" data-value={value} style={along(range, share(range, value))} />}
          {labels && at % Math.max(1, every) === 0 && (
            <span data-slot="spans-axis-label" data-value={value} style={along(range, share(range, value))}>
              {formatTick(value)}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * A line at `value`, drawn again each minute (or each `every` milliseconds) when `value` is a function, and not drawn
 * at all where it falls outside the range.
 */
export function SpansNow({ value, every = 60_000, className }: { value: number | (() => number); every?: number; className?: string }) {
  const range = useContext(SpansRangeContext);
  const read = () => (typeof value === 'function' ? value() : value);
  const [at, setAt] = useState(read);
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    setAt(latest.current());
    if (typeof value !== 'function') return;
    const timer = setInterval(() => setAt(latest.current()), every);
    return () => clearInterval(timer);
  }, [value, every]);
  if (at < range.min || at > range.max) return null;
  return (
    <span data-slot="spans-now" data-axis={range.axis} className={className} aria-hidden="true" style={along(range, share(range, at))} />
  );
}

/**
 * A stretch from `from` to `to` that nothing is moved or lengthened into: a lunch hour, a closed day. Its children
 * are its label, which is also what is said when a move into it is refused. Inside a track it refuses only that
 * track's stretches; `track` names another, and a region in the root refuses every track's.
 */
export function SpansRegion({
  from,
  to,
  track,
  children,
  className,
}: {
  from: number;
  to: number;
  track?: string;
  children?: ReactNode;
  className?: string;
}) {
  const range = useContext(SpansRangeContext);
  const id = useId();
  const element = useRef<HTMLDivElement>(null);
  const said = typeof children === 'string' || typeof children === 'number' ? String(children) : '';
  useEffect(() => {
    const mine = track ?? element.current?.closest<HTMLElement>('[data-slot="spans-track"]')?.dataset.track;
    range.regions.set(id, { from, to, track: mine, label: said || element.current?.textContent?.trim() || '' });
    return () => void range.regions.delete(id);
  }, [range, id, from, to, track, said]);
  return (
    <div
      ref={element}
      data-slot="spans-region"
      data-axis={range.axis}
      className={className}
      style={along(range, share(range, from), share(range, to))}
    >
      {children}
    </div>
  );
}
