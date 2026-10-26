/**
 * A result grid, for anything that has rows and columns.
 *
 * One grid for the explorer's table view, an app's list, a record's related
 * rows, a dashboard's list card and an expanded row's children — two
 * renderers would drift, and a work order's parts showing `1`/`0` where
 * the table above shows ✓/✗ is the kind of small inconsistency that makes a
 * tool feel assembled rather than built.
 *
 * Sorting and filtering here work by rewriting the query text — that is
 * the design, and it is why a filter built by clicking can be edited by
 * typing, saved, shared as a link and read back later. So the grid holds
 * no sort state of its own: the walk's query is read for what is sorted,
 * and the header's clicks write to it.
 *
 * TanStack Table holds the column and row model; TanStack Virtual does the
 * window arithmetic for a long result, rendered as a real table with two
 * spacer rows, so column widths, sticky headers, text selection and
 * Find-in-page all keep working. Below a few hundred rows windowing costs
 * more than it saves and every row is drawn.
 */
import { useMessageLanguage } from './useMessageLanguage.js';
import {
  cloneElement,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  columnDisplay,
  columnLabel,
  currentEntry,
  emptyWord,
  keyOf,
  openRecord,
  peekRecord,
  prefersPages,
  primaryKey,
  rowLabel,
  state,
  viewportBox,
} from '../core.js';
import { opensRecord } from '../recordIntent.js';
import { labelColumn as namingColumn } from '@mistriwork/engine/shared/schema.js';
import { centsAmong, dressFor, leadTonePath, maskedText, ruleSays, subtitlePath, type DisplayRule } from './valueModel.js';
import { currencyPath } from '@mistriwork/engine/shared/money.js';
import { dueOpen } from './dueOpen.js';
import { LeadMark } from './Dressed.js';
import { formatDate, formatDateTime, formatNumber, sayNearDay } from '../locale.js';
import { AvatarText, Dressed } from './Value.js';
import { ValueSlot } from './valueRenderers.js';
import { sortDirection } from '../clauses.js';
import { planColumn, sortableFromHeader } from '../columns.js';
import { pinnedFor, pinsVersion, subscribePins } from '../pins.js';
import { hasChildren } from '../nested.js';
import { openFilterMenu, sortBy } from '../thmenu.js';
import { AppColumnMenuButton, useAppColumnMenu } from './AppColumnMenu.js';
import type { ColumnMeta, TableMeta } from '@mistriwork/engine/shared/schema.js';
import { DetailRow, Expander } from './Nested.js';
import {
  createRowHosts,
  RowDecoration,
  RowHostScope,
  RowTrailScope,
  rowKeyString,
  useRowHostScope,
  useRowTrailScope,
  type RowHostStore,
} from './RowHost.js';
import type { TrailList } from '../recordTrail.js';
import { useGridKeyboard } from './useGridKeyboard.js';
import { useChangedRows } from '../liveState.js';
import { textMeasure } from './textMeasure.js';
import { presentationColumns } from './columnPresentation.js';
import { usePins } from './usePins.js';
import { useStickyHead } from './useStickyHead.js';
import type { TableSizing } from '@mistriwork/engine/shared/tableSizing.js';
import {
  fitGridColumns,
  keepFitting,
  tagsThatFit,
  twoLineWidth,
  GRID_EXPANDER_WIDTH,
  GRID_HEAD_CHAR,
  GRID_SIZE_SAMPLE,
  GRID_TRAIL_WIDTH,
} from './gridSizing.js';
import { VISUAL_THEME_EVENT } from '../visualTheme.js';
import { JsonPreview } from './JsonPreview.js';
import { AvatarPhotoContext, AvatarPhotos, avatarOwner } from './avatarPhotos.js';
import { jsonValueOf, previewOf } from './jsonModel.js';
import { vocabularyWord } from '@mistriwork/engine/shared/model.js';
import { shell } from '../shellMode.js';
import type { CellDraw } from './gridCellModel.js';
import { parseLabelTemplate } from '@mistriwork/engine/shared/recordLabel.js';
import { say } from '../copy/lists/components/Grid.js';
import { TAGS_TYPE, tagChips } from '@mistriwork/engine/shared/tagLists.js';
import { addHostListener, removeHostListener, shellBody } from '../shellHost.js';
import { rowOpensTarget, useRowOpens } from './rowOpens.js';

/* A column narrower than this does not take a folded detail line: it would wrap inside it. */
const FOLD_ROOM = 150;

/* How many of a record's tags a list's cell draws before it says how many more. */
const TAGS_SHOWN = 3;

export type Row = Record<string, unknown>;

export interface GridData {
  table?: string;
  columns?: string[];
  rows: Row[];
  total?: number;
  exactTotal?: boolean;
  /** The total stopped at its bound: at least `total` rows, not exactly. */
  cappedTotal?: boolean;
  /** The page this is, as the run answered it; a record opened from it steps through the list with them (recordTrail.ts). */
  limit?: number;
  offset?: number;
  ms?: number;
  order?: {
    implicit?: boolean;
    order: Array<{ column: string; direction: 'asc' | 'desc' }>;
  };
  /** The first and last rows' order values, where the list pages by key (pageStep.ts). */
  bounds?: {
    first: Record<string, string | number | boolean | null>;
    last: Record<string, string | number | boolean | null>;
  };
  errors?: unknown[];
}

interface GridProps {
  sizing?: TableSizing;
  table?: TableMeta;
  data: GridData;
  /** Ride-along columns — the keys a list fetches so rows can open — dropped from the drawing only. */
  hide?: string[];
  /** A caller's own words over columns; the label seam answers otherwise. */
  labels?: Record<string, string>;
  /** Column → its total over the whole query, drawn in a footer row; undefined while it is asked. */
  totals?: Record<string, unknown>;
  /** The footer's caption: "Total", or what it is a total of when the grid shows fewer rows than it sums. */
  totalsLabel?: string;
  /** Row height: 'compact' tightens the rows of a list read as a ledger. */
  density?: 'comfortable' | 'compact';
  /** Visible raw-key column -> hidden joined label column. Keys remain untouched. */
  referenceLabels?: Record<string, string>;
  /** Whether this grid may navigate the walk: header sort, filter menus, expanders. */
  interactive?: boolean;
  /** Whether a long result is windowed. */
  virtual?: boolean;
  onRowClick?: (row: Row) => void;
  /** The list this grid's rows are a page of, when it is a room's own list: a record opened from it steps past the page (recordTrail.ts). An embedded grid hands its rows only. */
  list?: TrailList;
  /** The record the reader is on beside this list — a split's detail — marked and kept in view as it steps. */
  current?: Record<string, unknown>;
  emptyText?: string;
  compact?: boolean;
  /** The result's first row number in the whole, for the keyboard's aria. */
  firstRow?: number;
  /** An embedded grid keeps to its width: columns past it are left out rather than scrolled to. */
  dropColumns?: boolean;
  /** A cell's editor in place of its value, where the list edits it (GridCellEditor.tsx); undefined leaves the cell as drawn. */
  /** `label` is the reference's name the cell already draws, so an editor opens on it rather than on the key. */
  editCell?: (row: Row, column: string, draw: CellDraw, label?: unknown) => ReactNode | undefined;
  /** What the host draws in an empty cell in place of its empty mark (a suggestion waiting on it); undefined leaves the mark. One line: no row grows. */
  adornCell?: (row: Row, column: string) => ReactNode | undefined;
}

/** Beyond a few hundred rows the DOM, not the database, is the bottleneck. */
const VIRTUAL_THRESHOLD = 300;
const OVERSCAN = 12;
/** The most a single grid cell will put in the DOM. Well past what 30rem shows. */
const CELL_MAX = 300;
/** Rows started per batch when every row is expanded at once, and the pause between. */
const BATCH = 4;
const BREATH_MS = 60;

interface Plan {
  align: string;
  kind: string;
  mono: boolean;
  /** A text column of keys, references or codes: the data face stays for it in an App, where other short text is read. */
  idLike?: boolean;
  decimals?: number;
  group?: boolean;
  showTime?: boolean;
}

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, Row>();
const NO_ROWS: Row[] = [];

type RowHostRef = ReturnType<RowHostStore['ref']>;

function clampCell(raw: string): { text: string; title?: string } {
  /* Not clamped, the cell has nothing to add on hover unless its column clips
     it, which onMouseOver decides from the cell's own overflow: a title on
     every value past 40 characters repeated a name the reader could read, in a
     native tooltip drawn over whatever sat under it. */
  if (raw.length <= CELL_MAX) return { text: raw };
  const more = raw.length - CELL_MAX;
  return {
    text: `${raw.slice(0, CELL_MAX)}…`,
    title: say('moreCharactersOpenTheRow', { count: more }),
  };
}

/**
 * One cell, rendered by what it holds. A reference is marked on the way
 * out: a foreign key can be a number, a string or a code, so the branch
 * that draws it is decided by its type while whether it points somewhere
 * is decided by the schema.
 */
/** A total, dressed as its column is; a sum past 2^53 is shown as the server sent it. */
function TotalValue({ value, display }: { value: unknown; display: DisplayRule | null }) {
  if (value === undefined)
    return (
      <span className="grid-totals-pending" aria-label={say('summing')}>
        …
      </span>
    );
  if (value === null) return <span className="null">{emptyWord()}</span>;
  const dress = dressFor(display, value);
  if (dress && dress.kind !== 'meter') return <Dressed dress={dress} compact={dress.kind === 'richText'} />;
  return <span className="num-value">{formatNumber(value)}</span>;
}

/** The words a plain cell draws for a value, which the grid sizes a column by and a folded detail line tests its head
    against: a reference's label, a display rule's own words, a number as formatted, else the raw value. */
function drawnWords(display: DisplayRule | null, plan: Plan, value: unknown, label?: unknown): unknown {
  if (label !== null && label !== undefined && String(label) !== '') return label;
  const dress = dressFor(display, value);
  if (!dress && plan.kind === 'number' && value != null) return numberShown(value, plan) ?? value;
  return (dress?.kind === 'tone' || dress?.kind === 'word' || dress?.kind === 'mark' ? dress.label : dress?.text) ?? value;
}

/** A row's folded columns, each drawn as its own cell would draw it, for the detail line under the row's name. */
export function foldedOf(more: NonNullable<CellColumn['more']>, record: Row): { name: string; head: string; body: ReactNode }[] {
  /* Empty says nothing, and a yes-or-no says its head where it is yes ("Listed online") and nothing where it is no. */
  const yes = (value: unknown) => value === true || value === 1 || value === '1' || value === 't' || value === 'true';
  return more
    .filter((column) => record[column.name] !== null && record[column.name] !== undefined && record[column.name] !== '')
    .filter((column) => column.plan.kind !== 'boolean' || yes(record[column.name]))
    .map((column) => {
      if (column.plan.kind === 'boolean') return { name: column.name, head: column.head, body: null };
      const td = CellBody({
        meta: column.meta,
        plan: column.plan,
        value: record[column.name],
        label: column.label ? record[column.label] : undefined,
        display: column.display,
        pin: undefined,
        edge: false,
      });
      /* A value that already says its head ("Cycle 19" under Cycle) is not told it twice: tested against the words
         the cell draws, which a display rule or a reference's label may set apart from the stored value. */
      const said = String(
        drawnWords(
          column.display as DisplayRule | null,
          column.plan,
          record[column.name],
          column.label ? record[column.label] : undefined,
        ) ?? '',
      ).toLowerCase();
      return {
        name: column.name,
        head: said.startsWith(column.head.toLowerCase()) ? '' : column.head,
        body: isValidElement<{ children?: ReactNode }>(td) ? td.props.children : null,
      };
    });
}

/** A cell, and under it the second line its column's display rule names.
    Memoized, as its row is: every prop is a value or a per-column object
    the grid keeps (`useKeptColumns`), so an unchanged cell is not redrawn.
    An editable cell is handed the grid's one `editCell` and its row, not a
    closure made per paint, for the same reason. */
const Cell = memo(function Cell({
  sub,
  more,
  editCell,
  adornCell,
  record,
  name,
  lead,
  ...props
}: Parameters<typeof CellBody>[0] & {
  sub?: unknown;
  editCell?: GridProps['editCell'];
  adornCell?: GridProps['adornCell'];
  record?: Row;
  name?: string;
  /** The mark in a tinted square before the value, and the tone its square takes from the row. */
  lead?: { mark: string; tone?: string };
  /** The folded columns' heads and values, drawn under the value as one detail line. */
  more?: { name: string; head: string; body: ReactNode }[];
}) {
  const edit = editCell && record && name !== undefined ? (draw: CellDraw) => editCell(record, name, draw, props.label) : undefined;
  const td = CellBody(props);
  const empty = props.value === null || props.value === undefined || props.value === '';
  const adorned = adornCell && record && name !== undefined && empty ? adornCell(record, name) : undefined;
  if (adorned !== undefined && isValidElement<{ children?: ReactNode }>(td)) return cloneElement(td, {}, adorned);
  /* An edited cell keeps its own <td> — alignment, pin, dress — and hands its
     editor a way to draw any value as this cell would. */
  if (edit && isValidElement<{ children?: ReactNode; className?: string }>(td)) {
    const draw: CellDraw = (next) => {
      const drawn = next ? CellBody({ ...props, value: next.value, label: next.label }) : td;
      return isValidElement<{ children?: ReactNode }>(drawn) ? drawn.props.children : null;
    };
    const editor = edit(draw);
    /* The whole cell is the editor's, its padding too: a click there edits
       rather than opening the row, as a click on the value does. */
    if (editor !== undefined)
      return cloneElement(
        td,
        {
          className: `${td.props.className ?? ''} cell-editable`,
          onClick: (event: React.MouseEvent<HTMLElement>) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) event.currentTarget.querySelector<HTMLElement>('[data-cell-edits]')?.click();
          },
        } as Record<string, unknown>,
        editor,
      );
  }
  const hasSub = !(sub === null || sub === undefined || sub === '');
  const hasMore = Boolean(more?.length);
  if ((!hasSub && !lead && !hasMore) || !isValidElement<{ children?: ReactNode; className?: string }>(td)) return td;
  const body =
    hasSub || hasMore ? (
      <span className="cell-stack">
        <span className="cell-main">{td.props.children}</span>
        {hasSub && <span className="cell-sub">{String(sub)}</span>}
        {hasMore && (
          <span className="cell-more">
            {more!.map((item) => (
              <span key={item.name} className="cell-more-item">
                {item.head && <span className={item.body === null ? 'cell-more-flag' : 'cell-more-head'}>{item.head}</span>}
                {item.body !== null && <> {item.body}</>}
              </span>
            ))}
          </span>
        )}
      </span>
    ) : (
      td.props.children
    );
  return cloneElement(
    td,
    hasMore ? ({ className: `${td.props.className ?? ''} has-more` } as Record<string, unknown>) : undefined,
    lead ? (
      <span className="cell-lead">
        <LeadMark mark={lead.mark} tone={lead.tone} />
        <span className="cell-lead-body">{body}</span>
      </span>
    ) : (
      body
    ),
  );
});

/* The lead icon a column's rule puts before its value, tinted by the tone its tone column's rule gives the row. Kept
   per row as one object per mark and tone, so the memoized cell sees the same prop until the row changes. */
const leads = new Map<string, { mark: string; tone?: string }>();
function leadOf(column: CellColumn, record: Row): { mark: string; tone?: string } | undefined {
  const mark = column.display?.icon?.mark;
  if (!mark) return undefined;
  const raw = column.leadTone && Object.hasOwn(record, column.leadTone.path) ? record[column.leadTone.path] : undefined;
  const said = column.leadTone && raw != null ? ruleSays(column.leadTone.rule, raw).tone : undefined;
  /* A value the rule does not name is "neutral" as a chip, but a grey square on every ordinary row reads as disabled:
     only a tone the rule says (by name or by "*") takes the accent's place. */
  const named = column.leadTone?.rule?.tone ?? {};
  const tone = said === 'neutral' && !Object.hasOwn(named, String(raw)) && !Object.hasOwn(named, '*') ? undefined : said;
  const key = `${mark}\u0000${tone ?? ''}`;
  if (!leads.has(key)) leads.set(key, { mark, ...(tone ? { tone } : {}) });
  return leads.get(key);
}

/* A key the App names in its own words ('SO-{id}'): the template filled
   with the key as it came, never through Number(), so a key past 2^53
   reads whole. The cell's data is untouched: sort, filter and export read the key. */
function keyName(template: string, value: unknown): unknown {
  if (value === null || value === undefined || value === '') return value;
  const parsed = parseLabelTemplate(template);
  return 'problem' in parsed ? value : parsed.parts.map((part) => ('text' in part ? part.text : String(value))).join('');
}

/** What a row needs to draw one column's cells. */
interface CellColumn {
  name: string;
  meta: ColumnMeta | undefined;
  plan: Plan;
  display: DisplayRule | null;
  /** The hidden column that holds a reference's label, when this column is one. */
  label: string | undefined;
  /** The row field its second line is read from, when the display rule names one. */
  subtitle: string | undefined;
  /** The row field a money column's currency code is read from, when its rule says `currency: { column }`. */
  currency?: string;
  /** The row field a lead icon's tone is read from, and the rule that says that field's tone. */
  leadTone?: { path: string; rule: DisplayRule | null };
  /** The App's name for a record keyed by this column ('SO-{id}'), drawn in place of the bare key. */
  named?: string;
  /** The row column holding the key of the record this column's avatar photo is of (avatarPhotos.tsx). */
  photoOwner: string | undefined;
  pin: number | undefined;
  edge: boolean;
  wraps?: boolean;
  /** The columns the room could not hold, drawn under this one's value as a detail line (an App's list). */
  more?: { name: string; head: string; meta: ColumnMeta | undefined; plan: Plan; display: DisplayRule | null; label: string | undefined }[];
}

/**
 * The columns as the rows draw them, the same array for as long as nothing
 * in it changed. The grid redraws whenever the room around it does — a
 * keystroke in the list's search box was one — and a fresh array every time
 * handed every memoized row a new prop, so each keystroke redrew every cell
 * on the page: 250 rows, 250 times the work of 20.
 */
function useKeptColumns(columns: CellColumn[]): CellColumn[] {
  const kept = useRef(columns);
  const was = kept.current;
  /* A plan is remade from the rows (planColumn reads their decimals), so a
     refetch with one changed row compares it by what it says. */
  const samePlan = (a: Plan, b: Plan) =>
    (Object.keys(a) as Array<keyof Plan>).every((key) => a[key] === b[key]) && Object.keys(a).length === Object.keys(b).length;
  const same =
    was.length === columns.length &&
    columns.every((column, i) =>
      (Object.keys(column) as Array<keyof CellColumn>).every(
        (key) => column[key] === was[i][key] || (key === 'plan' && samePlan(column.plan, was[i].plan)),
      ),
    );
  if (!same) kept.current = columns;
  return kept.current;
}

/** What a number cell draws for a value, or null where it draws the raw text.
    A value the server sent as a string because it is past 2^53 must not be
    run back through Number(): formatNumber keeps every digit. */
function numberShown(value: unknown, plan: { decimals?: number; group?: boolean }): string | null {
  const n = Number(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value) && !Number.isSafeInteger(n)) return formatNumber(value);
  return Number.isFinite(n)
    ? formatNumber(n, {
        minimumFractionDigits: plan.decimals,
        maximumFractionDigits: plan.decimals,
        useGrouping: plan.group,
      })
    : null;
}

/* A dress that draws only its words: a meter's bar and a percent's bar or ring are width the words do not
   measure. (Only a number's or a date's dress is read for this: an avatar or a signature is text's.) */
const drawsWords = (dress: NonNullable<ReturnType<typeof dressFor>>) =>
  dress.kind !== 'meter' && !('bar' in dress && dress.bar) && !('ring' in dress && dress.ring);

/* A record's tags in a list's cell: as many whole chips as the cell holds
   (at most TAGS_SHOWN, at least one), then how many more. Clipped by the
   cell, Thread's issues read "accessibility perfo"; a chip is a word, and a
   cut one is no word at all. The chips that do not fit are hidden, not
   unmounted, so a wider cell shows them again; the count is written into a
   span React leaves empty. */
function TagsCellList({ chips }: { chips: ReturnType<typeof tagChips> }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = chips.slice(0, TAGS_SHOWN);
  const labels = chips.map((chip) => chip.label).join('\n');
  useLayoutEffect(() => {
    const list = ref.current;
    const cell = list?.parentElement;
    if (!list || !cell) return;
    const tags = [...list.querySelectorAll<HTMLElement>(':scope > .record-tag')];
    const more = list.querySelector<HTMLElement>(':scope > .tags-cell-more')!;
    const sayMore = (count: number) => {
      more.textContent = count > 0 ? say('moreTags', { count }) : '';
      more.style.display = count > 0 ? '' : 'none';
    };
    const fit = () => {
      tags.forEach((tag) => (tag.style.display = ''));
      sayMore(chips.length - tags.length);
      const box = getComputedStyle(cell);
      const room = cell.clientWidth - parseFloat(box.paddingLeft) - parseFloat(box.paddingRight);
      if (!(room > 0)) return;
      const gap = parseFloat(getComputedStyle(list).columnGap) || 0;
      const widths = tags.map((tag) => tag.offsetWidth);
      const count = tagsThatFit(widths, chips.length, gap, room, (rest) => {
        sayMore(rest);
        return more.offsetWidth;
      });
      sayMore(chips.length - count);
      tags.forEach((tag, index) => (tag.style.display = index < count ? '' : 'none'));
    };
    fit();
    const observer = new ResizeObserver(() => fit());
    observer.observe(cell);
    return () => observer.disconnect();
  }, [labels]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span ref={ref} className="tags-cell-list">
      {shown.map((chip) => (
        <span key={chip.label} className={`record-tag tone tone-${chip.tone ?? 'neutral'}`}>
          {chip.label}
        </span>
      ))}
      <span className="tags-cell-more" />
    </span>
  );
}

function CellBody(
  props: Parameters<typeof PlatformCell>[0] & {
    row?: Record<string, unknown>;
    table?: string;
    currency?: unknown;
    /** A due date's row is still open (dueOpen.ts): one that has passed is drawn in the warning tone. */
    open?: boolean;
  },
) {
  const { row, table, currency, open, ...cell } = props;
  if (open) cell.display = { ...(cell.display as DisplayRule), open: true };
  /* A money column whose currency is the row's own: the code the row holds, where it holds one. */
  if (typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency))
    cell.display = {
      ...(cell.display as DisplayRule),
      currency: currency.toUpperCase(),
    };
  const rule = cell.display as DisplayRule | null;
  /* The App's own renderer draws the value inside the platform's cell — its
     class, alignment and pin kept — and the platform's own drawing stands in
     until it arrives. The cell's data is untouched: sort, filter and export
     read the value, never what a renderer drew. */
  if (
    rule?.component &&
    table &&
    maskedText(rule, cell.value) === undefined &&
    cell.value !== null &&
    cell.value !== undefined &&
    shellBody().classList.contains('app-mode')
  ) {
    const { component: _component, ...rest } = rule;
    const td = PlatformCell({ ...cell, display: rest });
    if (!isValidElement<{ children?: ReactNode }>(td)) return td;
    return cloneElement(
      td,
      undefined,
      <ValueSlot
        id={rule.component.id}
        value={cell.value}
        row={row}
        column={{ name: cell.meta?.name ?? '', resource: table }}
        context="grid"
        compact
        {...ruleSays(rest, cell.value)}
        fallback={td.props.children}
      />,
    );
  }
  return PlatformCell(cell);
}

function PlatformCell({
  meta,
  plan,
  value,
  label,
  display,
  pin,
  edge,
  photo,
  wraps,
}: {
  meta: ColumnMeta | undefined;
  plan: Plan;
  value: unknown;
  label?: unknown;
  display: unknown;
  pin: number | undefined;
  edge: boolean;
  /** The room set this column's values on two lines (gridSizing.ts): the cell wraps at words, kept whole. */
  wraps?: boolean;
  /** The avatar's photo, where the column draws one and the record has one. */
  photo?: string;
}) {
  const classes: string[] = [`align-${plan.align}`];
  const peek =
    meta?.references && value !== null && value !== undefined && value !== ''
      ? {
          'data-ref-table': meta.references.table,
          'data-ref-column': meta.references.column,
          'data-ref-value': String(value),
        }
      : {};
  const pinAttrs = pin !== undefined ? { style: { left: `${pin}px` } } : {};
  /* The face the rule asks for wins; unasked, an App sets short text in the reading face unless it is a key or a code. */
  const face = (display as DisplayRule | null)?.face;
  const app = shellBody().classList.contains('app-mode');
  const pinClass =
    (pin !== undefined ? ` pinned${edge ? ' pinned-edge' : ''}` : '') + (face ? ` face-${face}` : '') + (wraps ? ' wraps' : '');

  /* A record's tags (tagLists.ts): a few chips, and how many more there are. */
  if (meta?.type === TAGS_TYPE) {
    const chips = tagChips(value);
    return (
      <td className={`align-left tags-cell${pinClass}`} title={chips.map((chip) => chip.label).join(', ') || undefined} {...pinAttrs}>
        {chips.length ? <TagsCellList chips={chips} /> : emptyWord()}
      </td>
    );
  }
  if (value === null || value === undefined) {
    return (
      <td className={`null align-${plan.align}${pinClass}`} title="null" {...pinAttrs}>
        {emptyWord()}
      </td>
    );
  }
  const json = jsonValueOf(meta, value);
  if (json)
    return (
      <td className={`align-left json-cell${pinClass}`} {...pinAttrs}>
        <JsonPreview value={json.value} name={meta?.name ?? 'Value'} type={meta?.type} />
      </td>
    );
  const raw = String(value);
  if (label !== null && label !== undefined && String(label) !== '') {
    return (
      <td className={`align-left reflink${pinClass}`} title={`${String(label)} (${raw})`} {...peek} {...pinAttrs}>
        {(display as DisplayRule | null)?.avatar ? (
          <AvatarText text={clampCell(String(label)).text} photo={photo} />
        ) : (
          clampCell(String(label)).text
        )}
      </td>
    );
  }
  const dress = dressFor(display as DisplayRule | null, value);
  if (dress) {
    return (
      <td className={`align-${plan.align} dressed${pinClass}`} {...peek} {...pinAttrs}>
        {/* A cell is one line: rich text is its excerpt there, read whole on its record. */}
        <Dressed dress={dress.kind === 'avatar' && photo ? { ...dress, photo } : dress} compact={dress.kind === 'richText'} />
      </td>
    );
  }
  if (!face && (plan.kind === 'number' || (plan.mono && (!app || plan.kind !== 'text' || plan.idLike)))) classes.push('mono');

  if (plan.kind === 'boolean') {
    const on = value === true || value === 1 || value === '1' || value === 't';
    return (
      <td className={`${classes.join(' ')} bool${pinClass}`} title={raw} {...peek} {...pinAttrs}>
        <span className={on ? 'yes' : 'no'}>{on ? '✓' : '✗'}</span>
      </td>
    );
  }
  if (plan.kind === 'number') {
    const shown = numberShown(value, plan) ?? raw;
    return (
      <td
        className={`${classes.join(' ')} num${meta?.references ? ' reflink' : ''}${pinClass}`}
        title={shown === raw ? undefined : raw}
        {...peek}
        {...pinAttrs}
      >
        {shown}
      </td>
    );
  }
  if (plan.kind === 'date') {
    /* An App says a near day from today and the rest as the date, the whole of it on hover (sayNearDay); the
       Workbench shows the data as it is, its stored form on hover. */
    const near = app ? sayNearDay(raw, Boolean(plan.showTime)) : null;
    const shown = near?.text ?? (plan.showTime ? formatDateTime(raw) : formatDate(raw));
    const title = near?.title ?? (shown === raw ? undefined : raw);
    return (
      <td className={`${classes.join(' ')}${pinClass}`} title={title} {...peek} {...pinAttrs}>
        {shown}
      </td>
    );
  }
  if (meta?.references) {
    return (
      <td className={`${classes.join(' ')}${pinClass}`} {...peek} {...pinAttrs}>
        <span className="ref" title={`→ ${meta.references.table}`}>
          {raw}
        </span>
      </td>
    );
  }
  /* In an App a vocabulary's value is a word (Value.tsx says why); the Workbench's grid shows the data. */
  if (shellBody().classList.contains('app-mode') && meta?.allowed?.includes(raw))
    return (
      <td className={`${classes.join(' ')}${pinClass}`} title={raw} {...pinAttrs}>
        {vocabularyWord(raw)}
      </td>
    );
  const cell = clampCell(raw);
  return (
    <td className={`${classes.join(' ')}${pinClass}`} title={cell.title} {...pinAttrs}>
      {cell.text}
    </td>
  );
}

/* A vocabulary column that says where a row stands, kept when a narrow grid leaves columns out. */
const STATUS_NAME = /(^|_)(status|state|stage|phase)$/i;

export function Grid({
  table,
  data,
  hide,
  labels,
  totals,
  totalsLabel = say('total'),
  density,
  referenceLabels,
  sizing = 'fit',
  interactive = true,
  virtual: mayVirtualise = true,
  onRowClick,
  list,
  current,
  emptyText,
  compact = false,
  firstRow = 0,
  dropColumns = false,
  editCell,
  adornCell,
}: GridProps) {
  const captionLanguage = useMessageLanguage();
  const wrap = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const rows = data.rows ?? NO_ROWS;
  const byName = useMemo(() => presentationColumns(state.schema, table, data.columns ?? []), [table, data.columns, state.schema]);
  /* The columns asked to be drawn; an embedded grid may leave out those past its width (`drawn`, below). */
  const asked = useMemo(
    () => (hide?.length ? (data.columns ?? []).filter((name) => !hide.includes(name)) : (data.columns ?? [])),
    [data.columns, hide?.join(',')], // eslint-disable-line react-hooks/exhaustive-deps
  );
  /* A second line is read from the row only where the row carries it: a
     subtitle the list did not fetch is left out rather than read from a
     column of the same name on another table. */
  const subtitleOf = (name: string, row: Row) => {
    const path = subtitlePath(columnDisplay(table?.id, name) as DisplayRule | null, name);
    return path && Object.hasOwn(row, path) ? row[path] : undefined;
  };
  const plans = useMemo(
    () =>
      new Map(
        asked.map((name) => [
          name,
          {
            ...planColumn(byName.get(name), name, rows),
            ...(referenceLabels?.[name] ? { align: 'left' } : {}),
            // A key the App names ('SO-{id}') is drawn as that name: text, read from the left.
            ...(table?.keyLabel && table.labelTemplate && byName.get(name)?.primaryKey ? { kind: 'text', align: 'left' } : {}),
          } as Plan,
        ]),
      ),
    [asked, byName, rows, referenceLabels, table],
  );
  /* Each row's identity: the string its host is published under and the key
     React keeps it by, so a refetch that reorders or drops rows moves the
     survivors instead of redrawing them. A row that cannot name itself — no
     key, a result that dropped a key column, a duplicate — is kept by
     position and has no host. */
  const keyed = Boolean(table && primaryKey(table).length && primaryKey(table).every((c: string) => (data.columns ?? []).includes(c)));
  const outerHosts = useRowHostScope();
  const [ownHosts] = useState(createRowHosts);
  const hosts = outerHosts ?? ownHosts;
  /* The trailing cell, drawn only when something around the grid asked to
     put a row's own menu there — and only on rows that can name themselves. */
  const trailHosts = useRowTrailScope();
  const rowKeys = useMemo(() => {
    if (!keyed) return rows.map(() => null);
    const seen = new Set<string>();
    return rows.map((row) => {
      const key = rowKeyString(table, row);
      if (key === null || seen.has(key)) return null;
      seen.add(key);
      return key;
    });
  }, [keyed, table, rows]);
  /* Rows another person just changed, tinted for a moment (liveState.ts, docs/design.md rule 11). */
  const changedRows = useChangedRows(table?.id, rows, (row) => (table ? (keyOf(table, row) as Record<string, unknown> | null) : null));
  const openable = useMemo(() => rowKeys.filter((key): key is string => key !== null), [rowKeys]);

  const virtual = mayVirtualise && rows.length > VIRTUAL_THRESHOLD;
  /* Not where rows open as pages: the expander is the explorer's way of
     seeing what points at a row, and an app's list gets that on the page
     the row opens as. Nor on a windowed table: an opened detail is many
     times a row's height, and the window's whole model is uniform rows. Nor
     on a result without the key: what points at a row is asked by its key,
     and a projection that dropped it has nothing to ask with. */
  const expandable = interactive && !prefersPages() && rows.length <= VIRTUAL_THRESHOLD && hasChildren(table) && keyed;
  /* The leading cell is each row's host (components/RowHost.tsx): drawn when
     the grid has an expander to put there, or when a presentation around
     the grid has asked to decorate its rows. */
  const slotted = expandable || Boolean(outerHosts);
  const shift = slotted ? 1 : 0;
  const trailing = Boolean(trailHosts) && keyed;
  const language = interactive && Boolean(table);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [headChar, setHeadChar] = useState(GRID_HEAD_CHAR);
  /* How a head sets its label (font, case, tracking), so a column is sized by the label as drawn and not by a
     count of its characters: seven pixels a character kept "Listed online" 125px wide at 1280, and the table
     that did not fit cut the last column off. */
  const [headFace, setHeadFace] = useState<{ font: string; upper: boolean; tracking: number } | null>(null);
  /* The fonts the first row's cells set in, one per cell, so a column is sized
     by what its words measure there rather than a count of their characters
     (gridSizing.ts). Per cell: a look sets the first column heavier, and
     measured in the others' weight its names ran past the width they got. */
  const [cellFonts, setCellFonts] = useState<string[]>([]);
  /* What a tone chip in the first row draws beyond its words, per cell (its dot, gap, padding): a look that says a
     status as a pill spends 41px there, one that says it as a dot and a word 12, and sizing every column for the
     wider kept 30px of every table's room in a status that never used it. -1: the cell holds no chip. */
  const [cellChips, setCellChips] = useState<number[]>([]);
  useLayoutEffect(() => {
    if (sizing !== 'fit' || !wrap.current) return;
    const element = wrap.current;
    /* The look says how wide its heads' characters set (gridSizing.ts); read
       again when the reader picks another look, which moves no width. */
    const measure = (contentWidth?: number) => {
      const style = getComputedStyle(element);
      /* clientWidth rounds up fractional layout widths. At density zoom that
         can create a one-screen-pixel scroll range even when scrollWidth and
         clientWidth agree. Preserve the fraction until fitGridColumns floors
         it; neither clip real overflow nor subtract space from column minima. */
      const inset =
        style.boxSizing === 'border-box'
          ? [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth].reduce(
              (sum, value) => sum + (parseFloat(value) || 0),
              0,
            )
          : 0;
      setAvailableWidth(contentWidth ?? Math.max(0, parseFloat(style.width) - inset));
      setHeadChar(parseFloat(style.getPropertyValue('--grid-head-char')) || GRID_HEAD_CHAR);
      const label = element.querySelector('thead th .th-sort');
      if (label) {
        const face = getComputedStyle(label);
        const next = {
          font: `${face.fontStyle} ${face.fontWeight} ${face.fontSize} ${face.fontFamily}`,
          upper: face.textTransform === 'uppercase',
          tracking: parseFloat(face.letterSpacing) || 0,
        };
        setHeadFace((was) => (was && was.font === next.font && was.upper === next.upper && was.tracking === next.tracking ? was : next));
      }
      const cells = [...element.querySelectorAll('tbody tr:first-child > td')];
      if (cells.length) {
        const fonts = cells.map((cell) => {
          const font = getComputedStyle(cell);
          return `${font.fontStyle} ${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
        });
        setCellFonts((was) => (was.join('|') === fonts.join('|') ? was : fonts));
        /* The widest chip of the sampled rows, not the first row's: a look may draw a neutral state as a bare word
           and the rest as pills, and sized by a first-row "Ready" Sage cut every "In review" pill to "In rev…". */
        const rows = [...element.querySelectorAll('tbody tr')].slice(0, GRID_SIZE_SAMPLE);
        const chips = cells.map((_, index) => {
          let extra = -1;
          for (const row of rows) {
            const chip = row.children[index]?.querySelector<HTMLElement>('.tone:not(.tone-figure)');
            const words = chip?.textContent?.trim();
            const said = words ? textMeasure(fonts[index])?.(words) : undefined;
            if (chip && said !== undefined) extra = Math.max(extra, Math.ceil(chip.offsetWidth - said));
          }
          return extra;
        });
        /* A row with no chip in the cell (a sort moved the empty ones to the top) keeps what was known: the
           columns must not move because of which row happens to be first. */
        setCellChips((was) => {
          const next = chips.map((extra, index) => (extra >= 0 ? extra : (was[index] ?? -1)));
          return was.join('|') === next.join('|') ? was : next;
        });
      }
    };
    measure();
    const observer = new ResizeObserver((entries) => measure(entries[0]?.contentRect.width));
    observer.observe(element);
    const themeChanged = () => measure();
    addHostListener(window, VISUAL_THEME_EVENT, themeChanged);
    return () => {
      observer.disconnect();
      removeHostListener(window, VISUAL_THEME_EVENT, themeChanged);
    };
  }, [sizing]);
  /* The column that names the row — the table's label where it is drawn,
     else the first text — is read whole before the others (gridSizing.ts). */
  const titleName = useMemo(() => {
    const naming = table ? namingColumn(table) : undefined;
    return naming && asked.includes(naming)
      ? naming
      : asked.find((name) => plans.get(name)?.kind === 'text' || Boolean(referenceLabels?.[name]));
  }, [table, asked, plans, referenceLabels]);
  const sizeHints = useMemo(
    () =>
      asked.map((name) => {
        const plan = plans.get(name)!;
        const labelColumn = referenceLabels?.[name];
        const display = centsAmong(
          columnDisplay(table?.id, name) as DisplayRule | null,
          rows.map((row) => row[name]),
        );
        const label = String(labels?.[name] ?? columnLabel(table?.id, name) ?? name);
        const headText = byName.get(name)?.primaryKey && !shell().inApp() ? `${label} ${say('common.key')}` : label;
        const headMeasure = headFace ? textMeasure(headFace.font) : undefined;
        const headSet = (text: string) => headMeasure!(headFace!.upper ? text.toUpperCase() : text) + headFace!.tracking * text.length;
        return {
          headWidth: headMeasure ? headSet(headText) : undefined,
          /* An App's head wraps to two lines before it widens its column (style.css, .th-label). */
          wrapHead: shell().inApp(),
          /* An App's words may wrap too, once its heads have and the room is still short: kept whole on two lines. */
          wrapValues: shell().inApp() && (Boolean(labelColumn) || plan.kind === 'text') && !display?.component,
          headWrap: headMeasure && shell().inApp() ? twoLineWidth(headText, headSet) : undefined,
          /* The head's key badge is words too, where it is drawn (an App hides it, features.css): once a
             number was sized by its figures, the Workbench's "id KEY ↓" lost its "id" under the badge. */
          label: byName.get(name)?.primaryKey && !shell().inApp() ? `${label} ${say('common.key')}` : label,
          title: name === titleName,
          avatar: Boolean(display?.avatar),
          chipExtra: (cellChips[asked.indexOf(name) + shift] ?? -1) >= 0 ? cellChips[asked.indexOf(name) + shift] : undefined,
          kind: labelColumn ? 'text' : plan.kind,
          controls: language || Boolean(byName.get(name)?.primaryKey || byName.get(name)?.references),
          showTime: plan.showTime,
          values: rows.slice(0, GRID_SIZE_SAMPLE).map((row) => {
            if (labelColumn && row[labelColumn] != null) return row[labelColumn];
            /* A tags cell keeps at least its first chip whole, and the count beside it (TagsCellList). */
            if (byName.get(name)?.type === TAGS_TYPE) {
              const chips = tagChips(row[name]);
              return chips.length
                ? `${chips[0]!.label}${chips.length > 1 ? ` ${say('moreTags', { count: chips.length - 1 })}` : ''}`
                : null;
            }
            const json = jsonValueOf(byName.get(name), row[name]);
            if (json) return previewOf(json.value);
            // Sized by what is drawn: a tone chip draws its label, a bare number its formatted figures.
            return drawnWords(display, plan, row[name]);
          }),
          subValues: display?.subtitle ? rows.slice(0, GRID_SIZE_SAMPLE).map((row) => subtitleOf(name, row)) : undefined,
          chip:
            byName.get(name)?.type === TAGS_TYPE ||
            (!labelColumn &&
              rows.slice(0, GRID_SIZE_SAMPLE).some((row) => {
                const dress = dressFor(display, row[name]);
                return dress?.kind === 'tone' && !dress.figure;
              })),
          /* A number with no rule is sized by the figures its cell draws ("1,249.50"), measured as they
             are; an App's own renderer draws something the words do not measure. */
          dressed:
            !labelColumn &&
            !display?.component &&
            rows.slice(0, GRID_SIZE_SAMPLE).every((row) => {
              if (row[name] == null) return true;
              const dress = dressFor(display, row[name]);
              return dress ? drawsWords(dress) : plan.kind === 'number' && numberShown(row[name], plan) != null;
            }),
          status:
            !labelColumn &&
            plan.kind !== 'number' &&
            (Boolean(display?.tone && !display.format && !display.bar) ||
              (Boolean(byName.get(name)?.allowed?.length) && STATUS_NAME.test(name))),
        };
      }),
    [asked, plans, referenceLabels, table?.id, labels, language, captionLanguage, byName, rows, titleName, headFace, cellChips, shift],
  );
  /* Column i's cell follows the expander's when there is one. */
  const measureText = useMemo(
    () =>
      cellFonts.length
        ? (text: string, column: number) =>
            textMeasure(cellFonts[Math.min(column + (slotted ? 1 : 0), cellFonts.length - 1)])?.(text) ?? text.length * 8
        : undefined,
    [cellFonts, slotted],
  );
  /* An App's own list folds the columns its room cannot hold under the row's name, as a detail line, once its heads
     and words have wrapped (gridSizing.ts): they are moved, not lost, and the list does not scroll sideways. An
     embedded grid leaves them out, as it did. */
  const folds = !dropColumns && sizing === 'fit' && shell().inApp();
  const kept = useMemo(
    () =>
      (dropColumns || folds) && sizing === 'fit' ? keepFitting(sizeHints, availableWidth, slotted, trailing, headChar, measureText) : null,
    [dropColumns, folds, sizing, sizeHints, availableWidth, slotted, trailing, headChar, measureText],
  );
  const drawn = useMemo(() => (kept ? asked.filter((_, index) => kept[index]) : asked), [asked, kept]);
  const drawnHints = useMemo(() => (kept ? sizeHints.filter((_, index) => kept[index]) : sizeHints), [sizeHints, kept]);
  const fit = useMemo(
    () => fitGridColumns(drawnHints, availableWidth, slotted, trailing, headChar, measureText, dropColumns),
    [drawnHints, availableWidth, slotted, trailing, headChar, measureText, dropColumns],
  );
  const columns = useMemo(
    () => helper.columns(drawn.map((name) => helper.accessor((row: Row) => row[name], { id: name, header: name }))),
    [drawn],
  );
  const model = useTable({ features, columns, data: rows });
  const modelRows = model.getRowModel().rows;
  /* In an App list the header's ⌄ is the App's short menu (AppColumnMenu.tsx), and the list's pins are its own. */
  const appMenu = useAppColumnMenu();
  const pinList = appMenu?.current?.listKey;
  const pinChange = useSyncExternalStore(subscribePins, pinsVersion);
  const pinned = useMemo(
    () => (interactive ? (pinnedFor(table, drawn, pinList) as string[]) : []),
    [interactive, table, drawn, pinList, pinChange],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const navigable = Boolean(onRowClick) || keyed;
  const query = currentEntry()?.query ?? '';

  /* The records on this page, and the list they are a page of when the room
     hands one (TableView): a record opened from this grid steps through the
     list past this page too (recordTrail.ts). An embedded grid hands its
     rows only. */
  const records = useMemo(
    () =>
      rows.flatMap((item) => {
        const itemKey = table && (keyOf(table, item) as Record<string, unknown> | null);
        return itemKey ? [{ key: itemKey, label: rowLabel(table, item) }] : [];
      }),
    [table, rows],
  );

  /* The record the reader is on beside this list — a split's detail — is
     marked, and brought into view as J and K step it along. */
  const currentKey = current && table ? rowKeyString(table, current) : null;
  useLayoutEffect(() => {
    if (currentKey === null) return;
    const rowNodes = tableRef.current?.querySelectorAll<HTMLElement>('tbody tr[data-row-key]') ?? [];
    [...rowNodes].find((node) => node.dataset.rowKey === currentKey)?.scrollIntoView?.({ block: 'nearest' });
  }, [currentKey]);

  const opens = useRowOpens();
  const openRow = useCallback(
    (row: Row) => {
      if (onRowClick) {
        onRowClick(row);
        return;
      }
      /* A row that opens what it is about opens that, with no neighbors to step to: they are rows of this list. */
      if (opens && table) {
        const target = rowOpensTarget(table, row, opens);
        if (target) void openRecord(target.table, target.key, target.label, 'push');
        return;
      }
      const key = table && (keyOf(table, row) as Record<string, unknown> | null);
      if (!key) return;
      void openRecord(table!.id, key, rowLabel(table, row), 'push', {
        records,
        list,
      });
    },
    [onRowClick, opens, table, records, list],
  );

  /* Space glances at the row's record without leaving the list (peekpanel.js), its neighbors a J or K away. */
  const peekRow = useCallback(
    (row: Row) => {
      if (opens && table) {
        const target = rowOpensTarget(table, row, opens);
        if (target) peekRecord(target.table, target.key, target.label);
        return;
      }
      const key = table && (keyOf(table, row) as Record<string, unknown> | null);
      if (key) peekRecord(table!.id, key, rowLabel(table, row), records, list);
    },
    [opens, table, records, list],
  );

  /* ---------- expansion ---------- */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [expandingAll, setExpandingAll] = useState(false);
  /* An open row stays open for as long as it is in the result. A sort or a
     page re-asks in place (core.js `refine`) and a refetch moves rows by key,
     so a row still on screen keeps its detail; one that left is forgotten,
     and coming back to it is coming back to a closed row. */
  useEffect(() => {
    setExpanded((s) => {
      const kept = new Set(openable.filter((key) => s.has(key)));
      return kept.size === s.size ? s : kept;
    });
  }, [openable]);
  const toggle = (key: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const anyClosed = openable.some((key) => !expanded.has(key));
  const expandAll = async () => {
    if (expandingAll) return;
    if (!anyClosed) {
      setExpanded(new Set());
      return;
    }
    /* A few at a time — the top of the table fills in immediately, the
       rest follows, and the database is never asked for everything at once. */
    setExpandingAll(true);
    try {
      for (let i = 0; i < openable.length; i += BATCH) {
        const batch = openable.slice(i, i + BATCH);
        setExpanded((s) => new Set([...s, ...batch]));
        if (i + BATCH < openable.length) await new Promise((r) => setTimeout(r, BREATH_MS));
      }
    } finally {
      setExpandingAll(false);
    }
  };

  /* ---------- windowing ---------- */
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [rowHeight, setRowHeight] = useState(26);
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    if (!virtual || !wrap.current) return;
    setScroller((wrap.current.closest('.content') as HTMLElement | null) ?? (document.scrollingElement as HTMLElement | null));
  }, [virtual]);
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scroller,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    scrollMargin: margin,
    enabled: virtual && Boolean(scroller),
  });
  const items = virtualizer.getVirtualItems();
  /* Measured from a rendered row rather than assumed: row height depends on
     font, zoom and content, and a wrong guess is wrong by a pixel per row —
     a scrollbar disagreeing with its content by a screenful. Sampled after
     each paint and corrected once the disagreement is real. */
  useLayoutEffect(() => {
    if (!virtual || !tableRef.current || !scroller) return;
    const sample = tableRef.current.querySelector('tbody tr[data-row]');
    const actual = sample ? viewportBox(sample).height : 0;
    if (actual && Math.abs(actual - rowHeight) >= 0.5) setRowHeight(actual);
    const top = tableRef.current.offsetTop;
    if (top !== margin) setMargin(top);
  });
  useEffect(() => {
    if (virtual) virtualizer.measure();
  }, [rowHeight, virtual]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = virtual ? items.map((it) => it.index) : rows.map((_, i) => i);
  const padTop = virtual && items.length ? items[0].start - margin : 0;
  const padBottom = virtual && items.length ? Math.max(0, rows.length - items[items.length - 1].index - 1) * rowHeight : 0;

  /* ---------- pins and the keyboard ---------- */
  const lefts = usePins(wrap, drawn, pinned, shift, `${shown.join(',')}:${sizing}:${fit.columns.join(',')}`);
  useStickyHead(wrap, `${drawn.join(',')}:${sizing}:${rows.length > 0}`);
  const lastPinned = pinned.length ? drawn.filter((n) => pinned.includes(n)).pop() : undefined;
  /* Read on every paint, as the cells always read them — an App's display
     rules can change under the grid — and kept while they are equal. */
  const folded = folds && kept ? asked.filter((_, index) => !kept[index]) : [];
  /* Under the row's name, unless that column is a short key ("AC-105"): a line folded into it wraps word by word and
     reads as part of the key. Then the widest column of plain words (not a state's chip), else the name after all. */
  const foldsInto = (() => {
    if (!folded.length) return undefined;
    const named = titleName && drawn.includes(titleName) ? titleName : drawn[0]!;
    const width = (name: string) => fit.columns[drawn.indexOf(name)] ?? 0;
    if (width(named) >= FOLD_ROOM) return named;
    const words = drawn.filter(
      (name) =>
        (plans.get(name)?.kind === 'text' || Boolean(referenceLabels?.[name])) &&
        !(columnDisplay(table?.id, name) as DisplayRule | null)?.tone,
    );
    return words.reduce((best, name) => (width(name) > width(best) ? name : best), named);
  })();
  const cellColumns = useKeptColumns(
    drawn.map((name) => {
      /* A column of money says its cents only where one of its figures has some (centsAmong). */
      const display = centsAmong(
        columnDisplay(table?.id, name) as DisplayRule | null,
        rows.map((row) => row[name]),
      );
      return {
        name,
        meta: byName.get(name),
        plan: plans.get(name)!,
        display,
        label: referenceLabels?.[name],
        subtitle: subtitlePath(display, name),
        ...(currencyPath(display, name) ? { currency: currencyPath(display, name) } : {}),
        ...(leadTonePath(display, name)
          ? {
              leadTone: {
                path: leadTonePath(display, name)!,
                rule: columnDisplay(table?.id, leadTonePath(display, name)!) as DisplayRule | null,
              },
            }
          : {}),
        photoOwner: avatarOwner(table, name, display, data.columns),
        pin: lefts.get(name),
        edge: name === lastPinned,
        ...(fit.wraps[drawn.indexOf(name)] ? { wraps: true } : {}),
        ...(name === foldsInto
          ? {
              more: folded.map((other) => ({
                name: other,
                head: String(labels?.[other] ?? columnLabel(table?.id, other) ?? other),
                meta: byName.get(other),
                plan: plans.get(other)!,
                display: centsAmong(
                  columnDisplay(table?.id, other) as DisplayRule | null,
                  rows.map((row) => row[other]),
                ),
                label: referenceLabels?.[other],
              })),
            }
          : {}),
        ...(table?.keyLabel && table.labelTemplate && byName.get(name)?.primaryKey ? { named: table.labelTemplate } : {}),
      };
    }),
  );
  const photoColumns = useMemo(() => cellColumns.filter((column) => column.photoOwner), [cellColumns]);
  /* One callback for every row and every paint: the one it calls is read
     when a row is opened, so a caller's fresh onRowClick redraws nothing. */
  const opener = useRef(openRow);
  opener.current = openRow;
  const openOne = useCallback((row: Row) => opener.current(row), []);
  useGridKeyboard(tableRef, wrap, {
    rowCount: rows.length,
    columnCount: drawn.length,
    offset: shift,
    onOpen: navigable ? (index) => openRow(rows[index]) : undefined,
    onPeek: keyed ? (index) => peekRow(rows[index]) : undefined,
    totalRows: data.exactTotal === false || data.cappedTotal ? undefined : data.total,
    firstRow,
  });

  /* Whatever the column clipped gets its whole value on hover, decided at hover time, once, from its own overflow:
     the cell, or the line inside it that cuts its own text (a row's name over its detail, a lead mark's body, a
     component's text), which the cell never sees overflow. A long summary ended in "…" with no way to read it (G210). */
  const onMouseOver = (e: React.MouseEvent) => {
    if (!(e.target instanceof Element)) return;
    const td = e.target.closest('td') as HTMLTableCellElement | null;
    if (!td) return;
    for (let at: Element | null = e.target; at; at = at === td ? null : at.parentElement) {
      if (at instanceof HTMLElement && at.title) return;
      if (at.scrollWidth > at.clientWidth) {
        (at as HTMLElement).title = at.textContent ?? '';
        return;
      }
    }
  };

  if (!rows.length && !(emptyText && data.columns?.length)) {
    /* "No rows match" claims a filter did it. On `customer` with no
       conditions, nothing was excluded — the table is empty, which is a
       different thing to be told. */
    const entry = currentEntry();
    const filtered = !entry || entry.kind !== 'table' || entry.query.trim() !== entry.table || Boolean(data.errors?.length);
    return (
      <div className={`table-wrap${compact ? ' grid-compact' : ''}`} ref={wrap}>
        <p className="note">{filtered ? say('noRowsMatch') : say('thisTableIsEmpty')}</p>
      </div>
    );
  }

  const inApp = shell().inApp();
  const header = (name: string) => {
    const meta = byName.get(name);
    const plan = plans.get(name)!;
    /* Sorting from the header is offered only on columns the database can
       sort cheaply: indexed, or small enough that it does not matter. Over an
       API, only on the columns its documented sort values name (`sortable`). */
    const sortable = table
      ? table.sortable
        ? table.sortable.includes(name)
        : !table.indexed || table.indexed.includes(name) || sortableFromHeader(table)
      : false;
    const explicit = language ? (sortDirection(query, name) as 'asc' | 'desc' | null) : null;
    const implied = !explicit && data.order?.implicit ? (data.order.order.find((o) => o.column === name)?.direction ?? null) : null;
    const sorted = explicit ?? implied;
    const pin = lefts.get(name);
    return (
      <th
        key={name}
        scope="col"
        className={`align-${plan.align}${explicit ? ' sorted' : ''}${implied ? ' sorted-default' : ''}${pin !== undefined ? ` pinned${name === lastPinned ? ' pinned-edge' : ''}` : ''}`}
        style={pin !== undefined ? { left: `${pin}px` } : undefined}
        aria-sort={explicit ? (explicit === 'desc' ? 'descending' : 'ascending') : undefined}
        title={
          implied
            ? `${meta ? `${meta.type} · ` : ''}${say('defaultOrderRowsHaveToCome')}`
            : meta?.type
              ? `${meta.type}${meta.nullable ? '' : ' NOT NULL'}`
              : name
        }
      >
        <span className="th-controls">
          <button
            type="button"
            className={`th-sort${language && !sortable ? ' not-sortable' : ''}`}
            aria-disabled={!language || !sortable}
            /* An App has no statement to edit and no query bar to type into: its words say what is so. */
            title={
              !language
                ? say(inApp ? 'notSortableHere' : 'sortingAResultLike', {
                    name,
                  })
                : sortable
                  ? say('sortBy', { name })
                  : table?.sortable
                    ? say('theApiDocumentsNoSort', { name })
                    : say(inApp ? 'isNotIndexedSortingInApp' : 'isNotIndexedSorting', { name })
            }
            onClick={(e) => {
              if (!language || !sortable) return;
              if (e.shiftKey) sortBy(name, sortDirection(currentEntry()?.query ?? '', name) === 'asc' ? 'desc' : 'asc', true);
              else sortBy(name);
            }}
          >
            <span className="th-label">{labels?.[name] ?? columnLabel(table?.id, name) ?? name}</span>
            {meta?.primaryKey && <span className="pk">{say('common.key')}</span>}
            {meta?.references && <span className="fk">→</span>}
            {sorted && <span className="th-arrow">{sorted === 'desc' ? '↓' : '↑'}</span>}
          </button>
          {language && appMenu && (
            <AppColumnMenuButton
              host={appMenu}
              name={name}
              label={labels?.[name] ?? columnLabel(table?.id, name) ?? name}
              kind={plan.kind}
              meta={meta}
              sortable={sortable}
              current={sorted}
              columns={drawn}
              drawnBy={referenceLabels?.[name]}
            />
          )}
          {/* Over an API, only where it documents a filter (`filterable`): a menu the source refuses is a control that lies. */}
          {language && !appMenu && (!table?.filterable || table.filterable.includes(name)) && (
            <button
              type="button"
              className="th-filter"
              title={say('filterOn', { name })}
              aria-label={say('filterOn', { name })}
              onClick={(e) => {
                e.stopPropagation();
                openFilterMenu(e.currentTarget, meta, name, rows, plan);
              }}
            >
              <span className="th-filter-icon" aria-hidden="true" />
            </button>
          )}
        </span>
      </th>
    );
  };

  const colSpan = drawn.length + shift + (trailing ? 1 : 0);
  return (
    <div className={`table-wrap${compact ? ' grid-compact' : ''}${density === 'compact' ? ' grid-dense' : ''}`} ref={wrap}>
      <table
        ref={tableRef}
        onMouseOver={onMouseOver}
        className={sizing === 'fit' ? 'grid-fit' : undefined}
        style={sizing === 'fit' ? { width: fit.width } : undefined}
      >
        {sizing === 'fit' && (
          <colgroup>
            {slotted && <col style={{ width: GRID_EXPANDER_WIDTH }} />}
            {drawn.map((name, index) => (
              <col key={name} style={{ width: fit.columns[index] }} />
            ))}
            {trailing && <col style={{ width: GRID_TRAIL_WIDTH }} />}
          </colgroup>
        )}
        <thead>
          <tr>
            {slotted && (
              <th className="expander-cell row-host" ref={hosts.headRef}>
                {expandable && !virtual && (
                  <button
                    type="button"
                    className={`expander expand-all${expandingAll ? ' working' : ''}`}
                    title={anyClosed ? say('expandEveryRow') : say('collapseEveryRow')}
                    aria-label={anyClosed ? say('expandEveryRow') : say('collapseEveryRow')}
                    aria-expanded={!anyClosed}
                    onClick={(e) => {
                      e.stopPropagation();
                      void expandAll();
                    }}
                  >
                    {anyClosed ? '▸' : '▾'}
                  </button>
                )}
              </th>
            )}
            {drawn.map(header)}
            {trailing && (
              <th className="row-trail">
                <span className="visually-hidden">{say('actions')}</span>
              </th>
            )}
          </tr>
        </thead>
        {(() => {
          const body = (
            <tbody>
              {virtual && (
                <tr className="virtual-spacer" aria-hidden="true">
                  <td
                    colSpan={colSpan}
                    style={{
                      height: `${padTop}px`,
                      padding: 0,
                      border: 'none',
                    }}
                  />
                </tr>
              )}
              {shown.map((i) => {
                const row = modelRows[i];
                if (!row) return null;
                const key = rowKeys[i];
                const open = expandable && key !== null && expanded.has(key);
                return (
                  <Row
                    key={key === null ? `at:${i}` : `key:${key}`}
                    index={i}
                    rowKey={key}
                    slot={slotted}
                    hostRef={key === null ? undefined : hosts.ref(key)}
                    trail={trailing}
                    trailRef={key === null || !trailHosts ? undefined : trailHosts.ref(key)}
                    record={row.original}
                    navigable={navigable}
                    opensPage={navigable && !onRowClick && !opens}
                    onOpen={openOne}
                    open={open}
                    current={key !== null && key === currentKey}
                    changed={changedRows.get(row.original)}
                    table={table}
                    colSpan={colSpan}
                    columns={cellColumns}
                    editCell={editCell}
                    adornCell={adornCell}
                  />
                );
              })}
              {virtual && (
                <tr className="virtual-spacer" aria-hidden="true">
                  <td
                    colSpan={colSpan}
                    style={{
                      height: `${padBottom}px`,
                      padding: 0,
                      border: 'none',
                    }}
                  />
                </tr>
              )}
            </tbody>
          );
          return photoColumns.length ? (
            <AvatarPhotos columns={photoColumns} rows={rows}>
              {body}
            </AvatarPhotos>
          ) : (
            body
          );
        })()}
        {totals && rows.length > 0 && (
          <tfoot>
            <tr className="grid-totals">
              {slotted && <td className="expander-cell" />}
              {drawn.map((name, index) => {
                if (!Object.hasOwn(totals, name))
                  return <td key={name}>{index === 0 && <span className="grid-totals-label">{totalsLabel}</span>}</td>;
                return (
                  <td key={name} className="align-right num">
                    <TotalValue
                      value={totals[name]}
                      display={centsAmong(columnDisplay(table?.id, name) as DisplayRule | null, [
                        ...rows.map((row) => row[name]),
                        totals[name],
                      ])}
                    />
                  </td>
                );
              })}
              {trailing && <td />}
            </tr>
          </tfoot>
        )}
      </table>
      {/* The first decoration: the expander, declared here beside the table
          and portalled into each row's leading cell — the same place and the
          same button it always was, now drawn from outside the row. */}
      {expandable &&
        openable.map((key) => (
          <RowDecoration key={key} rowKey={key} store={hosts}>
            <Expander open={expanded.has(key)} onToggle={() => toggle(key)} />
          </RowDecoration>
        ))}
      {virtual && <p className="note virtual-note">{say('rowsDrawnAsYouScroll', { count: rows.length })}</p>}
      {!rows.length && <p className="note grid-empty">{emptyText}</p>}
    </div>
  );
}

/**
 * One row, and its detail row when it is open. The leading cell, when the
 * grid draws one, is the row's host: React never gives it children of its
 * own, so what a decoration portals there is left alone by every repaint.
 */
const Row = memo(function Row({
  index,
  rowKey,
  slot,
  hostRef,
  trail = false,
  trailRef,
  record,
  navigable,
  opensPage = false,
  onOpen,
  open,
  current = false,
  changed,
  table,
  colSpan,
  columns,
  editCell,
  adornCell,
}: {
  index: number;
  rowKey: string | null;
  slot: boolean;
  hostRef?: RowHostRef;
  trail?: boolean;
  trailRef?: RowHostRef;
  record: Row;
  navigable: boolean;
  onOpen: (row: Row) => void;
  open: boolean;
  /** The row opens its record (not a caller's own click): a press on it begins reading the record's page (recordCompose.ts). */
  opensPage?: boolean;
  /** The record shown beside the list (a split's detail). */
  current?: boolean;
  /** Another person's change to this row, just announced: which of two tints it wears. */
  changed?: 1 | 2;
  table: TableMeta | undefined;
  colSpan: number;
  columns: CellColumn[];
  editCell?: GridProps['editCell'];
  adornCell?: GridProps['adornCell'];
}) {
  const photoOf = useContext(AvatarPhotoContext);
  /* A click inside a dialog one of its cells opened reaches the row through
     React's tree, not the page's: only a click on the row opens it. */
  const row = (
    <tr
      className={
        `${navigable ? 'clickable' : ''}${open ? ' expanded' : ''}${current ? ' is-current' : ''}${changed ? ` row-changed-${changed}` : ''}`.trim() ||
        undefined
      }
      aria-current={current ? 'true' : undefined}
      data-row={index}
      data-row-key={rowKey ?? undefined}
      data-opens={opensPage && table ? opensRecord(table.id, keyOf(table, record)) : undefined}
      onClick={
        navigable
          ? (e) => {
              if (e.currentTarget.contains(e.target as Node)) onOpen(record);
            }
          : undefined
      }
    >
      {slot && <td className="expander-cell row-host" ref={hostRef} />}
      {columns.map((column) => (
        <Cell
          key={column.name}
          meta={column.meta}
          plan={column.plan}
          value={column.named ? keyName(column.named, record[column.name]) : record[column.name]}
          label={column.label ? record[column.label] : undefined}
          display={column.display}
          pin={column.pin}
          edge={column.edge}
          wraps={column.wraps}
          more={column.more ? foldedOf(column.more, record) : undefined}
          sub={column.subtitle && Object.hasOwn(record, column.subtitle) ? record[column.subtitle] : undefined}
          currency={column.currency ? record[column.currency] : undefined}
          open={(column.display as DisplayRule | null)?.format === 'relative' && dueOpen(table?.id, column.name, record) ? true : undefined}
          lead={leadOf(column, record)}
          name={column.name}
          editCell={editCell}
          adornCell={adornCell}
          record={editCell || adornCell ? record : undefined}
          photo={column.photoOwner ? photoOf(column.name, record[column.photoOwner]) : undefined}
          row={column.display?.component ? record : undefined}
          table={table?.id}
        />
      ))}
      {trail && <td className="row-trail" ref={trailRef} />}
    </tr>
  );
  if (!open || !table) return row;
  return (
    <>
      {row}
      {/* Its grids publish nowhere: a presentation decorating this grid must
          never find a nested row under one of its keys. */}
      <RowHostScope store={null}>
        <RowTrailScope store={null}>
          <DetailRow table={table} row={record} colSpan={colSpan} grid={Grid} />
        </RowTrailScope>
      </RowHostScope>
    </>
  );
});
