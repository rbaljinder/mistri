import { CaretLeft, CaretRight, Plus } from '@phosphor-icons/react';
import { announce } from '@ui-sdk/core';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Days, DaysDay } from './behaviors/Days';
import { addDays, addMonths, dayAt as at, inMonth, localToday, monthOf, weeksOf } from './behaviors/days';
import { Transfer, TransferItem, TransferList } from './behaviors/Transfer';
import { Button } from './Button';
import { Popover } from './containers';
import type { Tone } from './Status';
import { words } from './words';

/* A month of things by their day. It is a grid to the keyboard, which is the Days behavior (behaviors/days.ts):
   one stop in the Tab order (the day last visited), arrows by day and by week, Home and End to the week's edges,
   Page Up and Down by month. A day is one element with two behaviors, a day of the grid and a place things are
   carried to. Enter goes into a day,
   onto what it holds, where Up and Down step between them and Escape comes back out; on a day that holds nothing
   Enter adds to it. A thing is taken to another day by carrying it there (the Transfer behavior, so the day under
   it lights, a day that will not take it goes flat, and letting go anywhere else puts it back) or, from the
   keyboard, with Alt and an arrow: a day either way, a week up or down. The move is asked of the caller; the
   month is drawn from the events, so what the caller does not keep goes back where it was.

   Where it is narrow the month is read as an agenda: the days that hold something, in order. */

export type CalendarEvent = {
  id: string;
  /* The day it is on, as `2026-11-14`. */
  day: string;
  title: string;
  /* When in the day, as `09:30`; without one it is the day's, and stands first. */
  time?: string;
  tone?: Tone;
  href?: string;
  /* It stays on its day: it is not carried and Alt with an arrow does nothing. */
  fixed?: boolean;
};

export type CalendarProps = {
  /* What the calendar is of: `Repair visits`. */
  label: string;
  events: CalendarEvent[];
  /* The month in view, as `2026-11`. */
  month?: string;
  defaultMonth?: string;
  onMonthChange?: (month: string) => void;
  /* The day that is today, for a page that knows it in the App's own zone; else the reader's. */
  today?: string;
  onOpen?: (event: CalendarEvent) => void;
  /* Asked when a thing is taken to another day. Without it nothing moves. */
  onMove?: (event: CalendarEvent, day: string) => void;
  /* Whether a day would take a thing: a visit is not moved into the past. */
  accepts?: (event: CalendarEvent, day: string) => boolean;
  /* Asked to add to a day. */
  onAdd?: (day: string) => void;
  /* The first day of a week: 1 is Monday, 0 Sunday. */
  weekStart?: 0 | 1;
  /* How many a day shows before the rest are behind a count. */
  shown?: number;
  loading?: boolean;
};

const say = (day: string, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(at(day));
const sayTime = (time: string): string =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(`1970-01-01T${time}:00Z`));
const fullDay = (day: string): string => say(day, { weekday: 'long', month: 'long', day: 'numeric' });

/* What a day holds that the keyboard can land on, in the order it is drawn. */
const INSIDE = '[data-slot="month-event"], [data-slot="month-more"], [data-slot="month-add"]';

export function Calendar({
  label,
  events,
  month: given,
  defaultMonth,
  onMonthChange,
  today = localToday(),
  onOpen,
  onMove,
  accepts,
  onAdd,
  weekStart = 1,
  shown = 3,
  loading,
}: CalendarProps) {
  const [own, setOwn] = useState(defaultMonth ?? monthOf(today));
  const month = given ?? own;
  const [cursor, setCursor] = useState(monthOf(today) === month ? today : `${month}-01`);
  const [narrow, setNarrow] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  /* Where the keyboard goes once the month is drawn again: a day, or a thing that was just moved. */
  const land = useRef<{ day?: string; event?: string } | null>(null);

  const show = (next: string) => {
    if (next === month) return;
    if (given === undefined) setOwn(next);
    onMonthChange?.(next);
  };
  const visit = (day: string, focus = true) => {
    setCursor(day);
    if (focus) land.current = { day };
    show(monthOf(day));
  };

  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const read = () => setNarrow(el.clientWidth > 0 && el.clientWidth < 560);
    read();
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  useEffect(() => {
    const to = land.current;
    if (!to) return;
    land.current = null;
    const target = to.event
      ? root.current?.querySelector<HTMLElement>(`[data-slot="month-event"][data-event="${CSS.escape(to.event)}"]`)
      : root.current?.querySelector<HTMLElement>(`[role="gridcell"][data-day="${to.day}"]`);
    target?.focus();
  });

  const weeks = useMemo(() => weeksOf(month, weekStart), [month, weekStart]);

  const byId = useMemo(() => new Map(events.map((event) => [event.id, event])), [events]);
  const lists = useMemo(() => {
    const held: Record<string, string[]> = {};
    for (const day of weeks.flat()) held[day] = [];
    const ordered = [...events].sort((a, b) => (a.time ?? '').localeCompare(b.time ?? '') || a.title.localeCompare(b.title));
    for (const event of ordered) held[event.day]?.push(event.id);
    return held;
  }, [events, weeks]);

  const takes = (event: CalendarEvent | undefined, day: string): boolean =>
    Boolean(event && onMove && !event.fixed && (accepts?.(event, day) ?? true));
  const move = (event: CalendarEvent, day: string, focus: boolean) => {
    if (day === event.day) return;
    if (!takes(event, day)) {
      announce(words.dayRefuses(event.title, fullDay(day)));
      return;
    }
    if (focus) land.current = { event: event.id };
    onMove?.(event, day);
    announce(words.movedToDay(event.title, fullDay(day)));
    if (focus && monthOf(day) !== month) {
      setCursor(day);
      show(monthOf(day));
    }
  };

  /* Enter on a day: into it, onto the first thing it holds; a day that holds nothing is added to. */
  const enter = (day: string, event: Event) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('[role="gridcell"]');
    const first = [...(cell?.querySelectorAll<HTMLElement>(INSIDE) ?? [])].find((part) => part.dataset.slot !== 'month-add');
    if (first) first.focus();
    else onAdd?.(day);
  };

  const onInsideKey = (event: KeyboardEvent<HTMLElement>, day: string, held?: CalendarEvent) => {
    const cell = event.currentTarget.closest<HTMLElement>('[role="gridcell"]');
    if (!cell) return;
    if (event.altKey && held && event.key.startsWith('Arrow')) {
      event.preventDefault();
      const by = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
      if (by) move(held, addDays(day, by), true);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cell.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const inside = [...cell.querySelectorAll<HTMLElement>(INSIDE)];
      const next = inside[inside.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1)];
      next?.focus();
    }
  };

  const chip = (event: CalendarEvent, day: string) => (
    <a
      data-slot="month-event"
      data-event={event.id}
      data-tone={event.tone}
      href={event.href ?? '#'}
      tabIndex={-1}
      draggable={false}
      title={onMove && !event.fixed ? words.moveByKeys : undefined}
      onClick={(click) => {
        if (!onOpen || click.metaKey || click.ctrlKey || click.shiftKey) return;
        click.preventDefault();
        onOpen(event);
      }}
      onKeyDown={(key) => onInsideKey(key, day, event)}
    >
      {event.time && <time dateTime={event.time}>{sayTime(event.time)}</time>}
      <span>{event.title}</span>
    </a>
  );

  const weekdays = (weeks[0] ?? []).map((day) => ({ short: say(day, { weekday: 'short' }), long: say(day, { weekday: 'long' }) }));
  const title = say(`${month}-01`, { month: 'long', year: 'numeric' });
  const held = weeks.flat().filter((day) => monthOf(day) === month && (lists[day]?.length ?? 0) > 0);

  return (
    <div data-slot="month" ref={root} aria-busy={loading || undefined} data-loading={loading ? '' : undefined}>
      <header data-slot="month-head">
        <h2 aria-live="polite">{title}</h2>
        <div>
          <Button size="sm" onClick={() => visit(today, false)} disabled={monthOf(today) === month && cursor === today}>
            {words.today}
          </Button>
          <Button
            size="sm"
            intent="quiet"
            aria-label={words.previousMonth}
            onClick={() => visit(inMonth(cursor, addMonths(month, -1)), false)}
          >
            <CaretLeft aria-hidden="true" />
          </Button>
          <Button size="sm" intent="quiet" aria-label={words.nextMonth} onClick={() => visit(inMonth(cursor, addMonths(month, 1)), false)}>
            <CaretRight aria-hidden="true" />
          </Button>
        </div>
      </header>
      {narrow ? (
        <ol data-slot="month-agenda" aria-label={`${label}, ${title}`}>
          {held.length === 0 && <li data-slot="month-empty">{words.nothingThisMonth}</li>}
          {held.map((day) => (
            <li key={day} data-today={day === today ? '' : undefined}>
              <h3>
                <b>{say(day, { day: 'numeric' })}</b> {say(day, { weekday: 'long' })}
                {day === today && <span data-slot="month-today">{words.today}</span>}
              </h3>
              <ul>
                {(lists[day] ?? []).map((id) => {
                  const event = byId.get(id);
                  return event && <li key={id}>{chip(event, day)}</li>;
                })}
              </ul>
            </li>
          ))}
        </ol>
      ) : (
        <Days
          value={cursor}
          month={month}
          weekStart={weekStart}
          today={today}
          onValueChange={(day) => setCursor(day)}
          onMonthChange={(next) => show(next)}
          onPick={enter}
          style={{ display: 'contents' }}
        >
          {() => (
            <Transfer
              data-kind="month-grid"
              role="grid"
              aria-label={`${label}, ${title}`}
              value={lists}
              accepts={(key, day) => takes(byId.get(key), day)}
              label={(key) => byId.get(key)?.title}
              listLabel={(day) => fullDay(day)}
              onValueChange={(_next, details) => {
                // The month is drawn from the events, so a move is not the calendar's to keep: it is asked of the caller.
                details.cancel();
                const event = byId.get(details.key);
                if (event && details.to !== details.from) move(event, details.to, false);
              }}
            >
              <div role="row" data-slot="month-weekdays">
                {weekdays.map((day) => (
                  <span key={day.long} role="columnheader" aria-label={day.long}>
                    {day.short}
                  </span>
                ))}
              </div>
              {weeks.map((week) => (
                <div role="row" key={week[0]} data-slot="month-week">
                  {week.map((day) => {
                    const count = lists[day]?.length ?? 0;
                    return (
                      <DaysDay
                        key={day}
                        value={day}
                        render={
                          <TransferList
                            value={day}
                            render={<div />}
                            around={(items, state) => {
                              const folded = state.keys.filter((key, place) => place >= shown && key !== state.carrying);
                              return (
                                <>
                                  {/* The day in full and how much it holds, for a reader who does not see the grid; what it
                              holds follows as the cell's own words. */}
                                  <span
                                    data-kind="visually-hidden"
                                    data-slot="month-day"
                                  >{`${fullDay(day)}, ${words.thingsOn(count)}`}</span>
                                  <span data-slot="month-date" aria-hidden="true">
                                    {day.endsWith('-01') ? say(day, { month: 'short', day: 'numeric' }) : say(day, { day: 'numeric' })}
                                  </span>
                                  <ul>{items}</ul>
                                  {folded.length > 0 && (
                                    <Popover
                                      title={fullDay(day)}
                                      align="start"
                                      trigger={
                                        <button
                                          type="button"
                                          data-slot="month-more"
                                          tabIndex={-1}
                                          onKeyDown={(key) => onInsideKey(key, day)}
                                        >
                                          {words.moreOnDay(folded.length)}
                                        </button>
                                      }
                                    >
                                      <ul data-slot="month-all">
                                        {state.keys.map((key) => {
                                          const event = byId.get(key);
                                          return event && <li key={key}>{chip(event, day)}</li>;
                                        })}
                                      </ul>
                                    </Popover>
                                  )}
                                  {onAdd && (
                                    <button
                                      type="button"
                                      data-slot="month-add"
                                      tabIndex={-1}
                                      aria-label={words.addOn(fullDay(day))}
                                      onClick={() => onAdd(day)}
                                      onKeyDown={(key) => onInsideKey(key, day)}
                                    >
                                      <Plus aria-hidden="true" />
                                    </button>
                                  )}
                                </>
                              );
                            }}
                          >
                            {(key, place) => {
                              const event = byId.get(key);
                              if (!event) return null;
                              if (!onMove || event.fixed) return place < shown ? <li key={key}>{chip(event, day)}</li> : null;
                              return (
                                <TransferItem key={key} value={key} hidden={place >= shown ? true : undefined}>
                                  {chip(event, day)}
                                </TransferItem>
                              );
                            }}
                          </TransferList>
                        }
                      />
                    );
                  })}
                </div>
              ))}
            </Transfer>
          )}
        </Days>
      )}
    </div>
  );
}
