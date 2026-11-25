/**
 * Mistri's schema-aware and collection kit pieces (`@mistriwork/mistri/ui`): `<Value>`, `<Loaded>`, `<Icon>`, `<Tile>`,
 * `<Columns>` and `<Table>`. Shared layout, typography, display, feedback, chart and view primitives live in
 * `@mistriwork/ui` and connect to the App host through `seam.tsx`.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type MouseEvent, type ReactNode, type Ref } from 'react';
import type { AppIconName } from '@mistriwork/engine/shared/appIcons.js';
import { Avatar, isEmptyStateSpec, useInCard, type EmptyStateSpec, type Tone } from '@mistriwork/ui';
import { EmptyState, StatusDot } from '@mistriwork/ui/primitives.js';
import { Icon as PlatformIcon } from '@mistriwork/kit/client/components/Icon.js';
import { Problem } from '@mistriwork/kit/client/components/Notes.js';
import { Dressed, Said } from '@mistriwork/kit/client/components/Dressed.js';
import { rowCurrency } from '@mistriwork/engine/shared/money.js';
import { authoredDisplay, dressFor, maskedText, type DisplayRule } from '@mistriwork/kit/client/components/valueModel.js';
import { CopyValue } from '@mistriwork/kit/client/components/CopyValue.js';
import { StackedColumns } from '@mistriwork/kit/client/components/Chart.js';
import { useQuery } from '@tanstack/react-query';
import { useFollow, useHostIfAny, useUiHost, type UiHost } from './context.js';
import { say as sayKit } from '../../copy/components/components/sdk/kit.js';

export { useInCard };

/** A slot that was given something: `0` is a count, and `null`, `false` and `undefined` are a slot left empty. */
const given = (slot: ReactNode): boolean => slot !== undefined && slot !== null && slot !== false;

/**
 * A value, drawn as the App draws it: name the resource and the column and
 * its display rule dresses it (money, a tone, a relative day), or pass
 * `display` to say one here. An id past 2^53 arrives as a string and keeps
 * every digit; nothing here runs it through Number().
 */
export function Value({
  value,
  resource,
  column,
  row,
  display,
  compact = false,
  className,
}: {
  value: unknown;
  resource?: string;
  column?: string;
  row?: Readonly<Record<string, unknown>>;
  display?: Omit<DisplayRule, 'bar' | 'max'> & { bar?: boolean | number };
  compact?: boolean;
  className?: string;
}) {
  const host = useUiHost();
  const known = resource && column ? host.column(resource, column) : undefined;
  const baseRule = authoredDisplay(display) ?? known?.rule ?? null;
  if (value === null || value === undefined || value === '') {
    return <span className={className ? `null ${className}` : 'null'}>{baseRule?.empty ?? '—'}</span>;
  }
  const rule =
    baseRule?.currencyColumn && row
      ? { ...baseRule, currency: rowCurrency(baseRule, row, baseRule.currency ?? '') || undefined }
      : baseRule;
  const inner = <DrawnValue value={value} rule={rule} known={known} authored={display !== undefined} compact={compact} />;
  const drawn = rule?.face ? <span className={`face-${rule.face}`}>{inner}</span> : inner;
  /* A rule's `copy` is the record's copy button (CopyValue), never for a value a mask hides. */
  if (!rule?.copy || maskedText(rule, value) !== undefined) {
    return className ? <span className={className}>{drawn}</span> : drawn;
  }
  return (
    <CopyBeside value={value} label={known?.label ?? column ?? sayKit('aValue')} className={className}>
      {drawn}
    </CopyBeside>
  );
}

function DrawnValue({
  value,
  rule,
  known,
  authored,
  compact,
}: {
  value: unknown;
  rule: DisplayRule | null;
  known: ReturnType<UiHost['column']>;
  authored: boolean;
  compact: boolean;
}) {
  const host = useUiHost();
  const dress = dressFor(rule, value);
  if (dress) return <Dressed dress={dress} compact={compact} />;
  /* A reference holds its record's key; the lists say the record's name, so a column named here does too. */
  const target = known?.meta?.references?.table;
  if (target && !authored && (typeof value === 'string' || typeof value === 'number'))
    return (
      <ReferenceName resource={target} value={value} fallback={<Said col={known?.meta} value={value} compact={compact} app={host.app} />} />
    );
  return <Said col={known?.meta} value={value} compact={compact} app={host.app} />;
}

/** What makes an element a target of its own: a value inside one gets no copy button, since a button in a link or a
    row that opens is neither (the record's Value says the same through its `links`). `.clickable` is the Table's row
    under `onRowClick`. Not any `[tabindex]`: a table that scrolls is a focusable region, and not a target. */
const TARGET =
  'a[href], button, summary, label, .clickable, [role="button"], [role="link"], [role="option"], [role="menuitem"], [role="tab"]';

/**
 * The value and its copy button, the record's markup. A component cannot say whether its caller drew it inside a
 * target, so the page is asked: the button is added before the first paint where no ancestor is one, and never drawn
 * inside one, not even for a frame.
 */
function CopyBeside({ value, label, className, children }: { value: unknown; label: string; className?: string; children: ReactNode }) {
  const host = useUiHost();
  const box = useRef<HTMLSpanElement>(null);
  const [free, setFree] = useState(false);
  useLayoutEffect(() => {
    setFree(!box.current?.parentElement?.closest(TARGET));
  }, []);
  return (
    <span className={className ? `value-copyable ${className}` : 'value-copyable'} ref={box}>
      {children}
      {free && <CopyValue value={value} label={label} announce={(text, tone) => host.announce(text, tone)} />}
    </span>
  );
}

/**
 * The name of the record a reference column holds, read as the platform's pickers read one (the host's `choiceName`:
 * under the reader's grants), kept in the page's cache so a column of one record is one read. It holds the key's place
 * while it arrives, so the row does not move, and says the key where the record is not the reader's to read.
 */
function ReferenceName({ resource, value, fallback }: { resource: string; value: string | number; fallback: ReactNode }) {
  const host = useUiHost();
  const named = useQuery({
    queryKey: ['mistri-ui', 'reference-name', ...host.scope, resource, value],
    queryFn: () => host.choiceName({ resource }, value).catch(() => null),
    retry: false,
  });
  if (named.isPending) return <span style={{ opacity: 0 }}>{fallback}</span>;
  return named.data ? <span className="prose">{named.data.label}</span> : fallback;
}

/** What `<Loaded>` reads of a read: a hook's query (`useRows`, `useRecord`, `useBreakdown`) as it stands. */
interface LoadedQuery<T> {
  data: T | undefined;
  isError: boolean;
  error: Error | null;
  refetch(): unknown;
  /** An `optional: true` read the reader was refused: drawn as `empty`, never as a failure or a wait. */
  refused?: boolean;
}

/**
 * A read's states before its drawing, said as every section says them: the platform's placeholder while it is asked
 * (at `height`, the size the drawing will take, so nothing under it moves when it lands, or what `loading` draws in its
 * place: a `Skeleton` shaped like the drawing), `EmptyState` for no rows or no record (`empty`, or the house sentence;
 * `empty={null}` draws nothing), and the house problem with Try again when it could not be read — focus on
 * Try again when the drawing it replaced held it, so focus is never dropped. Then `children(data)`, the App's own.
 * What was read stays drawn when a later refresh fails: a finished screen is never swapped for a note. Domain states
 * ("not eligible", "unavailable") are the App's to draw inside it.
 */
export function Loaded<T>({
  query,
  empty,
  loading,
  height,
  className,
  children,
}: {
  query: LoadedQuery<T>;
  empty?: ReactNode;
  loading?: ReactNode;
  height?: number | string;
  className?: string;
  children: (data: NonNullable<T>) => ReactNode;
}) {
  const failed = query.data === undefined && query.isError;
  const note = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The placeholder holds no focus; a drawing that did and went (a refresh that failed once its rows were dropped) left it on the body.
    if (!failed) return;
    const at = document.activeElement;
    if (at === null || at === document.body) note.current?.querySelector<HTMLElement>('.problem-retry')?.focus({ preventScroll: true });
  }, [failed]);
  if (failed)
    return (
      <div ref={note} className={className ? `kit-loaded ${className}` : 'kit-loaded'}>
        <Problem text={query.error?.message || sayKit('notRead')} retry={() => void query.refetch()} />
      </div>
    );
  /* `empty={null}` says draw nothing; only an `empty` left out is the house sentence. */
  const nothing = empty === undefined ? <EmptyState title={sayKit('nothingHereYet')} /> : empty;
  if (query.data === undefined && query.refused) return className ? <div className={className}>{nothing}</div> : <>{nothing}</>;
  if (query.data === undefined && loading !== undefined)
    return (
      <div className={className} role="status" aria-label={sayKit('common.loading')}>
        {loading}
      </div>
    );
  if (query.data === undefined)
    return (
      <div
        className={className ? `sk-bar kit-loading ${className}` : 'sk-bar kit-loading'}
        role="status"
        aria-label={sayKit('common.loading')}
        {...(height === undefined ? {} : { style: { blockSize: height } })}
      />
    );
  if (query.data === null || (Array.isArray(query.data) && query.data.length === 0)) {
    return className ? <div className={className}>{nothing}</div> : <>{nothing}</>;
  }
  const content = children(query.data as NonNullable<T>);
  return className ? <div className={className}>{content}</div> : <>{content}</>;
}

/** One of the App's curated marks (the names a view's `icon` takes). Decoration unless it has an accessible label. */
export function Icon({
  name,
  label,
  ariaLabel,
  size,
  className,
}: {
  name: AppIconName;
  label?: string;
  ariaLabel?: string;
  size?: number | string;
  className?: string;
}) {
  return <PlatformIcon name={name} label={label} ariaLabel={ariaLabel} size={size} className={className} />;
}

/**
 * A card that is one control: a button with `onClick`, a link with `href` (an address of this App is followed in
 * place), toggled with `selected`. Its children are whatever the card holds, so they must not be controls of their
 * own. It is a card to the eye (the card's corner and lift, not a control's), which is why it says `data-slot="tile"`
 * and not a button's, so the platform's control rules leave it its own box.
 */
export function Tile({
  onClick,
  href,
  selected,
  disabled,
  ariaLabel,
  children,
  className,
  ref,
  ...rest
}: {
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  href?: string;
  selected?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  children?: ReactNode;
  className?: string;
  ref?: Ref<HTMLElement>;
} & Omit<ComponentProps<'button'>, 'onClick' | 'children' | 'type' | 'className' | 'disabled' | 'aria-label' | 'ref'>) {
  const follow = useFollow(href, onClick);
  const classes = `kit-tile${className ? ` ${className}` : ''}`;
  const state = {
    'data-slot': 'tile',
    'data-selected': selected ? '' : undefined,
    'data-disabled': disabled ? '' : undefined,
    ...(ariaLabel !== undefined ? { 'aria-label': ariaLabel } : {}),
  };
  if (href !== undefined && !disabled)
    return (
      <a
        {...(rest as unknown as ComponentProps<'a'>)}
        ref={ref as Ref<HTMLAnchorElement>}
        {...state}
        className={classes}
        href={href}
        aria-current={selected ? 'true' : undefined}
        onClick={follow}
      >
        {children}
      </a>
    );
  return (
    <button
      {...rest}
      ref={ref as Ref<HTMLButtonElement>}
      {...state}
      type="button"
      className={classes}
      disabled={disabled}
      aria-pressed={selected === undefined ? undefined : selected}
      onClick={(event) => onClick?.(event)}
    >
      {children}
    </button>
  );
}

/**
 * Columns over periods (or any keys), each divided by series: Tracked and
 * Business events a day, say. Levels on the left, periods along the bottom,
 * the current column's parts in a pill over it, and a legend of the series.
 */
export function Columns({
  rows,
  series,
  formatValue,
  height,
  className,
}: {
  rows: ReadonlyArray<{ key: string; values: Record<string, number> }>;
  series: ReadonlyArray<{ key: string; label: string }>;
  formatValue?: (value: unknown) => string;
  height?: number;
  className?: string;
}) {
  return (
    <div className={className ? `kit-columns ${className}` : 'kit-columns'}>
      <StackedColumns rows={[...rows]} series={[...series]} say={formatValue} high={height} />
    </div>
  );
}

export interface TableColumn<Row> {
  /** The row's field this column reads, and the key a sort names. */
  key: string;
  label: ReactNode;
  align?: 'left' | 'right';
  /** Semantic tone applied to non-empty cells in this column when no custom `display` or `render` is provided. */
  tone?: Tone;
  /** Dress the cell as this resource's column is dressed (money, a tone, a relative day), as `Value` does. */
  resource?: string;
  column?: string;
  display?: ComponentProps<typeof Value>['display'];
  /** Draw the cell yourself; the value, its dress and the row link are then yours. */
  render?: (row: Row) => ReactNode;
  /** Left out of the sort even where the table sorts. */
  sortable?: boolean;
  /** A second, quieter line under the value: a row field's key, or a function of the row. Never bold, and it wraps. */
  secondary?: string | ((row: Row) => ReactNode);
  /** Whether the primary line is emphasized. The first column's is `'strong'` unless said; any other column's is `'normal'`. */
  emphasis?: 'strong' | 'normal';
  /** A copy button beside the cell, a sibling of the row link (never inside it), copying the field as stored. */
  copy?: boolean;
  /**
   * A person's or a thing's disc before the lines: a row field's key holding the picture's address (the name is the
   * cell's value), or a function of the row. Without a picture the disc says the name's initials.
   */
  avatar?: string | ((row: Row) => { name: string; src?: string });
}

const textOf = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/** A row's face: a field holding the picture's address under the cell's own value as the name, or the column's function. */
function faceOf<Row extends Record<string, unknown>>(
  avatar: string | ((row: Row) => { name: string; src?: string }),
  row: Row,
  key: string,
): { name: string; src?: string } {
  if (typeof avatar === 'function') return avatar(row);
  const src = textOf(row[avatar]);
  return { name: textOf(row[key]), ...(src ? { src } : {}) };
}

/**
 * How many of a table's last columns fold into its first cell, and whether the box still scrolls sideways after
 * that. A table never scrolls where it can fold (docs/design.md, Standing layout rules): the columns past the room's
 * edge leave the head, last first, and are said as a quiet detail line under the first cell, as an App's list folds
 * on a phone. The fold is decided before the paint (a layout effect re-renders until it fits), and redone from none
 * when the box's width changes, so a wider room takes its columns back.
 *
 * A box that still scrolls once everything that can fold has (one column wider than a phone) is a Tab stop and has a
 * name (WCAG 2.1.1; axe scrollable-region-focusable): a keyboard reader cannot reach what is off the edge of a box
 * they cannot focus. It is so only while it scrolls, and only attributes change, so nothing moves.
 */
function useTableFold(count: number) {
  const box = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState(0);
  const [scrolls, setScrolls] = useState(false);
  const [, setPass] = useState(0);
  const width = useRef(-1);
  // After every render, not on a list of inputs: the rows usually arrive after the first paint, and what they hold
  // is what overflows. One read of two widths; it settles because a fold only grows while the box overflows.
  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const over = node.scrollWidth > node.clientWidth + 1;
    if (over && folded < count - 1) {
      setFolded(folded + 1);
      return;
    }
    setScrolls(over);
  });
  useEffect(() => {
    const node = box.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    width.current = node.clientWidth;
    // The room's width changing starts the fold again from none; the table's own size changing (a font arriving, a
    // value drawn late) only measures again.
    const watch = new ResizeObserver(() => {
      if (node.clientWidth !== width.current) {
        width.current = node.clientWidth;
        setFolded(0);
      }
      setPass((at) => at + 1);
    });
    watch.observe(node);
    const table = node.querySelector('table');
    if (table) watch.observe(table);
    return () => watch.disconnect();
  }, []);
  return { box, folded, scrolls };
}

/**
 * Rows the component read, in the look's own table: the head, the hairlines and the row hover are the platform's,
 * and each cell is a `Value`, so a column dressed in the App is dressed here. Sorting is the caller's, as its rows
 * are: a head is a button once `onSort` is given, and the table says which way it stands; it never reorders what it
 * was handed. With `onRowClick` the first cell is the row's link (one target for the keyboard) and the whole row
 * answers a pointer.
 */
export function Table<Row extends Record<string, unknown>>({
  ariaLabel,
  label,
  columns,
  rows,
  rowKey,
  sort,
  onSort,
  onRowClick,
  empty,
  className,
}: {
  /** What the table is, for assistive technology: a table of rows has no heading of its own. */
  ariaLabel?: string;
  label?: string;
  columns: ReadonlyArray<TableColumn<Row>>;
  rows: ReadonlyArray<Row>;
  rowKey?: (row: Row, index: number) => string | number;
  sort?: { key: string; direction: 'asc' | 'desc' };
  onSort?: (key: string) => void;
  onRowClick?: (row: Row) => void;
  /** Said under the head when there are no rows. */
  empty?: EmptyStateSpec | ReactNode;
  className?: string;
}) {
  const tableLabel = ariaLabel ?? label;
  const { box, folded, scrolls } = useTableFold(columns.length);
  const host = useHostIfAny();
  const shown = folded ? columns.slice(0, columns.length - folded) : columns;
  const tucked = folded ? columns.slice(columns.length - folded) : [];
  const cellOf = (column: TableColumn<Row>, row: Row) => {
    if (column.render) return column.render(row);
    const raw = row[column.key];
    const valueNode = <Value value={raw} resource={column.resource} column={column.column} display={column.display} compact />;
    if (column.tone && column.display === undefined && raw !== null && raw !== undefined && raw !== '') {
      return <StatusDot tone={column.tone}>{valueNode}</StatusDot>;
    }
    return valueNode;
  };
  const emptyNode: ReactNode = isEmptyStateSpec(empty) ? (
    <EmptyState title={empty.title} description={empty.body} action={empty.action} />
  ) : (
    empty
  );
  return (
    <div
      ref={box}
      className={className ? `table-wrap kit-table ${className}` : 'table-wrap kit-table'}
      {...(scrolls ? { role: 'region', tabIndex: 0, 'aria-label': tableLabel } : {})}
    >
      <table aria-label={tableLabel}>
        <thead>
          <tr>
            {shown.map((column) => {
              const align = column.align ?? 'left';
              const sorted = sort?.key === column.key ? sort.direction : undefined;
              const sortable = Boolean(onSort) && column.sortable !== false;
              return (
                <th
                  key={column.key}
                  className={`align-${align}${sorted ? ' sorted' : ''}`}
                  aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {sortable ? (
                    <button type="button" className="th-sort" onClick={() => onSort?.(column.key)}>
                      {column.label}
                      {sorted && <span aria-hidden="true">{sorted === 'asc' ? ' ↑' : ' ↓'}</span>}
                    </button>
                  ) : (
                    <span className="th-sort not-sortable">{column.label}</span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={rowKey ? rowKey(row, index) : index}
              className={onRowClick ? 'clickable' : undefined}
              onClick={onRowClick && (() => onRowClick(row))}
            >
              {shown.map((column, at) => {
                const drawn = cellOf(column, row);
                const second =
                  typeof column.secondary === 'function'
                    ? column.secondary(row)
                    : column.secondary === undefined
                      ? undefined
                      : row[column.secondary];
                const strong = (column.emphasis ?? (at === 0 ? 'strong' : 'normal')) === 'strong';
                /* One target: both lines sit inside the link, and the weight is the primary line's alone. */
                const text = (
                  <>
                    <span className={`kit-cell-primary${strong ? ' kit-cell-primary-strong' : ''}`}>{drawn}</span>
                    {given(second as ReactNode) && second !== '' && <span className="kit-cell-secondary">{second as ReactNode}</span>}
                    {at === 0 && tucked.length > 0 && (
                      <span className="kit-cell-secondary kit-cell-folded">
                        {tucked.map((other) => (
                          <span key={other.key} className="kit-cell-fold">
                            <span className="visually-hidden">{other.label}: </span>
                            {cellOf(other, row)}
                          </span>
                        ))}
                      </span>
                    )}
                  </>
                );
                const face = column.avatar === undefined ? undefined : faceOf(column.avatar, row, column.key);
                /* The disc is inside the one target too, and hidden: the name beside it is what is read. */
                const lines = face ? (
                  <span className="kit-cell-identity">
                    <span className="kit-cell-avatar" aria-hidden="true">
                      <Avatar name={face.name} src={face.src} size="sm" />
                    </span>
                    <span className="kit-cell-lines">{text}</span>
                  </span>
                ) : (
                  text
                );
                const stored = row[column.key];
                const copyable = column.copy && stored !== null && stored !== undefined && stored !== '';
                const target =
                  onRowClick && at === 0 ? (
                    <button
                      type="button"
                      className="kit-table-link"
                      onClick={(event) => {
                        // The row's own click is the pointer's; this one is the keyboard's, and must not run it twice.
                        event.stopPropagation();
                        onRowClick(row);
                      }}
                    >
                      {lines}
                    </button>
                  ) : (
                    lines
                  );
                return (
                  <td key={column.key} className={`kit-cell align-${column.align ?? 'left'}${typeof stored === 'number' ? ' num' : ''}`}>
                    {copyable ? (
                      <span className="kit-cell-copyable">
                        {target}
                        <CopyValue
                          value={stored}
                          label={typeof column.label === 'string' ? column.label : column.key}
                          announce={(text, tone) => host?.announce(text, tone)}
                        />
                      </span>
                    ) : (
                      target
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && emptyNode !== undefined && <div className="kit-table-empty">{emptyNode}</div>}
    </div>
  );
}
