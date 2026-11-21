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
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { AppIconName } from '@mistriwork/engine/shared/appIcons.js';
import type { DISPLAY_TONES } from '@mistriwork/engine/shared/model.js';
import { Button as UiButton, ButtonLink } from '@mistriwork/ui/Button.js';
import { Icon as PlatformIcon } from '@mistriwork/kit/client/components/Icon.js';
import { Empty as PlatformEmpty, Problem } from '@mistriwork/kit/client/components/Notes.js';
import { Dressed, Said } from '@mistriwork/kit/client/components/Dressed.js';
import { authoredDisplay, dressFor, maskedText, type DisplayRule } from '@mistriwork/kit/client/components/valueModel.js';
import { CopyValue } from '@mistriwork/kit/client/components/CopyValue.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { PHONE_QUERY, useMediaQuery } from '@mistriwork/kit/client/components/useMediaQuery.js';
import { useQuery } from '@tanstack/react-query';
import { formatMoney, formatNumber, formatPercent } from '@mistriwork/kit/client/locale.js';
import { useHostIfAny, useUiHost, type UiHost } from './context.js';
/* Named apart: `say` is also Sparkline's prop below, a figure's speaker. */
import { say as sayKit } from '../../copy/components/components/sdk/kit.js';
import { Sparkline as ChartSparkline, StackedColumns } from '@mistriwork/kit/client/components/Chart.js';

export { Dropdown } from '@mistriwork/kit/client/components/Dropdown.js';
export { SplitListDetail } from '../SplitListDetail.js';

type Gap = 'tight' | 'field' | 'section';
const GAPS: Record<Gap, string> = { tight: 'kit-gap-tight', field: 'kit-gap-field', section: 'kit-gap-section' };

/* Inside a kit Card: whether that Card names its own title and at which level, so a page part drawn in it knows to
   drop its own frame and, where the Card names none, to give its title as the Card's head (blocks.tsx). */
type CardFrame = false | { titled: boolean; level: 2 | 3 | 4 };
const InCard = createContext<CardFrame>(false);

/** The kit Card a part is drawn in, if any: its title's presence and level. */
export const useInCard = (): CardFrame => useContext(InCard);

/** A slot that was given something: `0` is a count, and `null`, `false` and `undefined` are a slot left empty. */
const given = (slot: ReactNode): boolean => slot !== undefined && slot !== null && slot !== false;

/**
 * One box: a hairline and the surface. A card inside a card is a plain group, as design.md's refusal list asks.
 * `count` (a quiet number beside the title) and `action` (right-aligned in the same row) turn the title into a header
 * row; with neither it is the heading alone. `ground="nav"` is the box on the look's navigation ground (see
 * `data-ground` in kit.css): everything the kit draws inside it takes that ground's inks.
 * `description` is one quiet line under the title (what the part holds), and `tone` says the title in a status ink
 * (a part about trouble). The title is an h3 unless `level` says another: a page of the App's own has the platform's h1 above it, and an
 * h3 straight under it skips a level of the outline (WCAG 1.3.1), so a card that is a section of the page is `level={2}`.
 */
export function Card({
  title,
  level = 3,
  count,
  action,
  description,
  tone,
  ground,
  children,
  className,
}: {
  title?: ReactNode;
  level?: 2 | 3 | 4;
  count?: ReactNode;
  action?: ReactNode;
  description?: ReactNode;
  tone?: ToneName;
  ground?: 'nav';
  children?: ReactNode;
  className?: string;
}) {
  const nested = useContext(InCard);
  const classes = [nested ? 'kit-group' : 'kit-card', className].filter(Boolean).join(' ');
  const Tag = `h${level}` as 'h2' | 'h3' | 'h4';
  const heading = title !== undefined && (
    <Tag className={['kit-card-title', tone && `kit-card-title-${tone}`].filter(Boolean).join(' ')}>{title}</Tag>
  );
  return (
    <div className={classes} {...(ground ? { 'data-ground': ground } : {})}>
      {given(count) || given(action) ? (
        <div className="kit-card-head">
          {heading}
          {given(count) && <span className="kit-card-count">{count}</span>}
          {given(action) && <span className="kit-card-action">{action}</span>}
        </div>
      ) : (
        <>{heading}</>
      )}
      {given(description) && <p className="kit-card-description">{description}</p>}
      <InCard.Provider value={{ titled: title !== undefined, level }}>{children}</InCard.Provider>
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
 * the main first and the rail under it, and it never scrolls sideways. `stackBelow` (a CSS length, `'40rem'` by
 * default) is the box width under which it stacks: a rail that wants more room than the default says so. Cluster makes equal columns; this makes two
 * unequal ones.
 */
export function Beside({
  rail,
  railWidth = '20rem',
  side = 'end',
  stackBelow,
  children,
  className,
}: {
  rail: ReactNode;
  railWidth?: string;
  side?: 'start' | 'end';
  stackBelow?: string;
  children?: ReactNode;
  className?: string;
}) {
  /* A container query cannot read a custom property, so a width of the author's is a rule of its own, held to a plain
     length so nothing else can ride in with it. */
  const mark = `kit-beside-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const stacks = stackBelow !== undefined && /^\d+(\.\d+)?(rem|em|px|ch)$/.test(stackBelow.trim()) ? stackBelow.trim() : undefined;
  return (
    /* The host is the container the stacking asks about, so the grid inside it can change with it. */
    <div className="kit-beside-host">
      {stacks && (
        <style>{`@container kit-beside (max-width: ${stacks}) { .${mark} > .kit-beside-main, .${mark} > .kit-beside-rail { flex-basis: 100%; } }`}</style>
      )}
      <div
        className={['kit-beside', side === 'start' && 'kit-beside-start', stacks && mark, className].filter(Boolean).join(' ')}
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

/* The display rule's tones, by the one list: a page that names a column's tone names it as the rule did. */
export type ToneName = (typeof DISPLAY_TONES)[number];

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
  const drawn = <DrawnValue value={value} rule={rule} known={known} authored={display !== undefined} compact={compact} />;
  /* A rule's `copy` is the record's copy button (CopyValue), never for a value a mask hides. */
  if (!rule?.copy || maskedText(rule, value) !== undefined) return drawn;
  return (
    <CopyBeside value={value} label={known?.label ?? column ?? sayKit('aValue')}>
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
function CopyBeside({ value, label, children }: { value: unknown; label: string; children: ReactNode }) {
  const host = useUiHost();
  const box = useRef<HTMLSpanElement>(null);
  const [free, setFree] = useState(false);
  useLayoutEffect(() => {
    setFree(!box.current?.parentElement?.closest(TARGET));
  }, []);
  return (
    <span className="value-copyable" ref={box}>
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

/**
 * A share of a whole as a bar and its figure: `value` against `max` (100 by default), in a tone when it means something.
 * `ariaLabel` names the meter (what it measures, "Seats taken") where its `label` is not a string, or says other words
 * than the figure; `valueLabel` is the value as a screen reader says it ("12 of 40 seats") in place of a bare number.
 * `size="fluid"` stretches the bar across the width it is given (a card's row, a table's column) in place of the short
 * bar beside a figure.
 */
export function Meter({
  value,
  max = 100,
  tone,
  label,
  ariaLabel,
  valueLabel,
  size,
}: {
  value: number;
  max?: number;
  tone?: ToneName;
  label?: ReactNode;
  ariaLabel?: string;
  valueLabel?: string;
  size?: 'fluid';
}) {
  const fill = max > 0 && Number.isFinite(value) ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const style: CSSProperties = { width: `${fill}%` };
  return (
    <span
      className={['meter-wrap', tone && `meter-${tone}`, size === 'fluid' && 'meter-fluid'].filter(Boolean).join(' ')}
      role="meter"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuetext={valueLabel}
      aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
    >
      <span className="pct-bar">
        <span className="pct-fill" style={style} />
      </span>
      {label !== undefined && <span className="num-value">{label}</span>}
    </span>
  );
}

/** One row of `Bars`: its key, its label, its figure and a quiet note after it ("4 deals"). */
interface BarItem {
  key: string;
  label: ReactNode;
  value: number;
  note?: ReactNode;
}

const BAR_FORMATS = {
  number: (value: number) => formatNumber(value),
  money: (value: number) => formatMoney(value),
  percent: (value: number) => formatPercent(value),
} as const;

/**
 * Groups as bars against the largest: a label, the bar on Meter's track and fill, the figure and a note. The rows are
 * drawn in the order given (a breakdown hands them in its column's declared order). Each row is a meter a screen
 * reader says whole, "Proposal: $120,000, 4 deals"; `say` (or `format`) says a figure. On a phone the label sits
 * above its bar.
 */
export function Bars({
  label,
  items,
  format = 'number',
  say,
  tone,
}: {
  label?: string;
  items: ReadonlyArray<BarItem>;
  format?: keyof typeof BAR_FORMATS;
  say?: (value: number) => string;
  tone?: ToneName;
}) {
  const figure = say ?? BAR_FORMATS[format];
  const max = Math.max(0, ...items.map((item) => (Number.isFinite(item.value) ? item.value : 0)));
  return (
    <ul className="kit-bars" aria-label={label}>
      {items.map((item) => {
        const said = figure(item.value);
        const named = typeof item.label === 'string' || typeof item.label === 'number' ? String(item.label) : item.key;
        const note = typeof item.note === 'string' || typeof item.note === 'number' ? `, ${item.note}` : '';
        return (
          <li key={item.key} className="kit-bars-row">
            <span className="kit-bars-label">{item.label}</span>
            <Meter value={item.value} max={max} tone={tone} size="fluid" ariaLabel={named} valueLabel={`${named}: ${said}${note}`} />
            <span className="kit-bars-figure">{said}</span>
            <span className="kit-bars-note">{item.note}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** What a component says when it has nothing to draw: the platform's own quiet note. */
export function Empty({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return <PlatformEmpty text={title} detail={description} action={action} />;
}

/**
 * A placeholder block: the platform's skeleton bar, at the size what is coming will take (`height`, and `width` where
 * it is not the box's), so nothing under it moves when it lands. `lines` draws that many, one under another, the last
 * shorter, for a paragraph. It is for `<Loaded loading={…}>`, and says nothing to assistive technology itself: the
 * wait is announced once, by what holds it.
 */
export function Skeleton({ height, width, lines = 1 }: { height?: number | string; width?: number | string; lines?: number }) {
  const count = Math.max(1, Math.floor(lines));
  return (
    <span className="kit-skeleton" aria-hidden="true">
      {Array.from({ length: count }, (_, at) => (
        <span
          key={at}
          className="sk-bar kit-skeleton-bar"
          style={{
            ...(height === undefined ? {} : { blockSize: height }),
            ...(width !== undefined ? { inlineSize: width } : count > 1 && at === count - 1 ? { inlineSize: '60%' } : {}),
          }}
        />
      ))}
    </span>
  );
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
 * place: a `Skeleton` shaped like the drawing), `Empty` for no rows or no record (`empty`, or the house sentence;
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
  children,
}: {
  query: LoadedQuery<T>;
  empty?: ReactNode;
  loading?: ReactNode;
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
  /* `empty={null}` says draw nothing; only an `empty` left out is the house sentence. */
  const nothing = empty === undefined ? <Empty title={sayKit('nothingHereYet')} /> : empty;
  if (query.data === undefined && query.refused) return <>{nothing}</>;
  if (query.data === undefined && loading !== undefined)
    return (
      <div role="status" aria-label={sayKit('common.loading')}>
        {loading}
      </div>
    );
  if (query.data === undefined)
    return (
      <div
        className="sk-bar kit-loading"
        role="status"
        aria-label={sayKit('common.loading')}
        {...(height === undefined ? {} : { style: { blockSize: height } })}
      />
    );
  if (query.data === null || (Array.isArray(query.data) && query.data.length === 0)) return <>{nothing}</>;
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
 * One target: arrows move the choice, as a radio group's do. A value no option carries leaves every one unchosen (the
 * first stays the tab stop). Past four choices the row is too wide for a phone, so at a phone's width a native picker
 * stands in its place; `className` is the App's own class, on whichever of the two is drawn.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  size = 'default',
  className,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode; count?: number; name?: string }>;
  onChange(value: T): void;
  size?: 'default' | 'compact';
  className?: string;
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
  /* A picker's words are text: a count is said after the word, and a label that is not text falls back to the option's name. */
  const said = (option: (typeof options)[number]) =>
    `${typeof option.label === 'string' ? option.label : (option.name ?? option.value)}${option.count === undefined ? '' : ` (${option.count})`}`;
  const folds = options.length > 4;
  return (
    <>
      <div
        className={`kit-segmented${size === 'compact' ? ' kit-segmented-compact' : ''}${folds ? ' kit-segmented-folds' : ''}${className ? ` ${className}` : ''}`}
        role="radiogroup"
        aria-label={label}
      >
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
      {folds && (
        <select
          data-slot="input"
          className={`kit-segmented-pick${className ? ` ${className}` : ''}`}
          aria-label={label}
          value={options.some((option) => option.value === value) ? value : ''}
          onChange={(event) => onChange(event.target.value as T)}
        >
          {!options.some((option) => option.value === value) && <option value="" disabled hidden />}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {said(option)}
            </option>
          ))}
        </select>
      )}
    </>
  );
}

/**
 * A figure and what it counts, as a dashboard's stat card says one: the
 * figure, its label, its change against the period before (in the tone of
 * the news where the caller knows which way is good) and, from four points,
 * its trend. As tall as what it says, so a strip of them stands from one edge.
 *
 * `delta` says the change as a number and which way is good, and the Stat tones and signs it (`{ value: 12, good:
 * 'up' }` is "+12" in the good ink; `{ value: -3, good: 'down' }` is "−3", also good); `change` is for words of the
 * caller's own, and wins where both are given. With `href` the whole Stat is a link, followed in place for an address
 * of this App, and it is named by its label and figure.
 */
export function Stat({
  label,
  value,
  change,
  delta,
  trend,
  href,
  say = String,
}: {
  label: ReactNode;
  value: ReactNode;
  change?: { text: ReactNode; tone?: ToneName };
  delta?: { value: number | string; good?: 'up' | 'down'; against?: string };
  trend?: ReadonlyArray<number | { key: string; value: number }>;
  href?: string;
  say?: (value: unknown) => string;
}) {
  const points = (trend ?? []).map((point, index) => (typeof point === 'number' ? { key: String(index), value: point } : point));
  /* In a Card it is a figure in that box, not a box in a box (as a Card in a Card is a plain group). */
  const nested = useContext(InCard);
  const follow = useFollow(href);
  const news = change ?? (delta ? deltaSaid(delta, say) : undefined);
  const body = (
    <>
      <span className="kit-stat-label">{label}</span>
      {/* The trend rides beside the figure, so a Stat with none is the same height as one with. */}
      <span className="kit-stat-row">
        <span className="kit-stat-figure">{value}</span>
        {points.length >= 4 && (
          /* The trend is a picture of what the figure and its change already say in words. */
          <span className="spark-host kit-stat-spark" aria-hidden="true">
            <ChartSparkline rows={points} say={say} />
          </span>
        )}
      </span>
      {news && (
        <span className={`kit-stat-change${news.tone ? ` kit-stat-${news.tone}` : ''}`}>
          {news.text}
          {!change && delta?.against && <span className="kit-stat-against"> {delta.against}</span>}
        </span>
      )}
    </>
  );
  const className = `${nested ? 'kit-stat kit-stat-plain' : 'kit-stat'}${href === undefined ? '' : ' kit-stat-link'}`;
  return href === undefined ? (
    <div className={className}>{body}</div>
  ) : (
    <a className={className} href={href} onClick={follow}>
      {body}
    </a>
  );
}

/** A delta as the news it is: signed, and toned where the caller said which way is good. */
function deltaSaid(
  delta: { value: number | string; good?: 'up' | 'down' },
  say: (value: unknown) => string,
): { text: ReactNode; tone?: ToneName } {
  const { value, good } = delta;
  if (typeof value === 'string') return { text: value };
  const way = value > 0 ? 'up' : value < 0 ? 'down' : undefined;
  const text = `${value > 0 ? '+' : value < 0 ? '\u2212' : ''}${say(Math.abs(value))}`;
  return { text, tone: way && good ? (way === good ? 'good' : 'bad') : undefined };
}

/**
 * The shape of a run of numbers, drawn in the look's chart ink: a line over a soft fill, the last point marked. It
 * spans its container's width. Four values or more draw (fewer have no shape to read), and it is named for a screen
 * reader by its values, `label` first where given.
 */
export function Sparkline({
  values,
  label,
  say = String,
}: {
  values: ReadonlyArray<number>;
  label?: string;
  say?: (value: unknown) => string;
}) {
  const rows = values.map((value, index) => ({ key: String(index + 1), value }));
  return (
    <span className="spark-host kit-spark" role="group" aria-label={label}>
      <ChartSparkline rows={rows} say={say} />
    </span>
  );
}

/**
 * A few bars side by side, tallest to the top of the box: a week of orders, a month by day. `labels` name them (under
 * the bars is the caller's to draw; a screen reader gets a table of label and value that the sighted reader does not
 * need), and `highlight` is the index of the one that stands out, the rest drawn quieter.
 */
export function MiniBars({
  values,
  labels,
  highlight,
  label,
  say = String,
}: {
  values: ReadonlyArray<number>;
  labels?: ReadonlyArray<string>;
  highlight?: number;
  label?: string;
  say?: (value: unknown) => string;
}) {
  const top = Math.max(...values, 0);
  return (
    <span className="kit-minibars" role="group" aria-label={label}>
      <span className="kit-minibars-bars" aria-hidden="true">
        {values.map((value, index) => (
          <i
            key={index}
            className={highlight === undefined || highlight === index ? 'is-lit' : undefined}
            style={{ height: `${top > 0 ? Math.max(4, Math.round((Math.max(value, 0) / top) * 100)) : 4}%` }}
          />
        ))}
      </span>
      <table className="kit-visually-hidden">
        <tbody>
          {values.map((value, index) => (
            <tr key={index}>
              <th scope="row">{labels?.[index] ?? String(index + 1)}</th>
              <td>{say(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </span>
  );
}

/**
 * A card that is one control: a button with `onPress`, a link with `href` (an address of this App is followed in
 * place), toggled with `selected`. Its children are whatever the card holds, so they must not be controls of their
 * own. It is a card to the eye (the card's corner and lift, not a control's), which is why it says `data-slot="tile"`
 * and not a button's, so the platform's control rules leave it its own box.
 */
export function Tile({
  onPress,
  href,
  selected,
  disabled,
  children,
  className,
  ...rest
}: {
  onPress?: () => void;
  href?: string;
  selected?: boolean;
  disabled?: boolean;
  children?: ReactNode;
  className?: string;
} & Omit<ComponentProps<'button'>, 'onClick' | 'children' | 'type' | 'className' | 'disabled'>) {
  const follow = useFollow(href, onPress);
  const classes = `kit-tile${className ? ` ${className}` : ''}`;
  const state = { 'data-slot': 'tile', 'data-selected': selected ? '' : undefined, 'data-disabled': disabled ? '' : undefined };
  if (href !== undefined && !disabled)
    return (
      <a
        /* The shared attributes (aria-*, data-*, title, handlers) suit either element; only the ref's type differs. */
        {...(rest as unknown as ComponentProps<'a'>)}
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
      {...state}
      type="button"
      className={classes}
      disabled={disabled}
      aria-pressed={selected === undefined ? undefined : selected}
      onClick={() => onPress?.()}
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
  const { box, folded, scrolls } = useTableFold(columns.length);
  const host = useHostIfAny();
  const shown = folded ? columns.slice(0, columns.length - folded) : columns;
  const tucked = folded ? columns.slice(columns.length - folded) : [];
  const cellOf = (column: TableColumn<Row>, row: Row) =>
    column.render ? (
      column.render(row)
    ) : (
      <Value value={row[column.key]} resource={column.resource} column={column.column} display={column.display} compact />
    );
  return (
    <div ref={box} className="table-wrap kit-table" {...(scrolls ? { role: 'region', tabIndex: 0, 'aria-label': label } : {})}>
      <table aria-label={label}>
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
      {rows.length === 0 && empty !== undefined && <div className="kit-table-empty">{empty}</div>}
    </div>
  );
}

/** One run of an `Items` list under a head of its own: `title` is the head's words, `count` a quiet number beside it, and
    `items` its `Item`s. */
interface ItemGroup {
  key?: string;
  title: ReactNode;
  count?: ReactNode;
  items: ReactNode;
}

/** Rows of a list with no head row: a lead, a title, a quiet note and an action each. `label` names the list for
    assistive technology; `empty` stands in its place when there are no `Item`s. With `groups` the rows come in runs, each
    under a head that holds the top of the room while its own rows pass beneath it (a run with no rows is not drawn). */
export function Items({
  label,
  empty,
  groups,
  children,
  className,
}: {
  label?: string;
  empty?: ReactNode;
  groups?: readonly ItemGroup[];
  children?: ReactNode;
  className?: string;
}) {
  /* In a Card the rows are that box's, not a box in a box: no inset of their own, as a Stat in a Card is plain. */
  const nested = useContext(InCard);
  const runs = (groups ?? []).filter((group) => Children.toArray(group.items).length > 0);
  if (Children.toArray(children).length === 0 && runs.length === 0)
    return given(empty) ? <div className={`kit-items-empty${nested ? ' kit-items-empty-flush' : ''}`}>{empty}</div> : null;
  return (
    <ul className={['kit-items', nested && 'kit-items-flush', className].filter(Boolean).join(' ')} aria-label={label}>
      {runs.map((group, at) => (
        <ItemRun key={group.key ?? at} group={group} />
      ))}
      {children}
    </ul>
  );
}

/* A run is one list item holding its head and its own list, labelled by the head: the groups are a list of lists to a
   screen reader. The run spans the shared columns, so the lead column still lines up down every run, and being the
   containing block of its sticky head is what lets the next run's head take the place of this one. */
function ItemRun({ group }: { group: ItemGroup }) {
  const id = useId();
  return (
    <li className="kit-items-run">
      <div id={id} className="kit-items-head">
        <span className="kit-items-head-title">{group.title}</span>
        {given(group.count) && <span className="kit-items-head-count">{group.count}</span>}
      </div>
      <ul className="kit-items-run-rows" aria-labelledby={id}>
        {group.items}
      </ul>
    </li>
  );
}

/**
 * One row of `Items`. `lead` is a slot before the text (an icon, an avatar, a time, a `Value`), `title` the row's words,
 * `note` one quiet line under it and `action` a slot at the row's end (buttons, a menu, a `Value`). The lead is one
 * column the rows of an `Items` share, as wide as its widest, so a time or a mark lines up down the list whichever rows
 * carry one. `tone` puts a mark of that tone in the column (a dot, as a status is one), or, beside a `lead`, says the
 * lead in the tone's ink; the words that mean it are the row's own. With `href` or `onClick` the title is the row's one
 * link or button (a single target for the keyboard) and the whole row answers a pointer, as a table's rows do: the
 * target reaches across the row, so a finger anywhere on it is the target's own. A click inside `action` is the
 * action's and never opens the row; at a narrow width the action wraps under the note rather than squeeze it.
 */
export function Item({
  lead,
  title,
  note,
  action,
  tone,
  href,
  onClick,
}: {
  lead?: ReactNode;
  title: ReactNode;
  note?: ReactNode;
  action?: ReactNode;
  tone?: ToneName;
  href?: string;
  onClick?: () => void;
}) {
  const target = useRef<HTMLAnchorElement & HTMLButtonElement>(null);
  const interactive = href !== undefined || onClick !== undefined;
  const follow = useFollow(href, onClick);
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
  const marked = given(lead) || tone !== undefined;
  return (
    <li
      className={`kit-item${interactive ? ' kit-item-clickable' : ''}`}
      /* The pointer's click is the target's own, run once: one that began in the target already is. */
      onClick={interactive ? (event) => void (target.current?.contains(event.target as Node) || target.current?.click()) : undefined}
    >
      {marked && (
        <span className={`kit-item-lead${tone ? ` kit-item-lead-${tone}` : ''}`}>
          {given(lead) ? lead : <span className="kit-item-mark" aria-hidden="true" />}
        </span>
      )}
      <span className="kit-item-main">
        <span className="kit-item-body">
          <span className="kit-item-title">{words}</span>
          {given(note) && <span className="kit-item-note">{note}</span>}
        </span>
        {given(action) && (
          <span className="kit-item-action" onClick={(event) => event.stopPropagation()}>
            {action}
          </span>
        )}
      </span>
    </li>
  );
}

/**
 * An address in this App is followed in place, as `useNavigate` does: a plain `<a>` would load the whole page again.
 * A modified or middle click keeps the browser's own meaning (a new tab, a download), and so does another origin.
 */
function useFollow(href: string | undefined, onClick?: () => void) {
  const host = useHostIfAny();
  return (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.();
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!host || href === undefined || !href.startsWith('/') || href.startsWith('//')) return;
    event.preventDefault();
    host.follow(href);
  };
}

type ButtonProps = ComponentProps<typeof UiButton>;
type LinkProps = Omit<ComponentProps<typeof ButtonLink>, 'onClick'> & { href: string; onClick?: () => void };

/**
 * The platform's one button. With `href` it is an `<a>` in the button's dress, so the action that opens another page
 * has an address: a new tab, a copied link, and the page still follows an address of this App in place. Without it, a
 * `<button>`; `busy` is the button's alone.
 */
export function Button(props: ButtonProps | LinkProps) {
  if ('href' in props && props.href !== undefined) return <LinkedButton {...(props as LinkProps)} />;
  return <UiButton {...(props as ButtonProps)} />;
}

function LinkedButton({ href, onClick, ...rest }: LinkProps) {
  const follow = useFollow(href, onClick);
  return <ButtonLink {...rest} href={href} onClick={follow} />;
}

/*
 * The disc is the house control's (pageControls.ts), fetched with the page's controls the first time a row or a
 * person draws one, so a page that draws no face pays nothing for it.
 */
const Avatar = onDemand(() => import('./pageControls.js'), 'Avatar', { quiet: true });

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
 * A person as a line of the page: their disc, their name and one quieter line under it (a company, a role). The disc
 * is decorative (`aria-hidden`) and says the initials until there is a picture; the name is the text a reader hears,
 * and with `href` it is the link, followed in place as `Button` follows one. On a phone the second line wraps under the
 * name and the disc is the small one, whatever size was asked.
 */
export function Person({
  name,
  secondary,
  src,
  href,
  size = 'md',
}: {
  name: string;
  secondary?: ReactNode;
  src?: string;
  href?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const phone = useMediaQuery(PHONE_QUERY);
  const follow = useFollow(href);
  const drawn = phone ? 'sm' : size;
  return (
    <span className="kit-person" data-size={drawn}>
      <span className="kit-person-avatar" aria-hidden="true">
        <Avatar name={name} src={src} size={drawn} />
      </span>
      <span className="kit-person-text">
        {href === undefined ? (
          <span className="kit-person-name">{name}</span>
        ) : (
          <a className="kit-person-name" href={href} onClick={follow}>
            {name}
          </a>
        )}
        {given(secondary) && secondary !== '' && <span className="kit-person-secondary">{secondary}</span>}
      </span>
    </span>
  );
}

/** A field `Details` lists: a column of the resource by name, or a pair the page worked out itself. */
export type DetailsField = string | { label: ReactNode; value: ReactNode };

/**
 * A record's facts as terms and values: one `<dl>`, each column's label from the App (`host.column`) and its value a
 * `Value`, dressed as the column is. It is the record page's own field grid (PageFields.tsx draws its read-only fields
 * under the same `kit-details`), so a look that dresses one dresses both; what it adds is that a long value wraps where
 * the record page clips it to a line, since a page's facts beside a card have no row of their own to open. `columns`
 * fixes the count at a desk; a phone has one.
 */
export function Details<Row extends Record<string, unknown>>({
  resource,
  row,
  fields,
  columns,
}: {
  resource: string;
  row: Row;
  fields: ReadonlyArray<DetailsField>;
  columns?: 1 | 2;
}) {
  const host = useUiHost();
  return (
    <dl
      className="page-field-grid kit-details kit-details-wrap"
      data-columns={columns}
      style={columns ? ({ '--page-field-columns': `repeat(${columns}, minmax(0, 1fr))` } as CSSProperties) : undefined}
    >
      {fields.map((field, at) =>
        typeof field === 'string' ? (
          <div key={field} className="page-field">
            <dt>{host.column(resource, field)?.label ?? field}</dt>
            <dd>
              <Value value={row[field]} resource={resource} column={field} />
            </dd>
          </div>
        ) : (
          <div key={`at-${at}`} className="page-field">
            <dt>{field.label}</dt>
            <dd>{given(field.value) && field.value !== '' ? field.value : <span className="null">—</span>}</dd>
          </div>
        ),
      )}
    </dl>
  );
}
