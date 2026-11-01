/**
 * A board list: the entry's rows as lanes of cards by one local column.
 *
 * The board itself is TriageBoard; this is the host it asks for. A card
 * moves only through one of the entry's fixed actions that sets exactly the
 * lane column — a lane without such an action is a place to read, not to
 * drop into — and an action with a `when` is offered on a card only after
 * the server has said the card satisfies it. Until it answers, the lane is
 * not offered: an option that appears and is then refused is worse than one
 * that arrives late. Every move is one ordinary update through the shared
 * bulk helper, so it shares the gate, the journal and Undo with every
 * other list that writes.
 *
 * Where `by` references another table (a cycle), the lanes are that table's
 * rows, read by their label, led by a lane for none; a card moves there by
 * an ordinary update of the reference, unless the resource's transitions
 * give the column to its actions, when the actions rule as above.
 *
 * With an `order` column the lanes read in its order, and where the reader
 * may edit that column a card is put in its place by a drag, Alt and an
 * arrow key, or its ⋯ menu (TriageBoard draws all three). A card dropped in
 * another lane lands where it was let go: the lane first, through its
 * action, then the place, as a second ordinary update — two writes, each
 * undoable on its own, and a place that fails to save is said while the card
 * keeps its new lane. Moved any other way it keeps its number, and lands
 * among its new lane by it.
 *
 * `swimlanes` draws a row per value of another column; a card changes row
 * by an ordinary update where the reader may edit that column. A card's
 * primary and line are edited in place, with the record page's editors.
 *
 * A move is drawn the moment it is made (optimisticMoves.ts): the card stands
 * in its new lane and place, quieter, while its writes run, and a refusal
 * puts it back with the server's sentence. A move that opens a form (a
 * confirmation, a reason, a command's inputs) holds the card faded in its new
 * place until the form is answered, and back where it was if it is
 * cancelled. A move made while another saves waits its turn. A saved move is
 * written into the lanes' cache, and the lanes it touched are read once more
 * when the last move is done — not every list on the page after every write.
 */
import { namedCell } from '@mistriwork/kit/client/components/listColumn.js';
import { ReasonForm } from './Actions.js';
import { Suspense, lazy, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useOptimisticMoves } from '@mistriwork/kit/client/components/optimisticMoves.js';
import { BoardNewForm } from '@mistriwork/kit/client/components/boardNew.js';
import { openNewRecord } from '@mistriwork/kit/client/insert.js';
import { Button } from '@mistriwork/ui/Button.js';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  columnDisplay,
  columnLabel,
  findTable,
  keyOf,
  openRecord,
  quote,
  state,
  toast,
  writeAllowed,
} from '@mistriwork/kit/client/core.js';
import { joinQuery, splitQuery } from '@mistriwork/kit/client/clauses.js';
import { andQuery } from '@mistriwork/engine/shared/query.js';
import { currencyPath, rowCurrency } from '@mistriwork/engine/shared/money.js';
import { defaultCurrency } from '@mistriwork/kit/client/locale.js';
import { amountRule, cardCategory, cardFact, dressedValue, laneMark, laneWord, namesPerson, shortAmount } from './boardFace.js';
import { activeApp } from '../appState.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { sessionIdentity, subscribeSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { updateAttempts } from '@mistriwork/kit/client/updateAttempts.js';
import { applyBulk, bulkKey, matchingKeys } from '@mistriwork/kit/client/bulkActions.js';
import { expectedValues, labelColumn, type ColumnMeta, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { type AppAction, type AppCommandAction, type AppUpdateAction } from '../../shared/appModel.js';
import { humanName, vocabularyWord } from '@mistriwork/engine/shared/model.js';
import type { AppBoardList } from '@mistriwork/engine/shared/listPresentations.js';
import { recordCommand } from './sdk/commands.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import { TriageBoard, type TriageCard, type TriageLane, type TriageRow, type TriageTarget } from './TriageBoard.js';
import { useChangedRows } from '@mistriwork/kit/client/liveState.js';
import { placements, savePlaces, wholeColumn } from '@mistriwork/kit/client/components/placeOrder.js';
import type { ModalRecord } from './RecordModal.js';
import type { CloseReason } from './BoardCardEditor.js';
import { say } from '../copy/lists/components/BoardList.js';

/* The editors load with the first card opened for editing. */
const BoardCardEditor = lazy(() => import('./BoardCardEditor.js'));

interface BoardListProps {
  table: TableMeta;
  rows: Array<Record<string, unknown>>;
  spec: AppBoardList;
  actions?: AppAction[];
  interactive?: boolean;
  /** The entry's label: the board's accessible name, so a reader finds it by the word the nav uses. */
  label?: string;
  /** A reference's record name, read beside it (listReferenceNames): a title that is a reference says the name, not the key. */
  referenceLabels?: Record<string, string>;
  /**
   * The list's whole question. Given, the board reads it lane by lane — each
   * lane's own cards a page at a time, and every lane's count in one
   * breakdown — rather than laying out the one page of `rows` the list read.
   */
  query?: string;
}

/** The lanes when none are authored: the column's vocabulary, the referenced rows, else what is seen, in order. */
const LANE_CAP = 8;
/** A lane's cards are read this many at a time; "Show more" reads the next. */
const LANE_PAGE = 20;
/** The lane, or row, of the cards whose value is empty: never a value a column can hold as text here. */
export const NONE = '\u0000none';

/** `position` is the order column's number, absent where the card has no place yet. */
interface BoardCard extends TriageCard {
  key: Record<string, unknown>;
  row: Record<string, unknown>;
  position?: number;
}
interface Move {
  card: BoardCard;
  to: TriageTarget;
  action?: LaneMove;
}
/** A move waiting on its confirmation or reason: drawn already (`token`), with what it will write. */
interface AskedMove extends Move {
  token: number;
  plan: { laneChange: boolean; rowChange: boolean; own: Values; drawn: Values; neighbors: Array<[BoardCard, number]> };
}
/** What moves a card between lanes: a fixed edit of the lane column, or a machine's command verb that leads there. */
type LaneMove = AppUpdateAction | AppCommandAction;
/** What one ordinary update writes: the bulk helper's values. */
type Values = Record<string, string | number | boolean | null>;
interface Named {
  id: string;
  label: string;
}

/** A fixed edit of the lane column alone, into a lane the board shows. */
const isMove = (action: AppAction, by: string, lanes: readonly string[]): action is AppUpdateAction =>
  action.command === undefined &&
  Object.keys(action.set).length === 1 &&
  Object.keys(action.set)[0] === by &&
  lanes.includes(String(action.set[by]));

/** A machine's command verb that leads to a lane of the board's column, which this reader is granted. */
const isCommandMove = (action: AppAction, by: string, lanes: readonly string[]): action is AppCommandAction => {
  const move = action.command === undefined ? undefined : (action as AppCommandAction).move;
  return (
    move?.column === by && move.edges.some((edge) => lanes.includes(edge.to)) && recordCommand(action.command!, action.label) !== undefined
  );
};
/** Whether a verb is told its lane: its command asks for the board's column, as `moveDeal` asks `{ stage }`. */
const asksLane = (action: AppCommandAction) => action.command.input.some((field) => field.name === action.move!.column);
/**
 * The lanes a move leads a card to from its lane: a fixed edit's one; a verb's step from that state — or each of its
 * steps from there, where it has several and is told which (asksLane); a verb whose handler picks says nothing here.
 */
const lanesOfMove = (action: LaneMove, by: string, from: string): string[] => {
  if (!action.command) return [String((action as AppUpdateAction).set[by])];
  const verb = action as AppCommandAction;
  const ends = verb.move!.edges.filter((edge) => edge.from === from).map((edge) => edge.to);
  return ends.length === 1 || asksLane(verb) ? ends : [];
};

/* "No cycle", "No assignee": a caption in its sentence, an acronym kept as it is. */
const none = (caption: string) =>
  say('noCaption', { caption: /^[A-Z][a-z]/.test(caption) ? caption[0].toLowerCase() + caption.slice(1) : caption });
/* A lane's or row's id is text; what is written is the column's own kind — a
   numeric key goes back as the number it is, unless it is past 2^53. */
const valueOf = (id: string, column: ColumnMeta | undefined): string | number | null => {
  if (id === NONE) return null;
  const numeric = /int|serial|numeric|decimal|real|double|float/i.test(column?.type ?? '');
  return numeric && /^-?\d+$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : id;
};

/** A referenced table's rows by label: every one (up to the cap), or the ones named, in the order named. */
function useReferenced(
  target: TableMeta | undefined,
  column: string | undefined,
  connection: string | null,
  epoch: number,
  ids?: readonly string[],
) {
  const wanted = ids ? [...ids].filter((id) => id !== NONE) : undefined;
  return useQuery<Named[]>({
    queryKey: ['board-references', connection, epoch, target?.id, column, wanted?.join('\n') ?? '*'],
    enabled: Boolean(target && column && (!wanted || wanted.length)),
    staleTime: 30_000,
    queryFn: async () => {
      const naming = labelColumn(target!) ?? column!;
      const data = (await api('/api/query', {
        ...ownedBy(connection),
        table: target!.id,
        columns: [...new Set([column!, naming])],
        ...(wanted
          ? { filter: { groups: [[{ column: column!, op: 'in', value: wanted }]] } }
          : { orderBy: [{ column: column!, direction: 'asc' }] }),
        limit: wanted?.length ?? LANE_CAP,
        offset: 0,
      })) as { rows: Array<Record<string, unknown>> };
      return data.rows.map((row) => ({ id: String(row[column!]), label: String(row[naming] ?? row[column!]) }));
    },
  });
}

/**
 * Every lane's count over the whole list, in one breakdown by the lane
 * column: the list's own conditions (its tab, its filters, the view's
 * standing condition, and whatever the server's row policies add), without
 * its sort or page. Empty values count under NONE.
 */
function useLaneCounts(
  query: string | undefined,
  by: string,
  connection: string | null,
  epoch: number,
  amount?: string,
  /** Where each card says its amount's currency: its lane's sum is summed apart per currency, by this column. */
  currencyBy?: string,
) {
  const text = laneCountsText(query, by, amount, currencyBy);
  return useQuery<LaneCounts>({
    queryKey: ['count', connection, 'board', epoch, text],
    enabled: Boolean(text),
    queryFn: async () => {
      const data = (await api('/api/breakdown', { text: text!, limit: 500 })) as {
        columns?: string[];
        rows?: Array<Record<string, unknown>>;
        errors?: Array<{ message: string }>;
      };
      if (data.errors?.length) throw new Error(data.errors[0].message);
      // The value first and the count last, whatever the server says between them about a reference's label.
      const columns = data.columns ?? [];
      const value = columns[0];
      const count = amount && columns.includes(LANE_COUNT) ? LANE_COUNT : columns[columns.length - 1];
      const lane = (row: Record<string, unknown>) => (row[value] == null ? NONE : String(row[value]));
      const rows = data.rows ?? [];
      const counts = new Map<string, number>();
      // A sum stays as the server wrote it: a numeric column's comes back as decimal text, which is said exactly.
      const sums = new Map<string, Array<[string | undefined, unknown]>>();
      for (const row of rows) {
        counts.set(lane(row), (counts.get(lane(row)) ?? 0) + (Number(row[count]) || 0));
        if (!amount || !columns.includes(LANE_SUM)) continue;
        const code = columns.includes(LANE_CURRENCY) && typeof row[LANE_CURRENCY] === 'string' ? String(row[LANE_CURRENCY]) : undefined;
        sums.set(lane(row), [...(sums.get(lane(row)) ?? []), [code?.trim().toUpperCase() || undefined, row[LANE_SUM]]]);
      }
      return { counts, sums };
    },
  });
}

interface LaneCounts {
  counts: Map<string, number>;
  sums: Map<string, Array<[string | undefined, unknown]>>;
}
/** The lane breakdown's question: the list's conditions, counted (and summed) by the lane column. */
function laneCountsText(query: string | undefined, by: string, amount?: string, currencyBy?: string): string | null {
  const parts = query ? splitQuery(query) : undefined;
  /* With an amount, the same breakdown sums it beside each count, named so neither is read for the other. */
  const measures = amount ? `count as ${LANE_COUNT}, sum ${amount} as ${LANE_SUM}` : 'count';
  const keys = amount && currencyBy ? `${by}, ${currencyBy} as ${LANE_CURRENCY}` : by;
  return parts ? `${parts.table} ${parts.filter ?? ''} ${measures} by ${keys}`.replace(/\s+/g, ' ') : null;
}

/** A list's sort as columns a card's row holds, for placing a moved card among a lane that keeps no order of its own. */
function sortOf(query: string | undefined): Array<{ column: string; desc: boolean }> {
  const said = query ? splitQuery(query).sort : undefined;
  if (!said) return [];
  return said
    .replace(/^sort\s+/i, '')
    .split(',')
    .flatMap((part) => {
      const [column, direction] = part.trim().split(/\s+/);
      return column && /^[A-Za-z_][\w]*$/.test(column) ? [{ column, desc: /^desc/i.test(direction ?? '') }] : [];
    });
}
const compareValues = (a: unknown, b: unknown) => {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  const [x, y] = [Number(a), Number(b)];
  return typeof a !== 'boolean' && Number.isFinite(x) && Number.isFinite(y) && String(a).trim() && String(b).trim()
    ? x - y
    : String(a).localeCompare(String(b), undefined, { numeric: true });
};

/* The lane breakdown's two measures, by names no column is read by. */
const LANE_COUNT = 'lane_cards';
const LANE_SUM = 'lane_amount';
const LANE_CURRENCY = 'lane_currency';

/** The lanes a reader has opened or folded on this board, kept in this browser: a convenience, so a storage that
    throws (a private window, blocked site data) leaves every foldable lane folded, as the App declared. */
function readFolds(key: string): Record<string, boolean> {
  try {
    const kept = JSON.parse(window.localStorage.getItem(key) ?? '{}') as unknown;
    return kept && typeof kept === 'object' && !Array.isArray(kept) ? (kept as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}
function keepFolds(key: string, folds: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(folds));
  } catch {
    /* Kept for this visit only. */
  }
}

/** The final lanes this browser last saw empty on this board. A first paint folds by them, never by counts that land
    after it: folding when the counts arrived moved every lane after the first paint. */
function readEmptyFinals(key: string): readonly string[] {
  try {
    const kept = JSON.parse(window.localStorage.getItem(`${key}:empty`) ?? '[]') as unknown;
    return Array.isArray(kept) ? kept.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}
function keepEmptyFinals(key: string, lanes: readonly string[]): void {
  try {
    window.localStorage.setItem(`${key}:empty`, JSON.stringify(lanes));
  } catch {
    /* Read again from the counts on the next visit. */
  }
}

/** One lane's question: the list's, narrowed to the lane, keeping its show and sort and dropping its page. */
function laneQuery(query: string, by: string, lane: string): string {
  const parts = splitQuery(query);
  const condition = lane === NONE ? `${by} is empty` : `${by} = ${quote(lane)}`;
  return joinQuery({ ...parts, filter: andQuery(parts.filter, condition), limit: undefined });
}

export function BoardList({ table, rows: page, spec, actions = [], interactive = true, label, query, referenceLabels }: BoardListProps) {
  const client = useQueryClient();
  const identity = useSyncExternalStore(subscribeSessionIdentity, sessionIdentity, sessionIdentity);
  useSyncExternalStore(updateAttempts.subscribe, updateAttempts.version, updateAttempts.version);
  const [asking, setAsking] = useState<AskedMove | null>(null);
  const [reasoning, setReasoning] = useState<AskedMove | null>(null);
  /* The card whose field is open, and which field; `column: null` once its save has landed and only the bar is left. */
  const [edit, setEdit] = useState<{ id: string; column: string | null } | null>(null);
  /* What the last move did, said to assistive technology, and the card the focus goes back to once it is redrawn. */
  const [said, setSaid] = useState('');
  const [focus, setFocus] = useState<{ id: string; seq: number }>();
  const landed = (card: TriageCard, sentence: string) => {
    setSaid(sentence);
    setFocus((current) => ({ id: card.id, seq: (current?.seq ?? 0) + 1 }));
  };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const connection = state.activeConnection ?? null;
  const isCurrentFrom = (epoch: number) => () =>
    mounted.current && epoch === sessionIdentity().epoch && connection === (state.activeConnection ?? null);

  // Every gate the ordinary update route applies, asked here so a card that
  // cannot move does not offer to.
  const current = (findTable(table.id) as TableMeta | undefined) ?? table;
  const columnNamed = (name: string | undefined): (ColumnMeta & { allowed?: string[] }) | undefined =>
    name === undefined ? undefined : (current.columns.find((c) => c.name === name) ?? table.columns.find((c) => c.name === name));
  const caption = (name: string) => columnLabel(table.id, name) ?? humanName(name.replace(/_id$/, ''));
  const editable = Boolean(
    interactive && writeAllowed(table.id) && state.connections?.some((c) => c.id === connection && c.writable) && !table.isView,
  );
  const mayEdit = (column: ColumnMeta | undefined) =>
    Boolean(editable && column && !column.primaryKey && column.writable !== false && column.changesBy !== 'actions');

  /* ---------- lanes ---------- */
  const byColumn = columnNamed(spec.by);
  const reference = byColumn?.references;
  const referenced = useReferenced(
    reference ? (findTable(reference.table) as TableMeta | undefined) : undefined,
    reference?.column,
    connection,
    identity.epoch,
    spec.lanes,
  );
  // The words are the table the list was read with; the catalog above is asked only what may be written.
  const vocabulary = table.columns.find((c) => c.name === spec.by)?.allowed ?? byColumn?.allowed;
  /* What a card is worth: the board's `sum`, else the first money its card shows (a line, a fact on its foot). Each
     lane's head says its sum, and a card says its money short, $240K, with the whole figure in its title. */
  const amount =
    spec.sum ??
    [...(spec.lines ?? []), ...(spec.footer ?? []).map((fact) => fact.column)].find(
      (name) => amountRule(table.id, name)?.format === 'money',
    );
  const amountSaid = amount ? (amountRule(table.id, amount) ?? { format: 'number' }) : null;
  /* Money each card says its own currency for: a card says its amount in it, and a lane sums each currency apart. */
  const currencyBy = amountSaid?.format === 'money' && amount ? currencyPath(amountSaid, amount) : undefined;
  const amountIn = (row: Record<string, unknown>) =>
    currencyBy && amountSaid
      ? { ...amountSaid, currency: rowCurrency(amountSaid, row, amountSaid.currency || defaultCurrency(), amount) }
      : amountSaid;
  const counts = useLaneCounts(query, spec.by, connection, identity.epoch, amount, currencyBy);
  const counted = counts.data?.counts;
  const sums = counts.data?.sums;
  const finals: readonly string[] = byColumn?.states?.final ?? table.columns.find((c) => c.name === spec.by)?.states?.final ?? [];
  /* A closed stage folds to a strip until the reader opens it, which this browser remembers for this board. */
  const foldKey = `mistri.board-folds:${activeApp()?.id ?? ''}:${table.id}:${spec.by}:${label ?? ''}`;
  const [folds, setFolds] = useState<Record<string, boolean>>(() => readFolds(foldKey));
  /* Which empty final lanes fold is decided before the first paint, from what this browser saw last time: the counts
     land after the cards, and a lane that folded then moved every lane to its right. What they find is kept for the
     next visit and changes nothing on this one, so a first visit draws every lane open and a later one draws the
     strips from the start; a strip that has since filled says its count and opens on a click. */
  const [emptyFinals] = useState(() => readEmptyFinals(foldKey));
  const foundEmpty = counted
    ? finals
        .filter((id) => (counted.get(id) ?? 0) === 0)
        .sort()
        .join('\n')
    : undefined;
  useEffect(() => {
    if (foundEmpty !== undefined) keepEmptyFinals(foldKey, foundEmpty ? foundEmpty.split('\n') : []);
  }, [foldKey, foundEmpty]);
  /* Values seen, most first: over the whole list once the counts are in, over the page until then. */
  const observed = counted
    ? [...counted]
        .filter(([id]) => id !== NONE)
        .sort((x, y) => y[1] - x[1])
        .map(([id]) => id)
    : [...new Set(page.flatMap((row) => (row[spec.by] == null ? [] : [String(row[spec.by])])))];
  /* Records with no value have a lane of their own where the lanes are not
     authored: a board that dropped them said nothing of where they were. */
  const noneLane = !reference && !spec.lanes && (counted ? (counted.get(NONE) ?? 0) > 0 : page.some((row) => row[spec.by] == null));
  const lanes: TriageLane[] = reference
    ? [
        { id: NONE, label: none(caption(spec.by)) },
        ...(spec.lanes ?? (referenced.data ?? []).map((each) => each.id)).map((id) => ({
          id,
          label: referenced.data?.find((each) => each.id === id)?.label ?? id,
        })),
      ]
    : [
        ...(spec.lanes ?? (vocabulary?.length ? vocabulary : observed).slice(0, LANE_CAP)).map((value) => ({
          id: value,
          label: laneWord(table.id, spec.by, value),
          mark: laneMark(table.id, spec.by, value, laneWord(table.id, spec.by, value)),
          ...(laneWord(table.id, spec.by, value) !== value ? { title: value } : {}),
        })),
        ...(noneLane ? [{ id: NONE, label: none(caption(spec.by)) }] : []),
      ];
  for (const lane of lanes) {
    if (spec.limits?.[lane.id] !== undefined) lane.limit = spec.limits[lane.id];
    const each = (sums?.get(lane.id) ?? []).flatMap(([currency, sum]) => {
      const short = shortAmount(sum, currency && amountSaid ? { ...amountSaid, currency } : amountSaid);
      return short ? [short] : [];
    });
    if (each.length) lane.sum = { text: each.map((one) => one.text).join(' · '), title: each.map((one) => one.title).join(' · ') };
    /* A board of rows keeps every lane open: a strip cannot stand in each row's run of cells. A lane the App folds, or
       a final state of the column's machine with nothing in it (Closed, Cancelled on a board of what is outstanding),
       is a strip a reader opens: an empty lane the width of a full one spent the room on nothing. */
    const emptyFinal = finals.includes(lane.id) && emptyFinals.includes(lane.id);
    if ((spec.folded?.includes(lane.id) || emptyFinal) && spec.swimlanes === undefined) {
      const folded = folds[lane.id] ?? true;
      lane.folded = folded;
      lane.onFold = () => {
        const next = { ...folds, [lane.id]: !folded };
        setFolds(next);
        keepFolds(foldKey, next);
      };
    }
  }
  /* New, from a lane's head, where the list offers New: the record starts in that lane where its column is the reader's
     to fill; where the resource's actions own the column, a record starts where they start it, so the "+" heads the
     first lane alone and presets nothing. */
  const newForm = useContext(BoardNewForm);
  if (newForm && editable) {
    const presets = Boolean(byColumn && !byColumn.primaryKey && byColumn.writable !== false && byColumn.changesBy !== 'actions');
    lanes.forEach((lane, index) => {
      if (presets ? lane.id === NONE : index > 0) return;
      lane.onNew = () =>
        openNewRecord(current, presets ? { ...newForm, defaults: { ...(newForm.defaults ?? {}), [spec.by]: lane.id } } : newForm);
    });
  }
  const laneIds = lanes.map((lane) => lane.id);

  /* Each lane's cards, read a page at a time: the list's one page left a
     900-card lane saying "3 / 5". Until a lane's own read lands, the list's
     page stands in for it, so nothing blinks. */
  const [pages, setPages] = useState<Record<string, number>>({});
  const laneOf = (row: Record<string, unknown>) => (row[spec.by] == null ? NONE : String(row[spec.by]));
  const reads = useQueries({
    queries: lanes.map((lane) => {
      const limit = LANE_PAGE * (pages[lane.id] ?? 1);
      const q = query ? laneQuery(query, spec.by, lane.id) : '';
      return {
        queryKey: ['run', connection, table.id, 'board-lane', identity.epoch, q, limit],
        // A folded lane's cards are not drawn, so not read until it is opened.
        enabled: Boolean(query) && !lane.folded && (counted ? (counted.get(lane.id) ?? 0) > 0 : true),
        // "Show more" keeps the cards drawn while the longer page is read; another question does not.
        placeholderData: (previous: unknown, before?: { queryKey: readonly unknown[] }) =>
          before?.queryKey[5] === q ? previous : undefined,
        queryFn: async () => {
          const data = (await api('/api/run', { q, limit, offset: 0 })) as {
            rows?: Array<Record<string, unknown>>;
            errors?: Array<{ message: string }>;
          };
          if (data.errors?.length) throw new Error(data.errors[0].message);
          return data.rows ?? [];
        },
      };
    }),
  });
  const laneRows = (index: number): Array<Record<string, unknown>> => {
    const id = lanes[index].id;
    if (counted && !(counted.get(id) ?? 0)) return [];
    return (reads[index]?.data as Array<Record<string, unknown>> | undefined) ?? page.filter((row) => laneOf(row) === id);
  };
  const read = query ? lanes.flatMap((_, index) => laneRows(index)) : page;
  const rowId = (row: Record<string, unknown>) => {
    const key = keyOf(table, row) as Record<string, unknown> | null;
    return key ? bulkKey(table, key) : null;
  };
  /* The rows as the moves still out draw them: a card stands where it was moved from the moment it is let go. */
  const optimistic = useOptimisticMoves(read, rowId, () => settle());
  const rows = optimistic.rows;
  /* A lane's count follows the cards drawn into it or out of it until the count is read again. */
  const drift = new Map<string, number>();
  read.forEach((row, index) => {
    const [was, is] = [laneOf(row), laneOf(rows[index])];
    if (was === is) return;
    drift.set(was, (drift.get(was) ?? 0) - 1);
    drift.set(is, (drift.get(is) ?? 0) + 1);
  });
  const laneKeys = lanes.map((lane) => [
    'run',
    connection,
    table.id,
    'board-lane',
    identity.epoch,
    query ? laneQuery(query, spec.by, lane.id) : '',
    LANE_PAGE * (pages[lane.id] ?? 1),
  ]);
  const countsKey = ['count', connection, 'board', identity.epoch, laneCountsText(query, spec.by, amount, currencyBy)];
  // A card another person just changed wears the grid's fading tint; the lanes are gathered anew each render.
  const changedRows = useChangedRows(table.id, rows, (row) => keyOf(table, row) as Record<string, unknown> | null);
  if (query && counted) {
    lanes.forEach((lane, index) => {
      const total = Math.max(0, (counted.get(lane.id) ?? 0) + (drift.get(lane.id) ?? 0));
      lane.total = total;
      const drawn = laneRows(index).length;
      if (total > drawn && !lane.folded)
        lane.more = {
          count: Math.min(LANE_PAGE, total - drawn),
          onMore: () => setPages((current) => ({ ...current, [lane.id]: (current[lane.id] ?? 1) + 1 })),
        };
    });
  }
  const laneLabel = (id: string) => lanes.find((lane) => lane.id === id)?.label ?? id;

  /* ---------- rows ---------- */
  const rowColumn = columnNamed(spec.swimlanes);
  const rowReference = rowColumn?.references;
  const seenRows =
    spec.swimlanes === undefined
      ? []
      : [...new Set(rows.map((row) => (row[spec.swimlanes!] == null ? NONE : String(row[spec.swimlanes!]))))];
  const rowNames = useReferenced(
    rowReference ? (findTable(rowReference.table) as TableMeta | undefined) : undefined,
    rowReference?.column,
    connection,
    identity.epoch,
    rowReference ? seenRows.slice().sort() : undefined,
  );
  const swimlanes: TriageRow[] | undefined =
    spec.swimlanes === undefined
      ? undefined
      : (() => {
          const values = seenRows.filter((value) => value !== NONE);
          const named = (value: string) =>
            rowReference ? (rowNames.data?.find((each) => each.id === value)?.label ?? value) : laneWord(table.id, spec.swimlanes!, value);
          const words = table.columns.find((c) => c.name === spec.swimlanes)?.allowed ?? rowColumn?.allowed;
          const ordered = words?.length
            ? [...words, ...values.filter((value) => !words.includes(value))]
            : values.sort((x, y) => named(x).localeCompare(named(y), undefined, { numeric: true }));
          return [
            ...ordered.map((value) => ({
              id: value,
              label: named(value),
              ...(!rowReference && named(value) !== value ? { title: value } : {}),
            })),
            ...(seenRows.includes(NONE) ? [{ id: NONE, label: none(caption(spec.swimlanes!)) }] : []),
          ];
        })();
  const rowLabel = (id: string) => swimlanes?.find((row) => row.id === id)?.label ?? id;
  const rowsMovable = Boolean(spec.swimlanes && mayEdit(rowColumn));
  const rowLock =
    spec.swimlanes === undefined || rowsMovable || !editable
      ? undefined
      : rowColumn?.changesBy === 'actions'
        ? say('changesOnlyThroughTheRecords', { caption: caption(spec.swimlanes) })
        : say('isNotYoursToChange', { caption: caption(spec.swimlanes) });

  /* With an order column, a lane reads in its order: empty places last, ties as the list sent them. */
  const place = (row: Record<string, unknown>): number | undefined => {
    const value = spec.order === undefined ? undefined : row[spec.order];
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(number) ? number : undefined;
  };
  /* Without an order a lane reads in the list's sort, and a card moved into it is placed by that sort until the lane
     is read again — or, where the sort is not one a row can say, after the cards already there — so the read that
     settles it finds it where it was drawn. */
  const sort = sortOf(query);
  const unordered = () =>
    optimistic.busy() || rows !== read
      ? rows
          .map((row, index) => ({ row, index, lane: laneIds.indexOf(laneOf(row)), moved: row !== read[index] }))
          .sort(
            (x, y) =>
              x.lane - y.lane ||
              sort.reduce((found, { column, desc }) => found || (desc ? -1 : 1) * compareValues(x.row[column], y.row[column]), 0) ||
              Number(x.moved) - Number(y.moved) ||
              x.index - y.index,
          )
          .map((each) => each.row)
      : rows;
  const ordered =
    spec.order === undefined
      ? unordered()
      : rows
          .map((row, index) => ({ row, index, at: place(row) }))
          .sort((x, y) =>
            x.at === undefined ? (y.at === undefined ? x.index - y.index : 1) : y.at === undefined ? -1 : x.at - y.at || x.index - y.index,
          )
          .map((each) => each.row);

  /* ---------- cards ---------- */
  const edited = [spec.primary, ...(spec.lines ?? []).slice(0, 1)]
    .filter((name) => name !== spec.by && name !== spec.order && name !== spec.swimlanes)
    .map((name) => columnNamed(name))
    // A reference on the card says another record's name: it is changed by that record's own verbs, not typed over here.
    .filter((column): column is ColumnMeta => mayEdit(column) && !column!.references && !/json/i.test(column!.type ?? ''))
    .map((column) => ({ field: column.name, label: caption(column.name) }));
  const lineWords = Boolean((table.columns.find((c) => c.name === spec.lines?.[0]) ?? columnNamed(spec.lines?.[0]))?.allowed?.length);
  let unplaced = 0;
  const cards: BoardCard[] = ordered.flatMap((row) => {
    const laneId = row[spec.by] == null ? (reference || noneLane ? NONE : undefined) : String(row[spec.by]);
    if (laneId === undefined || !laneIds.includes(laneId)) {
      unplaced++;
      return [];
    }
    const key = keyOf(table, row) as Record<string, unknown> | null;
    if (!key) return [];
    const line = spec.lines?.[0];
    // A reference says the record it names, never its key (listReferenceNames reads the name with the row).
    const detail = line ? namedCell(table, line, row, referenceLabels).value : undefined;
    const attempt = updateAttempts.get({ connection, table: table.id, key });
    const position = place(row);
    return [
      {
        id: bulkKey(table, key),
        key,
        row,
        laneId,
        ...(position === undefined ? {} : { position }),
        ...(spec.swimlanes === undefined ? {} : { rowId: row[spec.swimlanes] == null ? NONE : String(row[spec.swimlanes]) }),
        title: String(namedCell(table, spec.primary, row, referenceLabels).value ?? say('common.untitled')),
        // A line from a vocabulary says its word, as the lane heads and tone chips do.
        ...(detail != null && detail !== ''
          ? line === amount && shortAmount(detail, amountIn(row))
            ? (() => {
                const said = shortAmount(detail, amountIn(row))!;
                // Read out whole; drawn short, the whole figure in its title.
                return { subtitle: said.title, line: <span title={said.title}>{said.text}</span> };
              })()
            : {
                subtitle: lineWords ? vocabularyWord(String(detail)) : String(detail),
                // The line as its column dresses it, as the dashboard's board says it.
                ...(line && dressedValue(table.id, line, detail) ? { line: dressedValue(table.id, line, detail) } : {}),
              }
          : {}),
        /* A move drawn ahead of its save says so by the card's quiet (`pending`), not a line that would grow the card. */
        ...(attempt && !(attempt.phase === 'pending' && optimistic.pending(bulkKey(table, key)))
          ? { meta: attempt.phase === 'pending' ? say('common.saving') : attempt.message }
          : {}),
        ...(optimistic.pending(bulkKey(table, key)) ? { pending: optimistic.pending(bulkKey(table, key)) } : {}),
        ...(changedRows.has(row) ? { changed: changedRows.get(row) } : {}),
        ...(edited.length ? { edits: edited } : {}),
        ...(spec.category && cardCategory(table.id, spec.category, row[spec.category])
          ? { category: cardCategory(table.id, spec.category, row[spec.category])! }
          : {}),
        ...(spec.footer
          ? {
              footer: spec.footer.flatMap((fact) => {
                const value = row[fact.column];
                if (value === null || value === undefined || value === '') return [];
                const short = fact.column === amount ? shortAmount(value, amountIn(row)) : null;
                // A reference says the record it names, as the title does (`SoHo`, never `2`), unless a rule dresses it.
                const named = namedCell(table, fact.column, row, referenceLabels);
                const said = short
                  ? { node: <span title={short.title}>{short.text}</span>, text: short.title, person: false }
                  : named.value !== value && !columnDisplay(table.id, fact.column)
                    ? { node: String(named.value), text: String(named.value), person: false }
                    : cardFact(
                        table.id,
                        columnNamed(fact.column),
                        fact.column,
                        /* A person drawn as an initials disc is the one the reference names ("MO" for Maya Okafor), whose
                           name stands as its title: the disc of a staff key read as a number nobody could place. */
                        named.value !== value && namesPerson(table.id, fact.column) ? named.value : value,
                      );
                return [{ key: fact.column, ...(fact.icon ? { icon: fact.icon } : {}), ...said }];
              }),
            }
          : {}),
      },
    ];
  });
  const byId = new Map(cards.map((card) => [card.id, card]));
  /* What the lanes leave out, over the whole list once the counts are in:
     values past the lanes an App named, or past the cap on lanes a board
     draws by itself — which is said, since the reader cannot see it. */
  const outside = counted ? [...counted].filter(([id]) => !laneIds.includes(id) && (id !== NONE || !reference)) : undefined;
  const elsewhere = outside ? outside.reduce((sum, [, n]) => sum + n, 0) : unplaced;
  const capped = Boolean(!spec.lanes && outside?.some(([id]) => id !== NONE));
  const records: ModalRecord[] = cards.map((card) => ({ key: card.key, label: card.title }));

  /* ---------- who may move what ---------- */
  const laneWritable = Boolean(editable && byColumn && !byColumn.primaryKey && byColumn.writable !== false);
  // A reference is an ordinary column: its lanes are the reader's to change, unless the resource hands it to its actions.
  const direct = Boolean(reference && laneWritable && byColumn!.changesBy !== 'actions');
  /* A lane is entered through a fixed edit where the reader may write the column, or through a machine's command verb
     (G62) where the reader is granted the command: the drop is the verb, judged and recorded as its button would be. */
  const moves: LaneMove[] = direct
    ? []
    : [
        ...(laneWritable ? actions.filter((action) => isMove(action, spec.by, laneIds)) : []),
        ...actions.filter((action) => isCommandMove(action, spec.by, laneIds)),
      ];
  // The place is the reader's to change on the same terms as a calendar's date: an ordinary edit of an ordinary column.
  const orderColumn = columnNamed(spec.order);
  const orderable = Boolean(spec.order !== undefined && mayEdit(orderColumn));
  const whole = wholeColumn(orderColumn?.type);
  const conditions = [...new Set(moves.flatMap((action) => (action.when ? [action.when] : [])))];
  const keysText = cards.map((card) => card.id).join('\n');
  const answers = useQueries({
    queries: conditions.map((when) => ({
      queryKey: ['when-lanes', table.id, connection, identity.epoch, when, keysText],
      queryFn: () =>
        matchingKeys(
          table,
          cards.map((card) => card.key),
          when,
          connection,
        ),
      staleTime: 0,
      enabled: cards.length > 0,
    })),
  });
  const matched = new Map(conditions.map((when, index) => [when, answers[index].data]));
  const targets = (card: BoardCard) =>
    direct
      ? laneIds.filter((lane) => lane !== card.laneId && (lane !== NONE || byColumn!.nullable))
      : [
          ...new Set(
            moves
              .filter((action) => !action.when || matched.get(action.when)?.has(card.id))
              .flatMap((action) => lanesOfMove(action, spec.by, card.laneId))
              .filter((lane) => lane !== card.laneId),
          ),
        ];
  const laneMoves = direct || moves.length > 0;
  const offered = cards.map((card) => ({ ...card, targets: laneMoves ? targets(card) : [] }));

  const invalidate = async () => {
    // The rows and the counts have changed, and so may every other card's answer to `when`.
    void client.invalidateQueries({ queryKey: ['count', connection] });
    void client.invalidateQueries({ queryKey: ['when', table.id] });
    void client.invalidateQueries({ queryKey: ['when-lanes', table.id] });
    // Awaited: the card is redrawn in its new lane before the focus goes after it.
    await client.invalidateQueries({ queryKey: ['run', connection] });
  };
  /* What the cache is to say once a move is saved, and which lanes to read again when the last is done: read through
     a ref, as the queue runs after the render that made the move. */
  const touched = useRef(new Set<string>());
  const cache = useRef({ laneKeys, countsKey, laneIds, laneOf });
  cache.current = { laneKeys, countsKey, laneIds, laneOf };
  /* A saved move, written where the lanes are read from: the card leaves its lane's page and joins the other's, and
     each lane's count follows, so the drawing has nothing to give back when it lets the move go. */
  const dirty = useRef(false);
  const keep = (saved: ReadonlyArray<readonly [BoardCard, Values]>) => {
    dirty.current = true;
    if (!query) return;
    const { laneKeys: keys, countsKey: counting, laneIds: ids, laneOf: laneFor } = cache.current;
    const moved = new Map(saved.map(([card, values]) => [card.id, { ...card.row, ...values }]));
    const moves: Array<[string, string]> = [];
    keys.forEach((key, index) => {
      const lane = ids[index];
      client.setQueryData<Array<Record<string, unknown>>>(key, (data) => {
        if (!data && ![...moved.values()].some((row) => laneFor(row) === lane)) return data;
        const kept = (data ?? []).flatMap((row) => {
          const id = rowId(row);
          const now = id === null ? undefined : moved.get(id);
          if (!now) return [row];
          if (laneFor(row) !== laneFor(now)) moves.push([laneFor(row), laneFor(now)]);
          return laneFor(now) === lane ? [now] : [];
        });
        const present = new Set(kept.map(rowId));
        return [...kept, ...[...moved].filter(([id, row]) => laneFor(row) === lane && !present.has(id)).map(([, row]) => row)];
      });
    });
    if (moves.length)
      client.setQueryData<LaneCounts>(counting, (data) => {
        if (!data) return data;
        const counts = new Map(data.counts);
        for (const [from, to] of moves) {
          counts.set(from, Math.max(0, (counts.get(from) ?? 0) - 1));
          counts.set(to, (counts.get(to) ?? 0) + 1);
        }
        return { ...data, counts };
      });
    for (const [card, values] of saved) {
      touched.current.add(card.laneId);
      touched.current.add(laneFor({ ...card.row, ...values }));
    }
  };
  /* Once the last move is done: the lanes it touched, their counts and every card's `when` read again, once. */
  const settle = async () => {
    // Nothing saved (refused, cancelled, or a session since retired): nothing to read again.
    if (!dirty.current || !isCurrentFrom(identity.epoch)()) return;
    dirty.current = false;
    const lanesTouched = [...touched.current];
    touched.current.clear();
    void client.invalidateQueries({ queryKey: ['when', table.id] });
    void client.invalidateQueries({ queryKey: ['when-lanes', table.id] });
    if (!query) return invalidate();
    const { laneKeys: keys, countsKey: counting, laneIds: ids } = cache.current;
    await Promise.all([
      client.invalidateQueries({ queryKey: counting, exact: true }),
      ...keys
        .filter((_, index) => lanesTouched.includes(ids[index]))
        .map((key) => client.invalidateQueries({ queryKey: key, exact: true })),
    ]);
  };
  /** One write of one record; the outcome's message when it did not apply, and whether that was a refusal. */
  const write = async (card: BoardCard, values: Values, isCurrent: () => boolean) => {
    // The card as the board read it: a card someone else moved since is refused, not moved back over them.
    const expected = expectedValues(table, values, card.row);
    const result = await applyBulk(
      { connection, table: table.id },
      values,
      [{ key: card.key, label: card.title, ...(expected ? { expected } : {}) }],
      isCurrent,
    );
    const outcome = result.outcomes[0];
    return outcome.kind === 'applied'
      ? null
      : { message: outcome.message, refused: outcome.kind === 'rejected' || outcome.kind === 'blocked' };
  };

  /* What a move will write, worked out when it is made, so it is drawn at once and written as drawn: the lane where
     the reader writes it, the row, and the card's place with any neighbors renumbered around it. A lane an action
     moves to is drawn too, though the action writes it. */
  const planOf = ({ card, to, action }: Move) => {
    const laneChange = to.lane !== card.laneId;
    const rowChange = to.row !== undefined && to.row !== card.rowId && spec.swimlanes !== undefined;
    const own: Values = {};
    if (laneChange && !action) own[spec.by] = valueOf(to.lane, byColumn);
    if (rowChange) own[spec.swimlanes!] = valueOf(to.row!, rowColumn);
    let writes: Array<[BoardCard, number]> = [];
    if (to.index !== undefined && orderable) {
      const row = rowChange ? to.row : card.rowId;
      const cell = cards.filter(
        (each) => each.id !== card.id && each.laneId === to.lane && (spec.swimlanes === undefined || each.rowId === row),
      );
      writes = placements(card, cell, to.index, whole);
    }
    const mine = writes.find(([each]) => each.id === card.id);
    if (mine) own[spec.order!] = mine[1];
    const drawn: Values = { ...own, ...(laneChange && action ? { [spec.by]: valueOf(to.lane, byColumn) } : {}) };
    const neighbors = writes.filter(([each]) => each.id !== card.id);
    return { laneChange, rowChange, own, drawn, neighbors };
  };
  /* A move that did not apply goes back, and says so where the reader is: the card is where it was again. */
  const wentBack = (card: BoardCard, reason: string | undefined) => {
    landed(card, say('wentBack', { title: card.title, where: laneLabel(card.laneId), reason: reason ?? '' }).replace(/: $/, ''));
  };

  /* A move, in as few writes as it takes. The lane, where an action moves it,
     is that action alone — the action is what the resource's transitions
     allow, and nothing rides along with it. Everything else about the card —
     the lane where the reference is the reader's own, the row, the place —
     is one ordinary update of the card, then any renumbering of its new
     neighbors. Each write is checked, recorded and undoable on its own; the
     first that does not apply stops the rest, and what did apply is said. The
     move is already drawn (`token`): a refusal takes it back. */
  const run = async (
    { card, to, action }: Move,
    plan: ReturnType<typeof planOf>,
    token: number,
    values: Values | undefined = action?.set,
  ) => {
    const isCurrent = isCurrentFrom(identity.epoch);
    if (!isCurrent()) return optimistic.undo(token);
    const { laneChange, rowChange, own, drawn, neighbors } = plan;
    let moved = false;
    if (laneChange && action?.command) {
      // The verb's own pipeline: a refusal is said in the server's words, and a command that asks more opens its form.
      // A verb told its lane hears the drop's: `moveDeal` with `{ stage: 'negotiation' }`.
      const told = asksLane(action as AppCommandAction) ? { [spec.by]: valueOf(to.lane, byColumn) } : {};
      const outcome = await recordCommand(action.command, action.label)?.(card.key as Record<string, string | number>, told);
      if (!isCurrent()) return optimistic.undo(token);
      if (outcome?.status !== 'applied') {
        optimistic.undo(token);
        wentBack(card, outcome?.status === 'refused' ? outcome.message : undefined);
        return;
      }
      optimistic.saving(token);
      // In the command's own words when it said any, as a one-click command's notice is (Actions.tsx).
      toast(outcome.message ?? say('actionDone', { label: action.label }), 'ok');
      moved = true;
    } else if (laneChange && action) {
      const failed = await write(card, values!, isCurrent);
      if (!isCurrent()) return optimistic.undo(token);
      if (failed) {
        optimistic.undo(token);
        if (failed.refused) toast(failed.message, 'error');
        wentBack(card, failed.refused ? failed.message : undefined);
        return;
      }
      toast(say('actionDone', { label: action.label }), 'ok');
      moved = true;
    }
    let unsaved: string | undefined;
    if (Object.keys(own).length) {
      const failed = await write(card, own, isCurrent);
      if (!isCurrent()) return optimistic.undo(token);
      if (failed) {
        // Nothing applied yet: the card goes back, said only when refused (an uncertain write stays on the card).
        if (!moved) {
          optimistic.undo(token);
          if (failed.refused) toast(failed.message, 'error');
          wentBack(card, failed.refused ? failed.message : undefined);
          return;
        }
        unsaved = failed.message;
      } else moved = true;
    }
    if (unsaved === undefined) {
      const rest = await savePlaces(neighbors, (each, value) => write(each, { [spec.order!]: value }, isCurrent), isCurrent);
      if (rest.stale) return optimistic.undo(token);
      if (rest.failed) unsaved = rest.failed.message;
    }
    if (!moved) return optimistic.undo(token);
    /* What applied is kept as drawn; a place that did not save is put right by the read that settles the move. */
    keep(
      unsaved === undefined
        ? [[card, drawn], ...neighbors.map(([each, value]) => [each, { [spec.order!]: value }] as const)]
        : [[card, { [spec.by]: (drawn[spec.by] ?? card.row[spec.by] ?? null) as Values[string] }]],
    );
    optimistic.saved(token);
    const where = [laneChange ? laneLabel(to.lane) : '', rowChange ? rowLabel(to.row!) : ''].filter(Boolean).join(', ');
    if (unsaved !== undefined) {
      const what = rowChange && !laneChange ? 'row' : rowChange ? say('rowAndPlace') : 'place';
      toast(say('movedToButItsWasNotSaved', { where: where || laneLabel(to.lane), what, unsaved }), 'error');
      landed(card, say('movedToItsWasNotSaved', { title: card.title, where: where || laneLabel(to.lane), what }));
    } else {
      const at = to.index !== undefined && orderable ? say('place', { index: to.index + 1 }) : '';
      landed(card, say('moved', { title: card.title, where: where || laneLabel(to.lane), at }));
    }
  };
  /* A new place in the card's own cell. Each write is the ordinary update of
     the order column, so a renumbered lane is several updates, each checked,
     recorded and undoable; the first that does not apply stops the rest, and
     the lane is read again to show what is there. */
  const reorder = (card: BoardCard, index: number) => {
    const order = spec.order;
    if (!order) return;
    const cell = cards.filter((each) => each.laneId === card.laneId && each.rowId === card.rowId);
    const writes = placements(
      card,
      cell.filter((each) => each.id !== card.id),
      index,
      whole,
    );
    const isCurrent = isCurrentFrom(identity.epoch);
    if (!writes.length || !isCurrent()) return;
    const token = optimistic.begin(writes.map(([each, value]) => [each.id, { [order]: value }] as const));
    setFocus((current) => ({ id: card.id, seq: (current?.seq ?? 0) + 1 }));
    optimistic.enqueue(async () => {
      const saved = await savePlaces(writes, (each, value) => write(each, { [order]: value }, isCurrent), isCurrent);
      if (saved.stale) return optimistic.undo(token);
      if (saved.failed?.refused) toast(saved.failed.message, 'error');
      if (!saved.applied) {
        optimistic.undo(token);
        return wentBack(card, saved.failed?.refused ? saved.failed.message : undefined);
      }
      keep(writes.slice(0, saved.applied).map(([each, value]) => [each, { [order]: value }] as const));
      optimistic.saved(token);
      if (isCurrent())
        landed(
          card,
          say('movedToPlaceOfIn', { title: card.title, index: index + 1, cellCount: cell.length, laneLabel: laneLabel(card.laneId) }),
        );
    });
  };
  const onReorder = (picked: TriageCard, index: number) => {
    const card = byId.get(picked.id);
    if (card) reorder(card, index);
  };
  /* A move is drawn as it is made and written in its turn; one that asks first (a confirmation, a reason, a
     command's form) holds the card faded in its new place until it is answered. */
  const start = (move: Move, plan: ReturnType<typeof planOf>, token: number, values?: Values) => {
    optimistic.saving(token);
    optimistic.enqueue(() => run(move, plan, token, values));
  };
  const onMove = (picked: TriageCard, to: TriageTarget) => {
    const card = byId.get(picked.id);
    if (!card) return;
    const laneChange = to.lane !== card.laneId;
    // The move this card may make into that lane: one whose `when` it answered, where several lead there.
    const into = moves.filter((candidate) => lanesOfMove(candidate, spec.by, card.laneId).includes(to.lane));
    const action =
      laneChange && !direct
        ? (into.find((candidate) => !candidate.when || matched.get(candidate.when)?.has(card.id)) ?? into[0])
        : undefined;
    if (laneChange && !direct && !action) return;
    if (to.row !== undefined && to.row !== card.rowId && !rowsMovable) return;
    const move = { card, to, action };
    const plan = planOf(move);
    const asks =
      Boolean(action && !action.command && (action.reason || action.confirm)) ||
      Boolean(action?.command && (action as AppCommandAction).command.input.some((field) => field.name !== spec.by));
    const token = optimistic.begin(
      [[card.id, plan.drawn], ...plan.neighbors.map(([each, value]) => [each.id, { [spec.order!]: value }] as const)],
      asks ? 'asking' : 'saving',
    );
    setFocus((current) => ({ id: card.id, seq: (current?.seq ?? 0) + 1 }));
    if (action && !action.command && action.reason) setReasoning({ ...move, token, plan });
    else if (action && !action.command && action.confirm) setAsking({ ...move, token, plan });
    else optimistic.enqueue(() => run(move, plan, token));
  };
  const onRefuse = (_card: TriageCard, reason: string) => {
    toast(reason);
    setSaid(reason);
  };
  const onSelect = (picked: TriageCard) => {
    const card = byId.get(picked.id);
    if (card) void openRecord(table.id, card.key, card.title, 'push', { records });
  };
  const onEdit = (picked: TriageCard, field: string) => {
    setEdit({ id: picked.id, column: field });
  };
  const editing = edit ? byId.get(edit.id) : undefined;
  const closeEdit = (reason: CloseReason) => {
    const card = editing;
    if (!card) {
      setEdit(null);
      return;
    }
    if (reason === 'saved') {
      // The bar stays to say it saved, with its Undo; the card is read again to show the new words.
      setEdit({ id: card.id, column: null });
      void invalidate();
      landed(card, say('savedTitle', { title: card.title }));
    } else {
      setEdit(null);
      landed(card, '');
    }
  };

  if (reference && referenced.isPending && !spec.lanes) {
    return (
      <div className="board-list">
        <p className="board-elsewhere" role="status">
          {say('readingTheLanes')}
        </p>
      </div>
    );
  }
  return (
    <div className="board-list">
      <TriageBoard
        lanes={lanes}
        cards={offered}
        rows={swimlanes}
        rowsLabel={spec.swimlanes === undefined ? undefined : caption(spec.swimlanes)}
        rowLock={rowLock}
        ariaLabel={label ?? say('triageBoard')}
        emptyLaneMessage={say('noRecordsHere')}
        onSelect={interactive ? onSelect : undefined}
        onMove={laneMoves || rowsMovable || rowLock ? onMove : undefined}
        onReorder={orderable ? onReorder : undefined}
        onRefuse={onRefuse}
        onEdit={edited.length ? onEdit : undefined}
        under={
          editing
            ? {
                id: editing.id,
                node: (
                  <Suspense fallback={null}>
                    <BoardCardEditor
                      table={current}
                      row={editing.row}
                      column={edit?.column ? columnNamed(edit.column) : undefined}
                      recordKey={editing.key}
                      isCurrent={isCurrentFrom(identity.epoch)}
                      onClose={closeEdit}
                    />
                  </Suspense>
                ),
              }
            : undefined
        }
        announcement={said}
        focus={focus}
      />
      {elsewhere > 0 && (
        <p className="board-elsewhere" role="status">
          {capped
            ? say(reference ? 'inMoreLanes' : 'inMoreStates', {
                records: say('recordsAre', { count: elsewhere }),
                count: outside!.length,
                cap: LANE_CAP,
              })
            : say(reference ? 'inOtherLanes' : 'inOtherStates', { records: say('recordsAre', { count: elsewhere }) })}
        </p>
      )}
      {asking && (
        <Confirm
          move={asking}
          lane={laneLabel(asking.to.lane)}
          onAnswer={(yes) => {
            setAsking(null);
            if (yes) start(asking, asking.plan, asking.token);
            else {
              optimistic.undo(asking.token);
              landed(asking.card, '');
            }
          }}
        />
      )}
      {reasoning && (
        <ReasonForm
          action={reasoning.action as AppUpdateAction}
          label={reasoning.card.title}
          onAnswer={(reason) => {
            setReasoning(null);
            if (reason !== null && reasoning.action && !reasoning.action.command && reasoning.action.reason)
              start(reasoning, reasoning.plan, reasoning.token, { ...reasoning.action.set, [reasoning.action.reason]: reason });
            else {
              optimistic.undo(reasoning.token);
              landed(reasoning.card, '');
            }
          }}
        />
      )}
    </div>
  );
}

/** Ask before writing, in the page's own dialog. */
function Confirm({ move, lane, onAnswer }: { move: Move; lane: string; onAnswer: (yes: boolean) => void }) {
  const answered = useRef(false);
  const answer = (yes: boolean) => {
    if (answered.current) return;
    answered.current = true;
    onAnswer(yes);
  };
  const label = move.action!.label;
  return (
    <Modal className="confirm action-confirm" ariaLabel={`${label}?`} onClose={() => answer(false)}>
      <h2>{label}?</h2>
      <p>{say('moveTitleToLane', { title: move.card.title, lane })}</p>
      <div className="confirm-actions">
        <Button onClick={() => answer(false)}>{say('common.cancel')}</Button>
        <Button intent="primary" onClick={() => answer(true)}>
          {label}
        </Button>
      </div>
    </Modal>
  );
}
