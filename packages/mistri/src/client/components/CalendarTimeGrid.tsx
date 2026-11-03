/**
 * A week or a day of a calendar as a time grid (`span: 'week' | 'day'`): the hours down the side, a column per day,
 * and each record placed by its start and its end — records that overlap stand side by side, sharing the column's
 * width, as a day planner draws them. A line marks the present moment in today's column. CalendarList asks the
 * question and writes the moves; this draws them.
 *
 * The hours drawn are the working day (seven to seven) widened to whatever the period holds, so nothing scrolls
 * inside the page and nothing is left off it. A record that runs past midnight is a piece in each day it covers.
 *
 * A record is dragged to another time or day (usePointerDrag: each half hour of a day is a place to land, and the
 * record keeps the place it was held by), and its foot is dragged to change its end, where the list has an `end` to
 * write. The keyboard does the same: the records are one Tab stop, arrows move between them (Up and Down within a
 * day, Left and Right across days), Alt and an arrow moves one half an hour or a day, and Alt, Shift and Up or Down
 * moves its end.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { usePointerDrag } from '@mistriwork/kit/client/components/usePointerDrag.js';
import { DAY_MINUTES, SLOT_MINUTES, minutesBetween, nowMoment, type Moment } from './calendarTime.js';
import { say as sayCopy } from '../copy/lists/components/CalendarTimeGrid.js';

/** A record on the grid. */
export interface TimedRecord {
  id: string;
  title: string;
  start: Moment;
  /** Where it is drawn to: its end, or a half hour after its start where it has none. */
  end: Moment;
}

/** A record's piece of one day: the minutes it covers there, and the share of the column it takes. */
interface Piece {
  record: TimedRecord;
  day: string;
  from: number;
  to: number;
  /** Its place among the records it overlaps, and how many places they need. */
  column: number;
  columns: number;
  /** The record ends in this piece: its foot, which a drag moves, is here. */
  last: boolean;
}

const pieceKey = (piece: Pick<Piece, 'record' | 'day'>) => `${piece.record.id}@${piece.day}`;
/** A record is drawn at least a half hour tall, so a five-minute call is a target too. */
const drawnTo = (piece: Pick<Piece, 'from' | 'to'>) => Math.max(piece.to, piece.from + SLOT_MINUTES);
/** The working day a grid always shows, widened to what the period holds. */
const FIRST_HOUR = 7;
const LAST_HOUR = 19;

/** A record's pieces, a piece for each of `days` it covers. An end at midnight ends the day before. */
export function piecesOf(record: TimedRecord, days: readonly string[]): Array<Omit<Piece, 'column' | 'columns'>> {
  return days.flatMap((day) => {
    if (record.start.day > day || record.end.day < day) return [];
    if (record.end.day === day && record.end.minute === 0 && record.start.day < day) return [];
    const from = record.start.day === day ? record.start.minute : 0;
    const to = record.end.day === day ? record.end.minute : DAY_MINUTES;
    /* Its foot is in the day it ends, or in the day before where it ends at midnight. */
    const last = record.end.day === day || minutesBetween({ day, minute: DAY_MINUTES }, record.end) === 0;
    return [{ record, day, from, to: Math.max(to, from), last }];
  });
}

/**
 * One day's pieces laid side by side where they overlap: the earliest first, then the longest, each in the first
 * place free when it starts; a run of pieces that overlap one another shares its widest count of places, so a record
 * keeps one width from its top to its foot.
 */
export function layDay(pieces: Array<Omit<Piece, 'column' | 'columns'>>): Piece[] {
  const sorted = [...pieces].sort((a, b) => a.from - b.from || b.to - a.to || a.record.title.localeCompare(b.record.title));
  const laid: Piece[] = [];
  let run: Piece[] = [];
  let places: number[] = [];
  let reach = -Infinity;
  const close = () => {
    for (const piece of run) piece.columns = places.length;
    laid.push(...run);
    run = [];
    places = [];
  };
  for (const piece of sorted) {
    if (run.length && piece.from >= reach) close();
    let column = places.findIndex((end) => end <= piece.from);
    if (column < 0) column = places.length;
    places[column] = drawnTo(piece);
    reach = run.length ? Math.max(reach, drawnTo(piece)) : drawnTo(piece);
    run.push({ ...piece, column, columns: 1 });
  }
  if (run.length) close();
  return laid;
}

interface TimeGridProps {
  days: readonly string[];
  records: readonly TimedRecord[];
  /** What a record says inside its box, above its times: its title and its status, as the month draws them. */
  content: (record: TimedRecord) => ReactNode;
  /** The ids being written, drawn dimmed until the period is read again. */
  pending: (id: string) => boolean;
  movable: boolean;
  /** Its end is the list's to write too, so its foot can be dragged. */
  resizable: boolean;
  interactive: boolean;
  locale: string | undefined;
  label: string;
  onOpen: (record: TimedRecord) => void;
  /** Move a record's start and its end by these minutes. */
  onMove: (record: TimedRecord, start: number, end: number) => void;
}

const dayDate = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
};
const clockAt = (minute: number) => new Date(Date.UTC(1970, 0, 1, 0, minute));
/** Alt and an arrow: a half hour either way, or a day. */
const STEPS: Record<string, number> = { ArrowUp: -SLOT_MINUTES, ArrowDown: SLOT_MINUTES, ArrowLeft: -DAY_MINUTES, ArrowRight: DAY_MINUTES };

export function CalendarTimeGrid({
  days,
  records,
  content,
  pending,
  movable,
  resizable,
  interactive,
  locale,
  label,
  onOpen,
  onMove,
}: TimeGridProps) {
  const pieces = useMemo(() => days.flatMap((day) => layDay(records.flatMap((record) => piecesOf(record, [day])))), [days, records]);
  const byDay = useMemo(() => {
    const out = new Map<string, Piece[]>(days.map((day) => [day, []]));
    for (const piece of pieces) out.get(piece.day)!.push(piece);
    return out;
  }, [days, pieces]);
  const first = Math.min(FIRST_HOUR, ...pieces.map((piece) => Math.floor(piece.from / 60)));
  const last = Math.max(LAST_HOUR, ...pieces.map((piece) => Math.ceil(drawnTo(piece) / 60)));
  const top = first * 60;
  const length = (Math.min(last, 24) - first) * 60;
  const at = (minute: number) => `${(((minute - top) / length) * 100).toFixed(3)}%`;

  /* The present moves once a minute; a grid left open across midnight keeps its day. */
  const [now, setNow] = useState<Moment>(() => nowMoment());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(nowMoment()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  /* The records are one Tab stop: the one last visited while it is drawn, else the first. */
  const order = useMemo(
    () => [...pieces].sort((a, b) => days.indexOf(a.day) - days.indexOf(b.day) || a.from - b.from || a.column - b.column),
    [pieces, days],
  );
  const [active, setActive] = useState<string>();
  const tabStop = active && order.some((piece) => pieceKey(piece) === active) ? active : order[0] && pieceKey(order[0]);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  /* A moved record is drawn anew in its new place; the focus follows it there once it is. */
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    if (!refocus.current) return;
    const piece = order.find((candidate) => candidate.record.id === refocus.current);
    const button = piece ? buttons.current.get(pieceKey(piece)) : undefined;
    if (button) {
      refocus.current = null;
      setActive(pieceKey(piece!));
      button.focus();
    }
  });

  const hourWords = new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZone: 'UTC' });
  const clock = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  const fullDay = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const times = (piece: Piece) => clock.formatRange(clockAt(piece.from), clockAt(Math.max(piece.to, piece.from)));

  const move = (record: TimedRecord, start: number, end: number) => {
    if (!start && !end) return;
    refocus.current = record.id;
    onMove(record, start, end);
  };

  /* Where a held record would land: the half hour under the pointer, less where in the record it was held. */
  const [landing, setLanding] = useState<{ day: string; from: number; to: number }>();
  const held = useRef(0);
  const drag = usePointerDrag<Piece>({
    over: (piece, point) => {
      const day = point?.zone.dataset.date;
      const minute = Number(point?.zone.dataset.minute);
      if (!day || !Number.isFinite(minute)) return setLanding(undefined);
      const from = minute - held.current;
      setLanding({ day, from, to: from + (drawnTo(piece) - piece.from) });
    },
    drop: (piece, point) => {
      setLanding(undefined);
      const day = point?.zone.dataset.date;
      const minute = Number(point?.zone.dataset.minute);
      if (!day || !Number.isFinite(minute)) return;
      const shift = minutesBetween({ day: piece.day, minute: piece.from }, { day, minute: minute - held.current });
      move(piece.record, shift, shift);
    },
    end: () => setLanding(undefined),
  });

  /* The foot: dragged, the record's end follows the pointer by half hours, never above a half hour after its start. */
  const [stretch, setStretch] = useState<{ key: string; to: number }>();
  const stretched = useRef(false);
  const stretchFrom = (piece: Piece) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLSpanElement>) => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      event.stopPropagation();
      const grip = event.currentTarget;
      const column = grip.closest<HTMLElement>('.calendar-time-column');
      if (!column) return;
      grip.setPointerCapture?.(event.pointerId);
      const minuteAt = (y: number) => {
        const box = column.getBoundingClientRect(); // screen-px: a share of the column, compared with the pointer's clientY
        const minute = top + ((y - box.top) / (box.height || 1)) * length;
        return Math.max(piece.from + SLOT_MINUTES, Math.min(DAY_MINUTES, Math.round(minute / SLOT_MINUTES) * SLOT_MINUTES));
      };
      let to = piece.to;
      const onMoveTo = (moved: PointerEvent) => {
        to = minuteAt(moved.clientY);
        setStretch({ key: pieceKey(piece), to });
      };
      const onUp = () => {
        grip.removeEventListener('pointermove', onMoveTo);
        grip.removeEventListener('pointerup', onUp);
        grip.removeEventListener('pointercancel', onCancel);
        setStretch(undefined);
        stretched.current = true;
        window.setTimeout(() => (stretched.current = false), 0);
        if (to !== piece.to) move(piece.record, 0, to - piece.to);
      };
      const onCancel = () => {
        grip.removeEventListener('pointermove', onMoveTo);
        grip.removeEventListener('pointerup', onUp);
        grip.removeEventListener('pointercancel', onCancel);
        setStretch(undefined);
      };
      grip.addEventListener('pointermove', onMoveTo);
      grip.addEventListener('pointerup', onUp);
      grip.addEventListener('pointercancel', onCancel);
    },
  });

  const onKey = (event: KeyboardEvent<HTMLButtonElement>, piece: Piece) => {
    if (event.metaKey || event.ctrlKey) return;
    if (event.altKey) {
      const step = STEPS[event.key];
      if (!step || !movable) return;
      if (event.shiftKey) {
        /* Alt, Shift and Up or Down: the end, by a half hour, never above a half hour after the start. */
        if (!resizable || Math.abs(step) !== SLOT_MINUTES || !piece.last) return;
        event.preventDefault();
        if (step < 0 && piece.to - SLOT_MINUTES < piece.from + SLOT_MINUTES && piece.record.start.day === piece.day) return;
        move(piece.record, 0, step);
        return;
      }
      /* A day only where there is another day drawn to go to. */
      if (Math.abs(step) === DAY_MINUTES && days.length === 1) return;
      event.preventDefault();
      move(piece.record, step, step);
      return;
    }
    const index = order.indexOf(piece);
    let next: Piece | undefined;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const day = order.filter((candidate) => candidate.day === piece.day);
      next = day[day.indexOf(piece) + (event.key === 'ArrowDown' ? 1 : -1)];
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const way = event.key === 'ArrowRight' ? 1 : -1;
      for (let i = days.indexOf(piece.day) + way; i >= 0 && i < days.length && !next; i += way) {
        const there = byDay.get(days[i]!)!;
        next = [...there].sort((a, b) => Math.abs(a.from - piece.from) - Math.abs(b.from - piece.from))[0];
      }
    } else if (event.key === 'Home') next = order[0];
    else if (event.key === 'End') next = order[order.length - 1];
    if (!next && !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (!next || index < 0) return;
    setActive(pieceKey(next));
    buttons.current.get(pieceKey(next))?.focus();
  };

  const hours = Array.from({ length: Math.min(last, 24) - first }, (_, i) => first + i);
  const slots = Array.from({ length: length / SLOT_MINUTES }, (_, i) => top + i * SLOT_MINUTES);
  const today = now.day;

  return (
    <div className="calendar-time" style={{ '--calendar-days': days.length, '--calendar-hours': hours.length } as CSSProperties}>
      <div className="calendar-time-head" aria-hidden="true">
        <span className="calendar-time-corner" />
        {days.map((day) => (
          <span key={day} className={`calendar-time-day${day === today ? ' is-today' : ''}`}>
            <span className="calendar-time-weekday">{weekday.format(dayDate(day))}</span>
            <span className="calendar-date">{dayDate(day).getUTCDate()}</span>
          </span>
        ))}
      </div>
      <div className={`calendar-time-body${drag.dragging ? ' is-dragging' : ''}`} role="group" aria-label={label}>
        <div className="calendar-time-gutter" aria-hidden="true">
          {hours.map((hour) => (
            <span key={hour} className="calendar-time-hour">
              {hourWords.format(clockAt(hour * 60))}
            </span>
          ))}
        </div>
        {days.map((day) => {
          const here = byDay.get(day)!;
          return (
            <div
              key={day}
              className={`calendar-time-column${day === today ? ' is-today' : ''}`}
              data-date={day}
              role="group"
              aria-label={fullDay.format(dayDate(day))}
            >
              {slots.map((minute) => (
                <span
                  key={minute}
                  className={`calendar-time-slot${minute % 60 === 0 ? ' is-hour' : ''}`}
                  aria-hidden="true"
                  {...(movable ? { 'data-drop-zone': '' } : {})}
                  data-date={day}
                  data-minute={minute}
                />
              ))}
              {landing?.day === day && (
                <span
                  className="calendar-time-landing"
                  aria-hidden="true"
                  style={{
                    top: at(Math.max(top, landing.from)),
                    height: `calc(${at(Math.min(top + length, landing.to))} - ${at(Math.max(top, landing.from))})`,
                  }}
                />
              )}
              {now.day === day && now.minute >= top && now.minute <= top + length && (
                <span className="calendar-time-now" aria-hidden="true" style={{ top: at(now.minute) }} />
              )}
              <ul className="calendar-time-records">
                {here.map((piece) => {
                  const key = pieceKey(piece);
                  const to = stretch?.key === key ? stretch.to : piece.to;
                  /* A half hour has room for one line, its title and times beside each other; an hour and a half, a title
                     on two. */
                  const minutes = Math.max(to, piece.from + SLOT_MINUTES) - piece.from;
                  const size = minutes <= SLOT_MINUTES ? ' is-short' : minutes >= 3 * SLOT_MINUTES ? ' is-tall' : '';
                  return (
                    <li
                      key={key}
                      style={{
                        top: at(piece.from),
                        height: `calc(${at(Math.max(to, piece.from + SLOT_MINUTES))} - ${at(piece.from)})`,
                        left: `${(piece.column / piece.columns) * 100}%`,
                        width: `${100 / piece.columns}%`,
                      }}
                    >
                      <button
                        type="button"
                        className={`calendar-card calendar-time-card${size}${piece.from === piece.record.start.minute && piece.day === piece.record.start.day ? '' : ' runs-before'}${piece.last ? '' : ' runs-after'}${pending(piece.record.id) ? ' is-moving' : ''}`}
                        disabled={!interactive}
                        data-card={piece.record.id}
                        data-day={day}
                        tabIndex={key === tabStop ? 0 : -1}
                        ref={(button) => {
                          if (button) buttons.current.set(key, button);
                          else buttons.current.delete(key);
                        }}
                        onFocus={() => setActive(key)}
                        onClick={() => {
                          if (!stretched.current) onOpen(piece.record);
                        }}
                        onKeyDown={(event) => onKey(event, piece)}
                        onPointerDownCapture={(event) => {
                          /* Held a way down the record, it lands that way above the pointer: by whole half hours. */
                          const box = event.currentTarget.getBoundingClientRect(); // screen-px: a share of the record, compared with the pointer's clientY
                          const share = box.height ? (event.clientY - box.top) / box.height : 0;
                          held.current = Math.floor((share * (drawnTo(piece) - piece.from)) / SLOT_MINUTES) * SLOT_MINUTES;
                        }}
                        {...drag.source(piece, movable)}
                        aria-keyshortcuts={
                          movable
                            ? `Alt+ArrowUp Alt+ArrowDown${days.length > 1 ? ' Alt+ArrowLeft Alt+ArrowRight' : ''}${resizable && piece.last ? ' Alt+Shift+ArrowUp Alt+Shift+ArrowDown' : ''}`
                            : undefined
                        }
                        title={movable ? sayCopy('dragToAnotherTime') : undefined}
                      >
                        {content(piece.record)}
                        <span className="calendar-card-line calendar-time-times">
                          <span className="calendar-card-detail">{times(piece)}</span>
                          <span className="calendar-sr">, {fullDay.format(dayDate(day))}</span>
                        </span>
                        {resizable && movable && piece.last && (
                          <span
                            className="calendar-time-grip"
                            data-drag-ignore=""
                            aria-hidden="true"
                            title={sayCopy('dragToChangeTheEnd')}
                            {...stretchFrom(piece)}
                          />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
