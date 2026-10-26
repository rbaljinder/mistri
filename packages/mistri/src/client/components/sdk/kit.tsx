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
import { createContext, useContext, useRef, type ComponentProps, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { AppIconName } from '@mistriwork/engine/shared/appIcons.js';
import { Icon as PlatformIcon } from '@mistriwork/kit/client/components/Icon.js';
import { Empty as PlatformEmpty } from '@mistriwork/kit/client/components/Notes.js';
import { Dressed, Said } from '@mistriwork/kit/client/components/Dressed.js';
import { authoredDisplay, dressFor, type DisplayRule } from '@mistriwork/kit/client/components/valueModel.js';
import { useUiHost } from './context.js';
import { Sparkline, StackedColumns } from '@mistriwork/kit/client/components/Chart.js';

export { Button } from '@mistriwork/ui/Button.js';
export { Dropdown } from '@mistriwork/kit/client/components/Dropdown.js';
export { SplitListDetail } from '../SplitListDetail.js';

type Gap = 'tight' | 'field' | 'section';
const GAPS: Record<Gap, string> = { tight: 'kit-gap-tight', field: 'kit-gap-field', section: 'kit-gap-section' };

const InCard = createContext(false);

/** One box: a hairline and the surface. A card inside a card is a plain group, as design.md's refusal list asks. */
export function Card({ title, children, className }: { title?: ReactNode; children?: ReactNode; className?: string }) {
  const nested = useContext(InCard);
  const classes = [nested ? 'kit-group' : 'kit-card', className].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      {title !== undefined && <h3 className="kit-card-title">{title}</h3>}
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

/** Children side by side, wrapping onto a new line where there is no room. */
export function Row({
  gap = 'field',
  align = 'center',
  children,
  className,
}: {
  gap?: Gap;
  align?: 'start' | 'center' | 'baseline' | 'end';
  children?: ReactNode;
  className?: string;
}) {
  return <div className={['kit-row', GAPS[gap], `kit-align-${align}`, className].filter(Boolean).join(' ')}>{children}</div>;
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
  return <Said col={known?.meta} value={value} compact={compact} app={host.app} />;
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

/** One of the App's curated marks (the names a view's `icon` takes). Decoration unless it has a label. */
export function Icon({ name, label, size }: { name: AppIconName; label?: string; size?: number | string }) {
  return <PlatformIcon name={name} label={label} size={size} />;
}

/**
 * A segmented control: a few exclusive choices said as one row of words, the
 * chosen one filled in the look's tab dress — a filter's All / Needs attention,
 * a range's 7 d / 30 d. A choice may carry a count, a pill beside its word.
 * One target: arrows move the choice, as a radio group's do. Past four or five
 * choices it is a Dropdown's job.
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
          aria-checked={index === at}
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
  return (
    <div className="kit-stat">
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
  return (
    <div className="table-wrap kit-table">
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
