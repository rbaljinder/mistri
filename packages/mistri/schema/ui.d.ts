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
import type { AppIcon, PropValues, Register, SectionWidth } from './app.js';
export type { SectionWidth };

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
    ? Loaders[L] extends { readonly load: (...args: never[]) => infer R } ? Awaited<R> : unknown
    : unknown;

/* A page's props live here rather than beside definePage: @mistriwork/mistri/page types its house controls from
   @mistriwork/ui, which in a checkout is .tsx source, so the generated mistri-components.d.ts importing from there
   failed the typecheck (TS6142) of an App whose tsconfig sets no jsx. ui.d.ts reaches only react. */
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
export type PageProps<N extends ([PageLoaders] extends [never] ? string : keyof PageLoaders & string) = never> = LoaderPageProps<[N] extends [never] ? never : LoaderOf<N>>;

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
  rows: { readonly [K in keyof ReadsOf<D>]: ReadonlyArray<ReadsOf<D>[K] extends { from: infer F; show: readonly (infer P extends string)[] } ? RowAt<R, F, P> : never> };
  /** Each declared aggregate read, by its name, exact over every row the reader may see (not the page of rows a `rows`
      read holds): one figure, or with a `by` a group for each value, as the server counted them under the reader's grants. */
  figures: { readonly [K in keyof FiguresOf<D>]: FiguresOf<D>[K] extends { by: string }
    ? ReadonlyArray<FigureGroup<FiguresOf<D>[K] extends { measure: infer M } ? M : string>>
    : FigureValue<FiguresOf<D>[K] extends { measure: infer M } ? M : string> };
  /** The placement's props, checked against the declaration; a prop with a default is always there. */
  props: PropValues<PropsOf<D>>;
  section: { title?: string; width: SectionWidth; region: 'main' | 'aside' };
  /** 'empty' when every declared read came back with no rows (and there is no record). */
  state: 'ready' | 'empty';
  /** On a dashboard with windows: the reader's window in the query grammar's words (`'last 30 days'`), the one each
      read with an `over` is narrowed by. Absent on a record page, and while the dashboard reads all time. */
  period?: string;
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
 * column's text in a record's form (null for none), the input's value in a command's form — and `onChange`
 * to hand one back. The form keeps it, says its problems beside it and sends it; what it must be is still
 * the form's rules and the server's to judge.
 */
export interface InputProps<V = string | number | boolean> {
  value: V | null;
  onChange(value: V | null): void;
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
  tone?: ToneName;
  /** The word the rule says this value as (`values`), where it says one. */
  word?: string;
}

/* ---------- the kit ---------- */

type Children = { children?: ReactTypes.ReactNode };
type Gap = 'tight' | 'field' | 'section';
export type ToneName = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

/** A display rule said in place, for `<Value display>` and a fixture's rules: the resource's `display` rule, as the DSL
    writes it (`bar: 5` fills against 5). */
export type ValueDisplay = import('./app.js').Plain<import('./app.js').AppDisplayRule>;

/** One box: a hairline and the surface. A card inside a card, or a Stat inside one, draws as a plain group. `count` is a
    quiet number beside the title and `action` a slot at the title row's end (buttons, a menu): given either, the title
    row is a header row. `ground="nav"` puts the box on the look's navigation ground: a Stat, Value, Meter, Table, Items,
    Segmented or Empty inside it takes that ground's inks. Any element with `data-ground="nav"` is the same scope. The title is an h3; `level` makes it
    an h2 or an h4 where the page's outline needs one (a card that is a section of a page under the platform's h1 is `level={2}`).
    `description` is one quiet line under the title, what the part holds; `tone` says the title in a status ink, for a part about trouble. */
export declare function Card(
  props: Children & {
    title?: ReactTypes.ReactNode; level?: 2 | 3 | 4; count?: ReactTypes.ReactNode; action?: ReactTypes.ReactNode;
    description?: ReactTypes.ReactNode; tone?: ToneName; ground?: 'nav'; className?: string;
  },
): ReactTypes.ReactElement;
/** A main column beside a rail (notes, filters, facts). The rail is `railWidth` wide (a CSS length, `'20rem'` by default,
    never past half the box) at the `side` edge (`'end'` by default); the main takes the rest. Where the box itself is
    under 40rem wide, or the main would be left under 24rem, it stacks, main first, and it never scrolls sideways. Cluster makes equal columns; this makes two unequal ones. */
export declare function Beside(props: Children & { rail: ReactTypes.ReactNode; railWidth?: string; side?: 'start' | 'end'; className?: string }): ReactTypes.ReactElement;
/** Rows with no head row, each an `Item`. `label` names the list for assistive technology; `empty` is drawn when there are no rows. */
export declare function Items(props: Children & { label?: string; empty?: ReactTypes.ReactNode; className?: string }): ReactTypes.ReactElement | null;
/** One row of `Items`: `lead` a slot before the text (icon, avatar, a time, a Value), `title` its words, `note` one quiet
    line under it, `action` a slot at the row's end. The lead is one column the rows share, as wide as the widest, so a
    time or a mark lines up down the list. `tone` puts a mark of that tone in the column, or says a `lead` in the tone's ink.
    With `href` or `onClick` the title is the row's one link or button, reaching across the whole row, which answers a
    pointer; a click inside `action` never opens the row. At a narrow width the action wraps under the note. */
export declare function Item(props: {
  lead?: ReactTypes.ReactNode; title: ReactTypes.ReactNode; note?: ReactTypes.ReactNode; action?: ReactTypes.ReactNode;
  tone?: ToneName; href?: string; onClick?: () => void;
}): ReactTypes.ReactElement;
/** Children one under another: a field's 20px apart (default), a section's 40px, or tight. */
export declare function Stack(props: Children & { gap?: Gap; as?: 'div' | 'ul' | 'ol'; className?: string }): ReactTypes.ReactElement;
/** Children side by side, wrapping where there is no room. `foot`: the page's actions at the screen's foot (a sticky
    row of verbs on a phone), which a notice stands above instead of covering. */
export declare function Row(
  props: Children & { gap?: Gap; align?: 'start' | 'center' | 'baseline' | 'end'; foot?: boolean; className?: string },
): ReactTypes.ReactElement;
/** Children in a grid of equal columns, each as wide as `min` (a CSS length, `'16rem'` by default) where there is room
    and fewer columns where there is not: it wraps, and never scrolls sideways. Three cards across at a desk, one on a phone. */
export declare function Cluster(props: Children & { min?: string; gap?: Gap; className?: string }): ReactTypes.ReactElement;
/** A line of words: `<Text tone="muted" size="sm">Not open to your role.</Text>`. The default is the page's ink, `muted` its secondary ink
    (a note, a caption), `danger` the status colour of a refusal or a failure. It sets no layout of its own. */
export declare function Text(props: { tone?: 'default' | 'muted' | 'danger'; size?: 'sm' | 'md'; children?: ReactTypes.ReactNode }): ReactTypes.ReactElement;
/** Words only a screen reader hears: `<VisuallyHidden>, opens in a new tab</VisuallyHidden>`. Clipped, not `display: none`, so they stay announced and take no room. */
export declare function VisuallyHidden(props: { children?: ReactTypes.ReactNode }): ReactTypes.ReactElement;
/** A heading inside a section, whose own title is its h2. */
export declare function Heading(props: Children & { level?: 3 | 4; className?: string }): ReactTypes.ReactElement;
/** The platform's one button: 44px tall on a coarse pointer or at a phone's width. With `href` it is an `<a>` in the
    button's dress (a new tab, a copied link, an address of this App followed in place); without, a `<button>`. */
export declare function Button(props: (Omit<ReactTypes.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  intent?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'compact' | 'default' | 'large';
  busy?: boolean;
  busyLabel?: ReactTypes.ReactNode;
  block?: boolean;
  type?: 'button' | 'submit' | 'reset';
  ref?: ReactTypes.Ref<HTMLButtonElement>;
  href?: undefined;
}) | (Omit<ReactTypes.AnchorHTMLAttributes<HTMLAnchorElement>, 'onClick'> & {
  href: string;
  intent?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'compact' | 'default' | 'large';
  block?: boolean;
  onClick?: () => void;
  ref?: ReactTypes.Ref<HTMLAnchorElement>;
})): ReactTypes.ReactElement;
/** The platform's themed listbox, with optional actions beneath its choices. */
export declare function Dropdown(props: {
  items: Array<{ value: string; label: string; detail?: string; badge?: string; disabled?: boolean; tone?: ToneName; swatches?: string[] }>;
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  id?: string;
  buttonRef?: ReactTypes.Ref<HTMLButtonElement>;
  popupRef?: ReactTypes.Ref<HTMLDivElement>;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  readOnly?: boolean;
  valueClassName?: string;
  actions?: Array<{ label: string; onSelect: () => void }>;
}): ReactTypes.ReactElement;
/** A collection beside its selected detail; on a phone, the detail uses the platform's modal. */
export declare function SplitListDetail(props: {
  list: ReactTypes.ReactNode;
  detail?: ReactTypes.ReactNode;
  detailActions?: ReactTypes.ReactNode;
  selected?: boolean;
  detailTitle?: string;
  onCloseDetail?: () => void;
  listLabel?: string;
  detailLabel?: string;
  className?: string;
}): ReactTypes.ReactElement;
/** A value as the App draws it: name its resource and column and the App's display rule dresses it, or say one with `display`. */
export declare function Value(props: { value: unknown; resource?: string; column?: string; display?: ValueDisplay; compact?: boolean }): ReactTypes.ReactElement;
/** A meaning as the looks say one: a dot and its word. */
export declare function Tone(props: Children & { tone: ToneName }): ReactTypes.ReactElement;
/** A share of a whole: `value` against `max` (100 by default) as a bar and its figure. */
export declare function Meter(props: { value: number; max?: number; tone?: ToneName; label?: ReactTypes.ReactNode }): ReactTypes.ReactElement;
/** What a component says when it has nothing to draw. */
export declare function Empty(props: { title: ReactTypes.ReactNode; description?: ReactTypes.ReactNode; action?: ReactTypes.ReactNode }): ReactTypes.ReactElement;
/* The platform's fields, drawn as the shell draws its own (their stylesheet is fetched with them): a label, a hint and a
   problem wired to the control. Preview, as they are in @mistriwork/ui. Typed here by what a component passes (this file
   reaches only react: see LoaderPageProps), and by the package's own types from `@mistriwork/mistri/page`. */
type FieldFrame = {
  label: ReactTypes.ReactNode; hint?: ReactTypes.ReactNode; problem?: ReactTypes.ReactNode; required?: boolean; labelHidden?: boolean;
  optional?: ReactTypes.ReactNode; reserve?: boolean; id?: string; className?: string;
};
/** A text box in a field. */
export declare function TextField(props: FieldFrame & {
  value: string; onChange: (value: string) => void; onBlur?: () => void; type?: 'text' | 'email' | 'tel' | 'url';
  inputMode?: 'text' | 'email' | 'tel' | 'numeric' | 'url'; autoComplete?: string; placeholder?: string; name?: string;
  disabled?: boolean; readOnly?: boolean; valid?: boolean; after?: ReactTypes.ReactNode; inputRef?: ReactTypes.Ref<HTMLInputElement>;
}): ReactTypes.ReactElement;
/** One choice from a list, in a field. */
export declare function Select(props: FieldFrame & {
  options: Array<{ value: string; label: string; detail?: string; badge?: string; disabled?: boolean }>;
  value: string; onChange: (value: string) => void; placeholder?: string; disabled?: boolean;
}): ReactTypes.ReactElement;
/** A checkbox with its label. */
export declare function Checkbox(props: Omit<FieldFrame, 'label'> & {
  label: ReactTypes.ReactNode; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean;
}): ReactTypes.ReactElement;
/** Two choices, yes or no, as a pair. */
export declare function YesNo(props: Omit<FieldFrame, 'label'> & {
  label: ReactTypes.ReactNode; value: 'yes' | 'no' | ''; onChange: (value: 'yes' | 'no') => void; yes: string; no: string;
}): ReactTypes.ReactElement;
/** A switch with its label. */
export declare function Switch(props: {
  label?: ReactTypes.ReactNode; description?: ReactTypes.ReactNode; checked?: boolean; defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean, event: unknown) => void; disabled?: boolean; busy?: boolean; id?: string; className?: string;
}): ReactTypes.ReactElement;
/** A number on a range, said by `format`. */
export declare function Slider(props: FieldFrame & {
  value: number; onChange: (value: number) => void; min: number; max: number; step?: number; format?: (n: number) => string; disabled?: boolean;
}): ReactTypes.ReactElement;
/** Cards to choose from: one (`value` holds at most one key) or, with `multiple`, several; `exclusive` is the option that clears the rest. */
export declare function ChoiceCards(props: FieldFrame & {
  options: Array<{ value: string; label: string; icon?: ReactTypes.ReactNode }>; value: string[]; onChange: (value: string[]) => void;
  multiple?: boolean; exclusive?: string;
}): ReactTypes.ReactElement;
/** A file chosen in the browser, handed up as a `File` (or null), or with `multiple` a `File[]`; nothing is sent. Drawn with the
    kit's button and the chosen names; the label and the keyboard are the platform's. */
export declare function FileField(props: FieldFrame & {
  accept?: string; name?: string; disabled?: boolean; inputRef?: ReactTypes.Ref<HTMLInputElement>;
  /** The button's words and what the names say with no file, in the reader's language where not said. */
  chooseLabel?: string; noneLabel?: string;
} & (
  | { multiple?: false; value: File | null; onChange: (file: File | null) => void }
  | { multiple: true; value: File[]; onChange: (files: File[]) => void }
)): ReactTypes.ReactElement;
/** A placeholder block at the size what is coming will take (`height`, and `width` where it is not the box's); `lines`
    draws that many, the last shorter, for a paragraph. For `<Loaded loading={…}>`; the wait is announced by what holds it. */
export declare function Skeleton(props: { height?: number | string; width?: number | string; lines?: number }): ReactTypes.ReactElement;
/** A read's states before its drawing, as every section says them: the platform's placeholder while it is asked (at
    `height`, the size the drawing takes, so nothing moves when it lands, or what `loading` draws instead: a `Skeleton`
    shaped like the drawing), `empty` (or the house sentence; `empty={null}` draws nothing) for no rows
    or no record, and the house problem with Try again when it could not be read. Then `children(data)`:
    `<Loaded query={useRows('payment')} empty={<Empty title="No payments yet" />}>{(rows) => …}</Loaded>`. */
export declare function Loaded<T>(props: {
  query: { data: T | undefined; isError: boolean; error: Error | null; refetch(): unknown };
  empty?: ReactTypes.ReactNode;
  loading?: ReactTypes.ReactNode;
  height?: number | string;
  children: (data: NonNullable<T>) => ReactTypes.ReactNode;
}): ReactTypes.ReactElement;
/** One of the App's curated marks: the names a view's `icon` takes. Decoration unless it has a label. */
export declare function Icon(props: { name: AppIcon; label?: string; size?: number | string }): ReactTypes.ReactElement;
/** A few exclusive choices as one row of words, the chosen one filled; arrows move the choice. A choice may carry a count. */
export declare function Segmented<T extends string>(props: {
  label: string; value: T; options: ReadonlyArray<{ value: T; label: ReactTypes.ReactNode; count?: number; name?: string }>;
  onChange(value: T): void; size?: 'default' | 'compact';
}): ReactTypes.ReactElement;
/** A figure and what it counts: its label, its change against the period before (toned where the news is known) and, from four points, its trend. */
export declare function Stat(props: {
  label: ReactTypes.ReactNode; value: ReactTypes.ReactNode; change?: { text: ReactTypes.ReactNode; tone?: ToneName };
  trend?: ReadonlyArray<number | { key: string; value: number }>; say?: (value: unknown) => string;
}): ReactTypes.ReactElement;
/** Columns over periods (or any keys), each divided by series, with levels, the current column's parts in a pill and a legend. */
export declare function Columns(props: {
  rows: ReadonlyArray<{ key: string; values: Record<string, number> }>; series: ReadonlyArray<{ key: string; label: string }>;
  say?: (value: unknown) => string; height?: number;
}): ReactTypes.ReactElement;
/** One column of a `Table`: the row field it reads, drawn through `Value` (name `resource` and `column` and the App's display rule dresses it). */
export interface TableColumn<Row> {
  key: string; label: ReactTypes.ReactNode; align?: 'left' | 'right';
  resource?: string; column?: string; display?: ValueDisplay;
  render?: (row: Row) => ReactTypes.ReactNode; sortable?: boolean;
}
/** Rows in the look's own table. Sorting is the caller's: a head is a button once `onSort` is given and the table says which way it stands.
    With `onRowClick` the first cell is the row's link and the whole row answers a pointer. `label` names the table for assistive technology. */
export declare function Table<Row extends Record<string, unknown>>(props: {
  label: string; columns: ReadonlyArray<TableColumn<Row>>; rows: ReadonlyArray<Row>;
  rowKey?: (row: Row, index: number) => string | number;
  sort?: { key: string; direction: 'asc' | 'desc' }; onSort?: (key: string) => void;
  onRowClick?: (row: Row) => void; empty?: ReactTypes.ReactNode;
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
export interface UiRefusable { refused: boolean }
/** How far a `useRows` read has paged: the page size, whether the server holds more, and `total` only where the server counted. */
export interface UiRowsPage { limit: number; hasMore: boolean; total?: number }
/** `useRows`' read: the rows read so far, with `page` and `more()`, which reads the next `limit` rows onto the end. */
export interface UiRowsQuery<Row = UiRow> extends UiQuery<Row[]> {
  page: UiRowsPage;
  more(): void;
}
export type UiRow = Readonly<Record<string, unknown>>;
export type OpenMode = 'page' | 'drawer' | 'modal';
/** Where `useNavigate().openView` opens a list: a tab by its label, the name box's phrase and the filter boxes by column. */
export interface OpenViewOptions { tab?: string; search?: string; filters?: Readonly<Record<string, string>> }

/** Rows of one App resource, by the resource's name: `useRows('pay_run', { where: { status: 'review' }, show: ['title'], sort: 'pay_date desc', limit: 12 })`. `where` is a condition as an object, joined to `query` by "and".
    `enabled: false` asks nothing yet. On a free-form page, a resource is one of the page's `reads`. The first `limit` rows (20 unless said); `page.hasMore` and `more()` read on. */
export declare function useRows(resource: string, options: { query?: string; where?: Readonly<Record<string, unknown>>; show?: readonly string[]; sort?: string; limit?: number; enabled?: boolean; optional: true }): UiRowsQuery & UiRefusable;
export declare function useRows(resource: string, options?: { query?: string; where?: Readonly<Record<string, unknown>>; show?: readonly string[]; sort?: string; limit?: number; enabled?: boolean; optional?: false }): UiRowsQuery;
/** One record by its key: `useRecord('employee', { id: 4 }, ['name', 'title'])`. Null when there is none; not asked while the key is undefined. */
export declare function useRecord(resource: string, key: Readonly<Record<string, unknown>> | undefined, show: readonly string[] | undefined, options: { optional: true }): UiQuery<UiRow | null> & UiRefusable;
export declare function useRecord(resource: string, key: Readonly<Record<string, unknown>> | undefined, show?: readonly string[], options?: { optional?: false }): UiQuery<UiRow | null>;
/** A resource's rows grouped and measured: `useBreakdown('pay_stub', { by: 'status', measure: 'sum net' })`. Each row is keyed as the
    server names its columns: the groups by their paths (`status`, `day(moved_at)`), the measure as written (`count`, `sum(net)`). */
export declare function useBreakdown(resource: string, options: { by: string; measure?: string; query?: string; limit?: number; optional: true }): UiQuery<UiRow[]> & UiRefusable;
export declare function useBreakdown(resource: string, options: { by: string; measure?: string; query?: string; limit?: number; optional?: false }): UiQuery<UiRow[]>;
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
/**
 * The App's own addresses as strings, for an `<a href>` and for an embedding app's navigator: `useHref().record('leads', { id: 4 })`.
 * Each is the one canonical address the router reads back, built through the App's own address rules, so
 * a link never drifts from a typed-in address. A view, page or record the App has no address for throws, as `openView` does,
 * where a link to nowhere would otherwise ship. `params` are the words an address says (`tab`, `search`, a filter's column).
 */
export declare function useHref(): {
  /** The sign-in's address. `then` is an in-App path to go on to once signed in (`/leads/4`): carried as `?then=`, which the sign-in reads; an absolute or protocol-relative address is dropped, not carried. */
  signIn(options?: { then?: string }): string;
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
export interface CommandRunOptions { label?: string; challenge?: string; attempt?: string; review?: CommandReview; quiet?: boolean }
/** Why a command cannot be run on a record: signed out, the reader's role not granted it, or its `when` not holding for the record now. */
export type CommandUnavailable = 'signed-out' | 'not-granted' | 'unavailable';
/** What a component hands a command's run: any of its declared inputs, by name (every name where the App is not typed). */
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
export interface Field {
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
export declare function useField<const N extends import('./app.js').CommandName>(command: N, name: import('./app.js').CommandInputName<N>): Field;
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
 * reader not granted the command is offered nothing. Draw the list with `Typeahead` from `@mistriwork/ui`, which keeps
 * the keyboard.
 */
export declare function useOptions<const N extends import('./app.js').CommandName>(command: N, name: import('./app.js').CommandInputName<N>): Options;
/**
 * A resource's own records as a picker's options, with no command behind them: `useOptions('country', { where: { active: true } })`.
 * It is a declared read: a free-form page must list the resource in its `reads`, as `useRows` requires. Each option is labelled by
 * the resource's title column, and the reader is offered only the rows they may read (grants, row policy).
 */
export declare function useOptions(resource: string, options?: { where?: Readonly<Record<string, unknown>> }): Options;
/**
 * One of the App's fixed actions, a machine's verb or `action(label, { set })`, by its id: `const start = useAction('startVisit')`. Held
 * as a command is (`granted`, `available`, `reason`, `pending`, `run`, `open`, the same outcome), but it is the record page's own
 * button: `run(record)` writes the action's `set` to that record, by its key, through the update route, asking first when the
 * action says `confirm`. A record in a state the action does not leave is refused in words (`available` says so before the click),
 * and the server judges the write again. It takes no input, but for the reason an action asks: `run(record, { reason })`.
 */
export declare function useAction(action: import('./app.js').ActionName): {
  label: string;
  granted: boolean;
  available(record: Readonly<Record<string, unknown>>): boolean | undefined;
  reason(record: Readonly<Record<string, unknown>>): CommandUnavailable | undefined;
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
  percent(value: number): string;
  date(value: string): string;
  /** A moment as the App's clock says it; with `timezone` (an IANA zone), the instant said there with the zone's name. `style: 'short'` is the fewest characters ("3/5/26, 2:30 PM"), for a cell or a card's line. */
  dateTime(value: string, options?: { timezone?: string; style?: 'short' }): string;
  /** "in 3 days", "yesterday"; undefined for a value that is not a date. */
  relative(value: string): string | undefined;
};
/** The look the App wears for this reader, light or dark, and the density; redraws when any changes. `look` is `'tenant'` where a tenant's branding dresses the page; `preset` is then the App's theme it started from (`'workshop'`), and the look itself otherwise. */
export declare function useLook(): { look: string; preset: string; mode: 'light' | 'dark'; density: 'compact' | 'comfortable' | 'spacious' };
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
