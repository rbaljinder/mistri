import { type CSSProperties, useMemo } from 'react';
import { type Span, Spans, SpansSpan, SpansTrack } from './behaviors/Spans';
import type { Tone } from './Status';
import { words } from './words';

/* Things that each run from a day to a day, as bars against a calendar. Every task is a row: its name and its
   dates in words at the leading edge, which stay while the calendar scrolls, and its bar on the days it runs. A
   bar is carried along its row to move both its days, or pulled from an end to move one (the spans behavior);
   from the keyboard the bars are one stop, the arrows walk them, Alt with an arrow moves one a day and Alt with
   Shift moves its last day. The change is asked of the caller: the chart is drawn from the tasks, so what the
   caller does not keep goes back.

   The dates are also written beside each name, so nothing is read off a bar's length alone. */

export type GanttTask = {
  id: string;
  label: string;
  /* Its first and last day, as `2026-11-14`; the last is a day it still runs on. */
  start: string;
  end: string;
  tone?: Tone;
  /* How much of it is done, from 0 to 1: the bar fills that far. */
  progress?: number;
  /* It keeps its days. */
  fixed?: boolean;
};

export type GanttProps = {
  label: string;
  tasks: GanttTask[];
  /* The first and last day the calendar shows. Without them, a week either side of the tasks. */
  from?: string;
  to?: string;
  today?: string;
  /* Asked when a task's days are changed. Without it the chart is only read. */
  onChange?: (task: GanttTask, days: { start: string; end: string }) => void;
  onOpen?: (task: GanttTask) => void;
  /* How wide a day is, in pixels. */
  dayWidth?: number;
};

const DAY = 86_400_000;
const at = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const iso = (time: number): string => new Date(time).toISOString().slice(0, 10);
const say = (day: string, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(at(day));
const short = (day: string): string => say(day, { month: 'short', day: 'numeric' });

export function Gantt({ label, tasks, from, to, today, onChange, onOpen, dayWidth = 28 }: GanttProps) {
  const first = from ?? iso(Math.min(...tasks.map((task) => at(task.start)), Date.now()) - 7 * DAY);
  const last = to ?? iso(Math.max(...tasks.map((task) => at(task.end)), at(first)) + 14 * DAY);
  const days = Math.round((at(last) - at(first)) / DAY) + 1;
  const index = (day: string): number => Math.round((at(day) - at(first)) / DAY);
  const dayAt = (place: number): string => iso(at(first) + place * DAY);
  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  // A stretch ends where its last day does: one past that day's own place.
  const value: Span[] = tasks.map((task) => ({ id: task.id, track: task.id, start: index(task.start), end: index(task.end) + 1 }));
  const lengthOf = (span: Span): string => words.daysLong(span.end - span.start);
  const said = (span: Span): string =>
    `${byId.get(span.id)?.label ?? span.id}, ${words.fromTo(short(dayAt(span.start)), short(dayAt(span.end - 1)))}, ${lengthOf(span)}`;

  const months: { name: string; start: number; span: number }[] = [];
  for (let place = 0; place < days; place += 1) {
    const name = say(dayAt(place), { month: 'long', year: 'numeric' });
    const open = months[months.length - 1];
    if (open?.name === name) open.span += 1;
    else months.push({ name, start: place, span: 1 });
  }
  const todayAt = today === undefined ? undefined : index(today);

  return (
    <Spans
      data-kind="gantt"
      role="group"
      aria-label={label}
      value={value}
      min={0}
      max={days}
      step={1}
      minSize={1}
      axis="x"
      stay
      locked={(span) => !onChange || Boolean(byId.get(span.id)?.fixed)}
      label={said}
      onPick={(id) => {
        const task = byId.get(id);
        if (task) onOpen?.(task);
      }}
      onValueChange={(next, details) => {
        // The chart is drawn from the tasks, so a change is not the chart's to keep: it is asked of the caller.
        details.cancel();
        const task = byId.get(details.id);
        const span = next.find((each) => each.id === details.id);
        if (task && span) onChange?.(task, { start: dayAt(span.start), end: dayAt(span.end - 1) });
      }}
      style={{ '--gantt-day': `${dayWidth}px`, '--gantt-days': days } as CSSProperties}
    >
      {(state: { spans: Span[] }) => (
        <div data-slot="gantt-scroll">
          <div data-slot="gantt-grid">
            <div data-slot="gantt-head" aria-hidden="true">
              <div data-slot="gantt-corner" />
              <div data-slot="gantt-axis">
                <div data-slot="gantt-months">
                  {months.map((month) => (
                    <span key={month.start} style={{ width: month.span * dayWidth }}>
                      <b>{month.span >= 4 ? month.name : ''}</b>
                    </span>
                  ))}
                </div>
                <div data-slot="gantt-days">
                  {Array.from({ length: days }, (_, place) => {
                    const weekday = new Date(at(first) + place * DAY).getUTCDay();
                    return (
                      <span
                        key={place}
                        data-weekend={weekday === 0 || weekday === 6 ? '' : undefined}
                        data-today={place === todayAt ? '' : undefined}
                      >
                        {say(dayAt(place), { day: 'numeric' })}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
            {tasks.map((task) => (
              <div key={task.id} data-slot="gantt-row">
                <div data-slot="gantt-name">
                  <b>{task.label}</b>
                  <span>{words.fromTo(short(task.start), short(task.end))}</span>
                </div>
                <SpansTrack value={task.id} data-kind="gantt-track">
                  {() => (
                    <>
                      {todayAt !== undefined && todayAt >= 0 && todayAt < days && (
                        <i data-slot="gantt-today" style={{ insetInlineStart: (todayAt + 0.5) * dayWidth }} aria-hidden="true" />
                      )}
                      {/* A bar is drawn in its own row wherever a pointer has carried it: it keeps to its row, and
                        showing it under the row it passes over would say otherwise. */}
                      {state.spans
                        .filter((span) => span.id === task.id)
                        .map((span) => (
                          <SpansSpan
                            key={span.id}
                            value={span.id}
                            role="button"
                            data-kind="gantt-bar"
                            data-tone={task.tone}
                            aria-label={said(span)}
                            title={onChange && !task.fixed ? words.moveBar : undefined}
                          >
                            {onChange && !task.fixed && <i data-span-edge="start" aria-hidden="true" />}
                            {task.progress !== undefined && (
                              <i
                                data-slot="gantt-done"
                                style={{ width: `${Math.min(Math.max(task.progress, 0), 1) * 100}%` }}
                                aria-hidden="true"
                              />
                            )}
                            <span>{task.label}</span>
                            {onChange && !task.fixed && <i data-span-edge="end" aria-hidden="true" />}
                          </SpansSpan>
                        ))}
                    </>
                  )}
                </SpansTrack>
              </div>
            ))}
          </div>
        </div>
      )}
    </Spans>
  );
}
