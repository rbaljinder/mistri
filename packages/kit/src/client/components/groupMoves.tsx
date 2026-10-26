/**
 * A grouped list's rows moved by hand (PageGroups.tsx): a row dragged into
 * another group takes that group's value — the same write a board's lane
 * makes, an ordinary update of the grouped column where the reader may write
 * it, or the one command that takes it (`moveToSprint` with `{ sprint }`) —
 * and, where the list is read in a hand order (its sort is one number column
 * the reader may write), a place within the group, numbered as a list view's
 * row is (placeOrder.ts). Alt and ↑/↓ on a row do the same a step at a time:
 * up and down within a ranked group, and past its first or last row into the
 * group before or after.
 *
 * The move is drawn at once (optimisticMoves.ts) and read back once when the
 * last is done; a refusal puts the row back and says the server's sentence.
 * A group the row cannot enter (the empty group, where no write clears the
 * column) is shut while the row is carried, and a row let go over it says so.
 * Rows in a group with no hand order take no place: they land at its end and
 * no gap opens inside it.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { toast } from '../core.js';
import { placements, positionOf, type PlaceFailure } from './placeOrder.js';
import { useOptimisticMoves } from './optimisticMoves.js';
import { usePointerDrag, type DropPoint, type DropSlot } from './usePointerDrag.js';
import { say } from '../copy/record/components/groupMoves.js';

/** What the list hands a grouped body so its rows can move: PageRelated decides the path, the body draws the moves. */
export interface GroupMoves {
  /** A row's key under its table's own columns, and its key string as the grid names its `<tr>` (rowKeyString). */
  keyOf: (row: Record<string, unknown>, columns: readonly string[]) => { key: Record<string, unknown>; id: string } | null;
  labelOf: (row: Record<string, unknown>, columns: readonly string[]) => string;
  /** Whether a row may be put in the group with this key (null or undefined: the group with none). */
  enters: (key: unknown) => boolean;
  /** Put the row in the group: null once it applied, else the sentence it was refused with ('' when said already). */
  regroup: (key: Record<string, unknown>, label: string, from: unknown, to: unknown) => Promise<string | null>;
  /** The number column the rows are ranked by, where the list is read in it and the reader may write it. */
  rank?: {
    column: string;
    whole: boolean;
    write: (key: Record<string, unknown>, label: string, value: number, expected: unknown) => Promise<PlaceFailure | null>;
  };
  /** The rows are read again: every group, and the groups' own counts and sums. */
  done: () => Promise<unknown>;
}

/** The output name the rank is read under when the list does not show it. */
export const RANK = '__rank';
const GROUP = '__group';

interface Carried {
  id: string;
  group: number;
}
interface Entry {
  id: string;
  key: Record<string, unknown>;
  title: string;
  position?: number;
}

/* Each group's rows, named by the group they came from: cached on the answer, so the same answer is the same rows. */
const tagged = new WeakMap<object, Array<Record<string, unknown>>>();
function tag(answer: object, rows: Array<Record<string, unknown>>, group: string) {
  let out = tagged.get(answer);
  if (!out || out[0]?.[GROUP] !== group) {
    out = rows.map((row) => ({ ...row, [GROUP]: group }));
    tagged.set(answer, out);
  }
  return out;
}

export function useGroupMoves({
  moves,
  groups,
  answers,
  columns,
  label,
}: {
  moves: GroupMoves | undefined;
  /** Each group's key, in the order drawn. */
  groups: readonly unknown[];
  /** Each group's answer as read (its rows), or undefined while it is asked. */
  answers: ReadonlyArray<{ rows?: unknown[] } | undefined>;
  columns: readonly string[];
  /** A group's name as its header says it. */
  label: (key: unknown) => string;
}) {
  const text = (key: unknown) => String(key ?? '');
  const zones = useRef(new Map<number, HTMLElement>());
  const refocus = useRef<string | null>(null);
  const [said, setSaid] = useState('');
  const [shut, setShut] = useState<number | null>(null);
  const live = useRef(moves);
  live.current = moves;

  const base = answers.flatMap((answer, i) =>
    answer?.rows ? tag(answer, answer.rows as Array<Record<string, unknown>>, text(groups[i])) : [],
  );
  const idOf = (row: Record<string, unknown>) => (moves ? (moves.keyOf(row, columns)?.id ?? null) : null);
  const optimistic = useOptimisticMoves(base, idOf, () => live.current?.done());
  const homeOf = useMemo(() => new Map(base.map((row) => [idOf(row), row[GROUP] as string])), [base]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Each group's rows as drawn: what the moves put there, in rank order where the list keeps one, a row moved in
      from elsewhere last where it does not. */
  const bodies = groups.map((key) => {
    const own = optimistic.rows.filter((row) => row[GROUP] === text(key));
    if (moves?.rank) {
      const at = (row: Record<string, unknown>) => positionOf(row[RANK]) ?? Number.POSITIVE_INFINITY;
      return own
        .map((row, i) => [row, i] as const)
        .sort((a, b) => at(a[0]) - at(b[0]) || a[1] - b[1])
        .map(([row]) => row);
    }
    const stayed = own.filter((row) => homeOf.get(idOf(row)) === text(key));
    return [...stayed, ...own.filter((row) => homeOf.get(idOf(row)) !== text(key))];
  });
  /** How many rows a move took into (positive) or out of a group, for its header's count until it is read again. */
  const drift = (i: number) => {
    let by = 0;
    if (!moves || optimistic.rows === base) return by;
    for (const row of optimistic.rows) {
      const id = idOf(row);
      if (id === null) continue;
      const home = homeOf.get(id);
      if (row[GROUP] === text(groups[i]) && home !== text(groups[i])) by++;
      else if (row[GROUP] !== text(groups[i]) && home === text(groups[i])) by--;
    }
    return by;
  };

  const entriesOf = (i: number): Entry[] =>
    bodies[i].flatMap((row) => {
      const named = moves?.keyOf(row, columns);
      if (!named) return [];
      const position = positionOf(row[RANK]);
      return [{ id: named.id, key: named.key, title: moves!.labelOf(row, columns), ...(position === undefined ? {} : { position }) }];
    });
  const rowOf = (id: string) => optimistic.rows.find((row) => idOf(row) === id);

  /* A moved row is a new element in its new group; the focus follows it there. */
  const itemOf = (id: string) => {
    for (const zone of zones.current.values())
      for (const item of zone.querySelectorAll<HTMLElement>('tr[data-row-key]')) if (item.dataset.rowKey === id) return item;
    return null;
  };
  useEffect(() => {
    const item = refocus.current ? itemOf(refocus.current) : null;
    if (item) {
      item.focus();
      refocus.current = null;
    }
  });
  /* The grid draws its own rows; a row that can move is a Tab stop, with its keys said. */
  useEffect(() => {
    for (const zone of zones.current.values())
      for (const item of zone.querySelectorAll<HTMLElement>('tr[data-row-key]')) {
        if (moves) {
          item.tabIndex = 0;
          item.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
          item.setAttribute('data-draggable', 'true');
          // A row whose move is being saved is quiet, as a board's card is (TriageBoard.css `is-saving`).
          const pending = optimistic.pending(item.dataset.rowKey ?? '');
          item.style.opacity = pending ? '0.7' : '';
          if (pending) item.setAttribute('aria-busy', 'true');
          else item.removeAttribute('aria-busy');
        }
      }
  });

  /** Move a row into group `to` at `index` among the rows already there (its end where there is no hand order). */
  const move = (id: string, from: number, to: number, index?: number) => {
    const row = rowOf(id);
    const named = row && moves?.keyOf(row, columns);
    if (!moves || !row || !named) return;
    const title = moves.labelOf(row, columns);
    const group = label(groups[to]);
    if (from !== to && !moves.enters(groups[to])) {
      toast(say('cannotEnter', { title, group }), 'error');
      return;
    }
    const others = entriesOf(to).filter((entry) => entry.id !== id);
    const entry: Entry = { id, key: named.key, title, ...(positionOf(row[RANK]) === undefined ? {} : { position: positionOf(row[RANK]) }) };
    const ranked = moves.rank && index !== undefined ? placements(entry, others, index, moves.rank.whole) : [];
    if (from === to && !ranked.length) return;
    const writes: Array<readonly [string, Record<string, unknown>]> = [];
    if (from !== to) writes.push([id, { [GROUP]: text(groups[to]) }]);
    for (const [each, value] of ranked) writes.push([each.id, { [RANK]: value }]);
    const token = optimistic.begin(writes);
    refocus.current = id;
    const place = index === undefined ? undefined : Math.min(index, others.length) + 1;
    setSaid(
      place !== undefined && moves.rank
        ? say('movedToPlace', { title, index: place, count: others.length + 1, group })
        : say('movedToGroup', { title, group }),
    );
    optimistic.enqueue(async () => {
      try {
        if (from !== to) {
          const refused = await moves.regroup(named.key, title, groups[from], groups[to]);
          if (refused !== null) {
            optimistic.undo(token);
            const sentence = say('wentBack', { title, group: label(groups[from]), reason: refused || say('notMoved') });
            // '' is a refusal its command's own pipeline has said already; once is enough on screen.
            if (refused) toast(sentence, 'error');
            setSaid(sentence);
            return;
          }
        }
        for (const [each, value] of ranked) {
          const failed = await moves.rank!.write(each.key, each.title, value, each.position ?? null);
          if (failed) {
            // The row's group is moved; its place is what the read says, once the queue is done.
            if (failed.refused) toast(failed.message, 'error');
            break;
          }
        }
        optimistic.saved(token);
      } catch (error) {
        optimistic.undo(token);
        throw error;
      }
    });
  };

  /* Where a drop lands: the group under the pointer, and in a ranked one before the row in whose upper half it is. */
  const groupOf = (zone: HTMLElement | null | undefined) => {
    for (const [i, each] of zones.current) if (each === zone) return i;
    return undefined;
  };
  const landing = (carried: Carried, at: DropPoint | null) => {
    const to = groupOf(at?.zone);
    if (to === undefined || !at) return undefined;
    if (to !== carried.group && !moves?.enters(groups[to])) return { to, shut: true as const };
    if (!moves?.rank) return to === carried.group ? undefined : { to, before: null as HTMLElement | null };
    const rows = [...at.zone.querySelectorAll<HTMLElement>('tr[data-row-key]')].filter((item) => item.dataset.rowKey !== carried.id);
    let before: HTMLElement | null = null;
    if (at.item) {
      const i = rows.indexOf(at.item);
      before = i < 0 ? null : at.upper ? at.item : (rows[i + 1] ?? null);
    }
    const index = before ? rows.indexOf(before) : rows.length;
    if (to === carried.group) {
      const ids = entriesOf(to).map((entry) => entry.id);
      if (ids.indexOf(carried.id) === index) return undefined;
    }
    return { to, before, index };
  };
  const drag = usePointerDrag<Carried>({
    items: 'tr[data-row-key]',
    gap: true,
    locate: (carried) => itemOf(carried.id),
    over: (carried, at): DropSlot | null => {
      const landed = landing(carried, at);
      setShut(landed && 'shut' in landed ? landed.to : null);
      if (!landed || 'shut' in landed) return null;
      return { zone: zones.current.get(landed.to)!, before: landed.before };
    },
    drop: (carried, at) => {
      setShut(null);
      const landed = landing(carried, at);
      if (!landed) return;
      if ('shut' in landed) {
        const row = rowOf(carried.id);
        toast(say('cannotEnter', { title: row && moves ? moves.labelOf(row, columns) : '', group: label(groups[landed.to]) }), 'error');
        return;
      }
      move(carried.id, carried.group, landed.to, 'index' in landed ? landed.index : undefined);
    },
    end: () => setShut(null),
  });

  const groupOfRow = (id: string) => bodies.findIndex((rows) => rows.some((row) => idOf(row) === id));
  /* Alt and ↑/↓: a place up or down in a ranked group, and past its edge into the group before or after. */
  const step = (id: string, by: -1 | 1) => {
    const from = groupOfRow(id);
    if (from < 0) return;
    const ids = entriesOf(from).map((entry) => entry.id);
    const at = ids.indexOf(id);
    if (moves?.rank && at + by >= 0 && at + by < ids.length) {
      move(id, from, from, at + by);
      return;
    }
    for (let to = from + by; to >= 0 && to < groups.length; to += by) {
      if (!moves?.enters(groups[to])) continue;
      move(id, from, to, moves.rank ? (by > 0 ? 0 : entriesOf(to).length) : undefined);
      return;
    }
  };

  return {
    movable: Boolean(moves),
    bodies,
    drift,
    pending: (id: string) => optimistic.pending(id),
    /** A group's rows element: where rows land, the shut mark while a row is carried that cannot enter. */
    zone: (i: number) =>
      moves
        ? {
            ref: (element: HTMLElement | null) => {
              if (element) zones.current.set(i, element);
              else zones.current.delete(i);
            },
            'data-drop-zone': '',
            ...(drag.dragging && shut === i ? { 'data-shut': '', style: { opacity: 0.5 } } : {}),
            onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
              const item = (event.target as Element).closest<HTMLElement>('tr[data-row-key]');
              if (item && event.currentTarget.contains(item)) drag.start(event, { id: item.dataset.rowKey!, group: i }, item);
            },
            onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
              const item = event.target as HTMLElement;
              if (!(item instanceof HTMLTableRowElement) || !item.dataset.rowKey) return;
              if (event.key === 'Enter' && !event.altKey) {
                item.click();
                return;
              }
              if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
              event.preventDefault();
              step(item.dataset.rowKey, event.key === 'ArrowUp' ? -1 : 1);
            },
          }
        : {},
    live: moves ? (
      <div className="visually-hidden" aria-live="polite">
        {said}
      </div>
    ) : null,
  };
}
