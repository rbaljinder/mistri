// A declaration file includes a script of declarations (`*.css`) this way; an import would make it a module.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./css.d.ts" />
/**
 * The authored App surface, as types — the same facts app.schema.json
 * states for editors that read JSON Schema, for editors that read
 * TypeScript instead. The parsers in src/shared/app*.ts and
 * packages/engine/src/shared/page.ts remain the truth; test/schema.test.ts keeps the
 * schema honest and the schema keeps this file honest by saying the same
 * things in the same words.
 *
 * The root is grouped: identity (`id`, `name`); data (`connection`,
 * `sources`, `resources` — one block per resource); auth (`auth`, present
 * means sign-in is required); content (`views`, `pages`, `home`, `nav`); and
 * chrome (`ui`). Two words carry captions: `label` names a control or a
 * destination; `title` heads a region of content.
 *
 * Use from an app.mjs:
 *
 *   import { defineApp } from '@mistriwork/mistri/app';
 *   export default defineApp({ name: 'Field Ops', views: { ... }, home: 'work-orders', nav: [ ... ] });
 *
 * Arrays are `readonly` here so both a `satisfies App` value and a literal
 * `defineApp` infers as `const` fit; the value itself is plain data.
 */

import type { Action, ActionSetValue, AppUpdateAction, CommandAction } from './command.js';
/* Query-language strings checked against the table a helper names (query.d.ts). */
import type { GroupBy, MetricGuard, QueryGuard, ResourceGuard, RollupColumn, RowsGuard, SectionsGuard, SourceGuard, QueryTable } from './query.js';
export type {
  Action, ActionSetValue, AppAction, AppCommandAction, AppCommandChoice, AppCommandReference, AppCommandField, AppFormCommandReference, AppUpdateAction, AppFlagGate,
  CommandAction,
} from './command.js';
import type { AppLinkAction, AppMessageRef, AppTarget, AutoValue, CustomMeasure, FormDefault, RelatedCreate, StaticAppTarget } from '@mistriwork/engine/schema/model.js';
/* The shapes the engine reads as well (model.d.ts), named from @mistriwork/mistri/app as before. */
export type {
  AppLinkAction, AppLinkValue, AppMessageRef, AppTarget, AppTenantIntent, AutoValue, CustomMeasure, FormDefault, FormScalar, RelatedCreate,
  StaticAppTarget,
} from '@mistriwork/engine/schema/model.js';

/* ---------- state machines ----------
   A record's life as states and verbs: `machine('status', { submitted: { on: { assignReviewer: 'in_review',
   withdraw: 'withdrawn' } }, …, withdrawn: { final: true } })`. A verb that names one of the App's commands runs it,
   and the command moves the record to one of its states; any other word is a fixed move, a button that sets the
   column (its label read from the word). The states' order is the record's order: its stepper, a board's lanes and
   its actions follow it. Written through `machine()`, a verb's next state is checked against the states.
   A verb that names another record's command (a payment's `pending: { on: { cancelOrder: 'voided' } }`) moves
   each row that references that record with the command, in its transaction: final rows stay, and a row in a
   state that does not list it refuses the command. It goes to one state, unconditionally, and is no button here. */

/** A verb with more to say than where it goes: its label, the stamps it writes beside the column, the reason it asks
    (a fixed move's), a condition beyond the state, whether it confirms, and whether a queue offers it for a selection. */
export interface MachineVerb<State extends string = string, Column extends string = string> {
  /** The next state; a command's verb may name the states its handler chooses among. */
  to: State | readonly State[];
  /** The button's words. `{to}` says the state it leads to in the column's words (`'Move to {to}'`), so a verb to
      one state reads as its destination. A command verb may be labelled differently from different states (the
      same verb, `advance`, says "Move to Proposal" from Discovery and "Move to Negotiation" from Proposal); a
      fixed verb says one thing from every state. */
  label?: string | AppMessageRef;
  /** Columns the move writes beside the state, as a fixed action's `set` does: `{ closed_on: today }`. */
  set?: { readonly [column: string]: ActionSetValue };
  /** A text column the button asks why into, written with the move. */
  reason?: Column;
  /** A condition beyond the state, in the query language over the record's columns: offered only where it holds. */
  when?: string;
  /** Ask before the move writes. A command verb that asks nothing asks first too; one with inputs asks them in its
      form, which is its confirmation, and is refused one. */
  confirm?: boolean;
  /** A queue offers the verb for a selection too, as well as on one record. */
  bulk?: boolean;
}
/** Where a verb goes: a state; the states a command chooses among; or a fixed move said in full. */
export type MachineMove<State extends string = string, Column extends string = string> = State | readonly State[] | MachineVerb<State, Column>;
/** One state: the verbs that leave it, a timer (`after: { '14 days': 'expireApplication' }`, a command run through the
    jobs when the record has stayed that long; needs the machine's `since`), the moves only the jobs make (`by: { automation: 'escalated' }`, made by a command running as that service
    role and drawn as no button), and `final` for a state nothing leaves. */
export interface MachineState<State extends string = string, Column extends string = string> {
  on?: { readonly [verb: string]: MachineMove<State, Column> };
  after?: { readonly [duration: Duration]: CommandName };
  /** Not a state's: a timer at an instant is the resource's own `at`, with `when: "status = 'open'"`. */
  at?: never;
  by?: { readonly [role: string]: State | readonly State[] };
  final?: true;
}
/** A timer at an instant (`AppResource.at`): the command it runs, and the conditions the record must meet then. */
export interface AppAtTimer {
  command: CommandName;
  when?: string;
}
/** A record's state machine over one column. `since` names a timestamp column the server stamps whenever the state
    changes, which `after` timers count from. */
export interface AppMachine<Column extends string = string, State extends string = string> {
  column: Column;
  states: { readonly [S in State]: MachineState<State, Column> };
  since?: Column;
  /** The states a command may insert a new record in besides the first (`entry: ['discover']`); refused otherwise. A
      form's New record still starts in the first state. */
  entry?: readonly State[];
  /** Named sets of states, read by the query language as `status is open` is: `groups: { onBench: ['checked_in',
      'in_repair'] }` makes `status is onBench` those states and `status is not onBench` the others, wherever a
      condition is read — a view's query, a segment, a tab, a metric, a nav count, a rows section — and a board
      whose query names a group shows only its lanes. Each group names states of the machine; a group is never
      named like a state, nor `open` (every state that is not final). */
  groups?: { readonly [group: string]: readonly State[] };
}
/** One table of a union: its resource, and its own column for each of the union's. */
export interface AppUnionBranch<Columns extends string = string> {
  from: string;
  as: { readonly [C in Columns]: string };
}
/** A read-only resource over tables that share a shape. */
export interface AppUnion<Name extends string = string, Columns extends string = string> {
  name: Name;
  branches: readonly AppUnionBranch<Columns>[];
}
/** One list over several tables, in one order and one page: `union('my_requests', [{ from: 'incident', as: { title:
    'short_description', opened: 'opened_at' } }, { from: 'requested_item', as: { title: 'name', opened: 'created_at' } }])`.
    A view or `useRows` names it as it names a table. Each branch is read under the reader's own grants and row policy,
    and a row's `from` and `key` open its own record. Read-only: it has no record page, breakdown or summary. */
export declare function union<const Name extends string, const Columns extends string>(
  name: Name, branches: readonly [AppUnionBranch<Columns>, AppUnionBranch<Columns>, ...AppUnionBranch<Columns>[]],
): AppUnion<Name, Columns>;

/** A resource's state machine: `machine: machine('status', { draft: { on: { submit: 'submitted' } }, submitted: { final: true } })`.
    Each verb's next state must be one of the states. */
export declare function machine<const Column extends string, const States extends { readonly [S in keyof States]: MachineState<Extract<keyof States, string>> }>(
  column: Column, states: States,
  opts?: { since?: string; entry?: readonly Extract<keyof States, string>[]; groups?: { readonly [group: string]: readonly Extract<keyof States, string>[] } },
): Omit<AppMachine<Column, Extract<keyof States, string>>, 'states'> & { states: States };

/* ---------- commands, by name ----------
   An App names a command (`command: 'assignReviewer'`) and never imports its
   definition: that lives in the server-only module (`defineCommand`, from
   @mistriwork/mistri/commands), and the server sends its input to the browser with the
   App. `mistri check` writes mistri-commands.d.ts from that module,
   which fills `Register` in, so a name that is not a command, a record's
   command on another table or a form's step field that is not one of its
   inputs fails the typecheck. Without the generated file a name is any text,
   and loading the App judges it. */

/** Filled in by the generated mistri-commands.d.ts: `declare module '@mistriwork/mistri/app' { interface Register { commands: Commands } }`. */
export interface Register {}
/** One command as the generated file describes it: the table it acts on, how many existing records a request names,
    its input names, and whether a public form runs it. */
export interface RegisteredCommand { target: string; targets: 'one' | 'many' | 'none'; input: string; public?: true }
type Registered = Register extends { commands: infer C extends Record<string, RegisteredCommand> } ? C : never;
type Unregistered = [Registered] extends [never] ? true : false;
type NamesWhere<Test> = Unregistered extends true ? string
  : { [K in Extract<keyof Registered, string>]: Registered[K] extends Test ? K : never }[Extract<keyof Registered, string>];
/** Any command of the App. */
export type CommandName = NamesWhere<RegisteredCommand>;
/** The App's free-form pages by their paths (`pages/<path>.page.tsx`), filled in by the same generated file: `home` may name
    one beside a view. None without the generated file, whose `mistri check` writes it before it typechecks. */
type PagePath = Register extends { pagePaths: infer P extends string } ? P : never;
/** A command on an existing record of `Table`: what that resource's actions and import may run. */
export type CommandOn<Table extends string = string> = NamesWhere<{ target: Table; targets: 'one' | 'many' }>;
/** A command a form runs: it names no existing record. `Public` narrows to those a public form may run, or those it may not. */
export type FormCommandName<Public extends boolean = boolean> = NamesWhere<{ targets: 'none' } & (boolean extends Public ? unknown : Public extends true ? { public: true } : { public?: undefined })>;
/** A command's input names, or any text without generated types. */
export type CommandInputName<Name extends string> = Unregistered extends true ? string : Name extends keyof Registered ? Registered[Name]['input'] : never;
type TakesMany<Name extends string> = Unregistered extends true ? true : Name extends keyof Registered ? Registered[Name] extends { targets: 'many' } ? true : false : false;

/* ---------- one spelling: the helpers ----------
   A view, a list's presentation, a dashboard, page or landing section, a page and a resource action are each
   written with their helper — `listView()`, `checklist()`, `metric()`, `fields()`, `page()`, `action()` — and
   only so. Each helper's value carries this mark in its type and the places that take one require it, so a
   hand-written object in their place is a type error that names the helper it wants: "Property '[madeBy]' is
   missing … required in type '{ readonly [madeBy]: "listView" }'". Declared only, never a value: the data a
   helper returns is the plain object app.json and `mistri build` hold, with no mark in it. A kind with no
   helper (a list's `board` and `split`) is a key of the list view that holds its options. */
declare const madeBy: unique symbol;
/** The mark a helper's value carries in its type. */
type Made = typeof madeBy;
/** How long, in the one spelling every duration in the DSL shares: a whole number and a unit, `'30 seconds'`,
    `'5 minutes'`, `'12 hours'`, `'3 days'`, `'2 weeks'` (a singular unit reads too: `'1 hour'`). */
export type Duration = `${number} ${'second' | 'minute' | 'hour' | 'day' | 'week'}${'' | 's'}`;
/** What a helper's value is, in types: written by that helper. */
export type MadeBy<Helper extends string> = { readonly [madeBy]: Helper };
/** A helper's value as the plain data it is — what app.json and mistri.json hold — the mark taken off. */
export type Plain<T> = T extends unknown ? Omit<T, Made> : never;

/* ---------- shared pieces ---------- */

export type SectionWidth = 'full' | 'two-thirds' | 'half' | 'third';
export type TableSizing = 'fit' | 'scroll';
export type SectionRegion = 'main' | 'aside';
export type SectionOffset = 'quarter' | 'third' | 'half' | 'two-thirds';

/** One tab on a list view: a segment of its table by name (`'open'`), a segment with its own order
    (`{ segment: 'open', sort: 'due_on' }`), or every row (`{ label: 'All' }`). A tab's label and address are its
    segment's; its conditions are written once, on the resource (`resources.<table>.segments`). */
export type AppTab =
  | string
  | {
      segment: string;
      /** The order this tab reads in, written as the query bar writes one — `'scheduled_at'`, `'created_on desc'`: an
          Upcoming tab soonest first where the list reads newest first. It wins over the view's own `sort`. */
      sort?: string;
    }
  | { label: string | AppMessageRef; sort?: string };

/** A named set of conditions on a resource — `overdue: 'open and due_on < today'` — read as one word wherever its
    table's rows are asked: a tab, a metric's source (`'work_order.overdue'`), a rollup's `segment`, a query bar. It may
    name another segment; it only ever narrows, under the reader's grants and row scope. */
export type AppSegment = string | { query: string; label?: string | AppMessageRef };

/** A child row that uses up a number on the record it points at: `{ column: 'part_id.on_hand', by: 'quantity' }`. An
    insert takes `by` (1 if absent) from the balance in the same transaction, refused with `message` below zero; a
    delete gives it back; an edit moves the difference, or between records when the reference changes. */
export interface AppConsumes {
  /** The balance: a reference of this resource, then a number column of the record it names. */
  column: string;
  /** This row's number column holding how much it uses; one each when absent. */
  by?: string;
  /** What the refusal says, `{path}` read from the parent record: `'Only {part_id.on_hand} of {part_id.name} left'`. As
   * `msg()`, bind each place to its path: `msg('stock.short', { left: 'part_id.on_hand', name: 'part_id.name' })`. */
  message?: string | AppMessageRef;
  /** `false` lets the balance go below zero (a backorder); it never stops at zero then. */
  floor?: false;
}

/**
 * One shown column in a view: a column or a dotted label path
 * ("account_id.name"). Its caption is the resource's
 * (`resources.<table>.labels`), one per column App-wide.
 */
export type AppShowEntry = string;

/** A New form's value taken from the record a reference names — `{ from: 'service_id.price' }` — refreshed as the
    reference is chosen until the person edits it, and filled by the server where a create leaves it out. */
export interface FromReference<Path extends string = string> { readonly from: Path }
/** A condition in the query language, the one an action's `when` speaks: "completed = false",
    "stage = closed_won and probability < 100", "pay_type in (salary, hourly)", "due_on is empty". Read against the
    record's own values, so it compares local columns with `=`, `!=`, `<`, `<=`, `>`, `>=`, `in` and `is (not) empty`,
    joined by `and`, `or` and parentheses; no paths, no text matching, at most 16 comparisons. */
export type FormCondition = string;
/** A validation rule: the record must meet `must`, a condition in the query language, wherever `when` (a condition
 * too) holds — `{ must: 'close_date >= created_on', message: 'Closes before it was created' }`. Beside a number, date
 * or flag, a bare word naming another column compares with it; `x is not empty` requires a value (blank text is
 * empty). A validation may also read through one reference — `{ must: 'order_id.status = bench', message: 'Parts
 * go on only while the order is on the bench' }` — judged on the server against the record it names, as the write's
 * own transaction sees it; an empty reference reads as empty. The message is shown at the first column `must` names
 * (for a path, its reference). Static plain-text messages only; values are never interpolated. Max 128 rules per
 * resource. */
export interface FormRule { must: FormCondition; when?: FormCondition; message: string | AppMessageRef }

/** One step of a multi-step form. Every shown field belongs to exactly one step. Max 16 steps. */
export interface FormStep<Field extends string = string> {
  /** Lowercase letters, digits, underscores and hyphens, starting with a letter; unique within the form.
      Absent, the label's slug ("Care and coverage" → `care-and-coverage`), as `step()` makes it. */
  id?: string;
  label: string | AppMessageRef;
  /** The fields the step asks, in order. An inner list is a row, drawn side by side (stacking on a narrow screen):
      `[['first_name', 'last_name'], 'date_of_birth']`. At most 3 fields to a row, one level deep. */
  fields: readonly (Field | readonly Field[])[];
  /** The intake style's heading for the step (the room's h1), at most 160 characters; absent, the label. */
  title?: string | AppMessageRef;
  /** One sentence under the title, at most 500 characters. */
  lead?: string | AppMessageRef;
  /** The primary button's words on this step, at most 40 characters; absent, "Continue". */
  next?: string | AppMessageRef;
  /** The primary's words while every field of the step is empty (each optional), at most 40 characters: "Skip". */
  skip?: string | AppMessageRef;
}

/**
 * One step of a form saved on every step: `step('About you', 'startApplication')`.
 * It asks its own command's inputs and its handler writes them to the App's real tables when the
 * applicant moves on. The first step's handler inserts the application's root row, spreading
 * `draft.start` into it; every later one receives `draft.root`, the root's key resolved by the
 * server from the applicant's cookie — never from anything the page sent. Max 12 steps.
 */
export interface SavedFormStep {
  /** As a step that lists fields: lowercase letters, digits, underscores and hyphens, starting with a letter; unique
      within the form. Absent, the label's slug, as `step()` makes it. */
  id?: string;
  label: string | AppMessageRef;
  command: FormCommandName<true>;
  /** As a step that lists fields (`title`, `lead`, `next`); a saved step has no `skip`, as it asks its command's inputs. */
  title?: string | AppMessageRef;
  lead?: string | AppMessageRef;
  next?: string | AppMessageRef;
}

/**
 * Where a saved form keeps its place, on the application's root row. The platform owns these
 * columns: `token` holds the SHA-256 of the applicant's cookie (never the cookie), `expires`
 * the instant after which the draft cannot be resumed, `progress` the ids of the steps saved
 * so far — never anything typed in them. All three must be nullable text/timestamp columns
 * (`mistri check` names the one that is not).
 */
export interface SavedFormResume {
  token: string;
  expires: string;
  progress: string;
  /** How long from the first step a draft may be resumed: `'14 days'` (the default), 1 to 90. */
  after?: Duration;
}

/**
 * The one sanctioned read of an anonymous application, and it is authentication, not a lookup:
 * the receipt (high entropy, random) confirmed by one to three values only the applicant knows.
 * It answers `show` — a state, never an input — in the words `says` gives; a wrong receipt and a
 * wrong factor are answered alike, in the same time, and a receipt locks after repeated failures.
 * `stepUp` opens more after a one-time code sent to the root's email column (the config's email service sends it):
 * the check's details again with the code, ten minutes, once, three codes an hour; then `show` there for a
 * fifteen-minute session in that browser.
 */
export interface SavedFormStatusCheck {
  /** The root column holding the reference the submit returned. */
  receipt: string;
  /** Root column → the label asked, or `{ label, keyed: true }` for a column holding a `keyed` input's hash. */
  confirm: Readonly<Record<string, string | { label: string | AppMessageRef; keyed?: true }>>;
  /** Root columns answered after the check; `['status']` when left out. */
  show?: readonly string[];
  /** The words for a shown column's values: `{ status: { in_review: 'In review' } }`. A value it does not name reads "Received". */
  says?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** `email`: the root's text column the code goes to; `show`: the root columns opened after the code. */
  stepUp?: { email: string; show: readonly string[] };
  /** A nullable timestamp column the server stamps when a submitted application's receipt locks after repeated wrong
      answers; a `notify` rule on the root watching it (`on: { changes: 'check_alert_at' }`) tells staff. */
  alert?: string;
}

/**
 * Adding a submitted application to an account, on proven control only — never on matching data. `sameDevice`: the
 * submit leaves a 30-minute claim in the browser, spent only by a signed-in Yes on `/{app}/form/{key}/claim`, burned by
 * No, signing out, its expiry or the next application. `statusCheck: true`: signed in, a passed status check offers
 * "Add to my account". `email`: an account whose email the sign-in store has verified is offered the submitted
 * applications that captured the same address and adds each by a Yes; it adds one without asking only where the
 * applicant proved that address with a code in the form (`verified`, which the server stamps). A link writes `owner`
 * (the account's id), `at` and `via` once and is refused when the application has an owner; then only the owner's
 * session reads it. Needs the form's `statusCheck`; every column is a nullable column of the root that no step asks.
 */
export interface SavedFormLink {
  owner: string;
  /** A timestamp: when it was linked. */
  at: string;
  /** Text: `'same-device'`, `'status-check'` or `'email'`. */
  via: string;
  /** The claim's SHA-256 (text) and its expiry (a timestamp). */
  sameDevice?: { token: string; expires: string };
  statusCheck?: true;
  /** The root's email column, a step's input; or `{ column, verified }`, `verified` the text column the server stamps with
      the address the applicant proved in the form. */
  email?: string | { column: string; verified?: string };
}

/** The curated New form: which columns to ask for, values filled in first, and how it reads. */
export interface AppForm<Field extends string = string> {
  /** Fields to ask for, in order. Omit with steps or groups to use their fields; omit all three to use the editable
      catalog columns. An inner list is a row, drawn side by side (one column on a narrow form):
      `[['email', 'phone'], 'company']`. At most 3 fields to a row, one level deep. */
  show?: readonly (Field | readonly Field[])[];
  /** The values a new record starts with, typed or left as they are. Besides a literal, three constants: `today` on a
      date column, `now` on a date-and-time column, and `me` — the signed-in person's row on a reference to the
      `auth.me` table, their email on a text column. They are filled in as the form opens, and by the server on a
      create that leaves them out; a column the form does not show is the server's, whatever a create says. Or a value
      from the record a reference names, `{ from: 'service_id.price' }`. */
  defaults?: string extends Field ? Record<string, FormDefault | FromReference> : Partial<Record<Field, FormDefault | FromReference>>;
  /** Presentation only; members must be unique, shown and readable. Max 32 groups. A group is a section with its
      label as the heading and `description` as one line under it. Its fields take rows as `show` does; a row stands
      inside one group. */
  groups?: readonly {
    label: string | AppMessageRef;
    description?: string | AppMessageRef;
    fields: readonly (Field | readonly Field[])[];
  }[];
  /** Each field shown only while the draft matches its condition: `{ due_on: 'completed = false' }`.
      Visibility never changes field access or resource validation. */
  when?: Partial<Record<Field, FormCondition>>;
  /** Finite presentation steps; a group may not span two of them. */
  steps?: readonly FormStep<Field>[];
  /** How steps are drawn; both say where the reader is with one progress bar. `'stepper'` (the default: the step's name
      over its fields) or `'intake'` (the step's title large, a sticky bar of actions, and a last page that is every
      step's answers to check). */
  style?: 'stepper' | 'intake';
  /** One sentence under the form's heading: what a new record is for, or what happens once it is added. */
  description?: string | AppMessageRef;
  /** `'drawer'`: over the list, which stays in sight. `'page'`: a centered page of its own in the content pane,
      as a command form is. Absent: a drawer for up to 8 fields without steps, a page for more or with steps. */
  open?: 'drawer' | 'page';
  /** Each field's own dress on this form: its caption, a help sentence, a placeholder, the input it is drawn as and,
      for a reference, the choices it offers. */
  fields?: Partial<Record<Field, AppFormField<Field>>>;
  /** Child rows asked with the record and inserted with it in one transaction — an order's lines: each a grid row of
      `show` inputs, added, removed and reordered before the record is saved. At most four. Each row is judged as its
      own insert would be (grants, validation), `whose` filled with the new record's key, `order` with its place. */
  lines?: readonly AppFormLines[];
  /** The resource's computed columns and rollups the form says as it is filled in, worked out in the browser by the
      server's own evaluator — `live: ['subtotal', 'total']`. A preview only: the saved record's figures are the
      server's. A rollup here sums a collection of `lines`; at most sixteen names. */
  live?: readonly string[];
}

/** One collection of child rows on a New form: `{ label: 'Lines', from: 'order_line', whose: 'order_id', show: ['product_id', 'quantity', 'unit_price'], order: 'position' }`. */
export interface AppFormLines<From extends string = string, Column extends string = string> {
  /** The grid's heading, as a group's `label` is. At most 80 characters. */
  label: string | AppMessageRef;
  /** The child resource; the App writes it (`access: 'write'`). */
  from: From;
  /** The child's reference to the new record, filled by the server. */
  whose: Column;
  /** The child's columns each row asks, as inputs (1–12); not `whose` or `order`. */
  show: readonly Column[];
  /** A numeric column the rows' places fill, 1, 2, 3 …: the order they were arranged in. */
  order?: Column;
  /** Fewest rows the record is saved with (0–64; default 0). */
  min?: number;
  /** Most rows (1–64; default 64). */
  max?: number;
}

/**
 * One field of a resource's New form, beyond what the catalog says of it. The input is chosen from the column: a
 * vocabulary is radios (up to four words) or a listbox, in its display words (`values`); a flag is a
 * switch; a date and a date-and-time are pickers; money carries its currency; a text of more than 255 characters, or
 * one named like prose (`description`, `notes`, `body`, `bio`, `comments`), is a box of several lines.
 */
export interface AppFormField<Field extends string = string> {
  /** This form's caption, where it should differ from the resource's `labels`. At most 256 characters. */
  label?: string | AppMessageRef;
  /** A sentence under the control: what to put there, or what happens when it is left empty. At most 256 characters. */
  help?: string | AppMessageRef;
  /** Example text inside an empty box. At most 256 characters. */
  placeholder?: string | AppMessageRef;
  /** A text column: `true` draws a box of several lines, `false` one line, whatever the column's type says. */
  multiline?: boolean;
  /** A vocabulary (an enum or a check-constrained text) or a flag, drawn as `'cards'` (a vocabulary), `'buttons'` (a
      flag's Yes and No, or a vocabulary's few), `'radios'` or `'select'`, over the default its kind and size pick. */
  as?: 'cards' | 'buttons' | 'radios' | 'select';
  /** A reference: offer only the records whose column equals a field of this form — `{ project_id: 'project_id' }`
      lists the chosen project's milestones. Keys are the referenced table's columns, values this form's fields, at
      most four. Enforced on every write, not only drawn: the server refuses a record whose reference falls outside. */
  where?: Readonly<Record<string, Field>>;
}

/**
 * How one column's values dress — grids, record fields, cards, dashboard metrics — in one object, one key per
 * concern: the figure (`format`, with its `currency` and `unit`), the words (`values`), the color (`tone`), the
 * mark (`icons`), a `bar`, a disc (`avatar`), a mask (`masked`):
 * `display: { amount: { format: 'money', unit: '/mo' }, stage: { values: true, tone: { won: 'good', lost: 'bad' } } }`.
 */
export interface AppDisplayRule {
  /** money: currency. percent: the value is 0–100, shown with %. number: separators. relative: a date said from today.
      items: a text of one item per line, drawn as a list (a line of them where there is no room).
      duration: a number of seconds said as its two largest units — "2h 15m", "3d 4h".
      email, phone, url: the value is a link — mail, a call, a page opened beside the App — where it has that
      shape. A column named like one (`email`, `phone`, `website`) is linked without a rule.
      richText: formatted text kept as sanitized HTML — drawn formatted on a record, as a one-line excerpt in a
      list, edited in the rich text editor; the server sanitizes every write and reads Markdown into it:
      `description: { format: 'richText', mentions: { from: 'agents', by: 'handle', labelColumn: 'name' }, images: 'case_files' }`.
      avatars: the people on a thing — an array, a JSON array, or one name per line or comma — as up to three
      overlapping initials discs and a "+N" for the rest; every name is the stack's text. Takes nothing else.
      rating: a whole number of stars out of `outOf` (5), picked by a star in a form; a `tone` may color it.
      color: a hex color (#1d6a5a) as its swatch and code, picked with the system's color picker.
      time: a time of day (14:30) in the reader's words; month: a month ("2026-10" or a date) as "Oct 2026";
      year: a year, said without separators — each edited in the matching native picker.
      json: a JSON document as a tree to open level by level, one line of it in a list; edited as text whose parse
      problem is said while it is typed, and a write that is not JSON is refused by its field.
      qr: the value as a QR code to scan — an asset tag, a link — with the value under it; the text in a list.
      These draw the value their own way, and take no currency, unit, tone (but a rating), bar, icons or values. */
  format?:
    | 'money'
    | 'percent'
    | 'number'
    | 'relative'
    | 'items'
    | 'duration'
    | 'email'
    | 'phone'
    | 'url'
    | 'richText'
    | 'avatars'
    | 'rating'
    | 'color'
    | 'time'
    | 'month'
    | 'year'
    | 'json'
    | 'qr';
  /** The face this column's values are set in, over the look's own: `data` (the look's data face, usually
      monospace), `ui` (the interface's reading face) or `code` (always monospace, for a VIN or a hash):
      `display: { vin: { face: 'code' } }`. Left out, an App sets a key, a reference, a code or a QR value in the
      data face and any other text in the reading face, because a name is not compared character by character.
      A rule with a `component` takes no face, the component sets its own; `masked: true` takes none either. */
  face?: 'data' | 'ui' | 'code';
  /** With format "rating": the stars of its scale, 3 to 10 (5 when unsaid). The value is a whole number of
      them, edited by picking a star. */
  outOf?: number;
  /** With format "percent": the value drawn as a small ring, filled against 100, beside the figure. */
  ring?: true;
  /** A number edited by dragging along its range — an NPS from 0 to 10, a threshold — the figure said beside
      it; drawn as the number everywhere else: `score: { slider: { min: 0, max: 10 } }`. */
  slider?: { min: number; max: number; step?: number };
  /** A code typed or read by the camera — a UPC, a QR code, a serial — where the browser can read codes
      (BarcodeDetector); the box is always there, so the form never waits on a camera: `upc: { scan: true }`.
      Takes no format. */
  scan?: true;
  /** A signature: on a column that points at a resource with `file`, a pad to draw on (Clear, Undo) or a name to
      type, kept as a PNG row of that resource and drawn as the picture: `signed_file_id: { signature: true }`.
      Takes no format. */
  signature?: true;
  /** With format "richText": who an @ names — the resource of people, the column stored as the handle, the column shown
      or a template of their columns (`labelColumn: '{first_name} {last_name}'`); typing after the @ matches any word of the label
      and the handle by its start —
      and, with `groups`, the teams an @ names as well, each told as its members by a `notify` rule's `mentions`:
      `groups: { from: 'team', by: 'id', labelColumn: 'name', through: 'team_member' }`, `through` the resource of link rows
      that puts a person in a team (absent: the people resource's own reference to the team). */
  mentions?: {
    from: string;
    by: string;
    labelColumn?: string;
    groups?: { from: string; by: string; labelColumn?: string; through?: string };
  };
  /** With format "richText": the file resource a pasted or dropped picture is kept in, as an attachment of the record. */
  images?: string;
  /** `true`: a short placeholder is drawn instead of every value, everywhere — grids, fields, cards and the record's
      name — and the rule takes nothing else. `{ prefix: 'ENC:' }`: only the values that start with it (ciphertext),
      said as the prefix and a placeholder; any other value is drawn by the rest of the rule. Presentation, not
      protection: the value still reaches the browser; `hidden` on the resource is what keeps a column out of it. */
  masked?: true | { prefix: string };
  /** For "money": ISO 4217 (`'EUR'`), or `{ column: 'currency_code' }`, another column of the same record holding each
      row's code. Absent, `ui.currency`, else USD. */
  currency?: string | { column: string };
  /** For "money": the column holds a whole number of the currency's minor units — cents, paise, yen — and is drawn,
      edited, totalled, imported and exported as the major figure, in the currency's own decimals (2 for USD, 0 for JPY,
      3 for KWD): `total: { format: 'money', minor: true, currency: { column: 'currency_code' } }`. The column is an
      integer; a decimal money column needs nothing. */
  minor?: true;
  /** With "number", "money" or no format on a numeric column: the unit said after the figure — "mi", "kg", "/mo" (a leading slash joins
      without a space: "$242/mo"). At most 12 characters. */
  unit?: string | AppMessageRef;
  /** Value → tone pills. Keys may be exact values or numeric thresholds
      (">= 90"); for numbers, the first satisfied threshold wins. The key
      "*" is the fallback for every value no other key names; without it
      those wear `neutral`, so a vocabulary is all pills rather than pills
      beside bare text. */
  tone?: Record<string, 'good' | 'warn' | 'bad' | 'info' | 'neutral'>;
  /** Draw the value as a small bar beside it: `true` on format "percent", which fills against 100; for any other
      number, the value that fills it — `bar: 5` for a rating out of five. A tone rule colors the bar. */
  bar?: true | number;
  /** An initials disc before the value: a person's or a company's name. Given a file resource of photos,
      `{ from: 'member_avatar', whose: 'member_id' }`, the disc is the record's photo — its first file, drawn
      through the file route under the reader's grants — and the initials where there is none or the reader
      may not read it. */
  avatar?: boolean | AppAvatarPhoto;
  /** Value → an App icon drawn before the word: `{ rush: 'fire', high: 'cell-signal-high', low: 'cell-signal-low' }`.
      It stands where a tone's dot would, in the tone's color; the word stays, for every reader and for assistive
      technology. Not beside `avatar`, and not on a figure (money, a percent, a bar). */
  icons?: Readonly<Record<string, AppIcon>>;
  /** The words a vocabulary's values are said as, in a cell, a field, a card and a group's head. A column with a
      `tone` is a vocabulary already: `IN_REVIEW` and `in_review` read "In review". A map names your own —
      `values: { PUB: 'Published', DRF: 'Draft' }` — and any value it does not name is still said as words. The stored
      value is what filters, exports and is written, and `tone` and `icons` stay keyed by it. A column whose values
      the database declares (an enum, a `CHECK (stage IN (…))`) sorts in that declared order, in lists, the column
      menu and the API; free text sorts as text. At most 80 characters a word. */
  values?: Readonly<Record<string, string>>;
  /** Another column of the same record, said as a muted second line under the value in lists. */
  subtitle?: string;
  /** A small tinted square before the value in a list's cell: an App icon, in the accent's tint, or with `toneOf`
      another column of the same record whose own `tone` rule tints each row's square —
      `name: { icon: { mark: 'lightning', toneOf: 'status' } }`. */
  icon?: AppIcon | { mark: AppIcon; toneOf?: string };
  /** Value → one of the theme's eight chart colors (1–8): the stripe and chip of a board card's `category`, so a
      vocabulary keeps one color per value in every look: `kind: { colors: { design: 1, research: 3, ops: 5 } }`.
      A value it does not name takes a color fixed by its text. Not on a figure. */
  colors?: Readonly<Record<string, 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8>>;
  /** A value renderer: `component('hours-bar', { module, kind: 'value' })` draws the value in an App, where the
      rest of this rule dresses it until the module has arrived. Sort, filter, totals, export and the
      Workbench keep the raw value. The component alone may stand in the rule's place: `display: { hours: hoursBar }`. */
  component?: ComponentDecl<string, 'value'>;
}

/** An avatar's photo: the first file of a file resource whose `whose` column names the record. */
export interface AppAvatarPhoto {
  /** A resource whose rows are files (`file` on the resource). */
  from: string;
  /** Its column that points at the record the avatar is of. */
  whose: string;
  /** Which file leads where a record has several: "position", "added_at desc". */
  sort?: string;
}

/* ---------- custom components ----------
   An author's own React module, referenced by path and placed through a declared kind: a `custom` section on a
   page or a dashboard, a value renderer where a display rule stands, an input where a form draws a field
   (`inputs`) or a list view's rows (`customList`). The definition stays data — a component is a name and a path — and
   what it reads is declared beside it, so it is checked, planned and authorized like any section. The module draws
   with `@mistriwork/mistri/ui`. A whole page of the App's own is a file of its own, `pages/<path>.page.tsx`, made with
   `definePage` from `@mistriwork/mistri/page`. */

/** One prop a component declares: JSON-safe, with its default and its bounds, checked where it is placed. */
export type ComponentPropDecl =
  | { type: 'number'; default?: number; min?: number; max?: number }
  | { type: 'text'; default?: string; max?: number }
  | { type: 'boolean'; default?: boolean }
  | { type: 'choice'; options: readonly string[]; default?: string };

/** Where a component is placed: a section, a value renderer, a form's input, a list's rows, or a free-form page
    (`definePage` in pages/*.page.tsx). */
export type ComponentKind = 'section' | 'value' | 'input' | 'list' | 'page';
/** What `component()` returns, its `kind` saying where it may be placed. */
export interface ComponentDecl<Id extends string = string, Kind extends ComponentKind = ComponentKind,
  Props extends Readonly<Record<string, ComponentPropDecl>> = Readonly<Record<string, ComponentPropDecl>>> {
  id: Id;
  /** A path inside the App directory, written from it: './widgets/PayrollTimeline.tsx'. */
  module: `./${string}`;
  kind: Kind;
  props?: Props;
}

type PropValue<P> = P extends { type: 'number' } ? number : P extends { type: 'text' } ? string : P extends { type: 'boolean' } ? boolean
  : P extends { type: 'choice'; options: readonly (infer V)[] } ? V : never;
/** A component's props as its module receives them: a prop with a default is always there. */
export type PropValues<Props> = { readonly [K in keyof Props as Props[K] extends { default: unknown } ? K : never]: PropValue<Props[K]> }
  & { readonly [K in keyof Props as Props[K] extends { default: unknown } ? never : K]?: PropValue<Props[K]> };
/** A component's props as a placement gives them: any of the declared ones, each of its declared type. */
export type PropInput<Props> = { readonly [K in keyof Props]?: PropValue<Props[K]> };

/* ---------- data: sources and resources ---------- */

/** A named binding to a server-configured connection. `Connection` narrows it to the configured names (the generated `Connections`). */
export interface AppSource<Connection extends string = string> {
  /** A server-configured connection ID or name. URLs and credentials stay in server configuration. */
  connection: Connection;
  /**
   * The source whose resources stay bare. Beside other sources, at most one
   * says `true`, and none has to: without one, every resource is
   * `source.name`. A source standing alone is the default unless it says
   * `false`, which keeps its `source.name` names when the others go.
   */
  default?: boolean;
  /**
   * The one schema of its connection this source sees: a PostgreSQL schema.
   * Several sources may name one connection this way, each
   * with a schema of its own; each sees only its schema's tables, and a real
   * key from one of them to another joins as it would in one database. The
   * connection's `schemas`, where it lists any, must include it. Not on SQLite.
   */
  schema?: string;
  /**
   * The tables this source brings into the App without a block each:
   * `'all'`, or their names in this source. Each is an implicit `{}` block,
   * so it grants nothing a block would not; `authority.lock` records it.
   */
  resources?: 'all' | readonly string[];
  /**
   * A platform-only source: another database a tenant App's platform realm
   * (`auth.tenancy.platform`) reads and nothing else does. Never the default;
   * each of its resources is `owner: 'platform'` (read, never written), read under
   * the policy's `resolvePlatformRows` by its qualified name. Never written,
   * looked up by a command or served through the App API.
   */
  realm?: 'platform';
}

export interface AppFieldAccess<Column extends string = string> {
  /** Exact local column names; the complete primary key must remain readable. */
  read: readonly Column[];
  /** Defaults to no field writes. Needs the resource's access 'write'. */
  write?: readonly Column[];
}
/** A role's columns of one resource: `read` omitted is the resource's own read ceiling, so a role may narrow only `write`. */
export interface AppRoleFieldAccess<Column extends string = string> {
  /** Exact local column names, within the resource's ceiling; the complete primary key must remain readable. */
  read?: readonly Column[];
  /** Defaults to no field writes. Needs the resource's access 'write'. */
  write?: readonly Column[];
}

/** A text column's rule (`resources.<name>.text`). At least one of `min`, `max` and `pattern`. */
export interface AppTextRule {
  /** Fewest characters, counted after trimming. 1 to 16384. */
  min?: number;
  /** Most characters. 1 to 16384, and not under `min`. */
  max?: number;
  /** A regular expression (JavaScript, `u` flag) the whole value matches: `'^[A-Z]{3}$'` and `'[A-Z]{3}'` say the same. */
  pattern?: string;
  /** What the form says under the field when the rule is not met; a plain sentence naming the rule otherwise. */
  message?: string | AppMessageRef;
}

/**
 * One logical resource and everything the App says about it. Keyed by its
 * logical name: bare for the default source (or the single connection),
 * `source.name` for a secondary source — the only meaning a dot has in a
 * resource slot.
 */

/** An S3-compatible bucket a file resource keeps its bytes in. Its address only: the credentials are the server's environment. */
export interface AppFileBucket {
  /** The bucket's name. */
  name: string;
  /** Its region: 'us-east-1' when unsaid; 'auto' for R2. */
  region?: string;
  /** The service's address, for any but AWS: 'https://<account>.r2.cloudflarestorage.com', or a local one such as `http://localhost:9000`. */
  endpoint?: string;
  /** true addresses the bucket as a path ('<endpoint>/<name>/<key>'), as MinIO wants; otherwise as a host. */
  pathStyle?: boolean;
  /** A folder every key goes under, so Apps can share one bucket: 'tablewalk/'. */
  prefix?: string;
  /** true sends a download straight from the bucket, by a redirect to a URL signed for a minute; otherwise it passes through the server. */
  presign?: boolean;
}
export interface AppResource<Column extends string = string, Page extends string = Lowercase<string>> {
  /** The physical table id when it is not inferred. The only place an
      engine-schema-qualified id ("public.opportunity") appears. */
  physical?: string;
  /** The App's ceiling for this resource. An App serves only the resources
      it declares, signed in or not, and a declared one reads; say `'write'` for
      one the App writes. With `auth.roles`, roles grant within the ceilings. */
  access?: 'write';
  /** true lets this resource's records be deleted: Delete is offered last in
      the record's More menu, and the server accepts it. Absent, nothing in
      the App deletes them, whatever `access` and the connection allow.
      It needs access 'write'. */
  delete?: boolean;
  /** true puts a star on this resource's records, so a reader can keep them in Favorites. */
  favorite?: boolean;
  /** A settings record: the resource holds one row (a company profile, payroll settings), opened from the
      reader's settings — the account menu — under these words, 1 to 60 characters: `settings: 'Company profile'`.
      Its page and its grants are the resource's own; the first row by key is the one opened. */
  settings?: string;
  /** The rows are files: `content` is the binary column holding the bytes (BLOB,
      bytea), `name` the file name; `type` and `size`, when named, are filled
      from the upload. A related list over the resource draws as attachments,
      uploading where the reader may add a row (its `create` names the label). `thumbnail` names a binary column holding
      a smaller copy of the picture, which cards and gallery strips draw
      instead of the whole file; whoever writes the row fills it, and a row
      without one is drawn from the file. `maxBytes` caps an upload: 10 MB when
      unsaid, at most 25 MB. In a row-policy App an upload is an insert the
      policy judges, and removing a file a delete. A tenant App reads and
      uploads its files on the tenant's lease, each at most 10 MB, and only
      its own tenant's. `storage: 'bucket'` keeps new files' bytes in an
      S3-compatible `bucket` (AWS S3, R2, MinIO, B2, Tigris) instead, the row
      naming the object in its `object` column (`content` then null); `hash`
      names a text column for each file's SHA-256. The server's
      MISTRI_S3_ACCESS_KEY_ID and MISTRI_S3_SECRET_ACCESS_KEY sign
      every request, and never App source; the server does not start
      without them. `object` and `hash` need no grant in `fields`: a reader
      of `content` reads the file, and they are the server's alone, sent to no
      browser and named by no request, App API or MCP tool.
      An upload is one request, so `maxBytes` stays at most 25 MB with a
      bucket too; multipart upload is not supported. `mistri migrate files`
      moves files to where `storage` says and sweeps objects no row names; an
      App served with jobs is swept daily by the server, a tenant App tenant by tenant. */
  file?: {
    content: Column;
    name: Column;
    type?: Column;
    size?: Column;
    thumbnail?: Column;
    maxBytes?: number;
    /** A text column naming each file's object in the bucket; null for a file kept in `content`. The server's alone: granted with `content`, named by no request. */
    object?: Column;
    /** A text column the upload fills with the file's SHA-256 (hex), which tags it for caches. The server's alone: granted with `content`, named by no request. */
    hash?: Column;
    /** Where new files' bytes go: 'database' (when unsaid) or 'bucket'. A file is read from wherever its row says. */
    storage?: 'database' | 'bucket';
    bucket?: AppFileBucket;
  };
  /** The records carry tags: rows of `to`, linked through `through`, a table
      with one reference to this resource and one to `to`. They draw as chips
      under the record's title; where `through` is declared writable with
      `delete: true`, a picker adds and removes them, one link row at a time.
      `toneOf` names a column of `to` holding good | warn | bad | info | neutral.
      `add` and `remove` name commands on this record, each with a `tag` input (the tag's key):
      named, the picker runs them instead of writing link rows, for a reader granted them; they need not
      also be the resource's actions. */
  tags?: { through: string; to: string; toneOf?: string; add?: CommandName; remove?: CommandName };
  /** Search through a search provider: `fields` are the columns the index holds — or one step along a
      reference, `'requester.name'`, whose value each document copies and follows — and `connection`
      names the provider's connection. The list's filter box, reference pickers and the palette ask it
      and re-read the rows under the reader's grants; while it is down they search the database, as
      they do without it. Needs a single-column primary key. On a tenant App each document keeps its
      tenant and a search asks within the member's tenant. Search providers are packs (Typesense is
      `@mistriwork/search-typesense`, SQLite FTS5 is `@mistriwork/search-sqlite`, Postgres tsvector is
      `@mistriwork/search-postgres`), which ship after 1.0; until one is plugged in, an App that
      declares `search` is refused at startup — except through the built-in connection `memory`,
      which searches an in-memory index in the server process (lost on restart until the next
      reindex, and suited to moderate tables, not a large catalog). */
  search?: { connection: string; fields: readonly (Column | `${Column}.${string}`)[] };
  /** The record's states and the verbs that move it between them: `machine('status', { … })`. The column changes
      only along the graph, on every door — a form, a list, an import, a command, the App API — and the page's
      buttons, stepper, board lanes and history lines are drawn from it. */
  machine?: AppMachine<Column>;
  /** Timers at an instant the record keeps: `at: { due_at: 'markSla', warn_at: { command: 'warnSla', when: "state =
      'running'" } }`. Each runs its command through the jobs once the date or timestamp column's time has passed
      and the record matches `when` (query-language conditions over the record's own columns; a machine state is
      `"status = 'open'"`), once for each instant the column holds: writing a new instant arms it again. */
  at?: { readonly [C in Column]?: CommandName | AppAtTimer };
  /** Column ceiling for signed-in roles: needs `auth` with `auth.roles`; `write` needs access 'write'. To keep a
      column from every reader, signed in or not, use `hidden` (`mistri docs secrets`). */
  fields?: AppFieldAccess<Column>;
  /** Columns no reader of the App is ever served, with sign-in or without: `hidden: ['password_hash']`.
      The server cuts them from the catalog it answers with, so lists, records, exports, history, search and
      the App API never carry them, and a query, filter or sort that names one is refused as naming a column
      that is not there. No role re-grants them, and no form, edit or action writes them. Never the primary key,
      the `address`, or a `search` field. A database role without SELECT on the column is stronger still;
      `"hidden"` on the connection in mistri.json covers the database browser and MCP too. */
  hidden?: readonly Column[];
  /** Soft keys: a column that names a record of another resource without a foreign key in the database —
      `references: { product_sku: { to: 'product', column: 'sku' } }`. Followed like a foreign key wherever one is:
      the list shows the target's `recordLabel`, the value opens the target record, the target's page lists the
      rows that name it, and rollups, filters, sorts and label paths walk it. `column` defaults to the target's
      primary key and must be proven unique (the primary key, or a unique constraint or index on it alone); the two
      columns must be of one kind. A target in another source on the same connection joins in SQL; one on another
      connection (`to: 'catalog.product'`) is read in two steps, the list and then one read of the keys the page
      names through that source's grants and row policy: it labels, links and gives the target a related list, and
      a filter, sort, grouping, rollup, `tags` or `notify` path through it is refused. Under `auth.rows: 'policy'` or
      `'tenant'` a path through one is scoped like a key; a tenant App's stay within its source. The reader's grants,
      `fields` and `hidden` on the target apply as on any key, and a
      reference is never authority for a write: no cascade, no delete impact, no write check reads it. */
  references?: Partial<Record<Column, { to: string; column?: string }>>;
  /** How each column's values dress, keyed by column. */
  display?: Partial<Record<Column, AppDisplayRule | ComponentDecl<string, 'value'>>>;
  /** SQLite: what a TEXT column holds where its declared type cannot say — `types: { due_on: 'date' }` for ISO
      dates (`2026-09-24`), `'datetime'` for `2026-09-24 14:30:00`. The App's catalog reads the column as a date, so
      a dashboard's `over`, a timeline's `at`, a calendar, date presets and date filters take it; the database still
      holds text, compared as a DATE column's is. Refused on PostgreSQL, where the column's type says it. */
  types?: Partial<Record<Column, 'date' | 'datetime'>>;
  /** A column's control in the resource's edit and New forms, drawn by the App's own input component
      (`component('color-swatch', { module, kind: 'input' })`). What the value must be is still the form's and the server's to judge. */
  inputs?: Partial<Record<Column, ComponentDecl<string, 'input'>>>;
  /** Resource invariants, enforced on every write. */
  validation?: readonly FormRule[];
  /** How long a text column's value may be and what form it takes, keyed by column:
      `text: { code: { pattern: '^[A-Z]{3}$', message: 'Three capital letters.' }, name: { min: 2 } }` — the words a
      command's text input uses. The New form says the rule under the field as someone types, and the server holds
      every write to it, whichever door it came through. On PostgreSQL the database's own words come free: a
      `varchar(80)` is `max: 80`, and a `CHECK (char_length(name) >= 2)` or `CHECK (code ~ '^[A-Z]{3}$')` in that
      simple form is `min` or `pattern`; the App's rule wins key by key. An empty value breaks no rule (whether one is needed
      is NOT NULL's to say). */
  text?: Partial<Record<Column, AppTextRule>>;
  /** One caption per column (or label path), used by every view, page list and form. */
  labels?: Partial<Record<Column | `${Column}.${string}`, string | AppMessageRef>>;
  /** What names one record: a column or path (`name`, `party_id.display_name`), or a template of them in braces —
      `'PO-{id}'`, `'{product_id.name} × {qty}'` — computed in the statement, so lists sort and search by it. A table
      with no name column of its own is named by its noun and key ("Purchase order #3") unless this says otherwise.
      A column whose stored codes its display rule says as words (a vocabulary, `values`) names the record
      in those words, as its cell does ("Identity", not "identity"). */
  recordLabel?: Column | `${Column}.${string}` | LabelTemplate | AppMessageRef;
  /** The New form wherever this resource's records are created from a list:
      every view's New button and quickAdd. A related list's `create` keeps its
      own `show`, because it binds the parent. */
  form?: AppForm<Column>;
  /** What may be done to one record, keyed by its id and drawn in the order written: defined once and offered
      wherever the records appear — on record pages; in a queue, the `bulk` ones for a selection; on a board, the
      updates that set exactly its `by` to a lane. Everything else names an action by its id, a string tsc checks
      against these keys: a header's `primary: 'withdraw'`, a queue's `actions: ['approve']`, a role's
      `actions: { pay_run: ['submit'] }`. `{ withdraw: action('Withdraw application', { command: 'withdrawApplication' }) }`. */
  actions?: Readonly<Record<string, Action<CommandName, string | AppMessageRef> & MadeBy<'action'>>>;
  /** The page this resource's records open through, only when two pages
      share its base; otherwise the single page is the default. */
  page?: Page;
  /** The list view its records are addressed through (`/{app}/{view}/{id}`), when more than one lists them:
      a preference for whoever is served it, passed over for a person who is not. Absent: the first list view
      over it, among the views that person is served, in the menu's order with no standing query and no split. */
  view?: string;
  /** A natural key: the column whose value is the record's address instead of its primary key
      (`/shop/products/SKU-1049`). `mistri check` refuses one the catalog does not prove NOT NULL and
      unique (in a tenant App, unique within the tenant: `UNIQUE (tenant_id, number)`), and warns where a form or action can change it — an edited key breaks every link to the record. */
  address?: Column;
  /** true follows a numeric id with the record's name on public pages (`/forecourt/vehicles/1-2021-toyota-corolla`),
      from `recordLabel` or the name column. Only the id is read back: any other spelling opens the record and is
      rewritten to this one. */
  slug?: boolean;
  /** What one record is called, as it reads mid-sentence — `'issue'`, its plural made by rule — or `{ one, many }` for a
      plural no rule makes, or a `msg()` with an ICU plural (`'{count, plural, one {person} other {people}}'`) that
      a translation can say its own way. It names the New button, a split's detail and, when they say none, a page and a list. */
  noun?: string | AppMessageRef | { one: string; many: string };
  /** Who owns the resource's rows under `auth.rows: 'tenant'`, where it is required: 'tenant' (one tenant's, by its ownership column), 'global' (shared reference data) or 'platform' (the platform realm's, `auth.tenancy.platform`). */
  owner?: 'tenant' | 'global' | 'platform';
  /** What a tenant clone copies of this `owner: 'tenant'` resource into a sandbox tenant (`mistri tenant clone`):
      `'config'` rows always, `'sample'` rows only when the clone asks for samples. Unmarked, nothing. A sandbox's
      changes to `'config'` rows are what an import brings back to the live tenant. */
  clone?: 'config' | 'sample';
  /** What the durable write trails keep of these rows. Under a support session every Save, New, Delete, Undo and command appends one
      audit entry in the business write's own transaction; a column named in `redact` is recorded as a keyed hash instead of its value, in the
      change and in a delete's before image alike, and every other column keeps its value. A page's `history()` keeps no value of a column named
      here at all, only that it changed. `'values'` marks every column. */
  audit?: { redact: 'values' | readonly Column[] };
  /** `false`: on an App with `live: true`, a write to this table is not announced and no page follows it, for a hot or
      log-like table whose every write would set pages reading again; its pages refresh on focus and after their own
      saves. Absent, the App's choice. Means nothing on an App without `live: true`. */
  live?: false;
  /** Rows from a CSV file, offered as Import beside New on every list over the resource. `true` creates each row as a
      record through the ordinary insert — the reader's grants and field grants, the row policy, `validation` and
      machines judge every row, a check writes nothing, and the commit is one transaction. For a
      resource whose writes are its commands', `{ command, match }` runs that command once per row, on the record the
      row's `match` columns find. On a tenant App every row lands in the member's own tenant. */
  import?: boolean | AppImport<Column>;
  /** Numbers about the rows that point at each record, by name — `{ lines: count('order_line'), total: sum('order_line',
      'amount') }` — read like columns wherever a column is: a list's `show`, a sort, a tab's condition, a page's fields,
      `display` and `labels`. Computed in the record's own statement, through the child's grants and row scope; never
      written, and never offered by a form. */
  rollups?: Record<string, AppRollup>;
  /** Named conditions on this resource's rows, each read as one word — `{ open: 'status = open', overdue: { query:
      'open and due_on < today', label: 'Late' } }`: a tab names one (`tabs: ['open']`), a source does
      (`metric('Overdue', 'work_order.overdue')`), so does a rollup (`count('work_order', { segment: 'open' })`). Its label
      is its name said as words unless it gives one. A reader who may not read a column one names is served none of it. */
  segments?: Record<string, AppSegment>;
  /** This row uses up a number on the record it points at, kept true on every write: an insert takes `by` from the
      balance (refused below zero), a delete gives it back, an edit moves the difference. One, or a list. */
  consumes?: AppConsumes | readonly AppConsumes[];
  /** `consumes` the other way round, on a line that brings stock in (a receipt, a return to stock): an insert adds
      `by` to the balance, an edit moves the difference, and a delete takes it back out, refused with `refuse` where
      what it brought in has been used since. So Receive stock is a New form on the receipt line, not a command:
      `stock_receipt: { restocks: { column: 'part_id.on_hand', by: 'quantity' } }`. One, or a list. */
  restocks?: AppConsumes | readonly AppConsumes[];
  /** Row-defined fields: a JSON column whose keys are defined by another resource's rows, which people edit at runtime
      — `{ specs: { from: 'attribute', per: 'category_id' } }`. Each definition row has `key`, `label` and `type` (text,
      textarea, number, money, date, datetime, bool, choice or choices), and may have `options` (one per line),
      `required`, `help` and `position`. `per`, a column both tables have, picks the definitions whose `per` equals
      the record's, and those whose `per` is empty. The keys are drawn on record pages and forms as the record's own
      fields, judged at the server in the write's transaction (refusals name `specs.capacity`), and asked by a list as
      `specs.capacity`; a view's `filters` naming the column offers one refinement per definition. */
  defined?: Partial<Record<Column, AppDefined>>;
  /** Flows whose steps are rows, which people edit while the App runs: `{ from: 'po_flow', steps:
      'po_flow_step', events: { 'po.decided': 'order' }, kinds: { approval: { command: 'requestApproval', input:
      ['approver'], waitFor: 'po.decided' } } }`. A flow row has `id`, `name` and `start` (`created`, `updated` or
      `manual`), and may have `condition` (the query language, over this record's stored columns), `changes` (the
      column an update must change) and `active`. A step row has `flow_id`, `position` and `kind`: the platform's
      `wait` (`duration`), `until` (`field`, a date column, and `duration?` after it), `branch` (`condition`, and
      `goto`, the step a run goes on at when it does not hold; none ends the run), `set` (`field` of `set`, `value`),
      `waitFor` (`event` of `events`, `duration?` as its timeout), `notify` (`audience`, which a notify rule's
      `on: { flow }` names, and `message`, at most 500 characters), or one of `kinds`, which runs the App's command
      on the record. Steps that share a position start together, and the run goes on once each is done. Rows are
      judged as they are written; a run keeps the rows it started with. A jobs module's `flowRunner(resource, { runAs, listens })`
      runs them, started by the record's own history: so the resource keeps one. */
  flows?: AppFlows<Column>;
  /** Virtual columns, each a typed expression over the record's own columns (and paths through its references), in
      the query language's words with `today`, `now` and `me`: `{ is_overdue: computed.boolean('due_on < today and not
      completed'), days_open: computed.number('today - opened_on'), renews_on: computed.date('ends_on + term months') }`;
      hours and minutes move an instant (`computed.date('due_at - 2 hours')`, `updated_at > now - 30 minutes`);
      `coalesce`, `round`, `abs`, `min` and `max` are its functions (`computed.number('max(owed - paid, 0)')`).
      Written into the statement on every engine, so a list shows, sorts, filters, tones and exports by them, and a
      `when` or a query names them like columns. Never written and never in a form; a reader is served one only where
      every column it reads is served to them. Heavier logic belongs in a database view or a generated column. */
  computed?: Record<string, AppComputed>;
  /** Which writes tell which people — a reply to someone's thread, a task assigned to someone, an order of theirs
      received — each kept in its person's inbox (the bell in the App bar) until they have read it. Written beneath
      every door a write comes through, in the write's own transaction, into reserved tables provisioned once
      (`mistri migrate stores up`, or `provisionStores` from `@mistriwork/mistri/maintenance` with `only: ['inbox']`) — the
      App does not start without them. The person who made the write is never told. Needs sign-in. Under
      `auth.rows: 'tenant'` a notice is kept in the inbox of the tenant whose record was written, and read only there. */
  notify?: readonly AppNotifyRule<Column>[];
}

/** A resource's row-driven flows: the tables of its flows and their steps, and what their rows may do. */
export interface AppFlows<Column extends string = string, Table extends string = string> {
  /** The declared resource whose rows are the flows. */
  from: Table;
  /** The declared resource whose rows are the flows' steps. */
  steps: Table;
  /** The record's own columns a `set` step may write. None: the App offers no `set` step. */
  set?: readonly Column[];
  /** Each event a run may wait for, with the payload field naming the record it is about: `{ 'po.decided': 'order' }`. */
  events?: Readonly<Record<string, string>>;
  /** The step kinds the App adds, each running one of its commands on the record. */
  kinds?: Readonly<Record<string, AppFlowKind>>;
}
/** A step kind the App adds to its flows: its command, the step columns passed as its input, and an event of `events`
    waited for after it. A step of a kind that waits may say `mode` (`all` waits for one event per each its command
    answers it asked, `{ asked: 3 }`), `condition` (ends the wait early once it holds), `duration` (gives up and goes
    on) and `remind` (how often, like `1 day`, to run the kind's `remind` command while it waits). */
export interface AppFlowKind {
  command: string;
  /** Step columns passed under their own names; `'note?'` for one a step may leave empty. */
  input?: readonly string[];
  waitFor?: string;
  /** A command run on the record, with the step's input, each time a step's `remind` passes without the event. */
  remind?: string;
}

/** One row-defined column: the resource whose rows define its keys, and the column both share that scopes them. */
export interface AppDefined<From extends string = string, Per extends string = string> {
  /** The declared resource whose rows define the fields. */
  from: From;
  /** A column the record and the definitions both have: a record is shaped by the definitions whose value equals its own, and those whose value is empty. */
  per?: Per;
}

/** One `notify` rule: `{ on: 'insert', to: 'thread_id.author_id', title: 'New reply in {thread_id.title}', opens: 'thread_id' }`. */
export interface AppNotifyRule<Column extends string = string, Path extends string = string> {
  /** What happens: a new record, any change to it, a change to one of these columns (an assignment is a change to the
      column that names who), the action that ran, by its id: `{ action: 'approve' }`, or a flow's `notify` step
      telling this audience: `{ flow: 'requester' }`, whose `{message}` the title may say. */
  on: 'insert' | 'update' | { changes: Column | readonly Column[] } | { action: string } | { flow: string };
  /** Only when the record, after the write, meets this condition, in the query language over its own columns: `'status = received or status = cancelled'`.
      `=`, `!=` and `in`, joined by `and` / `or`. A `satisfies App` reads its first word against the table's columns;
      under `defineApp` or `defineFeature` the whole condition is read (packages/mistri/schema/query.d.ts). */
  when?: `${Column} ${string}`;
  /** Who is told: a text column holding an email, a reference to the table `auth.me` names, or a path of at most two
      references to either (`'thread_id.author_id'`). One, or several. Optional where `mentions` names who. */
  to?: Path | readonly Path[];
  /** The people a text column mentions, found by a handle column of the table `auth.me` names: a plain text column's
      `@handle` words (`{ in: 'body', by: 'handle' }`), a rich text column's stored mentions (`{ in: 'description' }`, its
      display rule's `by`, which the rule must agree with), a team mentioned told as its members. On an update, only
      whom the write newly mentions is told. A mention tells only someone who may read the record; at most twenty a write. */
  mentions?: { in: Column; by?: string };
  /** Tell it on an integration's channel too (`{ channel: 'sms', to: 'customer.phone', consent: 'customer.sms_ok' }`): the
      title is the message, sent to the address `to` reads off the record after the write commits, under the channel's
      rules — suppressed for a recipient who opted out, or when `consent` is not true and they never opted in; held
      through the jobs module's quiet hours, read in the `timezone` column's zone where there is one. Queued in the
      write's own transaction. A rule with `send` may leave `to` (the inbox's) out.
      `channel: 'email'` mails an address the record holds — someone with no account, such as a customer — through the
      config's email service, whose `links.secret` signs the unsubscribe link at each message's foot and in its
      List-Unsubscribe header: plain text, the title its subject. Besides the opt-out and `consent`, a public visitor's
      write mails only an address they proved with a code in the form (`link.email.verified`), and an address gets at
      most five a day (the App five hundred an hour). No `timezone`: mail waits in an inbox. Its store is made by
      `mistri migrate stores up --app`. */
  send?: { channel: string; to: Path; consent?: Path; timezone?: Path };
  /** Each notice is emailed too, after the write commits, through the config's email service: only to an account of the
      App, only while its grants may read the record, never to one that turned email off in Notifications. A send that
      fails is tried again later and never fails the write. */
  email?: true;
  /** The notice as its reader sees it, at most 200 characters: words with `{column}` or `{reference.column}` filled
      from the record after the write. Said only while its reader may read every column it names. `msg('ticket.assigned',
      { title: 'title' })` says it from the App's catalogs in each recipient's own language. */
  title: string | AppMessageRef;
  /** The reference whose record the notice opens (`'thread_id'`); absent, the record itself. */
  opens?: Column;
}

/** A command import: the command each row of a file runs, and the columns that find the record it runs on — a
    reference column found by the record's name (`bin_id` by a bin's code). */
export interface AppImport<Column extends string = string, Command extends string = CommandName> {
  command: Command;
  match: readonly Column[];
}

/** A computed column: what it comes to, and its expression. `computed.boolean('…')` writes one. A rollup's `column`
    and a dashboard window's `over` may name one that reads only its row's own columns. */
export interface AppComputed {
  type: 'boolean' | 'number' | 'date';
  value: string;
}

/** A rollup: `count` of the `from` rows pointing at the record, or the `sum`, `min` or `max` of one of their columns.
    Over no rows a count and a sum are 0; a min, max or latest is empty. `whose` names the reference when `from` points here more than once, or two references when `from` points at a record
    that points here (`sum('time_entry', 'hours', { whose: 'task_id.project_id' })`, read under the reader's grants on
    both tables); `query` narrows which rows count, over `from`'s own columns and paths through its references to a
    stored column (`'status = open'`, `'sales_order_id.status != cancelled'`). The column may be a
    computed one of `from` (`sum('task', 'overrun')`), written inline, so long as it reads only its row's own columns:
    not a rollup, a reference or `me`. */
export interface AppRollup<From extends string = string, Column extends string = string, Whose extends string = string> {
  fn: 'count' | 'sum' | 'min' | 'max' | 'latest';
  from: From;
  column?: Column;
  whose?: Whose;
  query?: string;
  /** One of the table's segments (`resources.<table>.segments`), its conditions ANDed with `query`. */
  segment?: string;
  /** A `latest`'s order: the column of `from` (a date or a number) whose greatest value is the newest row; its key when absent. */
  sort?: string;
}

/** A record label template: words around columns or paths in braces, `'PO-{id}'`. The names in braces are checked
    when the App loads. */
export type LabelTemplate = `${string}{${string}}${string}`;

/* ---------- auth ---------- */

export interface AppRoleGrant<Resource extends string = string, Role extends string = string> {
  /** The role's name as people read it, wherever a screen names the role (accounts, grants, invitations):
      `{ loan_officer: { label: 'Loan officer', read: true } }`. Absent: the id, made readable. Words only; it grants nothing. */
  label?: string | AppMessageRef;
  /** Another role whose grants this one holds too: `manager: { extends: 'mechanic', commands: ['approveQuote'] }`
      reads, writes and runs all a mechanic does, and approves quotes. A chain is followed; a loop is refused. Only
      grants pass down (reads, writes, creates, commands, actions, operations, flags and column narrowing, each the
      union of both) — never `label`, `claims` or `service` — and a role extends one of its own realm. authority.lock
      lists what the role holds in full. A view's or page's `roles` open to a role that extends one they name; a row
      policy's `principal.roles` still match by name. */
  extends?: Role;
  /** @preview */
  flags?: readonly FlagCapability[];
  /** @preview */
  experiments?: readonly ExperimentCapability[];
  /** true grants the App's read ceiling (every declared resource); a list names some of them. */
  read?: boolean | readonly Resource[];
  /** true grants the write ceiling (every resource with access 'write'); must stay within the role's reads. */
  write?: boolean | readonly Resource[];
  /** Of what the role writes, what it makes new records in. Absent: everything it writes. `false`: it edits and
      never creates, so New, quick add and a related list's add are not offered and the server refuses the insert.
      A list names the few it creates: `{ write: ['lead', 'note'], create: ['note'] }`. Commands still create
      what they write; this limits the generic insert only. */
  create?: false | readonly Resource[];
  /** Tables the role may export (the whole matching list as a CSV or JSON file) beyond those it writes, which it
      always may. Of what it reads. A person may export a table if any of their roles writes it or lists it here; a
      signed-out visitor never may. `{ read: ['charge'], export: ['charge'] }`. Enforced by the server. An App without role grants keeps its one switch, `ui.export`. */
  export?: readonly Resource[];
  /** The commands the role runs, by name. Default: none. Does not grant generic CRUD access. */
  commands?: readonly CommandName[];
  /** Fixed actions the role runs on a resource it reads and does not write, by action id:
      `{ pay_run: ['submit', 'approve'] }`. The server admits the update only as
      that action — its `set`, its reason column, its `when` on the stored row.
      Under `rows: 'policy'` only on a row the policy gives the principal, before and after the write;
      not supported with `rows: 'tenant'`. */
  actions?: { [T in Resource]?: readonly string[] };
  /** Operator reads over the authenticated App host: `readiness`, `bundle` (the sanitized support bundle) and `workflows` (the durable workflows room: list, history, Cancel and Retry).
      In a suite's Console, for this App only: `workflows`, `jobs` (list and redrive), `deliveries` (event and webhook deliveries, list and redrive),
      `stores` (the store layouts' status) and `analytics` (events over time, funnels and breakdowns; read-only).
      With the platform realm, `support` reads the support sessions of the role's own realm: a tenant role its own
      tenant's, a platform role every tenant's (the one view naming the operator). A feature never grants it. */
  operations?: readonly ('readiness' | 'bundle' | 'workflows' | 'jobs' | 'deliveries' | 'stores' | 'analytics' | 'support')[];
  /** Column narrowing per resource, within the resource's own `fields`. Omit `read` to narrow only `write`. */
  fields?: { [T in Resource]?: AppRoleFieldAccess };
  /** The realm the role grants in: a tenant's (the default) or the platform realm's. Required on every role once `auth.tenancy.platform` is declared; a platform role edits only the platform's own writable resources, never the profile's New, and changes a tenant's rows only through its commands. */
  realm?: 'tenant' | 'platform';
  /** The identity provider's claims that give this role, re-read at every sign-in through an `oidc(...)` provider:
      `{ groups: ['8f2c…'] }`, `{ roles: ['Underwriter'] }`, `{ 'realm_access.roles': ['underwriter'] }`. Any listed
      value of any listed claim gives it; a sign-in whose claims give no role is refused. Not in a tenant App.
      `provider` names the one provider whose claims these are, `{ provider: oidc('workforce'), groups: ['admins'] }`:
      a sign-in through another never reads the rule. Without it any of the App's providers does, and `check` warns
      where the App has more than one. */
  claims?: AppRoleClaims;
  /** A role only a service principal holds (a jobs module's `principals`, an App API token), never a person:
      `{ integration: { service: true, read: true, commands: ['recordCreditResult'] } }`. A free-form page is offered
      to it only where the page names it; it is never `defaultRole` and has no `claims`. */
  service?: true;
}

/** A role's claims: each claim (a name, or a dotted path into one) with the values that give the role, and
    optionally the one named provider they are read from. `provider` is not a claim; any other key is. */
export type AppRoleClaims = {
  readonly provider?: `oidc:${string}` | `saml:${string}`;
  readonly [claim: string]: readonly string[] | `oidc:${string}` | `saml:${string}` | undefined;
};

/** Tenancy vocabulary under `auth.rows: 'tenant'`: what one tenant is called, the platform-owned profile resource with one row per tenant (whose record name the chooser and the bar call each tenant by), and the platform realm with its label. */
export interface AppTenancy<Resource extends string = string> {
  label?: string | AppMessageRef;
  profile?: Resource;
  platform?: {
    label: string | AppMessageRef;
    /** Who `me` is in the platform realm, as `auth.me` says it in a tenant's: the platform-owned resource its staff
        are rows of, and the column holding each one's account id, so a provider view can say `owner_id = me`. A
        tenant's member is never this row, and the platform's staff are never a tenant's person. */
    me?: { from: Resource; column: string };
  };
}

/** A way to sign in: email and password, GitHub, Google, an OpenID Connect provider (`oidc(...)`) or a SAML 2.0 one (`saml(...)`). */
export type AuthProvider = 'email' | 'github' | 'google' | `oidc:${string}` | `saml:${string}`;

/** Sign-in for this App, through Better Auth. Present, every request needs a session. */
export interface AppAuth<Resource extends string = string, Role extends string = string> {
  /** How people sign in. GitHub and Google read their credentials from the environment; `oidc('workforce')` is the
      identity provider the config file names "workforce", `saml('okta')` a SAML one; `oidc.tenants()` and
      `saml.tenants()` are each tenant's own, in a tenant App. */
  providers?: readonly AuthProvider[];
  /** invite (default): an admin creates accounts. open: anyone may sign up. `{ providers, domains }`: an account is
      made at its first sign-in through an identity provider, with a verified email in one of the domains. */
  signUp?: 'open' | 'invite' | { providers?: readonly AuthProvider[]; domains?: readonly string[] };
  /** Where accounts and sessions live: a SQLite file, or a postgres:// URL (name its password, or the whole URL, by a
      `${NAME}` reference; `migratePostgresAuthStore` from @mistriwork/mistri/maintenance makes its schema before the first start).
      Never a business database, which a tenant App refuses at startup. Default: a SQLite file in the config directory,
      named for the app. */
  store?: string;
  /** The role a new account gets. Default: user. */
  defaultRole?: string;
  /** Row scoping: every row (default), a server-defined row policy, or tenant enrollment. */
  rows?: 'all' | 'policy' | 'tenant';
  /** Grants within the resource ceilings. Omitted grants deny. Needs at least one declared resource. */
  roles?: Record<Role, AppRoleGrant<Resource, Role>>;
  /** What a signed-out visitor reads: each resource named (never `true`),
      read-only, optionally narrowed by `fields`. The rest of the App still
      needs a session. Needs `roles`, and `rows` 'all'. */
  public?: { read: readonly Resource[]; fields?: Partial<Record<Resource, { read: readonly string[] }>> };
  /** The human check every public door asks before it reads a submission — a public form's submit, a public page's
      command: the name of a verifier the commands module exports in `challenges` (`defineChallenges` from
      @mistriwork/mistri/commands; a provider such as Turnstile comes from its pack). A missing or refused token is a 403. */
  challenge?: string;
  tenancy?: AppTenancy<Resource>;
  /** Who `me` is as a row: the table people are rows of and its column holding their sign-in email, so a condition
      like `owner_id = me` compares a reference to that table with the signed-in person's row. Without it, `me` is the
      signed-in account's email and compares with text columns only. In a tenant App `column` holds the account's id,
      and `me` is the row of the tenant the request is in: one account is a row in each of its tenants, and a tenant
      with no row for them matches nothing. */
  me?: {
    from: Resource;
    column: string;
    /** Make each new account's row: the first time an account is signed in to the App (after sign-up, or a first
        sign-in through an identity provider) the server inserts a row with its email in `column` and, where `name`
        names a column, its name there. Never a second row: `column` must be unique, and an account whose row is
        there already is left as it is. Every other column the row needs must have a default. The insert is the
        server's own, as a stamp is: no role needs to write the table. Not in a tenant App yet. */
    create?: { name?: string };
  };
}

/* ---------- content: list views ---------- */

/** A checklist: a card of one text column, a boolean it toggles, and one line beneath. */
export interface AppChecklist<Column extends string = string> {
  kind: 'checklist';
  readonly [madeBy]: 'checklist';
  primary: Column;
  checked: Column;
  lines?: readonly [Column];
}

/* `OneHop` is a local column or a one-hop reference label path ("owner_id.name"): what the schema-typed layer
   narrows to the table's own columns and the columns its references land on. */
/** A keyboard-first selection queue; the resource's `bulk` actions apply to exactly the selected records. */
export interface AppQueueList<Column extends string = string, OneHop extends string = Column | `${Column}.${string}`> {
  kind: 'queue';
  readonly [madeBy]: 'queue';
  /** A local text column, a local reference (the card says the record it names), or a one-hop label path to a text
      column (`patient_id.name`). Absent, the card says its record's name (`recordLabel`). */
  primary?: OneHop;
  /** Up to two local columns or one-hop label paths; the second sits in the meta position. */
  lines?: readonly [OneHop] | readonly [OneHop, OneHop];
  /** Up to six captioned values under the title: local columns or one-hop reference label paths. */
  properties?: readonly OneHop[];
  /** An optional status cue, dressed by the column's display tones. A local column or one-hop reference label path. */
  badge?: OneHop;
  /** The row-opening call to action; omitted uses "Open". */
  openLabel?: string;
}

/** Lanes of cards by one local column; a card moves only through an update that sets exactly that column. A
    machine's column reads its lanes in the machine's order, and a card moves by the verb that leads there — a fixed
    verb, or a command verb with one destination, run as its button runs it for a reader granted it; while a card is
    dragged, a lane none of its verbs leads to is dimmed; another
    column's lanes are `lanes`, else its vocabulary or the values seen. Where the column references another table (a
    cycle), the lanes are its rows, led by one for none, and a card moves by an ordinary update of the reference. */
export interface AppBoardList<Column extends string = string, OneHop extends string = Column | `${Column}.${string}`> {
  kind: 'board';
  by: Column;
  /** One to eight exact lane values (a reference's keys), in order; omit to use the machine's states, the column's
      vocabulary, the referenced rows or the values seen. Refused over a machine's column, which orders its own. */
  lanes?: readonly string[];
  /** A numeric column holding each card's place in its lane. The lanes read in its order, empty places last; a
      reader who may edit it drags a card into place (in its lane or another), or presses Alt+↑/↓, or picks Move
      up, down, to top or to bottom. A move writes the one card's place, between its new neighbors. Absent keeps the
      list's own order. */
  order?: Column;
  /** A column whose values are rows across the lanes, one per value plus one for none, each folding. A card changes
      row by an ordinary update where the reader may edit the column; where not, it keeps its row and says why. */
  swimlanes?: Column;
  /** A lane's work-in-progress limit, by lane value: its head says "count / limit" and warns past it. Shown, never
      enforced. */
  limits?: Readonly<Record<string, number>>;
  /** The card's title: a text column, a reference, which says the record it names (`primary: 'sales_order_id'`
      titles a parcel `#1042 · Ana Ruiz`), or a one-hop label path (`primary: 'patient_id.name'`). A reference in
      `lines` or `footer` says its record's name too, never its key. Absent, the card says its record's name: the
      resource's `recordLabel` column. */
  primary?: OneHop;
  /** One line under the title: a column, or a rollup or computed column of the row — a problem's open tickets. */
  lines?: readonly [Column];
  /** A column whose value is the card's kind — design, research, ops: a chip over the title, in the color its
      display rule's `colors` gives the value (else one fixed by its text), and the card's stripe where the look draws
      one. */
  category?: Column;
  /** Up to four facts along the card's foot — a due date, a count of comments, the people on it — each a column,
      with an App icon before it where given: `footer: [{ column: 'due_on', icon: 'calendar' }, 'assignees']`. A
      person (an `avatar` or `avatars` column) stands at the right end. */
  footer?: readonly (Column | { column: Column; icon?: AppIcon })[];
  /** A numeric column summed in each lane's head beside its count: "Discovery · 3 · $92.8K". Absent, the first money
      column the card shows (a line, a fact) is summed; a card and a lane say money short ($240K), whole in the title. */
  sum?: Column;
  /** Lane values drawn folded until a reader opens one — a closed stage, won or lost: a narrow strip with its name,
      count and sum, opened by a click. The reader's choice is remembered in their browser, per board. */
  folded?: readonly string[];
}

/** A month of records by one date column, each on its day — or, with `end`, drawn across every day from `date`
    to `end`, continuing from one week's row to the next; a phone reads it as an agenda. */
export interface AppCalendarList<Column extends string = string, OneHop extends string = Column | `${Column}.${string}`> {
  kind: 'calendar';
  readonly [madeBy]: 'calendar';
  /** The date (or timestamp) column a record sits on, or starts on when it has an `end`. */
  date: Column;
  /** A date column holding the record's last day: a leave from its first day to its last, a pay period. A move
      shifts both. Absent, a record sits on one day. */
  end?: Column;
  /** A local text column or one-hop reference label path, like `employee_id.name`. Absent, the record's name. */
  primary?: OneHop;
  /** One local column or one-hop label path, said quietly under the primary. */
  lines?: readonly [OneHop];
  /** A status said as its tone — a dot and its word — from the column's display map. A local column or one-hop
      label path. */
  badge?: OneHop;
  /** Shaded spans behind the days — a change calendar's blackout windows — read from another resource through the
      reader's own grants: `backdrop: { from: 'blackout', start: 'starts_on', end: 'ends_on', labelColumn: 'name', tone: 'warn' }`,
      or up to four of them. A span is named where it starts and where it runs into a new week, and opens its record
      where its resource has a list the reader can open. A reader who cannot read the resource sees the month without
      it. */
  backdrop?: CalendarBackdrop | readonly CalendarBackdrop[];
}

/** One kind of shaded span on a calendar: another resource's rows, from one of its date columns to another. */
export interface CalendarBackdrop {
  /** The resource whose rows are the spans. */
  from: string;
  /** Its date (or timestamp) column where a span starts. */
  start: string;
  /** Its date (or timestamp) column holding a span's last day. */
  end: string;
  /** Its column whose value names a span. */
  labelColumn: string;
  /** The span's shade, in a display tone; absent, the quiet neutral. */
  tone?: 'good' | 'warn' | 'bad' | 'info' | 'neutral';
}

/** Records as the tree their parent column makes: each record with no parent a root, its children folded under it
    and opened a level at a time (the keyboard's tree pattern: arrows move and open, Enter opens the record).
    Read whole, up to 2,000 records. */
export interface AppTreeList<Column extends string = string, OneHop extends string = Column | `${Column}.${string}`> {
  kind: 'tree';
  readonly [madeBy]: 'tree';
  /** A local column that references this resource's own table: the record above, empty at a root. */
  parent: Column;
  /** A local text column or one-hop reference label path. */
  primary: OneHop;
  /** One local column or one-hop label path, said quietly beside the primary. */
  lines?: readonly [OneHop];
}

/** Records as bars along time from `start` to `end` — a project plan, a rota — in a row per value of `by` (or per
    record), with today ruled across and the weeks or months marked above; a record with no end is a mark on its
    start. A bar opens its record. Read whole, up to 500 records. @preview */
export interface AppGanttList<Column extends string = string, OneHop extends string = Column | `${Column}.${string}`> {
  kind: 'gantt';
  readonly [madeBy]: 'gantt';
  /** The date (or timestamp) column a bar starts on. */
  start: Column;
  /** The date column it ends on. */
  end: Column;
  /** A local text column or one-hop reference label path, said on the bar. */
  primary: OneHop;
  /** A local column or one-hop label path whose value names a bar's row, like `owner_id.name`; overlapping bars stack in it. */
  by?: OneHop;
  /** A numeric column, 0 to 100, drawn as the bar's filled share. */
  progress?: Column;
}

/** The view's own list — its `show`, `query`, tabs and filter bar — beside one selected record, headed by the
    resource's `noun`. Data only; the renderer supplies the panes. */
export interface AppSplitListDetail<Path extends string = AppShowEntry> {
  kind: 'split';
  /** The picked record's fields, in order: columns or label paths. Absent, its fields as the schema has them. */
  detail?: readonly Path[];
  /** The list's page size, 1 to 200. */
  limit?: number;
  /** How a row reads in the list beside the record, in the queue's vocabulary: a title, up to two lines, captioned
      `properties`, a status badge and an avatar. Absent, the list is the plain grid. */
  row?: { primary: Path; lines?: readonly [Path] | readonly [Path, Path]; properties?: readonly Path[]; badge?: Path; avatar?: Path };
}

/**
 * A responsive grid of cards: a picture, the title, one prominent figure, up
 * to four facts and a badge; the whole card opens its record. One to four
 * columns by the room's width.
 */
export interface AppCardsList<Column extends string = string, OneHop extends string = Column | `${string}.${string}`> {
  kind: 'cards';
  readonly [madeBy]: 'cards';
  /** The card's title: a text column, or one a reference names ("vehicle_id.title"). Omitted on a list view, the
      record's name: the resource's `recordLabel`, or the column the catalog names its records by. A related list's
      cards name theirs. */
  primary?: OneHop;
  /** A text column said under the title at the card's full width, without a caption, clamped to three lines — a
      summary that a captioned `properties` entry would wrap into a third of the card. */
  description?: Column;
  /** One prominent figure, dressed by the column's display rule — a price, a total — the row's own or one a
      reference names ("vehicle_id.price"), read through that table's grants. */
  value?: OneHop;
  /** A short word in the picture's corner, drawn when the row has one. */
  badge?: Column;
  /** A column whose display rule maps its values to icons (`display.<column>.icons`): the card wears its value's
      icon before the title — a ticket's channel, a part's kind — or, with `media: 'icon'`, as a tile leading the
      card. A value the rule leaves unmapped draws none. */
  icon?: Column;
  /** Up to four values under the title, each under its caption: a local column or a one-hop label path ("dealer_id.name"). */
  properties?: readonly OneHop[];
  /** Up to six values said in one line under the figure, a dot between — "2019 · 85,780 mi · Hybrid", a fields
      section's `facts` line on a card — local columns or one-hop label paths. A fact written
      `{ column: 'owners', after: 'owner' }` says its word after the value: "1 owner", "3 owners". */
  facts?: readonly (OneHop | AppCardFact<OneHop>)[];
  /** Up to four values along the card's foot under a hairline, written as `facts` are — a catalog item's price and
      how long it takes: `footer: ['price', { column: 'delivery_days', after: 'day' }]`. A word for one value, a free
      item's "No charge", is the column's display rule's (`values: { 0: 'No charge' }`). */
  footer?: readonly (OneHop | AppCardFact<OneHop>)[];
  /** A text column holding an `https://` or `/`-rooted image address — the row's own or one a reference names
      ("vehicle_id.photo_url") — or the first file of a related file resource: `{ from: 'vehicle_photo', whose:
      'vehicle_id', sort: 'position' }`. With `about`, a reference column of the row, the files are the record it names:
      a saved car drawn with its car's photo, `{ about: 'vehicle_id', from: 'vehicle_photo', whose: 'vehicle_id' }`
      A part read through a reference the reader may not read is left off the card. */
  image?: OneHop | { about?: Column; from: string; whose: string; sort?: string };
  /** How the image is framed. Omit or use "cover" for the current picture; "avatar" makes it a circular portrait and falls back to initials from primary;
      "icon" leads the card with its `icon` column's mark as a tile, in place of a picture (a catalog's laptop, its headset). */
  media?: 'cover' | 'avatar' | 'icon';
}

/** A fact with a word beside its value: `{ column: 'beds', after: 'bed' }` reads "3 beds", `{ column: 'born_on', before:
    'Born' }` reads "Born Apr 24, 2017", as a date, a due day or an end wants its word first. An `after` word takes
    the plural by rule for a figure other than 1, or is a `msg()` with an ICU plural, or `{ one, many }` where no rule
    makes it ("1 person", "2 people"). One shape wherever a facts line is written: cards, the record's `header()`. */
export type AppCardFact<OneHop extends string = string> =
  | { column: OneHop; before: string | AppMessageRef; after?: never }
  | { column: OneHop; after: string | AppMessageRef | { one: string; many: string }; before?: never };

export type AppListPresentation<Column extends string = string, OneHop extends string = Column | `${Column}.${string}`, Path extends string = AppShowEntry> =
  | AppChecklist<Column>
  | AppQueueList<Column, OneHop>
  | AppCalendarList<Column, OneHop>
  | AppTreeList<Column, OneHop>
  | AppGanttList<Column, OneHop>
  | AppCardsList<Column, OneHop>
  | AppCustomList<Path>;

/**
 * A list view's rows drawn by the App's own component: `customList(postStream, { show: ['body', 'author_id.display_name'] })`.
 * The platform keeps the query, the tabs, the filters, the sort, the paging and the bulk actions; `show` is what each row
 * carries beside its keys. The component receives `ListProps` (@mistriwork/mistri/ui).
 */
export interface AppCustomList<Path extends string = string> {
  kind: 'custom';
  readonly [madeBy]: 'customList';
  component: ComponentDecl<string, 'list'>;
  /** The columns the component reads, label paths welcome: at most 32. */
  show: readonly Path[];
  props?: Readonly<Record<string, unknown>>;
}

/** Copy for a list whose standing query has no rows. The optional action opens another App list or dashboard, or a signed-in form: "No canned responses: write one". */
export interface AppListEmpty {
  title: string | AppMessageRef;
  /** A sentence under the title. */
  description?: string | AppMessageRef;
  action?: { label: string | AppMessageRef; to: string };
}

/** The rows of one resource: how they read, draw and open. Its key in `views` is its address. */
/** Any string, as a union of string mappings, so an id written under `satisfies App` stays a literal the reference layer can check. */
export type AnyWord = Capitalize<string> | Uncapitalize<string>;

/**
 * A list's filter: a column, a path up a reference (`'account_id.industry_id'`), or the rows that point at the record.
 */
export type AppListFilter<Column extends string = string> = Column | `${Column}.${string}` | AppHasFilter;

/**
 * The rows that point at a list's record, as a filter: `{ has: 'opportunity', filter: 'stage' }` lists accounts with
 * an opportunity at the stages picked, counted as accounts. `filter` is a column of those rows or a path up from them
 * (`'tag_id'` on a link table lists the tags); `segment` one of their segments, a yes-or-no ("Has open
 * opportunities"). `whose` names the reference where the rows have more than one to this record. Two of them are each
 * satisfied by any row; one row that answers both is a segment.
 */
export type AppHasFilter =
  | { has: string; filter: string; segment?: never; whose?: string }
  | { has: string; segment: string; filter?: never; whose?: string };

export interface AppListView<Table extends string = string, Column extends string = string, ActionId extends string = AnyWord> {
  kind: 'list';
  readonly [madeBy]: 'listView';
  /** The resource whose rows it lists: a logical resource name. */
  from: Table;
  /** Heading, breadcrumb and default menu word; absent = the humanized table name. */
  label?: string | AppMessageRef;
  /** Its address after the App's (`/{app}/{path}`), when not its key: lowercase letters, digits and hyphens. */
  path?: string;
  /** The menu's mark for this view: in the side and top menus, and alone in the icon rail. */
  icon?: AppIcon;
  /** Standing conditions (a "module"): tabs refine on top of it. Conditions only: the order is `sort`, the
      columns `show`, the page size is the platform's. */
  query?: string;
  /** One of the table's segments (`resources.<table>.segments`), its conditions ANDed with `query`. */
  segment?: string;
  show?: readonly AppShowEntry[];
  /** How the rows draw; absent = a grid. A board or a split is the `board` or `split` key instead. */
  presentation?: AppListPresentation<Column>;
  /** The rows as lanes of cards: `board: { by: 'stage', primary: 'name' }`. Not with `presentation` or `split`. */
  board?: Omit<AppBoardList<Column>, 'kind'>;
  /** The list beside the picked record: `split: { detail: ['name', 'status'] }`. Not with `presentation` or `board`. */
  split?: Omit<AppSplitListDetail, 'kind'>;
  /** A split's single keys: a key (one lowercase letter or digit; J and K are the walk's) to the id of an action of the
      picked record — an update action or the action that runs a command. Each shows beside its verb in the record's
      header and works only while focus is not in an input. */
  shortcuts?: Readonly<Record<string, string>>;
  /** With `ui.shell.counts`: true counts this list in the menu, false never does. Absent, the list is counted where
      its condition is work: its machine's unfinished states, a date at or before today, or the reader (`me`). */
  count?: boolean;
  /** false draws the list without its title (it stays for a screen reader), where the room above already says where the reader is. */
  heading?: false;
  /** Shown only when this list's base query has no rows; tabs and filters retain their ordinary no-matches message. */
  empty?: AppListEmpty;
  tabs?: readonly AppTab[];
  /** Columns offered as quick filter boxes — a rollup or computed column too, a number's Min and Max (`'spent'`).
      A path up a reference filters by the record it names (`'account_id.industry_id'`); `{ has: 'opportunity',
      filter: 'stage' }` by the rows that point at this one (AppHasFilter). Empty means none, on purpose. */
  filters?: readonly AppListFilter<Column>[];
  /** The list's order, written like the query bar: `sort: 'created_on desc'` is how it reads when nothing else says
      one. Two to eight named orders — `[{ label: 'Newest', sort: 'listed_on desc' }, { label: 'Lowest price', sort:
      'price' }]` — are a Sort menu beside the filters, the first of them the order the list opens in; a chosen one is
      the query's own sort clause, so the address keeps it. The opening order is kept out of the bar and the address,
      as `order` is. A tab's sort clause wins over it, and the menu over both. Not beside `order` or a sort in
      `query`, and not on a board or a calendar. */
  sort?: string | readonly { label: string | AppMessageRef; sort: string }[];
  /** A numeric column holding each row's place. The list reads in its order wherever nothing else sorts it — a
      tab's own sort, a header or the Sort menu reads the rows another way, and hides the grips meanwhile — and a
      reader who may edit it drags a row into place (a finger holds it first), presses Alt+↑/↓, or picks Move up,
      down, to top or to bottom from the row's grip. A move writes the one row's place, between its new neighbors.
      A grid, a checklist, a queue or cards (a board's is its presentation's `order`); not with a sort in `query`. */
  order?: Column;
  /** Where the list's filters sit. 'bar' (the default): a bar above the rows. 'rail': a rail of facets beside the rows —
      checklists with counts, toggles, date presets — and a Filters sheet on a phone; not beside a split. 'none': no
      filter bar; tabs remain visible. */
  filterBar?: 'bar' | 'rail' | 'none';
  /** A text filter that suggests as the reader types: one of `filters` to the text columns of this resource
      whose values it offers — `suggest: { title: ['make', 'model'] }` offers "Toyota" for "toy". Up to eight, most
      common first, under the list's `query` and the reader's grants; a pick searches for it. A landing's search over
      this list suggests alike. */
  suggest?: Partial<Record<Column, readonly Column[]>>;
  /** Opt in to the raw query editor and Advanced filter action. Hidden by default. */
  advancedFilters?: boolean;
  /** Inline the resource's New form above the rows. */
  quickAdd?: boolean;
  /** This list's own CSV import, or `false` for none where its resource offers one. A command import finds each row's
      record among the rows this list's `query` stands on. */
  import?: boolean | AppImport<Column>;
  /** true puts a star on the view, so a reader can keep it in Favorites. */
  favorite?: boolean;
  /** Numeric columns, rollups or computed numbers summed in a footer row, over everything the list's conditions match,
      not just the page. A grid only. */
  totals?: readonly Column[];
  /** Row height: 'comfortable' (default) or 'compact', for a list read as a ledger. A reader's zoom still applies. A grid only
      (a split's list is one). */
  density?: 'comfortable' | 'compact';
  /** true puts a ⋯ menu at the end of each row with the record's own actions, as its page offers them. A grid only. */
  rowActions?: boolean;
  /** Cells edited in place, where the connection is writable and the reader may write the column: Enter or F2 opens a
      cell, Enter saves, Esc cancels, Tab saves and moves on. A selection gains "Set field…", one value written to every
      selected record. `true` offers every shown column the reader may write; a list, only those — shown local columns (a
      reference shown by its record's name, `owner_id.name`, is edited as `owner_id`, with a picker), never the key, a
      document, a file's columns or a machine's column, which its verbs move. Every cell is
      the record form's update, checked the same way on the server. A grid only, on a resource with access 'write'. */
  editable?: true | readonly Column[];
  /** How rows open: the full page (default), a drawer over the list, or a modal. Not beside a split, which opens its own rows. */
  open?: 'page' | 'drawer' | 'modal';
  /** A reference column whose record a row opens, in place of the row itself: a list of a join table such as
      `ticket_watcher` opens the ticket each row is about (`opens: 'ticket_id'`). A grid only. */
  opens?: Column;
  /** 'fit' (default) shares the width; 'scroll' keeps content widths. A grid only (a split's list is one). */
  sizing?: TableSizing;
  /** Queue and board only: narrows the resource's actions by id, in this order (`actions: ['approve', 'reject']`). Never defines one. */
  actions?: readonly ActionId[];
  /** The realm it belongs to: a tenant's (the default) or the platform realm's, which needs `auth.tenancy.platform`. */
  realm?: 'tenant' | 'platform';
  /** The roles that may open it: `roles: ['agent']`. A signed-in reader holding none of them is not served it — not in
      the menu, ⌘K or search, and its address answers as one that does not exist. Table grants still apply; this only
      narrows. Each must be a role `auth.roles` declares. */
  roles?: readonly string[];
}

/* ---------- content: dashboards ---------- */

interface DashSectionCommon {
  title?: string | AppMessageRef;
  width?: SectionWidth;
  /** The area of the dashboard's `areas` this section stands in; with `areas` every section names one (a first run
      leads the dashboard outside the grid and takes none). Sections in one area stack in source order. The area sets
      the width, so `width` is refused beside it. */
  area?: string;
}

/** A section about a table may carry a mark beside its title: one of the curated App icons. */
interface DashSectionMark {
  /** A curated mark in the section's heading row (a metric's label, a chart's title). */
  icon?: AppIcon;
}

/** Every kind but a note is about a table, narrowed by a query. */
interface DashTableSection extends DashSectionCommon, DashSectionMark {
  /** The table the section reads. Absent means the dashboard-level `from`. */
  from?: string;
  /** The query language, without the leading table name. */
  query?: string;
  /** One of the table's segments (`resources.<table>.segments`), its conditions ANDed with `query`. */
  segment?: string;
  /** The date column the dashboard's time window narrows this section by: a computed date of the table too
      (`renews_on: computed.date('due_on + term months')`), compiled inline. */
  over?: string;
  /** The section's own windows, in the query grammar's words: `['last 7 days', 'last 30 days', 'last 12 months']`.
      The reader picks this section's period in its heading, apart from the dashboard's window, and the first is
      where it starts. Needs `over`. The address names the section by its title:
      `/depot/operations?period.lines-moved-by-day=last-30-days`. */
  windows?: readonly string[];
}

/** How a measured section says its figures: a metric's number, a breakdown's bars, a chart's points, a matrix's cells. */
interface DashFigureWords {
  /** How a figure is said where its measure is not one column's (an average, a computed measure): `'percent'` —
      the figure is 0–100, said with % (`measure: 'avg resolution_met * 100'` reads "78.3%") — `'number'`, `'money'`
      in the App's currency, or `'duration'` — the figure is seconds, said as its two largest units
      (`measure: 'avg first_response_seconds'` reads "10h 2m"). Absent, a measure of one column takes that column's
      display rule. */
  format?: 'percent' | 'number' | 'money' | 'duration';
  /** A word said after each figure: `'days'`, `'/mo'`. */
  unit?: string | AppMessageRef;
}

/** A metric's goal read from data: a measure over a table and a query, the metric's own three words. */
export interface MetricTarget {
  from?: string;
  query?: string;
  measure?: string;
}

export interface MetricDashSection extends DashTableSection, DashFigureWords {
  kind: 'metric';
  readonly [madeBy]: 'metric';
  /** "count" (default), "sum amount as pipeline", "median amount" (PostgreSQL only: SQLite has no median),
      or a computed measure — aggregates and numbers joined by `+ - * /`: "sum won / sum amount as win_rate". */
  measure?: string;
  /** A second query for the same measure; the card shows the delta. The
      phrase "previous period" derives it from `query`'s one "last N
      days/weeks/months/years" window, shifted back one length; with no
      window in `query` and an `over`, it is the period before the window
      the reader picks. Unsaid on a metric with an `over`, it is "previous
      period": a windowed metric shows its change unasked. With neither an
      `over` nor a window in `query`, "previous period" is refused. */
  compare?: string;
  /** Which way is good news; the delta wears good/bad. Absent means neutral. Without
      `compare` or `over` there is no delta, and the check warns that it colors nothing. */
  better?: 'up' | 'down';
  /** Draw the measure's last twelve months inside the card while no window stands. Needs `over`. A windowed metric
      draws its trend across the window unless this is false. */
  spark?: boolean;
  /** A goal for the measure: a meter under the number, and the share reached said beside it. A number, or a goal
      read from data in the metric's own words — `{ from: 'quota', query: 'period = this quarter', measure: 'sum amount' }`;
      an unwritten `from` or `measure` is the metric's. Where the goal counts the same measure over the same table with
      no condition the metric does not also hold (`{ measure: 'count' }` beside `query: 'status = approved'`), it is
      the whole the figure is a share of: said "118 of 159 (74%)", and following the metric's window and picks. */
  target?: number | MetricTarget;
  /** A list view over the same table that the card opens on exactly the rows it counted: the whole card is the
      link, marked with an arrow. The figure is the metric's `query` within the list's own standing `query` (the
      rows that list can show); a tab is never counted, so a metric with no `query` counts every row the list
      shows. Absent, the card opens the table's rows; `false`, the card is a figure read where it stands and opens
      nothing, as a breakdown's `to: false` makes its groups text. */
  to?: string | false;
}

/** A breakdown's goal per group (G76): another table's measure by its own column, matched on each group's key. */
export interface BreakdownTarget extends MetricTarget {
  /** The goal table's column whose value is a group's key: a quota's `owner_id` for deals by `owner_id`. */
  by: string;
  /** The goal table's date column the reader's window narrows, as the section's `over` does its own. */
  over?: string;
}

export interface BreakdownDashSection extends DashTableSection, DashFigureWords {
  kind: 'breakdown';
  readonly [madeBy]: 'breakdown';
  measure?: string;
  /** What to group by — "status", or "month opened_on". */
  by: string;
  limit?: number;
  /** Each group measured against its goal: `{ from: 'sales_quota', by: 'owner_id', measure: 'sum amount', over:
      'starts_on' }`. The bar is the share reached, full at the goal; a group with a goal and nothing measured is at 0%. */
  target?: BreakdownTarget;
  /** "bars" (default): a row per group with its bar. "steps": a card per value of one column, in the column's order
      (its vocabulary's), joined by arrows — orders received, picked, packed, shipped. A step's mark is the value's icon
      from the column's display rule, in its tone; the look dresses the cards (its `steps` recipe). */
  shape?: 'bars' | 'steps';
  /** Steps: a line under a step, by the value it counts — `{ received: 'Waiting to be picked' }`. At most 12, each
      at most 80 characters. */
  notes?: Readonly<Record<string, string>>;
  /** The list view each group opens: a group is a link to that list narrowed to the group, the section's `query` kept.
      Absent, it is the one list view over the table that the reader is served; with none, or several, the groups are
      text (check says which). `false` keeps them text. An App never opens the database browser from a dashboard. */
  to?: string | false;
  /** `'hide'` leaves the section out of the dashboard while it has nothing to draw. */
  empty?: 'hide';
}

export interface ChartDashSection extends DashTableSection, DashFigureWords {
  kind: 'chart';
  readonly [madeBy]: 'chart';
  measure?: string;
  /** What to group by — a bucketed by ("month opened_on") for a line, categories for a donut. "auto created_at" lets the
      chart pick the unit (day, week, month or quarter) from the window the reader has picked and how the data falls, and
      say it under the title; give the section an `over` so the window follows. A line over two
      keys ("month created_at, channel") draws a line per value of the second, with a legend that shows one alone and
      a hover card naming every line at the point. */
  by: string;
  /** "line" (default); "bar", one series of bars — a bucketed `by` or categories — the current (last) bar
      marked until another is pointed at, its value said beside it on a guide line; "donut"; or "stacked": a
      two-key `by` ("region, stage"), a bar for each group of the first key divided by the second.
      Further shapes: "scatter", a dot per group of one key placed by `x` across and `measure` up; "heatmap", a
      two-key `by` ("weekday created_at, hour created_at") as shaded cells; "waterfall", how each group's rise or fall
      makes the total; "treemap", the whole divided into tiles by size, eight at most. */
  shape?: 'line' | 'bar' | 'donut' | 'stacked' | 'scatter' | 'heatmap' | 'waterfall' | 'treemap';
  /** A scatter's across measure ("sum amount"); `measure` is its up one. Only on a scatter, which needs it. */
  x?: string;
  /** A line's curve: "smooth" draws a monotone curve through the points, which never overshoots one. */
  curve?: 'smooth' | 'straight';
  /** A donut's words for the figure in its middle — "Total visitors" — said under it. At most 40 characters. */
  total?: string | AppMessageRef;
  /** A goal drawn as a rule in the ink on a line, bar, stacked or waterfall chart, and said beside it; not on a
      donut, scatter, heat map or treemap. */
  target?: number;
  limit?: number;
  /** The drawing's height in CSS pixels (120 or more). */
  height?: number;
  /** The list view each group opens: a group is a link to that list narrowed to the group, the section's `query` kept.
      Absent, it is the one list view over the table that the reader is served; with none, or several, the groups are
      text (check says which). `false` keeps them text. An App never opens the database browser from a dashboard. */
  to?: string | false;
  /** `'hide'` leaves the section out of the dashboard while it has nothing to draw. */
  empty?: 'hide';
}

/** One stage of a funnel: a label and the conditions a row holds to be at it. */
export interface FunnelStage {
  /** The stage as a reader says it: "Submitted", or `msg('funnel.submitted')`. Each stage's label is its own. */
  label: string | AppMessageRef;
  /** Conditions only, in the query grammar (a segment is a word in it): `'submitted_at is not empty'`. Absent, every
      row the funnel holds. A row reaches a stage when it holds the section's `query`, every required stage before it
      and this stage's own conditions. */
  query?: string;
  /** A side road: counted against the stage before it, and not required by the stages after it. Every stage after
      the first may be optional, for an any-order checklist; the first never is. */
  optional?: true;
}

export interface FunnelDashSection extends DashTableSection {
  kind: 'funnel';
  readonly [madeBy]: 'funnel';
  /** 2 to 8 stages, in order. Each is counted in the one statement, so a later stage is never longer than the one
      before it. A stage is drawn as a share of the last required stage before it, with the rows it lost beside it. */
  stages: readonly FunnelStage[];
  /** The list view each stage opens: a stage is a link to that list narrowed to the rows that reached it, and its
      lost figure to the rows that stopped there (where the conditions can be turned over exactly), the section's
      `query` kept. Absent, it is the one list view over the table that the reader is served; with none, or several,
      they are text (check says which). `false` keeps them text. */
  to?: string | false;
  /** `'hide'` leaves the section out of the dashboard while it has nothing to draw. */
  empty?: 'hide';
}

export interface MatrixDashSection extends DashTableSection, DashFigureWords {
  kind: 'matrix';
  readonly [madeBy]: 'matrix';
  measure?: string;
  /** Two keys — "stage, month close_date": rows by the first, columns by the second. */
  by: string;
  /** The list view each group opens: a group is a link to that list narrowed to the group, the section's `query` kept.
      Absent, it is the one list view over the table that the reader is served; with none, or several, the groups are
      text (check says which). `false` keeps them text. An App never opens the database browser from a dashboard. */
  to?: string | false;
  /** `'hide'` leaves the section out of the dashboard while it has nothing to draw. */
  empty?: 'hide';
}

export interface RowsDashSection extends DashTableSection {
  kind: 'rows';
  readonly [madeBy]: 'rows';
  /** Columns, label paths welcome. In the dashboard's `aside` the rows draw as a list, not a table: the first
      column names each row, the second is a quiet line under it and the third a value at its end — at most three. */
  show?: readonly AppShowEntry[];
  /** Written like the query bar. */
  sort?: string;
  limit?: number;
  /** Fit available width (default), or scroll at content widths. */
  sizing?: TableSizing;
  /** What the section says while it has no row: what belongs here, and where to start; or `'hide'`, which leaves it
      out of the dashboard while it has none. */
  empty?: AppListEmpty | 'hide';
}

/** A board has the dashboard's whole width, so it takes no `width`. */
export interface BoardDashSection extends Omit<DashTableSection, 'width'> {
  kind: 'board';
  readonly [madeBy]: 'board';
  /** The bare column of the table whose values are its lanes: the machine's states, its vocabulary, or the values seen. */
  by: string;
  /** Ordered subset of 1..8 unique, nonblank exact values. Omit to discover lanes. */
  lanes?: readonly string[];
  /** The card's first line, a column or label path; absent = the table's label column, alone. */
  primary?: string;
  /** Lines beneath the primary, label paths welcome. Needs `primary`. */
  lines?: readonly string[];
  sort?: string;
  limit?: number;
  /** `'hide'` leaves the board out of the dashboard while it has nothing to draw. */
  empty?: 'hide';
}

export interface NoteDashSection extends DashSectionCommon {
  kind: 'note';
  readonly [madeBy]: 'note';
  /** The words. Plain text; blank lines separate paragraphs. */
  text: string | AppMessageRef;
  /** A curated mark above the guidance. */
  icon?: AppIcon;
  /** One already-reachable list or dashboard to open. */
  action?: AppLinkAction;
  /** 'banner': the dashboard's introduction — a ground of its own across the width, the title larger, the action a
      button, and room for a picture on the right. The look dresses it (its `banner` recipe). Needs a `title`. */
  variant?: 'banner';
  /** A banner's short tag over its title ("New", "Growth"), at most 40 characters. */
  eyebrow?: string | AppMessageRef;
  /** A banner's picture: one row of a file resource, by its record key, with alt text of at most 200 characters.
      A reader whose role cannot read that resource sees the banner without it. */
  image?: { from: string; key: string | number; alt: string | AppMessageRef };
}

/** The keys only a dashboard's banner note takes. */
type BannerOnly = 'variant' | 'eyebrow' | 'image';

/** One step of a first run: the next action, and the list view whose New form it opens. */
export interface FirstRunStep<View extends string = string> {
  /** The next action, said to the reader: "Add your first customer". */
  label: string | AppMessageRef;
  /** A list view's key. The step is done once its table has a row. */
  to: View;
  /** A line under the label: what the records are for. */
  description?: string | AppMessageRef;
}

/** A new App's first steps, at the top of its home. While none is done — every step's table empty — it stands
    alone, a welcome with next actions instead of charts of nothing; once one is, the dashboard draws beneath
    it; once all are, it is gone. At most one per dashboard, never in the aside. */
export interface FirstRunDashSection<View extends string = string> {
  kind: 'firstRun';
  readonly [madeBy]: 'firstRun';
  title?: string | AppMessageRef;
  /** A sentence under the title. */
  description?: string | AppMessageRef;
  /** One to six steps, each a different list view. */
  steps: readonly FirstRunStep<View>[];
}

/** One read of rows a dashboard's custom section declares: a rows section's words, the window's `over` included. */
export interface CustomDashRead {
  from: string;
  query?: string;
  /** The columns the component reads, label paths welcome; each row carries exactly these. */
  show: readonly string[];
  sort?: string;
  /** 1 to 500. */
  limit?: number;
  /** The date column the dashboard's time window narrows this read by. */
  over?: string;
}


/** One aggregate read a dashboard's custom section declares: a figure the server counted, summed or averaged under the
    reader's grants and row policy, exact over every row (not the rows a `rows` read loaded, which stop at 500). The
    dashboard's window and picks narrow it as they narrow a metric. The component receives it as `figures.<name>`: a
    number with no `by`, a group for each value (`{ key, value, label? }`) with one. */
export interface CustomDashFigure {
  from: string;
  /** "count", "sum amount", "avg amount", "min due_on" or "max due_on". */
  measure: CustomMeasure;
  /** Group the figure: a column, a path or a period and a date column ("status", "month opened_on"). */
  by?: string;
  query?: string;
  /** The date column the dashboard's time window narrows this figure by. */
  over?: string;
  /** With a `by`, the most groups returned: 1 to 500. Default 100. */
  limit?: number;
}

/** An author's component on a dashboard: `custom('Payroll cadence', payrollTimeline, { rows: { runs: { from, show, over } } })`. */
export interface CustomDashSection extends DashSectionCommon {
  kind: 'custom';
  readonly [madeBy]: 'custom';
  component: ComponentDecl<string, 'section'>;
  /** Named reads, at most eight; the component receives each as `rows.<name>`. */
  rows?: Readonly<Record<string, CustomDashRead>>;
  /** Named aggregate reads, at most eight; the component receives each as `figures.<name>`, exact past the rows' 500. */
  figures?: Readonly<Record<string, CustomDashFigure>>;
  props?: Readonly<Record<string, string | number | boolean>>;
}

/** One resource an activity section reads: the mark each of its changes wears, and its word in the feed. */
export interface ActivityResource {
  icon?: AppIcon;
  /** Its word in the feed, when not the resource's noun. */
  label?: string | AppMessageRef;
}

/** Recent changes across resources, read from their record history: each change's record by its name, what the
    write did (its action or command, else added or changed, and the first fields from what to what), who made it and
    when, under a segmented Today / Yesterday / This week and a search. Read as the reader reads: a record they cannot
    read is not in their feed, and a field they may not read, or one `audit.redact` names, says that it changed and
    nothing else. Each resource named keeps a history from then on, as a page's `history()` makes its resource keep
    one, in the store provisioned once (`provisionStores` with `only: ['record-history']`). Not under
    `auth.rows: 'tenant'`. */
export interface ActivityDashSection extends DashSectionCommon, DashSectionMark {
  kind: 'activity';
  readonly [madeBy]: 'activity';
  /** The resources whose changes it lists, each with its mark: `{ pick_list: { icon: 'truck' } }`. One to twelve. */
  resources: Readonly<Record<string, ActivityResource>>;
  /** Changes drawn before "Show more", 1 to 50. Default 8. */
  limit?: number;
}

/** One box that searches several resources' records by their names, as the reader reads them: the hits grouped by
    resource, each its record's name and one line of its list, opening the record. A resource is searched when the
    reader is served a list of it; its text filter is the one its list's search asks, through `search` where the
    resource declares an engine. */
export interface FindDashSection<Resource extends string = string> extends DashSectionCommon {
  kind: 'find';
  readonly [madeBy]: 'find';
  /** The resources whose records it finds, one to six: `['article', 'catalog_item']`. */
  resources: readonly Resource[];
  /** The box's words before anything is typed. */
  placeholder?: string | AppMessageRef;
  /** A curated mark in the section's heading row. */
  icon?: AppIcon;
}

/** What a tenant may change: never the grounds, the ink or the recipes, which stay the App's. */
export type BrandingKey = 'logo' | 'name' | 'accent' | 'palette' | 'radius' | 'density' | 'preset' | 'locale';
export interface AppBranding {
  /** What each tenant may set. `preset` (which of `themes` it starts from) needs more than one of `themes` to pick from; `palette`, a theme with palettes. */
  allow: readonly BrandingKey[];
  /** The tenant roles (auth.roles with `realm: 'tenant'`) whose members may save it: a tenant's admins. */
  editors: readonly string[];
  /** The themes a tenant starts from, `defineTheme(...)` results or built-in names; the first is the default.
      Absent: the App's own look. */
  themes?: readonly (import('@mistriwork/engine/schema/theme.js').Theme | import('@mistriwork/engine/schema/theme.js').ThemeBase)[];
}

/** A tenant's own Branding form, for its admins: the name, logo, accent and the rest the App's `branding.allow` lets
    them change, beside a live preview of the shell, a record, a stat and an email. A save is checked as a theme is
    (contrast in light and dark, the chart's color-blind separation) and refused with the reason. Members who are not
    among `branding.editors` see it read-only. Needs the App's `branding`. */
export interface BrandingDashSection extends DashSectionCommon {
  kind: 'branding';
  readonly [madeBy]: 'brandingForm';
  /** A curated mark in the section's heading row. */
  icon?: AppIcon;
}

/** The integrations' settings form: each integration the jobs module lists, its secrets set or not (never a
    value), the webhook address its provider sends to and the channel it sends on. The roles in the jobs module's
    `integrations.editors` enter and remove secrets; everyone else reads it. On a tenant App, each tenant's own. */
export interface IntegrationsDashSection extends DashSectionCommon {
  kind: 'integrations';
  readonly [madeBy]: 'integrationsForm';
  /** A curated mark in the section's heading row. */
  icon?: AppIcon;
}

/** One section of a dashboard, by kind. */
export type AppDashSection =
  | MetricDashSection | BreakdownDashSection | RowsDashSection | ChartDashSection
  | NoteDashSection | MatrixDashSection | FunnelDashSection | BoardDashSection | FirstRunDashSection | CustomDashSection | ActivityDashSection
  | FindDashSection | BrandingDashSection | IntegrationsDashSection;

/** A list view drawn read-only inside a dashboard: the rows its room opens on, drawn as it draws them.
    Its "open →" opens that view's room, which it has even when nav does not list it. */
export interface AppViewDashSection<View extends string = Lowercase<string>> {
  kind: 'view';
  readonly [madeBy]: 'embed';
  /** A list view's key. */
  view: View;
  /** Default: the view's label. */
  title?: string | AppMessageRef;
  /** A curated mark in the section's heading row. */
  icon?: AppIcon;
  /** Not beside a board, which a dashboard draws full width. */
  width?: SectionWidth;
  /** The area of the dashboard's `areas` this embed stands in. */
  area?: string;
  /** One of the view's tabs by its address word (`'all'`, the segment's name), as its URL carries it; a label is
      refused, since it is said in the reader's language. Default: its first tab. */
  tab?: string;
  /** Rows; per lane for a board. */
  limit?: number;
  /** The date column the dashboard's window narrows it by. */
  over?: string;
  /** The section's own windows, as a table section's (`DashTableSection.windows`). Needs `over`. */
  windows?: readonly string[];
  /** The list works as its room does: its search, its filters and, for a reader offered one, its selection and
      bulk actions, authorized as the room is. Default false — a dashboard's list is a glance. Not in the aside, and
      not a board or a calendar. */
  interactive?: boolean;
}

/** A screen of sections about whole tables. Its key in `views` is its address (`/{app}/{key}?period=last-30-days`). */
export interface AppDashboardView<Table extends string = string, View extends string = string> {
  kind: 'dashboard';
  readonly [madeBy]: 'dashboard';
  label: string | AppMessageRef;
  /** Its address after the App's, when not its key. */
  path?: string;
  /** The words drawn over the sections when they are not its label, which the menu and the browser tab keep:
      "Hello, {me.name}". `{me.name}` is the signed-in reader's name, filled in by the server from the verified
      session; where there is none (a public reader, an account with no name) the label is drawn instead. Needs `auth`.
      false draws the dashboard without its title (it stays for a screen reader). */
  heading?: string | AppMessageRef | false;
  /** Short plain text shown under the dashboard heading. It may greet `{me.name}` too; with no name it is left out. */
  description?: string | AppMessageRef;
  /** The menu's mark for this dashboard. */
  icon?: AppIcon;
  /** The resource every section that names none reads. A section's own `from` still wins; a dashboard-level `from` no section inherits is refused. */
  from?: Table;
  sections: readonly (AppDashSection | AppViewDashSection<View>)[];
  /** Sections in an independent context column beside the dashboard's main flow: a record page's aside, its own
      `aside` landmark for a screen reader, with the narrow column's presentation (a list draws as names with a line
      and a value, an embed is a glance). The main flow keeps its rows by `width` beside it, and neither column's height
      waits on the other's. For a section whose height lines up with the ones beside it, place it with `areas`
      instead; a dashboard says one or the other. */
  aside?: readonly (AppDashSection | AppViewDashSection<View>)[];
  /** Sections placed on a grid of equal columns: one string per row (1 to 8), each the same count of 1 to 4 space-separated
      cells, a cell an area's name (lowercase, up to 24 characters) or `.` for none:
      `['kpis kpis kpis', 'trend trend side', 'mix work side']`. A section names its `area`; an area covering cells in two
      rows spans them, and a narrow screen stacks the areas in the order the template reads. Every area has a section, and
      `areas` is not written with an `aside`. */
  areas?: readonly string[];
  /** Time windows offered when any section declares `over`, in the query
      grammar's words. Default: last 30 days / last 90 days / last 12 months. */
  windows?: readonly string[];
  /** The window the dashboard opens on, one of `windows` ('last 30 days'); unsaid, it opens on all time. An address's
      `?period=` still wins, and a reader's All time is said `?period=all-time`. */
  window?: string;
  /** How the windows are offered: 'segmented' (default), a button for each; 'button', one button saying the dates
      the window covers, with a calendar mark, that opens a menu of the windows. */
  windowControl?: 'segmented' | 'button';
  /** Pick-filters: columns offered as selectors, narrowing every section whose table has the column. */
  filters?: readonly string[];
  /** true puts a star on the view, so a reader can keep it in Favorites. */
  favorite?: boolean;
  /** The realm it belongs to: a tenant's (the default) or the platform realm's, which needs `auth.tenancy.platform`. */
  realm?: 'tenant' | 'platform';
  /** The roles that may open it: `roles: ['agent']`. A signed-in reader holding none of them is not served it — not in
      the menu, ⌘K or search, and its address answers as one that does not exist. Table grants still apply; this only
      narrows. Each must be a role `auth.roles` declares. */
  roles?: readonly string[];
}

/* ---------- content: the landing ---------- */

/**
 * The landing view: the App's signed-out front page, public by kind. Plain
 * text only — markup is shown, never run — and every link is https://,
 * mailto: or tel:. At most one; a `{ view, signedOut: true }` home rule
 * makes it the signed-out home, and it is also served at `/{app}/welcome`.
 */
export interface AppLandingView<Form extends string = string> {
  kind: 'landing';
  readonly [madeBy]: 'landing';
  /** The browser title; the App's name when absent. At most 120 characters. */
  label?: string | AppMessageRef;
  hero: LandingHero<Form>;
  /** At most 12, drawn in order under the hero. */
  sections?: readonly LandingSection<Form>[];
}
export interface LandingHero<Form extends string = string> {
  /** The page's one heading, at most 120 characters. */
  heading: string | AppMessageRef;
  /** At most 600 characters. */
  description?: string | AppMessageRef;
  /** One to three; the first is primary unless it says otherwise. */
  actions: readonly LandingAction<Form>[];
  /** A wide lead photo: one row of a file resource that `auth.public` reads, by its record key, with alt text of at most 200 characters. */
  image?: { from: string; key: string | number; alt: string | AppMessageRef };
  /** Where the photo sits: 'split' (beside the words, the default with an image) or 'overlay' (behind them, under a scrim). */
  layout?: 'split' | 'overlay';
  /** The search panel inside the hero: one to six of a list view's own `filters`, as the `search` section takes them. */
  search?: { view: string; filters: readonly string[]; submitLabel?: string | AppMessageRef };
  /** Up to four short items of at most 60 characters, said as one quiet line under the actions. Not with `points`. */
  highlights?: readonly (string | AppMessageRef)[];
  /** A few words (at most 40) in a chip over the heading, with an App icon where it names one: `{ text: 'Decisions in minutes', icon: 'lightning' }`. */
  badge?: { text: string | AppMessageRef; icon?: AppIcon };
  /** Two to four photos as tiles beside the words, in place of `image`: each a row of a file resource `auth.public` reads, as `image` is. */
  tiles?: readonly { from: string; key: string | number; alt: string | AppMessageRef }[];
  /** Up to four icon rows under the actions, each an App icon and a line of at most 60 characters. Not with `highlights`. */
  points?: readonly { icon: AppIcon; text: string | AppMessageRef }[];
}
/** What a hero takes beyond its heading, description and calls to action: `hero(heading, description, actions, { image, layout, search, highlights, badge, tiles, points })`. */
export type LandingHeroOptions = Pick<LandingHero, 'image' | 'layout' | 'search' | 'highlights' | 'badge' | 'tiles' | 'points'>;
/** A call to action's emphasis, as a button's `intent` says it. */
export type LandingActionIntent = 'primary' | 'secondary';
/** Open a public form view — one the App declares — or, where `auth.public` opens it to signed-out visitors, a
    list or dashboard view; or go to staff sign-in. */
export type LandingAction<Form extends string = Lowercase<string>> =
  | { label: string | AppMessageRef; to: Form; intent?: LandingActionIntent }
  | { label: string | AppMessageRef; signIn: true; intent?: LandingActionIntent };
export interface LandingItem { title: string | AppMessageRef; description: string | AppMessageRef }
export interface LandingQuestion { question: string | AppMessageRef; answer: string | AppMessageRef }
/** `href` is `https://…`, `mailto:…` or `tel:…` — nothing relative, nothing else. */
export interface LandingLink { label: string | AppMessageRef; href: string }
export interface LandingFooter { text?: string | AppMessageRef; links?: readonly LandingLink[] }
export type FeaturesSection = { kind: 'features'; readonly [madeBy]: 'features'; title?: string | AppMessageRef; items: readonly LandingItem[] };
export type StepsSection = { kind: 'steps'; readonly [madeBy]: 'steps'; title?: string | AppMessageRef; items: readonly LandingItem[] };
export type FaqSection = { kind: 'faq'; readonly [madeBy]: 'faq'; title?: string | AppMessageRef; items: readonly LandingQuestion[] };
export type TextSection = { kind: 'text'; readonly [madeBy]: 'text'; title?: string | AppMessageRef; text: string | AppMessageRef };
export type CallToActionSection<Form extends string = string> = { kind: 'callToAction'; readonly [madeBy]: 'callToAction'; title: string | AppMessageRef; description?: string | AppMessageRef; actions: readonly LandingAction<Form>[] };
export type ContactSection = { kind: 'contact'; readonly [madeBy]: 'contact'; title?: string | AppMessageRef; items: readonly LandingLink[] };
/** A list view drawn as its cards, read through `auth.public`: at most `limit` (1–12), the first by `sort`. */
export type LandingViewSection = { kind: 'view'; readonly [madeBy]: 'embed'; title?: string | AppMessageRef; view: string; limit?: number; sort?: string };
/** A search over a list view: one to six of its own `filters`, submitted as that list's conditions. */
export type LandingSearchSection = { kind: 'search'; readonly [madeBy]: 'search'; title?: string | AppMessageRef } & NonNullable<LandingHero['search']>;
export type LandingSection<Form extends string = string> =
  FeaturesSection | StepsSection | FaqSection | TextSection | CallToActionSection<Form> | ContactSection
  | LandingViewSection | LandingSearchSection;

/* ---------- content: command forms ---------- */

/** The screen after a submission, beside the reference the handler returned when it returned one. */
export interface AppFormDone { title?: string | AppMessageRef; /** A sentence under the title. */ description?: string | AppMessageRef }

/**
 * A command form: one form running one command that creates records. Its
 * `label` is the form's heading. With `steps`, every command input is asked
 * on exactly one step and the form is drawn as a stepper; without, it is
 * one page asking every input in order. Presentation only: the handler
 * owns validation and every write.
 *
 * Signed in (the default), it is a room of the App: nav and home may name
 * it, and it runs its command through the signed-in grant — only a role
 * granted the command in `auth.roles.<role>.commands` sees it or submits it.
 * Public (`public: true`, written, never inferred), it is served at
 * `/{app}/form/{key}` to anyone, signed out or signed in, and always runs as
 * a public submission: its command must be registered `public: true`, it
 * may take no `reference` input, and it is never in nav.
 */
export interface AppFormView<Field extends string = string> {
  kind: 'form';
  readonly [madeBy]: 'commandForm';
  /** The form's heading, at most 120 characters. */
  label: string | AppMessageRef;
  /** A signed-in form's address after the App's, when not its key. A public form is `/{app}/form/{key}`. */
  path?: string;
  /** The menu's mark for a signed-in form; a public form is in no menu and takes none. */
  icon?: AppIcon;
  /** Shown under the heading. */
  description?: string | AppMessageRef;
  /** The command the form runs, by name; on a form saved each step, the final submit. */
  command: FormCommandName;
  /** The pages the form asks on, each a label and its fields: `step('The call', ['account', 'notes'])`. A step that
      runs a command of its own instead — `step('About you', 'startApplication')` — makes a public form saved into the
      App's real tables as the applicant goes: this form's `command` is then the final submit, run in one transaction
      over what the steps saved. The server is write-only to the applicant: nothing saved is ever answered back, the
      review before submit is drawn from the page's memory alone, and a draft is found only through an HttpOnly
      cookie whose hash is on the root row (`resume`). Such a form needs `resume` and `draft`, never `prefillable`. On
      a tenant App each step is placed by its `?via=` address, the draft is kept in that tenant (or the platform's
      triage), the cookie continues it only there, and `statusCheck` and `link` are refused. */
  steps?: readonly FormStep<Field>[] | readonly SavedFormStep[];
  /** How the steps are drawn: `'stepper'` (the default) or `'intake'`: a progress bar, one question at a time under the
      step's `title`, a sticky bar of actions and, unless `review: false`, a last page of every step's fields to edit
      before Submit (on a form saved each step the review stays read-only). */
  style?: 'stepper' | 'intake';
  /** Intake: a quiet line over the progress bar, with an App icon: `{ icon: 'shield-check', text: 'Your information is stored securely' }`. Text at most 120 characters. */
  note?: { icon?: AppIcon; text: string | AppMessageRef };
  /** Intake: whether the last page reviews every answer. Default true; `false` submits from the last step. */
  review?: boolean;
  submitLabel?: string | AppMessageRef;
  done?: AppFormDone;
  /** true serves it signed out, under the public rules; false or absent, it is signed in. A public form is write-only:
      its command answers `{ reference: text(…), message: literal(…) }` at most (make the reference `publicReference()`,
      random, never a key), anything else is refused at load, and with steps its last step reviews the answers from the
      page's memory. */
  public?: boolean;
  /** The inputs a link's address may start filled (`?stock_ref=FC-1049`): text, number, date or choice inputs,
      shown, editable and checked like anything typed. A form that names none fills none. On a public form, a page's
      headline may fill them only from fields the public grant opens. */
  prefillable?: readonly Field[];
  /** A form's input drawn by the App's own input component, in place of the platform's control; a public form's page loads
      it too, and the value is still the field's kind's to judge on the server. An input in a group is named by its path (`trade.vin`), and in a repeating group stands in every row; `check` refuses a
      path the command does not take. */
  inputs?: Partial<Record<Field | `${Field}.${string}`, ComponentDecl<string, 'input'>>>;
  resume?: SavedFormResume;
  /** The one root column and the value an unfinished application holds until submit: `{ status: 'in_progress' }`. Staff lists hide it by default. */
  draft?: Readonly<Record<string, string>>;
  /** An expired draft: `'purge'` (the default) removes the root and the rows that point at it; `'keep'` leaves them for follow-up. */
  abandoned?: 'purge' | 'keep';
  statusCheck?: SavedFormStatusCheck;
  link?: SavedFormLink;
  /** The realm it belongs to: a tenant's (the default) or the platform realm's, which needs `auth.tenancy.platform`. */
  realm?: 'tenant' | 'platform';
  /** A signed-in form's: the roles that may open it, within those granted its command. Never on a public form. */
  roles?: readonly string[];
}

export type AppView = AppListView | AppDashboardView | AppLandingView | AppFormView;

/* ---------- content: pages ---------- */

interface SectionCommon {
  title?: string | AppMessageRef;
  /** Optional record side panel; absent means the main region. A page with no `'aside'` section gets a default one of the
      record's remaining fields (`page(…, { aside: false })` opts out). */
  region?: SectionRegion;
  /** The record's sections as tabs: sections sharing a name are one tab's panel, the strip standing where the
      first of them stands. A region that names tabs names two or more (at most 40 characters each). */
  tab?: string | AppMessageRef;
  width?: SectionWidth;
  offsetRight?: SectionOffset;
  /** Shown only when the root record matches: "status = converted", or through a reference path or a computed
      column as a list's filter reads them ("company_id.major_incident_open = true"). */
  when?: string;
}

/** Read-only state presentation, not a transition policy or execution history. The record's own fields, laid out one
    of four ways; a box for another record is `card()`, a figure with buttons `headline()`. */
export interface FieldsSection extends SectionCommon {
  kind?: 'fields';
  readonly [madeBy]: 'fields';
  /** Fields to show: a column, or a dotted path like "account_id.name". */
  show?: readonly string[];
  /** Layout columns for the group. */
  columns?: 1 | 2 | 3;
  /** Default: 'properties' in the aside (`region: 'aside'`), 'summary' in the main region. A call that says the default
      is told so by `mistri check`.
      'summary': compact properties.
      'facts': the values alone in one line, a dot between — "2019 · 85,780 mi · Electric".
      'table': a sheet of caption and value rows in `columns` columns, empty values left out.
      'properties': a property rail — caption beside value, a hairline between rows, every field kept and
      editable in place where the record may change; `region: 'aside'` puts it beside the record. */
  presentation?: 'summary' | 'facts' | 'table' | 'properties';
  /** true edits the properties in place — a choice is a picker, the rest an input — writing through the resource's write
      grant, or, where the reader has none for a column, through an action of the resource that sets just that column (a
      status moved by its machine's actions). The server judges every write as it always does; a reader who may do neither
      sees the values, read-only. For a summary or a property rail. */
  editable?: true;
}

/** A box for the record a reference names — who sells a car, who owns an account — made by `card()`: the reference
    first (its record's name, opening its page), then that record's facts, and a "View …" link at its foot. In the
    aside unless `region` says otherwise. */
export interface CardSection extends SectionCommon {
  kind: 'card';
  readonly [madeBy]: 'card';
  /** The reference column first, then label paths through it (`'dealer_id', 'dealer_id.rating'`); `card()` writes them. */
  show: readonly string[];
}

/** A figure with buttons, made by `headline()`: the first shown field is a large figure (a price), the rest a row of facts, `links` beside. */
export interface HeadlineSection extends SectionCommon {
  kind: 'headline';
  readonly [madeBy]: 'headline';
  /** The figure first, then the facts. */
  show: readonly string[];
  /** One or two calls to action, each opening one of the App's views by key — a public form, a list, a dashboard.
      A public form may start filled: `prefill` from this record's fields (input → field), `defaults` with your words (input → text). */
  links?: readonly ({ label: string | AppMessageRef; to: AppTarget; intent?: 'primary' | 'secondary'; prefill?: never; defaults?: never; open?: never } | {
    label: string | AppMessageRef; to: string; intent?: 'primary' | 'secondary';
    prefill?: Readonly<Record<string, string>>;
    defaults?: Readonly<Record<string, string>>;
    /** `'modal'` draws a form over this record instead of leaving for its
        page — a public form, or a signed-in form view of this App — so the
        price, the photographs and the mileage stay in view while it is filled
        in. The address still opens the form on its own. */
    open?: 'modal';
  })[];
  /** A second figure, under the first and smaller: an estimate, a unit price. */
  subfigure?: string;
  /** An earlier value of the figure — a number or money column, `was: 'was_price'` — struck through beside
      the figure while it is set and above it, and not drawn otherwise. A fact with no value is left out. */
  was?: string;
  /** Small print under the links (at most 300 characters): what the figures assume. */
  note?: string | AppMessageRef;
}

/** A card fact, or a header's: a column path, or `{ column, after }` saying a word after the value ("3 beds"),
    or `{ column, before }` before it — `{ column: 'born_on', before: 'Born' }` reads "Born Apr 24, 2017". */
export type FactEntry<Path extends string = string> = Path | AppCardFact<Path>;

/**
 * The record's head as you say it: `header({ status: 'stage', facts: ['account_id', 'amount', 'close_date'] })`.
 * It is drawn in the head wherever it is written — the page's label over the name, the
 * `status` column's tone as a chip beside the name, the `facts` in one line under it (up to six, captions and units
 * from the display rules, a `{ column, after }` word after its value or `{ column, before }` before it),
 * and the record's actions: exactly one filled — `primary`, the id of the verb the record most needs next,
 * else its first action that is not destructive — then the rest quiet, the destructive ones last: those you
 * name in `destructive`, and update actions that ask for a confirmation or set a value the display tones call
 * bad. A record whose only verbs are destructive has no filled button. No region, tab, width or title.
 */
export interface HeaderSection {
  kind: 'header';
  readonly [madeBy]: 'header';
  status?: string;
  facts?: readonly FactEntry[];
  /** The one action drawn filled, never one of `destructive`: the resource's action by its id (`primary: 'renew'`),
      checked against the keys of `resources.<base>.actions`. */
  primary?: string;
  /** Actions drawn last and quiet, by id: `destructive: ['withdraw']`. */
  destructive?: readonly string[];
  /** The verbs the head draws, by id and in this order, the first filled unless `primary` says another: `actions: ['resolve', 'reassign']`.
      The record's other verbs go into More. They stay granted — the palette, a queue and `useCommand` still reach them — so
      this only says which few the head leads with. Absent, the head draws up to three and folds the rest. */
  actions?: readonly string[];
}

/**
 * The one current related row as a card — the active lease, the latest visit: `current('Current lease', 'lease',
 * 'unit_id', { query: 'status = active', sort: 'starts_on desc', show: ['tenant_id', 'rent', 'ends_on'] })`. The row's
 * name opens it, over its `show` columns as facts; `query` and `sort` choose it, `empty` says what no row means.
 * In the aside unless `region` says otherwise.
 */
export interface CurrentSection extends Pick<SectionCommon, 'title' | 'region' | 'tab' | 'width' | 'when'> {
  kind: 'current';
  readonly [madeBy]: 'current';
  from: string;
  /** The from rows *whose* named column is this record: "unit_id", or a path to it. */
  whose: string;
  show?: readonly PageShowEntry[];
  /** Which rows qualify, in the query language. */
  query?: string;
  /** Which of them is current, written like the query bar: "starts_on desc". */
  sort?: string;
  /** What no current row means. */
  empty?: AppListEmpty;
}

/** How a section's figures are said: a metric's, a breakdown's bars, a chart's axis. */
interface SectionFigureWords {
  /** As a dashboard's: `'percent'` — the figure is 0–100, said with % (`measure: 'avg won_flag * 100'` reads
      "53.8%") — `'number'`, `'money'` in the App's currency, or `'duration'`, a figure of seconds said as "10h 2m".
      Absent, a measure of one column takes that column's display rule, and an average is said to one place ("3.3"). */
  format?: 'percent' | 'number' | 'money' | 'duration';
  /** A word said after each figure: `'of 5'`, `'days'`. */
  unit?: string | AppMessageRef;
}

export interface MetricSection extends SectionCommon, SectionFigureWords {
  kind: 'metric';
  readonly [madeBy]: 'metric';
  /** The dashboard's words: "count" (the default), "sum amount", "avg total as mean". Everything but a count names a column. */
  measure?: string;
  from: string;
  /** The from rows *whose* named column is this record. */
  whose: string;
  /** The record this section is about, when not the root. */
  about?: string;
  /** Extra narrowing, in the query language. */
  query?: string;
  /** One of the table's segments (`resources.<table>.segments`), its conditions ANDed with `query`. */
  segment?: string;
}


/** A page list's show entry: a column path, or the same with its own caption (the page grammar, shared with mistri.json). */
/** A related list's match on a shared key (`related(title, from, { same, near? })`). */
export interface RelatedMatch {
  same: readonly string[];
  near?: Readonly<Record<string, number>>;
}

export type PageShowEntry = string | { column: string; label?: string | AppMessageRef };

/** A related list read as groups (`group`). */
export interface RelatedGroup {
  /** The column, or the path up references to one, the rows are grouped under. A reference makes each group that record:
      its name, linked to its page, with `show` as its facts. A plain column makes each group its value. It cannot end at
      the record the page is on, which would make one group of everything. */
  by: string;
  /** One to four columns of the grouped record, said after its name in the header. Only where `by` ends at a reference. */
  show?: readonly string[];
  /** The groups' order, on one column of the grouped record: "created_on desc". Absent, the largest group first. */
  sort?: string;
  /** Groups to a page, 1 to 10. Default 5. */
  limit?: number;
  /** What the group of rows with no value is called ('Backlog'). Absent, "No <the column>" ("No sprint"). That group
      is always drawn last, whatever the order. */
  empty?: string | AppMessageRef;
  /** One or two numeric columns, rollups or computed numbers of the listed rows, summed over every row of each group
      and said in its header after the count ("12 issues · 34 pts"), in the column's own display rule. Unlike
      `totals` it works beside a `query`. */
  sum?: string | readonly string[];
}

export interface ListSection extends SectionCommon {
  kind: 'list';
  readonly [madeBy]: 'related';
  /** 'gallery': a list over a file resource of images, drawn as a lead photo, thumbnails and a lightbox.
      A cards object: the rows as cards, in the list view's own cards grammar. The one current row as a card is a
      section of its own, `current()`. */
  presentation?: 'gallery' | (AppCardsList & { primary: string });
  from: string;
  /** The from rows *whose* named column (or path to one) is this record. Absent when the list is matched by
      `same`. */
  whose?: string;
  /** Instead of `whose`, rows that share a key with the page's record: one to four columns a listed row shares with
      the record (`same: ['account_id']`), each a column of both tables, the record itself left out where the list is
      over the page's own table. A record with no value there lists nothing. */
  same?: readonly string[];
  /** With `same`: one or two number columns, each within ± this fraction of the record's value (0.25 is ±25%);
      the first is also the order, closest first. */
  near?: Readonly<Record<string, number>>;
  /** A New form for a row of this list, its parent key bound. On a list with a `query`, the query's equalities
      (`status = open`, `kind in (a)`) fill the new row too, so what is added is listed here. Absent, a reader who may add the list's rows is offered "Add <noun>" with the child resource's
      own New form; `false` offers none. */
  create?: string | AppMessageRef | RelatedCreate | false;
  /** The record's own verbs that add to this list, by id, drawn in the list's head rather than the record's — a
      deal's `actions: ['addBuyer']` on its buying committee. Each is offered as the head offers it: granted, and
      while its condition holds. With `actions` and no `create`, the list draws no Add of its own. */
  actions?: readonly string[];
  /** What an empty related list does: guidance (its action opens a served list, dashboard or signed-in form view), or
      `'hide'`, which leaves it out while it has no rows — a person's direct reports, where most people have none —
      or `'collapse'`, which says it in one line with the other empty lists beside it ("No charges, payments or notes
      yet", each with its Add). A list that offers an Add or `actions` to this reader collapses rather than hides, and a
      tab keeps at least one list; inside a `listTabs` strip an empty list is a tab and neither. Absent, the page's
      `empty` applies. */
  empty?: AppListEmpty | 'hide' | 'collapse';
  /** Numeric columns, or the rows' numeric rollups and computed columns (`['total_amount', 'refunded']`), summed in
      one ruled footer row over every row that points at the record — not the page — through any `whose`. The list
      has no `query`, `same` or `near`; not with a presentation. */
  totals?: readonly string[];
  /** true puts a ⋯ menu at the end of each row with that row's own actions and machine verbs, as its page offers
      them: an order's payments are voided and refunded from the order. Not with a presentation. */
  rowActions?: boolean;
  /** The rows under a header for each record they share, one level deep: a household's charges under their lease.
      `limit` then counts the rows to a group (at most 50, "Show all" opens a group to them) and `group.limit` the
      groups to a page. Tables only: not with a presentation, `same` or on a `current()` card; `rowActions` draws its ⋯ on each group's rows. */
  group?: RelatedGroup;
  /** Columns of from, label paths welcome. */
  show?: readonly PageShowEntry[];
  /** Extra narrowing, in the query language. */
  query?: string;
  /** One of the table's segments (`resources.<table>.segments`), its conditions ANDed with `query`. */
  segment?: string;
  limit?: number;
  /** Written like the query bar: "due_on desc, name". */
  sort?: string;
}

export interface BreakdownSection extends SectionCommon, SectionFigureWords {
  kind: 'breakdown';
  readonly [madeBy]: 'breakdown';
  from: string;
  whose: string;
  about?: string;
  /** A column of from, or a dotted path ending in one. */
  by: string;
  /** What each bar measures: "count" (the default), "sum open_value". Everything but a count names a
      column of from, or one of its rollups. Groups are ranked by it, largest first, unless by has a vocabulary,
      whose order they keep. */
  measure?: string;
  /** Extra narrowing, in the query language. */
  query?: string;
  /** One of the table's segments (`resources.<table>.segments`), its conditions ANDed with `query`. */
  segment?: string;
  limit?: number;
}

export interface TimelineStream {
  from: string;
  /** The path from `from` back to this record. */
  whose: string;
  /** The date column the stream is ordered and merged by. */
  at: string;
  /** The line each row becomes: a column, or a dotted path. */
  show: string;
  detail?: string;
  /** Who wrote each row: a column of `from`, or a dotted path, said beside its date. */
  author?: string;
  /** Extra narrowing, in the query language. */
  query?: string;
  /** A reference column of the page's table: the stream is about the row it names, as a list's `about` is, and
      `whose` leads there — a deal's timeline holds its company's tickets with `{ about: 'company_id' }`. */
  about?: string;
  /** This stream's own far side, in place of the timeline's `side`, where its rows name the other party their own way:
      `stream('work_time', 'ticket_id', 'logged_at', 'note', { side: 'person_id = record.caller_id' })`. */
  side?: string;
  /** Every row of this stream on a quiet ground in this tone, in place of the timeline's `tone` rules. */
  tone?: TimelineTone;
  /** `true`: every row of this stream is one line (the date, the line, no author or detail), in place of the
      timeline's `compact` rules — time logged in a ticket's conversation: `stream('work_time', ..., { compact: true })`. */
  compact?: true;
}

export interface TimelineSection extends SectionCommon {
  kind: 'timeline';
  readonly [madeBy]: 'timeline';
  /** Dated child rows from several tables, merged newest-first. Max 4. */
  streams: readonly TimelineStream[];
  /** Per stream, before the merge. */
  limit?: number;
  /** A composer: adds a row of the first stream, bound to this record through its
      direct reference. A string is the button's label. Not with `composer`. */
  create?: string | AppMessageRef | RelatedCreate;
  /** Where the newest row sits. `'last'` reads it as a conversation: oldest first, the newest at the foot, the section
      scrolled to it on arrival. Absent or `'first'`, newest first. */
  newest?: 'first' | 'last';
  /** A conversation's pinned composer under the rows, a Reply / Internal note toggle that runs these commands on this record,
      the text typed becoming the command's first text input (any other input opens the command's own form, filled with it).
      Each command is offered to the reader by an action of the page's resource (`action('Reply', { command: 'reply' })`) and
      a role's `commands` grant; a reader granted neither sees no composer, and one granted a single command sees no toggle. */
  composer?: TimelineComposer;
  /** A row's tone by one of its columns' value — `{ kind: { internal: 'warn' } }` — a quiet ground in a display tone, so
      an internal note reads apart from a reply. Read on each stream whose table has the column and that says no `tone`
      of its own; one no stream reads is refused. */
  tone?: Readonly<Record<string, Readonly<Record<string, TimelineTone>>>>;
  /** Rows drawn as one line, by one of their columns' value — `{ kind: ['system'] }`: the date, the line, no author or detail.
      Read on each stream as `tone` is; a stream's own `compact: true` makes all its rows one line. */
  compact?: Readonly<Record<string, readonly string[]>>;
  /** The other party's rows — a requester's messages in a ticket's conversation — drawn against the far edge on a soft
      surface, the author named once per run: a condition in the query language over each stream's rows, where
      `record.<column>` is the page's record (`'author_id = record.caller_id'`). Asked where the rows are read, through
      the reader's grants; a stream with `about` cannot name the record. A stream whose table lacks a column it names
      is never on the far side, and a stream's own `side` replaces it; one no stream can read is refused. On a phone
      the rows stay full width, told apart by the surface alone. */
  side?: string;
}

/** The display tones a timeline row may be tinted. */
export type TimelineTone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';
/** A conversation's composer: the commands its two modes run. */
export interface TimelineComposer {
  reply: CommandName;
  /** The Internal note mode; absent, the composer is a reply box alone. */
  note?: CommandName;
  /** Canned replies: a Templates menu beside Send listing the rows of `from` by their `labelColumn`; picking one puts
      its `text` column in the box (as `useComposer().fill` does) and sends nothing. `query` narrows the rows offered, in
      the query language (`'active = true'`; `me` is the reader). The reader's own read of `from`
      decides what is listed. */
  templates?: { from: string; labelColumn: string; text: string; query?: string };
}

/** The record's own change history, newest first: each write that changed it — who made it, when, and the action
    or command it came from — with each field from what to what, in the App's words (captions, vocabulary words, a
    reference by its record's name). Declaring one is what makes its resource keep a history: every write to it
    from then on, whichever door it came through, adds a row in the same transaction, in reserved tables provisioned
    once (`mistri migrate stores up`, or `provisionStores` from `@mistriwork/mistri/maintenance` with
    `only: ['record-history']`) — the App does not start without them. A field the reader may not read, or one the
    resource's `audit.redact` names, says that it changed and not its values. Under `auth.rows: 'tenant'` a
    record's history is kept under its key and its owner, and read only in a context that can read the record.
    `history()` stands in the aside, untitled it says "History" in the reader's language, and it shows eight writes
    before "Show earlier changes"; `region: 'main'` puts it under the record. */
export interface HistorySection extends SectionCommon {
  kind: 'history';
  readonly [madeBy]: 'history';
  /** Writes shown before "Show earlier changes", 1 to 100. Default 8. */
  limit?: number;
}


/** The record's row-driven flow runs, newest first: each run's state, its steps, what it waits for and, where it
    failed, why. The page's base resource must declare `flows`. A workflow operator (a role with `operations: ['workflows']`)
    may start a manual flow from here. Flows run only where the server is started with `--jobs`, which the section says.
    Declaring one keeps no history of its own, and it is not supported under `auth.rows: 'tenant'`. */
export interface FlowsSection extends SectionCommon {
  kind: 'flows';
  readonly [madeBy]: 'flows';
}

/** A flow drawn from its step rows: each position a column, the steps that share one its lanes, a branch's other way
    to its `goto` (or to the run's end), each step marked by its kind. On a flow's own page (the base is the `from` table
    of a resource's `flows`) it draws the flow; on the page of a resource that declares `flows`, the record's run over
    its flow's steps: what is done and when, where it stands, what is ahead. The steps are read as the reader's rows when
    the section is drawn, and a step they cannot read is not drawn. */
export interface DiagramSection extends SectionCommon {
  kind: 'diagram';
  readonly [madeBy]: 'diagram';
}

/** A page chart — the related rows measured and drawn, the dashboard's chart about one record:
    `chart('Billed by month', 'invoice', 'month issued_on', { whose: 'customer_id', measure: 'sum total' })`. */
export interface ChartSection extends SectionCommon, SectionFigureWords {
  kind: 'chart';
  readonly [madeBy]: 'chart';
  from: string;
  whose: string;
  about?: string;
  /** What to group by — a bucketed date ("month issued_on") for a line, categories for a donut, two keys
      ("month issued_on, status") for stacked bars. */
  by: string;
  /** "count" (the default), "sum total", "avg amount". Everything but a count names a column. */
  measure?: string;
  /** "line" (default), "bar", "donut" or "stacked", as on a dashboard. */
  shape?: 'line' | 'bar' | 'donut' | 'stacked';
  /** The order of a bar chart's or donut's categories: `'value'` (largest first), `'category'` (the key's own order),
      or one column of `from` as a list sorts ("starts_on", "ended_on desc"). Absent, a category with an order of its
      own keeps it — a date, a number that is a step, a column with allowed values (in that order), or the rows' own
      label, one bar for each row, in the order the rows were made — and any other goes largest first. */
  sort?: 'value' | 'category' | (string & {});
  /** Extra narrowing, in the query language. */
  query?: string;
  /** One of the table's segments (`resources.<table>.segments`), its conditions ANDed with `query`. */
  segment?: string;
  /** A donut's slices or a stacked chart's bars, largest kept. */
  limit?: number;
  /** The drawing's height in CSS pixels (120 or more). */
  height?: number;
  /** A goal ruled across a line or stacked bars; not on a donut. */
  target?: number;
}

/** The author speaking on a record's page — guidance, a policy, what to do next: `note('Call within a day.')`. */
export interface NoteSection extends SectionCommon {
  kind: 'note';
  readonly [madeBy]: 'note';
  /** The words. Plain text; blank lines separate paragraphs. */
  text: string | AppMessageRef;
  /** 'quiet': small print, no mark, for the line that should not compete with the record. 'callout': a ground of its own, for what must be seen. Absent: the plain note. */
  variant?: 'quiet' | 'callout';
  /** A curated mark above the words. */
  icon?: AppIcon;
  /** One of the App's list or dashboard views to open. */
  action?: AppLinkAction;
}

/** A list view drawn on a record's page, its rows narrowed to those pointing at the record:
    `embed('invoices', { whose: 'customer_id' })`. It shows what the view shows — its columns or its card,
    its standing query and first tab, its order, and a board or calendar presentation, drawn as its room draws it
    (a board embed moves cards where the reader may edit the board's column) — and its heading is the view's label. */
export interface EmbedSection<View extends string = string> extends Omit<SectionCommon, 'tab'> {
  kind: 'view';
  readonly [madeBy]: 'embed';
  /** A list view's key. */
  view: View;
  /** The view's rows *whose* named column is this record. */
  whose: string;
  /** The record this section is about, when not the root. */
  about?: string;
  /** Rows per page. */
  limit?: number;
  /** The record's section tab it stands in (not one of the view's tabs, which is always its first). */
  tab?: string | AppMessageRef;
}

/** One read of rows a page's custom section declares: related to the record by `whose`, or the resource's own rows. */
export interface CustomRead {
  from: string;
  /** The from rows *whose* named column is this record. Absent, the rows are not tied to it: the query narrows them. */
  whose?: string;
  query?: string;
  /** The columns the component reads, label paths welcome; each row carries exactly these. */
  show: readonly string[];
  sort?: string;
  /** 1 to 500; default 10. */
  limit?: number;
}

/** One aggregate read a page's custom section declares: a figure the server counted, summed or averaged under the
    reader's grants and row policy, exact over every row (not the rows a `rows` read loaded, which stop at 500). The
    component receives it as `figures.<name>`: a number with no `by`, a group for each value (`{ key, value, label? }`)
    with one. */
export interface CustomFigure {
  from: string;
  /** "count", "sum amount", "avg amount", "min due_on" or "max due_on". */
  measure: CustomMeasure;
  /** Group the figure: a column, a path or a period and a date column ("status", "month opened_on"). */
  by?: string;
  /** The from rows *whose* named column is this record. Absent, the figure is over the resource's own rows, narrowed by `query`. */
  whose?: string;
  query?: string;
  /** With a `by`, the most groups returned: 1 to 500. Default 100. */
  limit?: number;
}

/** An author's component where a section stands: `custom('Pay history', payrollTimeline, { record: ['status'], rows: { runs: { from, show } } })`.
    Region, tab, width and `when` apply as to any section. Not on a page `auth.public` opens. */
export interface CustomSection extends SectionCommon {
  kind: 'custom';
  readonly [madeBy]: 'custom';
  component: ComponentDecl<string, 'section'>;
  /** The record's own fields the component reads, label paths welcome. */
  record?: readonly string[];
  /** Named reads, at most eight; the component receives each as `rows.<name>`. */
  rows?: Readonly<Record<string, CustomRead>>;
  /** Named aggregate reads, at most eight; the component receives each as `figures.<name>`, exact past the rows' 500. */
  figures?: Readonly<Record<string, CustomFigure>>;
  props?: Readonly<Record<string, string | number | boolean>>;
}

export type PageSection = FieldsSection | HeaderSection | CurrentSection | MetricSection | ListSection | CardSection | HeadlineSection | BreakdownSection | ChartSection
  | NoteSection | EmbedSection | TimelineSection | HistorySection | FlowsSection | DiagramSection | CustomSection;

/** One record's screen. In an App it is keyed in `pages` (or is a file found by its name: pages/<key>.json, or pages/<key>.ts whose default export is the page); the key is its id. */
export interface AppPage<Base extends string = string> {
  readonly [madeBy]: 'page';
  /** The resource a root record is chosen from. The page is called what that resource's `noun` says (else its table's name). */
  base: Base;
  /** Its address after the App's, when not its key. Its records are addressed through the list view over its base
      when there is one; a page's own address is for a base no list shows, or a second page over one. */
  path?: string;
  /** true draws each run of adjacent related lists as one tab strip. Absent or false, the sections stand as
      written, each at its own `width`; a list with a `width` never joins a strip. Tabs of other sections are `tab`. */
  listTabs?: boolean;
  /** What a related list that says nothing of its own `empty` does while it has no rows: `'hide'` leaves it out,
      `'collapse'` says it in one line with the other empty lists beside it ("No charges, payments or notes yet", each
      with its Add). A list's own `empty` wins. */
  empty?: 'hide' | 'collapse';
  /** A page that declares no `region: 'aside'` section gets one: the record's remaining readable fields, those no
      section shows, as a property rail titled by the resource's `noun` ("Bike"). `false` leaves it out and the page
      stands as written. Nothing remaining, or a `fields([])` that already says the whole record, draws none. */
  aside?: false;
  /** Its archetype, the arrangement of its regions. Absent is the one its sections make, chosen when the App is read
      and never from a row (`mistri check --defaults` says which and why): a gallery first is a showcase, a timeline
      that ends the main column with no list there a conversation, the record's long text with no more than 12 facts
      and nothing else an article, anything else the record's own. `'record'` is the record's own written out (a main
      column, an aside a third of it beside), for a page that would be chosen as another. A written layout refuses a
      section it cannot place, where a chosen one falls back to the record. `'conversation'`: one timeline, last in the main column so its composer ends the thread, the record's
      cards beside it; a related list stands in the aside. `'showcase'`: the photos (a gallery, first) at two thirds
      with a panel of 1 to 3 aside sections (the price headline) beside them, then the rest at full width; on a phone
      the price comes straight after the photos. `'article'`: one column at a reading measure, with no aside. The look
      dresses each; a layout never sets a colour. A page's `layout` names a shape from this fixed set; a dashboard's
      `areas` ({@link AppDashboardView}) draws its own grid. */
  layout?: 'record' | 'conversation' | 'showcase' | 'article';
  sections?: readonly PageSection[];
  /** The realm it belongs to: a tenant's (the default) or the platform realm's, which needs `auth.tenancy.platform`. */
  realm?: 'tenant' | 'platform';
  /** The roles that may open it. A reader holding none is not served it: a record of its base opens on another page,
      and its own address answers as one that does not exist. Each must be a role `auth.roles` declares. */
  roles?: readonly string[];
  /** The record on paper, made with `document()`: an invoice, a packing slip, a payslip. */
  document?: AppDocument;
}

/* The authored spelling the engine's page rules write back (model.d.ts `AuthoredSection`, `AuthoredPage`): these
   types, as plain data. */
declare module '@mistriwork/engine/schema/model.js' {
  interface AuthoredPageShapes {
    section: Plain<PageSection>;
    page: Plain<AppPage>;
  }
}

/** A record on paper (`document()`): printed by the browser, saved as a PDF by the browser. Its address is its
    record's with its key after it (`/orders/12/invoice`), and it is a verb in its record's More menu. It reads what
    the record's own page reads, under the same grants, row scope and tenant. */
export interface AppDocument {
  /** What it is, "Invoice" or "Packing slip": the verb on the record and the sheet's heading. */
  label: string | AppMessageRef;
  /** A field of the record whose value is the document's number: `'invoice_no'`, `'pay_run_id.reference'`. Absent: the
      record's own name. */
  number?: string;
  /** The sheet: ISO A4 or US Letter. Absent: the paper of the App's (or tenant's) locale, Letter in North America. */
  size?: 'a4' | 'letter';
  /** The sender's lines under the letterhead's logo and name: an address, a registration number. Newlines are kept. */
  description?: string | AppMessageRef;
}
/** What paper draws: the record's own fields, the rows that point at it (every line, its header repeated on each
    sheet), and notes, placed side by side by `width` and `offsetRight`. */
export type DocumentSection = FieldsSection | ListSection | NoteSection;

/** A mistri.json page: the same body in an array, naming its own id. */
export interface ConfigPage extends Omit<AppPage, Made | 'realm' | 'sections' | 'path' | 'roles' | 'layout'> {
  id?: string;
  /** Its word in the Pages menu and its heading. Absent: the base table's name. */
  label?: string | AppMessageRef;
  /** The one connection this page is for, by id or name, as the root of mistri.json names it. Absent: every connection. */
  connection?: string;
  sections?: readonly Plain<PageSection>[];
}

/* ---------- home and nav ---------- */

/**
 * Where a visitor starts: a rule list read in order, first match wins.
 * `signedOut` matches a visitor with no session; `roles` a signed-in one
 * holding any of them; a rule with neither matches everyone, and ends the
 * list, so every visitor has a home. The server evaluates the rules on each
 * request, from the verified session's roles (a tenant App's, the current
 * membership's); a rule whose view the visitor cannot open gives way to the
 * next that matches.
 */
/** A view id is lowercase by rule, so ids default to `Lowercase<string>` rather than `string`: a literal written
    under `satisfies App` stays a literal the reference layer can check. Role names in a home rule do too. */
export type AppHomeRule<View extends string = Lowercase<string>, Role extends string = Lowercase<string>> =
  | { view: View; signedOut: true; roles?: never }
  | { view: View; signedOut?: never; roles?: readonly Role[] };
/** A view id for every visitor, or rules that end with one with no condition. Required: nothing is inferred from nav. */
export type AppHome<View extends string = Lowercase<string>, Role extends string = Lowercase<string>> = View | readonly AppHomeRule<View, Role>[];

/**
 * A menu mark: one of Phosphor's icons by its own name (https://phosphoricons.com,
 * MIT), from the curated set business menus use. Drawn before the entry's words in
 * the side and top menus, and alone in the icon rail (`ui.shell.rail`). The names are
 * listed in `mistri docs icons`.
 */
export type AppIconName =
  | 'house' | 'tray' | 'list' | 'list-checks' | 'kanban' | 'table' | 'calendar' | 'calendar-check'
  | 'clock' | 'chart-bar' | 'chart-line' | 'chart-pie' | 'gauge' | 'target' | 'flag' | 'user' | 'users'
  | 'user-circle' | 'address-book' | 'handshake' | 'buildings' | 'storefront' | 'briefcase' | 'package'
  | 'truck' | 'car' | 'shopping-cart' | 'receipt' | 'currency-dollar' | 'credit-card' | 'wallet'
  | 'bank' | 'file' | 'file-text' | 'folder' | 'clipboard-text' | 'note' | 'archive' | 'tag' | 'ticket'
  | 'star' | 'bookmark-simple' | 'bell' | 'envelope' | 'chat-circle' | 'phone' | 'headset' | 'megaphone'
  | 'globe' | 'map-pin' | 'magnifying-glass' | 'gear' | 'sliders' | 'wrench' | 'bug' | 'shield-check'
  | 'lock' | 'key' | 'database' | 'stack' | 'lightning' | 'check-circle' | 'warning' | 'info'
  | 'cell-signal-low' | 'cell-signal-medium' | 'cell-signal-high' | 'cell-signal-full' | 'fire'
  | 'hourglass' | 'circle-dashed' | 'x-circle' | 'plus-circle' | 'pencil-simple' | 'paper-plane-tilt'
  | 'arrows-left-right' | 'arrow-circle-down' | 'arrow-circle-up' | 'laptop' | 'monitor'
  | 'device-mobile' | 'printer' | 'stethoscope' | 'heartbeat' | 'heart' | 'pill' | 'syringe'
  | 'first-aid-kit' | 'thermometer' | 'flask' | 'test-tube' | 'microscope' | 'bed' | 'hospital'
  | 'ambulance' | 'tooth' | 'eyeglasses' | 'wheelchair' | 'baby' | 'dna' | 'brain' | 'bandaids'
  | 'hand-heart' | 'graduation-cap' | 'book-open' | 'student' | 'chalkboard-teacher' | 'factory'
  | 'warehouse' | 'house-line' | 'plant' | 'leaf' | 'sun' | 'cloud' | 'drop' | 'airplane' | 'bicycle'
  | 'bus' | 'train' | 'boat' | 'hammer' | 'toolbox' | 'plug' | 'lightbulb' | 'cube' | 'camera' | 'image'
  | 'trophy' | 'gift' | 'coffee' | 'fork-knife' | 'shopping-bag' | 'basket' | 'barcode' | 'qr-code'
  | 'scales' | 'gavel' | 'certificate' | 'identification-card' | 'fingerprint' | 'eye' | 'link'
  | 'paperclip' | 'scissors' | 'palette' | 'code' | 'terminal' | 'users-three' | 'user-plus';

/** A menu icon: one of `AppIconName` (`mistri docs icons` lists them), checked by `mistri check`. The types take any lowercase
    word so a misspelled name is reported at the icon by `check`, not by a failed overload of the helper it sits in. */
export type AppIcon = AppIconName | Lowercase<string>;

export type AppNavLink = { label: string | AppMessageRef; to: StaticAppTarget };
/** Type-only target manifest checking; the runtime helper returns its argument. */
export declare function appLink<TargetManifest>(target: StaticAppTarget & {
  app: TargetManifest extends { id: infer Id extends string } ? Id : string;
} & ({ kind: 'home' } | { kind: 'view'; view: ViewId<TargetManifest> }
  | { kind: 'record'; resource: IdsIn<Contributed<TargetManifest, 'resources'>> })): StaticAppTarget;
export declare function appLink<TargetManifest>(target: AppTarget & {
  app: TargetManifest extends { id: infer Id extends string } ? Id : string;
} & ({ kind: 'home' } | { kind: 'view'; view: ViewId<TargetManifest> }
  | { kind: 'record'; resource: IdsIn<Contributed<TargetManifest, 'resources'>> })): AppTarget;

export interface AppNavGroup<View extends string = Lowercase<string>, Placement = never> {
  /** Stable, tree-wide unique lowercase slug. */
  id: string;
  label: string | AppMessageRef;
  /** The group's mark in the top bar's strip and its menus. */
  icon?: AppIcon;
  children: readonly AppNavNode<View, Placement>[];
  /** The realm it belongs to: a tenant's (the default) or the platform realm's, which needs `auth.tenancy.platform`. */
  realm?: 'tenant' | 'platform';
  /** 'footer' holds a top-level group at the foot of the sidebar, apart from the rest. It folds as any section does,
      its heading kept at the foot and its rows opening above it. */
  placement?: 'footer';
  /** In the top bar, a top-level group's entries stand in the bar as links of their own, not under its menu. The sidebar still draws the group. */
  inline?: true;
  /** In the sidebar, the section starts folded to its heading for someone who has never opened or closed it: for a section used rarely.
      Their own fold, once chosen, is remembered over it; the section still opens itself while it holds the current room, while the menu is filtered, and in the rail. */
  folded?: true;
}
/** In the App's nav and its groups only: the named feature's nav fragment, spliced in place, once. */
export interface AppNavPlacement<Feature extends string = Lowercase<string>> { feature: Feature }
/** A local view reference, a static checked App link, a group, or a feature placement. Never a definition. */
/** A nav entry's dot, in its icon's place: one of the theme's eight chart colors, so a project or a label is told
    apart at a glance — `{ to: 'launch', label: 'Q3 launch', color: 2 }`. */
export type AppNavColor = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type AppNavNode<View extends string = Lowercase<string>, Placement = never> =
  | View
  | { to: View; label: string | AppMessageRef; color?: AppNavColor }
  | (AppNavLink & { color?: AppNavColor })
  | AppNavGroup<View, Placement>
  | Placement;

/* ---------- ui ---------- */

/** Authored choices only. Absence offers no App switcher. Runtime access may
 * remove choices, never add to an authored list or grouped menu. */
export type AppSwitcher = { placement: 'navbar' | 'account'; label?: string | AppMessageRef } & (
  | { apps: 'authorized' | readonly string[]; groups?: never }
  | { groups: readonly { label: string | AppMessageRef; links: readonly AppNavLink[] }[]; apps?: never }
);

/** App defaults: legacy tokens or a built-in/registered preset. No arbitrary CSS. */
export interface AppTheme {
  /** Built-in theme, or one of `ui.customThemes`, used by the Default preference. The built-in names
      keep an authored literal a literal, so `defineApp` can check it against the App's custom themes. */
  preset?: import('@mistriwork/engine/schema/theme.js').ThemeBase | (string & {});
  /** Named palette of the preset; `default` explicitly selects its original colors. */
  palette?: string;
  /** The App's own color: one, authored for the light ground and mixed toward white on the dark one, or
      `{ light, dark }`, one for each, worn as written. The soft tint of a selected item is derived from it. */
  accent?: string | { light: string; dark: string };
  /** A CSS length: "0", "10px". */
  radius?: string;
  /** The data face; the reader's typography preference still wins. */
  font?: string;
  /**
   * A theme per audience: `public` for every page a signed-out visitor sees (the landing, sign-in, a public form or
   * view), worn whatever a reader once picked, so those pages are the same for everyone; and one per role, the
   * first entry in written order that the account holds. A reader's own pick still wins in the shell, and a role's
   * theme wins over a tenant's saved one. Each names a built-in look or one of `ui.customThemes`; each role is one of
   * `auth.roles`. The App's `accent`, `radius` and `font` stay over whichever is worn, and `palette` only over the
   * preset it names; a tenant's accent, logo, name, corner and density are laid over it as over its own theme.
   */
  for?: { public?: import('@mistriwork/engine/schema/theme.js').ThemeBase | (string & {}); roles?: Readonly<Record<string, import('@mistriwork/engine/schema/theme.js').ThemeBase | (string & {})>> };
}

/** Optional App presentation overrides. Omitted settings keep the existing UI. */
export interface AppShell {
  /** Where the nav lives: the sidebar (default) or a top bar — the web-app shell. `{ top: ['employee'] }` draws the
      top bar for a person whose every role is listed, and the sidebar for anyone holding another: a portal's
      employees get a slim bar of their few places while the agents keep the sidebar. */
  placement?: 'side' | 'top' | { top: readonly string[] };
  /** With the side placement: folding the sidebar (its « button, ⌘B) leaves a
      rail of the entries' icons by default. Set false to hide it completely. An App with no `nav` has no menu. */
  rail?: boolean;
  /** Show the sidebar menu filter. Defaults to false in Apps. */
  menuSearch?: boolean;
  /** Show live row counts beside the App menu's lists of work: a list whose condition picks its machine's unfinished states, a date at or before today (said in the danger's ink), or the reader (me). A list's own count: true or false says otherwise. Defaults to false; Workbench estimates remain. */
  counts?: boolean;
  /** The header's search: its box and its button, on a phone too. A member sees it by default and a signed-out
   * visitor does not, having nothing of their own to search; 'everyone' offers it to a visitor as well,
   * and false hides it from everyone. Default 'members'. */
  search?: 'members' | 'everyone' | false;
  /** false hides the crumb bar above each room. Default true. */
  breadcrumbs?: boolean;
  /** false keeps each room's heading for a screen reader only, and drops a list's empty chip row and count. Default true. */
  heading?: boolean;
  width?: 'full' | 'wide' | 'narrow';
  /** Align header contents to width/gutter; its background and border remain full width. */
  headerWidth?: 'full' | 'content';
  gutter?: 'none' | 'compact' | 'normal' | 'comfortable';
  /** Sidebar-specific presentation. This is static App chrome, never a tenant
      or account switcher. */
  sidebar?: AppSidebar;
  /** The header's New menu: one "+ New" button beside the bell, listing every way to make
      something — a list by its view key (`{ view: 'tickets' }`, its New form), a signed-in form by its
      view key or by the command it runs (`{ command: 'raiseChange' }`). Each reader sees the entries
      they may use: a list whose table they may add to, a form whose command they are granted; none, no
      button. The palette lists the same entries. Naming a form here counts as referencing it. A long menu
      groups its lines under headings, in a nav group's shape: `{ label: 'Service desk', children: [...] }`. */
  new?: readonly (AppShellNew | AppShellNewGroup)[];
}

/** One line of the New menu (`ui.shell.new`): the view or command it opens, and its words and mark —
    absent, a list's noun ("Ticket") or the form's label. */
export type AppShellNew =
  | { readonly view: string; readonly label?: string | AppMessageRef; readonly icon?: AppIcon }
  | { readonly command: string; readonly label?: string | AppMessageRef; readonly icon?: AppIcon };
/** A run of New menu lines under a heading, written as a nav group is: `{ label: 'Service desk', children: [{ view:
    'tickets' }, ...] }`. A long menu reads by its groups; a line outside every group is drawn where it is written,
    with no heading. */
export interface AppShellNewGroup {
  readonly label: string | AppMessageRef;
  readonly children: readonly AppShellNew[];
}

/** Optional presentation for a roomier side menu and its fixed workspace identity. */
export interface AppSidebar {
  /** Compact keeps the ordinary menu rhythm; comfortable gives rows more room. */
  density?: 'compact' | 'comfortable';
  /** Static identity at the bottom of the sidebar. It has no switching behaviour. */
  footer?: { title: string | AppMessageRef; description?: string | AppMessageRef };
}

/** Existing-record save preference; grants no write capability. */
export interface AppEditing {
  save: 'explicit' | 'blur';
}

/** A file reference, never a URL or raw CSS. Key values name columns of the branding record. */
export interface BrandingImageBinding<Column extends string = string> {
  readonly from: string;
  readonly key: Readonly<Record<string, Column>>;
  readonly alt?: string | AppMessageRef;
}
export type BrandingFields<Column extends string = string> = Readonly<
  Partial<Record<'preset' | 'accent' | 'fontPair' | 'barStyle' | 'name' | 'heading' | 'tagline' | 'hours' | 'about', Column>> & {
    logo?: BrandingImageBinding<Column>; hero?: BrandingImageBinding<Column>;
  }>;
export interface FromRecordOptions<Column extends string = string> {
  readonly by: 'host' | 'tenant';
  readonly tenantField: Column;
  readonly publishedField?: Column;
  readonly fallback: { readonly preset: import('@mistriwork/engine/schema/theme.js').ThemeBase };
  readonly fields: BrandingFields<Column>;
}
export interface RecordBrandingSpec<Resource extends string = string, Column extends string = string> extends FromRecordOptions<Column> {
  readonly kind: 'fromRecord';
  readonly from: Resource;
}
/** Plain data; runtime catalog checks validate types, visibility and exact file keys.
 * Literal resource/column names survive for `satisfies TypedAppConfig`. */
export declare function fromRecord<const Resource extends string, const Options extends FromRecordOptions>(
  resource: Resource, options: Options & Record<Exclude<keyof Options, keyof FromRecordOptions>, never>,
): { readonly kind: 'fromRecord'; readonly from: Resource } & Options;
/** A tenant's own words over the App's catalogs (`ui.messages`): one row per key and locale, its text ICU. */
export interface FromRecordMessagesOptions<Column extends string = string> {
  readonly by: 'tenant';
  readonly tenantField: Column;
  readonly fields: { readonly key: Column; readonly locale: Column; readonly text: Column };
}
export interface RecordMessagesSpec<Resource extends string = string, Column extends string = string> extends FromRecordMessagesOptions<Column> {
  readonly kind: 'fromRecord';
  readonly from: Resource;
}
export declare function fromRecord<const Resource extends string, const Options extends FromRecordMessagesOptions>(
  resource: Resource, options: Options & Record<Exclude<keyof Options, keyof FromRecordMessagesOptions>, never>,
): { readonly kind: 'fromRecord'; readonly from: Resource } & Options;

/** `ui.locale` read per reader: a text column of a resource (`resource.column`) naming a language tag, and the App's own. */
export interface ReaderLocale {
  column: string;
  default?: string;
}

/** `ui.timezone` read per reader: a text column of a resource (`resource.column`) naming an IANA zone, and the App's own. */
export interface ReaderZone {
  column: string;
  default?: string;
}

/**
 * An App's own logo picture: files in its directory, each a PNG, JPEG, WebP, GIF or SVG (an SVG is written again from
 * an allowlist; a raster stays under 256 KB), served from the App's own origin by its content's name. Never a URL.
 */
export interface AppLogoImage {
  /** The picture the bar draws, fitted in a 96 by 24 box at its start. */
  src: string;
  /** The picture drawn on a dark bar: in dark mode, and by day under a theme whose bar is dark; omitted, `src` on the dark bar, and `check` says so (`theme-dark`). */
  dark?: string;
  /** A square picture for the browser tab; omitted, the tab shows `src`. */
  mark?: string;
}

/** Chrome and formatting: the one nested block of the root. */
export interface AppUi {
  /** Explicit compact picker or grouped mega menu; independent of shell placement. */
  appSwitcher?: AppSwitcher;
  /** The App's footer, drawn under every room: a line of small print and a
      row of links. The landing wears it too. */
  footer?: LandingFooter;
  /** Decorative brand mark drawn beside the App name: an App icon, or the App's own picture (`{ src, dark, mark }`).
      The name remains its accessible label. */
  logo?: AppIcon | AppLogoImage;
  /** The App's look: a built-in or a registered theme by name, with the App's accent (`{ preset: 'lumen' }`), or one
      read from a record (`fromRecord`). A theme of its own is registered in `customThemes` and named here by its id. */
  theme?: AppTheme | RecordBrandingSpec;
  /** The App's own themes (`defineTheme(...)`): `theme.preset` names one as its look, and each is offered in the
      reader's theme picker. */
  customThemes?: readonly import('@mistriwork/engine/schema/theme.js').Theme[];
  shell?: AppShell;
  /** Omission keeps explicit Save. Workbench always uses explicit review/apply. */
  editing?: AppEditing;
  /** false hides the Export menu everywhere the app curates, and the server refuses the file as well, over any role's export grant. Default true. */
  export?: boolean;
  /** true makes the App an installable PWA: its pages carry its manifest and worker registration, and it serves
      its worker, its painted icons and an offline page for failed navigations. Offline data is not part of it: with
      no connection the App opens to its offline page, and its lists, records and writes need the network. @preview */
  pwa?: boolean;
  /** BCP 47 tag the App is said and written in: its captions' language where it has `messages/<locale>.ts` catalogs, and
      every figure — numbers, money, dates, counts ("en-AU"). Default: the reader's browser decides the figures.
      `{ column: 'person.locale', default: 'en-US' }` says each reader's in the tag the first row of that text column
      they may read names; a tenant's (`branding.allow: ['locale']`) comes next, then `default`. */
  locale?: string | ReaderLocale;
  /** A tenant's own words over the App's catalogs, read from a record:
      `fromRecord('tenant_message', { by: 'tenant', tenantField: 'tenant_id', fields: { key: 'key', locale: 'locale', text: 'text' } })`.
      A row is checked as it is written and skipped when read if it no longer says a source key's arguments. */
  messages?: RecordMessagesSpec;
  /** IANA zone the app's "today" is reckoned in ("Australia/Sydney"). A TIMESTAMP or DATETIME with no zone holds the wall clock in it (UTC when the App names none); a column with a zone holds the instant.
      `{ column: 'desk_setting.timezone', default: 'America/New_York' }` counts each reader's days — today, windows, the
      payload's zone — in the zone the first row of that text column they may read names (their tenant's, their
      account's); writes keep `default`, which also stands in where the row names none. */
  timezone?: string | ReaderZone;
  /** ISO 4217 default for money rules that name none. Defaults to USD. */
  currency?: string;
  /** The origins the page opens beside the App's own for its custom components, recorded in authority.lock. Each is
      https, a host and a port; no path, no wildcard. */
  csp?: {
    /** Origins they may send requests to — `['https://api.example.com']` — opened in the page's policy (`connect-src`). */
    connect?: readonly string[];
    /** Origins they may load pictures from, beside the App's own: the page's `img-src`. Once an App serves components,
        pictures come only from its own origin and these. */
    images?: readonly string[];
  };
}

/* ---------- the root ---------- */

export type FlagJson = null | boolean | number | string | readonly FlagJson[] | { readonly [key: string]: FlagJson };
export type FlagObject = { readonly [key: string]: FlagJson };
export type FlagValue = boolean | string | number | FlagObject;
export interface FlagOptions<T extends FlagValue> {
  readonly owner: string;
  readonly variants?: readonly T[];
  readonly safeValue?: T;
  readonly expiry?: string;
  readonly tenantManaged?: boolean;
}
export interface FlagDefinitionOf<T extends FlagValue, K extends string> extends FlagOptions<T> {
  readonly type: K;
  readonly default: T;
}
export type FlagDefinition = FlagDefinitionOf<boolean, 'boolean'> | FlagDefinitionOf<string, 'string'>
  | FlagDefinitionOf<number, 'number'> | FlagDefinitionOf<FlagObject, 'object'>;
export interface FlagCapability {
  readonly actions: readonly ('view' | 'manage' | 'killswitch')[];
  readonly environments: readonly string[];
  readonly owners: readonly string[];
  readonly ids?: readonly string[];
}
/** Scoped experiment viewing, lifecycle management and explicit decisions.
 * These powers are independent of flag management and Console admission. */
export interface ExperimentCapability {
  readonly actions: readonly ('view' | 'manage' | 'decide')[];
  readonly environments: readonly string[];
  readonly owners: readonly string[];
  readonly ids?: readonly string[];
}
/** Who an audience holds, defined once at the App's root and named by flag rules
 * and experiment eligibility. Every condition given must hold; `allow` and `deny`
 * name account ids and decide before the rest. `rollout` is a stable share of
 * signed-in accounts or visitors, salted by the audience's name, so every flag
 * and experiment naming it reaches the same people. An email domain is read
 * only from an address its account proved. */
export interface AudienceDefinition {
  /** Roles from `auth.roles`; holding any one is enough. */
  readonly roles?: readonly string[];
  /** Tenant ids; the request's verified tenant must be one. Never grants tenant access. */
  readonly tenants?: readonly string[];
  readonly attributes?: { readonly emailDomain?: readonly string[] };
  readonly rollout?: number;
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}
/** Frozen eligibility, allocation, binary conversion metrics and fixed windows.
 * Analytics requires an explicitly enrolled suite deployment and source delivery;
 * rendering never creates a visitor or records an exposure by itself. */
export interface ExperimentDeclaration {
  readonly version: string;
  readonly unit: 'subject' | 'visitor';
  readonly control: FlagValue;
  readonly startsAt: string;
  readonly endsAt: string;
  /** How long after a subject's first exposure a conversion counts: `'48 hours'`. */
  readonly conversionWindow: Duration;
  /** How long after `endsAt` a late delivery is still taken: `'24 hours'`. */
  readonly deliveryGrace: Duration;
  /** Who may enter is said only by audiences, the same ones flag rules name. */
  readonly eligibility: {
    readonly rollout?: number;
    /** Audience names; a member of any one is eligible. Each definition is frozen into the experiment's version. */
    readonly audiences?: readonly string[];
  };
  /** Two to sixteen arms; the parser checks dynamic lists too. */
  readonly allocation: readonly { readonly value: FlagValue; readonly weight: number }[];
  readonly primary: { readonly conversion: string };
  /** When present, one to sixteen binary guardrails; a winner is decided only while every one holds. */
  readonly guardrails?: readonly { readonly conversion: string; readonly maxIncrease: number }[];
}
/** One step of a funnel: exactly one of a view or page id, a command id (counted when it ran), a form (and optionally one of its step ids), or an event name. */
export type AnalyticsStep = { readonly view: string } | { readonly command: string }
  | { readonly form: string; readonly step?: string } | { readonly event: string };
/** Behavior analytics, off unless declared. Where events are stored is configuration
 * (`analytics.store`), never the App's; the store holds no email, IP address, user agent,
 * referrer or payload text. Declared names are checked: analytics-unknown-step,
 * analytics-not-collected, analytics-name-clash. */
export interface AnalyticsDeclaration {
  /** Built-in kinds recorded; omitted means none. */
  readonly collect?: readonly ('views' | 'commands' | 'forms')[];
  /** Custom events a component emits through `useAnalytics().emit`, each with its field allow-list. Named as a view id is: `'compare-opened'`. */
  readonly events?: Readonly<Record<string, { readonly fields?: readonly string[] }>>;
  /** Funnels by id, named as a view id is: `'apply'`, `'trial-to-paid'`. */
  readonly funnels?: Readonly<Record<string, {
    readonly unit: 'subject' | 'visitor';
    /** How long after its first step a subject may take the rest, at most a year: `'72 hours'`, `'30 days'`. */
    readonly conversionWindow: Duration;
    /** Two to ten steps. */
    readonly steps: readonly AnalyticsStep[];
  }>>;
}
export declare const flag: {
  boolean<const O extends FlagOptions<boolean>>(value: boolean, options: O & { safeValue?: false } & ClosedFlagOptions<O>): FlagDefinitionOf<boolean, 'boolean'> & O;
  string<const O extends FlagOptions<string>>(value: string, options: O & ClosedFlagOptions<O>): FlagDefinitionOf<string, 'string'> & O;
  number<const O extends FlagOptions<number>>(value: number, options: O & ClosedFlagOptions<O>): FlagDefinitionOf<number, 'number'> & O;
  object<const O extends FlagOptions<FlagObject>>(value: FlagObject, options: O & ClosedFlagOptions<O>): FlagDefinitionOf<FlagObject, 'object'> & O;
};
type ClosedFlagOptions<O> = { [K in Exclude<keyof O, keyof FlagOptions<FlagValue>>]: never };
type ExperimentListSize = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;
type ClosedExperimentEntries<L, Allowed extends string, Size extends number> = { [I in keyof L]: { [K in Exclude<keyof L[I], Allowed>]: never } }
  & (L extends { length: infer N } ? number extends N ? unknown : { length: Size } : unknown);
type ClosedExperiment<E> = { [K in Exclude<keyof E, keyof ExperimentDeclaration>]: never } & {
  eligibility: { [K in Exclude<keyof Held<E, 'eligibility'>, keyof ExperimentDeclaration['eligibility']>]: never };
  primary: { [K in Exclude<keyof Held<E, 'primary'>, 'conversion'>]: never };
  allocation: ClosedExperimentEntries<Held<E, 'allocation'>, 'value' | 'weight', Exclude<ExperimentListSize, 1>>;
  guardrails?: ClosedExperimentEntries<Held<E, 'guardrails'>, 'conversion' | 'maxIncrease', ExperimentListSize>;
};
/** Declare an immutable experiment epoch. Suite analytics needs separately
 * provisioned results and source delivery stores; declaring an epoch does not activate it. */
export declare function experiment<const E extends ExperimentDeclaration>(declaration: E & ClosedExperiment<E>): E;
/** The in-App assistant: a side panel where a signed-in person asks in words and is answered
 * with the App's own blocks. It reads as the person, under their grants and row policy, and every write
 * it proposes is a card the person confirms; it never has authority of its own. The model's key is the
 * operator's (`ANTHROPIC_API_KEY`), never the App's. On a tenant App it answers only for the tenants the platform
 * owner turns it on for. */
export interface AssistantDeclaration {
  /** What it is for and how it answers, appended to the platform's own rules. */
  readonly instructions?: string;
  /** Questions an empty conversation offers, each one line the person sends with a press: a bare line everywhere,
   * `{ text, views, records }` only in those views' rooms or on a record of those tables. At most six in one place. */
  readonly starters?: readonly (string | AssistantStarter)[];
  /** The model id; `'claude-sonnet-5-5'` when absent. */
  readonly model?: string;
  readonly effort?: 'low' | 'medium' | 'high';
  /** The roles offered it; absent, everyone who may open the App. */
  readonly roles?: readonly string[];
  /** The tools it may use, a narrowing of the five; absent, all of them. */
  readonly tools?: readonly ('find' | 'describe' | 'query' | 'show' | 'run')[];
  /** Verbs it may never propose, as `'resource.action'`, or `'resource.new'` for the New form. */
  readonly exclude?: readonly `${string}.${string}`[];
  /** The blocks it may draw; absent, all of them. */
  readonly blocks?: readonly ('table' | 'metric' | 'chart' | 'breakdown' | 'record')[];
  /** `'panel'` beside every room; `'record'` also takes the open record as its context; `'page'` gives it a room
   * of its own at `/{app}/assistant`, which nav places by the word `'assistant'` (at the menu's end where it does not).
   * Absent, the panel and the record. */
  readonly placement?: readonly ('panel' | 'record' | 'page')[];
  /** Token caps, counted per model call: a turn past one is refused before the model is asked. A person's day is 200,000 tokens unless `tokensPerPersonPerDay` names another figure. */
  readonly limits?: { readonly tokensPerTurn?: number; readonly tokensPerPersonPerDay?: number; readonly tokensPerDay?: number };
}
/** A starter offered in some places only: `{ text: 'Summarize this ticket', records: ['incident'] }`. Give it
 * `views`, `records` or both; a starter for everywhere is the line alone. */
export interface AssistantStarter {
  readonly text: string | AppMessageRef;
  /** View keys: offered while one of these views is the room (its list, dashboard or form). */
  readonly views?: readonly string[];
  /** Table names: offered while a record of one of these tables is open. Needs the `'record'` placement. */
  readonly records?: readonly string[];
}
/** Declare an App's assistant; identity at runtime, checked at load. */
export declare function assistant<const A extends AssistantDeclaration>(declaration: A & { [K in Exclude<keyof A, keyof AssistantDeclaration>]: never }): A;
/** Value types and names from all authored contributors; no runtime assignment. */
export type AppFlagValues<C> = { readonly [I in IdsIn<Contributed<C, 'flags'>>]: FlagReadValue<Contributed<C, 'flags'>, I> };
type FlagReadValue<F, I extends string> = F extends Record<I, infer D> ? D extends { type: 'boolean' } ? boolean
  : D extends { variants: readonly (infer V)[] } ? V | (D extends { safeValue: infer S } ? S : never)
  : D extends { type: 'string' } ? string : D extends { type: 'number' } ? number : FlagObject : never;

/** How long the runtime keeps what it writes about the App as it runs. Each window is a duration ('30 days', '12 weeks') or
 * 'forever'; a daily job forgets what is older, in small batches. A window left out is its default. */
export interface RetentionDeclaration {
  /** Who changed which record. Default '730 days'. */
  history?: string;
  /** The command journal's receipts, audit and events. Default '730 days'. */
  commands?: string;
  /** The finished tries of jobs and webhook deliveries; one pending or waiting for a redrive is never forgotten. Default '30 days'. */
  attempts?: string;
}

export interface AppConfig {
  /* A key tagged @preview works as documented and may change in any release, outside the 1.x promise
     (docs/compatibility.md); test/public-surface.test.ts holds these tags to the inventory's preview root keys. */
  /** Typed feature flags. @preview */
  flags?: Readonly<Record<string, FlagDefinition>>;
  /** Named audiences that flag rules and experiment eligibility share; see `AudienceDefinition`. @preview */
  audiences?: Readonly<Record<string, AudienceDefinition>>;
  /** Experiment epochs; see `experiment()`. @preview */
  experiments?: Readonly<Record<string, ExperimentDeclaration>>;
  /** Behavior analytics; see `AnalyticsDeclaration`. @preview */
  analytics?: AnalyticsDeclaration;
  /** The in-App assistant; see `assistant()`. */
  assistant?: AssistantDeclaration;
  /** How long the runtime keeps what it writes about the App; see `RetentionDeclaration`. */
  retention?: RetentionDeclaration;
  /* identity */
  id?: string;
  name: string;
  /* data */
  /** The one connection this App is for, by id or name. Absent means every connection. Not with `sources`. A name that is
      an identifier is also the App's one source's, as `sources: { <name>: { connection: '<name>', default: true } }` says
      it: commands name it in `defineSource('<name>')`. */
  connection?: string;
  /** Named bindings. At most one says `default: true`; several may share a connection, each with its own `schema`. */
  sources?: Record<string, AppSource>;
  /** One block per logical resource. */
  resources?: Record<string, AppResource>;
  /** Read-only resources over tables that share a shape, each listed in one order and one page: `union(...)`. */
  unions?: readonly AppUnion[];
  /* auth */
  auth?: AppAuth;
  /** What the App API and App MCP expose: resources, views, commands and events, to roles' scoped tokens. */
  api?: ApiConfig;
  /**
   * What the App's commands keep unless one says otherwise: `'none'`, `'receipts'` (a retried request is
   * answered once) or `'audit'` (the receipt and every change). A command reached through a door that retries —
   * the App API, MCP, a job, an Idempotency-Key — keeps at least receipts. Absent: nothing, for the browser's
   * own actions (`mistri docs commands`, "What a command keeps").
   */
  track?: 'none' | 'receipts' | 'audit';
  /**
   * Whether the App's open pages follow other people's changes (live sync): a list, a record and a dashboard read
   * again what a change touched, as it commits. Off unless the App says `true`; then its pages refresh on focus and
   * after their own saves, and a dashboard reads every section again each minute while it is shown. The operator's
   * `--no-live` turns it off whatever the App says. A resource leaves it with its own `live: false`.
   */
  live?: boolean;
  /** What each tenant may change about how the App looks to its people — `branding: { allow: ['logo', 'name',
      'accent'], editors: ['owner'] }` — saved by those roles in a `brandingForm()` and kept per tenant. A tenant App only. */
  branding?: AppBranding;
  /* content */
  /** Everything a visitor can open, keyed: the key is the view's address. */
  views?: Record<string, AppView>;
  /** Record pages, keyed by id, or one file per page under pages/. */
  pages?: Record<string, AppPage>;
  /** Ordered slices of content, merged at load after the App's own. */
  features?: readonly AppFeature[];
  /** Where a visitor starts. Required. */
  home: AppHome;
  /** Arrangement only: view ids, `{ to, label }`, groups, and `{ feature }` placements of a feature's fragment.
      Optional: without it the App's menu is its features' fragments in order, or none. A list view it leaves
      out is still served at its address and offered by ⌘K; a dashboard it, `home` and every embed leave out is refused. */
  nav?: readonly AppNavNode<Lowercase<string>, AppNavPlacement>[];
  /* ui */
  ui?: AppUi;
}

/* ---------- composition: features ---------- */

/** A feature's grant to a role the App declares: resources by name, within the App's ceilings, added to what the App grants. */
export interface FeatureRoleGrant<Resource extends string = string> {
  /** @preview */
  flags?: readonly FlagCapability[];
  /** @preview */
  experiments?: readonly ExperimentCapability[];
  /** May only restate an identical, explicitly declared root role realm. The App checker enforces agreement; a feature cannot introduce a realm. */
  realm?: 'tenant' | 'platform';
  read?: readonly Resource[];
  /** Within the role's reads and the App's write ceiling. */
  write?: readonly Resource[];
  commands?: readonly CommandName[];
  /** Fixed actions by resource and action id (`{ pay_run: ['submit'] }`), added to what the App grants. */
  actions?: { [T in Resource]?: readonly string[] };
  operations?: readonly ('readiness' | 'bundle' | 'workflows' | 'jobs' | 'deliveries' | 'stores' | 'analytics')[];
  fields?: { [T in Resource]?: AppRoleFieldAccess };
}

/**
 * A slice of an App's content, listed in the App's `features` and merged at
 * load: identical facts merge, conflicting ones are refused naming both
 * contributors, and view, page and nav group ids are global across the App
 * and every feature. A feature may restate a resource's binding and ceiling
 * exactly as the App states them, and grant only to the App's roles, within
 * those ceilings. The App keeps its identity, sources, sign-in, roles and ui.
 */
export interface AppFeature {
  /** @preview */
  flags?: Readonly<Record<string, FlagDefinition>>;
  /** @preview */
  audiences?: Readonly<Record<string, AudienceDefinition>>;
  /** @preview */
  experiments?: Readonly<Record<string, ExperimentDeclaration>>;
  /** @preview */
  analytics?: AnalyticsDeclaration;
  /** Lowercase letters, digits and hyphens, unique in the App: names the feature in refusals, the authority report and a nav placement.
      Lowercase<string>, like a view id, so a literal written under `satisfies` stays one for a placement to be checked against. */
  id: Lowercase<string>;
  resources?: Record<string, AppResource>;
  auth?: { roles: Record<string, FeatureRoleGrant> };
  /** Adds exposure only when the App declares api; version and roles remain root-only. */
  api?: ApiFeatureConfig;
  views?: Record<string, AppView>;
  pages?: Record<string, AppPage>;
  /** This feature's own views, arranged; the App's nav places the fragment with `{ feature: '<id>' }`. */
  nav?: readonly AppNavNode[];
  /** Rules appended after the App's, in `features` order. */
  home?: AppHome;
}

/** One locale's words, as `messages/<locale>.ts` default-exports them. */
export interface AppMessageCatalog<Locale extends string = string, Entries extends Readonly<Record<string, string | undefined>> = Readonly<Record<string, string>>> {
  readonly kind: 'messages';
  readonly locale: Locale;
  readonly entries: Entries;
}
/** The keys `msg` takes. Empty, any key (`mistri check` names one the source catalog lacks); an App narrows it to its
    source catalog's: `declare module '@mistriwork/mistri/app' { interface AppMessages extends Record<keyof typeof en.entries, string> {} }`. */
export interface AppMessages {}
export type AppMessageKey = [keyof AppMessages] extends [never] ? string : Extract<keyof AppMessages, string>;
/** The source catalog, in the App's own language: `export default defineMessages('en', { 'lead.title': 'Lead' })`.
    Text is ICU MessageFormat: `{name}`, `{n, plural, one {# lead} other {# leads}}`, `{v, select, …}`. */
export declare function defineMessages<const Locale extends string, const Entries extends Readonly<Record<string, string>>>(
  locale: Locale, entries: Entries,
): AppMessageCatalog<Locale, Entries>;
/** A translation, typed against the source: `defineMessages<typeof en>('es', { 'lead.title': 'Prospecto' })` — every key
    optional (a missing one says the source text), none new. */
export declare function defineMessages<Source extends AppMessageCatalog>(
  locale: string, entries: { readonly [K in keyof Source['entries']]?: string },
): AppMessageCatalog<string, { readonly [K in keyof Source['entries']]?: string }>;
/** Name a message where a caption goes. `args` binds an ICU argument to a column path (`{ title: 'thread_id.title' }`);
    a bare `{status}` reads the record's own column, and `{count}`, `{message}` and `{to}` are the framework's. */
export declare function msg<const Key extends AppMessageKey>(key: Key, args?: Readonly<Record<string, string>>): AppMessageRef;

/* ---------- the reference layer ----------
   `defineApp` checks the App against the keys of every contributor, its
   own and each feature's: nav, home and embed view ids, the view kinds at
   each reference, action ids — in a view's selector (queue and board only),
   a record header's `primary` and `destructive`, a role's `actions` — home roles, `resources.*.page` against the pages over that
   resource, and `{ feature }` placements against the features that bring a
   fragment. Each feature's own references are checked the same way, and its
   fragment against its own views only. Contributors stay a union, never
   merged, so the cost is linear in them. It needs no generated types, so an
   untyped app.mjs that calls `defineApp` gets it too. Merge conflicts,
   realm agreement, home openability, reachability and "once in nav" are
   the parser's. */

type Keys<M> = [M] extends [object] ? Extract<keyof M, string> : never;
type ViewsOf<C> = C extends { views: infer V } ? V : {};
type FeaturesOf<C> = C extends { features: readonly (infer F)[] } ? F : never;
/** The records every contributor declares under K, the App's own and each feature's, as a union. */
type Contributed<C, K extends string> = (C extends { [P in K]: infer R } ? Untyped<R> : never)
  | (FeaturesOf<C> extends infer F ? F extends { [P in K]: infer R } ? Untyped<R> : never : never);
/* A map typed `any` — what `Object.fromEntries` gives a map built from table lists — names any id and declares
   nothing: as a contributor it is a map of every name to an empty block. Left as `any`, it swallowed the union of
   contributors, so every feature's actions read as none and a correct header was refused. */
type Untyped<R> = 0 extends 1 & R ? { readonly [id: string]: {} } : R;
/* Both distribute over contributors. */
type IdsIn<R> = R extends object ? Extract<keyof R, string> : never;
type KindIds<R, K> = R extends object ? { [I in Extract<keyof R, string>]: R[I] extends { kind: K } ? I : never }[Extract<keyof R, string>] : never;
type ViewId<C> = IdsIn<Contributed<C, 'views'>>;
/* A views map typed `Record<string, …>` knows no ids: any id passes, as a widened string does. */
type ViewIdOf<C, K extends string> = string extends ViewId<C> ? string : KindIds<Contributed<C, 'views'>, K>;
type RoleOf<C> = C extends { auth: { roles: infer R } } ? Keys<R> : never;
type ResourcesOf<C> = C extends { resources: infer R } ? R : {};
/** The ids of a resource's actions, from every contributor that declares it. */
type MachineActionIds<R> = R extends { machine: { states: infer S } } ? S[keyof S] extends infer State ? State extends { on: infer On } ? Keys<On> : never : never : never;
type ResourceActionIds<R> = (R extends { actions: infer A } ? Keys<A> : never) | MachineActionIds<R>;
type ActionIdOf<C, T> = Contributed<C, 'resources'> extends infer R ? R extends { [P in T & string]: infer Resource } ? ResourceActionIds<Resource> : never : never;
type PageOver<C, T> = Contributed<C, 'pages'> extends infer P ? P extends object ? { [I in Keys<P>]: P[I] extends { base: T } ? I : never }[Keys<P>] : never : never;
/** The features a nav may place: those that bring a fragment. */
type NavFeature<C> = FeaturesOf<C> extends infer F ? F extends { id: infer I extends string; nav: readonly unknown[] } ? I : never : never;
/** A literal id is checked; a widened `string` (an id the checker cannot know) passes. */
type Ref<X, Allowed> = string extends X ? X : Allowed;
/* A list is judged against its references here and, when it passes, handed back as itself. The parameter then
   holds one array type where it would hold two intersected, and tsc relates a value to an intersection of two
   array types member by member as well — `map`, `flatMap` and every other generic method of both — which was
   most of a large App's reference check. A list that fails meets the check as before, and its error reads the
   same. */
type Same<X, Check> = [X] extends [Check] ? X : Check;
/** What an authored object holds under K, or nothing. */
type Held<O, K extends string> = O extends { [P in K]: infer X } ? X : never;

/* A view or a page names its roles among the App's own. */
type RoleListRefs<C, V> = V extends { roles: infer L extends readonly unknown[] } ? { roles: Same<L, readonly Ref<L[number], RoleOf<C>>[]> } : unknown;
type ViewRefs<C, V> = ViewShapeRefs<C, V> & RoleListRefs<C, V>;
type ViewShapeRefs<C, V> =
  V extends { kind: 'list'; from: infer T } & ({ presentation: { kind: 'queue' } } | { board: object }) ? { actions?: Same<Held<V, 'actions'>, readonly Ref<ActionIdOf<C, T>, ActionIdOf<C, T>>[]> }
  : V extends { kind: 'list' } ? { actions?: never }
  : V extends { kind: 'dashboard' } ? { sections: Same<Held<V, 'sections'>, readonly (Exclude<AppDashSection, FindDashSection> | FindDashSection<IdsIn<Contributed<C, 'resources'>>> | { kind: 'view'; view: ViewIdOf<C, 'list'> })[]> }
  : V extends { kind: 'landing' } ? { hero: { actions: Same<Held<Held<V, 'hero'>, 'actions'>, readonly LandingAction<PublicFormIdOf<C> | ViewIdOf<C, 'list' | 'dashboard'>>[]> } }
  : unknown;

/* A record header names its verbs by id, each one of the page's base resource's actions. Only a page with a
   header is judged, and only its header: every other section is held to its own kind, which it already is. */
type SectionOf<P> = Held<P, 'sections'> extends readonly (infer E)[] ? E : never;
type SectionIds<E, Ids> = E extends { kind: 'header' }
  ? { kind: 'header'; primary?: Ref<Held<E, 'primary'>, Ids>; destructive?: readonly Ref<Held<E, 'destructive'> extends readonly (infer D)[] ? D : never, Ids>[] }
  : { kind: Exclude<Held<E, 'kind'>, 'header'> };
/* Valid headers need only a check of their names. Rebuilding the section union
   also relates every unrelated section and every array method on each page. */
type HeaderNames<E> = E extends { kind: 'header' }
  ? (string extends Held<E, 'primary'> ? never : Held<E, 'primary'>)
    | (Held<E, 'destructive'> extends readonly (infer D)[] ? string extends D ? never : D : never)
  : never;
type PageRefs<C, P> = PageHeaderRefs<C, P> & RoleListRefs<C, P>;
type PageHeaderRefs<C, P> = [HeaderNames<SectionOf<P>>] extends [never] ? unknown
  : [HeaderNames<SectionOf<P>>] extends [ActionIdOf<C, Held<P, 'base'>>] ? unknown
    : { sections: Same<Held<P, 'sections'>, readonly SectionIds<SectionOf<P>, ActionIdOf<C, Held<P, 'base'>>>[]> };
type PagesOf<C> = C extends { pages: infer P } ? P : {};
/* A role runs fixed actions by id, each one of that resource's. */
type RoleRefs<C, G> = (G extends { actions: infer A } ? { actions: { [T in Keys<A>]: Same<A[T], readonly Ref<A[T] extends readonly (infer I)[] ? I : never, ActionIdOf<C, T>>[]> } } : unknown)
  & (G extends { flags: readonly unknown[] } ? { flags: readonly CapabilityRef<C, Held<G, 'flags'>[number], 'flags'>[] } : unknown)
  & (G extends { experiments: readonly unknown[] } ? { experiments: readonly CapabilityRef<C, Held<G, 'experiments'>[number], 'experiments'>[] } : unknown);
type FlagOwner<F> = F extends object ? F[keyof F] extends { owner: infer O } ? O : never : never;
type CapabilityRef<C, E, K extends 'flags' | 'experiments'> = E & {
  ids?: readonly IdsIn<Contributed<C, K>>[];
  owners: readonly FlagOwner<Contributed<C, 'flags'>>[];
} & { [P in Exclude<keyof E, keyof FlagCapability>]: never };
type FlagRefs<X> = X extends { flags: infer F } ? { [I in Keys<F>]: { [K in Exclude<keyof F[I], keyof FlagDefinition>]: never } } : unknown;
type ExperimentRefs<C, X> = X extends { experiments: infer E } ? { [I in Keys<E>]: I extends IdsIn<Contributed<C, 'flags'>> ? E[I] & ClosedExperiment<E[I]> & {
  control: FlagReadValue<Contributed<C, 'flags'>, I>;
  allocation: readonly { value: FlagReadValue<Contributed<C, 'flags'>, I>; weight: number }[];
  eligibility: { audiences?: readonly IdsIn<Contributed<C, 'audiences'>>[] };
} : never } : unknown;
type AudienceRefs<C, X> = X extends { audiences: infer A } ? { [I in Keys<A>]: A[I] & { [K in Exclude<keyof A[I], keyof AudienceDefinition>]: never } & {
  roles?: readonly RoleOf<C>[];
} } : unknown;
type RolesOf<C> = C extends { auth: { roles: infer R } } ? R : {};

/* A form is public only when it says `public: true`; any other form is a room nav may name.
   Like KindIds, it distributes over contributors: a feature's forms count too. */
type FormIds<R, Public extends boolean> = R extends object ? { [I in Extract<keyof R, string>]: R[I] extends { kind: 'form'; public: true }
  ? (Public extends true ? I : never) : R[I] extends { kind: 'form' } ? (Public extends true ? never : I) : never }[Extract<keyof R, string>] : never;
type PublicFormIdOf<C> = string extends ViewId<C> ? string : FormIds<Contributed<C, 'views'>, true>;
type SignedInFormIdOf<C> = string extends ViewId<C> ? string : FormIds<Contributed<C, 'views'>, false>;
/* The assistant's own room, by its word, where the App gives it one (`assistant({ placement: [..., 'page'] })`). */
type AssistantRoomOf<C> = C extends { assistant: { placement: readonly (infer P)[] } } ? ('page' extends P ? 'assistant' : never) : never;
type NavRef<C> = AppNavNode<ViewIdOf<C, 'list' | 'dashboard'> | SignedInFormIdOf<C> | AssistantRoomOf<C>, AppNavPlacement<NavFeature<C>>>;
/* An id typed wide — `string`, or the `Lowercase<string>` an annotation such as
   `const nav: NonNullable<App['nav']>` gives — is one the checker cannot know:
   it passes, and the parser judges it at load. */
type Wide<X> = [X] extends [never] ? false : string extends X ? true : Lowercase<string> extends X ? true : false;
type ApiViewName<V> = V extends string ? V : V extends { view: infer I } ? I : never;
type ApiViewRef<C, V> = V extends string ? Ref<V, ViewIdOf<C, 'list'>> : V & { view: Ref<ApiViewName<V>, ViewIdOf<C, 'list'>> };
type ApiRefs<C, X> = X extends { api: infer A } ? {
  roles?: A extends { roles: infer L extends readonly unknown[] } ? Same<L, readonly Ref<L[number], RoleOf<C>>[]> : unknown;
  views?: A extends { views: infer L extends readonly unknown[] } ? Same<L, readonly ApiViewRef<C, L[number]>[]> : unknown;
  resources?: A extends { resources: infer R } ? Wide<Keys<R>> extends true ? unknown
    : { [K in Keys<R>]: K extends Keys<ResourcesOf<C>> ? unknown : never } : unknown;
} : unknown;
type NavLeaf<N> = N extends string ? N : N extends { view: infer V } ? V : N extends { children: readonly (infer K)[] } ? NavLeaf<K> : never;
type HomeLeaf<H> = H extends string ? H : H extends readonly (infer R)[] ? (R extends { view: infer V } ? V : never) : never;

type HomeRefs<C, X> = X extends { home: infer H } ? (Wide<HomeLeaf<H>> extends true ? unknown : Same<H, ViewId<C> | PagePath | readonly AppHomeRule<ViewId<C> | PagePath, RoleOf<C>>[]>) : unknown;
/** A fragment names only its feature's own views, of the kinds nav takes, and places nothing. */
type FragmentRefs<F> = F extends { nav: infer L extends readonly unknown[] } ? (Wide<NavLeaf<L[number]>> extends true ? unknown : Same<L, readonly AppNavNode<ViewIdOf<F, 'list' | 'dashboard'>>[]>) : unknown;
/** One feature's references, judged where every contributor is known. */
type FeatureRefs<C, F> = {
  flags?: FlagRefs<F>;
  audiences?: AudienceRefs<C, F>;
  experiments?: ExperimentRefs<C, F>;
  api?: ApiRefs<C, F> & { version?: never; roles?: never; publicSpec?: never; network?: never; description?: never };
  views?: { [I in Keys<ViewsOf<F>>]: ViewRefs<C, ViewsOf<F>[I]> };
  pages?: { [I in Keys<PagesOf<F>>]: PageRefs<C, PagesOf<F>[I]> };
  auth?: { roles?: { [R in Keys<RolesOf<F>>]: RoleRefs<C, RolesOf<F>[R]> } };
  resources?: { [T in Keys<ResourcesOf<F>>]?: { page?: PageOver<C, T> } };
  home?: HomeRefs<C, F>;
  nav?: FragmentRefs<F>;
};
/* Every listed feature together with its own references, distributed over the features rather than
   mapped over the list: a list built beforehand is an array, not a tuple. An element must be one
   feature with that feature's references, and literal ids keep two features from standing in for each other. */
type FeatureChecked<C, F> = F extends unknown ? F & FeatureRefs<C, F> : never;

/* A preset is a built-in theme or one the App registers in `ui.customThemes`; the
   runtime refuses anything else at load, so the editor refuses it first. */
type CustomThemeIds<C> = C extends { ui: { customThemes: readonly (infer T)[] } } ? T extends { id: infer I extends string } ? I : never : never;
type ThemeRefs<C> = { theme?: C extends { ui: { theme: { kind: 'fromRecord' } } }
  ? { from: IdsIn<Contributed<C, 'resources'>> }
  : { preset?: import('@mistriwork/engine/schema/theme.js').ThemeBase | CustomThemeIds<C>; for?: ThemeForRefs<C> } };
/* A theme per audience names the App's looks, and its roles are the App's own. */
type ThemeForRefs<C> = {
  public?: import('@mistriwork/engine/schema/theme.js').ThemeBase | CustomThemeIds<C>;
  roles?: C extends { ui: { theme: { for: { roles: infer M } } } }
    ? { [R in Keys<M>]: R extends RoleOf<C> ? import('@mistriwork/engine/schema/theme.js').ThemeBase | CustomThemeIds<C> : never }
    : Partial<Record<RoleOf<C>, import('@mistriwork/engine/schema/theme.js').ThemeBase | CustomThemeIds<C>>>;
};

/* A shell drawn on top by role names the App's own roles. */
type ShellRefs<C> = C extends { ui: { shell: { placement: { top: infer L extends readonly unknown[] } } } }
  ? { shell: { placement: { top: Same<L, readonly Ref<L[number], RoleOf<C>>[]> } } } : unknown;

export type AppRefs<C> = {
  flags?: FlagRefs<C>;
  audiences?: AudienceRefs<C, C>;
  experiments?: ExperimentRefs<C, C>;
  api?: ApiRefs<C, C>;
  ui?: ThemeRefs<C> & ShellRefs<C>;
  nav?: C extends { nav: infer L extends readonly unknown[] } ? (Wide<NavLeaf<L[number]>> extends true ? unknown : Same<L, readonly NavRef<C>[]>) : unknown;
  home?: HomeRefs<C, C>;
  views?: { [I in Keys<ViewsOf<C>>]: ViewRefs<C, ViewsOf<C>[I]> };
  pages?: { [I in Keys<PagesOf<C>>]: PageRefs<C, PagesOf<C>[I]> };
  auth?: { roles?: { [R in Keys<RolesOf<C>>]: RoleRefs<C, RolesOf<C>[R]> } };
  resources?: { [T in Keys<ResourcesOf<C>>]?: { page?: PageOver<C, T> } & ResourceGuard<T, ResourcesOf<C>[T]> };
  features?: Same<Held<C, 'features'>, readonly FeatureChecked<C, FeaturesOf<C>>[]>;
};

/* A `const` type parameter keeps an authored literal's names — a table, a
   column, a view id — as literal types, which is what both layers check; it
   also marks every property readonly, which the value never was.
   `Authored` hands the literals back mutable, the way the object was written,
   and a tuple stays a tuple: a queue's `lines` written as two names must still
   read as those two names where the App lists the view. */
type Authored<T> = T extends readonly unknown[] ? { -readonly [K in keyof T]: Authored<T[K]> }
  : T extends object ? { -readonly [K in keyof T]: Authored<T[K]> } : T;

/** An identity that carries the types: the editor checks, the value passes through. */
export declare function defineApp<const C extends AppConfig>(app: C & AppRefs<C>): Authored<C>;
/* What a feature can check alone: its fragment, and that it says nothing that is the App's. Its
   embeds, selectors, calls to action, pages and home are checked by defineApp, where every feature is known. */
type FeatureLocalRefs<F> = {
  api?: { version?: never; roles?: never; publicSpec?: never; network?: never; description?: never };
  /* Its resources' conditions are read against their tables here, where the feature is whole; the App's check does not read them again. */
  resources?: { [T in Keys<ResourcesOf<F>>]?: ResourceGuard<T, ResourcesOf<F>[T]> };
  nav?: FragmentRefs<F>;
  name?: never; connection?: never; sources?: never; ui?: never; features?: never;
  auth?: { providers?: never; signUp?: never; store?: never; defaultRole?: never; rows?: never; tenancy?: never };
};
/** A feature, typed like an App: an identity that carries the types; the value passes through. */
/* Handed back as inferred — readonly, not through `Authored` — because the App lists it and `satisfies App` judges
   each feature again: its views, pages and sections are then the very types `satisfies Feature` judged here, and
   tsc answers from its cache. A remapped copy was judged from scratch, which at 150 tables was most of app.ts. */
export declare function defineFeature<const F extends AppFeature>(feature: F & FeatureLocalRefs<F>): F;
/** Explicit integration exposure; runtime checks references and authority. */
export interface ApiExposureOptions<Field extends string = string> {
  filters?: readonly Field[];
  sorts?: readonly Field[];
  description?: string;
  /** Generic writes, each a command the platform defines on the command routes
      (`create-<resource>`, `update-<resource>`, `delete-<resource>`), held to the
      token's roles' own editor rules. Absent: the resource is read-only to the API. */
  create?: true;
  update?: true;
  delete?: true;
}
export interface ApiResourceExposure<Field extends string = string> extends ApiExposureOptions<Field> {
  fields: readonly Field[];
}
export interface DraftApiConfig {
  version: number;
  roles: readonly string[];
  /** Serve the OpenAPI document at `…/$openapi` without a token: every declared operation, without roles or
      standing queries. Absent or false, each token reads its own narrowed document. */
  publicSpec?: boolean;
  /** Answer beyond loopback when the server listens there (`--host`, `--allowed-host`, `--trust-proxy`), to scoped
      bearer tokens only. Absent, the API and its MCP endpoint answer loopback only. Recorded in authority.lock. */
  network?: boolean;
  description?: string;
  resources?: Readonly<Record<string, ApiResourceExposure>>;
  views?: readonly (string | { view: string; label?: string; description?: string })[];
  commands?: readonly (CommandName | { command: CommandName; label?: string; description?: string })[];
  /** The commands' events the event feed (`…/v{n}/$events`) serves, each its own token operation
      (`event:<name>`); a token sees an event only about a record its roles read. Absent: no feed. */
  events?: readonly string[];
}
/** Active contract: ordinary single-source SQL read metadata, plus commands
 * served beside their `--commands` registry: one on a record at
 * `…/{resource}/{key}/commands/{name}/v{n}`, and a signed-in form's command,
 * which names no record, at `…/{resource}/commands/{name}/v{n}` with an
 * `Idempotency-Key` and no `If-Match`. An API declaration does not itself
 * serve routes or grant access. */
export interface ApiConfig extends Omit<DraftApiConfig, 'commands'> {
  commands?: readonly (CommandOn | FormCommandName<false> | { command: CommandOn | FormCommandName<false>; label?: string; description?: string })[];
}
export type ApiFeatureConfig = Pick<ApiConfig, 'resources' | 'views' | 'commands' | 'events'>;
/** Expose explicit fields: what a token reads, and with `create`, `update` or
 * `delete` what it writes through the generic write commands. Filters and sorts must be in fields. */
export declare function expose<const F extends readonly [string, ...string[]], const O extends ApiExposureOptions<F[number]> = {}>(
  fields: F, options?: O & Record<Exclude<keyof O, keyof ApiExposureOptions>, never>,
): Authored<O> & { fields: F };

/** Everything a command form takes beside its label, command and steps. */
export type CommandFormOptions = Omit<AppFormView, Made | 'kind' | 'label' | 'command' | 'steps'>;
/** A command form view: `views: { 'log-call': commandForm('Log a call', 'logCall', [step('The call', ['account', 'notes'])], { done }) }`,
    or `commandForm('Apply for financing', 'applyForFinancing', steps, { public: true })` for one served signed out.
    The command is named; its steps' field names are its input names, checked in the editor against the generated
    mistri-commands.d.ts; without steps the form is one page. */
export declare function commandForm<const Name extends FormCommandName, const O extends CommandFormOptions & Required<Pick<AppFormView, 'resume' | 'draft'>>>(
  label: string | AppMessageRef, submit: Name, steps: readonly SavedFormStep[], opts: O,
): AppFormView<string> & { kind: 'form'; command: Name } & Authored<O>;
export declare function commandForm<const Name extends FormCommandName, const O extends CommandFormOptions = {}>(
  label: string | AppMessageRef, command: Name, steps?: readonly FormStep<CommandInputName<Name>>[], opts?: O,
): AppFormView<CommandInputName<Name>> & { kind: 'form'; command: Name } & Authored<O>;
export declare function commandForm<const Name extends FormCommandName, const O extends CommandFormOptions = {}>(
  label: string | AppMessageRef, command: Name, opts: O,
): AppFormView<CommandInputName<Name>> & { kind: 'form'; command: Name } & Authored<O>;
/** One step of a multi-step form: `label` is its caption in the stepper, and the id is the label's slug unless given
    (a `msg()` label's key's slug, the same in every language). */
export declare function step<const F extends string>(label: string | AppMessageRef, fields: readonly (F | readonly F[])[], opts?: StepOptions): FormStep<F>;
/** A step of a form saved on every step: it asks the named command's inputs, and its handler saves them. */
export declare function step(label: string | AppMessageRef, command: FormCommandName<true>, opts?: Omit<StepOptions, 'skip'>): SavedFormStep;
/** What `step()` takes beside its label and fields: the id, and the intake style's words. */
export interface StepOptions {
  id?: string;
  /** The step's heading in the intake style (at most 160 characters); absent, the label. */
  title?: string | AppMessageRef;
  /** One sentence under the title (at most 500 characters). */
  lead?: string | AppMessageRef;
  /** The primary's words on this step (at most 40 characters); absent, "Continue". */
  next?: string | AppMessageRef;
  /** The primary's words while every field here is empty (at most 40 characters): "Skip". */
  skip?: string | AppMessageRef;
}

/** The landing view — `landing(hero('Finance your next car', [applyTo('finance', 'Apply')]), [steps('How it works', [...])])`; it wears the App's `ui.footer`.
    Requires `auth`; content only, plain text only. With no `applyTo`, only `signIn()`, it names no form (`Form` is `never`),
    so it fits any App's typed views from its own module. */
export declare function landing<const Form extends string = never>(hero: LandingHero<Form>, sections?: readonly LandingSection<Form>[],
  opts?: Omit<AppLandingView, Made | 'kind' | 'hero' | 'sections'>): AppLandingView<Form> & { kind: 'landing' };
/** The top of the landing: the page's one heading, an optional description line, and one to three calls to action. */
export declare function hero<const Form extends string = never>(heading: string | AppMessageRef, actions: readonly LandingAction<Form>[], opts?: LandingHeroOptions): LandingHero<Form>;
export declare function hero<const Form extends string = never>(heading: string | AppMessageRef, description: string | AppMessageRef | undefined, actions: readonly LandingAction<Form>[], opts?: LandingHeroOptions): LandingHero<Form>;
/** A call to action that opens a public form view at `/{app}/form/{key}` — `applyTo('finance', 'Apply for financing')`. */
export declare function applyTo<const View extends string>(view: View, label: string | AppMessageRef, intent?: LandingActionIntent): { label: string | AppMessageRef; to: View; intent?: LandingActionIntent };
/** A call to action that opens staff sign-in at `/{app}/sign-in` — `signIn('Staff sign in', 'secondary')`. */
export declare function signIn(label: string | AppMessageRef, intent?: LandingActionIntent): { label: string | AppMessageRef; signIn: true; intent?: LandingActionIntent };
/** Landing section: up to six short points, each a title and a sentence or two. */
export declare function features(items: readonly LandingItem[]): FeaturesSection;
export declare function features(title: string | AppMessageRef | undefined, items: readonly LandingItem[]): FeaturesSection;
/** Landing section: up to six numbered steps. Not `step()`, which is one page of a multi-step form. */
export declare function steps(items: readonly LandingItem[]): StepsSection;
export declare function steps(title: string | AppMessageRef | undefined, items: readonly LandingItem[]): StepsSection;
/** Landing section: up to twelve questions, each drawn as a disclosure that opens to its answer. */
export declare function faq(items: readonly LandingQuestion[]): FaqSection;
export declare function faq(title: string | AppMessageRef | undefined, items: readonly LandingQuestion[]): FaqSection;
/** Landing section: up to eight https://, mailto: or tel: links — `contact('Contact', [{ label: 'Email us', href: 'mailto:hello@example.test' }])`. */
export declare function contact(items: readonly LandingLink[]): ContactSection;
export declare function contact(title: string | AppMessageRef | undefined, items: readonly LandingLink[]): ContactSection;
/** Landing section: a titled closing prompt with one to three calls to action. */
export declare function callToAction<const Form extends string = string>(title: string | AppMessageRef, actions: readonly LandingAction<Form>[]): CallToActionSection<Form>;
export declare function callToAction<const Form extends string = string>(title: string | AppMessageRef, description: string | AppMessageRef | undefined, actions: readonly LandingAction<Form>[]): CallToActionSection<Form>;
/** Landing section: up to 2,000 characters of prose; the title may be left out. */
export declare function text(text: string | AppMessageRef): TextSection;
export declare function text(title: string | AppMessageRef | undefined, text: string | AppMessageRef): TextSection;
/** Landing section: a search over a list view, one to six of its own `filters`, submitted as that list's conditions. */
export declare function search<const V extends string>(
  view: V, filters: readonly string[], opts?: Pick<LandingSearchSection, 'title' | 'submitLabel'>,
): LandingSearchSection & { view: V };
/* An update's columns ride a phantom key: a type the schema-typed layer can read and no JSON ever holds. A `set`
   written in a literal is checked by its excess keys; one handed back by `action()` is not fresh, so without this
   `{ status: 'closed', closedd_at: … }` would pass for its one good column. Declared only — never a value. */
declare const setColumns: unique symbol;
/** A fixed update's `set` as `action()` returns it: the written values, and its column names kept for the check. */
export type ActionSet<Set> = { -readonly [K in keyof Set]: Set[K] } & { readonly [setColumns]?: keyof Set };
/** A resource action: a fixed update, or a command by its name. The label stays a literal, so a view's selector is checked against it;
    so do the columns an update sets and asks a reason in, and the command it names, so `resources.<table>.actions` checks them
    against that table. */
export declare function action<const L extends string | AppMessageRef, const Name extends CommandOn>(
  label: L, options: Omit<CommandAction<Name>, 'label' | 'command' | 'bulk'> & { command: Name;
    /** Offered for a queue selection only when the command declares `targets: 'many'`. */
    bulk?: TakesMany<Name> extends true ? boolean : false },
): CommandAction<Name, L> & MadeBy<'action'>;
export declare function action<const L extends string | AppMessageRef, const O extends Omit<AppUpdateAction, 'id' | 'label' | 'set'> & { set: Readonly<Record<string, ActionSetValue>> }>(
  label: L, options: O & Record<Exclude<keyof O, Exclude<keyof AppUpdateAction, 'id'>>, never>,
): NoInfer<Omit<AppUpdateAction<L>, 'id' | 'set' | 'reason' | 'when'> & Authored<Omit<O, 'set'>> & { set: ActionSet<O['set']> } & MadeBy<'action'>>;
export type { Theme, ThemeBase, ThemeColors, ThemeColorsOver, ThemePalette, ThemePaletteVariant, ThemeRecipes, ThemeSpec } from '@mistriwork/engine/schema/theme.js';
/** An OpenID Connect provider for `auth.providers`: `oidc('workforce')` signs in through the config file's entry
    of kind "oidc" named "workforce" (issuer, client id, the secret's environment variable). `oidc.tenants()` is each
    tenant's own provider in a tenant App, found by the domain of the email a person types. */
export declare const oidc: {
  <const Name extends string>(name: Name): `oidc:${Name}`;
  tenants(): 'oidc:*';
};
/** A SAML 2.0 identity provider for `auth.providers`: `saml('okta')` signs in through the config file's entry of kind
    "saml" named "okta" (entity id, sign-in URL, signing certificates). `saml.tenants()` is each tenant's own provider
    in a tenant App, found by the domain of the email a person types. */
export declare const saml: {
  <const Name extends string>(name: Name): `saml:${Name}`;
  tenants(): 'saml:*';
};
/** A theme: colors by purpose for light and dark, shape, type, density and a pick from the closed recipe menu. `extends` starts from a built-in look. Register it in `ui.customThemes` and name it by its id, `ui.theme: { preset: 'harbor' }`, as a built-in is named. */
export declare function defineTheme<const S extends import('@mistriwork/engine/schema/theme.js').ThemeSpec>(theme: S): import('@mistriwork/engine/schema/theme.js').Theme<S>;

/* ---------- the helpers ----------
   Pure data constructors returning exactly the JSON they stand for. Their
   value is here, in the types: each section kind gets its own narrowed
   signature, so a `compare` on a list is an editor error rather than a
   startup refusal. All deletable — the plain object always works.

   Positional arguments are generic so their literals survive into the
   return type — that is what lets `satisfies TypedDashboardView<Tables>`
   catch a mistyped table through a helper call, not only through a literal.
   A bare column given in opts (`over`) rides a generic of its own for the
   same reason; absent, it is `never`, which every typed column accepts.
   `NoInfer` keeps a contextual return type — a section written inline in
   `dashboard([...])` — from widening that literal back to string. The
   helpers that build what the schema-typed layer checks name by name wrap
   their whole return in it: inferring their literals back from a
   `satisfies Pages` or `Views` would walk every path union of every table
   for each call, which cost Compass a second of typecheck for one page. */

/* ---------- computed columns ---------- */

/** A resource's computed column: `computed.boolean('due_on < today and not completed')`, `computed.number('today -
    opened_on')`, `computed.date('ends_on + term months')`. The expression's columns are judged by `mistri check`,
    which names the column and where it stands; its name and type reach the generated types. */
export declare const computed: {
  boolean<const V extends string>(value: V): { type: 'boolean'; value: V };
  number<const V extends string>(value: V): { type: 'number'; value: V };
  date<const V extends string>(value: V): { type: 'date'; value: V };
};

/* ---------- rollups: one number about the rows that point at a record ---------- */

/** A rollup counting the `from` rows that point at the record: `count('task', { query: 'status = open' })`. */
export declare function count<const F extends string, const O extends Pick<AppRollup, 'whose' | 'query' | 'segment'> & QueryGuard<F, O> = {}>(
  from: F, opts?: O,
): NoInfer<{ fn: 'count'; from: F } & Authored<O>>;
/** A rollup summing a column of the `from` rows that point at the record: `sum('order_line', 'amount')`. */
export declare function sum<const F extends string, const C extends string, const O extends Pick<AppRollup, 'whose' | 'query' | 'segment'> & QueryGuard<F, O> = {}>(
  from: F, column: RollupColumn<F, 'sum', C>, opts?: O,
): NoInfer<{ fn: 'sum'; from: F; column: C } & Authored<O>>;
/** A rollup: the least value of a column of the `from` rows — `min('invoice', 'due_on', { query: 'status = open' })`. */
export declare function min<const F extends string, const C extends string, const O extends Pick<AppRollup, 'whose' | 'query' | 'segment'> & QueryGuard<F, O> = {}>(
  from: F, column: RollupColumn<F, 'min', C>, opts?: O,
): NoInfer<{ fn: 'min'; from: F; column: C } & Authored<O>>;
/** A rollup: the greatest value of a column of the `from` rows — `max('activity', 'happened_on')`. */
export declare function max<const F extends string, const C extends string, const O extends Pick<AppRollup, 'whose' | 'query' | 'segment'> & QueryGuard<F, O> = {}>(
  from: F, column: RollupColumn<F, 'max', C>, opts?: O,
): NoInfer<{ fn: 'max'; from: F; column: C } & Authored<O>>;
/** A rollup: a column of the newest `from` row — `latest('payment', 'status')`, the order's payment status, read
    where it is written rather than copied onto the order. Newest by its key, or by `sort`, a date or a number. */
export declare function latest<const F extends string, const C extends string, const O extends Pick<AppRollup, 'whose' | 'query' | 'segment' | 'sort'> & QueryGuard<F, O> = {}>(
  from: F, column: RollupColumn<F, 'latest', C>, opts?: O,
): NoInfer<{ fn: 'latest'; from: F; column: C } & Authored<O>>;

/** The day the form opens, on a date column: `defaults: { due_on: today }`. */
export declare const today: AutoValue<'today'>;
/** The moment — when the form opens, or when a fixed action's write lands: `set: { resolved_at: now }`. */
export declare const now: AutoValue<'now'>;
/** The signed-in person: their row on a reference to `auth.me`'s table, their email on a text column. */
export declare const me: AutoValue<'me'>;

type SectionOpts<Sec, Positional extends keyof Sec, Over extends string> = Omit<Sec, Made | 'kind' | 'title' | 'from' | 'over' | Positional> & { over?: Over };
/* A metric and a breakdown are one helper each, on a dashboard and on a page: given `whose` (a page's), the
   rows come `from` the table and point at the record, and the section is the page's kind; without it, they are
   the dashboard's whole table. Two overloads, so each place is checked against its own fields. */
type PageMetricOpts = Omit<MetricSection, Made | 'kind' | 'title' | 'from'>;
/** A dashboard metric — one number over a table, with `compare` for a delta: `metric('Won', 'opportunity', { query: 'stage = won' })`. */
export declare function metric<T extends string, Over extends string = never, const O extends Omit<SectionOpts<MetricDashSection, never, Over>, 'over'> = {}>(
  title: string | AppMessageRef, from: T & NoInfer<SourceGuard<T>>,
  opts?: O & NoInfer<MetricGuard<T, O>> & { over?: Over } & Record<Exclude<keyof O, keyof SectionOpts<MetricDashSection, never, Over>>, never>,
): MetricDashSection & { from: QueryTable<T>; over?: NoInfer<Over> };
/** A page metric — how many `from` rows point at this record, or `measure` over them: `metric('Open balance',
    'invoice', { whose: 'customer_id', measure: 'sum total', query: 'status = open' })`. `whose` may be a path
    several references long (`'invoice_id.customer_id'`). */
export declare function metric<const F extends string, const O extends PageMetricOpts & MetricGuard<F, O>>(
  title: string | AppMessageRef, from: F & NoInfer<SourceGuard<F>>, opts: O,
): NoInfer<{ kind: 'metric'; readonly [madeBy]: 'metric'; title: string | AppMessageRef; from: QueryTable<F> } & Authored<O>>;
/** A dashboard chart — a line over a bucketed by, a donut over categories: `chart('Bookings', 'opportunity', 'month close_date')`.
    `auto close_date` picks the unit from the window. */
export declare function chart<T extends string, const By extends string, Over extends string = never, const O extends Omit<SectionOpts<ChartDashSection, 'by', Over>, 'over'> = {}>(
  title: string | AppMessageRef, from: T & NoInfer<SourceGuard<T>>, by: GroupBy<T, By>,
  opts?: O & NoInfer<QueryGuard<T, O>> & { over?: Over } & Record<Exclude<keyof O, keyof SectionOpts<ChartDashSection, 'by', Over>>, never>,
): ChartDashSection & { from: QueryTable<T>; over?: NoInfer<Over> };
/** A page chart — the `from` rows pointing at this record, measured and drawn:
    `chart('Billed by month', 'invoice', 'month issued_on', { whose: 'customer_id', measure: 'sum total' })`. */
export declare function chart<const F extends string, const By extends string,
  const O extends Omit<ChartSection, Made | 'kind' | 'title' | 'from' | 'by'> & QueryGuard<F, O>>(
  title: string | AppMessageRef, from: F & NoInfer<SourceGuard<F>>, by: GroupBy<F, By>, opts: O,
): NoInfer<{ kind: 'chart'; readonly [madeBy]: 'chart'; title: string | AppMessageRef; from: QueryTable<F>; by: By } & Authored<O>>;
/** A dashboard breakdown — ranked bars over a table: `breakdown('Pipeline', 'opportunity', 'stage', { measure: 'sum amount' })`. */
export declare function breakdown<T extends string, const By extends string, Over extends string = never, const O extends Omit<SectionOpts<BreakdownDashSection, 'by', Over>, 'over'> = {}>(
  title: string | AppMessageRef, from: T & NoInfer<SourceGuard<T>>, by: GroupBy<T, By>,
  opts?: O & NoInfer<QueryGuard<T, O>> & { over?: Over } & Record<Exclude<keyof O, keyof SectionOpts<BreakdownDashSection, 'by', Over>>, never>,
): BreakdownDashSection & { from: QueryTable<T>; over?: NoInfer<Over> };
/** A page breakdown — how many `from` rows point at this record, grouped: `breakdown('Issue status', 'issue', 'status', { whose: 'project_id' })`. */
export declare function breakdown<const F extends string, const By extends string,
  const O extends Omit<BreakdownSection, Made | 'kind' | 'title' | 'from' | 'by'> & QueryGuard<F, O>>(
  title: string | AppMessageRef, from: F & NoInfer<SourceGuard<F>>, by: GroupBy<F, By>, opts: O,
): NoInfer<{ kind: 'breakdown'; readonly [madeBy]: 'breakdown'; title: string | AppMessageRef; from: QueryTable<F>; by: By } & Authored<O>>;
/** A dashboard's rows — the newest or matching rows of a table, projected: `rows('Closing soon', 'opportunity', { show, sort, limit })`. */
export declare function rows<T extends string, Over extends string = never, const O extends Omit<SectionOpts<RowsDashSection, never, Over>, 'over'> = {}>(
  title: string | AppMessageRef, from: T & NoInfer<SourceGuard<T>>,
  opts?: O & NoInfer<QueryGuard<T, O>> & { over?: Over },
): NoInfer<{ kind: 'rows'; readonly [madeBy]: 'rows'; title: string | AppMessageRef; from: QueryTable<T>; over?: NoInfer<Over> } & Authored<O>>;
/** The author speaking — on a dashboard or on a record's page: `note('Call within a day.', { title: 'Next step' })`.
    A plain note stands in either; a banner is a dashboard's, and `quiet` and `callout` are a page's. */
export declare function note(
  text: string | AppMessageRef, opts?: Omit<NoteDashSection, Made | 'kind' | 'text' | BannerOnly>,
): Omit<NoteDashSection, BannerOnly>;
export declare function note(
  text: string | AppMessageRef, opts?: Omit<NoteDashSection, Made | 'kind' | 'text'>,
): NoteDashSection;
export declare function note(
  text: string | AppMessageRef, opts: Omit<NoteSection, Made | 'kind' | 'text'>,
): NoteSection;
/** A new App's first steps: `firstRun('Welcome to Compass', [{ label: 'Add your first account', to: 'accounts' }], { description })`. */
export declare function firstRun<const V extends string>(
  title: string | AppMessageRef, steps: readonly FirstRunStep<V>[], opts?: Pick<FirstRunDashSection, 'description'>,
): NoInfer<{ kind: 'firstRun'; readonly [madeBy]: 'firstRun'; title: string | AppMessageRef; steps: readonly FirstRunStep<V>[] } & Pick<FirstRunDashSection, 'description'>>;
export declare function matrix<T extends string, const By extends string, Over extends string = never, const O extends Omit<SectionOpts<MatrixDashSection, 'by', Over>, 'over'> = {}>(
  title: string | AppMessageRef, from: T, by: GroupBy<T, By>,
  opts?: O & NoInfer<QueryGuard<T, O>> & { over?: Over } & Record<Exclude<keyof O, keyof SectionOpts<MatrixDashSection, 'by', Over>>, never>,
): MatrixDashSection & { from: T; over?: NoInfer<Over> };
export declare function funnel<T extends string, Over extends string = never, const O extends Omit<SectionOpts<FunnelDashSection, 'stages', Over>, 'over'> = {}>(
  title: string | AppMessageRef, from: T & NoInfer<SourceGuard<T>>, stages: readonly FunnelStage[],
  opts?: O & NoInfer<QueryGuard<T, O>> & { over?: Over } & Record<Exclude<keyof O, keyof SectionOpts<FunnelDashSection, 'stages', Over>>, never>,
): FunnelDashSection & { from: T; over?: NoInfer<Over> };
export declare function board<T extends string, By extends string, Over extends string = never,
  const O extends Omit<SectionOpts<BoardDashSection, 'by', Over>, 'over'> = {}>(
  title: string | AppMessageRef, from: T, by: By,
  opts?: O & NoInfer<QueryGuard<T, O>> & { over?: Over },
): NoInfer<{ kind: 'board'; readonly [madeBy]: 'board'; title: string | AppMessageRef; from: T; by: NoInfer<By>; over?: NoInfer<Over> } & Authored<O>>;
/* Generic over its sections so their literal table types survive into
   the return — a dashboard built from helpers stays assignable to
   TypedDashboardView<Tables> instead of widening to plain strings. */
export declare function dashboard<const Sec extends AppDashSection | AppViewDashSection, T extends string = never,
  const Aside extends readonly (AppDashSection | AppViewDashSection)[] | undefined = undefined, const F extends readonly string[] = readonly [],
  const Ro extends readonly string[] = never>(
  label: string | AppMessageRef, sections: readonly Sec[],
  opts?: Pick<AppDashboardView, 'heading' | 'description' | 'areas' | 'windows' | 'window' | 'windowControl' | 'realm' | 'icon' | 'path'> & { aside?: Aside; from?: T; filters?: F; roles?: Ro },
): NoInfer<Omit<AppDashboardView, 'sections' | 'aside' | 'from' | 'filters'> & { kind: 'dashboard'; sections: Authored<Sec>[]; from?: T; filters?: F }
  & (Aside extends readonly (infer A)[] ? { aside: Authored<A>[] } : {}) & ([Ro] extends [never] ? {} : { roles: Ro })>;
/** A dashboard's feed of recent changes across resources, from their record history:
    `activity('Latest updates', { pick_list: { icon: 'truck' }, purchase_order: { icon: 'receipt' } }, { limit: 8 })`. */
export declare function activity<const R extends Readonly<Record<string, ActivityResource>>>(
  title: string | AppMessageRef, resources: R, opts?: Omit<ActivityDashSection, Made | 'kind' | 'title' | 'resources'>,
): { kind: 'activity'; readonly [madeBy]: 'activity'; title: string | AppMessageRef; resources: R } & Omit<ActivityDashSection, Made | 'kind' | 'title' | 'resources'>;
/** dashboard section: a tenant's own Branding form, for the App's `branding` — `brandingForm('Branding')`. */
export declare function brandingForm(
  title?: string | AppMessageRef, opts?: Omit<BrandingDashSection, Made | 'kind' | 'title'>,
): { kind: 'branding'; readonly [madeBy]: 'brandingForm'; title?: string | AppMessageRef } & Omit<BrandingDashSection, Made | 'kind' | 'title'>;
/** dashboard section: the integrations' settings form, where admins enter their secrets — `integrationsForm('Integrations')`. */
export declare function integrationsForm(
  title?: string | AppMessageRef, opts?: Omit<IntegrationsDashSection, Made | 'kind' | 'title'>,
): { kind: 'integrations'; readonly [madeBy]: 'integrationsForm'; title?: string | AppMessageRef } & Omit<IntegrationsDashSection, Made | 'kind' | 'title'>;
/** A dashboard's one box over several resources' records: `find('Find anything', ['article', 'catalog_item'], { placeholder: 'Search help and the catalog' })`. */
export declare function find<const R extends readonly string[]>(
  title: string | AppMessageRef, resources: R, opts?: Omit<FindDashSection, Made | 'kind' | 'title' | 'resources'>,
): { kind: 'find'; readonly [madeBy]: 'find'; title: string | AppMessageRef; resources: R } & Omit<FindDashSection, Made | 'kind' | 'title' | 'resources'>;
/** A list view drawn read-only inside a dashboard, as its room draws it: `embed('projects', { width: 'half', limit: 6 })`;
    or on a landing, as its cards: `embed('recommended', { limit: 6, sort: 'listed_on desc' })`. */
export declare function embed<const V extends string>(view: V, opts?: Omit<AppViewDashSection, Made | 'kind' | 'view'>): AppViewDashSection<V>;
/** On a record's page, given `whose`: the view's rows that point at the record — `embed('invoices', { whose: 'customer_id' })`. */
export declare function embed<const V extends string, const O extends Omit<EmbedSection, Made | 'kind' | 'view'>>(view: V, opts: O): NoInfer<{ kind: 'view'; readonly [madeBy]: 'embed'; view: V } & Authored<O>>;
export declare function embed<const V extends string>(view: V, opts: Omit<LandingViewSection, Made | 'kind' | 'view'>): LandingViewSection & { view: V };
/* The list view and its presentations keep their names as literals, so a view built from them is still checked
   against its table's columns where it sits under `satisfies App`. */
/** A list view: `listView('Issues', 'issue', { show: ['name', 'status'], presentation: queue('name') })`;
    a board or a split is a key: `listView('Deals', 'opportunity', { board: { by: 'stage', primary: 'name' } })`. */
export declare function listView<const T extends string, const O extends Omit<AppListView<T>, Made | 'kind' | 'label' | 'from'> = {}>(
  label: string | AppMessageRef, from: T, opts?: O & NoInfer<QueryGuard<T, O>> & Record<Exclude<keyof O, keyof AppListView>, never>,
): NoInfer<{ kind: 'list'; readonly [madeBy]: 'listView'; label: string | AppMessageRef; from: T } & Authored<O>>;
/** A list view called what its resource's `noun` says: `listView('issue', { show, tabs })`. */
export declare function listView<const T extends string, const O extends Omit<AppListView<T>, Made | 'kind' | 'label' | 'from'> = {}>(
  from: T, opts?: O & NoInfer<QueryGuard<T, O>> & Record<Exclude<keyof O, keyof AppListView>, never>,
): NoInfer<{ kind: 'list'; readonly [madeBy]: 'listView'; from: T } & Authored<O>>;
/** A checklist: `checklist('name', 'completed', { lines: ['due_on'] })`. */
export declare function checklist<const P extends string, const C extends string, const O extends Omit<AppChecklist, Made | 'kind' | 'primary' | 'checked'> = {}>(
  primary: P, checked: C, opts?: O,
): NoInfer<{ kind: 'checklist'; readonly [madeBy]: 'checklist'; primary: P; checked: C } & O>;
/** A queue: `queue('name', { lines: ['status', 'priority'] })`. */
export declare function queue<const P extends string, const O extends Omit<AppQueueList, Made | 'kind' | 'primary'> = {}>(
  primary: P, opts?: O,
): NoInfer<{ kind: 'queue'; readonly [madeBy]: 'queue'; primary: P } & O>;
/** A queue whose cards say their record's name: `queue({ lines: ['due_on'] })`. */
export declare function queue<const O extends Omit<AppQueueList, Made | 'kind' | 'primary'> = {}>(
  opts?: O,
): NoInfer<{ kind: 'queue'; readonly [madeBy]: 'queue' } & O>;
/** A calendar: `calendar('due_on', 'subject')`. */
export declare function calendar<const D extends string, const P extends string, const O extends Omit<AppCalendarList, Made | 'kind' | 'date' | 'primary'> = {}>(
  date: D, primary: P, opts?: O,
): NoInfer<{ kind: 'calendar'; readonly [madeBy]: 'calendar'; date: D; primary: P } & O>;
/** A calendar whose records say their name: `calendar('due_on', { lines: ['bike_id'] })`. */
export declare function calendar<const D extends string, const O extends Omit<AppCalendarList, Made | 'kind' | 'date' | 'primary'> = {}>(
  date: D, opts?: O,
): NoInfer<{ kind: 'calendar'; readonly [madeBy]: 'calendar'; date: D } & O>;
/** A tree: `tree('parent_account_id', 'name')`. */
export declare function tree<const Pa extends string, const P extends string, const O extends Omit<AppTreeList, Made | 'kind' | 'parent' | 'primary'> = {}>(
  parent: Pa, primary: P, opts?: O,
): NoInfer<{ kind: 'tree'; readonly [madeBy]: 'tree'; parent: Pa; primary: P } & O>;
/** A Gantt chart: `gantt('starts_on', 'due_on', 'name', { by: 'owner_id.name' })`. @preview */
export declare function gantt<
  const S extends string,
  const E extends string,
  const P extends string,
  const O extends Omit<AppGanttList, Made | 'kind' | 'start' | 'end' | 'primary'> = {},
>(start: S, end: E, primary: P, opts?: O): NoInfer<{ kind: 'gantt'; readonly [madeBy]: 'gantt'; start: S; end: E; primary: P } & O>;
/** Cards: `cards('title', { value: 'price', facts: ['year', 'mileage'], properties: ['dealer_id.name'] })`, or on a list
    view `cards({ value: 'price' })`, titled by the record's name. */
export declare function cards<const P extends string, const O extends Omit<AppCardsList, Made | 'kind' | 'primary'> = {}>(
  primary: P, opts?: O,
): NoInfer<{ kind: 'cards'; readonly [madeBy]: 'cards'; primary: P } & O>;
export declare function cards<const O extends Omit<AppCardsList, Made | 'kind' | 'primary'> = {}>(opts?: O): NoInfer<{ kind: 'cards'; readonly [madeBy]: 'cards' } & O>;
/** The record's own change history, in the aside, eight writes at first: `history()`, or `history('Changes', { limit: 50 })`. */
export declare function history(title?: string | AppMessageRef, opts?: Omit<HistorySection, Made | 'kind' | 'title'>): HistorySection;
/** The record's row-driven flow runs: `flows()`, or `flows('Automation')`. The base resource must declare `flows`. */
export declare function flows(title?: string | AppMessageRef, opts?: Omit<FlowsSection, Made | 'kind' | 'title'>): FlowsSection;
/** A flow's steps drawn, on the flow's own page or over a record's run: `diagram()`, or `diagram('Steps')`. The base is a resource's flows `from`, or a resource with `flows`. */
export declare function diagram(title?: string | AppMessageRef, opts?: Omit<DiagramSection, Made | 'kind' | 'title'>): DiagramSection;
export declare function timeline<const St extends TimelineStream>(
  title: string | AppMessageRef, streams: readonly St[],
  opts?: Omit<TimelineSection, Made | 'kind' | 'title' | 'streams'>,
): NoInfer<Omit<TimelineSection, 'streams'> & { streams: Authored<St>[] }>;
/** A record page, keyed in `pages` by its id: `page('issue', [...])`. It is called what the resource's `noun` says. */
export declare function page<T extends string, const Sec extends PageSection, const Ro extends readonly string[] = never>(
  base: T, sections: readonly Sec[] & NoInfer<SectionsGuard<T, Sec>>,
  opts?: Pick<AppPage, 'listTabs' | 'empty' | 'aside' | 'layout' | 'realm' | 'path'> & { roles?: Ro },
): NoInfer<Omit<AppPage, 'base' | 'sections'> & { base: T; sections: Authored<Sec>[] } & ([Ro] extends [never] ? {} : { roles: Ro })>;
/** A record on paper, keyed in `pages` by the word after its record's address: `invoice: document('sales_order',
    [fields(['customer_id'], { title: 'Bill to', width: 'half' }), related('Items', 'order_line', 'sales_order_id', { … })],
    { label: 'Invoice', number: 'invoice_no' })`. */
export declare function document<T extends string, const Sec extends DocumentSection, const Ro extends readonly string[] = never>(
  base: T, sections: readonly Sec[] & NoInfer<SectionsGuard<T, Sec>>,
  opts: AppDocument & Pick<AppPage, 'realm'> & { roles?: Ro },
): NoInfer<Omit<AppPage, 'base' | 'sections' | 'document'> & { base: T; sections: Authored<Sec>[]; document: AppDocument } & ([Ro] extends [never] ? {} : { roles: Ro })>;
export declare function stream<const F extends string, const W extends string, const At extends string, const Show extends string,
  const O extends Pick<TimelineStream, 'detail' | 'author' | 'query' | 'about' | 'side' | 'tone' | 'compact'> & QueryGuard<F, O> = {}>(
  from: F, whose: W, at: At, show: Show, opts?: O,
): NoInfer<{ from: F; whose: W; at: At; show: Show } & Authored<O>>;
/** A group of the record's own fields: `fields(['name', 'status'], { title: 'Identity', columns: 2 })`. */
export declare function fields<const Show extends string, const O extends Omit<FieldsSection, Made | 'kind' | 'show'> = {}>(
  show: readonly Show[], opts?: O): NoInfer<{ kind: 'fields'; readonly [madeBy]: 'fields'; show: Show[] } & Authored<O>>;
/** Related record list with optional contextual creation: the `from` rows whose `whose` column points at this record. */
export declare function related<const F extends string, const W extends string, const O extends Omit<ListSection, Made | 'kind' | 'title' | 'from' | 'whose' | 'same' | 'near'> & QueryGuard<F, O> = {}>(
  title: string | AppMessageRef, from: F & NoInfer<SourceGuard<F>>, whose: W, opts?: O,
): NoInfer<{ kind: 'list'; readonly [madeBy]: 'related'; title: string | AppMessageRef; from: QueryTable<F>; whose: W } & Authored<O>>;
/** Rows that share a key with this record, in place of a reference: `same` columns equal to the record's, `near`
    numbers within a fraction of it (0.25 is ±25%, the first also the order). Over the page's own table the record
    itself is left out: `related('Similar vehicles', 'vehicle', { same: ['body_type'], near: { price: 0.25 } }, { limit: 4 })`,
    `related('Other deals on this account', 'opportunity', { same: ['account_id'] })`. */
export declare function related<const F extends string, const M extends RelatedMatch, const O extends Omit<ListSection, Made | 'kind' | 'title' | 'from' | 'whose' | 'same' | 'near'> & QueryGuard<F, O> = {}>(
  title: string | AppMessageRef, from: F & NoInfer<SourceGuard<F>>, match: M, opts?: O,
): NoInfer<{ kind: 'list'; readonly [madeBy]: 'related'; title: string | AppMessageRef; from: QueryTable<F> } & Authored<M> & Authored<O>>;
/** A box for the record a reference names: `card('Sold by', 'dealer_id', ['rating', 'city', 'phone'])` — the reference
    column, then that record's columns. In the aside unless `region` says otherwise. */
export declare function card<const R extends string, const Show extends string, const O extends Omit<CardSection, Made | 'kind' | 'title' | 'show'> = {}>(
  title: string | AppMessageRef, reference: R, show?: readonly Show[], opts?: O,
): NoInfer<{ kind: 'card'; readonly [madeBy]: 'card'; title: string | AppMessageRef; show: (R | `${R}.${Show}`)[] } & Authored<O>>;
/** A figure with buttons: `headline('price', { was: 'was_price', subfigure: 'est_monthly', links: [{ label: 'Ask about this car', to: 'inquire' }] })`.
    The first field is the large figure; a list names it and the facts after it. */
export declare function headline<const Show extends string, const O extends Omit<HeadlineSection, Made | 'kind' | 'show'> = {}>(
  show: Show | readonly Show[], opts?: O,
): NoInfer<{ kind: 'headline'; readonly [madeBy]: 'headline'; show: Show[] } & Authored<O>>;
/** What a header must say at least one of: an empty `header({})` is refused, here and by `mistri check`. */
export type HeaderSays = { status: string } | { facts: readonly FactEntry[] } | { primary: string } | { destructive: readonly string[] } | { actions: readonly string[] };
/** The record's head: its status chip, its facts line and its verbs, destructive ones last (HeaderSection).
    `header({ primary: 'renew' })` alone is the head the page draws anyway, with that verb filled; `'renew'` is the id
    of the resource's own action (`actions: { renew: action('Renew', …) }`), which `defineApp` checks. */
/** A header's verbs as literal ids: `defineApp` checks them against the resource's actions, which it cannot do with a
    `string` — `header({ primary })` over a `string` variable is refused here rather than left unchecked. */
export type HeaderIdsLiteral<O> = (O extends { primary: infer P } ? string extends P ? { primary: 'an action id written as a literal: a string variable cannot be checked' } : unknown : unknown)
  & (O extends { destructive: readonly (infer D)[] } ? string extends D ? { destructive: readonly ['action ids written as literals: a string[] cannot be checked'] } : unknown : unknown)
  & (O extends { actions: readonly (infer A)[] } ? string extends A ? { actions: readonly ['action ids written as literals: a string[] cannot be checked'] } : unknown : unknown);
export declare function header<const O extends Omit<HeaderSection, Made | 'kind'> & HeaderSays>(opts: O & HeaderIdsLiteral<O>): NoInfer<{ kind: 'header'; readonly [madeBy]: 'header' } & Authored<O>>;
/** One related row as a card, chosen by a query and a sort: `current('Current lease', 'lease', 'unit_id', { query: 'status = active', sort: 'starts_on desc', show: ['tenant_id', 'rent', 'ends_on'] })`. */
export declare function current<const F extends string, const W extends string, const O extends Omit<CurrentSection, Made | 'kind' | 'title' | 'from' | 'whose'> & QueryGuard<F, O> = {}>(
  title: string | AppMessageRef, from: F, whose: W, opts?: O,
): NoInfer<{ kind: 'current'; readonly [madeBy]: 'current'; title: string | AppMessageRef; from: F; whose: W } & Authored<O>>;
/** A prop a component declares: `prop.number({ default: 12, min: 1, max: 36 })`, `prop.text()`, `prop.bool()`, `prop.choice(['week', 'month'])`. */
export declare const prop: {
  number<const O extends { default?: number; min?: number; max?: number } = {}>(opts?: O): { type: 'number' } & O;
  text<const O extends { default?: string; max?: number } = {}>(opts?: O): { type: 'text' } & O;
  bool<const O extends { default?: boolean } = {}>(opts?: O): { type: 'boolean' } & O;
  choice<const V extends string, const O extends { default?: NoInfer<V> } = {}>(options: readonly V[], opts?: O): { type: 'choice'; options: V[] } & O;
};
/** A custom component: its id, its module inside the App directory, its kind and the props it declares —
    `component('payroll-timeline', { module: './widgets/PayrollTimeline.tsx', props: { months: prop.number({ default: 12 }) } })`;
    `kind: 'value'` makes a value renderer, placed where a display rule goes. */
export declare function component<const Id extends string,
  const O extends { module: `./${string}`; kind?: ComponentKind; props?: Readonly<Record<string, ComponentPropDecl>> }>(
  id: Id, options: O,
): { id: Id; kind: O extends { kind: infer K extends ComponentKind } ? K : 'section'; module: O['module'] } & Authored<Omit<O, Made | 'kind' | 'module'>>;
type CustomOpts<C> = (Omit<CustomSection, Made | 'kind' | 'title' | 'component' | 'props'> | Omit<CustomDashSection, Made | 'kind' | 'title' | 'component' | 'props'>)
  & { props?: PropInput<C extends { props?: infer P } ? NonNullable<P> : {}> };
/** A custom section, on a page or a dashboard: `custom('Pay history', payrollTimeline, { record, rows, props, width, when })`.
    Export it, so the module can type its props from it: `SectionProps<typeof payHistory, Rows>` (@mistriwork/mistri/ui). */
export declare function custom<const C extends ComponentDecl<string, 'section'>, const O extends CustomOpts<C> = {},
  const Ti extends string | AppMessageRef = string>(
  /* The title as given, so a plain one fits a dashboard, whose titles are words. */
  title: Ti, component: C, opts?: O & NoInfer<RowsGuard<O>>,
): NoInfer<{ kind: 'custom'; readonly [madeBy]: 'custom'; title: Ti; component: C } & Authored<O>>;
/** A custom section with no title of its own — a floor plan over the record: `custom(binMap, { record: ['code', 'zone'] })`. */
export declare function custom<const C extends ComponentDecl<string, 'section'>, const O extends CustomOpts<C> = {}>(
  component: C, opts?: O & NoInfer<RowsGuard<O>>,
): NoInfer<{ kind: 'custom'; readonly [madeBy]: 'custom'; component: C } & Authored<O>>;
/** A list view's rows drawn by a component: `presentation: customList(postStream, { show: ['body', 'created_at'] })`.
    Export the view's options or the call, so the module can type its rows: `ListProps<typeof conversation, Rows, 'post'>` (@mistriwork/mistri/ui). */
export declare function customList<const C extends ComponentDecl<string, 'list'>, const S extends readonly string[],
  const O extends { props?: PropInput<C extends { props?: infer P } ? NonNullable<P> : {}> } = {}>(
  component: C, opts: { show: S } & O,
): { kind: 'custom'; readonly [madeBy]: 'customList'; component: C; show: S } & Authored<O>;
/** Structural navigation parent; its children are view ids, `{ to, label }` or groups, kept as literals. */
export declare function navGroup<const Children extends readonly AppNavNode<Lowercase<string>, AppNavPlacement>[]>(
  id: string, label: string | AppMessageRef, children: Children, opts?: Pick<AppNavGroup, 'realm' | 'icon' | 'placement' | 'inline' | 'folded'>,
): { id: string; label: string | AppMessageRef; children: Children; realm?: 'tenant' | 'platform'; icon?: AppIcon; placement?: 'footer'; inline?: true; folded?: true };

/* ---------- schema-typed names ----------
   Pair with `mistri --export types > mistri-schema.d.ts`: the
   generated file binds these generics to the connection's own tables,
   columns and references, so a mistyped table, column or label path
   squiggles in the editor before the server has to refuse it. Grammar
   strings — queries, measures, `when`, a bucketed `by` — stay strings
   here: a type pretending to parse them at a `satisfies` would lie at the
   edges. A sort's first key is the exception, a name a type can say
   exactly (`SortOf`). The helpers and `defineApp`/`defineFeature` read them
   in full where they know the table (packages/mistri/schema/query.d.ts), against the
   registered `Columns`, computed columns and rollups among them; whatever
   that guard cannot read for certain passes to the server. Names are checked: bare
   columns (a filter, an `over`, a board's `by`, a card's primary, a form's
   fields, an update's `set`, a command's version field), and label paths
   (a `show`, a card's facts, a label, a related list's `whose`), hop by hop
   through the generated `References`. A column no reader is served is
   generated apart, as `Hidden`: `hidden`, `fields` and a role's `fields` take
   it, and no place that shows a column does. `mistri check` judges the
   query language in the end, naming the column and where in the query it
   stands. */

/** Table name → union of its column names. Generated, never hand-kept. */
export interface SchemaShape { [table: string]: string }
/** Table name → its references: the hop a label path writes (the column, `a+b` for a composite key) → the table
    that hop lands on. Generated as `References`, never hand-kept. Without it (`never`), a path's first segment is
    checked against the table's columns and the rest is left to the catalog check. */
export interface SchemaReferences { [table: string]: { [hop: string]: string } }
/** Table name → union of its columns no reader is served: `hidden`, and what every role's ceiling leaves out.
    Generated as `Hidden` when there are any; `{}` otherwise. */
export interface SchemaHidden { [table: string]: string }

type TableOf<S> = Extract<keyof S, string>;
type ColumnOf<S, T> = S[T & keyof S] & string;
/* A column an access rule may name: one a reader is served, or one none is. */
type GovernedOf<S, H, T> = ColumnOf<S, T> | ColumnOf<H, T>;

/* Without references (`R` is `never`) no table has hops, and a path's first segment is the only
   name the type knows. */
type HopsOf<R, T> = [R] extends [never] ? {} : T extends keyof R ? R[T] : {};
type HopOf<R, T> = Extract<keyof HopsOf<R, T>, string>;
type LandsOn<R, T, H> = HopsOf<R, T>[H & keyof HopsOf<R, T>];
type Unwalked<S, R, T> = [R] extends [never] ? `${ColumnOf<S, T>}.${string}` : never;
type Unreferenced<S, R, T> = [R] extends [never] ? ColumnOf<S, T> : never;
/* Paths are walked exactly for two hops (`account_id.owner_id.name`); past them the tail is the
   catalog's (`a.b.c.…`). A path type is the union of every name it allows, so each hop multiplies
   it: two keeps the largest example schema's unions small and its typecheck fast. Each exported
   name builds its own union, so an error reads `LabelPath<Tables, References, "task">`. */
type Beyond<S, R, T, Hops extends unknown[]> = { [H in HopOf<R, T>]:
  `${H}.${Hops['length'] extends 2 ? string : ColumnOf<S, LandsOn<R, T, H>> | Beyond<S, R, LandsOn<R, T, H>, [...Hops, 0]>}` }[HopOf<R, T>];
type OneHop<S, R, T> = { [H in HopOf<R, T>]: `${H}.${ColumnOf<S, LandsOn<R, T, H>>}` }[HopOf<R, T>];
type RefWalk<R, T, Hops extends unknown[] = []> = { [H in HopOf<R, T>]:
  H | `${H}.${Hops['length'] extends 2 ? string : RefWalk<R, LandsOn<R, T, H>, [...Hops, 0]>}` }[HopOf<R, T>];
type RefWalkTo<R, T, To, Hops extends unknown[] = []> = { [H in HopOf<R, T>]:
  | (LandsOn<R, T, H> extends To ? H : never)
  | (Hops['length'] extends 2 ? never : `${H}.${RefWalkTo<R, LandsOn<R, T, H>, To, [...Hops, 0]>}`) }[HopOf<R, T>];

/* A sort key is a column or a path through a reference; the path's tail is the catalog's to judge, which keeps
   the union one entry per column however many tables a reference reaches. */
type SortKey<S, R, T> = ColumnOf<S, T> | Unwalked<S, R, T> | `${HopOf<R, T>}.${string}`;
/** A sort written like the query bar — `ordered_on desc`, `due_on, name` — its first key checked against T's
    columns (a typo like `orderd_on` fails the typecheck); keys after the first comma are the catalog's to judge. */
export type SortOf<S extends SchemaShape, R, T> =
  `${SortKey<S, R, T>}${'' | ' asc' | ' desc'}` | `${SortKey<S, R, T>}${'' | ' asc' | ' desc'}, ${string}`;

/** A column of T, or a label path through its references to a column: `owner_id.name`, `account_id.owner_id.name`. */
export type LabelPath<S extends SchemaShape, R, T> = ColumnOf<S, T> | Unwalked<S, R, T> | Beyond<S, R, T, []>;
/** A column of T, or a label path one reference long: what a queue, a calendar or a card says. */
export type OneHopPath<S extends SchemaShape, R, T> = ColumnOf<S, T> | Unwalked<S, R, T> | OneHop<S, R, T>;
/** References alone, from T: a related section's `about`, or its `whose` beside one. */
export type ReferencePath<S extends SchemaShape, R, T> = Unreferenced<S, R, T> | Unwalked<S, R, T> | RefWalk<R, T>;
/** References from T that land on `To`: a related section's `whose`, leading from its rows to the page's record. */
export type ReferencePathTo<S extends SchemaShape, R, T, To> = Unreferenced<S, R, T> | Unwalked<S, R, T> | RefWalkTo<R, T, To>;

type TypedApiResources<S extends SchemaShape, R> = {
  [T in TableOf<S>]?: ApiResourceExposure<LabelPath<S, R, T>>;
};

/** A resource's action, written with `action()`: an update whose `set` and `reason` name its columns, or a command
    targeting it. */
export type TypedAppAction<S extends SchemaShape, T extends TableOf<S>> =
  | (Omit<AppUpdateAction<string | AppMessageRef>, 'id' | 'set' | 'reason' | 'when'> & {
      set: Partial<Record<ColumnOf<S, T>, ActionSetValue>> & { readonly [setColumns]?: ColumnOf<S, T> };
      reason?: ColumnOf<S, T>;
      /** Where the button is offered, in the query language. Here its first word is read against the table's columns;
          under `defineApp` or `defineFeature` the whole condition is (packages/mistri/schema/query.d.ts). */
      when?: `${ColumnOf<S, T>} ${string}`;
    } & MadeBy<'action'>)
  | (CommandAction<CommandOn<T>, string | AppMessageRef> & MadeBy<'action'>);

/** Each resource block keyed by its table, its column-valued keys checked against that table. `hidden`, `fields`
    and `audit.redact` govern columns, so they also take the ones no reader is served (`H`); every other key shows
    or writes one, so it takes only those a reader may be served. */
export type TypedResources<S extends SchemaShape, R extends SchemaReferences = never, H extends SchemaHidden = {}> = {
  [T in TableOf<S>]?: Omit<AppResource<ColumnOf<S, T>>, 'fields' | 'hidden' | 'references' | 'display' | 'inputs' | 'validation' | 'labels' | 'recordLabel' | 'form' | 'actions' | 'audit' | 'rollups' | 'import' | 'notify' | 'defined' | 'flows'> & {
    fields?: AppFieldAccess<GovernedOf<S, H, T>>;
    hidden?: readonly GovernedOf<S, H, T>[];
    references?: Partial<Record<ColumnOf<S, T>, { [To in TableOf<S>]: { to: To; column?: ColumnOf<S, To> } }[TableOf<S>]>>;
    display?: Partial<Record<ColumnOf<S, T>, AppDisplayRule | ComponentDecl<string, 'value'>>>;
    inputs?: Partial<Record<ColumnOf<S, T>, ComponentDecl<string, 'input'>>>;
    validation?: readonly FormRule[];
    labels?: Partial<Record<LabelPath<S, R, T>, string | AppMessageRef>>;
    recordLabel?: LabelPath<S, R, T> | LabelTemplate | AppMessageRef;
    form?: Omit<AppForm<ColumnOf<S, T>>, 'lines' | 'defaults'> & {
      /** As `AppForm.defaults`, a `from` path checked: one reference of this table, then a column of the table it names. */
      defaults?: Partial<Record<ColumnOf<S, T>, FormDefault | FromReference<OneHop<S, R, T>>>>;
      lines?: readonly { [F in TableOf<S>]: AppFormLines<F, ColumnOf<S, F>> }[TableOf<S>][];
    };
    actions?: Readonly<Record<string, TypedAppAction<S, T>>>;
    audit?: { redact: 'values' | readonly GovernedOf<S, H, T>[] };
    rollups?: Record<string, TypedRollup<S, R>>;
    defined?: Partial<Record<ColumnOf<S, T>, { [F in TableOf<S>]: AppDefined<F, ColumnOf<S, T> & ColumnOf<S, F>> }[TableOf<S>]>>;
    import?: boolean | AppImport<ColumnOf<S, T>, CommandOn<T>>;
    notify?: readonly AppNotifyRule<ColumnOf<S, T>, LabelPath<S, R, T>>[];
    flows?: AppFlows<ColumnOf<S, T>, TableOf<S>>;
  } };

/** A rollup over one of the schema's tables: its column that table's, its `whose` one of that table's references. */
export type TypedRollup<S extends SchemaShape, R extends SchemaReferences = never> = { [F in TableOf<S>]:
  AppRollup<F, ColumnOf<S, F>, [R] extends [never] ? string : RollupWhose<R, F>> }[TableOf<S>];
/* A rollup's `whose`: one reference of its rows, or one and then a reference of the record it lands on. */
type RollupWhose<R, T> = { [H in HopOf<R, T>]: H | `${H}.${HopOf<R, LandsOn<R, T, H>>}` }[HopOf<R, T>];

/** The rows that point at a list's record, as a filter (AppHasFilter): `has` names one of the schema's tables. */
export type TypedHasFilter<S extends SchemaShape> = AppHasFilter extends infer H ? (H extends { has: string } ? Omit<H, 'has'> & { has: TableOf<S> } : never) : never;

/** A list view over one of the schema's tables: what it shows, filters, totals and draws are that table's
    columns and label paths. */
export type TypedListView<S extends SchemaShape, R extends SchemaReferences = never> = { [T in TableOf<S>]:
  Omit<AppListView, 'from' | 'show' | 'filters' | 'totals' | 'order' | 'presentation' | 'sort' | 'editable' | 'import' | 'board' | 'split'>
  & {
    from: T;
    show?: readonly LabelPath<S, R, T>[];
    editable?: true | readonly ColumnOf<S, T>[];
    sort?: SortOf<S, R, T> | readonly { label: string | AppMessageRef; sort: SortOf<S, R, T> }[];
    filters?: readonly (LabelPath<S, R, T> | TypedHasFilter<S>)[];
    totals?: readonly ColumnOf<S, T>[];
    order?: ColumnOf<S, T>;
    presentation?: AppListPresentation<ColumnOf<S, T>, OneHopPath<S, R, T>, LabelPath<S, R, T>>;
    board?: Omit<AppBoardList<ColumnOf<S, T>, OneHopPath<S, R, T>>, 'kind'>;
    split?: Omit<AppSplitListDetail<LabelPath<S, R, T>>, 'kind'>;
    import?: boolean | AppImport<ColumnOf<S, T>, CommandOn<T>>;
  } }[TableOf<S>];

/* A section that names its table is checked against that table's columns
   — `over`, a board's `by`, a list's `show`, a board's card. One that
   inherits the dashboard's table keeps them as strings: which table it is
   cannot be known from here. */
type TableSectionNames<Sec, S extends SchemaShape, R, T> = { from: T; over?: ColumnOf<S, T> }
  & (Sec extends BoardDashSection ? { by: ColumnOf<S, T>; primary?: LabelPath<S, R, T>; lines?: readonly LabelPath<S, R, T>[]; sort?: SortOf<S, R, T> }
    : Sec extends RowsDashSection ? { show?: readonly LabelPath<S, R, T>[]; sort?: SortOf<S, R, T> }
      : Sec extends { by: string } ? { by: string } : {});
type TypedTableSection<Sec extends Exclude<AppDashSection, NoteDashSection>, S extends SchemaShape, R> =
  | { [T in TableOf<S>]: Omit<Sec, 'from' | 'over' | 'by' | 'show' | 'primary' | 'lines' | (Sec extends RowsDashSection | BoardDashSection ? 'sort' : never)>
    & TableSectionNames<Sec, S, R, T> }[TableOf<S>]
  | (Omit<Sec, 'from'> & { from?: undefined });
type EachTableSection<Sec, S extends SchemaShape, R> = Sec extends Exclude<AppDashSection, NoteDashSection> ? TypedTableSection<Sec, S, R> : never;
/* An activity's resources are the schema's tables. */
type TypedActivityDashSection<S extends SchemaShape> = Omit<ActivityDashSection, 'resources'> & { resources: Partial<Readonly<Record<TableOf<S>, ActivityResource>>> };
/* A custom section's reads, each checked against its own resource: what it shows and sorts by, and its `over`. */
type TypedCustomDashRead<S extends SchemaShape, R> = { [F in TableOf<S>]: Omit<CustomDashRead, 'from' | 'show' | 'sort' | 'over'>
  & { from: F; show: readonly LabelPath<S, R, F>[]; sort?: SortOf<S, R, F>; over?: ColumnOf<S, F> } }[TableOf<S>];
type TypedCustomDashFigure<S extends SchemaShape> = { [F in TableOf<S>]: Omit<CustomDashFigure, 'from' | 'over'>
  & { from: F; over?: ColumnOf<S, F> } }[TableOf<S>];
type TypedCustomDashSection<S extends SchemaShape, R> = Omit<CustomDashSection, 'rows' | 'figures'> & {
  rows?: Readonly<Record<string, TypedCustomDashRead<S, R>>>;
  figures?: Readonly<Record<string, TypedCustomDashFigure<S>>>;
};
export type TypedDashSection<S extends SchemaShape, R extends SchemaReferences = never> =
  NoteDashSection | TypedCustomDashSection<S, R> | TypedActivityDashSection<S>
  | EachTableSection<Exclude<AppDashSection, NoteDashSection | CustomDashSection | ActivityDashSection>, S, R>;

export interface TypedDashboardView<S extends SchemaShape, R extends SchemaReferences = never> extends Omit<AppDashboardView, 'sections' | 'aside' | 'from' | 'filters'> {
  from?: TableOf<S>;
  /** Pick-filters: each a column of at least one of the schema's tables. */
  filters?: readonly ColumnOf<S, TableOf<S>>[];
  sections: readonly (TypedDashSection<S, R> | AppViewDashSection)[];
  aside?: readonly (TypedDashSection<S, R> | AppViewDashSection)[];
}

export type TypedView<S extends SchemaShape, R extends SchemaReferences = never> =
  TypedListView<S, R> | TypedDashboardView<S, R> | AppLandingView | AppFormView;

/* Page sections name the table their rows come from, and walk back from
   it to the page's record: `whose` lands on the page's base, or, beside
   `about`, on the record `about` names from the base. One object type,
   not a union split on `about`: tsc explains a union's mismatch against
   the member whose `whose` overlaps most, so a wrong `whose` read as
   "Property 'about' is missing". Its cost is that `whose` is checked
   against the base and every table `about` could reach, and the two are
   not tied together here — the catalog check does that. What a section
   shows and sorts by is its own table's. `measure` is grammar and stays
   a string. */
type Reach<R, T, Hops extends unknown[] = []> = { [H in HopOf<R, T>]:
  LandsOn<R, T, H> | (Hops['length'] extends 2 ? never : Reach<R, LandsOn<R, T, H>, [...Hops, 0]>) }[HopOf<R, T>];
type Anchor<S extends SchemaShape, R, Base, From> = {
  from: From;
  about?: ReferencePath<S, R, Base>;
  whose: ReferencePathTo<S, R, From, Base | Reach<R, Base>>;
};
type TypedShowEntry<S extends SchemaShape, R, T> = LabelPath<S, R, T> | { column: LabelPath<S, R, T>; label?: string | AppMessageRef };
type TypedCards<S extends SchemaShape, R, T> = 'gallery' | (AppCardsList<ColumnOf<S, T>, OneHopPath<S, R, T>> & { primary: ColumnOf<S, T> });

export type TypedMetricSection<S extends SchemaShape, R extends SchemaReferences = never, Base extends string = TableOf<S>> =
  { [F in TableOf<S>]: Omit<MetricSection, 'from' | 'whose' | 'about'> & Anchor<S, R, Base, F> }[TableOf<S>];
export type TypedRelatedSection<S extends SchemaShape, R extends SchemaReferences = never, Base extends string = TableOf<S>> =
  { [F in TableOf<S>]: Omit<ListSection, 'from' | 'whose' | 'same' | 'near' | 'show' | 'totals' | 'presentation' | 'create' | 'sort'> & {
    from: F;
    show?: readonly TypedShowEntry<S, R, F>[];
    sort?: SortOf<S, R, F>;
    totals?: readonly ColumnOf<S, F>[];
    presentation?: TypedCards<S, R, F>;
    create?: string | AppMessageRef | (Omit<RelatedCreate, 'show'> & { show?: readonly ColumnOf<S, F>[] }) | false;
    /* Either a path to the record (`whose`) or a match on values it shares (`same`, `near`); the parser refuses both. */
    whose?: ReferencePathTo<S, R, F, Base | Reach<R, Base>>;
    same?: readonly ColumnOf<S, F>[];
    near?: Partial<Record<ColumnOf<S, F>, number>>;
  } }[TableOf<S>];
/** The one current related row: its table's columns and label paths. */
export type TypedCurrentSection<S extends SchemaShape, R extends SchemaReferences = never, Base extends string = TableOf<S>> =
  { [F in TableOf<S>]: Omit<CurrentSection, 'from' | 'whose' | 'show' | 'sort'> & {
    from: F;
    show?: readonly TypedShowEntry<S, R, F>[];
    sort?: SortOf<S, R, F>;
    whose: ReferencePathTo<S, R, F, Base | Reach<R, Base>>;
  } }[TableOf<S>];
export type TypedBreakdownSection<S extends SchemaShape, R extends SchemaReferences = never, Base extends string = TableOf<S>> =
  { [F in TableOf<S>]: Omit<BreakdownSection, 'from' | 'whose' | 'about' | 'by'> & { by: LabelPath<S, R, F> } & Anchor<S, R, Base, F> }[TableOf<S>];
export type TypedTimelineStream<S extends SchemaShape, R extends SchemaReferences = never, Base extends string = TableOf<S>> =
  { [F in TableOf<S>]: Omit<TimelineStream, 'from' | 'whose' | 'at' | 'show' | 'detail' | 'author' | 'about'> & {
    from: F;
    at: ColumnOf<S, F>;
    show: LabelPath<S, R, F>;
    detail?: LabelPath<S, R, F>;
    author?: LabelPath<S, R, F>;
  } & (
    | { whose: ReferencePathTo<S, R, F, Base>; about?: undefined }
    /* About a row the record names: `whose` leads to that row's table, which `mistri check` judges. */
    | { whose: ReferencePathTo<S, R, F, TableOf<S>>; about: ColumnOf<S, Base> }
  ) }[TableOf<S>];
/** The record's own fields: its base's columns and label paths. */
export type TypedFieldsSection<S extends SchemaShape, R extends SchemaReferences = never, Base extends string = TableOf<S>> =
  Omit<FieldsSection, 'show'> & {
    show?: readonly LabelPath<S, R, Base>[];
  };
/** A card over a reference of the base: the reference, then label paths through it. */
export type TypedCardSection<S extends SchemaShape, R extends SchemaReferences = never, Base extends string = TableOf<S>> =
  Omit<CardSection, 'show'> & { show: readonly LabelPath<S, R, Base>[] };
/** A headline over the base's own fields. */
export type TypedHeadlineSection<S extends SchemaShape, R extends SchemaReferences = never, Base extends string = TableOf<S>> =
  Omit<HeadlineSection, 'show' | 'was'> & { show: readonly LabelPath<S, R, Base>[]; was?: ColumnOf<S, Base> };
/** The record's head over its base: its status a column, its facts columns and label paths. */
export type TypedHeaderSection<S extends SchemaShape, R extends SchemaReferences = never, Base extends string = TableOf<S>> =
  Omit<HeaderSection, 'status' | 'facts'> & { status?: ColumnOf<S, Base>; facts?: readonly FactEntry<LabelPath<S, R, Base>>[] };
/* A chart's `by` is grammar — "month issued_on", two keys — so it stays a string, as a dashboard's does. */
export type TypedChartSection<S extends SchemaShape, R extends SchemaReferences = never, Base extends string = TableOf<S>> =
  { [F in TableOf<S>]: Omit<ChartSection, 'from' | 'whose' | 'about'> & Anchor<S, R, Base, F> }[TableOf<S>];
/* An embed's `whose` leads from its view's table, which only the App knows: the catalog check judges it. */
export type TypedPageSection<S extends SchemaShape, R extends SchemaReferences = never, Base extends string = TableOf<S>> =
  | TypedFieldsSection<S, R, Base>
  | TypedHeaderSection<S, R, Base>
  | TypedCurrentSection<S, R, Base>
  | TypedMetricSection<S, R, Base>
  | TypedRelatedSection<S, R, Base>
  | TypedCardSection<S, R, Base>
  | TypedHeadlineSection<S, R, Base>
  | TypedBreakdownSection<S, R, Base>
  | TypedChartSection<S, R, Base>
  | NoteSection
  | EmbedSection
  | (Omit<TimelineSection, 'streams'> & { streams: readonly TypedTimelineStream<S, R, Base>[] })
  | HistorySection
  | FlowsSection
  | DiagramSection
  | TypedCustomSection<S, R, Base>;
/** A custom section's record fields are its base's; each read is checked against its own resource, its `whose` leading home. */
type TypedCustomRead<S extends SchemaShape, R, Base> = { [F in TableOf<S>]: Omit<CustomRead, 'from' | 'whose' | 'show' | 'sort'> & {
  from: F; whose?: ReferencePathTo<S, R, F, Base>; show: readonly LabelPath<S, R, F>[]; sort?: SortOf<S, R, F>;
} }[TableOf<S>];
type TypedCustomFigure<S extends SchemaShape, R, Base> = { [F in TableOf<S>]: Omit<CustomFigure, 'from' | 'whose'> & {
  from: F; whose?: ReferencePathTo<S, R, F, Base>;
} }[TableOf<S>];
export type TypedCustomSection<S extends SchemaShape, R extends SchemaReferences = never, Base extends string = TableOf<S>> =
  Omit<CustomSection, 'record' | 'rows' | 'figures'> & {
    record?: readonly LabelPath<S, R, Base>[];
    rows?: Readonly<Record<string, TypedCustomRead<S, R, Base>>>;
    figures?: Readonly<Record<string, TypedCustomFigure<S, R, Base>>>;
  };

/** A record page over one of the schema's tables, every section judged against that base. */
export type TypedPage<S extends SchemaShape, R extends SchemaReferences = never> = { [B in TableOf<S>]:
  Omit<AppPage, 'base' | 'sections'> & { base: B; sections?: readonly TypedPageSection<S, R, B>[] } }[TableOf<S>];

/* `views` of kind landing and form are inherited unchanged: a form's
   field names are the command's input names, not the schema's. */
/* A role's column narrowing, per table, in that table's governed columns. */
type TypedFieldGrants<S extends SchemaShape, H> = { [T in TableOf<S>]?: AppRoleFieldAccess<GovernedOf<S, H, T>> };
/** Sign-in with the schema's names: a role's `fields` and the public reader's are each table's columns, and `me`
    names a table and one of its columns. */
export type TypedAuth<S extends SchemaShape, H extends SchemaHidden = {}> = Omit<AppAuth<TableOf<S>>, 'roles' | 'public' | 'me'> & {
  roles?: Record<string, Omit<AppRoleGrant<TableOf<S>>, 'fields'> & { fields?: TypedFieldGrants<S, H> }>;
  public?: { read: readonly TableOf<S>[]; fields?: { [T in TableOf<S>]?: { read: readonly GovernedOf<S, H, T>[] } } };
  me?: { [T in TableOf<S>]: { from: T; column: GovernedOf<S, H, T> } }[TableOf<S>];
};

type TypedBrandingImage<S extends SchemaShape, Column extends string> = { [F in TableOf<S>]: {
  readonly from: F; readonly key: Readonly<Partial<Record<ColumnOf<S, F>, Column>>>; readonly alt?: string | AppMessageRef;
} }[TableOf<S>];
export type TypedRecordBranding<S extends SchemaShape> = { [T in TableOf<S>]:
  Omit<RecordBrandingSpec<T, ColumnOf<S, T>>, 'fields'> & {
    readonly fields: Omit<BrandingFields<ColumnOf<S, T>>, 'logo' | 'hero'> & {
      readonly logo?: TypedBrandingImage<S, ColumnOf<S, T>>;
      readonly hero?: TypedBrandingImage<S, ColumnOf<S, T>>;
    };
  }
}[TableOf<S>];

export type TypedRecordMessages<S extends SchemaShape> = { [T in TableOf<S>]: RecordMessagesSpec<T, ColumnOf<S, T>> }[TableOf<S>];

interface TypedAppUi<S extends SchemaShape> extends Omit<AppUi, 'theme' | 'messages'> {
  theme?: AppTheme | TypedRecordBranding<S>;
  messages?: TypedRecordMessages<S>;
}

export interface TypedAppConfig<S extends SchemaShape, R extends SchemaReferences = never, Connection extends string = string, H extends SchemaHidden = {}>
  extends Omit<AppConfig, 'resources' | 'views' | 'pages' | 'auth' | 'features' | 'connection' | 'sources' | 'api' | 'ui'> {
  /** One of the server's configured connections: `--app … --export types` writes them as `Connections`. */
  connection?: Connection;
  sources?: Record<string, AppSource<Connection>>;
  resources?: TypedResources<S, R, H>;
  api?: Omit<ApiConfig, 'resources'> & { resources?: TypedApiResources<S, R> };
  auth?: TypedAuth<S, H>;
  views?: Record<string, TypedView<S, R>>;
  pages?: Record<string, TypedPage<S, R>>;
  features?: readonly TypedFeature<S, R, H>[];
  ui?: TypedAppUi<S>;
}

/** A feature with this schema's own names: `defineFeature({ … } satisfies TypedFeature<Tables, References>)`. */
export interface TypedFeature<S extends SchemaShape, R extends SchemaReferences = never, H extends SchemaHidden = {}> extends Omit<AppFeature, 'resources' | 'auth' | 'views' | 'pages' | 'api'> {
  resources?: TypedResources<S, R, H>;
  api?: Omit<ApiFeatureConfig, 'resources'> & { resources?: TypedApiResources<S, R> };
  auth?: { roles: Record<string, Omit<FeatureRoleGrant<TableOf<S>>, 'fields'> & { fields?: TypedFieldGrants<S, H> }> };
  views?: Record<string, TypedView<S, R>>;
  pages?: Record<string, TypedPage<S, R>>;
}
