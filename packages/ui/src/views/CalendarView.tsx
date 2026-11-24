/** Month, week, and day schedule surface with timed event blocks and navigation controls. */
import { Icon } from '../Icon.js';
import { Button } from '@ui-sdk/react/button';
import { Popover, PopoverContent, PopoverTrigger } from '@ui-sdk/react/popover';
import { type Ref, useMemo, useState } from 'react';
import {
  addDays,
  addMonths,
  Days,
  DaysDay,
  localToday,
  monthOf,
  type Span,
  Spans,
  SpansAxis,
  SpansNow,
  SpansSpan,
  SpansTrack,
  weeksOf,
} from '@mistriwork/ui/behaviors/index.js';
import { cx, toDataTone, type Tone } from '../internal/cx.js';
import { resolveLocale } from '../internal/locale.js';

/** Schedule display mode for `CalendarView`. */
export type CalendarViewMode = 'month' | 'week' | 'day';

/** Scheduled event item rendered in `CalendarView`. */
export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO date YYYY-MM-DD */
  date: string;
  /** Minutes from midnight (e.g. 540 = 09:00) */
  startMinutes?: number;
  /** Minutes from midnight (e.g. 600 = 10:00) */
  endMinutes?: number;
  allDay?: boolean;
  tone?: Tone;
  location?: string;
  locked?: boolean;
}

/** Localized UI strings and accessibility labels for `CalendarView`. */
export interface CalendarViewWords {
  navigationAriaLabel?: string;
  previousPeriodLabel?: string;
  todayLabel?: string;
  nextPeriodLabel?: string;
  viewModeAriaLabel?: string;
  monthLabel?: string;
  weekLabel?: string;
  dayLabel?: string;
  newEventLabel?: string;
  allDayLabel?: string;
  createEventOnDayLabel?: (day: string) => string;
  moreEventsLabel?: (count: number) => string;
  eventRangeLabel?: (title: string, day: string | undefined, start: string, end: string) => string;
}

/** Props for the `CalendarView` component. */
export interface CalendarViewProps {
  events: ReadonlyArray<CalendarEvent>;
  onEventsChange?: (events: CalendarEvent[]) => void;
  /* View Mode */
  mode?: CalendarViewMode;
  defaultMode?: CalendarViewMode;
  onModeChange?: (mode: CalendarViewMode) => void;
  /* Focused / Selected Date (YYYY-MM-DD) */
  selectedDate?: string;
  defaultSelectedDate?: string;
  onSelectedDateChange?: (date: string) => void;
  /* Event & Day Callbacks */
  onEventClick?: (event: CalendarEvent) => void;
  onCreateEvent?: (date: string, startMinutes?: number) => void;
  /* Schedule & Locale Config */
  locale?: string;
  words?: CalendarViewWords;
  weekStart?: 0 | 1;
  today?: string;
  dayStartHour?: number;
  dayEndHour?: number;
  stepMinutes?: number;
  maxMonthEventsPerDay?: number;
  scheduleHeight?: number;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

function parseUtcDate(isoDay: string): Date {
  return new Date(`${isoDay}T00:00:00Z`);
}

function formatClock(minutes: number, localeTag?: string): string {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(minutes)));
  const h24 = Math.floor(clamped / 60) % 24;
  const m = clamped % 60;
  const utc = new Date(Date.UTC(2026, 0, 4, h24, m));
  return new Intl.DateTimeFormat(localeTag, {
    hour: 'numeric',
    minute: m === 0 ? undefined : '2-digit',
    timeZone: 'UTC',
  }).format(utc);
}

function formatShortClock(minutes: number, localeTag?: string): string {
  return formatClock(minutes, localeTag);
}

const EVENT_FIELDS = ['id', 'title', 'date', 'startMinutes', 'endMinutes', 'allDay', 'tone', 'location', 'locked'] as const;

/* Whether two lists say the same events. The uncontrolled view compares by what the events say, not by the array's
   identity: a host that writes its events inline hands over a new array on every render, and taking each of those
   for a change would throw away a drag the moment anything above re-rendered. */
function sameEvents(a: ReadonlyArray<CalendarEvent>, b: ReadonlyArray<CalendarEvent>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((event, at) => EVENT_FIELDS.every((field) => event[field] === b[at]![field]));
}

function currentLocalMinutes(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

/** Month, week, and day schedule surface with timed event blocks and navigation controls. */
export function CalendarView({
  events: propEvents,
  onEventsChange,
  mode: controlledMode,
  defaultMode = 'month',
  onModeChange,
  selectedDate: controlledDate,
  defaultSelectedDate,
  onSelectedDateChange,
  onEventClick,
  onCreateEvent,
  locale,
  words,
  weekStart = 1,
  today: explicitToday,
  dayStartHour = 7,
  dayEndHour = 20,
  stepMinutes = 30,
  maxMonthEventsPerDay = 3,
  scheduleHeight = 620,
  className,
  ref,
}: CalendarViewProps) {
  const resolvedLocale = resolveLocale(locale);
  const monthFormatter = useMemo(
    () => new Intl.DateTimeFormat(resolvedLocale, { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    [resolvedLocale],
  );
  const dayFullFormatter = useMemo(
    () => new Intl.DateTimeFormat(resolvedLocale, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
    [resolvedLocale],
  );
  const shortDayFormatter = useMemo(
    () => new Intl.DateTimeFormat(resolvedLocale, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    [resolvedLocale],
  );
  const sunWeekdayNames = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(resolvedLocale, { weekday: 'short', timeZone: 'UTC' });
    return Array.from({ length: 7 }, (_, dow) => fmt.format(new Date(Date.UTC(2026, 0, 4 + dow))));
  }, [resolvedLocale]);
  const todayStr = useMemo(() => explicitToday ?? localToday(), [explicitToday]);

  const [internalMode, setInternalMode] = useState<CalendarViewMode>(defaultMode);
  const [internalDate, setInternalDate] = useState<string>(defaultSelectedDate ?? todayStr);
  const [internalMonth, setInternalMonth] = useState<string>(monthOf(defaultSelectedDate ?? todayStr));
  const [localEvents, setLocalEvents] = useState<CalendarEvent[] | null>(null);
  /* Uncontrolled, the view keeps its own copy once something is dragged, and that copy used to win for good: events
     the host loaded or changed afterwards never appeared. When the host's events change, its list is the truth
     again and the local copy is dropped. */
  const [seenEvents, setSeenEvents] = useState(propEvents);
  if (seenEvents !== propEvents) {
    setSeenEvents(propEvents);
    if (localEvents !== null && !sameEvents(seenEvents, propEvents)) setLocalEvents(null);
  }

  const mode = controlledMode !== undefined ? controlledMode : internalMode;
  const activeDate = controlledDate !== undefined ? controlledDate : internalDate;
  const activeMonth = controlledDate !== undefined ? monthOf(controlledDate) : internalMonth;
  const events = onEventsChange ? propEvents : (localEvents ?? propEvents);

  const setMode = (next: CalendarViewMode) => {
    if (controlledMode === undefined) setInternalMode(next);
    onModeChange?.(next);
  };

  const setDateAndMonth = (nextDate: string, nextMonth = monthOf(nextDate)) => {
    if (controlledDate === undefined) {
      setInternalDate(nextDate);
      setInternalMonth(nextMonth);
    }
    onSelectedDateChange?.(nextDate);
  };

  const commitEvents = (next: CalendarEvent[]) => {
    if (!onEventsChange) setLocalEvents(next);
    onEventsChange?.(next);
  };

  /* --- Navigation --- */
  const stepPeriod = (dir: -1 | 1) => {
    if (mode === 'month') {
      const nextMonth = addMonths(activeMonth, dir);
      const dayPart = activeDate.slice(8, 10);
      const candidate = `${nextMonth}-01`;
      // Clamp day within target month
      const monthWeeks = weeksOf(nextMonth, weekStart)
        .flat()
        .filter((d) => monthOf(d) === nextMonth);
      const matching = monthWeeks.find((d) => d.slice(8, 10) === dayPart) ?? monthWeeks[monthWeeks.length - 1] ?? candidate;
      setDateAndMonth(matching, nextMonth);
    } else if (mode === 'week') {
      const next = addDays(activeDate, dir * 7);
      setDateAndMonth(next);
    } else {
      const next = addDays(activeDate, dir);
      setDateAndMonth(next);
    }
  };

  const goToday = () => {
    setDateAndMonth(todayStr, monthOf(todayStr));
  };

  /* --- Visible Days for Week / Day --- */
  const weekDays = useMemo(() => {
    const monthGrid = weeksOf(monthOf(activeDate), weekStart);
    const found = monthGrid.find((w) => w.includes(activeDate));
    if (found) return found;
    const dow = (parseUtcDate(activeDate).getUTCDay() - weekStart + 7) % 7;
    const start = addDays(activeDate, -dow);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [activeDate, weekStart]);

  const scheduleDays = mode === 'day' ? [activeDate] : weekDays;

  /* --- Header Title --- */
  const headerTitle = useMemo(() => {
    if (mode === 'month') {
      return monthFormatter.format(parseUtcDate(`${activeMonth}-01`));
    }
    if (mode === 'day') {
      return dayFullFormatter.format(parseUtcDate(activeDate));
    }
    const first = weekDays[0]!;
    const last = weekDays[6]!;
    if (monthOf(first) === monthOf(last)) {
      return `${monthFormatter.format(parseUtcDate(first))}`;
    }
    return `${shortDayFormatter.format(parseUtcDate(first))} – ${shortDayFormatter.format(parseUtcDate(last))}`;
  }, [mode, activeMonth, activeDate, weekDays, monthFormatter, dayFullFormatter, shortDayFormatter]);

  /* --- Events Indexed by Day --- */
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of events) {
      const list = map.get(ev.date) ?? [];
      list.push(ev);
      map.set(ev.date, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.allDay && !b.allDay) return -1;
        if (!a.allDay && b.allDay) return 1;
        return (a.startMinutes ?? 0) - (b.startMinutes ?? 0);
      });
    }
    return map;
  }, [events]);

  const eventsById = useMemo(() => {
    const m = new Map<string, CalendarEvent>();
    for (const ev of events) m.set(ev.id, ev);
    return m;
  }, [events]);

  /* --- Spans for Week / Day --- */
  const minMinutes = dayStartHour * 60;
  const maxMinutes = dayEndHour * 60;

  const scheduleSpans = useMemo<Span[]>(() => {
    const visibleSet = new Set(scheduleDays);
    const list: Span[] = [];
    for (const ev of events) {
      if (!visibleSet.has(ev.date) || ev.allDay) continue;
      const start = Math.max(minMinutes, Math.min(maxMinutes - stepMinutes, ev.startMinutes ?? 9 * 60));
      const end = Math.max(start + stepMinutes, Math.min(maxMinutes, ev.endMinutes ?? start + 60));
      list.push({
        id: ev.id,
        track: ev.date,
        start,
        end,
      });
    }
    return list;
  }, [events, scheduleDays, minMinutes, maxMinutes, stepMinutes]);

  const drawnSpans = useMemo(() => new Map(scheduleSpans.map((s) => [s.id, s])), [scheduleSpans]);

  /* Only a stretch that was moved or resized is written back. Every stretch is drawn clamped to the visible hours
     (and one with no start is drawn at nine), so writing all of them back on any change rewrote events nobody
     touched: dragging one event turned a 21:00 to 22:00 event elsewhere in the week into 19:30 to 20:00. */
  const handleSpansChange = (nextSpans: Span[]) => {
    const updatedMap = new Map(nextSpans.map((s) => [s.id, s]));
    let changed = false;
    const nextEvents = events.map((ev) => {
      const s = updatedMap.get(ev.id);
      const drawn = drawnSpans.get(ev.id);
      if (!s || (drawn && drawn.track === s.track && drawn.start === s.start && drawn.end === s.end)) return ev;
      changed = true;
      return {
        ...ev,
        date: s.track,
        startMinutes: s.start,
        endMinutes: s.end,
      };
    });
    if (changed) commitEvents(nextEvents);
  };

  /* The times a stretch is labelled with: the event's own while it stands where it was drawn, since the drawing is
     clamped and the event is not (a 21:00 event drawn in the last visible half hour is still at 21:00), and the
     stretch's once it has been carried somewhere else. An event with no start has no time to state. */
  const spanTimes = (span: Span): { start: string; end: string } | null => {
    const ev = eventsById.get(span.id);
    const drawn = drawnSpans.get(span.id);
    const moved = !drawn || drawn.track !== span.track || drawn.start !== span.start || drawn.end !== span.end;
    if (!ev || moved) return { start: formatClock(span.start, resolvedLocale), end: formatClock(span.end, resolvedLocale) };
    if (ev.startMinutes === undefined) return null;
    const end = ev.endMinutes ?? ev.startMinutes + 60;
    return { start: formatClock(ev.startMinutes, resolvedLocale), end: formatClock(end, resolvedLocale) };
  };

  const weekdayLabels = useMemo(
    () => (weekStart === 1 ? [...sunWeekdayNames.slice(1), sunWeekdayNames[0]!] : sunWeekdayNames),
    [weekStart, sunWeekdayNames],
  );
  const hasAnyAllDayInSchedule = useMemo(
    () => scheduleDays.some((d) => (eventsByDate.get(d) ?? []).some((e) => e.allDay)),
    [scheduleDays, eventsByDate],
  );

  return (
    <div ref={ref} className={cx('nx-calendar', className)}>
      {/* Calendar Header */}
      <header className="nx-calendar-header">
        <div className="nx-calendar-title-group">
          <h2 className="nx-calendar-title">{headerTitle}</h2>
          <div className="nx-calendar-nav" role="group" aria-label={words?.navigationAriaLabel ?? 'Calendar navigation'}>
            <Button
              data-size="sm"
              data-variant="outline"
              data-icon-only=""
              onClick={() => stepPeriod(-1)}
              aria-label={words?.previousPeriodLabel ?? 'Previous period'}
            >
              <Icon name="caret-left" size={13} weight="bold" />
            </Button>
            <Button data-size="sm" data-variant="outline" onClick={goToday}>
              {words?.todayLabel ?? 'Today'}
            </Button>
            <Button
              data-size="sm"
              data-variant="outline"
              data-icon-only=""
              onClick={() => stepPeriod(1)}
              aria-label={words?.nextPeriodLabel ?? 'Next period'}
            >
              <Icon name="caret-right" size={13} weight="bold" />
            </Button>
          </div>
        </div>

        <div className="nx-calendar-controls">
          <div className="nx-calendar-mode-switch" role="tablist" aria-label={words?.viewModeAriaLabel ?? 'Calendar view mode'}>
            {(['month', 'week', 'day'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                className="nx-calendar-mode-btn"
                data-active={mode === m ? '' : undefined}
                onClick={() => setMode(m)}
              >
                {m === 'month' ? (words?.monthLabel ?? 'Month') : m === 'week' ? (words?.weekLabel ?? 'Week') : (words?.dayLabel ?? 'Day')}
              </button>
            ))}
          </div>

          {onCreateEvent && (
            <Button data-size="sm" data-variant="primary" onClick={() => onCreateEvent(activeDate, 9 * 60)}>
              <Icon name="plus" size={13} weight="bold" />
              <span>{words?.newEventLabel ?? 'New event'}</span>
            </Button>
          )}
        </div>
      </header>

      {/* MONTH MODE */}
      {mode === 'month' ? (
        <div className="nx-calendar-month">
          <div className="nx-calendar-weekdays" aria-hidden="true">
            {weekdayLabels.map((label, idx) => (
              <div key={`${label}-${idx}`} className="nx-calendar-weekday">
                {label}
              </div>
            ))}
          </div>

          <Days
            value={activeDate}
            month={activeMonth}
            weekStart={weekStart}
            today={todayStr}
            press
            onValueChange={(day) => setDateAndMonth(day, activeMonth)}
            onMonthChange={(m) => {
              if (controlledDate === undefined) setInternalMonth(m);
            }}
            onPick={(day) => setDateAndMonth(day)}
            role="grid"
            aria-label={headerTitle}
            className="nx-calendar-month-grid"
          >
            {({ weeks }) =>
              weeks.map((week) => (
                <div role="row" key={week[0]} className="nx-calendar-week-row">
                  {week.map((day) => {
                    const dayEvents = eventsByDate.get(day) ?? [];
                    const visibleEvents = dayEvents.slice(0, maxMonthEventsPerDay);
                    const overflowCount = dayEvents.length - visibleEvents.length;
                    const dayNum = Number(day.slice(8, 10));
                    const isSelected = day === activeDate;

                    return (
                      <DaysDay key={day} value={day} data-selected={isSelected ? '' : undefined} className="nx-calendar-day-cell">
                        <div className="nx-calendar-day-top">
                          <span className="nx-calendar-day-num">{dayNum === 1 ? shortDayFormatter.format(parseUtcDate(day)) : dayNum}</span>
                          {onCreateEvent && (
                            <button
                              type="button"
                              className="nx-calendar-day-add"
                              onClick={(e) => {
                                e.stopPropagation();
                                onCreateEvent(day, 9 * 60);
                              }}
                              aria-label={words?.createEventOnDayLabel ? words.createEventOnDayLabel(day) : `Create event on ${day}`}
                            >
                              <Icon name="plus" size={11} weight="bold" />
                            </button>
                          )}
                        </div>

                        <div className="nx-calendar-day-events">
                          {visibleEvents.map((ev) => (
                            <button
                              key={ev.id}
                              type="button"
                              className="nx-calendar-event-pill"
                              data-tone={toDataTone(ev.tone ?? 'accent')}
                              data-all-day={ev.allDay ? '' : undefined}
                              onClick={(e) => {
                                e.stopPropagation();
                                onEventClick?.(ev);
                              }}
                            >
                              {!ev.allDay && ev.startMinutes !== undefined && (
                                <span className="nx-calendar-event-time">{formatShortClock(ev.startMinutes, resolvedLocale)}</span>
                              )}
                              <span className="nx-calendar-event-title">{ev.title}</span>
                            </button>
                          ))}

                          {overflowCount > 0 && (
                            <Popover>
                              <PopoverTrigger className="nx-calendar-more-btn" onClick={(e) => e.stopPropagation()}>
                                {words?.moreEventsLabel ? words.moreEventsLabel(overflowCount) : `+${overflowCount} more`}
                              </PopoverTrigger>
                              <PopoverContent align="start" sideOffset={4} className="nx-calendar-more-popover">
                                <div className="nx-calendar-more-header">{dayFullFormatter.format(parseUtcDate(day))}</div>
                                <div className="nx-calendar-more-list">
                                  {dayEvents.map((ev) => (
                                    <button
                                      key={ev.id}
                                      type="button"
                                      className="nx-calendar-event-pill"
                                      data-tone={toDataTone(ev.tone ?? 'accent')}
                                      data-all-day={ev.allDay ? '' : undefined}
                                      onClick={() => onEventClick?.(ev)}
                                    >
                                      {!ev.allDay && ev.startMinutes !== undefined && (
                                        <span className="nx-calendar-event-time">{formatShortClock(ev.startMinutes, resolvedLocale)}</span>
                                      )}
                                      <span className="nx-calendar-event-title">{ev.title}</span>
                                    </button>
                                  ))}
                                </div>
                              </PopoverContent>
                            </Popover>
                          )}
                        </div>
                      </DaysDay>
                    );
                  })}
                </div>
              ))
            }
          </Days>
        </div>
      ) : (
        /* WEEK & DAY SCHEDULE MODES (Spans axis="y") */
        <div className="nx-calendar-schedule" data-mode={mode}>
          {/* Column Headers */}
          <div className="nx-calendar-schedule-head">
            <div className="nx-calendar-gutter-corner" aria-hidden="true" />
            <div className="nx-calendar-schedule-cols" style={{ gridTemplateColumns: `repeat(${scheduleDays.length}, minmax(0, 1fr))` }}>
              {scheduleDays.map((day) => {
                const dateObj = parseUtcDate(day);
                const dowLabel = sunWeekdayNames[dateObj.getUTCDay()];
                const dayNum = Number(day.slice(8, 10));
                const isToday = day === todayStr;
                const isSelected = day === activeDate;

                return (
                  <button
                    key={day}
                    type="button"
                    className="nx-calendar-col-head"
                    data-today={isToday ? '' : undefined}
                    data-selected={isSelected ? '' : undefined}
                    onClick={() => setDateAndMonth(day)}
                  >
                    <span className="nx-calendar-col-dow">{dowLabel}</span>
                    <span className="nx-calendar-col-num">{dayNum}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* All-day Strip */}
          {hasAnyAllDayInSchedule && (
            <div className="nx-calendar-allday-row">
              <div className="nx-calendar-allday-label">{words?.allDayLabel ?? 'All day'}</div>
              <div className="nx-calendar-allday-cols" style={{ gridTemplateColumns: `repeat(${scheduleDays.length}, minmax(0, 1fr))` }}>
                {scheduleDays.map((day) => {
                  const allDays = (eventsByDate.get(day) ?? []).filter((e) => e.allDay);
                  return (
                    <div key={day} className="nx-calendar-allday-cell">
                      {allDays.map((ev) => (
                        <button
                          key={ev.id}
                          type="button"
                          className="nx-calendar-event-pill"
                          data-tone={toDataTone(ev.tone ?? 'accent')}
                          data-all-day=""
                          onClick={() => onEventClick?.(ev)}
                        >
                          <span className="nx-calendar-event-title">{ev.title}</span>
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Scrollable Vertical Spans Stage */}
          <div className="nx-calendar-schedule-scroll" data-scrolls="">
            <Spans
              axis="y"
              min={minMinutes}
              max={maxMinutes}
              step={stepMinutes}
              minSize={stepMinutes}
              value={scheduleSpans}
              onValueChange={handleSpansChange}
              locked={(span) => Boolean(eventsById.get(span.id)?.locked)}
              label={(span) => {
                const ev = eventsById.get(span.id);
                const title = ev?.title ?? span.id;
                const times = spanTimes(span);
                if (!times) return `${title}, ${span.track}`;
                return words?.eventRangeLabel
                  ? words.eventRangeLabel(title, span.track, times.start, times.end)
                  : `${title}, ${span.track}, ${times.start} to ${times.end}`;
              }}
              onPick={(id) => {
                const ev = eventsById.get(id);
                if (ev) onEventClick?.(ev);
              }}
              className="nx-calendar-spans-root"
              style={{ height: scheduleHeight }}
            >
              <div className="nx-calendar-time-gutter">
                <SpansAxis step={60} lines={false} formatValue={(mins) => formatClock(mins, resolvedLocale)} />
              </div>

              <div className="nx-calendar-tracks" style={{ gridTemplateColumns: `repeat(${scheduleDays.length}, minmax(0, 1fr))` }}>
                <SpansAxis step={60} labels={false} />
                {scheduleDays.map((day) => (
                  <SpansTrack key={day} value={day} className="nx-calendar-day-track">
                    {(trackSpans) => (
                      <>
                        {day === todayStr && <SpansNow value={currentLocalMinutes} className="nx-calendar-now" />}
                        {trackSpans.map((span) => {
                          const ev = eventsById.get(span.id);
                          const duration = span.end - span.start;
                          const title = ev?.title ?? span.id;
                          const times = spanTimes(span);
                          return (
                            <SpansSpan
                              key={span.id}
                              value={span.id}
                              data-tone={toDataTone(ev?.tone ?? 'accent')}
                              aria-label={
                                !times
                                  ? title
                                  : words?.eventRangeLabel
                                    ? words.eventRangeLabel(title, undefined, times.start, times.end)
                                    : `${title}, ${times.start} to ${times.end}`
                              }
                              className="nx-calendar-span-event"
                            >
                              <i data-span-edge="start" className="nx-calendar-span-edge" data-edge="start" />
                              <div className="nx-calendar-span-body">
                                {times && (
                                  <div className="nx-calendar-span-time">
                                    {times.start} – {times.end}
                                  </div>
                                )}
                                <div className="nx-calendar-span-title">{title}</div>
                                {ev?.location && duration >= 60 && (
                                  <div className="nx-calendar-span-loc">
                                    <Icon name="map-pin" size={11} />
                                    <span>{ev.location}</span>
                                  </div>
                                )}
                              </div>
                              <i data-span-edge="end" className="nx-calendar-span-edge" data-edge="end" />
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
        </div>
      )}
    </div>
  );
}
