// A declaration file includes a script of declarations (`*.css`) this way; an import would make it a module.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./css.d.ts" />
/**
 * `@mistriwork/mistri/ui`: what a custom component imports from mistri.
 *
 * The page's own React (re-exported, so a component takes its hooks from here
 * or from `react` and either way gets the one copy the page runs), the kit a
 * component draws with, and the hooks it reads and moves with. Nothing else of
 * the client is reachable: no store, no walk, no raw request.
 *
 * A component's props are typed from its declaration and the generated rows,
 * with no code generation of their own:
 *
 *   import type { SectionProps } from '@mistriwork/mistri/ui';
 *   import type { Rows } from '../mistri-schema.d.ts';
 *   import type { payHistory } from '../features/payroll.ts';
 *   export default function PayHistory({ rows, record }: SectionProps<typeof payHistory, Rows, 'pay_run'>) { … }
 *
 * Every read goes through the reader's session and is authorized by the server
 * like any other request: role grants, field projection, row policy. The
 * resource names these hooks take narrow what a component asks for; they are
 * not the boundary.
 */
import type * as ReactTypes from 'react';
import type { AppIconName, PropValues, Register, SectionWidth } from './app.js';
import type { EmptyStateSpec, Tone } from './kit.js';
export type { SectionWidth };

export {
  AiBadge,
  Badge,
  Beside,
  BreakdownList,
  Button,
  Card,
  Checkbox,
  ChoiceCards,
  Cluster,
  DescriptionList,
  Dropdown,
  EmptyState,
  FileField,
  Heading,
  ItemList,
  ItemRow,
  Meter,
  MiniBars,
  Person,
  Row,
  SegmentedControl,
  Select,
  Skeleton,
  Slider,
  Sparkline,
  SplitView,
  Stack,
  StatCard,
  StatusDot,
  Switch,
  Text,
  TextArea,
  TextField,
  VisuallyHidden,
  YesNo,
  type AiBadgeProps,
  type BadgeProps,
  type BesideProps,
  type BreakdownItem,
  type BreakdownListProps,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
  type CardProps,
  type ChangeDetails,
  type CheckboxProps,
  type ChoiceCardsProps,
  type ChoiceOption,
  type ClusterProps,
  type ControlSize,
  type DescriptionField,
  type DescriptionListProps,
  type DropdownAction,
  type DropdownChange,
  type DropdownItem,
  type DropdownProps,
  type EmptyStateProps,
  type EmptyStateSpec,
  type FileFieldProps,
  type HeadingProps,
  type ItemListProps,
  type ItemRowProps,
  type MeterProps,
  type MiniBarsProps,
  type PersonProps,
  type RowProps,
  type SegmentedControlOption,
  type SegmentedControlProps,
  type SelectOption,
  type SelectProps,
  type SkeletonProps,
  type SliderProps,
  type SparklineProps,
  type SplitViewItem,
  type SplitViewProps,
  type StackProps,
  type StatCardDelta,
  type StatCardProps,
  type StatusDotProps,
  type SwitchProps,
  type TextAreaProps,
  type TextFieldProps,
  type TextProps,
  type Tone,
  type VisuallyHiddenProps,
  type YesNoProps,
} from './kit.js';

/** Pass the generated `Flags<typeof manifest>` alias. These are evaluated
 * presentation values, never permission grants. Reads do not record exposure. @preview */
export interface FlagReader<V = Readonly<Record<string, unknown>>> {
  readonly ready: boolean;
  get<K extends Extract<keyof V, string>>(key: K): V[K];
}
/** Render loading UI until ready; absent/unready get() throws instead of false. @preview */
export declare function useFlags<V = Readonly<Record<string, unknown>>>(): FlagReader<V>;
/** Explicit anonymous interaction starts a visitor experiment identity and
 * reloads evaluated flags. Call start from an event, never during render/load.
 * This grants no App authority and never stitches to a later sign-in. @preview */
export declare function useVisitor(): { start(selection?: { readonly form?: string; readonly address?: string }): Promise<void> };

/** Emit a custom event the App declared in `analytics.events`, from an event handler. The server keeps only the
 * declared name and fields, and takes who it was from the session or visitor cookie, never from here. @preview */
export declare function useAnalytics(): { emit(name: string, fields?: Readonly<Record<string, string | number | boolean>>): void };

/* ---------- the page's React ---------- */

export declare const React: typeof ReactTypes;
export declare const Fragment: typeof ReactTypes.Fragment;
export declare const useState: typeof ReactTypes.useState;
export declare const useEffect: typeof ReactTypes.useEffect;
export declare const useMemo: typeof ReactTypes.useMemo;
export declare const useRef: typeof ReactTypes.useRef;
export declare const useCallback: typeof ReactTypes.useCallback;
export declare const useId: typeof ReactTypes.useId;
export declare const useReducer: typeof ReactTypes.useReducer;
export declare const useContext: typeof ReactTypes.useContext;

/* ---------- props ---------- */

type Loaders = Register extends { loaders: infer V } ? V : never;
/** What a loader returns, by its name: a page's `data`. */
export type LoaderData<L extends string> = [Loaders] extends [never]
  ? unknown
  : L extends keyof Loaders
    ? Loaders[L] extends { readonly load: (...args: never[]) => infer R }
      ? Awaited<R>
      : unknown
    : unknown;

/** What a page's component is drawn with, by the loader it names: the shape `definePage` holds a component to. */
export interface LoaderPageProps<L extends string = never> {
  data: [L] extends [never] ? null : LoaderData<L>;
  /** Runs the loader again and draws its new result as `data`. A command the page runs that commits does this itself;
      this is for a change the page did not make (a timer, a scan that arrived, a save somewhere else). */
  refresh: () => void;
  props: Readonly<Record<string, unknown>>;
}

type PageLoaders = Register extends { pageLoaders: infer V } ? V : never;
type LoaderOf<N extends string> = [PageLoaders] extends [never] ? string : N extends keyof PageLoaders ? Extract<PageLoaders[N], string> : never;
/** What a page's component is drawn with, keyed by the page's own path (`pages/pick-walk.page.tsx` is
    `PageProps<'pick-walk'>`): its loader's result as `data`, whatever the loader is called, and its placement's props. */
export type PageProps<N extends ([PageLoaders] extends [never] ? string : keyof PageLoaders & string) = never> = LoaderPageProps<
  [N] extends [never] ? never : LoaderOf<N>
>;

/** One row as a component receives it: keyed by the paths it declared, each typed from the generated rows where the path is a column. */
type Cell<Row, P> = Row extends object ? (P extends keyof Row ? Row[P] : unknown) : unknown;
type RowAt<R, F, Show extends string> = { readonly [P in Show]: F extends keyof R ? Cell<R[F], P> : unknown };
type ReadsOf<D> = D extends { rows: infer Reads } ? Reads : {};
type PropsOf<D> = D extends { component: { props?: infer P } } ? NonNullable<P> : {};
type FiguresOf<D> = D extends { figures: infer T } ? T : {};

/** What a measure says: a count is always a number; a sum, average, minimum or maximum may be text (a PostgreSQL
    bigint or numeric past 2^53 arrives as a string — never run one through Number()) or null (no rows to measure). */
export type FigureValue<Measure = string> = Measure extends 'count' ? number : number | string | null;
/** One group of a figure declared with a `by`: the group's value, its figure and, for a reference, the record's name. */
export interface FigureGroup<Measure = string> {
  readonly key: unknown;
  readonly value: FigureValue<Measure>;
  readonly label?: string;
}

/**
 * What a custom section's component receives, from its declaration (`typeof` the
 * exported `custom()` value) and the generated `Rows`. `Base`, on a page, names
 * the page's resource, so `record` is typed from its columns.
 *
 * Loading and a failed read are the section's to say, never the component's:
 * it is drawn once its data is here. Values keep the adapter's truth — an id
 * past 2^53 is a string; never run one through Number().
 */
export interface SectionProps<D, R = Record<string, Record<string, unknown>>, Base extends string = never> {
  /** The page's record, with exactly the declared `record` fields; undefined on a dashboard. */
  record: (D extends { record: readonly (infer P extends string)[] } ? RowAt<R, [Base] extends [never] ? never : Base, P> : never) | undefined;
  /** Each declared read, by its name: the rows the planner ran, each carrying exactly its `show`. */
  rows: {
    readonly [K in keyof ReadsOf<D>]: ReadonlyArray<
      ReadsOf<D>[K] extends { from: infer F; show: readonly (infer P extends string)[] } ? RowAt<R, F, P> : never
    >;
  };
  /** Each declared aggregate read, by its name, exact over every row the reader may see (not the page of rows a `rows`
      read holds): one figure, or with a `by` a group for each value, as the server counted them under the reader's grants. */
  figures: {
    readonly [K in keyof FiguresOf<D>]: FiguresOf<D>[K] extends { by: string }
      ? ReadonlyArray<FigureGroup<FiguresOf<D>[K] extends { measure: infer M } ? M : string>>
      : FigureValue<FiguresOf<D>[K] extends { measure: infer M } ? M : string>;
  };
  /** The placement's props, checked against the declaration; a prop with a default is always there. */
  props: PropValues<PropsOf<D>>;
  section: { title?: string; width: SectionWidth; region: 'main' | 'aside' };
  /** 'empty' when every declared read came back with no rows (and there is no record). */
  state: 'ready' | 'empty';
  /** On a dashboard with windows: the reader's window in the query grammar's words (`'last 30 days'`), the one each
      read with an `over` is narrowed by. Absent on a record page, and while the dashboard reads all time. */
  period?: string;
  /** That window's bounds, as its reads compared against them: `start` is in it and `end` is the first day (or, for a
      window of hours, the moment) after it, ISO in the App's time zone — `last 30 days` on 2026-11-20 is
      `{ start: '2026-10-21', end: '2026-11-21' }`. Present with `period`. */
  window?: { start: string; end: string };
}

type ShowOf<V> = V extends { presentation: { show: readonly (infer P extends string)[] } } ? P : string;
type TableOfView<V> = V extends { from: infer T extends string } ? T : never;
type ListPropsOf<V> = V extends { presentation: { component: { props?: infer P } } } ? NonNullable<P> : {};

/**
 * What a list view's custom presentation receives (`customList`), from the view (`typeof conversation`, the
 * exported `listView(…)`) and the generated `Rows`: one page of the list's rows, each with its keys and exactly
 * the presentation's `show`. The list around them is the platform's — its question, its paging (the pager under
 * the rows) and its selection's bulk actions (the bar over them) — so the component only lays rows out.
 */
export interface ListProps<V, R = Record<string, Record<string, unknown>>> {
  rows: ReadonlyArray<RowAt<R, TableOfView<V>, ShowOf<V>> & UiRow>;
  /** How many rows the list holds, where the server counted them. */
  total?: number;
  /** Which page this is: the pager under the list turns it. */
  page: { index: number; size: number; more: boolean };
  /** Open a row's record — its page, a peek or a dialog — stepping to its neighbours as one opened from the grid does. */
  open(row: UiRow, options?: { mode?: OpenMode }): void;
  /** Present only when the reader can act on a group (the list's bulk actions); the bar over the list acts on it. */
  selection?: { count: number; has(row: UiRow): boolean; toggle(row: UiRow): void; clear(): void };
  props: PropValues<ListPropsOf<V>>;
  list: { resource: string; label: string; show: readonly string[] };
}

/**
 * What an input component receives, standing where a form draws a field (`inputs`): the form's value — a
 * column's text in a record's form (null for none), the input's value in a command's form — and `onValueChange`
 * (or `onChange`) to hand one back. The form keeps it, says its problems beside it and sends it; what it must be
 * is still the form's rules and the server's to judge.
 */
export interface InputProps<V = string | number | boolean> {
  value: V | null;
  onValueChange(value: V | null): void;
  /** The control's id, which the field's label points at, and what describes it (the hint, the problem). */
  id: string;
  describedBy?: string;
  invalid: boolean;
  disabled: boolean;
  required: boolean;
  label: string;
  field: { name: string; resource?: string };
  context: 'edit' | 'new' | 'command';
}

/** What a value renderer receives: one value, drawn where its display rule stands. Sort, filter, totals and export keep the raw value. */
export interface ValueProps<V = unknown, Row = Record<string, unknown>> {
  /** Never null: an empty value is the platform's to say. */
  value: V;
  /** The row the value is in, where one is at hand (a grid). */
  row?: Readonly<Partial<Row>>;
  column: { name: string; resource: string };
  context: 'grid' | 'record' | 'card';
  /** In a cell or a card: one line, no room to spare. */
  compact: boolean;
  /** The tone the rest of the column's display rule gives this value (`tone: { closed: 'good' }`), so a renderer
      can keep the colour the platform's pill would wear. */
  tone?: Tone;
  /** The word the rule says this value as (`values`), where it says one. */
  word?: string;
}

/* ---------- Mistri schema-aware kit pieces ---------- */

/** A display rule said in place, for `<Value display>` and a fixture's rules: the resource's `display` rule, as the DSL
    writes it (`bar: 5` fills against 5). */
export type ValueDisplay = import('./app.js').Plain<import('./app.js').AppDisplayRule>;

/** A value as the App draws it: name its resource and column and the App's display rule dresses it, or say one with `display`. */
export declare function Value(props: {
  value: unknown;
  resource?: string;
  column?: string;
  display?: ValueDisplay;
  compact?: boolean;
  className?: string;
}): ReactTypes.ReactElement;

/** A read's states before its drawing, as every section says them: the platform's placeholder while it is asked (at
    `height`, the size the drawing takes, so nothing moves when it lands, or what `loading` draws instead: a `Skeleton`
    shaped like the drawing), `empty` (or the house sentence; `empty={null}` draws nothing) for no rows
    or no record, and the house problem with Try again when it could not be read. Then `children(data)`:
    `<Loaded query={useRows('payment')} empty={{ title: 'No payments yet' }}>{(rows) => …}</Loaded>`. */
export declare function Loaded<T>(props: {
  query: { data: T | undefined; isError: boolean; error: Error | null; refetch(): unknown; refused?: boolean };
  empty?: EmptyStateSpec | ReactTypes.ReactNode;
  loading?: ReactTypes.ReactNode;
  height?: number | string;
  className?: string;
  children: (data: NonNullable<T>) => ReactTypes.ReactNode;
}): ReactTypes.ReactElement;

/** One of the App's curated marks: the names a view's `icon` takes. Decoration unless it has an accessible label. */
export declare function Icon(props: {
  name: AppIconName;
  ariaLabel?: string;
  label?: string;
  size?: number | string;
  className?: string;
}): ReactTypes.ReactElement;

/** A card that is one control: a button with `onClick`, a link with `href` (an address of this App is followed in place), toggled with `selected`.
    Drawn with the card's corner and lift, not a control's. Its children are what the card holds, which must not be controls of their own. @preview */
export declare function Tile(
  props: {
    onClick?: (event: ReactTypes.MouseEvent<HTMLElement>) => void;
    href?: string;
    selected?: boolean;
    disabled?: boolean;
    ariaLabel?: string;
    children?: ReactTypes.ReactNode;
    className?: string;
    ref?: ReactTypes.Ref<HTMLElement>;
  } & Omit<
    ReactTypes.ComponentProps<'button'>,
    'onClick' | 'children' | 'type' | 'className' | 'disabled' | 'aria-label' | 'onChange' | 'inlist' | 'ref'
  >,
): ReactTypes.ReactElement;

/** Columns over periods (or any keys), each divided by series, with levels, the current column's parts in a pill and a legend. */
export declare function Columns(props: {
  rows: ReadonlyArray<{ key: string; values: Record<string, number> }>;
  series: ReadonlyArray<{ key: string; label: string }>;
  formatValue?: (value: unknown) => string;
  height?: number;
  className?: string;
}): ReactTypes.ReactElement;

/** One column of a `Table`: the row field it reads, drawn through `Value` (name `resource` and `column` and the App's display rule dresses it). */
export interface TableColumn<Row> {
  key: string;
  label: ReactTypes.ReactNode;
  align?: 'left' | 'right';
  tone?: Tone;
  resource?: string;
  column?: string;
  display?: ValueDisplay;
  render?: (row: Row) => ReactTypes.ReactNode;
  sortable?: boolean;
  /** A second, quieter line under the value (a row field's key, or a function of the row): body weight, muted, wrapping. */
  secondary?: string | ((row: Row) => ReactTypes.ReactNode);
  /** Whether the primary line is emphasized: the first column's is `'strong'` unless said, any other's `'normal'`. */
  emphasis?: 'strong' | 'normal';
  /** A copy button beside the cell, a sibling of the row link and never inside it. */
  copy?: boolean;
  /** A face before the value, for a column that names someone: a row field holding the picture's address (the name is
      the cell's own value), or a function of the row. Initials stand in where there is no picture; the disc is decoration. */
  avatar?: string | ((row: Row) => { name: string; src?: string });
}

/** Rows in the look's own table. Sorting is the caller's: a head is a button once `onSort` is given and the table says which way it stands.
    With `onRowClick` the first cell is the row's link and the whole row answers a pointer. `ariaLabel` names the table for assistive technology. */
export declare function Table<Row extends Record<string, unknown>>(props: {
  ariaLabel?: string;
  label?: string;
  columns: ReadonlyArray<TableColumn<Row>>;
  rows: ReadonlyArray<Row>;
  rowKey?: (row: Row, index: number) => string | number;
  sort?: { key: string; direction: 'asc' | 'desc' };
  onSort?: (key: string) => void;
  onRowClick?: (row: Row) => void;
  empty?: EmptyStateSpec | ReactTypes.ReactNode;
  className?: string;
}): ReactTypes.ReactElement;

/* ---------- hooks ---------- */

/** A read as a hook holds it. `isPending` is the first read, with nothing to draw yet; `isFetching` is any read under way, a
    background refresh included. A refresh that fails keeps the last good `data` and flags it (`isStale`, `refreshError`):
    it is never shown as fresh. Each hook is one read, consistent on its own; two hooks share no snapshot. */
export interface UiQuery<T> {
  data: T | undefined;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  error: Error | null;
  isStale: boolean;
  refreshError: Error | null;
  refetch(): unknown;
}
/** What an `optional: true` read adds to its result: the reader was refused it (a 401 or 403). That is neither an error
    (`isError` stays false, no toast, no error boundary) nor an empty result (`data` is undefined): draw the refusal in its place. A 500 stays an error. */
export interface UiRefusable {
  refused: boolean;
}
/** How far a `useRows` read has paged: the page size, whether the server holds more, and `total` only where the server counted. */
export interface UiRowsPage {
  limit: number;
  hasMore: boolean;
  total?: number;
}
/** `useRows`' read: the rows read so far, with `page` and `more()`, which reads the next `limit` rows onto the end. */
export interface UiRowsQuery<Row = UiRow> extends UiQuery<Row[]> {
  page: UiRowsPage;
  more(): void;
}
export type UiRow = Readonly<Record<string, unknown>>;
export type OpenMode = 'page' | 'drawer' | 'modal';
/** Where `useNavigate().openView` opens a list: a tab by its label, the name box's phrase and the filter boxes by column. */
export interface OpenViewOptions {
  tab?: string;
  search?: string;
  filters?: Readonly<Record<string, string>>;
}

/** Rows of one App resource, by the resource's name: `useRows('pay_run', { where: { status: 'review' }, show: ['title'], sort: 'pay_date desc', limit: 12 })`. `where` is a condition as an object, joined to `query` by "and".
    `enabled: false` asks nothing yet. On a free-form page, a resource is one of the page's `reads`. The first `limit` rows (20 unless said); `page.hasMore` and `more()` read on. */
export declare function useRows(
  resource: string,
  options: {
    query?: string;
    where?: Readonly<Record<string, unknown>>;
    show?: readonly string[];
    sort?: string;
    limit?: number;
    enabled?: boolean;
    optional: true;
  },
): UiRowsQuery & UiRefusable;
export declare function useRows(
  resource: string,
  options?: {
    query?: string;
    where?: Readonly<Record<string, unknown>>;
    show?: readonly string[];
    sort?: string;
    limit?: number;
    enabled?: boolean;
    optional?: false;
  },
): UiRowsQuery;
/** One record by its key: `useRecord('employee', { id: 4 }, ['name', 'title'])`. Null when there is none; not asked while the key is undefined. */
export declare function useRecord(
  resource: string,
  key: Readonly<Record<string, unknown>> | undefined,
  show: readonly string[] | undefined,
  options: { optional: true },
): UiQuery<UiRow | null> & UiRefusable;
export declare function useRecord(
  resource: string,
  key: Readonly<Record<string, unknown>> | undefined,
  show?: readonly string[],
  options?: { optional?: false },
): UiQuery<UiRow | null>;
/** A resource's rows grouped and measured: `useBreakdown('pay_stub', { by: 'status', measure: 'sum net' })`. Each row is keyed as the
    server names its columns: the groups by their paths (`status`, `day(moved_at)`), the measure as written (`count`, `sum(net)`). */
export declare function useBreakdown<const B extends string>(
  resource: string,
  options: { by: B; measure?: string; query?: string; where?: Readonly<Record<string, unknown>>; limit?: number; optional: true },
): UiQuery<UiBreakdownRow<B>[]> & UiRefusable;
export declare function useBreakdown<const B extends string>(
  resource: string,
  options: { by: B; measure?: string; query?: string; where?: Readonly<Record<string, unknown>>; limit?: number; optional?: false },
): UiQuery<UiBreakdownRow<B>[]>;
/** A group's key as the server names its column: `day moved_at` is `day(created_at)`. */
type BreakdownKey<P extends string> = P extends `${infer F} ${infer C}` ? `${F}(${C})` : P;
type BreakdownKeys<B extends string> = B extends `${infer Head},${infer Rest}`
  ? BreakdownKey<Trim<Head>> | BreakdownKeys<Rest>
  : BreakdownKey<Trim<B>>;
type Trim<S extends string> = S extends ` ${infer T}` ? Trim<T> : S extends `${infer T} ` ? Trim<T> : S;
/** One row of a breakdown: its groups by the keys `by` names, the first measure as `value` and the rows it stands for as `count`. */
export type UiBreakdownRow<B extends string = string> = UiRow & { readonly [K in BreakdownKeys<B>]: unknown } & {
  readonly value: number;
  readonly count: number;
};
/** Where a component may send the reader: a record, as a page, a peek or a dialog, or one of the App's views. */
export declare function useNavigate(): {
  openRecord(resource: string, key: Readonly<Record<string, unknown>>, options?: { mode?: OpenMode; label?: string }): void;
  /** One of the App's views. On a list, `tab` is a tab's label, `search` the name box's phrase and `filters` its filter boxes
      by column (a comma between values: `{ status: 'open,pending' }`) — the same words an address says. */
  openView(view: string, options?: OpenViewOptions): void;
  /** One of the App's forms: a public form in a dialog over the page, its `prefillable` inputs filled; a signed-in form opened as its room. */
  openForm(view: string, prefill?: Readonly<Record<string, string | number>>): void;
  /** One of the App's custom pages, by its path, in place: the shell's router follows its canonical address with `params`
      (the words the page keeps in its address), with no reload, so a member of several tenants is not asked to choose again.
      A page the App has no address for throws. */
  openPage(name: string, params?: Readonly<Record<string, string>>): void;
  /** The same address as a string, for an `<a href>` whose click calls `openPage` (a plain click only: a modified one is the browser's). */
  pageHref(name: string, params?: Readonly<Record<string, string>>): string;
  /** In a tenant App, the link a visitor opens by, placed with the reader's own tenant: a view by the tenant's public
      address, a public form by its intake address — `?via=` and all, to hand out. Undefined when the tenant has no
      such address, outside a tenant's own lease, or for a view no visitor opens. */
  publicLink(view: string): string | undefined;
};
/** Raises the platform's own notice, the one a verb's outcome is said in (a toast, read out by assistive technology). @preview */
export declare function useNotice(): (notice: { text: string; tone?: Tone }) => void;
/**
 * The App's own addresses as strings, for an `<a href>` and for an embedding app's navigator: `useHref().record('leads', { id: 4 })`.
 * Each is the one canonical address the router reads back, built through the App's own address rules, so
 * a link never drifts from a typed-in address. A view, page or record the App has no address for throws, as `openView` does,
 * where a link to nowhere would otherwise ship. `params` are the words an address says (`tab`, `search`, a filter's column).
 */
export declare function useHref(): {
  /** The sign-in's address. `then` is an in-App path to go on to once signed in (`/leads/4`): carried as `?then=`, which the sign-in reads; an absolute or protocol-relative address is dropped, not carried. */
  signIn(options?: { then?: string }): string;
  /** The App's root, where its home opens: under a base path or a mount it is that, not `/`. `<a href={useHref().home()}>`. */
  home(): string;
  /** A list or dashboard by its view key: `view('leads', { tab: 'working', search: 'stone' })` is `/leads?tab=working&search=stone`. */
  view(view: string, params?: Readonly<Record<string, string>>): string;
  /** A record by its key under the view that shows its table: `record('leads', { id: 127 })` is `/leads/127`, and `{ tab: 'map' }` adds the tab's word. */
  record(view: string, key: Readonly<Record<string, unknown>>, options?: { tab?: string }): string;
  /** A free-form page by its path, with the parameters it keeps in its address. */
  page(path: string, params?: Readonly<Record<string, string>>): string;
};
/** The page's timeline composer, from a custom section beside it: `fill` puts a template's words in the box (and chooses
    Reply or Internal note, where the page offers it) for the reader to edit and send. It never sends; it answers false
    when the page draws no composer. */
export declare function useComposer(): { fill(text: string, options?: { mode?: 'reply' | 'note' }): boolean };
/** A pointer event's position inside an element, in layout pixels, from the element's top-left: `layoutPoint(event, column)`.
    The density zoom makes client coordinates and a drawn box differ from the pixels a page styles in; this is the one ruler the shell
    measures with, so hit-testing and dragging place what they find where the pointer is. */
export declare function layoutPoint(event: { clientX: number; clientY: number }, element: Element): { x: number; y: number };
/** Where a file resource's row is served, for an `<img>`: `const file = useFile('member_avatar'); file({ id: 4 }, { thumbnail: true })`. */
export declare function useFile(resource: string): (key: Readonly<Record<string, unknown>>, options?: { thumbnail?: boolean }) => string | undefined;
/** Who is reading: signed in or not, the signed-in account's id and the roles the reader holds here (empty when signed
    out, and in an App that grants by no role). What a component knows of the reader, to choose what to offer; the server decides every request. */
export declare function useViewer(): { signedIn: boolean; account?: string; roles: readonly string[] };
/** What this server presents the App as, read-only: the deployment's name, mark, theme and language (its config's `"presentation"` is already in them) and the path it is served under. Presentation only, never a credential or a connection. */
export declare function useDeployment(): {
  /** The program's name, as the bar and the page title say it. */
  readonly name: string;
  /** Where the logo's picture is served (its mark where it has one), or null: the App's logo is an icon, or it has none. */
  readonly mark: string | null;
  /** The theme the App is set in, by id, or null where the App sets none. */
  readonly theme: string | null;
  /** The language tag the App is set in, or null where the reader's browser decides. */
  readonly locale: string | null;
  /** The path a reverse proxy serves the server under (`/tools`), or '' at the root. */
  readonly basePath: string;
};
/** The current tenant's team: its members and pending invitations, the roles the reader may place people in, and whether
    they may change the team (`canManage`, the grant the administration and invitation routes enforce). Read through the page's
    query cache; each action refreshes it. An empty, non-managing team outside a tenant App. The server judges every request.
    `read` says which list this is. `'administration'`: the reader manages the team, and each member has an `email` and a
    `role`. `'names'`: the reader is a member who does not, and is told each member's `name`, `initials`, `id` and `account`
    and which one is `you`, with `email` and `role` empty: enough for "assign this to a person", and no more. `'none'`:
    neither was answered (not a tenant's member, or the App says `auth.tenancy.team: false`). `account` is the id
    `useViewer().account` and a command's `actor.id` say, so it is what a pick is stored by. */
export declare function useTeam(): {
  members: readonly { id: string; account: string; name: string; initials: string; email: string; role: string; you: boolean }[];
  read: 'administration' | 'names' | 'none';
  invitations: readonly { id: string; email: string; role: string; expiresAt: number }[];
  roles: readonly string[];
  canManage: boolean;
  isPending: boolean;
  error: Error | null;
  /** Invite by email into a role; `token` is the one-time handoff the invitee is given, where the server returned one. */
  invite(email: string, role: string): Promise<{ token?: string }>;
  changeRole(memberId: string, role: string): Promise<void>;
  remove(memberId: string): Promise<void>;
  /** A fresh invitation in place of a pending one; `token` as for `invite`. */
  reissue(invitationId: string): Promise<{ token?: string }>;
  cancel(invitationId: string): Promise<void>;
};
/** The organization's read audit, as the Settings Reads room reads it: who opened or listed which of an audited resource's
    rows, newest first, a page at a time (`more()` reads the page below; `next` is absent on the last). The same gate as the
    room: the tenant's admins, the tenant from the lease. A reader outside it gets the route's refusal as `error` and no
    lines. Empty outside a tenant App. `useReadAudit({ resource: 'patient', record: String(patient.id) })`. */
export declare function useReadAudit(filters?: {
  /** An account id, or `api-token:<id>`, `assistant:<account>`, `public`. */
  actor?: string;
  resource?: string;
  /** A record's id: matched where it was opened and in every list that showed it. */
  record?: string;
  /** ISO instants, inclusive. */
  since?: string;
  until?: string;
  /** A line's id: read the lines below it. */
  before?: number;
}): {
  reads: readonly {
    id: number;
    at: string;
    actor: string;
    /** The account's name, where the actor names a person the sign-in store knows. */
    person?: string;
    /** The roles the read was granted under; an API token's are its own. */
    roles?: readonly string[];
    /** The membership read through: the person's own, or the one that holds the API token. */
    membership?: string;
    resource: string;
    route: 'page' | 'api' | 'mcp' | 'assistant' | 'export' | 'picker' | 'custom-page' | 'related' | 'command';
    /** The command whose handler or lookup read it, where the route is `command`. */
    command?: string;
    kind: 'opened' | 'listed';
    record?: string;
    count?: number;
  }[];
  next: number | undefined;
  more(): void;
  isPending: boolean;
  error: Error | null;
};
/** Open a tenant in one request from a platform App's own screen: `useOpenTenant('createClinicProfile')`. `open` runs that
    platform command under a key derived from `key`, then creates the tenant and issues its first invitation under `key`.
    The command's step is not atomic with the other two: when `open` resolves null (`error` says why), send it again with
    the same `key` and it completes the rest without running anything twice. The same `key` with other details is refused
    and applies nothing. `key` is 16 to 128 letters, digits, dashes or underscores, made once per intent and kept. */
export declare function useOpenTenant(command: string): {
  open(input: {
    key: string;
    input?: Readonly<Record<string, unknown>>;
    tenant: { tenantId: string };
    invitation:
      | { accountId: string; roles: readonly string[]; redeemUntil: number; validUntil: number }
      | { email: string; roles: readonly string[]; redeemUntil: number; validUntil: number };
  }): Promise<{ tenantId: string; version: string; invitation: { result: { receiptId: string }; token?: string } } | null>;
  isPending: boolean;
  error: Error | null;
  result: { tenantId: string; version: string; invitation: { result: { receiptId: string }; token?: string } } | null;
};
/** The brand the reader sees now: the current tenant's name, logo address and accent in a tenant App that dresses one, else the App's own name, logo mark and accent (`null` where it has none). Presentation only. */
export declare function useBranding(): { readonly name: string; readonly logo: string | null; readonly accent: string | null };
/** How a command a component ran ended: applied, with what its handler returned as `output`, typed from the command's
    declared `output` (`undefined` for a command that declares none), refused in the server's words, a form closed with
    nothing sent, or `unknown`: it was sent and no answer said whether it ran (the connection dropped, the server could
    not say). Never send it again under a new key: `check()` asks under the same one, so it cannot run twice, and
    resolves as the run would have. A public page with a human check hands `check` a fresh token. A refusal about one
    input names it in `fields`, by its path, where the command declares it and the values sent leave it shown: say it
    beside the field you draw; `message` always holds the words. `code: 'stale'` is a run pinned to a review
    (`{ review }`) that the record has moved past: show the review again rather than run what was not seen. */
export type CommandOutcome<O = unknown> =
  | { status: 'applied'; message?: string; output: O }
  | { status: 'refused'; message: string; code?: 'stale'; fields?: Readonly<Record<string, string>> }
  | { status: 'closed' }
  | { status: 'unknown'; message: string; check(options?: { challenge?: string }): Promise<CommandOutcome<O>> };
/** A command refused before or as it ran: the server's words, and the input they are about. */
export type CommandRefusal = Extract<CommandOutcome, { status: 'refused' }>;
/**
 * What a person was shown before they confirmed a run (`prepare`): the values the command starts from on that record
 * at its revision then, and a token that pins the run to that revision. `run(record, input, { review })` sends exactly
 * that revision, never retries, and is refused `code: 'stale'` when the record has changed since, where a run without a
 * review quietly prepares again. `fresh` turns false once a change to the record reaches the page.
 */
export interface CommandReview<Input extends string = string> {
  readonly token: string;
  readonly values: Readonly<Partial<Record<Input, unknown>>>;
  readonly fresh: boolean;
}
/** How a run is sent: the word its form says it by, a public page's human-check token, the key a run that names no
    record is sent under, and the review it confirms. `attempt` is a UUID the component makes once per intent and keeps
    (in its address, say): a run sent again with it, after a reload, is the same run. A fresh key per run when not given.
    `quiet: true` returns a refusal as ever but shows no notice in the shell, for a page that says it in place itself. */
export interface CommandRunOptions {
  label?: string;
  challenge?: string;
  attempt?: string;
  review?: CommandReview;
  quiet?: boolean;
}
/** Why a command cannot be run on a record: signed out, the reader's role not granted it, or its `when` not holding for the record now. */
export type CommandUnavailable = 'signed-out' | 'not-granted' | 'unavailable';
/** What a component hands a command's run: any of its declared inputs, by name (every name where the App is not typed).
    Each value is what a person would type, as the form sends it: a `field.money({ minor: true })` input is its major
    amount (`255` or `'255.00'` for $255.00), never the cents the handler receives. An input left out takes its `default`. */
export type CommandInput<N extends string> = Readonly<Partial<Record<import('./app.js').CommandInputName<N>, unknown>>>;
/**
 * One of the App's commands, as its actions offer it, by name: `const react = useCommand('reactToPost')`. `run(record, input)` sends it when the
 * input is complete and valid, and opens the platform's own form, filled with what was given, when it is not; `open` always opens the form.
 * Either way it is the one command pipeline — prepared for the record's revision, sent once, refused in the server's words — never a
 * write of the component's own. `available(record)` is whether the command's `when` holds for this record and reader, undefined until
 * the server has said; `reason(record)` says why not in a word, before any click. A signed-out reader is granted no command. A
 * precondition only the command's handler checks ("join first") is the App's to say: the page cannot know it before the run. A
 * command that names no record (`targets: 'none'`) is reached the same way, through its form or, when no form runs it, by name; pass
 * `{}` as its record: `markAllRead.run({}, {})`. An applied run resolves with what the command returned as `output`:
 * `const done = await raise.run({}, input); if (done.status === 'applied') nav.openRecord('ticket', { id: done.output.id })`,
 * typed from the command's `output`. Its input is typed by the command's declared inputs (`CommandInputName`), so a
 * misspelled one is a type error. `prepare(record, input)` reads what a review shows before the person confirms, and
 * `run(record, input, { review })` runs exactly that revision or is refused `stale`; `reviewFresh` is whether the last
 * review still stands.
 */
export declare function useCommand<const N extends import('./app.js').CommandName>(command: N): {
  label: string;
  granted: boolean;
  available(record: Readonly<Record<string, unknown>>): boolean | undefined;
  /** Why it cannot be run on this record; undefined while it can be, and until the server has said. */
  reason(record: Readonly<Record<string, unknown>>): CommandUnavailable | undefined;
  /** Whether a run on this record is on its way. */
  isPending(record: Readonly<Record<string, unknown>>): boolean;
  /** @deprecated Use `isPending`, the name every hook says it by; this one still answers the same. */
  pending(record: Readonly<Record<string, unknown>>): boolean;
  run(record: Readonly<Record<string, unknown>>, input?: CommandInput<N>, options?: CommandRunOptions): Promise<CommandOutcome<import('./app.js').CommandOutputOf<N>>>;
  open(record: Readonly<Record<string, unknown>>, input?: CommandInput<N>, options?: CommandRunOptions): Promise<CommandOutcome<import('./app.js').CommandOutputOf<N>>>;
  /** What a review shows before the person confirms: the values the command starts from on the record now, with
      `input` over them, and the token that pins a run to this revision. Refused where it cannot be run on it. */
  prepare(record?: Readonly<Record<string, unknown>>, input?: CommandInput<N>): Promise<CommandReview<import('./app.js').CommandInputName<N>> | CommandRefusal>;
  /** Whether the last review `prepare` gave still stands: false once a change to its record reaches the page; true without one. */
  reviewFresh: boolean;
  /** The choices one of its inputs offers, as served with the command: a choice's options, or a table's rows
      (`field.choice({ from })`) where they come with it. Undefined for an input that offers none, or whose rows its own
      form reads. */
  choices(field: import('./app.js').CommandInputName<N>): ReadonlyArray<{ value: string | number | boolean; label: string }> | undefined;
};
/** An amount as typed, read: whole minor units as text (exact past 2^53) and the major amount with a point, or why not. */
export type MoneyParse = { minor: string; major: string } | { problem: string };
/**
 * Text a person typed as an amount of `currency`, read as the platform's money box reads it: grouping and the currency's
 * sign dropped, the locale's decimal mark (the App's `ui.locale` unless said) taken as the point, at most the currency's own
 * decimal places (19.999 dollars is refused, never rounded), and a negative only where `negative` allows one, as a field
 * allows one only when its `min` is below zero: `parseMoney('1.234,50', { currency: 'EUR', locale: 'de-DE' })` is
 * `{ minor: '123450', major: '1234.50' }`. Text to text, so an amount past 2^53 is exact.
 */
export declare function parseMoney(text: string, options: { currency: string; locale?: string; negative?: boolean }): MoneyParse;
/** One input of a command, bound (`useField`). */
export interface BoundField {
  /** What an App's input component receives in the platform's own form, for the control the component draws. */
  inputProps: InputProps & { context: 'command' };
  /** What the control last handed back, as text. */
  text: string;
  /** The value as the platform's own form sends it — an amount as its major-unit text, which the server reads into the
      minor units a `minor` handler receives, exactly, past 2^53 too; null while there is none, or it is not one. */
  value: unknown;
  /** Whether the control has handed anything back. */
  touched: boolean;
  /** Whether the value is other than the one the field starts with. */
  dirty: boolean;
  /** What is wrong with it, in the person's words: said once `validate()` has run, and kept current from then on.
      `inputProps.describedBy` is then the id to give the element that says it. */
  error: string | undefined;
  /** Judges it now and says what is wrong from here on; true when nothing is. */
  validate(): boolean;
}
/**
 * One input of a command, by name, for a control a component draws itself: `const amount = useField('transfer', 'amount')`.
 * `inputProps` is the contract an App's input component receives in the platform's own form, and the value is judged by
 * the same declaration — its kind, `required`, bounds and format — so a custom control and the form agree; a money input
 * reads what is typed with `parseMoney`, in the App's locale and the field's currency. Nothing is sent: hand `value` to
 * `useCommand(...).run`, where the server judges it again, and say a refusal's `fields[name]` beside it. For a reader not
 * served the command the control is drawn disabled.
 */
export declare function useField<const N extends import('./app.js').CommandName>(command: N, name: import('./app.js').CommandInputName<N>): BoundField;
/** A record a reference input offers, named as the platform's own picker names it. */
export interface Option {
  key: string | number;
  label: string;
  detail?: string;
}
/** A reference input's choices, searched and paged, and the one picked (`useOptions`). */
export interface Options {
  /** The text searched for, as typed. */
  query: string;
  setQuery(text: string): void;
  /** The matches read so far, a page each; the latest query's, never an earlier one's. */
  pages: Option[][];
  hasMore: boolean;
  /** Reads the next page onto the end; nothing while there is none or one is already under way. */
  more(): void;
  /** The picked record's key. */
  selected: string | number | undefined;
  select(key: string | number | undefined): void;
  /** The picked record named, read by its key when it is not on a page; `available` is false when the reader cannot see it. */
  resolved: (Option & { available: boolean }) | undefined;
  /** True while what is typed has not been searched yet. */
  isPending: boolean;
  error: Error | null;
}
/**
 * The records one reference input of a command offers: `const nurse = useOptions('assignVisit', 'nurse')`. They are read
 * where the platform's own picker reads them, under the reader's access and the input's filter. Typing searches (the
 * latest text wins), `more()` reads the next page, and `select(key)` holds a pick whose name is read by its key when it
 * is not on a page. A reader who has lost access is told the pick is not available, never that it does not exist; a
 * reader not granted the command is offered nothing. Draw the list with `Typeahead` from `@mistriwork/mistri/primitives`,
 * which keeps the keyboard.
 */
export declare function useOptions<const N extends import('./app.js').CommandName>(command: N, name: import('./app.js').CommandInputName<N>): Options;
/**
 * A resource's own records as a picker's options, with no command behind them: `useOptions('country', { where: { active: true } })`.
 * It is a declared read: a free-form page must list the resource in its `reads`, as `useRows` requires. Each option is labelled by
 * the resource's title column, and the reader is offered only the rows they may read (grants, row policy).
 */
export declare function useOptions(resource: string, options?: { where?: Readonly<Record<string, unknown>> }): Options;
/**
 * Whether this reader may run one of the App's commands, without running it: `const mayRaise = useGranted('raiseInvoice')`. The
 * same answer as `useCommand(…).granted` (signed in, granted the command, and served the action or form that offers it), but a
 * free-form page need not declare the command in its `commands` to ask: it lists the commands it runs, not the ones it only asks about.
 */
export declare function useGranted(command: import('./app.js').CommandName): boolean;
/**
 * One of the App's fixed actions, a machine's verb or `action(label, { set })`, by its id: `const start = useAction('startVisit')`. Held
 * as a command is (`granted`, `available`, `reason`, `isPending`, `run`, `open`, the same outcome), but it is the record page's own
 * button: `run(record)` writes the action's `set` to that record, by its key, through the update route, asking first when the
 * action says `confirm`. A record in a state the action does not leave is refused in words (`available` says so before the click),
 * and the server judges the write again. It takes no input, but for the reason an action asks: `run(record, { reason })`.
 */
export declare function useAction(action: import('./app.js').ActionName): {
  label: string;
  granted: boolean;
  available(record: Readonly<Record<string, unknown>>): boolean | undefined;
  reason(record: Readonly<Record<string, unknown>>): CommandUnavailable | undefined;
  /** Whether a run on this record is on its way. */
  isPending(record: Readonly<Record<string, unknown>>): boolean;
  /** @deprecated Use `isPending`, the name every hook says it by; this one still answers the same. */
  pending(record: Readonly<Record<string, unknown>>): boolean;
  run(record: Readonly<Record<string, unknown>>, input?: Readonly<{ reason?: string }>): Promise<CommandOutcome>;
  open(record: Readonly<Record<string, unknown>>, input?: Readonly<{ reason?: string }>): Promise<CommandOutcome>;
};
/** One of the App's messages (`messages/<locale>.ts`) in the reader's language, its `{name}`s filled from `args`:
    `useMessage('help.title')`, `useMessage('help.results', { count: 3 })`. Redraws when the reader picks another
    language; a key the catalog lacks is said as itself. Keys are `msg`'s (`AppMessages` in @mistriwork/mistri/app). */
export declare function useMessage(
  key: import('./app.js').AppMessageKey,
  args?: Readonly<Record<string, string | number | boolean | Date | null | undefined>>,
): string;
/** How `useFormat().money` says a figure, as a column's display rule does (`format: 'money'`). */
export interface MoneyFormat {
  /** An ISO 4217 code; the App's `ui.currency` when not given. */
  currency?: string;
  /** The value is kept in minor units: 1999 is said as 19.99, exactly. */
  minor?: boolean;
  /** Without the minor digits where they are all zero: "$24,495", and "$24,495.50" still. */
  whole?: boolean;
  /** Compact from a thousand ("$27.9K"), for a figure meant to be glanced at; put the exact one in its title. */
  compact?: boolean;
}
/** Figures in the App's locale, currency and timezone, as every built-in section says them. Money is exact: a decimal
    string (as a database sends one) is said digit for digit, past 2^53 too, and minor units are read exactly. */
export declare function useFormat(): {
  /** The App's zone (`ui.timezone`), for reckoning "today" as the App's day; undefined where the App names none. */
  timezone: string | undefined;
  number(value: number | string, options?: Intl.NumberFormatOptions): string;
  /** `money('1999', { minor: true })` is "$19.99"; a currency code alone is `money(5, 'EUR')`. */
  money(value: number | string, options?: string | MoneyFormat): string;
  /** A percent in points, as a breakdown's share is: `percent(56)` is "56%", not "5,600%". */
  percent(value: number): string;
  date(value: string): string;
  /** A moment as the App's clock says it; with `timezone` (an IANA zone), the instant said there with the zone's name. `style: 'short'` is the fewest characters ("3/5/26, 2:30 PM"), for a cell or a card's line. */
  dateTime(value: string, options?: { timezone?: string; style?: 'short' }): string;
  /** "in 3 days", "yesterday"; undefined for a value that is not a date. */
  relative(value: string): string | undefined;
};
/** The look the App wears for this reader, light or dark, and the density; redraws when any changes. `look` is `'tenant'` where a tenant's branding dresses the page; `preset` is then the App's theme it started from (`'workshop'`), and the look itself otherwise. */
export declare function useLook(): {
  look: string;
  preset: string;
  mode: 'light' | 'dark';
  density: 'compact' | 'comfortable' | 'spacious';
};
/** Every design token a component may read — colors, faces, corners, type, motion — as `var(--accent)` in CSS or `useToken('--accent')` in script. `mistri check` warns about any other `var(--…)` a component does not declare itself. */
export type Token =
  | '--ground'
  | '--surface'
  | '--field-fill'
  | '--raised'
  | '--line'
  | '--line-strong'
  | '--line-control'
  | '--ink'
  | '--ink-muted'
  | '--ink-subtle'
  | '--accent'
  | '--on-accent'
  | '--accent-ink'
  | '--primary'
  | '--on-primary'
  | '--focus'
  | '--accent-soft'
  | '--link'
  | '--status-good'
  | '--status-warning'
  | '--status-critical'
  | '--status-info'
  | '--nav-ground'
  | '--nav-ink'
  | '--nav-muted'
  | '--nav-line'
  | '--nav-accent'
  | '--nav-current'
  | '--nav-on-current'
  | '--rules-section'
  | '--rules-head'
  | '--shadow-ink'
  | '--band'
  | '--ai'
  | '--rules-weight'
  | '--control-border-w'
  | '--chart-1'
  | '--chart-2'
  | '--chart-3'
  | '--chart-4'
  | '--chart-5'
  | '--chart-6'
  | '--chart-7'
  | '--chart-8'
  | '--sans'
  | '--mono'
  | '--heading-font'
  | '--code'
  | '--figures-face'
  | '--radius'
  | '--field-radius'
  | '--pill-radius'
  | '--panel-radius'
  | '--radius-lg'
  | '--radius-pop'
  | '--radius-panel'
  | '--radius-dialog'
  | '--radius-item'
  | '--type-ui'
  | '--type-display'
  | '--type-list-title'
  | '--type-record-title'
  | '--space-1'
  | '--space-2'
  | '--space-3'
  | '--space-4'
  | '--space-5'
  | '--space-6'
  | '--space-7'
  | '--space-8'
  | '--space-1h'
  | '--space-2h'
  | '--space-3h'
  | '--space-4h'
  | '--control-h'
  | '--section-seam'
  | '--page-head-gap'
  | '--page-top'
  | '--page-measure'
  | '--room-inset'
  | '--row-h'
  | '--text-xs'
  | '--text-sm'
  | '--text-base'
  | '--text-md'
  | '--text-lg'
  | '--text-xl'
  | '--heading-weight'
  | '--track-caps'
  | '--track-display'
  | '--track-title'
  | '--t-hover'
  | '--t-press'
  | '--t-popover'
  | '--t-panel'
  | '--ease-out'
  | '--ease-in-out'
  | '--shadow-pop'
  | '--shadow-panel'
  | '--shadow-modal'
  | '--scrim'
  | '--scrim-light'
  | '--focus-width'
  | '--focus-offset';
/** The same list as a value, for a picker or a test. */
export declare const tokens: readonly Token[];
/** One token's value as the look resolves it — `useToken('--accent')` — for an SVG attribute or a canvas. CSS says `var(--accent)` itself. */
export declare function useToken(name: Token | (`--${string}` & {})): string;
/** The section's measured width, and whether it is phone-narrow (below 420px). */
export declare function useSectionSize(): { width: number; compact: boolean };

/** The signed-in reader's own account profile (`useAccountProfile()`). */
export interface AccountProfile {
  accountId: string;
  appId: string;
  name: string;
  email: string;
  providers: string[];
  emailChange?: true;
  connectedClients?: true;
}
/** Reads and updates the signed-in reader's own account profile (`name`, `email`, `providers`). */
export declare function useAccountProfile(): {
  profile: AccountProfile | null;
  isPending: boolean;
  isSaving: boolean;
  error: Error | null;
  save(name: string): Promise<AccountProfile>;
  changeEmail(newEmail: string): Promise<void>;
};
