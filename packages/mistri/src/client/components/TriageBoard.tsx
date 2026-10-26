/**
 * A board of lanes and cards: a lane per value of the board's `by` column (or,
 * on a board by a reference, per referenced row), optional swimlane rows, work
 * in progress said in each lane's head against its limit, and a card per
 * record. A card moves by drag, by Alt and an arrow, or from its ⋯ menu — one
 * move each way, announced, with the focus kept on the card. This component
 * draws the board and gathers the gesture; the list that owns it
 * (BoardList.tsx) decides whether the move is allowed and writes it.
 */
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MutableRefObject, ReactNode, RefObject } from 'react';
import './TriageBoard.css';
import { formatNumber } from '@mistriwork/kit/client/locale.js';
import { DropGroup, DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
import { Icon, type IconName } from '@mistriwork/kit/client/components/Icon.js';
import { PLACES, placeIndex as indexIn, type Place } from '@mistriwork/kit/client/components/placeOrder.js';
import { landingBefore } from '@mistriwork/kit/client/components/pointerDrag.js';
import { usePointerDrag, type DropPoint, type DropSlot } from '@mistriwork/kit/client/components/usePointerDrag.js';
import { Empty } from '@mistriwork/kit/client/components/Notes.js';
import { say } from '../copy/lists/components/TriageBoard.js';

export interface TriageLane {
  id: string;
  label: string;
  /** The stored value, said on hover where the label is a word made from it. */
  title?: string;
  /** A work-in-progress limit: the head says "count / limit" and warns past it. Shown here, never enforced. */
  limit?: number;
  /** The lane's name as its column dresses it (a dot and its word); `label` stays its accessible text. */
  mark?: ReactNode;
  /** How many records the lane holds in all, where the host knows more than the cards drawn. */
  total?: number;
  /** More of the lane's cards, fetched by the host: how many are not drawn yet, and how to ask for them. */
  more?: { count: number; onMore: () => void };
  /** A New record in this lane, where the host offers one: a "+" in the lane's head. */
  onNew?: () => void;
  /** What the lane's cards are worth together, said short ("$92.8K") beside its count, and in full in its title. */
  sum?: { text: string; title: string };
  /** Drawn folded: a narrow strip with its name down its side, its count and its sum, that opens on a click. */
  folded?: boolean;
  /** Folds or opens the lane, where the host lets it fold: a closed stage (won, lost) is news a reader opens. */
  onFold?: () => void;
}

/** One fact on a card's foot: an optional mark, the value as its column dresses it, its words for the card's name. */
interface TriageFact {
  key: string;
  icon?: string;
  node: ReactNode;
  text: string;
  /** A person (an avatar or a stack of them): stands at the foot's right end. */
  person?: boolean;
}

/** A swimlane: one row across every lane. */
export interface TriageRow {
  id: string;
  label: string;
  title?: string;
}

export interface TriageCard {
  id: string;
  laneId: string;
  /** The row the card stands in, on a board with rows. */
  rowId?: string;
  title: string;
  subtitle?: string;
  /** The subtitle as its column dresses it; `subtitle` stays its accessible text. */
  line?: ReactNode;
  meta?: string;
  /**
   * The lanes this card may move to, decided by the host. Absent means any
   * other lane; an empty list means no move is offered — the control is not
   * drawn rather than drawn and refused.
   */
  targets?: string[];
  /** The card's fields the reader may edit in place, each with its caption, the first one F2's. */
  edits?: Array<{ field: string; label: string }>;
  /** What kind of thing the card is: a chip over the title in one of the theme's eight series colors (1–8). */
  category?: { label: string; color: number };
  /** Facts along the card's foot. */
  footer?: TriageFact[];
  /** Another person just changed it: which of the two fading tints it wears (docs/design.md, rule 11). */
  changed?: 1 | 2;
  /** A move of it drawn before the server has it: being saved, or waiting on a form the move opened. */
  pending?: 'saving' | 'asking';
}

/** Where a move sends a card: a lane, a row on a board with rows, and a place among the cards there. */
export interface TriageTarget {
  lane: string;
  row?: string;
  /** The card's place among the cards already there, 0 at the top; absent keeps the card's own number. */
  index?: number;
}

export interface TriageBoardProps {
  lanes: TriageLane[];
  cards: TriageCard[];
  /** Swimlanes, in order. Absent draws one row of lanes. */
  rows?: TriageRow[];
  /** What the rows are, for the card menu's group: "Priority". */
  rowsLabel?: string;
  /** Why no card may change row here: said when one is dropped on another row, and no control offers it. */
  rowLock?: string;
  selectedId?: string;
  onSelect?: (card: TriageCard) => void;
  /** The host owns authorization, persistence, retries and uncertain writes. */
  onMove?: (card: TriageCard, to: TriageTarget) => void;
  /**
   * A card's new place in its own lane: `index` is where it will stand, 0 at
   * the top, counted among the lane's cards as they will be. Absent means the
   * lane's order is not the reader's to change, and no control offers it.
   */
  onReorder?: (card: TriageCard, index: number) => void;
  /** A move the board would not make, with the host's reason for it. */
  onRefuse?: (card: TriageCard, reason: string) => void;
  /** Open the host's editor for one of the card's `edits`. */
  onEdit?: (card: TriageCard, field: string) => void;
  /** Drawn under one card: the host's editor, or what its last save says. */
  under?: { id: string; node: ReactNode };
  movingId?: string;
  emptyLaneMessage?: string;
  /** Said once, above the lanes, when no lane holds a card. */
  emptyBoardMessage?: string;
  /** The board's accessible name; an App list passes its own label. */
  ariaLabel?: string;
  /** Said to assistive technology after a move: the host's sentence for what just happened. */
  announcement?: string;
  /** A card to put the focus on once it is drawn; `seq` lets the same card be asked for again. */
  focus?: { id: string; seq: number };
}

/* The cell a card stands in: its row (none on a board without rows) and its lane. */
const cellKey = (row: string | undefined, lane: string) => `${row ?? ''}\u0000${lane}`;

/**
 * A bounded board interaction for triage-heavy Apps.
 *
 * This component owns presentation and movement gestures only. It does not
 * infer workflow rules or write a record: an App supplies the explicit move
 * and reorder callbacks after its server-side contract has said which moves
 * exist. Every gesture has three spellings, so none is pointer-only: a drag
 * (usePointerDrag: a mouse, a pen, or a finger held still for a moment),
 * Alt and an arrow key (the calendar's gesture — left and right change lane,
 * up and down change place, with Shift a row), and the card's ⋯ menu, which
 * stays quiet until its card is hovered or focused. Plain arrows only move
 * the focus. A lane the card may enter is marked by color; where the lanes
 * keep an order, the cards there slide aside to open the place the card
 * would take, and the dragged copy settles into it (usePointerDrag's gap: a
 * drag is occasional and spatial, and the slide is where it lands — the 2px
 * rule it replaced stood under the copy). A board that keeps no order draws
 * no place at all: the drop picks a lane, not a spot in it. The keyboard's
 * and the menu's moves animate nothing; the card is redrawn where it landed,
 * with the focus on it.
 */
export function TriageBoard({
  lanes,
  cards,
  rows,
  rowsLabel = say('row'),
  rowLock,
  selectedId,
  onSelect,
  onMove,
  onReorder,
  onRefuse,
  onEdit,
  under,
  movingId,
  emptyLaneMessage = say('noItemsHere'),
  emptyBoardMessage = say('nothingOnThisBoard'),
  ariaLabel = say('triageBoard'),
  announcement,
  focus,
}: TriageBoardProps) {
  const boardId = useId();
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const board = useRef<HTMLDivElement>(null);
  /* The lane (and row) a carried card would join: its edge is marked. Its place there is the gap the drag opens. */
  const [drop, setDrop] = useState<{ lane: string; row?: string } | null>(null);
  const rowOf = (card: TriageCard) => (rows ? card.rowId : undefined);
  const byCell = new Map<string, TriageCard[]>();
  for (const card of cards) {
    const key = cellKey(rowOf(card), card.laneId);
    byCell.set(key, [...(byCell.get(key) ?? []), card]);
  }
  const cellOf = (card: TriageCard) => byCell.get(cellKey(rowOf(card), card.laneId)) ?? [];
  /* A moved card is drawn anew in its lane or place; the focus follows it once
     it is there. The list's rows can arrive a beat after the move is told
     (the query hands them on after its fetch resolves), so the card may be
     focused in its old lane and then drawn anew in the new one, the focused
     button removed and the focus fallen to the page. Once per move, when the
     card focused is no longer on the page and nothing else has the focus, it
     goes to the card as now drawn. */
  const placed = useRef<{ seq: number; node: HTMLElement } | null>(null);
  useEffect(() => {
    if (!focus) return;
    const node = cardRefs.current.get(focus.id);
    if (!node) return;
    const before = placed.current;
    const fresh = before?.seq !== focus.seq;
    const lost = !document.activeElement || document.activeElement === document.body;
    if (fresh || (before.node !== node && !before.node.isConnected && lost)) {
      node.focus();
      placed.current = { seq: focus.seq, node };
    }
  }, [focus?.id, focus?.seq, cards]); // eslint-disable-line react-hooks/exhaustive-deps
  /* A card's button is kept through a redraw rather than dropped and taken up
     again: a menu closing in between asks for the card to hand the focus to,
     and must find it. Cards that have left the board are let go after it draws. */
  useEffect(() => {
    const present = new Set(cards.map((card) => card.id));
    for (const id of [...cardRefs.current.keys()]) if (!present.has(id)) cardRefs.current.delete(id);
  });
  const focusCard = (card: TriageCard | undefined) => {
    if (card) cardRefs.current.get(card.id)?.focus();
    return Boolean(card);
  };
  const moveFocus = (card: TriageCard, direction: 'up' | 'down' | 'left' | 'right') => {
    if (direction === 'up' || direction === 'down') {
      const current = cellOf(card);
      const index = current.findIndex((candidate) => candidate.id === card.id);
      if (focusCard(current[index + (direction === 'up' ? -1 : 1)]) || !rows) return;
      // Past the edge of its cell, the focus goes on to the same lane in the next row that has a card.
      const at = rows.findIndex((row) => row.id === card.rowId);
      for (let i = at + (direction === 'up' ? -1 : 1); i >= 0 && i < rows.length; i += direction === 'up' ? -1 : 1) {
        const there = byCell.get(cellKey(rows[i].id, card.laneId)) ?? [];
        if (focusCard(there[direction === 'up' ? there.length - 1 : 0])) return;
      }
      return;
    }
    const laneIndex = lanes.findIndex((lane) => lane.id === card.laneId);
    const destination = lanes[laneIndex + (direction === 'left' ? -1 : 1)];
    const destinationCards = destination ? (byCell.get(cellKey(rowOf(card), destination.id)) ?? []) : [];
    focusCard(destinationCards[direction === 'left' ? destinationCards.length - 1 : 0]);
  };
  const allowed = (card: TriageCard, laneId: string) =>
    laneId !== card.laneId && (card.targets === undefined || card.targets.includes(laneId));
  const movable = (card: TriageCard) => Boolean(onMove && lanes.some((lane) => allowed(card, lane.id)));
  const rowMovable = Boolean(rows && rows.length > 1 && onMove && !rowLock);
  /* The nearest lane the card may go to, that way: a lane it may not enter is stepped over, as the menu leaves it out. */
  const neighbor = (card: TriageCard, step: -1 | 1) => {
    for (let index = lanes.findIndex((lane) => lane.id === card.laneId) + step; index >= 0 && index < lanes.length; index += step) {
      if (allowed(card, lanes[index].id)) return lanes[index].id;
    }
    return undefined;
  };
  const placeIndex = (card: TriageCard, place: Place) =>
    indexIn(
      cellOf(card).map((candidate) => candidate.id),
      card.id,
      place,
    );
  const reorder = (card: TriageCard, place: Place) => {
    const index = placeIndex(card, place);
    if (onReorder && index !== undefined && movingId !== card.id) onReorder(card, index);
  };
  const changeRow = (card: TriageCard, step: -1 | 1) => {
    if (!rows || !onMove || movingId === card.id) return;
    if (rowLock) {
      onRefuse?.(card, rowLock);
      return;
    }
    const row = rows[rows.findIndex((candidate) => candidate.id === card.rowId) + step];
    if (row) onMove(card, { lane: card.laneId, row: row.id });
  };
  /* An item chosen from a card's menu hands the focus back to the card, not
     its ⋯: the card is what moved, and is where the reader goes on from. An
     edit's editor takes the focus for itself. Closed without a choice, the
     menu hands it back to its ⋯, as a menu does. The choice is forgotten when
     a menu opens, not when it is read: the menu asks more than once as it
     closes, and every answer has to be the same. */
  const chosen = useRef<{ id: string; card: boolean } | null>(null);
  const pick = (card: TriageCard, act: () => void, focusCard = true) => {
    chosen.current = { id: card.id, card: focusCard };
    act();
  };
  const afterMenu = (card: TriageCard): boolean | HTMLElement => {
    const choice = chosen.current;
    if (choice?.id !== card.id) return true;
    return choice.card ? (cardRefs.current.get(card.id) ?? true) : false;
  };
  const onCardKeyDown = (event: KeyboardEvent<HTMLButtonElement>, card: TriageCard) => {
    if (event.key === 'F2' && onEdit && card.edits?.length) {
      event.preventDefault();
      onEdit(card, card.edits[0].field);
      return;
    }
    const direction =
      event.key === 'ArrowUp'
        ? 'up'
        : event.key === 'ArrowDown'
          ? 'down'
          : event.key === 'ArrowLeft'
            ? 'left'
            : event.key === 'ArrowRight'
              ? 'right'
              : null;
    if (!direction) return;
    event.preventDefault();
    if (!event.altKey || event.metaKey || event.ctrlKey) {
      moveFocus(card, direction);
      return;
    }
    if (event.shiftKey) {
      if (direction === 'up' || direction === 'down') changeRow(card, direction === 'up' ? -1 : 1);
      return;
    }
    if (direction === 'left' || direction === 'right') {
      const lane = onMove && movingId !== card.id ? neighbor(card, direction === 'left' ? -1 : 1) : undefined;
      if (lane) onMove!(card, { lane });
    } else reorder(card, direction);
  };

  /* A drop before a card in its own cell is a new place; anywhere in another
     lane the card may enter, or another row, is a move, landing before the
     card it was dropped on. A row the card may not change to is a refusal,
     said on the drop rather than silently ignored. */
  const changes = (card: TriageCard, laneId: string, rowId?: string) => ({
    lane: laneId !== card.laneId,
    row: Boolean(rows) && rowId !== undefined && rowId !== card.rowId,
  });
  const canDrop = (card: TriageCard | null, laneId: string, rowId?: string): card is TriageCard => {
    if (!card) return false;
    const change = changes(card, laneId, rowId);
    if (!change.lane && !change.row) return Boolean(onReorder);
    if (!onMove || (change.lane && !allowed(card, laneId))) return false;
    return !(change.row && rowLock);
  };
  const refusal = (card: TriageCard | null, laneId: string, rowId?: string) => {
    if (!card || !rowLock || !onMove) return undefined;
    const change = changes(card, laneId, rowId);
    return change.row && (!change.lane || allowed(card, laneId)) ? rowLock : undefined;
  };
  /* Where the pointer is: the lane and row of the cell under it (each named
     by its index, as a lane's id may be any text), and the card there it
     would land before — the one in whose top half it is, else the next. */
  const placeAt = (card: TriageCard, at: DropPoint | null) => {
    const lane = at ? lanes[Number(at.zone.dataset.lane)]?.id : undefined;
    if (!at || lane === undefined) return null;
    const row = at.zone.dataset.row === undefined ? undefined : rows?.[Number(at.zone.dataset.row)]?.id;
    const cell = byCell.get(cellKey(changes(card, lane, row).row ? row : rowOf(card), lane)) ?? [];
    return {
      lane,
      row,
      before: landingBefore(
        cell.map((each) => each.id),
        card.id,
        at.item?.dataset.dropItem,
        at.upper,
      ),
    };
  };
  const hover = (card: TriageCard, at: DropPoint | null): DropSlot | null => {
    const place = placeAt(card, at);
    // A place the card may not go is not marked; a lane or row it may not enter says why only when it is let go there.
    if (!at || !place || !canDrop(card, place.lane, place.row)) {
      setDrop(null);
      return null;
    }
    const change = changes(card, place.lane, place.row);
    const mark = change.lane || change.row ? { lane: place.lane, row: place.row } : null;
    setDrop((current) => (current?.lane === mark?.lane && current?.row === mark?.row ? current : mark));
    /* The place itself only where the lanes keep an order: a board that keeps none would put the card where its sort
       says, wherever it was let go, so a gap there would promise a place the drop does not give. */
    if (!onReorder) return null;
    const before =
      place.before === undefined
        ? null
        : at.item?.dataset.dropItem === place.before
          ? at.item
          : ([...at.zone.querySelectorAll<HTMLElement>('[data-drop-item]')].find((node) => node.dataset.dropItem === place.before) ?? null);
    return { zone: at.zone, before };
  };
  const land = (card: TriageCard, at: DropPoint | null) => {
    setDrop(null);
    const title = card.title;
    const place = placeAt(card, at);
    if (!place) return;
    const { lane: laneId, row: rowId, before } = place;
    if (!canDrop(card, laneId, rowId)) {
      /* Let go over a lane it may not enter, the card goes back and says why, rather than going back in silence. */
      const change = changes(card, laneId, rowId);
      const lane = lanes.find((each) => each.id === laneId);
      const reason =
        refusal(card, laneId, rowId) ??
        (change.lane && onMove && lane && !allowed(card, laneId) ? say('cannotMoveTo', { title, lane: lane.label }) : undefined);
      if (reason) onRefuse?.(card, reason);
      return;
    }
    const change = changes(card, laneId, rowId);
    const cell = byCell.get(cellKey(change.row ? rowId : rowOf(card), laneId)) ?? [];
    const others = cell.filter((candidate) => candidate.id !== card.id);
    if (!change.lane && !change.row) {
      const index = before === undefined ? others.length : others.findIndex((candidate) => candidate.id === before);
      const at = cell.findIndex((candidate) => candidate.id === card.id);
      if (index >= 0 && index !== at && movingId !== card.id) onReorder!(card, index);
      return;
    }
    /* Where the lanes keep an order, the card lands where it was let go: before
       the card it was dropped on, or last in a lane that has cards. */
    const index =
      !onReorder || !others.length
        ? undefined
        : before === undefined
          ? others.length
          : others.findIndex((candidate) => candidate.id === before);
    onMove!(card, { lane: laneId, ...(change.row ? { row: rowId } : {}), ...(index !== undefined && index >= 0 ? { index } : {}) });
  };
  /* Where a dropped card now stands, for the copy to settle into: the host has drawn the move by then (flushSync). */
  const locate = (card: TriageCard) =>
    [...(board.current?.querySelectorAll<HTMLElement>('[data-drop-item]') ?? [])]
      .find((node) => node.dataset.dropItem === card.id)
      ?.querySelector<HTMLElement>('.triage-card') ?? null;
  const drag = usePointerDrag<TriageCard>({ over: hover, drop: land, end: () => setDrop(null), gap: Boolean(onReorder), locate });
  /* While a card is dragged, a lane it may not enter says so before it is reached — dimmed, its cursor refusing —
     rather than staying blank under the pointer. Colour and cursor only. Worked out once per drag: the lift redraws
     the lanes, and the cards (memoised) are left alone. */
  const shutLanes = useMemo(() => {
    const card = drag.dragging;
    return card && onMove
      ? new Set(lanes.filter((lane) => lane.id !== card.laneId && !allowed(card, lane.id)).map((lane) => lane.id))
      : null;
  }, [drag.dragging]); // eslint-disable-line react-hooks/exhaustive-deps
  const shut = (laneId: string) => Boolean(shutLanes?.has(laneId));

  const count = (n: number, limit?: number) => {
    if (limit === undefined)
      return (
        <span className="triage-lane-count" aria-label={say('items', { count: n })}>
          {formatNumber(n)}
        </span>
      );
    const past = n > limit;
    return (
      <span
        className={`triage-lane-count${past ? ' is-over' : ''}`}
        aria-label={`${say('itemsLimit', { count: n, limit: formatNumber(limit) })}${past ? say('overTheLimit') : ''}`}
      >
        {formatNumber(n)} / {formatNumber(limit)}
      </span>
    );
  };
  const laneHeading = (lane: TriageLane) => `${boardId}-lane-${lane.id}`;
  const rowHeading = (row: TriageRow) => `${boardId}-row-${row.id}`;
  /* The count is the lane's own over the whole list where the host knows it:
     a lane's cards are read a page at a time, and "3 / 5" on a lane of 900
     was a limit met by the page, not by the work. */
  const sum = (lane: TriageLane) =>
    lane.sum ? (
      <span className="triage-lane-sum" title={lane.sum.title}>
        {lane.sum.text}
      </span>
    ) : null;
  const laneHead = (lane: TriageLane, n: number) => (
    <header className="triage-lane-head">
      <h2 id={laneHeading(lane)} className="triage-lane-label" title={lane.title}>
        {lane.mark ?? lane.label}
      </h2>
      {count(lane.total ?? n, lane.limit)}
      {sum(lane)}
      {lane.onFold && (
        <button
          type="button"
          className="triage-lane-fold"
          aria-expanded="true"
          aria-label={say('foldLane', { lane: lane.label })}
          title={say('foldLane', { lane: lane.label })}
          onClick={lane.onFold}
        >
          <Icon name="caret-left" size={14} />
        </button>
      )}
      {lane.onNew && (
        <button
          type="button"
          className="triage-lane-new"
          aria-label={say('newInLane', { lane: lane.label })}
          title={say('newInLane', { lane: lane.label })}
          onClick={lane.onNew}
        >
          <span aria-hidden="true">+</span>
        </button>
      )}
    </header>
  );
  const more = (lane: TriageLane) =>
    lane.more && lane.more.count > 0 ? (
      <button type="button" className="ghost triage-more" onClick={lane.more.onMore}>
        {say('showMore', { count: formatNumber(lane.more.count) })}
      </button>
    ) : null;

  /* What a card's own drawing reads, current on every render: the cards are memoised, and call through this. */
  const acts = useRef<CardActs>(null as unknown as CardActs);
  acts.current = {
    source: drag.source,
    remember: (id, element) => {
      if (element) cardRefs.current.set(id, element);
    },
    select: (card) => onSelect?.(card),
    keyDown: onCardKeyDown,
    pick,
    afterMenu,
    opened: () => {
      chosen.current = null;
    },
    move: (card, to) => onMove?.(card, to),
    place: reorder,
    edit: (card, field) => onEdit?.(card, field),
  };
  const drawCard = (card: TriageCard, cell: TriageCard[]) => {
    const moving = movingId === card.id;
    const laneTargets = onMove ? lanes.filter((target) => allowed(card, target.id)) : [];
    const rowTargets = rowMovable ? rows!.filter((target) => target.id !== card.rowId) : [];
    const places = onReorder && cell.length > 1 ? PLACES.filter(([place]) => placeIndex(card, place) !== undefined) : [];
    const edits = onEdit ? (card.edits ?? []) : [];
    const draggable = !moving && card.pending !== 'asking' && (movable(card) || rowMovable || Boolean(onReorder && cell.length > 1));
    const keys = [
      ...(movable(card) ? ['Alt+ArrowLeft', 'Alt+ArrowRight'] : []),
      ...(places.length ? ['Alt+ArrowUp', 'Alt+ArrowDown'] : []),
      ...(rowTargets.length ? ['Alt+Shift+ArrowUp', 'Alt+Shift+ArrowDown'] : []),
      ...(edits.length ? ['F2'] : []),
    ].join(' ');
    const view = { laneTargets, rowTargets, places, edits, rowsLabel };
    /* The card's own content, said as text: a host builds its cards afresh on every render, and a card that reads the
       same is the same card (its line and facts are drawn from the words compared here). */
    const sig = [
      card.id,
      card.laneId,
      card.rowId,
      card.title,
      card.subtitle,
      card.meta,
      card.pending,
      card.changed,
      card.category ? `${card.category.label}:${card.category.color}` : '',
      (card.footer ?? []).map((fact) => `${fact.key}:${fact.icon ?? ''}:${fact.text}:${fact.person ? 1 : 0}`).join(','),
      selectedId === card.id,
      moving,
      draggable,
      keys,
      rowsLabel,
      laneTargets.map((lane) => `${lane.id}:${lane.label}`).join(','),
      rowTargets.map((row) => `${row.id}:${row.label}`).join(','),
      places.map(([place]) => place).join(','),
      edits.map((edit) => `${edit.field}:${edit.label}`).join(','),
    ].join('\u0001');
    return (
      <BoardCard
        key={card.id}
        card={card}
        selected={selectedId === card.id}
        moving={moving}
        draggable={draggable}
        keys={keys}
        view={view}
        sig={sig}
        under={under?.id === card.id ? under.node : undefined}
        acts={acts}
      />
    );
  };

  const live = (
    /* Polite and always present, so a move is heard once it lands rather than lost to a region that appeared with it. */
    <div className="triage-sr" aria-live="polite">
      {announcement}
    </div>
  );
  /* A folded lane is a strip beside the open ones, in view with the last of them: the picker steps through the open
     lanes only, and a strip opens with a tap. */
  const picker = <LanePicker lanes={lanes.filter((lane) => !(lane.folded && lane.onFold))} board={board} />;

  /* A board with nothing on it says so once, above its lanes, rather than
     once in every lane: three "No items here." read as three problems. */
  const boardEmpty = cards.length === 0;
  if (!rows) {
    /* A group of lanes, each a region whose cards are a list: the cards are
       the list items, and a lane (with its head, its count, its empty note)
       is not one. The live region sits in the group, not in a list. */
    return (
      <>
        {boardEmpty && <Empty className="triage-board-empty" text={emptyBoardMessage} />}
        {picker}
        <div ref={board} className="triage-board" data-scrolls="" role="group" aria-label={ariaLabel}>
          {lanes.map((lane, laneIndex) => {
            const laneCards = byCell.get(cellKey(undefined, lane.id)) ?? [];
            /* A folded lane is a strip that opens on a click: its name, its count and its sum, written down its side.
               It is still a place to drop a card, which joins the lane unseen and is counted. */
            if (lane.folded && lane.onFold)
              return (
                <section
                  key={lane.id}
                  className={`triage-lane is-folded${drop?.lane === lane.id ? ' is-over' : ''}${shut(lane.id) ? ' is-shut' : ''}`}
                  aria-disabled={shut(lane.id) || undefined}
                  aria-labelledby={laneHeading(lane)}
                  data-drop-zone=""
                  data-lane={laneIndex}
                >
                  <button
                    type="button"
                    className="triage-lane-unfold"
                    aria-expanded="false"
                    title={say('openLane', { lane: lane.label })}
                    onClick={lane.onFold}
                  >
                    <span id={laneHeading(lane)} className="triage-lane-label">
                      {lane.mark ?? lane.label}
                    </span>
                    {count(lane.total ?? laneCards.length, lane.limit)}
                    {sum(lane)}
                  </button>
                </section>
              );
            return (
              <section
                key={lane.id}
                className={`triage-lane${drop?.lane === lane.id ? ' is-over' : ''}${shut(lane.id) ? ' is-shut' : ''}`}
                aria-disabled={shut(lane.id) || undefined}
                aria-labelledby={laneHeading(lane)}
                data-drop-zone=""
                data-lane={laneIndex}
                data-lane-at={laneIndex}
              >
                {laneHead(lane, laneCards.length)}
                <div className="triage-lane-cards" role={laneCards.length ? 'list' : undefined}>
                  {laneCards.length === 0 && !boardEmpty && (
                    <p className="triage-empty" role="status">
                      {emptyLaneMessage}
                    </p>
                  )}
                  {laneCards.map((card) => drawCard(card, laneCards))}
                  {more(lane)}
                </div>
              </section>
            );
          })}
          {live}
        </div>
      </>
    );
  }

  /* With rows, the lane heads stand once above them, and each row is a run of
     cells under those heads — the same widths, scrolled together. A row folds;
     a lane's count and limit are over every row. A cell says no count of its
     own: its cards are in view, and a bare figure in each cell's corner said
     nothing about what it counted. */
  return (
    <>
      {picker}
      <div ref={board} className="triage-board has-rows" data-scrolls="" role="group" aria-label={ariaLabel}>
        <div className="triage-heads">
          {lanes.map((lane, laneIndex) => (
            <div key={lane.id} className="triage-lane-top" data-lane-at={laneIndex}>
              {laneHead(lane, cards.filter((card) => card.laneId === lane.id).length)}
              {more(lane)}
            </div>
          ))}
        </div>
        {rows.map((row, rowIndex) => {
          const inRow = cards.filter((card) => card.rowId === row.id).length;
          return (
            <details key={row.id} className="triage-swimlane" open>
              <summary className="triage-swimlane-head">
                <h3 id={rowHeading(row)} className="triage-swimlane-label" title={row.title}>
                  {row.label}
                </h3>
                {count(inRow)}
              </summary>
              <div className="triage-swimlane-cells">
                {lanes.map((lane, laneIndex) => {
                  const cell = byCell.get(cellKey(row.id, lane.id)) ?? [];
                  const target = drop?.lane === lane.id && drop.row === row.id;
                  return (
                    <section
                      key={lane.id}
                      className={`triage-lane triage-cell${cell.length ? '' : ' is-empty'}${target ? ' is-over' : ''}${shut(lane.id) ? ' is-shut' : ''}`}
                      aria-disabled={shut(lane.id) || undefined}
                      aria-labelledby={`${laneHeading(lane)} ${rowHeading(row)}`}
                      data-drop-zone=""
                      data-lane={laneIndex}
                      data-row={rowIndex}
                    >
                      <div className="triage-lane-cards" role={cell.length ? 'list' : undefined}>
                        {cell.map((card) => drawCard(card, cell))}
                      </div>
                    </section>
                  );
                })}
              </div>
            </details>
          );
        })}
        {live}
      </div>
    </>
  );
}

/** What a card calls on the board: read through a ref, so a card drawn once is not drawn again for a new closure. */
interface CardActs {
  source: (card: TriageCard, enabled: boolean) => Record<string, unknown>;
  remember: (id: string, element: HTMLButtonElement | null) => void;
  select: (card: TriageCard) => void;
  keyDown: (event: KeyboardEvent<HTMLButtonElement>, card: TriageCard) => void;
  pick: (card: TriageCard, act: () => void, focusCard?: boolean) => void;
  afterMenu: (card: TriageCard) => boolean | HTMLElement;
  opened: () => void;
  move: (card: TriageCard, to: TriageTarget) => void;
  place: (card: TriageCard, place: Place) => void;
  edit: (card: TriageCard, field: string) => void;
}

interface BoardCardProps {
  card: TriageCard;
  selected: boolean;
  moving: boolean;
  draggable: boolean;
  keys: string;
  view: {
    laneTargets: TriageLane[];
    rowTargets: TriageRow[];
    places: Array<[Place, string]>;
    edits: Array<{ field: string; label: string }>;
    rowsLabel: string;
  };
  /** Everything above but the card, said as text: two cards drawn alike compare equal, and are not drawn again. */
  sig: string;
  under?: ReactNode;
  acts: MutableRefObject<CardActs>;
}

/**
 * One card and its ⋯. Memoised: a lift, a hover over a lane and a drop redraw the board's lanes, and a card is drawn
 * again only when it, or what it offers, has changed — a lift that redrew every card stalled the drag's first frame.
 */
const BoardCard = memo(
  function BoardCard({ card, selected, moving, draggable, keys, view, under, acts }: BoardCardProps) {
    const { laneTargets, rowTargets, places, edits, rowsLabel } = view;
    const menu = laneTargets.length + rowTargets.length + places.length + edits.length > 0;
    const act = acts.current;
    return (
      <article className="triage-card-wrap" role="listitem" data-drop-item={card.id}>
        {/* The card draws the box, and the button that opens it stops short of the ⋯'s column, so neither is drawn over
            the other (the ⋯ sat on the button, and a tap at its edge opened the card). The button's own hit area reaches
            the card's padding up to that column (TriageBoard.css). */}
        <div
          className={`triage-card${selected ? ' is-selected' : ''}${menu ? ' has-menu' : ''}${
            card.category ? ` has-category cat-c${card.category.color}` : ''
          }${card.changed ? ` row-changed-${card.changed}` : ''}${card.pending ? ` is-pending is-${card.pending}` : ''}`}
          aria-busy={card.pending === 'saving' || undefined}
          {...act.source(card, draggable)}
        >
          <button
            type="button"
            ref={(element) => acts.current.remember(card.id, element)}
            className="triage-card-open"
            aria-pressed={selected}
            aria-label={[card.category?.label, card.title, card.subtitle, ...(card.footer ?? []).map((fact) => fact.text)]
              .filter(Boolean)
              .join(', ')}
            aria-keyshortcuts={keys || undefined}
            onClick={() => acts.current.select(card)}
            onKeyDown={(event) => acts.current.keyDown(event, card)}
          >
            {card.category && <span className="triage-card-category">{card.category.label}</span>}
            <span className="triage-card-title">{card.title}</span>
            {card.subtitle && <span className="triage-card-subtitle">{card.line ?? card.subtitle}</span>}
            {card.meta && <span className="triage-card-meta">{card.meta}</span>}
            {card.footer?.length ? (
              <span className="triage-card-foot">
                {card.footer.map((fact) => (
                  <span key={fact.key} className={`triage-card-fact${fact.person ? ' is-person' : ''}`} title={fact.text}>
                    {fact.icon && <Icon name={fact.icon as IconName} size={13} className="triage-card-fact-icon" />}
                    {fact.node}
                  </span>
                ))}
              </span>
            ) : null}
          </button>
        </div>
        {menu && (
          /* In the card's column but outside what is dragged, so a press on it never lifts the card. */
          <DropMenu
            className="triage-card-menu"
            triggerClassName="triage-card-menu-button"
            triggerLabel={say('actionsForTitle', { title: card.title })}
            triggerTitle={say('moveOrderOrEdit')}
            label={<span aria-hidden="true">⋯</span>}
            popupClassName="more-list triage-menu"
            finalFocus={() => acts.current.afterMenu(card)}
            onOpenChange={(open) => {
              if (open) acts.current.opened();
            }}
          >
            {laneTargets.length > 0 && (
              <DropGroup label={say('move')} labelClassName="more-group-label">
                {laneTargets.map((target) => (
                  <DropItem
                    key={target.id}
                    className="more-item"
                    disabled={moving}
                    onClick={() => acts.current.pick(card, () => acts.current.move(card, { lane: target.id }))}
                  >
                    <span className="more-tick" aria-hidden="true" />
                    <span className="more-label">{target.label}</span>
                  </DropItem>
                ))}
              </DropGroup>
            )}
            {rowTargets.length > 0 && (
              <DropGroup label={rowsLabel} labelClassName="more-group-label">
                {rowTargets.map((target) => (
                  <DropItem
                    key={target.id}
                    className="more-item"
                    disabled={moving}
                    onClick={() => acts.current.pick(card, () => acts.current.move(card, { lane: card.laneId, row: target.id }))}
                  >
                    <span className="more-tick" aria-hidden="true" />
                    <span className="more-label">{target.label}</span>
                  </DropItem>
                ))}
              </DropGroup>
            )}
            {places.length > 0 && (
              <DropGroup label={say('order')} labelClassName="more-group-label">
                {places.map(([place, label]) => (
                  <DropItem
                    key={place}
                    className="more-item"
                    disabled={moving}
                    onClick={() => acts.current.pick(card, () => acts.current.place(card, place))}
                  >
                    <span className="more-tick" aria-hidden="true" />
                    <span className="more-label">{label}</span>
                  </DropItem>
                ))}
              </DropGroup>
            )}
            {edits.length > 0 && (
              <DropGroup label={say('editGroup')} labelClassName="more-group-label">
                {edits.map((edit) => (
                  <DropItem
                    key={edit.field}
                    className="more-item"
                    disabled={moving}
                    onClick={() => acts.current.pick(card, () => acts.current.edit(card, edit.field), false)}
                  >
                    <span className="more-tick" aria-hidden="true" />
                    <span className="more-label">{edit.label}</span>
                  </DropItem>
                ))}
              </DropGroup>
            )}
          </DropMenu>
        )}
        {under !== undefined && <div className="triage-card-under">{under}</div>}
      </article>
    );
  },
  (before, after) => before.sig === after.sig && before.under === after.under,
);

/**
 * On a phone a board is one lane and the edge of the next: the lanes snap
 * into place as they are swiped (TriageBoard.css), and this says which one
 * is in view — "Ready, 2 of 5" — with a step either way, so a reader knows
 * how many lanes there are and can reach one without swiping past the rest.
 * Drawn only on a phone; a desk sees its lanes side by side.
 */
function LanePicker({ lanes, board }: { lanes: TriageLane[]; board: RefObject<HTMLDivElement | null> }) {
  const [at, setAt] = useState(0);
  useEffect(() => {
    const element = board.current;
    if (!element) return;
    /* The lane whose left edge is nearest the scroller's: offsets and the
       scroll position are both layout pixels, so the density zoom leaves
       them agreeing. */
    const read = () => {
      const pad = parseFloat(getComputedStyle(element).paddingLeft) || 0;
      const edges = [...element.querySelectorAll<HTMLElement>('[data-lane-at]')].map((node) => node.offsetLeft - pad);
      if (!edges.length) return;
      let nearest = 0;
      edges.forEach((edge, index) => {
        if (Math.abs(edge - element.scrollLeft) < Math.abs(edges[nearest] - element.scrollLeft)) nearest = index;
      });
      setAt(nearest);
    };
    read();
    element.addEventListener('scroll', read, { passive: true });
    return () => element.removeEventListener('scroll', read);
  }, [board, lanes.length]);
  if (lanes.length < 2) return null;
  const show = (index: number) => {
    const element = board.current;
    const lane = element?.querySelectorAll<HTMLElement>('[data-lane-at]')[index];
    if (!element || !lane) return;
    // Straight there: a step through the lanes is a keyboard's gesture, and it animates nothing.
    element.scrollLeft = lane.offsetLeft - (parseFloat(getComputedStyle(element).paddingLeft) || 0);
    setAt(index);
  };
  const lane = lanes[Math.min(at, lanes.length - 1)];
  return (
    <div className="triage-lane-picker" role="group" aria-label={say('lanes')}>
      <button type="button" className="ghost" aria-label={say('previousLane')} disabled={at <= 0} onClick={() => show(at - 1)}>
        <Icon name="caret-left" size={16} />
      </button>
      <span className="triage-lane-picker-at">
        <span className="triage-lane-picker-name">{lane.label}</span>{' '}
        <span className="triage-lane-picker-of">{say('laneOf', { lane: formatNumber(at + 1), count: formatNumber(lanes.length) })}</span>
      </span>
      <button type="button" className="ghost" aria-label={say('nextLane')} disabled={at >= lanes.length - 1} onClick={() => show(at + 1)}>
        <Icon name="caret-right" size={16} />
      </button>
    </div>
  );
}
