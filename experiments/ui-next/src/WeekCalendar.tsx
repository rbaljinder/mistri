import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import { type CSSProperties, useMemo, useState } from 'react';
import { type Span, Spans, SpansSpan, SpansTrack } from './behaviors/Spans';
import { Button } from './Button';
import type { Tone } from './Status';
import { words } from './words';

/* A week by the hour: a column a day, and each thing with a time as a block from when it starts to when it ends.
   A block is carried to another time or another day and pulled from its foot to last longer or shorter (the spans
   behavior, snapped to a quarter of an hour); things at the same time stand side by side. From the keyboard the
   blocks are one stop, the arrows walk them, Alt with Up or Down moves one a quarter of an hour, Alt with Shift
   moves its end, and Alt with Left or Right takes it to the day beside. The change is asked of the caller. */

export type TimedEvent = {
  id: string;
  /* The day, as `2026-11-14`, and when in it, as `09:30`. */
  day: string;
  start: string;
  end: string;
  title: string;
  tone?: Tone;
  fixed?: boolean;
};

export type WeekCalendarProps = {
  label: string;
  events: TimedEvent[];
  /* A day in the week shown. */
  week?: string;
  defaultWeek?: string;
  onWeekChange?: (day: string) => void;
  today?: string;
  /* The time that is now, as `14:20`, for the line across today. */
  now?: string;
  /* The first and last hour drawn. */
  from?: number;
  to?: number;
  /* What a start and an end snap to, in minutes. */
  step?: number;
  onChange?: (event: TimedEvent, when: { day: string; start: string; end: string }) => void;
  onOpen?: (event: TimedEvent) => void;
  weekStart?: 0 | 1;
};

const DAY = 86_400_000;
const at = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const iso = (time: number): string => new Date(time).toISOString().slice(0, 10);
const minutes = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
const clock = (total: number): string => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
const sayTime = (total: number): string =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(total * 60_000));
const sayDay = (day: string, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(at(day));
const localToday = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

export function WeekCalendar({
  label,
  events,
  week: given,
  defaultWeek,
  onWeekChange,
  today = localToday(),
  now,
  from = 7,
  to = 20,
  step = 15,
  onChange,
  onOpen,
  weekStart = 1,
}: WeekCalendarProps) {
  const [own, setOwn] = useState(defaultWeek ?? today);
  const inWeek = given ?? own;
  const first = iso(at(inWeek) - ((new Date(at(inWeek)).getUTCDay() - weekStart + 7) % 7) * DAY);
  const days = Array.from({ length: 7 }, (_, place) => iso(at(first) + place * DAY));
  const show = (day: string) => {
    if (given === undefined) setOwn(day);
    onWeekChange?.(day);
  };
  const byId = useMemo(() => new Map(events.map((event) => [event.id, event])), [events]);
  const value: Span[] = events
    .filter((event) => days.includes(event.day))
    .map((event) => ({ id: event.id, track: event.day, start: minutes(event.start), end: minutes(event.end) }));
  const said = (span: Span): string =>
    `${byId.get(span.id)?.title ?? span.id}, ${sayDay(span.track, { weekday: 'long' })} ${words.fromTo(sayTime(span.start), sayTime(span.end))}`;
  const title = `${sayDay(first, { month: 'short', day: 'numeric' })} – ${sayDay(days[6] as string, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const hours = Array.from({ length: to - from }, (_, place) => from + place);
  const nowAt = now === undefined ? undefined : (minutes(now) - from * 60) / ((to - from) * 60);

  return (
    <div data-slot="week">
      <header data-slot="month-head">
        <h2 aria-live="polite">{title}</h2>
        <div>
          <Button size="sm" onClick={() => show(today)} disabled={days.includes(today)}>
            {words.today}
          </Button>
          <Button size="sm" intent="quiet" aria-label={words.previousWeek} onClick={() => show(iso(at(first) - 7 * DAY))}>
            <CaretLeft aria-hidden="true" />
          </Button>
          <Button size="sm" intent="quiet" aria-label={words.nextWeek} onClick={() => show(iso(at(first) + 7 * DAY))}>
            <CaretRight aria-hidden="true" />
          </Button>
        </div>
      </header>
      <Spans
        data-kind="week-grid"
        role="group"
        aria-label={`${label}, ${title}`}
        value={value}
        min={from * 60}
        max={to * 60}
        step={step}
        minSize={step}
        axis="y"
        locked={(span) => !onChange || Boolean(byId.get(span.id)?.fixed)}
        label={said}
        onPick={(id) => {
          const event = byId.get(id);
          if (event) onOpen?.(event);
        }}
        onValueChange={(next, details) => {
          // The week is drawn from the events, so a change is not the week's to keep: it is asked of the caller.
          details.cancel();
          const event = byId.get(details.id);
          const span = next.find((each) => each.id === details.id);
          if (event && span) onChange?.(event, { day: span.track, start: clock(span.start), end: clock(span.end) });
        }}
        style={{ '--week-hours': to - from } as CSSProperties}
      >
        <div data-slot="week-head" aria-hidden="true">
          <span />
          {days.map((day) => (
            <span key={day} data-today={day === today ? '' : undefined}>
              {sayDay(day, { weekday: 'short' })} <b>{sayDay(day, { day: 'numeric' })}</b>
            </span>
          ))}
        </div>
        <div data-slot="week-body">
          <div data-slot="week-hours" aria-hidden="true">
            {hours.map((hour) => (
              <span key={hour}>{sayTime(hour * 60).replace(':00', '')}</span>
            ))}
          </div>
          {days.map((day) => (
            <SpansTrack key={day} value={day} data-kind="week-day" data-today={day === today ? '' : undefined}>
              {(onDay) => (
                <>
                  {day === today && nowAt !== undefined && nowAt >= 0 && nowAt <= 1 && (
                    <i data-slot="week-now" style={{ top: `${nowAt * 100}%` }} aria-hidden="true" />
                  )}
                  {onDay.map((span) => {
                    const event = byId.get(span.id);
                    const moves = Boolean(onChange) && !event?.fixed;
                    return (
                      <SpansSpan key={span.id} value={span.id} role="button" data-kind="week-event" data-tone={event?.tone}>
                        <time>{sayTime(span.start)}</time>
                        <span>{event?.title}</span>
                        {/* Named by what it shows, then the rest of when: its day and when it ends. */}
                        <span data-kind="visually-hidden">{`${sayDay(span.track, { weekday: 'long' })}, ${words.until(sayTime(span.end))}`}</span>
                        {moves && <i data-span-edge="end" aria-hidden="true" />}
                      </SpansSpan>
                    );
                  })}
                </>
              )}
            </SpansTrack>
          ))}
        </div>
      </Spans>
    </div>
  );
}
