/**
 * A month of records by one date column. The list's own question is asked
 * again for the month in view — a sort, a column list or a page are the
 * grid's, not the calendar's — so a record sits on its day whatever page the
 * list is on, and a write that refreshes the list refreshes the month too.
 * With an `end` a record is a range — a leave, a pay period — drawn as one bar
 * across the days it spans, continued on the next week's row; each week lays
 * its records in lanes so a bar keeps one height across its days.
 * On a phone the month reads as an agenda: the days that have records, in
 * order, a range under its first day with its dates said. Opening a record is
 * the board's gesture. Where the date is the list's to change, a record is
 * dragged to another day (usePointerDrag: a mouse, a pen, or a finger held
 * still for a moment — on a phone, onto another day of the agenda), or moved
 * a day or a week with Alt and an arrow key: the ordinary update, gated as a
 * board move is, a range moving both its ends.
 * The month is a grid to the keyboard (the APG grid pattern): one Tab stop,
 * the day last visited; arrows move by day and week, Home and End to the
 * week's edges, Page Up and Down by month. Enter goes into a day — onto its
 * first record, or its "+N more" when all of them are folded — where Up and
 * Down step between what the day holds and Escape comes back out. A month of
 * thirty cards was thirty Tab stops before it.
 */
import './CalendarList.css';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, columnLabel, findTable, keyOf, openRecord, refsFrom, state, toast, writeAllowed } from '@mistriwork/kit/client/core.js';
import { formatLocale, formatNumber } from '@mistriwork/kit/client/locale.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { sessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { applyBulk, bulkKey } from '@mistriwork/kit/client/bulkActions.js';
import { splitQuery } from '@mistriwork/kit/client/clauses.js';
import { andQuery } from '@mistriwork/engine/shared/query.js';
import { expectedValues, primaryKey, type ColumnMeta, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import type { AppCalendarBackdrop, AppCalendarList } from '@mistriwork/engine/shared/listPresentations.js';
import { activeApp, inAppMode } from '../appState.js';
import { appRooms, isListRoom } from '@mistriwork/kit/client/components/appRooms.js';
import { listPresentationColumns } from '@mistriwork/engine/shared/appListColumns.js';
import { namedCell } from '@mistriwork/kit/client/components/listColumn.js';
import { PHONE_QUERY, useMediaQuery } from '@mistriwork/kit/client/components/useMediaQuery.js';
import { useOptimisticMoves } from '@mistriwork/kit/client/components/optimisticMoves.js';
import { usePointerDrag } from '@mistriwork/kit/client/components/usePointerDrag.js';
import type { ModalRecord } from './RecordModal.js';
import type { TableEntry } from '@mistriwork/kit/client/components/TableView.js';
import { Value } from '@mistriwork/kit/client/components/Value.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import { say as sayCopy } from '../copy/lists/components/CalendarList.js';

/** A month is read in one request; past this, the calendar says so rather than silently dropping days. */
const LIMIT = 500;
/** A day shows this many before saying how many more; the rest are one press away. */
const SHOWN = 3;
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (day: Date) => `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
const monthStart = (day: Date) => new Date(day.getFullYear(), day.getMonth(), 1);
const addMonths = (day: Date, months: number) => new Date(day.getFullYear(), day.getMonth() + months, 1);
const at = (day: string) => new Date(`${day}T00:00:00`);
const addDays = (day: string, days: number) => {
  const date = at(day);
  date.setDate(date.getDate() + days);
  return iso(date);
};
/** The Monday that starts the week a day is in: the key a week opens by. */
const weekOf = (day: string) => {
  const date = at(day);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return iso(date);
};
/** Alt and an arrow: a day either way, or a week. */
const STEPS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
/** The same day of the month `months` away, held inside that month's length. */
const sameDayIn = (day: string, months: number) => {
  const date = at(day);
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const length = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), length));
  return iso(target);
};
/** What a day holds that the keyboard can land on, in the order it is drawn: a span that opens (a button; one that does not is a span, with no type), a card, the more. */
const ITEMS = '.calendar-backdrop[type], .calendar-card:not(:disabled), .calendar-more';
/** A month's spans of one kind are read in one request, as its records are. */
const SPANS = 100;

/** A shaded span behind the days: another resource's row, from its first day to its last. */
interface CalendarSpan {
  table: string;
  key: Record<string, unknown>;
  label: string;
  day: string;
  last: string;
  tone: NonNullable<AppCalendarBackdrop['tone']>;
  /** Its resource has a list this reader can open, so the span opens its record. */
  opens: boolean;
}

/* A span opens its record where its resource is somewhere this reader goes: a list of it in the App's rooms (the
   reader's own, as served), or anywhere in the Workbench. Elsewhere it is a shade and its words. */
const opensRecords = (tableId: string) => {
  if (!inAppMode()) return true;
  const app = activeApp();
  return Boolean(app && appRooms(app).some((room) => isListRoom(room) && room.table === tableId && !room.error));
};

/** The month's spans, each kind read through the reader's own grants as any list is, in its own request. */
function useSpans(backdrop: AppCalendarBackdrop[] | undefined, first: string, next: string, connection: string | null) {
  const asked = (backdrop ?? []).flatMap((span) => {
    const table = findTable(span.from) as TableMeta | undefined;
    if (!table) return [];
    const columns = [...new Set([...primaryKey(table), span.start, span.end, span.labelColumn])];
    return [
      {
        span,
        table,
        text: `${table.id} ${span.start} < ${next} and ${span.end} >= ${first} sort ${span.start} show ${columns.join(', ')}`,
      },
    ];
  });
  return useQuery({
    queryKey: ['run', connection ?? '', 'calendar-backdrop', asked.map((one) => one.text)],
    enabled: asked.length > 0,
    queryFn: async () =>
      (
        await Promise.all(
          asked.map(async ({ span, table, text }) => {
            const data = (await api('/api/run', {
              q: text,
              limit: SPANS,
              offset: 0,
              count: 'none',
              ...(connection ? ownedBy(connection) : {}),
            })) as { rows?: Array<Record<string, unknown>>; errors?: Array<{ message: string }> };
            if (data.errors?.length) throw new Error(data.errors[0].message);
            const opens = opensRecords(table.id);
            return (data.rows ?? []).flatMap((row): CalendarSpan[] => {
              const day = row[span.start] == null ? '' : String(row[span.start]).slice(0, 10);
              const end = row[span.end] == null ? '' : String(row[span.end]).slice(0, 10);
              const key = keyOf(table, row) as Record<string, unknown> | null;
              if (!day || !key) return [];
              return [
                {
                  table: table.id,
                  key,
                  label: String(row[span.labelColumn] ?? ''),
                  day,
                  last: end > day ? end : day,
                  tone: span.tone ?? 'neutral',
                  opens,
                },
              ];
            });
          }),
        )
      ).flat(),
  });
}

/** A record on the calendar: its first day and, for a range, its last. */
interface CalendarCard {
  id: string;
  key: Record<string, unknown>;
  title: string;
  row: Record<string, unknown>;
  day: string;
  last: string;
  value: unknown;
  endValue?: unknown;
}
/** A record's piece of one week: the columns it spans there, its lane, and whether it runs on from the week before or into the next. */
interface Placed {
  card: CalendarCard;
  lane: number;
  from: number;
  to: number;
  before: boolean;
  after: boolean;
}

/**
 * Lanes for one week, as a month view lays them: the earliest first, then the
 * longest, each in the first lane free from its first day — so a bar keeps
 * one lane, and one height, across every day of the week it spans.
 */
function placeWeek(days: string[], cards: CalendarCard[]): Placed[] {
  const first = days[0],
    last = days[days.length - 1];
  const pieces = cards
    .filter((card) => card.day <= last && card.last >= first)
    .map((card) => ({
      card,
      from: days.indexOf(card.day < first ? first : card.day),
      to: days.indexOf(card.last > last ? last : card.last),
      before: card.day < first,
      after: card.last > last,
    }))
    .sort((a, b) => a.from - b.from || b.to - b.from - (a.to - a.from));
  const lanes: number[] = [];
  return pieces.map((piece) => {
    let lane = lanes.findIndex((end) => end < piece.from);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = piece.to;
    return { ...piece, lane };
  });
}

interface CalendarListProps {
  table: TableMeta;
  spec: AppCalendarList;
  entry: TableEntry;
  interactive?: boolean;
  label?: string;
  /** A reference's record name, read beside it (listReferenceNames): a title that is a reference says the name, not the key. */
  referenceLabels?: Record<string, string>;
}

export function CalendarList({ table, spec, entry, interactive = true, label, referenceLabels }: CalendarListProps) {
  const [month, setMonth] = useState(() => monthStart(new Date()));
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [over, setOver] = useState<string>();
  /* The grid's one Tab stop, and a day the keyboard asked for that is not drawn yet (the month is turning). */
  const [active, setActive] = useState<string>();
  const pendingDay = useRef<string | null>(null);
  const gridRef = useRef<HTMLTableElement>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  /* A moved card is a new element on its new day; the focus goes after it once it is drawn. */
  const refocus = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const card = refocus.current ? cardRefs.current.get(refocus.current) : undefined;
    if (card) {
      card.focus();
      refocus.current = null;
    }
    const day = pendingDay.current ? gridRef.current?.querySelector<HTMLElement>(`td[data-date="${pendingDay.current}"]`) : undefined;
    if (day) {
      day.focus();
      pendingDay.current = null;
    }
  });
  const client = useQueryClient();
  const phone = useMediaQuery(PHONE_QUERY);
  const connection = state.activeConnection ?? null;
  const locale = formatLocale();
  const first = iso(month);
  const next = iso(addMonths(month, 1));
  const columns = [...new Set([...primaryKey(table), ...listPresentationColumns(spec), ...Object.values(referenceLabels ?? {})])];
  /* A range is in the month when it starts before the month ends and ends in
     it or after; a record with no end is on its one day. */
  const range = spec.end
    ? `${spec.date} < ${next} and (${spec.end} >= ${first} or ${spec.date} >= ${first})`
    : `${spec.date} >= ${first} and ${spec.date} < ${next}`;
  const text = `${table.id} ${andQuery(splitQuery(entry.query).filter, range)} sort ${spec.date} show ${columns.join(', ')}`;
  /* The spans behind the days stand apart from the records: a reader whose spans fail still has the month. */
  const spans = useSpans(spec.backdrop, first, next, connection).data ?? [];
  const answer = useQuery({
    queryKey: ['run', connection ?? '', 'calendar', text],
    queryFn: async () => {
      const data = (await api('/api/run', {
        q: text,
        limit: LIMIT,
        offset: 0,
        count: 'none',
        ...(connection ? ownedBy(connection) : {}),
      })) as {
        rows?: Array<Record<string, unknown>>;
        errors?: Array<{ message: string }>;
        more?: boolean;
      };
      if (data.errors?.length) throw new Error(data.errors[0].message);
      return { rows: data.rows ?? [], more: Boolean(data.more) };
    },
  });

  /* A moved record is drawn on its new day at once and stays there while it saves (optimisticMoves); the month is
     read again once, when the last move is done. */
  const optimistic = useOptimisticMoves(
    answer.data?.rows ?? [],
    (row) => {
      const key = keyOf(table, row) as Record<string, unknown> | null;
      return key ? bulkKey(table, key) : null;
    },
    () => client.invalidateQueries({ queryKey: ['run', connection] }),
  );
  const drawnRows = optimistic.rows;
  const all = useMemo(() => {
    const out: CalendarCard[] = [];
    for (const row of drawnRows) {
      const day = row[spec.date] == null ? '' : String(row[spec.date]).slice(0, 10);
      const key = keyOf(table, row) as Record<string, unknown> | null;
      if (!day || !key) continue;
      // A range that ends before it starts, or has no end, is its first day alone.
      const end = spec.end && row[spec.end] != null ? String(row[spec.end]).slice(0, 10) : '';
      out.push({
        id: bulkKey(table, key),
        key,
        row,
        day,
        last: end > day ? end : day,
        value: row[spec.date],
        ...(spec.end ? { endValue: row[spec.end] } : {}),
        title: String(namedCell(table, spec.primary, row, referenceLabels).value ?? sayCopy('common.untitled')),
      });
    }
    return out;
  }, [drawnRows, table, spec, referenceLabels]);
  /* A day's records for the agenda: a range sits under its first day in the month. */
  const byDay = useMemo(() => {
    const days = new Map<string, CalendarCard[]>();
    for (const card of all) {
      const day = card.day < first ? first : card.day;
      days.set(day, [...(days.get(day) ?? []), card]);
    }
    return days;
  }, [all, first]);
  const records: ModalRecord[] = [...byDay.keys()]
    .sort()
    .flatMap((day) => byDay.get(day)!.map((card) => ({ key: card.key, label: card.title })));
  /* A column a card says, a label path dressed as the column it ends in. */
  const columnOf = (name: string | undefined): ColumnMeta | undefined => {
    if (!name) return undefined;
    if (!name.includes('.')) return table.columns.find((column) => column.name === name);
    const [reference, terminal] = name.split('.');
    const fk = (refsFrom(table.id) as Array<{ from: { columns: string[] }; to: { table: string } }>).find(
      (candidate) => candidate.from.columns.length === 1 && candidate.from.columns[0] === reference,
    );
    const target = fk ? (findTable(fk.to.table) as TableMeta | undefined) : undefined;
    const column = target?.columns.find((candidate) => candidate.name === terminal);
    return column ? { ...column, name } : undefined;
  };
  const lineColumn = columnOf(spec.lines?.[0]);
  /* A date under the title is captioned: on a calendar a bare date reads as
     the day the record is on, and a pay date is not the pay period. */
  const lineCaption =
    lineColumn && /date|time/i.test(lineColumn.type ?? '')
      ? ((columnLabel(table.id, lineColumn.name) as string | null) ?? humanName(lineColumn.name.split('.').pop() ?? lineColumn.name))
      : undefined;
  const badgeColumn = columnOf(spec.badge);
  /* A reference says the record it points at, as the title does: a bike's name, never its stored key. */
  const said = (column: ColumnMeta | undefined, row: Record<string, unknown>) => {
    if (!column) return null;
    const { column: drawn, value } = namedCell(table, column.name, row, referenceLabels);
    return value != null && value !== '' ? <Value tableId={table.id} col={drawn ?? column} value={value} compact /> : null;
  };
  /* Every card of a calendar is as tall as its fullest: a bar keeps its lane
     across days whose other cards say less. A status rides the title as its dot (below), so only a detail asks for
     the second line. */
  const twoLines = Boolean(spec.lines?.length);
  const open = (card: CalendarCard) => {
    if (interactive) void openRecord(table.id, card.key, card.title, 'push', { records });
  };

  /* Whole weeks, Monday first, from the week the month starts in to the week it ends in. */
  const weeks = useMemo(() => {
    const day = new Date(month);
    day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
    const end = addMonths(month, 1);
    const out: Date[][] = [];
    while (day < end || out[out.length - 1]?.length !== 7) {
      if (!out.length || out[out.length - 1].length === 7) out.push([]);
      out[out.length - 1].push(new Date(day));
      day.setDate(day.getDate() + 1);
    }
    return out;
  }, [month]);
  const weekdays = useMemo(() => {
    const say = new Intl.DateTimeFormat(locale, { weekday: 'short' });
    return Array.from({ length: 7 }, (_, i) => say.format(new Date(2024, 0, 1 + i)));
  }, [locale]);
  const fullDate = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  const shortDate = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
  const spanned = (card: CalendarCard) => shortDate.formatRange(at(card.day), at(card.last));
  const today = iso(new Date());

  // Every gate the ordinary update route applies, asked here so a card that
  // cannot move does not offer to; a date the App moves only through its
  // actions is the actions' to move.
  const current = findTable(table.id) as TableMeta | undefined;
  const canWrite = (name: string | undefined) => {
    const column = name === undefined ? undefined : current?.columns.find((c) => c.name === name);
    return Boolean(column && !column.primaryKey && column.writable !== false && column.changesBy !== 'actions');
  };
  // A range moves whole, so both of its ends must be the list's to write.
  const movable = Boolean(
    interactive &&
    writeAllowed(table.id) &&
    state.connections?.some((c) => c.id === connection && c.writable) &&
    !table.isView &&
    canWrite(spec.date) &&
    (spec.end === undefined || canWrite(spec.end)),
  );
  // A time of day stays; only the date moves.
  const keepTime = (raw: unknown, date: string) => (typeof raw === 'string' && raw.length > 10 ? `${date}${raw.slice(10)}` : date);
  const reschedule = (card: CalendarCard, date: string) => {
    if (!movable || date === card.day) return;
    const epoch = sessionIdentity().epoch;
    const isCurrent = () => mounted.current && epoch === sessionIdentity().epoch && connection === (state.activeConnection ?? null);
    const shift = Math.round((at(date).getTime() - at(card.day).getTime()) / 86_400_000);
    const values: Record<string, string> = { [spec.date]: keepTime(card.value, date) };
    if (spec.end && card.endValue != null) values[spec.end] = keepTime(card.endValue, addDays(card.last, shift));
    // The dates as the calendar read them: moved by someone else since, the move is refused, not written over theirs.
    const expected = expectedValues(table, values, card.row);
    // The card follows its date: into its month and onto its day, opened, with the focus — all drawn in the one
    // render the move is (begin flushes these with it), so the card the focus goes to is the one that stays.
    if (date.slice(0, 7) !== first.slice(0, 7)) setMonth(monthStart(at(date)));
    setOpened((current) => new Set([...current, weekOf(date)]));
    refocus.current = card.id;
    const move = optimistic.begin([[card.id, values]]);
    optimistic.enqueue(async () => {
      try {
        const result = await applyBulk(
          { connection, table: table.id },
          values,
          [{ key: card.key, label: card.title, ...(expected ? { expected } : {}) }],
          isCurrent,
        );
        if (!isCurrent()) return optimistic.undo(move);
        const outcome = result.outcomes[0];
        if (outcome.kind === 'applied') {
          optimistic.saved(move);
          toast(sayCopy('movedTitleToAt', { title: card.title, at: fullDate.format(at(date)) }), 'ok');
          void client.invalidateQueries({ queryKey: ['count', connection] });
        } else {
          // Refused, or uncertain (the update route's to settle, as on a board): drawn where the server has it.
          optimistic.undo(move);
          if (outcome.kind === 'rejected' || outcome.kind === 'blocked') toast(outcome.message, 'error');
        }
      } catch (error) {
        optimistic.undo(move);
        throw error;
      }
    });
  };
  const onCardKey = (event: KeyboardEvent<HTMLButtonElement>, card: CalendarCard) => {
    const step = event.altKey && !event.metaKey && !event.ctrlKey ? STEPS[event.key] : undefined;
    if (!step || !movable) return;
    event.preventDefault();
    reschedule(card, addDays(card.day, step));
  };
  /* Inside a day (the agenda has no grid, so its cards stay plain Tab stops):
     Up and Down step through what the day holds, Escape goes back to the day. */
  const onItemKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (phone || event.altKey || event.metaKey || event.ctrlKey) return;
    const day = event.currentTarget.closest<HTMLElement>('td.calendar-day');
    if (!day) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      day.focus();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const items = [...day.querySelectorAll<HTMLElement>(ITEMS)];
      const index = items.indexOf(event.currentTarget);
      items[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
    }
  };
  /* The day the grid's Tab stop is on: the one last visited while it is drawn,
     else today in its month, else the month's first. */
  const drawnDays = weeks.flat().map(iso);
  const tabDay = active && drawnDays.includes(active) ? active : today.slice(0, 7) === first.slice(0, 7) ? today : first;
  const goTo = (date: string) => {
    setActive(date);
    if (!drawnDays.includes(date)) setMonth(monthStart(at(date)));
    const cell = gridRef.current?.querySelector<HTMLElement>(`td[data-date="${date}"]`);
    if (cell && drawnDays.includes(date)) cell.focus();
    else pendingDay.current = date;
  };
  const onDayKey = (event: KeyboardEvent<HTMLTableCellElement>, date: string) => {
    // What a day holds keeps its own keys; only the day itself moves the grid.
    if (event.target !== event.currentTarget || event.altKey || event.metaKey || event.ctrlKey) return;
    const weekday = (at(date).getDay() + 6) % 7;
    const target =
      event.key in STEPS
        ? addDays(date, STEPS[event.key])
        : event.key === 'Home'
          ? addDays(date, -weekday)
          : event.key === 'End'
            ? addDays(date, 6 - weekday)
            : event.key === 'PageUp'
              ? sameDayIn(date, -1)
              : event.key === 'PageDown'
                ? sameDayIn(date, 1)
                : undefined;
    if (target) {
      event.preventDefault();
      goTo(target);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const item = event.currentTarget.querySelector<HTMLElement>(ITEMS);
      if (!item) return;
      event.preventDefault();
      item.focus();
    }
  };
  /* A day is a place to land: its cell in the month, its entry in the agenda. */
  /* No gap: a day holds its records in their time order, not a place a hand picks, so the day lights and the copy
     settles onto where the record is drawn. */
  const drag = usePointerDrag<CalendarCard>({
    over: (_card, at) => setOver(at?.zone.dataset.date),
    drop: (card, at) => {
      setOver(undefined);
      const date = at?.zone.dataset.date;
      if (date) reschedule(card, date);
    },
    end: () => setOver(undefined),
    locate: (card) => cardRefs.current.get(card.id) ?? null,
  });
  const zone = (date: string) => (movable ? { 'data-drop-zone': '', 'data-date': date } : { 'data-date': date });
  const card = (item: CalendarCard, extra = '', style?: CSSProperties, agenda = false) => {
    const badge = said(badgeColumn, item.row);
    const line = said(lineColumn, item.row);
    const ranged = item.last !== item.day;
    return (
      <button
        type="button"
        className={`calendar-card${twoLines ? ' has-line' : ''}${extra}${optimistic.pending(item.id) ? ' is-moving' : ''}`}
        style={style}
        disabled={!interactive}
        data-card={item.id}
        ref={(button) => {
          if (button) cardRefs.current.set(item.id, button);
          else cardRefs.current.delete(item.id);
        }}
        tabIndex={phone ? undefined : -1}
        onClick={() => open(item)}
        onKeyDown={(event) => {
          onCardKey(event, item);
          if (!event.defaultPrevented) onItemKey(event);
        }}
        {...drag.source(item, movable)}
        aria-keyshortcuts={movable ? 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown' : undefined}
        title={movable ? sayCopy('dragToAnotherDay') : undefined}
      >
        {/* In a day's cell the status is its toned dot before the title, its word kept for a reader and the pointer's
            hover: a pill cut to "Book…" beside a name cut to "Trek F…" said neither. The agenda has the room for the
            word, so it keeps it on the line. */}
        <span className="calendar-card-title">
          {badge && !agenda && (
            <span
              className="calendar-card-mark"
              ref={(mark) => {
                if (mark) mark.title = mark.firstElementChild?.textContent?.trim() ?? '';
              }}
            >
              {badge}
              <span className="calendar-sr">: </span>
            </span>
          )}
          {item.title}
        </span>
        {/* A range says its days: in words to a reader of the grid, as its line on the agenda. */}
        {ranged && !agenda && <span className="calendar-sr">, {spanned(item)}</span>}
        {((badge && agenda) || line || (ranged && agenda)) && (
          <span className="calendar-card-line">
            {badge && agenda && <span className="calendar-card-badge">{badge}</span>}
            {line && (
              <span className="calendar-card-detail">
                {lineCaption && <span className="calendar-card-caption">{lineCaption} </span>}
                {line}
              </span>
            )}
            {ranged && agenda && <span className="calendar-card-detail">{spanned(item)}</span>}
          </span>
        )}
      </button>
    );
  };
  /* A span's words where it starts, and again where it runs into a new week: a button to its record where the reader
     may open one, else plain words. Inline beside the day's number, so a span adds no height to the day. */
  const spanLabel = (span: CalendarSpan, i: number, agenda = false) => {
    const said = agenda ? sayCopy('spanDays', { label: span.label, days: shortDate.formatRange(at(span.day), at(span.last)) }) : span.label;
    return span.opens ? (
      <button
        key={i}
        type="button"
        className="calendar-backdrop"
        data-tone={span.tone}
        tabIndex={phone ? undefined : -1}
        onKeyDown={onItemKey}
        title={agenda ? undefined : sayCopy('spanDays', { label: span.label, days: shortDate.formatRange(at(span.day), at(span.last)) })}
        onClick={() => void openRecord(span.table, span.key, span.label, 'push')}
      >
        {said}
      </button>
    ) : (
      <span
        key={i}
        className="calendar-backdrop"
        data-tone={span.tone}
        title={agenda ? undefined : sayCopy('spanDays', { label: span.label, days: shortDate.formatRange(at(span.day), at(span.last)) })}
      >
        {said}
      </span>
    );
  };
  /* The spans over a day; their shade is the first's tone. */
  const spansOn = (date: string) => spans.filter((span) => span.day <= date && span.last >= date);
  const cards = (list: CalendarCard[]) => (
    <ul className="calendar-cards">
      {list.map((item) => (
        <li key={item.id}>{card(item, '', undefined, true)}</li>
      ))}
    </ul>
  );
  /* One day of a week: its lanes in order, a bar where one starts here, a
     held place where one runs through or a lower lane is empty. */
  const lanesOf = (placed: Placed[], column: number, shown: number) => {
    const here = placed.filter((piece) => piece.from <= column && piece.to >= column && piece.lane < shown);
    if (!here.length) return null;
    const top = Math.max(...here.map((piece) => piece.lane));
    return (
      <ul className="calendar-cards">
        {Array.from({ length: top + 1 }, (_, lane) => {
          const piece = here.find((candidate) => candidate.lane === lane);
          /* A card's place is keyed by its record, not its lane: a read that orders the day anew moves the card, and
             the focus with it, rather than handing its button (and the focus) to whichever record took its lane. */
          if (!piece || piece.from !== column)
            return <li key={`lane-${lane}`} className={`calendar-slot${twoLines ? ' has-line' : ''}`} aria-hidden="true" />;
          const span = piece.to - piece.from + 1;
          return (
            <li key={piece.card.id} className={span > 1 || piece.before || piece.after ? 'calendar-span' : undefined}>
              {card(
                piece.card,
                `${span > 1 ? ' is-span' : ''}${piece.before ? ' runs-before' : ''}${piece.after ? ' runs-after' : ''}`,
                span > 1 ? ({ '--calendar-span': span } as CSSProperties) : undefined,
              )}
            </li>
          );
        })}
      </ul>
    );
  };

  const body = answer.isError ? (
    <p className="calendar-note" role="alert">
      {(answer.error as Error).message}
    </p>
  ) : answer.isPending ? (
    <p className="calendar-note" role="status">
      {sayCopy('loadingTheMonth')}
    </p>
  ) : phone ? (
    <ol className="calendar-agenda">
      {[...new Set([...byDay.keys(), ...spans.map((span) => (span.day < first ? first : span.day)).filter((day) => day < next)])]
        .sort()
        .map((day) => {
          const starting = spans.filter((span) => (span.day < first ? first : span.day) === day);
          return (
            <li key={day} {...zone(day)} className={over === day ? 'is-over' : undefined}>
              <h3 className={`calendar-agenda-day${day === today ? ' is-today' : ''}`}>{fullDate.format(new Date(`${day}T00:00:00`))}</h3>
              {starting.length > 0 && (
                <div className="calendar-agenda-backdrops">{starting.map((span, i) => spanLabel(span, i, true))}</div>
              )}
              {byDay.has(day) && cards(byDay.get(day)!)}
            </li>
          );
        })}
    </ol>
  ) : (
    <table
      className="calendar-grid"
      role="grid"
      ref={gridRef}
      aria-label={new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(month)}
    >
      <thead>
        <tr>
          {weekdays.map((weekday) => (
            <th key={weekday} scope="col">
              {weekday}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week, i) => {
          const days = week.map(iso);
          const placed = placeWeek(days, all);
          // A week opens whole: a bar in a folded lane would run past the days still folded.
          const shown = opened.has(days[0]) ? Infinity : SHOWN;
          return (
            <tr key={i}>
              {week.map((day, column) => {
                const date = days[column];
                const outside = day.getMonth() !== month.getMonth();
                const hidden = placed.filter((piece) => piece.from <= column && piece.to >= column && piece.lane >= shown).length;
                const shaded = spansOn(date);
                /* Said where a span starts, and on a week's first day for one that runs into it. */
                const named = shaded.filter((span) => span.day === date || column === 0);
                return (
                  <td
                    key={date}
                    {...zone(date)}
                    tabIndex={date === tabDay ? 0 : -1}
                    aria-current={date === today ? 'date' : undefined}
                    onKeyDown={(event) => onDayKey(event, date)}
                    onFocus={() => setActive(date)}
                    data-backdrop={shaded[0]?.tone}
                    className={`calendar-day${outside ? ' is-outside' : ''}${date === today ? ' is-today' : ''}${over === date ? ' is-over' : ''}`}
                  >
                    <span className="calendar-date">
                      <span aria-hidden="true">{day.getDate()}</span>
                      <span className="calendar-sr">{fullDate.format(day)}</span>
                    </span>
                    {named.map((span, n) => spanLabel(span, n))}
                    {lanesOf(placed, column, shown)}
                    {hidden > 0 && (
                      <button
                        type="button"
                        className="calendar-more"
                        tabIndex={-1}
                        onKeyDown={onItemKey}
                        aria-label={sayCopy('more', { hidden: formatNumber(hidden), day: fullDate.format(day) })}
                        onClick={(event) => {
                          // The button goes as the week opens; the focus stays on its day rather than falling to the page.
                          event.currentTarget.closest<HTMLElement>('td')?.focus();
                          setOpened((current) => new Set([...current, days[0]]));
                        }}
                      >
                        {sayCopy('moreHidden', { count: formatNumber(hidden) })}
                      </button>
                    )}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <section className="calendar-list" aria-label={label ?? sayCopy('calendar')}>
      <div className="calendar-head">
        <h2 className="calendar-title" aria-live="polite">
          {new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(month)}
        </h2>
        <div className="calendar-nav">
          <button
            type="button"
            className="ghost"
            aria-label={sayCopy('previousMonth')}
            onClick={() => setMonth((current) => addMonths(current, -1))}
          >
            <Icon name="caret-left" size={16} />
          </button>
          <button type="button" className="ghost" onClick={() => setMonth(monthStart(new Date()))}>
            {sayCopy('common.today')}
          </button>
          <button
            type="button"
            className="ghost"
            aria-label={sayCopy('nextMonth')}
            onClick={() => setMonth((current) => addMonths(current, 1))}
          >
            <Icon name="caret-right" size={16} />
          </button>
        </div>
      </div>
      {body}
      {answer.data && !answer.data.rows.length && <p className="calendar-note">{sayCopy('nothingOnTheCalendar')}</p>}
      {answer.data?.more && <p className="calendar-note">{sayCopy('showingTheFirstThisMonth', { max: LIMIT })}</p>}
    </section>
  );
}
