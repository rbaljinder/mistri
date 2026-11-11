/**
 * `@mistriwork/mistri/page`: a free-form page of the App's own, one file each — `pages/<path>.page.tsx` in the App directory.
 *
 *   import { definePage, Empty, Stack, type PageProps } from '@mistriwork/mistri/page';
 *   const page = definePage({
 *     label: 'Pick walk', icon: 'list-checks', nav: { group: 'floor' },
 *     reads: ['pick_list'], commands: ['pickList'], params: { list: 'id' }, loader: 'pickWalk',
 *     component: PickWalk,
 *   });
 *   export default page;
 *   function PickWalk({ data }: PageProps<'pick-walk'>): ReactNode {
 *     const [list, setList] = page.useParam('list');
 *     const lists = page.useRows('pick_list', { show: ['id', 'reference'], where: { status: 'to_pick' } });
 *     …
 *   }
 *
 * Rows are typed from the generated schema by what `show` names (`lists.data[0].reference` is a string, and a column
 * not shown is a type error), a `where` is typed against the resource's columns, and a param declared with a kind
 * (`params: { list: 'id' }`) is read back as that kind. This entry point is the whole of what a page draws with:
 * everything `@mistriwork/mistri/ui` exports, the page's own blocks, and the house controls of `@mistriwork/ui`.
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
import type {
  ActionName,
  AppBoardList,
  AppCalendarList,
  AppCardsList,
  PageIcon,
  AppMessageRef,
  AppSplitListDetail,
  CommandInputName,
  CommandName,
  CommandOutputOf,
  FormViewCommand,
  Register,
} from './app.js';
import type {
  CommandOutcome,
  CommandRefusal,
  CommandReview,
  CommandRunOptions,
  CommandUnavailable,
  LoaderPageProps,
  PageProps,
  UiQuery,
  UiRefusable,
  UiRow,
  UiRowsQuery,
} from './ui.js';
/* Everything a custom component imports, so a page has one import path; `useRows` and `useRecord` are declared again
   below, typed from the schema, and a module's own declaration stands over the one `export *` brings. */
export * from './ui.js';
/* The house controls, drawn as the shell draws its own (the page loads their stylesheet with them). Preview, as they
   are in @mistriwork/ui. */
export {
  Avatar,
  CheckCards,
  Checkbox,
  ChoiceCards,
  DateField,
  Drawer,
  FileField,
  Modal,
  Pagination,
  Popover,
  Select,
  Slider,
  Switch,
  TextField,
  Tooltip,
  YesNo,
  type AvatarProps,
  type AvatarSize,
  type CheckCard,
  type CheckCardsProps,
  type CheckboxProps,
  type ChoiceCardsProps,
  type ChoiceOption,
  type DateFieldProps,
  type DrawerProps,
  type DrawerSide,
  type FileFieldProps,
  type ModalHandle,
  type PaginationProps,
  type PopoverProps,
  type SliderProps,
  type SwitchProps,
  type TextFieldProps,
  type TooltipProps,
  type YesNoProps,
} from '@mistriwork/ui';
/**
 * An App's control kit (Preview): the module `uiKit` names exports `defineUiKit({ Button, Modal, … })`, each slot
 * drawn with the props the platform's own control takes; `defaultUiKit` holds those defaults, to dress rather than
 * replace one. `mistri check` refuses a slot name the kit does not have.
 */
export { defineUiKit, defaultUiKit, type SlotName, type UiKit, type UiKitSlots } from '@mistriwork/ui';

/* ---------- what the App's generated types register ---------- */

type Registered<K extends string> = Register extends { [P in K]: infer V } ? V : never;
type SchemaColumns = Register extends { schema(): { columns: infer C } } ? C : never;
type SchemaRows = Register extends { schema(): { rows: infer W } } ? W : never;
type SchemaReferences = Register extends { schema(): { references: infer F } } ? F : never;
type SchemaKeys = Register extends { schema(): { keys: infer K } } ? K : never;
type Loaders = Registered<'loaders'>;
type TableName = Extract<keyof SchemaColumns, string>;
/* One table's column kinds, stored row and references, or nothing for a name the schema does not have. */
type KindsOf<T> = T extends keyof SchemaColumns ? SchemaColumns[T] : {};
type RowsOf<T> = T extends keyof SchemaRows ? SchemaRows[T] : {};
type RefsOf<T> = T extends keyof SchemaReferences ? SchemaReferences[T] : {};

/** A view of the App by its key, as the generated types list them; any text before there are any. */
type ViewKeyName = [Registered<'views'>] extends [never] ? string : Extract<Registered<'views'>, string>;
/** A free-form page by its path, as the generated types list them; any text before there are any. */
type PagePathName = [Registered<'pagePaths'>] extends [never] ? string : Extract<Registered<'pagePaths'>, string>;

/** The tab words a record of one view opens on, as the generated types list them (`RecordTabs`); any text before there are any. */
type RecordTabName<V extends string> = [Registered<'tabs'>] extends [never]
  ? string
  : V extends keyof Registered<'tabs'>
    ? Extract<Registered<'tabs'>[V], string>
    : never;

/** The key that names one record of a resource, by its primary-key columns (`{ id: number }`); any object before the
    generated types say which columns those are. */
export type RecordKey<T extends string> = [SchemaKeys] extends [never]
  ? Readonly<Record<string, unknown>>
  : T extends keyof SchemaKeys
    ? { readonly [C in SchemaKeys[T] & string]: C extends keyof RowsOf<T> ? RowsOf<T>[C] : unknown }
    : Readonly<Record<string, unknown>>;

/** A resource of the App, by its name: the generated schema's tables, or any name before there is one. */
export type ResourceName = [SchemaColumns] extends [never] ? string : Extract<keyof SchemaColumns, string>;
/** A column of a resource, or a label path through a reference (`warehouse_id.name`). */
export type ColumnPath<T extends string> = [SchemaColumns] extends [never]
  ? string
  : [T] extends [never]
    ? string
    : T extends keyof SchemaColumns
      ? (keyof SchemaColumns[T] & string) | `${keyof SchemaColumns[T] & string}.${string}`
      : string;

/* ---------- rows, conditions and params, typed from the schema ---------- */

/* What a column holds, by its kind, where the stored row does not say (a rollup, a computed column): a number past
   2^53 or a numeric arrives as text, so it is a number or a string, never something to run through Number(). */
type KindValue<K> = K extends 'number'
  ? number | string
  : K extends 'boolean'
    ? boolean
    : K extends 'text' | 'date'
      ? string
      : K extends readonly string[]
        ? string
        : unknown;
type ColumnValue<T, C extends string> = C extends keyof RowsOf<T>
  ? RowsOf<T>[C]
  : C extends keyof KindsOf<T>
    ? KindValue<KindsOf<T>[C]> | null
    : unknown;
/* A label path follows each reference to the table it lands on; the record may point at nothing, so a hop may be null. */
type PathValue<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof RefsOf<T>
    ? PathValue<RefsOf<T>[Head], Rest> | null
    : unknown
  : ColumnValue<T, P>;
/* A path's value in whichever of the tables it could be read from: a block that inherits its resource from a Scope is
   typed against every table (JSX carries no type down), so a column two tables share is the union of their types. */
type ValueIn<T, P extends string> = T extends string ? (P extends ColumnPath<T> ? PathValue<T, P> : never) : never;
/* The resource a block reads: the one it names, or, inheriting a Scope's, any of the App's. */
type Reading<R extends string> = [R] extends [never] ? TableName : R;

/**
 * One row as a read returns it: the paths `show` names, each typed from the generated rows (an id past 2^53
 * is a string — never run one through Number()), and the resource's key column(s), which `List` and `useRows` always
 * read beside `show`. Without `show`, every column of the resource. Any other column the read did not show is a type
 * error, because it is not there.
 */
export type PageRow<T extends string, S extends readonly string[] = readonly []> = [SchemaColumns] extends [never]
  ? UiRow
  : S extends readonly []
    ? [T] extends [never]
      ? UiRow
      : { readonly [C in Extract<keyof KindsOf<T> | keyof RowsOf<T>, string>]: ValueIn<T, C> }
    : { readonly [P in S[number]]: ValueIn<Reading<T>, P> } & KeyOf<T>;
/* The key column(s) a read adds beside `show`. Untyped where the resource is not one name (a List inside a Scope, without its own `from`: the runtime still sends the key) or the types are not generated. */
type KeyOf<T extends string> = [SchemaKeys] extends [never] ? {} : [T] extends [never] ? {} : RecordKey<T>;

/* The value a condition compares a column with, by the column's kind: a number column takes a number or its digits
   (an id past 2^53 is digits), a vocabulary one of its words. */
type WhereValue<K> = K extends 'number'
  ? number | `${number}` | `${bigint}`
  : K extends 'boolean'
    ? boolean
    : K extends 'text' | 'date'
      ? string
      : K extends readonly (infer Word extends string)[]
        ? Word
        : string | number | boolean;
type WhereOperators<K> = {
  /** Anything but this value, or than any of these; `{ not: null }` is "is not empty". */
  readonly not?: WhereValue<K> | null | readonly WhereValue<K>[];
} & (K extends 'boolean'
  ? {}
  : { readonly gt?: WhereValue<K>; readonly gte?: WhereValue<K>; readonly lt?: WhereValue<K>; readonly lte?: WhereValue<K> }) &
  (K extends 'number' | 'boolean' | 'date'
    ? {}
    : { readonly contains?: string; readonly startsWith?: string; readonly endsWith?: string });
/** One column's condition: equal to a value, empty (`null`), one of a list, or the operators of `WhereOperators`. */
export type WhereCondition<K> = WhereValue<K> | null | readonly WhereValue<K>[] | WhereOperators<K>;
type KindAt<T, C> = T extends string ? (C extends keyof KindsOf<T> ? KindsOf<T>[C] : never) : never;
type WhereColumn<T> = T extends string ? Extract<T extends keyof SchemaRows ? keyof SchemaRows[T] : keyof KindsOf<T>, string> : never;

/**
 * A condition as an object, every key one of the resource's columns and every value of that column's kind:
 * `{ status: 'booked', class_session_id: classId, party_size: { gt: 1 } }`. Keys are joined by "and"; an undefined
 * value is left out, so `{ class_session_id: classId }` asks for every class while none is chosen. It is the same
 * condition the query language says (`status = "booked" and party_size > 1`), and the server refuses a column or an
 * operator the resource does not have rather than drop it.
 */
export type Where<T extends string> = [SchemaColumns] extends [never]
  ? Readonly<Record<string, unknown>>
  : { readonly [C in WhereColumn<Reading<T>>]?: WhereCondition<KindAt<Reading<T>, C>> | undefined };

/** What a page param holds: an id, any text, a day (`2026-11-08`), a run of days (`2026-11-01..2026-11-08`, either end
    open: `..2026-11-08`), or one of a few words. */
export type ParamKind = 'id' | 'text' | 'date' | 'date-range' | readonly [string, ...string[]];
/** A param's value as `useParam` gives it, already checked: an id is a number (its digits past 2^53), or, where the
    param is named for a resource the page reads and that resource's key is text, URL-safe text (`TextKey` true; either
    while the generated types do not say); a day is `YYYY-MM-DD`, a list of words one of them. An address that does not
    fit reads as undefined. */
export type ParamValue<K, TextKey extends boolean = false> = K extends 'id'
  ? [TextKey] extends [true]
    ? string
    : [TextKey] extends [false]
      ? number | `${bigint}`
      : number | string
  : K extends readonly (infer Word extends string)[]
    ? Word
    : string;
/* What a param's setter takes: its kind, and a text param a number as well. */
type ParamInput<K, TextKey extends boolean = false> = K extends 'id' | readonly string[] ? ParamValue<K, TextKey> : string | number;
/* A resource's key column when it has exactly one, as the runtime reads an id param by it (paramKinds.ts `idKeyOf`). */
type KeyColumns<T> = T extends keyof SchemaKeys ? Extract<SchemaKeys[T], string> : never;
type OnlyKey<T, C extends string = KeyColumns<T>> = [{ [X in C]: Exclude<C, X> }[C]] extends [never] ? C : never;
/* Whether an id param holds text: only one named for a resource the page reads whose one key column is text; a count-up
   table, or a param naming no table, holds an integer. Before the generated types say, it could be either. */
type TextKeyed<N, R> = N extends R
  ? [SchemaKeys] extends [never]
    ? boolean
    : [OnlyKey<N>] extends [never]
      ? false
      : [KindAt<N, OnlyKey<N>>] extends ['text']
        ? true
        : false
  : false;
type ParamsDeclared = readonly Lowercase<string>[] | { readonly [name: string]: ParamKind };
/* An address's parameters are lower case (the server refuses others): a declared name that is not says so where it is written. */
type LowercaseNames<PD> = PD extends readonly string[] ? unknown : { readonly [N in keyof PD]: N extends Lowercase<N & string> ? ParamKind : never };
type ParamNames<PD> = PD extends readonly (infer Name extends string)[] ? Name : Extract<keyof PD, string>;
type ParamKinds<PD> = PD extends readonly string[] ? { readonly [N in PD[number]]: 'text' } : PD;
/** What a public command answers a public page (`run({}, input)`): the reference to quote and the receipt, never the input. */
export interface PublicCommandReceipt { reference: string; receipt: { id: string; status: 'applied' } }
/* A public command runs only through a public page's door, which answers its receipt; any other, its declared `output`. */
type PageCommandOutput<N extends string> = Register extends { commands: infer C }
  ? N extends keyof C ? C[N] extends { public: true } ? PublicCommandReceipt : CommandOutputOf<N> : CommandOutputOf<N>
  : CommandOutputOf<N>;
/* A form's input names, by its view's command; any text where the generated file does not name the view. */
type FormInput<View extends string> = [FormViewCommand<View>] extends [never] ? string : CommandInputName<FormViewCommand<View>>;
/** A page loader of the App, by its name: the commands module's `loaders`. */
export type LoaderName = [Loaders] extends [never] ? string : Extract<keyof Loaders, string>;

/** A command as a page holds it (`page.useCommand`): the one command pipeline, never a write of its own. `Output` is
    what an applied run returns, typed from the command's declared `output`. */
export interface PageCommand<Input extends string = string, Output = unknown> {
  label: string;
  /** Whether this reader may run it at all: signed in, granted it, and offered it. */
  granted: boolean;
  /** Whether it is available on this record now; undefined until the server has said. */
  available(record: Readonly<Record<string, unknown>>): boolean | undefined;
  reason(record: Readonly<Record<string, unknown>>): CommandUnavailable | undefined;
  pending(record: Readonly<Record<string, unknown>>): boolean;
  /** Run it. On a public page, a public command is run through the page's own door as the public principal, whoever
      is signed in: `run({}, input)` — applied, its `output` is `{ reference, receipt }` and its `message` a thank-you
      naming the reference, for the page to show or to follow with `useNavigate()` — and `challenge` carries the token
      the page's human check gave, where the App names one (`auth.challenge`). */
  run(record: Readonly<Record<string, unknown>>, input?: Readonly<Partial<Record<Input, unknown>>>, options?: CommandRunOptions): Promise<CommandOutcome<Output>>;
  open(record: Readonly<Record<string, unknown>>, input?: Readonly<Partial<Record<Input, unknown>>>, options?: CommandRunOptions): Promise<CommandOutcome<Output>>;
  /** What a review shows before the person confirms (`{}` for a command that names no record): the values it starts
      from, `input` over them, and a token pinning a run to this revision. `run(record, input, { review })` then runs
      exactly that or is refused `code: 'stale'`, never retried; a run without one prepares again quietly. */
  prepare(record?: Readonly<Record<string, unknown>>, input?: Readonly<Partial<Record<Input, unknown>>>): Promise<CommandReview<Input> | CommandRefusal>;
  /** Whether the last review `prepare` gave still stands: false once a change to its record reaches the page; true without one. */
  reviewFresh: boolean;
  /** The choices one of its inputs offers, as served with the command. On a public page a choice from a table
      (`field.choice({ from })`) comes with its rows, read as the public reads them and kept until one changes, so the
      page draws its own select with no read of its own: `enrol.choices('make')`. Undefined for an input that offers none. */
  choices(field: Input): ReadonlyArray<{ value: string | number | boolean; label: string }> | undefined;
}

/** How a form a page opened ended: submitted and done, received under a reference, still being processed, left with
    saved steps, or closed with nothing saved. */
export type PageFormOutcome =
  | { status: 'done'; message?: string }
  | { status: 'received'; reference: string; message?: string }
  | { status: 'processing'; message: string }
  | { status: 'saved'; saved: readonly string[] }
  | { status: 'closed' };

/** A form view as a page holds it (`page.useForm`): its draft, read as the form's own layout resumes it, and the form
    itself. Every submit is still granted by the server. */
export interface PageForm<Input extends string = string> {
  label: string;
  /** Whether this reader is served the form; one that is not (or a public form) opens as `openForm` does. */
  granted: boolean;
  steps: ReadonlyArray<{ id: string; label: string }>;
  /** The open draft; null without one. */
  resume: { saved: readonly string[]; step: string | null; expiresAt: string | null } | null;
  /** The step the form reopens at, or the first not saved; null at the review, or without a draft. */
  step: string | null;
  saved: readonly string[];
  /** The draft holds saved steps not yet submitted. */
  dirty: boolean;
  expiresAt: string | null;
  /** A submit was sent and its result is not known yet: `startOver()` refuses until it is. */
  pending: boolean;
  /** How the form ended the last time this page opened it; null before. */
  outcome: PageFormOutcome | null;
  isPending: boolean;
  error: Error | null;
  isFetching: boolean;
  isStale: boolean;
  refreshError: Error | null;
  /** The form over the page, filled with `input` (its command's inputs, by name); `at` opens a draft at a step it has
      reached, as `goTo` does. Resolves as it closes. */
  open(input?: Readonly<Partial<Record<Input, unknown>>>, options?: { at?: string }): Promise<PageFormOutcome>;
  /** The form opened at a step its draft has reached; never past the first not saved. */
  goTo(step: string): Promise<PageFormOutcome>;
  /** The draft discarded, as the form's Start over does; false while a submit is pending, or without a draft. */
  startOver(): Promise<boolean>;
}

/** A page as `definePage` makes it: the component that draws it, and its hooks, held to what it declares. */
export interface PageDefinition<
  R extends string,
  C extends string,
  P extends string,
  L extends string,
  A extends string = never,
  K extends { readonly [N in P]?: ParamKind } = { readonly [N in P]: 'text' },
  F extends string = never,
> {
  (props: LoaderPageProps<L>): ReactTypes.ReactNode;
  readonly definition: { readonly label: string | AppMessageRef; readonly reads: readonly R[]; readonly commands?: readonly C[];
    readonly actions?: readonly A[]; readonly forms?: readonly F[]; readonly params?: readonly P[] | K; readonly loader?: L };
  /** Rows of one of the page's reads, each typed by what `show` names:
      `page.useRows('pick_list', { show: ['id', 'reference'], where: { status: 'to_pick' }, sort: 'reference' })`. */
  useRows<T extends R, const S extends readonly ColumnPath<T>[] = readonly []>(resource: T, options: RowsOptions<T, S> & { optional: true }): UiRowsQuery<PageRow<T, S>> & UiRefusable;
  useRows<T extends R, const S extends readonly ColumnPath<T>[] = readonly []>(resource: T, options?: RowsOptions<T, S> & { optional?: false }): UiRowsQuery<PageRow<T, S>>;
  /** One record of one of the page's reads, by its key; null when there is none, not asked while the key is undefined. */
  useRecord<T extends R, const S extends readonly ColumnPath<T>[] = readonly []>(
    resource: T,
    key: Readonly<Record<string, unknown>> | undefined,
    show: S | undefined,
    options: { optional: true },
  ): UiQuery<PageRow<T, S> | null> & UiRefusable;
  useRecord<T extends R, const S extends readonly ColumnPath<T>[] = readonly []>(
    resource: T,
    key: Readonly<Record<string, unknown>> | undefined,
    show?: S,
    options?: { optional?: false },
  ): UiQuery<PageRow<T, S> | null>;
  /** The key of the record a page is a tab of (`pages/accounts/[id]/map.page.tsx` at `/compass/accounts/13/map` is
      `{ id: 13 }`), typed by the resource's primary key: `page.useRecord('account', page.useRecordKey('account'))`.
      The resource is the record's own; any other, or a page that is not a record's tab, throws. */
  useRecordKey<T extends R>(resource: T): RecordKey<T>;
  /** One of the page's reads grouped and measured: `page.useBreakdown('pick_list', { by: 'status' })`. */
  useBreakdown<T extends R>(resource: T, options: { by: ColumnPath<T>; measure?: string; query?: string; limit?: number; optional: true }): UiQuery<UiRow[]> & UiRefusable;
  useBreakdown<T extends R>(resource: T, options: { by: ColumnPath<T>; measure?: string; query?: string; limit?: number; optional?: false }): UiQuery<UiRow[]>;
  /** Where one of the page's file resources serves a row, for an `<img>`. */
  useFile<T extends R>(resource: T): (key: Readonly<Record<string, unknown>>, options?: { thumbnail?: boolean }) => string | undefined;
  /** One of the page's commands: `page.useCommand('pickList')`, its input typed by the command's declared inputs. */
  useCommand<const N extends C>(command: N): PageCommand<CommandInputName<N>, PageCommandOutput<N>>;
  /** One of the page's fixed actions, a machine's verb or `action(label, { set })` on a resource it reads: `page.useAction('startVisit')`.
      The record page's own button, run on a record of the resource by its key: `run(record)` asks first when the action says
      `confirm`, is refused when the record's state does not allow it, and takes no input. */
  useAction(action: A): PageCommand;
  /** One of the form views the page opens (`forms`): `page.useForm('apply')` — "Continue your application" from the
      draft the form itself resumes, `open()`, `goTo(step)`, `startOver()`, and how the last opening ended. */
  useForm<const N extends F>(form: N): PageForm<FormInput<N>>;
  /** One of the page's address parameters, read as its declared kind and written: `/{app}/pick-walk?list=12` is `12` for
      `params: { list: 'id' }`, and an address that does not fit the kind reads as undefined. A change refines the place
      the reader is on, unless `{ push: true }` makes it a step Back returns from. */
  useParam<N extends P>(
    name: N,
  ): [
    ParamValue<N extends keyof K ? K[N] : 'text', TextKeyed<N, R>> | undefined,
    (value: ParamInput<N extends keyof K ? K[N] : 'text', TextKeyed<N, R>> | undefined, options?: { push?: boolean }) => void,
  ];
  /** `Choose` held to this page: `param` is one of its params (one of a few words, when no `from` is named), `from` one of its
      reads, `value`, `label` and `sort` columns of that read. A type error otherwise. */
  Choose: {
    <T extends R>(props: ChooseProps<ParamsOfKind<P, K, 'id' | 'text' | readonly string[]>> & ChooseRows<T>): ReactTypes.ReactElement;
    (props: ChooseProps<ParamsOfKind<P, K, readonly string[]>> & { from?: undefined }): ReactTypes.ReactElement;
  };
  /** `Search` held to this page: `param` is one of its text params. */
  Search(props: SearchProps<ParamsOfKind<P, K, 'text'>>): ReactTypes.ReactElement;
  /** `DateRange` held to this page: `param` is one of its params of kind `'date-range'`. */
  DateRange(props: DateRangeProps<ParamsOfKind<P, K, 'date-range'>>): ReactTypes.ReactElement;
  /** `Steps` held to this page: `command` is one of its commands, each step's `inputs` that command's declared inputs, and
      `param` one of its text params or a list of words. A type error otherwise. */
  Steps<const N extends C>(props: StepsProps<N, ParamsOfKind<P, K, 'text' | readonly string[]>>): ReactTypes.ReactElement | null;
}

/* The params of a kind: the names whose declared kind is (a subtype of) `Kind`. A page declared with a list of names has
   text params. */
type ParamsOfKind<P extends string, K, Kind> = { [N in P]: N extends keyof K ? ([K[N]] extends [Kind] ? N : never) : never }[P];
type SortOf<T extends string> = ColumnPath<T> | `${ColumnPath<T>} asc` | `${ColumnPath<T>} desc`;

/** What every `Choose` takes. */
export interface ChooseProps<P extends string = string> {
  /** One of the page's `params`: the address is the control's state, so Back and a pasted link restore it. */
  param: P;
  /** Names the control for assistive technology; the param's name when absent. */
  name?: string;
  /** Present, a first choice with this word that clears the param (a param is optional; the control says so only when asked). */
  all?: string;
}
/** A `Choose` whose options are the rows of a read of the page: the value is `value`'s column (`id`), what an option says is `label`. */
export interface ChooseRows<T extends string> {
  from: T;
  where?: Where<T>;
  query?: string;
  sort?: SortOf<T>;
  limit?: number;
  /** The column that is the param's value; `id` unless said. */
  value?: ColumnPath<T>;
  /** What an option says: a column path, or a function of the row (all its columns; a column that may be empty may be said as nothing). The value when absent. */
  label?: ColumnPath<T> | ((row: PageRow<T>) => string | null | undefined);
  /** Said instead of the control while the read has no rows. */
  empty?: ReactTypes.ReactNode;
}
export interface SearchProps<P extends string = string> {
  param: P;
  name?: string;
  placeholder?: string;
  /** Milliseconds of quiet before what is typed reaches the address; 300 unless said. */
  delay?: number;
}
export interface DateRangeProps<P extends string = string> {
  param: P;
  name?: string;
}

/** What a read of rows asks: the paths it shows, its condition (`where`, `query` or both, joined by "and"), its order and
    how many. `enabled: false` asks nothing yet. */
export interface RowsOptions<T extends string, S extends readonly string[] = readonly string[]> {
  show?: S;
  where?: Where<T>;
  query?: string;
  sort?: string;
  limit?: number;
  enabled?: boolean;
}

/**
 * A free-form page: `export default definePage({ label, reads, component })` in `pages/<path>.page.tsx`. The path is the
 * file's name and the page's address (`/{app}/<path>`); `label` is what the menu and the heading call it (text, or `msg('…')` said in the reader's language, as a view's), `icon` its mark
 * in the menu, as a view's; `nav` places it in the App's menu (`false` keeps it out; `position` is its place among its
 * neighbors, from 0), `roles`
 * narrows who is offered it, `public: true` opens it to signed-out visitors within `auth.public`; `head` is the form its
 * head takes (`'compact'`, or `false` where the component draws its own); `layout: 'bare'` takes the shell's bars away.
 */
export declare function definePage<
  const R extends ResourceName,
  const C extends CommandName = never,
  const PD extends ParamsDeclared = readonly never[],
  const L extends LoaderName = never,
  const A extends ActionName = never,
  const F extends string = never,
>(definition: {
  label: string | AppMessageRef;
  icon?: PageIcon;
  description?: string | AppMessageRef;
  /** `group` is the nav group the page stands in, or several (a page can stand in more than one workspace). */
  nav?: false | { group?: string | readonly string[]; position?: number };
  roles?: readonly string[];
  public?: true;
  favorite?: boolean;
  /** The head's form: `'compact'` is the title alone on one line with its verbs, no intro; `false` is a page that draws
      its own head, its title kept for a screen reader (the page's one h1) and the label still the tab's, the crumb's
      and the palette's word. Absent: the full head. */
  head?: 'compact' | false;
  /** `'bare'`: no sidebar and no top bar; the component owns the whole window (a kiosk, a wallboard, a landing page). The title
      stays for a screen reader, the tab and the palette, and the skip link and focus are the shell's. With `public: true` it is a
      public landing page, and `auth.public` bounds what it reads and runs as for any public page. A bare page draws no head, so it takes no `head`. */
  layout?: 'bare';
  reads: readonly R[];
  commands?: readonly C[];
  /** The fixed actions it runs (a machine's verbs, `action(label, { set })`) on what it reads; commands are named in `commands`. Not on a public page. */
  actions?: readonly A[];
  /** The form views it opens with `page.useForm` (a view whose `command` makes it a form); the checker counts each as reachable. */
  forms?: readonly F[];
  /** The address parameters it keeps its place in: names (each read as text), or each name with its kind,
      `{ class: 'id', day: 'date', view: ['list', 'board'] }`. */
  params?: PD & LowercaseNames<PD>;
  loader?: L;
  component: (props: LoaderPageProps<L>) => ReactTypes.ReactNode;
}): PageDefinition<R, C, ParamNames<PD>, L, A, ParamKinds<PD>, F>;

/** A surface as `defineSurface` makes it: its declaration, typed to the App, for the server to read and a front end's types to follow. */
export interface SurfaceDefinition<R extends string, C extends string = never, L extends string = never, F extends string = never> {
  readonly definition: { readonly label: string | AppMessageRef; readonly reads: readonly R[]; readonly commands?: readonly C[];
    readonly forms?: readonly F[]; readonly loader?: L };
}

/**
 * A surface: `export default defineSurface({ label, reads, commands })` in `surfaces/<key>.surface.ts`. What a front end the
 * App draws itself (a Next.js page on the same domain) may read and run, named on each of its requests in `X-Mistri-Surface`;
 * the server refuses anything else with 403 `{ code: 'surface' }`. A free-form page's manifest with nothing to draw, so it
 * takes no `component`, `nav`, `layout`, `head`, `params` or `public`, nor `actions`: a fixed action writes through the
 * record page's update route, which a surface does not open, so a front end runs a command. `roles` narrows who may use it,
 * as a page's does. With the generated types a resource, command, loader or form the App does not have is a type error.
 */
export declare function defineSurface<
  const R extends ResourceName,
  const C extends CommandName = never,
  const L extends LoaderName = never,
  const F extends string = never,
>(definition: {
  label: string | AppMessageRef;
  icon?: PageIcon;
  description?: string | AppMessageRef;
  roles?: readonly string[];
  favorite?: boolean;
  reads: readonly R[];
  commands?: readonly C[];
  forms?: readonly F[];
  loader?: L;
}): SurfaceDefinition<R, C, L, F>;

/**
 * The App's own addresses as strings, for an `<a href>` and for an embedding app's navigator: `useHref().record('leads', { id: 4 })`.
 * Each is the one canonical address the router reads back, so a link never drifts from a typed-in address. A view, page or record
 * the App has no address for throws, where a link to nowhere would otherwise ship. With the generated types a view that is not
 * the App's, or a page path that is not a page's, is a type error. `params` are the words an address says (`tab`, `search`, a filter's column).
 */
export declare function useHref(): {
  /** The sign-in's address. `then` is an in-App path to go on to once signed in (`/leads/4`): carried as `?then=`, which the sign-in reads; an absolute or protocol-relative address is dropped, not carried. */
  signIn(options?: { then?: string }): string;
  /** A list or dashboard by its view key: `view('leads', { tab: 'working', search: 'stone' })` is `/leads?tab=working&search=stone`. */
  view(view: ViewKeyName, params?: Readonly<Record<string, string>>): string;
  /** A record by its key under the view that shows its table: `record('leads', { id: 127 })` is `/leads/127`; `{ tab: 'map' }` adds the tab's word. */
  record<V extends ViewKeyName>(view: V, key: Readonly<Record<string, unknown>>, options?: { tab?: RecordTabName<V> }): string;
  /** A free-form page by its path, with the parameters it keeps in its address. */
  page(path: PagePathName, params?: Readonly<Record<string, string>>): string;
};

/** Rows of one of the page's reads, typed by what `show` names; `page.useRows` is this hook held to the page's `reads`. */
export declare function useRows<T extends ResourceName, const S extends readonly ColumnPath<T>[] = readonly []>(
  resource: T,
  options: RowsOptions<T, S> & { optional: true },
): UiRowsQuery<PageRow<T, S>> & UiRefusable;
export declare function useRows<T extends ResourceName, const S extends readonly ColumnPath<T>[] = readonly []>(
  resource: T,
  options?: RowsOptions<T, S> & { optional?: false },
): UiRowsQuery<PageRow<T, S>>;
/** One record by its key, typed by what `show` names; null when there is none, not asked while the key is undefined. */
export declare function useRecord<T extends ResourceName, const S extends readonly ColumnPath<T>[] = readonly []>(
  resource: T,
  key: Readonly<Record<string, unknown>> | undefined,
  show: S | undefined,
  options: { optional: true },
): UiQuery<PageRow<T, S> | null> & UiRefusable;
export declare function useRecord<T extends ResourceName, const S extends readonly ColumnPath<T>[] = readonly []>(
  resource: T,
  key: Readonly<Record<string, unknown>> | undefined,
  show?: S,
  options?: { optional?: false },
): UiQuery<PageRow<T, S> | null>;

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

/** One step of a `<Steps>`: the command's inputs it asks, in order, and the words it is drawn with. */
export interface StepsStep<Input extends string = string> {
  /** The param's value while this step is open: `?step=amount`. */
  id: string;
  /** The short name: the progress bar's "Step 2 of 3: Amount". */
  label: string;
  /** The step's heading; absent, its label. */
  title?: string;
  /** One sentence under the heading. */
  lead?: string;
  /** The primary button's words on this step; absent, "Continue". The last step's is the command's label. */
  next?: string;
  /** The command's inputs this step asks; each belongs to one step. */
  inputs: readonly Input[];
}

/** What `<Steps>` takes. */
export interface StepsProps<N extends CommandName = CommandName, Param extends string = string> {
  /** One of the page's `commands`: the one that runs, once, at the end. */
  command: N;
  /** One of the page's `params`: the step open now, by its id; absent, the first. */
  param: Param;
  steps: readonly StepsStep<CommandInputName<N>>[];
  /** The record the command runs on, for one an action offers; a command with no record names none. */
  record?: Readonly<Record<string, unknown>>;
  /** What is said once it has run; absent, "<label>: done." and what the command's own result said. */
  done?: { title?: string; description?: string };
  /** How the run ended, once it applied. */
  onDone?: (outcome: CommandOutcome) => void;
}

/**
 * A command's form over several steps, drawn in the intake style, its step kept in a param of the page:
 * `<Steps command="addCharge" param="step" steps={[{ id: 'what', label: 'What', inputs: ['kind', 'description'] },
 * { id: 'amount', label: 'Amount', inputs: ['amount', 'due_on'] }]} />`. The command runs once, from the last step,
 * under its own label; an earlier step's Continue checks what that step asks, in the browser and then on the server,
 * and runs nothing. The step is written to the param in place (Back leaves the page), so a reload or a link opens the
 * same step; what was typed is kept in the page's memory between steps, never in the address, and an address naming
 * a step past one that does not hold opens that one. Each move says "Step 2 of 3: Amount" and moves the focus to the
 * step's heading; a refusal about an input on another step opens that step, says so, and focuses the input. Not drawn
 * for a reader who may not run the command. A file or signature input is not asked here.
 */
export declare function Steps<const N extends CommandName>(props: StepsProps<N>): ReactTypes.ReactElement | null;

/**
 * One command on one row, as a button: `<CommandButton command="checkIn" row={booking} />`. Not drawn for a reader who
 * may not run it, disabled while the row's state does not allow it, busy while it runs. Its accessible name is its
 * label and the row's title ("Check in Morgan Lee"), so a list of them reads apart. Its outcome is said in the
 * platform's live region — `done` says it in the page's words — and a refusal is said there too. The row needs its
 * key (a `List`'s and a `useRows` read's rows both carry it); a command that names no row (`targets: 'none'`) takes
 * none: `<CommandButton command="postRent" />`. `page.useCommand` stays for what a button cannot say.
 */
export declare function CommandButton(props: {
  command: CommandName;
  row?: Readonly<Record<string, unknown>>;
  label?: string;
  intent?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'compact' | 'default' | 'large';
  done?: string;
  onDone?: (outcome: CommandOutcome) => void;
}): ReactTypes.ReactElement | null;
/** One of the page's fixed actions on one row, as `CommandButton` draws a command: `<ActionButton action="startVisit" row={visit} />`. */
export declare function ActionButton(props: {
  action: ActionName;
  row: Readonly<Record<string, unknown>>;
  label?: string;
  intent?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'compact' | 'default' | 'large';
  done?: string;
  onDone?: (outcome: CommandOutcome) => void;
}): ReactTypes.ReactElement | null;

/**
 * One resource and condition for every block inside it: `<Scope from="booking" where={{ class_session_id: classId }}>`.
 * A block that names no `from` reads the Scope's resource under the Scope's condition, its own `where` and `query`
 * joined to it by "and"; a block that names another resource reads that one alone. A Scope inside another on the same
 * resource narrows it.
 */
export declare function Scope<const R extends ResourceName>(props: {
  from: R;
  where?: Where<R>;
  query?: string;
  children?: ReactTypes.ReactNode;
}): ReactTypes.ReactElement;

/**
 * Rows drawn by the page, one at a time: `<List from="booking" where={{ status: 'booked' }} show={['guest_name']}>{(b) => …}</List>`.
 * The read's states are the platform's — its placeholder while asked, `empty` (or the house sentence) for no rows, the
 * house problem with Try again where it could not be read, and a note where the reader may not read it — so `children`
 * draws only rows. Each row is typed by `show`, and also carries its key, for a `CommandButton` on it.
 */
export declare function List<const R extends ResourceName = never, const S extends readonly ColumnPath<Reading<R>>[] = readonly []>(props: {
  from?: R;
  where?: Where<R>;
  query?: string;
  show?: S;
  sort?: string;
  limit?: number;
  empty?: ReactTypes.ReactNode;
  /** Names the list for assistive technology. */
  label?: string;
  children: (row: PageRow<R, S>, index: number) => ReactTypes.ReactNode;
}): ReactTypes.ReactElement;

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

/**
 * One of a few, kept in a param of the page: `<Choose param="class" from="class_session" sort="starts_at" label="title" />`.
 * The options are the rows of a read of the page (`from`, with `where`, `query`, `sort`, `limit`), or the param's own words
 * when it is declared as a list (`params: { view: ['list', 'board'] }`). A row of segments for up to five short options, the
 * house listbox past that; a control that holds its height while the options load. The address is its state: a change
 * replaces the entry (Back leaves the page), and a link opens with the choice made. `page.Choose` is this held to the page's
 * own params and reads.
 */
export declare function Choose<const T extends ResourceName>(props: ChooseProps & ChooseRows<T>): ReactTypes.ReactElement;
export declare function Choose(props: ChooseProps & { from?: undefined }): ReactTypes.ReactElement;
/** A search box kept in a text param of the page, typed into after a pause and replacing the entry: `<Search param="q" />`. */
export declare function Search(props: SearchProps): ReactTypes.ReactElement;
/** Two date fields kept in one param of kind `'date-range'` (`2026-11-01..2026-11-08`, either end open): `<DateRange param="period" />`. */
export declare function DateRange(props: DateRangeProps): ReactTypes.ReactElement;

/* The platform's sections as components: each takes its DSL helper's words as props, `from` for its resource (or the
   enclosing Scope's), `where` beside `query` for its condition, and reads only a resource the page declares in `reads`. */

/** A dashboard's rows, `rows()`: `<Rows title="Closing soon" from="opportunity" show={['name', 'amount']} sort="close_date" limit={10} />`. */
export declare function Rows<const R extends ResourceName = never>(props: {
  title: string;
  from?: R;
  where?: Where<R>;
  query?: string;
  show?: readonly ColumnPath<Reading<R>>[];
  sort?: string;
  limit?: number;
  sizing?: 'fit' | 'scroll';
  width?: BlockWidth;
}): ReactTypes.ReactElement;
/** One number over a resource, `metric()`: `<Metric title="Open" from="ticket" query="status = open" compare="previous period" better="down" />`. */
export declare function Metric<const R extends ResourceName = never>(props: {
  title: string;
  from?: R;
  where?: Where<R>;
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
export declare function Chart<const R extends ResourceName = never>(props: {
  title: string;
  from?: R;
  where?: Where<R>;
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
export declare function Breakdown<const R extends ResourceName = never>(props: {
  title: string;
  from?: R;
  where?: Where<R>;
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
export declare function Tree<const R extends ResourceName = never>(props: {
  from?: R;
  where?: Where<R>;
  parent: ColumnPath<Reading<R>>;
  primary: ColumnPath<Reading<R>>;
  /** One line said quietly beside the primary. */
  lines?: readonly [ColumnPath<Reading<R>>];
  query?: string;
}): ReactTypes.ReactElement;
/** Rows as bars between two dates, the `gantt()` presentation: `<Gantt from="task" start="starts_on" end="due_on" primary="name" />`. */
export declare function Gantt<const R extends ResourceName = never>(props: {
  from?: R;
  where?: Where<R>;
  start: ColumnPath<Reading<R>>;
  end: ColumnPath<Reading<R>>;
  primary: ColumnPath<Reading<R>>;
  by?: ColumnPath<Reading<R>>;
  progress?: ColumnPath<Reading<R>>;
  query?: string;
}): ReactTypes.ReactElement;
/** A list presentation's own words, as its DSL helper takes them, less the kind the block's name already says. */
type PresentationWords<T> = { [K in keyof T as K extends string ? Exclude<K, 'kind'> : never]: T[K] };
/** What a block that draws a list presentation asks of its rows, as `<Rows>` does. */
interface PresentedRows<R extends string> {
  from?: R;
  where?: Where<R>;
  query?: string;
  sort?: string;
  limit?: number;
  /** The list's accessible name. */
  label?: string;
}
/** Rows as lanes of cards by a column, the `board()` presentation: `<Board from="ticket" by="status" primary="title" />`. Dropping
    a card runs a verb the page declares (its `commands` and `actions`), with the refusal and the optimistic place a list's board has;
    `move` narrows which. A board the page declares no move for is read. */
export declare function Board<const R extends ResourceName = never>(
  props: PresentedRows<R> &
    PresentationWords<AppBoardList<ColumnPath<Reading<R>>>> & {
      move?: readonly (CommandName | ActionName)[];
    },
): ReactTypes.ReactElement;
/** Rows by the day they fall on, the `calendar()` presentation: `<Calendar from="class_session" date="starts_at" primary="title" />`. */
export declare function Calendar<const R extends ResourceName = never>(
  props: PresentedRows<R> & PresentationWords<AppCalendarList<ColumnPath<Reading<R>>>>,
): ReactTypes.ReactElement;
/** Rows as a grid of cards led by a picture, the `cards()` presentation: `<Gallery from="vehicle" image="photo_url" primary="title" />`. */
export declare function Gallery<const R extends ResourceName = never>(
  props: PresentedRows<R> &
    Omit<PresentationWords<AppCardsList<ColumnPath<Reading<R>>>>, 'image'> & {
      /** A column holding an image address, or the first file of a related file resource (`{ from, whose, sort }`). */
      image: NonNullable<AppCardsList<ColumnPath<Reading<R>>>['image']>;
    },
): ReactTypes.ReactElement;
/** Rows in a queue beside the picked record's own page, the `split()` presentation. The pick is held in the page param `param`
    when it names one (a single-column key's value, so Back and a link keep it), else in the block. */
export declare function Split<const R extends ResourceName = never>(props: {
  from?: R;
  where?: Where<R>;
  query?: string;
  sort?: string;
  label?: string;
  param?: string;
  row: { primary: ColumnPath<Reading<R>>; lines?: readonly [ColumnPath<Reading<R>>] | readonly [ColumnPath<Reading<R>>, ColumnPath<Reading<R>>] };
  /** The picked record's fields, in order. Absent, its fields as the schema has them. */
  detail?: readonly ColumnPath<Reading<R>>[];
  /** The list's page size, 1 to 200. */
  limit?: number;
}): ReactTypes.ReactElement;
/** The App's assistant, as its own page draws it (where the App declares one): `<Assistant />`. */
export declare function Assistant(props: { conversation?: string }): ReactTypes.ReactElement | null;
