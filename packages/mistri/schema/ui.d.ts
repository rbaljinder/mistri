// A declaration file includes a script of declarations (`*.css`) this way; an import would make it a module.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./css.d.ts" />
/**
 * `@mistriwork/mistri/ui`: what a custom component imports from tablewalk.
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
import type { AppIcon, PropValues, SectionWidth } from './app.js';
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

/** One box: a hairline and the surface. A card inside a card draws as a plain group. */
export declare function Card(props: Children & { title?: ReactTypes.ReactNode; className?: string }): ReactTypes.ReactElement;
/** Children one under another: a field's 20px apart (default), a section's 40px, or tight. */
export declare function Stack(props: Children & { gap?: Gap; as?: 'div' | 'ul' | 'ol'; className?: string }): ReactTypes.ReactElement;
/** Children side by side, wrapping where there is no room. */
export declare function Row(props: Children & { gap?: Gap; align?: 'start' | 'center' | 'baseline' | 'end'; className?: string }): ReactTypes.ReactElement;
/** A heading inside a section, whose own title is its h2. */
export declare function Heading(props: Children & { level?: 3 | 4; className?: string }): ReactTypes.ReactElement;
/** The platform's one button. */
export declare function Button(props: Omit<ReactTypes.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  intent?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'compact' | 'default' | 'large';
  busy?: boolean;
  busyLabel?: ReactTypes.ReactNode;
  block?: boolean;
  type?: 'button' | 'submit' | 'reset';
  ref?: ReactTypes.Ref<HTMLButtonElement>;
}): ReactTypes.ReactElement;
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

/** A read as a hook holds it. */
export interface UiQuery<T> {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  refetch(): unknown;
}
export type UiRow = Readonly<Record<string, unknown>>;
export type OpenMode = 'page' | 'drawer' | 'modal';
/** Where `useNavigate().openView` opens a list: a tab by its label, the name box's phrase and the filter boxes by column. */
export interface OpenViewOptions { tab?: string; search?: string; filters?: Readonly<Record<string, string>> }

/** Rows of one App resource, by the resource's name: `useRows('pay_run', { query: 'status = review', show: ['title'], sort: 'pay_date desc', limit: 12 })`.
    `enabled: false` asks nothing yet. On a free-form page, a resource is one of the page's `reads`. */
export declare function useRows(resource: string, options?: { query?: string; show?: readonly string[]; sort?: string; limit?: number; enabled?: boolean }): UiQuery<UiRow[]>;
/** One record by its key: `useRecord('employee', { id: 4 }, ['name', 'title'])`. Null when there is none; not asked while the key is undefined. */
export declare function useRecord(resource: string, key: Readonly<Record<string, unknown>> | undefined, show?: readonly string[]): UiQuery<UiRow | null>;
/** A resource's rows grouped and measured: `useBreakdown('pay_stub', { by: 'status', measure: 'sum net' })`. Each row is keyed as the
    server names its columns: the groups by their paths (`status`, `day(moved_at)`), the measure as written (`count`, `sum(net)`). */
export declare function useBreakdown(resource: string, options: { by: string; measure?: string; query?: string; limit?: number }): UiQuery<UiRow[]>;
/** Where a component may send the reader: a record, as a page, a peek or a dialog, or one of the App's views. */
export declare function useNavigate(): {
  openRecord(resource: string, key: Readonly<Record<string, unknown>>, options?: { mode?: OpenMode; label?: string }): void;
  /** One of the App's views. On a list, `tab` is a tab's label, `search` the name box's phrase and `filters` its filter boxes
      by column (a comma between values: `{ status: 'open,pending' }`) — the same words an address says. */
  openView(view: string, options?: OpenViewOptions): void;
  /** One of the App's forms: a public form in a dialog over the page, its `prefillable` inputs filled; a signed-in form opened as its room. */
  openForm(view: string, prefill?: Readonly<Record<string, string | number>>): void;
  /** In a tenant App, the link a visitor opens by, placed with the reader's own tenant: a view by the tenant's public
      address, a public form by its intake address — `?via=` and all, to hand out. Undefined when the tenant has no
      such address, outside a tenant's own lease, or for a view no visitor opens. */
  publicLink(view: string): string | undefined;
};
/** The page's timeline composer, from a custom section beside it: `fill` puts a template's words in the box (and chooses
    Reply or Internal note, where the page offers it) for the reader to edit and send. It never sends; it answers false
    when the page draws no composer. */
export declare function useComposer(): { fill(text: string, options?: { mode?: 'reply' | 'note' }): boolean };
/** Where a file resource's row is served, for an `<img>`: `const file = useFile('member_avatar'); file({ id: 4 }, { thumbnail: true })`. */
export declare function useFile(resource: string): (key: Readonly<Record<string, unknown>>, options?: { thumbnail?: boolean }) => string | undefined;
/** Who is reading: signed in or not, and the signed-in account's id. What a component knows of the reader; the server decides every request. */
export declare function useViewer(): { signedIn: boolean; account?: string };
/** How a command a component ran ended: applied, with what its handler returned as `output` (the new record's id, the
    ticket it opened: read it as the shape your command returns), refused in the server's words, or a form closed with
    nothing sent. */
export type CommandOutcome = { status: 'applied'; message?: string; output?: unknown } | { status: 'refused'; message: string } | { status: 'closed' };
/** Why a command cannot be run on a record: signed out, the reader's role not granted it, or its `when` not holding for the record now. */
export type CommandUnavailable = 'signed-out' | 'not-granted' | 'unavailable';
/**
 * One of the App's commands, as its actions offer it, by name: `const react = useCommand('reactToPost')`. `run(record, input)` sends it when the
 * input is complete and valid, and opens the platform's own form, filled with what was given, when it is not; `open` always opens the form.
 * Either way it is the one command pipeline — prepared for the record's revision, sent once, refused in the server's words — never a
 * write of the component's own. `available(record)` is whether the command's `when` holds for this record and reader, undefined until
 * the server has said; `reason(record)` says why not in a word, before any click. A signed-out reader is granted no command. A
 * precondition only the command's handler checks ("join first") is the App's to say: the page cannot know it before the run. A
 * command that names no record (`targets: 'none'`) is reached the same way, through its form or, when no form runs it, by name; pass
 * `{}` as its record: `markAllRead.run({}, {})`. An applied run resolves with what the command returned as `output`:
 * `const done = await raise.run({}, input); if (done.status === 'applied') nav.openRecord('ticket', { id: (done.output as { id: number }).id })`.
 */
export declare function useCommand(command: import('./app.js').CommandName): {
  label: string;
  granted: boolean;
  available(record: Readonly<Record<string, unknown>>): boolean | undefined;
  /** Why it cannot be run on this record; undefined while it can be, and until the server has said. */
  reason(record: Readonly<Record<string, unknown>>): CommandUnavailable | undefined;
  pending(record: Readonly<Record<string, unknown>>): boolean;
  run(record: Readonly<Record<string, unknown>>, input?: Readonly<Record<string, unknown>>, options?: { label?: string; challenge?: string }): Promise<CommandOutcome>;
  open(record: Readonly<Record<string, unknown>>, input?: Readonly<Record<string, unknown>>, options?: { label?: string; challenge?: string }): Promise<CommandOutcome>;
  /** The choices one of its inputs offers, as served with the command: a choice's options, or a table's rows
      (`field.choice({ from })`) where they come with it. Undefined for an input that offers none, or whose rows its own
      form reads. */
  choices(field: string): ReadonlyArray<{ value: string | number | boolean; label: string }> | undefined;
};
/** One of the App's messages (`messages/<locale>.ts`) in the reader's language, its `{name}`s filled from `args`:
    `useMessage('help.title')`, `useMessage('help.results', { count: 3 })`. Redraws when the reader picks another
    language; a key the catalog lacks is said as itself. Keys are `msg`'s (`AppMessages` in @mistriwork/mistri/app). */
export declare function useMessage(
  key: import('./app.js').AppMessageKey,
  args?: Readonly<Record<string, string | number | boolean | Date | null | undefined>>,
): string;
/** Figures in the App's locale, currency and timezone, as every built-in section says them. */
export declare function useFormat(): {
  number(value: number | string, options?: Intl.NumberFormatOptions): string;
  money(value: number, currency?: string): string;
  percent(value: number): string;
  date(value: string): string;
  dateTime(value: string): string;
  /** "in 3 days", "yesterday"; undefined for a value that is not a date. */
  relative(value: string): string | undefined;
};
/** The look the App wears for this reader, light or dark, and the density; redraws when any changes. */
export declare function useLook(): { look: string; mode: 'light' | 'dark'; density: 'compact' | 'comfortable' | 'spacious' };
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
  | '--space-2h'
  | '--space-3h'
  | '--space-4h'
  | '--section-seam'
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
