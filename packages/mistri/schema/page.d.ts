/**
 * `@mistriwork/mistri/page`: a free-form page of the App's own, one file each — `pages/<path>.page.tsx` in the App directory.
 *
 *   import { definePage, Empty, Stack, type PageProps } from '@mistriwork/mistri/page';
 *   const page = definePage({
 *     label: 'Pick walk', icon: 'list-checks', nav: { group: 'floor' },
 *     reads: ['pick_list'], commands: ['pickList'], params: ['list'], loader: 'pickWalk',
 *     component: PickWalk,
 *   });
 *   export default page;
 *   function PickWalk({ data }: PageProps<'pickWalk'>): ReactNode {
 *     const [list, setList] = page.useParam('list');
 *     const lists = page.useRows('pick_list', { show: ['id', 'reference'], query: 'status = to_pick' });
 *     const pick = page.useCommand('pickList');
 *     …
 *   }
 *
 * What the page declares is read by the server without drawing it, and holds it: a role is offered the page only
 * when it is granted everything the page reads and runs (or the roles it names must be), its path joins the App's
 * addresses, and authority.lock records its reads, commands and loader. The hooks bound to the definition read and
 * run only what it declares — `page.useRows('order_line')` is a type error until `reads` names it — and every
 * request is still authorized by the server as any other: role grants, field projection, row policy, tenancy.
 *
 * The loader (`export const loaders = defineLoaders({ … })` in the commands module, @mistriwork/mistri/commands) runs on the
 * server for the reader, read-only and bounded; its result is the page's `data`, typed from it once `mistri
 * check` has generated mistri-commands.d.ts. A component that names its own return type (`: ReactNode`) lets
 * the page's hooks be typed from the definition it is part of.
 */
import type * as ReactTypes from 'react';
import type { AppIcon, AppMessageRef, CommandName, Register } from './app.js';
import type { CommandOutcome, CommandUnavailable, UiQuery, UiRow } from './ui.js';
export { Button, Card, Columns, Empty, Heading, Row, Stack, Stat, Value } from './ui.js';

/* ---------- what the App's generated types register ---------- */

type Registered<K extends string> = Register extends { [P in K]: infer V } ? V : never;
type SchemaColumns = Register extends { schema(): { columns: infer C } } ? C : never;
type Loaders = Registered<'loaders'>;

/** A resource of the App, by its name: the generated schema's tables, or any name before there is one. */
export type ResourceName = [SchemaColumns] extends [never] ? string : Extract<keyof SchemaColumns, string>;
/** A column of a resource, or a label path through a reference (`warehouse_id.name`). */
export type ColumnPath<T extends string> = [SchemaColumns] extends [never]
  ? string
  : T extends keyof SchemaColumns
    ? (keyof SchemaColumns[T] & string) | `${keyof SchemaColumns[T] & string}.${string}`
    : string;
/** A page loader of the App, by its name: the commands module's `loaders`. */
export type LoaderName = [Loaders] extends [never] ? string : Extract<keyof Loaders, string>;
/** What a loader returns, by its name: a page's `data`. */
export type LoaderData<L extends string> = [Loaders] extends [never]
  ? unknown
  : L extends keyof Loaders
    ? Loaders[L] extends { readonly load: (...args: never[]) => infer R } ? Awaited<R> : unknown
    : unknown;

/** What a page's component is drawn with: the result of the loader it names (`PageProps<'pickWalk'>`), and its placement's props. */
export interface PageProps<L extends string = never> {
  data: [L] extends [never] ? null : LoaderData<L>;
  props: Readonly<Record<string, unknown>>;
}

/** A command as a page holds it (`page.useCommand`): the one command pipeline, never a write of its own. */
export interface PageCommand {
  label: string;
  /** Whether this reader may run it at all: signed in, granted it, and offered it. */
  granted: boolean;
  /** Whether it is available on this record now; undefined until the server has said. */
  available(record: Readonly<Record<string, unknown>>): boolean | undefined;
  reason(record: Readonly<Record<string, unknown>>): CommandUnavailable | undefined;
  pending(record: Readonly<Record<string, unknown>>): boolean;
  /** Run it. On a public page, a public command is run through the page's own door as the public principal, whoever
      is signed in: `run({}, input)` — its `output` is `{ reference, receipt }` — and `challenge` carries the token the
      page's human check gave, where the App names one (`auth.challenge`). */
  run(record: Readonly<Record<string, unknown>>, input?: Readonly<Record<string, unknown>>, options?: { label?: string; challenge?: string }): Promise<CommandOutcome>;
  open(record: Readonly<Record<string, unknown>>, input?: Readonly<Record<string, unknown>>, options?: { label?: string; challenge?: string }): Promise<CommandOutcome>;
  /** The choices one of its inputs offers, as served with the command. On a public page a choice from a table
      (`field.choice({ from })`) comes with its rows, read as the public reads them and kept until one changes, so the
      page draws its own select with no read of its own: `enrol.choices('make')`. Undefined for an input that offers none. */
  choices(field: string): ReadonlyArray<{ value: string | number | boolean; label: string }> | undefined;
}

/** A page as `definePage` makes it: the component that draws it, and its hooks, held to what it declares. */
export interface PageDefinition<R extends string, C extends string, P extends string, L extends string> {
  (props: PageProps<L>): ReactTypes.ReactNode;
  readonly definition: { readonly label: string | AppMessageRef; readonly reads: readonly R[]; readonly commands?: readonly C[];
    readonly params?: readonly P[]; readonly loader?: L };
  /** Rows of one of the page's reads: `page.useRows('pick_list', { show: ['id', 'reference'], query: 'status = to_pick' })`. */
  useRows<T extends R>(resource: T, options?: { show?: readonly ColumnPath<T>[]; query?: string; sort?: string; limit?: number; enabled?: boolean }): UiQuery<UiRow[]>;
  /** One record of one of the page's reads, by its key; null when there is none, not asked while the key is undefined. */
  useRecord<T extends R>(resource: T, key: Readonly<Record<string, unknown>> | undefined, show?: readonly ColumnPath<T>[]): UiQuery<UiRow | null>;
  /** One of the page's reads grouped and measured: `page.useBreakdown('pick_list', { by: 'status' })`. */
  useBreakdown<T extends R>(resource: T, options: { by: ColumnPath<T>; measure?: string; query?: string; limit?: number }): UiQuery<UiRow[]>;
  /** Where one of the page's file resources serves a row, for an `<img>`. */
  useFile<T extends R>(resource: T): (key: Readonly<Record<string, unknown>>, options?: { thumbnail?: boolean }) => string | undefined;
  /** One of the page's commands: `page.useCommand('pickList')`. */
  useCommand(command: C): PageCommand;
  /** One of the page's address parameters, read and written: `/{app}/pick-walk?list=12`. A change refines the place the reader is
      on, unless `{ push: true }` makes it a step Back returns from. */
  useParam(name: P): [string | undefined, (value: string | number | undefined, options?: { push?: boolean }) => void];
}

/**
 * A free-form page: `export default definePage({ label, reads, component })` in `pages/<path>.page.tsx`. The path is the
 * file's name and the page's address (`/{app}/<path>`); `label` is what the menu and the heading call it (text, or `msg('…')` said in the reader's language, as a view's), `icon` its mark
 * in the menu, as a view's; `nav` places it in the App's menu (`false` keeps it out; `position` is its place among its
 * neighbors, from 0), `roles`
 * narrows who is offered it, `public: true` opens it to signed-out visitors within `auth.public`.
 */
export declare function definePage<
  const R extends ResourceName,
  const C extends CommandName = never,
  const P extends Lowercase<string> = never,
  const L extends LoaderName = never,
>(definition: {
  label: string | AppMessageRef;
  icon?: AppIcon;
  description?: string | AppMessageRef;
  nav?: false | { group?: string; position?: number };
  roles?: readonly string[];
  public?: true;
  favorite?: boolean;
  reads: readonly R[];
  commands?: readonly C[];
  params?: readonly P[];
  loader?: L;
  component: (props: PageProps<L>) => ReactTypes.ReactNode;
}): PageDefinition<R, C, P, L>;

/** A free-form page's place, kept in its address: `const [list, setList] = useAddressState('list')` for `/{app}/pick-walk?list=12`. The name
    is one of the page's `params` (`page.useParam` is this hook, typed to them; this one serves a module the page draws); a change refines the place the reader is on, unless
    `{ push: true }` makes it a step Back returns from. */
export declare function useAddressState(name: string): [string | undefined, (value: string | number | undefined, options?: { push?: boolean }) => void];

/**
 * A command's own form, behind a button: `<CommandForm command="releaseOrder" />`, or on one record,
 * `<CommandForm command="pickList" record={{ id: 12 }} />`. The platform's dialog and the one pipeline; not drawn for a reader
 * who may not run the command. The command is one of the page's `commands`.
 */
export declare function CommandForm(props: {
  command: CommandName;
  record?: Readonly<Record<string, unknown>>;
  label?: ReactTypes.ReactNode;
  intent?: 'primary' | 'secondary' | 'quiet';
  onDone?: (outcome: CommandOutcome) => void;
}): ReactTypes.ReactElement | null;

/** A block's place in the page's grid, as a dashboard section's: the whole width, half, a third or two thirds. */
export type BlockWidth = 'full' | 'half' | 'third' | 'two-thirds';

/** The page's grid: blocks and panels side by side by their `width`, wrapping as a dashboard's sections do. */
export declare function Grid(props: { children?: ReactTypes.ReactNode }): ReactTypes.ReactElement;
/** A titled region of the grid: `<Panel title="Open lines" width="half">…</Panel>`. */
export declare function Panel(props: { title?: ReactTypes.ReactNode; width?: BlockWidth; children?: ReactTypes.ReactNode }): ReactTypes.ReactElement;
/** Tabs, each panel drawn the first time it is opened; `param` (one of the page's `params`) keeps the open tab in the
    address: `<Tabs param="tab" tabs={[{ key: 'open', label: 'Open', content: <Rows … /> }]} />`. */
export declare function Tabs(props: {
  tabs: readonly { key: string; label: ReactTypes.ReactNode; content: ReactTypes.ReactNode }[];
  param?: string;
  label?: string;
}): ReactTypes.ReactElement;

/* The platform's sections as components: each takes its DSL helper's words as props, `from` for its resource, and
   reads only a resource the page declares in `reads`. */

/** A dashboard's rows, `rows()`: `<Rows title="Closing soon" from="opportunity" show={['name', 'amount']} sort="close_date" limit={10} />`. */
export declare function Rows<const R extends ResourceName>(props: {
  title: string;
  from: R;
  query?: string;
  show?: readonly ColumnPath<R>[];
  sort?: string;
  limit?: number;
  sizing?: 'fit' | 'scroll';
  width?: BlockWidth;
}): ReactTypes.ReactElement;
/** One number over a resource, `metric()`: `<Metric title="Open" from="ticket" query="status = open" compare="previous period" better="down" />`. */
export declare function Metric<const R extends ResourceName>(props: {
  title: string;
  from: R;
  query?: string;
  measure?: string;
  compare?: string;
  better?: 'up' | 'down';
  format?: 'percent' | 'number' | 'money' | 'duration';
  unit?: string;
  target?: number | { from?: ResourceName; query?: string; measure?: string };
  width?: BlockWidth;
}): ReactTypes.ReactElement;
/** A chart, `chart()`: `<Chart title="Bookings" from="opportunity" by="month close_date" measure="sum amount" />`. */
export declare function Chart<const R extends ResourceName>(props: {
  title: string;
  from: R;
  by: string;
  query?: string;
  measure?: string;
  shape?: 'line' | 'bar' | 'donut' | 'stacked' | 'scatter' | 'heatmap' | 'waterfall' | 'treemap';
  x?: string;
  curve?: 'smooth' | 'straight';
  total?: string;
  target?: number;
  limit?: number;
  height?: number;
  /** How its figures are said where the measure's column has no rule to say them: `'duration'` reads seconds as "10h 2m". */
  format?: 'percent' | 'number' | 'money' | 'duration';
  /** A short word said after each figure, like "days". */
  unit?: string;
  width?: BlockWidth;
}): ReactTypes.ReactElement;
/** Groups measured as bars, `breakdown()`: `<Breakdown title="By priority" from="ticket" by="priority" measure="avg first_response_seconds" format="duration" />`. */
export declare function Breakdown<const R extends ResourceName>(props: {
  title: string;
  from: R;
  by: string;
  query?: string;
  measure?: string;
  limit?: number;
  /** How its figures are said where the measure's column has no rule to say them: `'duration'` reads seconds as "10h 2m". */
  format?: 'percent' | 'number' | 'money' | 'duration';
  /** A short word said after each figure, like "days". */
  unit?: string;
  width?: BlockWidth;
}): ReactTypes.ReactElement;
/** One record as its page shows it, its name and verbs over its fields (or `show`'s): `<RecordCard from="account" record={{ id: 12 }} />`. */
export declare function RecordCard<const R extends ResourceName>(props: {
  from: R;
  record: Readonly<Record<string, unknown>>;
  show?: readonly ColumnPath<R>[];
}): ReactTypes.ReactElement;
/** A record's timeline, as its page declares it: `<Timeline from="ticket" record={{ id: 7 }} />`. */
export declare function Timeline(props: { from: ResourceName; record: Readonly<Record<string, unknown>> }): ReactTypes.ReactElement;
/** Rows as a tree by a parent reference, the `tree()` presentation: `<Tree from="category" parent="parent_id" primary="name" />`. */
export declare function Tree<const R extends ResourceName>(props: {
  from: R;
  parent: ColumnPath<R>;
  primary: ColumnPath<R>;
  /** One line said quietly beside the primary. */
  lines?: readonly [ColumnPath<R>];
  query?: string;
}): ReactTypes.ReactElement;
/** Rows as bars between two dates, the `gantt()` presentation: `<Gantt from="task" start="starts_on" end="due_on" primary="name" />`. */
export declare function Gantt<const R extends ResourceName>(props: {
  from: R;
  start: ColumnPath<R>;
  end: ColumnPath<R>;
  primary: ColumnPath<R>;
  by?: ColumnPath<R>;
  progress?: ColumnPath<R>;
  query?: string;
}): ReactTypes.ReactElement;
/** The App's assistant, as its own page draws it (where the App declares one): `<Assistant />`. */
export declare function Assistant(props: { conversation?: string }): ReactTypes.ReactElement | null;
