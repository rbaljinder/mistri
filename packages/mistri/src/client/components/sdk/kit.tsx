/**
 * The kit a custom component draws with: the platform's own pieces, dressed
 * in the classes every look already dresses, so a component reads as part of
 * the App in all three looks, light and dark, without a colour of its own.
 *
 * Each takes explicit props. The column a `Value` belongs to and how its App
 * dresses it come from the host (context.ts), never from the walk's globals,
 * so the same piece draws in the page and in a component's tests. Layout
 * follows docs/design.md: one box, never a box in a box (a `Card` inside a
 * `Card` draws as a plain group); the 20px field gap and the 40px section
 * seam as `Stack`'s two gaps; a tone is a dot and its word.
 */
import {
  Children,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { AppIconName } from '@mistriwork/engine/shared/appIcons.js';
import { Icon as PlatformIcon } from '@mistriwork/kit/client/components/Icon.js';
import { Empty as PlatformEmpty, Problem } from '@mistriwork/kit/client/components/Notes.js';
import { Dressed, Said } from '@mistriwork/kit/client/components/Dressed.js';
import { authoredDisplay, dressFor, type DisplayRule } from '@mistriwork/kit/client/components/valueModel.js';
import { useQuery } from '@tanstack/react-query';
import { useHostIfAny, useUiHost } from './context.js';
/* Named apart: `say` is also Sparkline's prop below, a figure's speaker. */
import { say as sayKit } from '../../copy/components/components/sdk/kit.js';
import { Sparkline, StackedColumns } from '@mistriwork/kit/client/components/Chart.js';

export { Button } from '@mistriwork/ui/Button.js';
export { Dropdown } from '@mistriwork/kit/client/components/Dropdown.js';
export { SplitListDetail } from '../SplitListDetail.js';

type Gap = 'tight' | 'field' | 'section';
const GAPS: Record<Gap, string> = { tight: 'kit-gap-tight', field: 'kit-gap-field', section: 'kit-gap-section' };

const InCard = createContext(false);

/** A slot that was given something: `0` is a count, and `null`, `false` and `undefined` are a slot left empty. */
const given = (slot: ReactNode): boolean => slot !== undefined && slot !== null && slot !== false;

/**
 * One box: a hairline and the surface. A card inside a card is a plain group, as design.md's refusal list asks.
 * `count` (a quiet number beside the title) and `action` (right-aligned in the same row) turn the title into a header
 * row; with neither it is the heading alone. `ground="nav"` is the box on the look's navigation ground (see
 * `data-ground` in kit.css): everything the kit draws inside it takes that ground's inks.
 * The title is an h3 unless `level` says another: a page of the App's own has the platform's h1 above it, and an
 * h3 straight under it skips a level of the outline (WCAG 1.3.1), so a card that is a section of the page is `level={2}`.
 */
export function Card({
  title,
  level = 3,
  count,
  action,
  ground,
  children,
  className,
}: {
  title?: ReactNode;
  level?: 2 | 3 | 4;
  count?: ReactNode;
  action?: ReactNode;
  ground?: 'nav';
  children?: ReactNode;
  className?: string;
}) {
  const nested = useContext(InCard);
  const classes = [nested ? 'kit-group' : 'kit-card', className].filter(Boolean).join(' ');
  const Tag = `h${level}` as 'h2' | 'h3' | 'h4';
  const heading = title !== undefined && <Tag className="kit-card-title">{title}</Tag>;
  return (
    <div className={classes} {...(ground ? { 'data-ground': ground } : {})}>
      {given(count) || given(action) ? (
        <div className="kit-card-head">
          {heading}
          {given(count) && <span className="kit-card-count">{count}</span>}
          {given(action) && <span className="kit-card-action">{action}</span>}
        </div>
      ) : (
        heading
      )}
      <InCard.Provider value={true}>{children}</InCard.Provider>
    </div>
  );
}

/** Children one under another, a field's 20px apart (default), a section's 40px, or tight. */
export function Stack({
  gap = 'field',
  as: Tag = 'div',
  children,
  className,
}: {
  gap?: Gap;
  as?: 'div' | 'ul' | 'ol';
  children?: ReactNode;
  className?: string;
}) {
  return <Tag className={['kit-stack', GAPS[gap], className].filter(Boolean).join(' ')}>{children}</Tag>;
}

/** Children side by side, wrapping onto a new line where there is no room. `foot` says the row is the page's actions
    at the screen's foot (a sticky row of verbs on a phone): a notice stands above it, as above a record's bar, and
    never over the verbs it reports on. */
export function Row({
  gap = 'field',
  align = 'center',
  foot,
  children,
  className,
}: {
  gap?: Gap;
  align?: 'start' | 'center' | 'baseline' | 'end';
  foot?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={['kit-row', GAPS[gap], `kit-align-${align}`, className].filter(Boolean).join(' ')}
      {...(foot ? { 'data-foot-actions': '' } : {})}
    >
      {children}
    </div>
  );
}

/** Children in a grid of equal columns as wide as `min` where there is room, fewer where there is not: it wraps, and
    never scrolls sideways. A card or a stat that should sit three across at a desk and stack on a phone, with no
    breakpoint written. `min` is a CSS length (`'16rem'` by default); a column is never wider than the box itself. */
export function Cluster({
  min = '16rem',
  gap = 'field',
  children,
  className,
}: {
  min?: string;
  gap?: Gap;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={['kit-cluster', GAPS[gap], className].filter(Boolean).join(' ')} style={{ '--kit-cluster-min': min } as CSSProperties}>
      {children}
    </div>
  );
}

/**
 * A main column beside a rail: the page's content and the notes, filters or facts that go with it. The main takes what
 * the rail leaves (`minmax(0, 1fr)`) and the rail is `railWidth` wide (a CSS length, `'20rem'` by default, and never
 * past half the box). `side` says which edge the rail stands at. Where the box itself is too narrow for both it stacks,
 * the main first and the rail under it, and it never scrolls sideways. Cluster makes equal columns; this makes two
 * unequal ones.
 */
export function Beside({
  rail,
  railWidth = '20rem',
  side = 'end',
  children,
  className,
}: {
  rail: ReactNode;
  railWidth?: string;
  side?: 'start' | 'end';
  children?: ReactNode;
  className?: string;
}) {
  return (
    /* The host is the container the stacking asks about, so the grid inside it can change with it. */
    <div className="kit-beside-host">
      <div
        className={['kit-beside', side === 'start' && 'kit-beside-start', className].filter(Boolean).join(' ')}
        style={{ '--kit-beside-rail': railWidth } as CSSProperties}
      >
        <div className="kit-beside-main">{children}</div>
        <div className="kit-beside-rail">{rail}</div>
      </div>
    </div>
  );
}

/**
 * A line of words: `<Text tone="muted" size="sm">Not shared with your role.</Text>`. The default is the page's ink; `muted`
 * is its secondary ink, for a note or a caption; `danger` is the status colour for a refusal or a failure. It stands
 * in a Card or on the page and sets no layout of its own.
 */
export function Text({
  tone = 'default',
  size = 'md',
  children,
}: {
  tone?: 'default' | 'muted' | 'danger';
  size?: 'sm' | 'md';
  children?: ReactNode;
}) {
  return (
    <p className={['kit-text', tone === 'default' ? '' : `kit-text-${tone}`, size === 'sm' ? 'kit-text-sm' : ''].filter(Boolean).join(' ')}>
      {children}
    </p>
  );
}

/**
 * Words only a screen reader hears: a count's unit, the "opens in a new tab" a link's icon implies, a heading a sighted
 * reader has no use for. It is clipped, not `display: none`, so it stays in the accessibility tree and the page's
 * tab order and layout never see it. A page that wrote its own clip rule for this can drop it.
 */
export function VisuallyHidden({ children }: { children?: ReactNode }) {
  return <span className="kit-visually-hidden">{children}</span>;
}

/** A heading inside a section: the section's own title is its h2, so this is an h3 by default. */
export function Heading({ level = 3, children, className }: { level?: 3 | 4; children?: ReactNode; className?: string }) {
  const Tag = level === 4 ? 'h4' : 'h3';
  return <Tag className={['kit-heading', className].filter(Boolean).join(' ')}>{children}</Tag>;
}

export type ToneName = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

/** A meaning as the looks say one: a dot and its word. Earned, like a display rule's tone. */
export function Tone({ tone, children }: { tone: ToneName; children?: ReactNode }) {
  return <span className={`tone tone-${tone}`}>{children}</span>;
}

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
  display,
  compact = false,
}: {
  value: unknown;
  resource?: string;
  column?: string;
  display?: Omit<DisplayRule, 'bar' | 'max'> & { bar?: boolean | number };
  compact?: boolean;
}) {
  const host = useUiHost();
  const known = resource && column ? host.column(resource, column) : undefined;
  if (value === null || value === undefined || value === '') return <span className="null">—</span>;
  const rule = authoredDisplay(display) ?? known?.rule ?? null;
  const dress = dressFor(rule, value);
  if (dress) return <Dressed dress={dress} compact={compact} />;
  /* A reference holds its record's key; the lists say the record's name, so a column named here does too. */
  const target = known?.meta?.references?.table;
  if (target && display === undefined && (typeof value === 'string' || typeof value === 'number'))
    return (
      <ReferenceName resource={target} value={value} fallback={<Said col={known?.meta} value={value} compact={compact} app={host.app} />} />
    );
  return <Said col={known?.meta} value={value} compact={compact} app={host.app} />;
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

/** A share of a whole as a bar and its figure: `value` against `max` (100 by default), in a tone when it means something. */
export function Meter({ value, max = 100, tone, label }: { value: number; max?: number; tone?: ToneName; label?: ReactNode }) {
  const fill = max > 0 && Number.isFinite(value) ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const style: CSSProperties = { width: `${fill}%` };
  return (
    <span
      className={`meter-wrap${tone ? ` meter-${tone}` : ''}`}
      role="meter"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={typeof label === 'string' ? label : undefined}
    >
      <span className="pct-bar">
        <span className="pct-fill" style={style} />
      </span>
      {label !== undefined && <span className="num-value">{label}</span>}
    </span>
  );
}

/** What a component says when it has nothing to draw: the platform's own quiet note. */
export function Empty({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return <PlatformEmpty text={title} detail={description} action={action} />;
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
 * (at `height`, the size the drawing will take, so nothing under it moves when it lands), `Empty` for no rows or no
 * record (`empty`, or the house sentence), and the house problem with Try again when it could not be read — focus on
 * Try again when the drawing it replaced held it, so focus is never dropped. Then `children(data)`, the App's own.
 * What was read stays drawn when a later refresh fails: a finished screen is never swapped for a note. Domain states
 * ("not eligible", "unavailable") are the App's to draw inside it.
 */
export function Loaded<T>({
  query,
  empty,
  height,
  children,
}: {
  query: LoadedQuery<T>;
  empty?: ReactNode;
  height?: number | string;
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
      <div ref={note} className="kit-loaded">
        <Problem text={query.error?.message || sayKit('notRead')} retry={() => void query.refetch()} />
      </div>
    );
  if (query.data === undefined && query.refused) return <>{empty ?? <Empty title={sayKit('nothingHereYet')} />}</>;
  if (query.data === undefined)
    return (
      <div
        className="sk-bar kit-loading"
        role="status"
        aria-label={sayKit('common.loading')}
        {...(height === undefined ? {} : { style: { blockSize: height } })}
      />
    );
  if (query.data === null || (Array.isArray(query.data) && query.data.length === 0))
    return <>{empty ?? <Empty title={sayKit('nothingHereYet')} />}</>;
  return <>{children(query.data as NonNullable<T>)}</>;
}

/** One of the App's curated marks (the names a view's `icon` takes). Decoration unless it has a label. */
export function Icon({ name, label, size }: { name: AppIconName; label?: string; size?: number | string }) {
  return <PlatformIcon name={name} label={label} size={size} />;
}

/**
 * A segmented control: a few exclusive choices said as one row of words, the
 * chosen one filled in the look's tab dress — a filter's All / Needs attention,
 * a range's 7 d / 30 d. A choice may carry a count, a pill beside its word.
 * One target: arrows move the choice, as a radio group's do. Past four or five
 * choices it is a Dropdown's job. A value no option carries leaves every one unchosen (the first stays the tab stop).
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  size = 'default',
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode; count?: number; name?: string }>;
  onChange(value: T): void;
  size?: 'default' | 'compact';
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const at = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const key = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    const next = step
      ? (index + step + options.length) % options.length
      : event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : -1;
    if (next < 0) return;
    event.preventDefault();
    onChange(options[next].value);
    buttons.current[next]?.focus();
  };
  return (
    <div className={`kit-segmented${size === 'compact' ? ' kit-segmented-compact' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={index === at ? 0 : -1}
          aria-label={option.name}
          ref={(node) => {
            buttons.current[index] = node;
          }}
          className="kit-segment"
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => key(event, index)}
        >
          <span>{option.label}</span>
          {option.count !== undefined && <span className="kit-segment-count">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * A figure and what it counts, as a dashboard's stat card says one: the
 * figure, its label, its change against the period before (in the tone of
 * the news where the caller knows which way is good) and, from four points,
 * its trend. As tall as what it says, so a strip of them stands from one edge.
 */
export function Stat({
  label,
  value,
  change,
  trend,
  say = String,
}: {
  label: ReactNode;
  value: ReactNode;
  change?: { text: ReactNode; tone?: ToneName };
  trend?: ReadonlyArray<number | { key: string; value: number }>;
  say?: (value: unknown) => string;
}) {
  const points = (trend ?? []).map((point, index) => (typeof point === 'number' ? { key: String(index), value: point } : point));
  /* In a Card it is a figure in that box, not a box in a box (as a Card in a Card is a plain group). */
  const nested = useContext(InCard);
  return (
    <div className={nested ? 'kit-stat kit-stat-plain' : 'kit-stat'}>
      <span className="kit-stat-label">{label}</span>
      {/* The trend rides beside the figure, so a Stat with none is the same height as one with. */}
      <span className="kit-stat-row">
        <span className="kit-stat-figure">{value}</span>
        {points.length >= 4 && (
          <span className={`spark-host kit-stat-spark${change?.tone === 'good' ? ' good' : change?.tone === 'bad' ? ' bad' : ''}`}>
            <Sparkline rows={points} say={say} />
          </span>
        )}
      </span>
      {change && <span className={`kit-stat-change${change.tone ? ` kit-stat-${change.tone}` : ''}`}>{change.text}</span>}
    </div>
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
  say,
  height,
}: {
  rows: ReadonlyArray<{ key: string; values: Record<string, number> }>;
  series: ReadonlyArray<{ key: string; label: string }>;
  say?: (value: unknown) => string;
  height?: number;
}) {
  return (
    <div className="kit-columns">
      <StackedColumns rows={[...rows]} series={[...series]} say={say} high={height} />
    </div>
  );
}

export interface TableColumn<Row> {
  /** The row's field this column reads, and the key a sort names. */
  key: string;
  label: ReactNode;
  align?: 'left' | 'right';
  /** Dress the cell as this resource's column is dressed (money, a tone, a relative day), as `Value` does. */
  resource?: string;
  column?: string;
  display?: ComponentProps<typeof Value>['display'];
  /** Draw the cell yourself; the value, its dress and the row link are then yours. */
  render?: (row: Row) => ReactNode;
  /** Left out of the sort even where the table sorts. */
  sortable?: boolean;
}

/**
 * Whether a box scrolls sideways right now. Such a box is a Tab stop and has a name (WCAG 2.1.1; axe
 * scrollable-region-focusable): a keyboard reader cannot reach what is off the edge of a box they cannot focus. It is
 * so only while it scrolls — a table that fits adds no stop to the page — and only attributes change, so nothing moves.
 */
function useScrolls() {
  const box = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const measure = () => setScrolls(node.scrollWidth > node.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(measure);
    watch.observe(node);
    if (node.firstElementChild) watch.observe(node.firstElementChild);
    return () => watch.disconnect();
  }, []);
  return { box, scrolls };
}

/**
 * Rows the component read, in the look's own table: the head, the hairlines and the row hover are the platform's,
 * and each cell is a `Value`, so a column dressed in the App is dressed here. Sorting is the caller's, as its rows
 * are: a head is a button once `onSort` is given, and the table says which way it stands; it never reorders what it
 * was handed. With `onRowClick` the first cell is the row's link (one target for the keyboard) and the whole row
 * answers a pointer.
 */
export function Table<Row extends Record<string, unknown>>({
  label,
  columns,
  rows,
  rowKey,
  sort,
  onSort,
  onRowClick,
  empty,
}: {
  /** What the table is, for assistive technology: a table of rows has no heading of its own. */
  label: string;
  columns: ReadonlyArray<TableColumn<Row>>;
  rows: ReadonlyArray<Row>;
  rowKey?: (row: Row, index: number) => string | number;
  sort?: { key: string; direction: 'asc' | 'desc' };
  onSort?: (key: string) => void;
  onRowClick?: (row: Row) => void;
  /** Said under the head when there are no rows. */
  empty?: ReactNode;
}) {
  const { box, scrolls } = useScrolls();
  return (
    <div ref={box} className="table-wrap kit-table" {...(scrolls ? { role: 'region', tabIndex: 0, 'aria-label': label } : {})}>
      <table aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => {
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
              {columns.map((column, at) => {
                const drawn = column.render ? (
                  column.render(row)
                ) : (
                  <Value value={row[column.key]} resource={column.resource} column={column.column} display={column.display} compact />
                );
                return (
                  <td key={column.key} className={`align-${column.align ?? 'left'}${typeof row[column.key] === 'number' ? ' num' : ''}`}>
                    {onRowClick && at === 0 ? (
                      <button
                        type="button"
                        className="kit-table-link"
                        onClick={(event) => {
                          // The row's own click is the pointer's; this one is the keyboard's, and must not run it twice.
                          event.stopPropagation();
                          onRowClick(row);
                        }}
                      >
                        {drawn}
                      </button>
                    ) : (
                      drawn
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && empty !== undefined && <div className="kit-table-empty">{empty}</div>}
    </div>
  );
}

/** Rows of a list with no head row: a lead, a title, a quiet note and an action each. `label` names the list for
    assistive technology; `empty` stands in its place when there are no `Item`s. */
export function Items({
  label,
  empty,
  children,
  className,
}: {
  label?: string;
  empty?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  /* In a Card the rows are that box's, not a box in a box: no inset of their own, as a Stat in a Card is plain. */
  const nested = useContext(InCard);
  if (Children.toArray(children).length === 0) return given(empty) ? <div className="kit-items-empty">{empty}</div> : null;
  return (
    <ul className={['kit-items', nested && 'kit-items-flush', className].filter(Boolean).join(' ')} aria-label={label}>
      {children}
    </ul>
  );
}

/**
 * One row of `Items`. `lead` is a slot before the text (an icon, an avatar, a `Value`), `title` the row's words, `note`
 * one quiet line under it and `action` a slot at the row's end (buttons, a menu, a `Value`). With `href` or `onClick`
 * the title is the row's one link or button (a single target for the keyboard) and the whole row answers a pointer,
 * as a table's rows do; a click inside `action` is the action's own and never opens the row.
 */
export function Item({
  lead,
  title,
  note,
  action,
  href,
  onClick,
}: {
  lead?: ReactNode;
  title: ReactNode;
  note?: ReactNode;
  action?: ReactNode;
  href?: string;
  onClick?: () => void;
}) {
  const host = useHostIfAny();
  const target = useRef<HTMLAnchorElement & HTMLButtonElement>(null);
  const interactive = href !== undefined || onClick !== undefined;
  /* An address in this App is followed in place, as `useNavigate` does: a plain `<a>` would load the whole page again.
     A modified or middle click keeps the browser's own meaning (a new tab, a download), and so does another origin. */
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.();
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!host || href === undefined || !href.startsWith('/') || href.startsWith('//')) return;
    event.preventDefault();
    host.follow(href);
  };
  const words =
    href !== undefined ? (
      <a ref={target} className="kit-item-target" href={href} onClick={follow}>
        {title}
      </a>
    ) : onClick ? (
      <button ref={target} type="button" className="kit-item-target" onClick={onClick}>
        {title}
      </button>
    ) : (
      title
    );
  return (
    <li
      className={`kit-item${interactive ? ' kit-item-clickable' : ''}`}
      /* The pointer's click is the target's own, run once: one that began in the target already is. */
      onClick={interactive ? (event) => void (target.current?.contains(event.target as Node) || target.current?.click()) : undefined}
    >
      {given(lead) && <span className="kit-item-lead">{lead}</span>}
      <span className="kit-item-body">
        <span className="kit-item-title">{words}</span>
        {given(note) && <span className="kit-item-note">{note}</span>}
      </span>
      {given(action) && (
        <span className="kit-item-action" onClick={(event) => event.stopPropagation()}>
          {action}
        </span>
      )}
    </li>
  );
}
