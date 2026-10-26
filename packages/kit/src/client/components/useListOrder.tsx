/**
 * A list's rows in the order an editor gives them by hand: a view's `order`
 * column, read ascending, and changed three ways, none pointer-only — a row
 * dragged into place, Alt and ↑/↓ on a focused row, and the row's grip menu
 * (up, down, top, bottom). Each is the board's move (placeOrder.ts): the one
 * row, numbered halfway between its new neighbors, and the run renumbered a
 * step apart only when there is no number left between them — ordinary
 * updates, each checked, recorded and undoable.
 *
 * Offered only where the rows are read in that order now: a reader who sorts
 * by a header, a tab with a sort of its own, or a Sort menu choice reads the
 * rows another way, and the handles go until the order is back. And only to a
 * reader who may edit the column, on the same gates as the update route.
 *
 * A move is drawn at once (optimisticMoves.ts): the row stands in its new
 * place from the moment it is let go, and goes back, with the server's
 * sentence, only if a write is refused. Moves made while one saves wait their
 * turn. Rows one under another open a gap where the row will land, the
 * board's (usePointerDrag's `gap`); cards side by side keep the mark at their
 * side, since a gap in a wrapping grid would move every card after it.
 *
 * On a page of a longer list a row can take a number between two neighbors
 * on the page but the run is never renumbered, which would collide with the
 * pages it cannot see; the move says so instead.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { findTable, keyOf, state, toast, writeAllowed } from '../core.js';
import { applyBulk, bulkKey } from '../bulkActions.js';
import { shell } from '../shellMode.js';
import { sessionIdentity } from '../sessionIdentity.js';
import { expectedValues, labelColumn, primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { PLACES, placeIndex, placements, positionOf, savePlaces, wholeColumn, type Place } from './placeOrder.js';
import { landingBefore } from './pointerDrag.js';
import { useOptimisticMoves } from './optimisticMoves.js';
import { usePointerDrag, type DropPoint } from './usePointerDrag.js';
import { DropGroup, DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
import { RowDecoration, rowKeyString } from './RowHost.js';
import { say } from '../copy/lists/components/useListOrder.js';

/** A view's order, as the list room hands it on. */
export interface ListOrder {
  /** The numeric column holding each row's place. */
  column: string;
  /** The rows are read in that order now, and nothing else. */
  active: boolean;
  /** The rows are a page of a longer list. */
  partial: boolean;
}

interface ListOrderOptions {
  table: TableMeta;
  rows: Array<Record<string, unknown>>;
  order?: ListOrder;
  interactive: boolean;
  title: (row: Record<string, unknown>) => string;
  /** How a row is named on its element; bulkKey's spelling in `data-drop-item` unless the rows already carry one. */
  id?: (row: Record<string, unknown>, key: Record<string, unknown>) => string | null;
  /** The attribute a row's element carries its id in. */
  attribute?: string;
  /** Where the focus goes back to after a move, from the row's element. */
  focusOf?: (item: HTMLElement) => HTMLElement | null;
  /** Rows that stand beside each other, as cards in columns: a row's halves are left and right. */
  across?: (zone: HTMLElement) => boolean;
}

interface Entry {
  id: string;
  key: Record<string, unknown>;
  title: string;
  position?: number;
}

const ownFocus = (item: HTMLElement) => item.querySelector<HTMLElement>('[data-order-focus]');

export function useListOrder({
  table,
  rows,
  order,
  interactive,
  title,
  id: idOf,
  attribute = 'data-drop-item',
  focusOf = ownFocus,
  across,
}: ListOrderOptions) {
  const client = useQueryClient();
  const [said, setSaid] = useState('');
  const zone = useRef<HTMLElement | null>(null);
  const refocus = useRef<string | null>(null);
  const chosen = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const nameOf = (row: Record<string, unknown>) => {
    const key = keyOf(table, row) as Record<string, unknown> | null;
    return key ? (idOf ? idOf(row, key) : bulkKey(table, key)) : null;
  };
  const connection = state.activeConnection ?? null;
  /* A move is drawn before it is saved: its rows carry their new numbers, and stand in that order. */
  const optimistic = useOptimisticMoves(rows, nameOf, () => client.invalidateQueries({ queryKey: ['run', connection] }));
  const drawnRows = useMemo(() => {
    if (!order || optimistic.rows === rows) return rows;
    const place = (row: Record<string, unknown>) => positionOf(row[order.column]) ?? Number.POSITIVE_INFINITY;
    return [...optimistic.rows].sort((a, b) => place(a) - place(b));
  }, [optimistic.rows, rows, order]);
  /* Rows are named only in a list that keeps an order: every other list pays nothing. */
  const named = !order
    ? []
    : drawnRows.flatMap((row) => {
        const key = keyOf(table, row) as Record<string, unknown> | null;
        const id = key ? (idOf ? idOf(row, key) : bulkKey(table, key)) : null;
        if (!key || id === null) return [];
        const position = positionOf(row[order.column]);
        return [{ row, entry: { id, key, title: title(row), ...(position === undefined ? {} : { position }) } as Entry }];
      });
  const entries = named.map((each) => each.entry);
  const rowIds = new Map(named.map((each) => [each.row, each.entry.id]));
  const ids = entries.map((entry) => entry.id);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  /* Every gate the ordinary update route applies, asked only of a list that keeps an order. */
  const column = order ? ((findTable(table.id) as TableMeta | undefined) ?? table).columns.find((c) => c.name === order.column) : undefined;
  const orderable = Boolean(
    order?.active &&
    interactive &&
    column &&
    entries.length > 1 &&
    writeAllowed(table.id) &&
    state.connections?.some((c: { id: string; writable?: boolean }) => c.id === connection && c.writable) &&
    !table.isView &&
    !column.primaryKey &&
    column.writable !== false &&
    column.changesBy !== 'actions',
  );
  const whole = wholeColumn(column?.type);

  const itemOf = (id: string) =>
    [...(zone.current?.querySelectorAll<HTMLElement>(`[${attribute}]`) ?? [])].find((item) => item.getAttribute(attribute) === id) ?? null;
  /* A moved row is drawn anew in its place; the focus follows it once it is there. */
  useEffect(() => {
    const item = refocus.current ? itemOf(refocus.current) : null;
    const target = item && focusOf(item);
    if (target) {
      target.focus();
      refocus.current = null;
    }
  });

  const write = async (entry: Entry, value: number, isCurrent: () => boolean) => {
    const values = { [order!.column]: value };
    const expected = expectedValues(table, values, named.find((each) => each.entry.id === entry.id)?.row);
    const result = await applyBulk(
      { connection, table: table.id },
      values,
      [{ key: entry.key, label: entry.title, ...(expected ? { expected } : {}) }],
      isCurrent,
    );
    const outcome = result.outcomes[0];
    return outcome.kind === 'applied'
      ? null
      : { message: outcome.message, refused: outcome.kind === 'rejected' || outcome.kind === 'blocked' };
  };
  const move = (entry: Entry, index: number) => {
    if (!orderable) return;
    const writes = placements(
      entry,
      entries.filter((each) => each.id !== entry.id),
      index,
      whole,
    );
    if (!writes.length) return;
    if (order!.partial && writes.length > 1) {
      toast(say('thereIsNoRoom', { title: entry.title }), 'error');
      return;
    }
    const epoch = sessionIdentity().epoch;
    const isCurrent = () => mounted.current && epoch === sessionIdentity().epoch && connection === (state.activeConnection ?? null);
    const token = optimistic.begin(writes.map(([each, value]) => [each.id, { [order!.column]: value }] as const));
    refocus.current = entry.id;
    setSaid(say('movedToPlace', { title: entry.title, index: index + 1, entriesCount: entries.length }));
    optimistic.enqueue(async () => {
      try {
        const saved = await savePlaces(writes, (each, value) => write(each, value, isCurrent), isCurrent);
        if (saved.stale) return optimistic.undo(token);
        if (!saved.applied || saved.failed) {
          // A renumbered run part-written goes back to what the server says, read again when the queue is done.
          optimistic.undo(token);
          if (saved.failed?.refused) toast(saved.failed.message, 'error');
          if (!saved.applied) return;
        } else optimistic.saved(token);
        void shell().undo.refresh();
        void client.invalidateQueries({ queryKey: ['count', connection] });
      } catch (error) {
        optimistic.undo(token);
        throw error;
      }
    });
  };
  const place = (id: string, where: Place) => {
    const entry = byId.get(id);
    const index = placeIndex(ids, id, where);
    if (entry && index !== undefined) move(entry, index);
  };

  /* Where a drop lands: before the row in whose first half it is let go,
     before the next in its second, last past the last — and nowhere when
     that is where the row already stands. */
  const landing = (id: string, at: DropPoint | null): { index: number; before?: string; beside: boolean } | undefined => {
    if (!at || at.zone !== zone.current) return undefined;
    const over = at.item?.getAttribute(attribute) ?? undefined;
    const beside = Boolean(across?.(at.zone));
    const before = landingBefore(ids, id, over, beside ? at.left : at.upper);
    const others = ids.filter((each) => each !== id);
    const index = before === undefined ? others.length : others.indexOf(before);
    return index < 0 || index === ids.indexOf(id) ? undefined : { index, before, beside };
  };
  /* The mark is an attribute on the row's element, set here rather than drawn: a grid's rows are the grid's to render. */
  const clear = () => {
    for (const marked of zone.current?.querySelectorAll('[data-drop]') ?? []) marked.removeAttribute('data-drop');
  };
  const drag = usePointerDrag<string>({
    items: `[${attribute}]`,
    gap: !across,
    locate: (id) => itemOf(id),
    over: (id, at) => {
      clear();
      const landed = landing(id, at);
      if (!landed) return null;
      // Rows one under another: the gap opens where the row will land, and is the mark.
      if (!landed.beside) return { zone: zone.current!, before: landed.before === undefined ? null : itemOf(landed.before) };
      const last = ids.filter((each) => each !== id).at(-1);
      const marked = itemOf(landed.before ?? last ?? '');
      // Rows one under another take a rule above or below; cards side by side, at their side.
      const edge = landed.before === undefined ? (landed.beside ? 'end' : 'after') : landed.beside ? 'start' : 'before';
      marked?.setAttribute('data-drop', edge);
      return null;
    },
    drop: (id, at) => {
      clear();
      const landed = landing(id, at);
      const entry = byId.get(id);
      if (landed && entry) move(entry, landed.index);
    },
    end: clear,
  });

  const keyDown = (event: KeyboardEvent, id: string) => {
    if (!orderable || !event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    event.stopPropagation();
    place(id, event.key === 'ArrowUp' ? 'up' : 'down');
  };

  /* A row's grip: the place menu, quiet until the row is hovered or focused
     (always there on touch), and a sign that the row itself can be dragged.
     Pressing it opens the menu rather than starting a drag. */
  const menu = (id: string): ReactNode => {
    const entry = byId.get(id);
    if (!orderable || !entry) return null;
    const places = PLACES.filter(([where]) => placeIndex(ids, id, where) !== undefined);
    return (
      <span className="order-grip" data-drag-ignore="">
        <DropMenu
          className="order-menu"
          triggerClassName="order-grip-button"
          triggerLabel={say('reorder', { title: entry.title })}
          triggerTitle={say('dragTheRowPress')}
          label={<span aria-hidden="true">⠿</span>}
          popupClassName="more-list order-menu-list"
          onOpenChange={(open) => {
            if (open) chosen.current = null;
          }}
          finalFocus={() => {
            const item = chosen.current === id ? itemOf(id) : null;
            return (item && focusOf(item)) ?? true;
          }}
        >
          <DropGroup label={say('order')} labelClassName="more-group-label">
            {places.map(([where, label]) => (
              <DropItem
                key={where}
                className="more-item"
                onClick={() => {
                  chosen.current = id;
                  place(id, where);
                }}
              >
                <span className="more-tick" aria-hidden="true" />
                <span className="more-label">{label}</span>
              </DropItem>
            ))}
          </DropGroup>
        </DropMenu>
      </span>
    );
  };

  return {
    orderable,
    /** The rows as they are to be drawn: in their places, a move made and not yet read back included. */
    rows: drawnRows,
    /** Whether a row's move is still being saved. */
    pending: (id: string) => Boolean(optimistic.pending(id)),
    /** The list's element: where its rows land, and where their marks and the focus are looked for. */
    zone: {
      ref: (element: HTMLElement | null) => {
        zone.current = element;
      },
      ...(orderable ? { 'data-drop-zone': '' } : {}),
    },
    /** A row's name here, in a list that keeps an order; null in any other. */
    id: (row: Record<string, unknown>) => rowIds.get(row) ?? null,
    /** A row's element, by id: its name for the drop, and a drag source while the rows may move. */
    item: (id: string) => (orderable && byId.has(id) ? { [attribute]: id, ...drag.source(id, true) } : {}),
    start: (event: ReactPointerEvent, id: string, element: HTMLElement) => {
      if (orderable && byId.has(id)) drag.start(event, id, element);
    },
    keyDown,
    menu,
    shortcuts: orderable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined,
    /** Said to assistive technology after a move. */
    live: order ? (
      <div className="visually-hidden" aria-live="polite">
        {said}
      </div>
    ) : null,
  };
}

/**
 * The grid's rows put in order: the grid draws its own rows, so a press on
 * one is taken here, by delegation, and each row's grip is portalled into
 * its leading cell (RowHost.tsx). Under a RowHosts scope, beside any other
 * decoration of the same rows.
 */
export function GridOrder({
  table,
  rows,
  order,
  interactive,
  children,
}: {
  table: TableMeta;
  rows: Array<Record<string, unknown>>;
  order: ListOrder;
  interactive: boolean;
  /** The grid, drawn from the rows in their places (a move not yet read back included). */
  children: (rows: Array<Record<string, unknown>>) => ReactNode;
}) {
  const naming = labelColumn(table) ?? primaryKey(table)[0];
  const ordering = useListOrder({
    table,
    rows,
    order,
    interactive,
    title: (row) => String(row[naming] ?? say('common.untitled')),
    id: (row) => rowKeyString(table, row),
    attribute: 'data-row-key',
    focusOf: (item) => item.querySelector<HTMLElement>('.order-grip-button'),
  });
  const rowOf = (target: EventTarget | null) => (target as Element | null)?.closest?.<HTMLElement>('tr[data-row-key]') ?? null;
  return (
    <div
      className="grid-order"
      {...ordering.zone}
      onPointerDown={(event) => {
        const row = rowOf(event.target);
        if (row) ordering.start(event, row.dataset.rowKey!, row);
      }}
      onKeyDown={(event) => {
        const row = rowOf(event.target);
        if (row) ordering.keyDown(event, row.dataset.rowKey!);
      }}
    >
      {children(ordering.rows)}
      {ordering.orderable &&
        ordering.rows.map((row) => {
          const key = rowKeyString(table, row);
          return key === null ? null : (
            <RowDecoration key={key} rowKey={key}>
              {ordering.menu(key)}
            </RowDecoration>
          );
        })}
      {ordering.live}
    </div>
  );
}
