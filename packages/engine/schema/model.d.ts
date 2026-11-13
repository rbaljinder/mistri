/**
 * The shapes the engine and the shared client read as well as an App: a caption that may be a message of the
 * App's catalog, a form's starting value, a link target, a related list's New form, and a resource action and its
 * command as the App serves them. They are published from here so the page, list and record rules
 * (src/shared, src/client) can read them without reading the App's authoring types; `@mistriwork/mistri/app` re-exports
 * every one of them, so an App names them from there as before (packages/mistri/schema/app.d.ts, packages/mistri/schema/command.d.ts).
 */

/** A message of the App's catalog where a caption goes: `msg('lead.title')`, `msg('lead.due', { days: 'due_in' })`.
    The server says it in each reader's language; it is words, never an identifier for data or authority. */
export interface AppMessageRef { readonly message: string; readonly args?: Readonly<Record<string, string>> }

export type FormScalar = string | number | boolean | null;
/** A value filled in rather than stated — the constants `today`, `now` and `me` — which is `{ auto }` in JSON. */
export interface AutoValue<Word extends 'today' | 'now' | 'me' = 'today' | 'now' | 'me'> { readonly auto: Word }
/** A form default: a literal, or `today`, `now` or `me`. */
export type FormDefault = FormScalar | AutoValue;

/** A related list's or a composer's New form. `Label` is a caption as it is written; the parsed form, which every
    reader is served, has said it (`RelatedCreate<string>`). */
export interface RelatedCreate<Label extends string | AppMessageRef = string | AppMessageRef> {
  label: Label;
  /** The fields to ask for; absent, the child resource's own New form. The parent reference is bound and never shown. */
  show?: readonly string[];
  /** The values the new row starts with, over the child resource's form defaults: a literal, or `today`, `now`, `me`. */
  defaults?: Readonly<Record<string, FormDefault>>;
  /** Columns filled from the page's record: child column → the record's column — a prescription from a visit takes
      the visit's patient, `{ patient_id: 'patient_id' }`. Shown fields stay editable; at most eight. The same word, and
      direction, as a headline action's `prefill` (form input → this record's field). */
  prefill?: Readonly<Record<string, string>>;
}

/** What an aggregate read of a custom section measures: "count", or an aggregate and a column of the resource. */
export type CustomMeasure = 'count' | `count distinct ${string}` | `${'sum' | 'avg' | 'min' | 'max'} ${string}`;

/** A scalar key, or a field of the source record. Never a URL or authority. */
export type AppLinkValue = string | number | { column: string };
export type AppTenantIntent<Value = AppLinkValue> = { kind: 'choose' } | { kind: 'tenant'; id: Value } | { kind: 'platform' };
export interface AppTargetBase<Value> { app: string; tenant?: AppTenantIntent<Value> }
export interface AppHomeTarget<Value> extends AppTargetBase<Value> { kind: 'home'; view?: never; resource?: never; key?: never }
export interface AppViewTarget<Value> extends AppTargetBase<Value> { kind: 'view'; view: string; resource?: never; key?: never }
export interface AppRecordTarget<Value> extends AppTargetBase<Value> { kind: 'record'; resource: string; key: Readonly<Record<string, Value>>; view?: never }
export type AppTarget<Value = AppLinkValue> = AppHomeTarget<Value> | AppViewTarget<Value> | AppRecordTarget<Value>;
/** One of this App's views by key, or a list on one of its tabs, named by the tab's address word (`?tab=`): `{ view: 'leads', tab: 'working' }`. */
export type ViewTo = string | { view: string; tab?: string };
export type AppLinkAction = { label: string | AppMessageRef; to: AppTarget | ViewTo };
/** A checked destination on a surface with no source row (nav or App switcher). */
export type StaticAppTarget = AppTarget<string | number>;

/* ---------- actions and commands, as the App serves them ---------- */

/**
 * A field's starting value: a literal (`'phone'`, `3`, `true`); `today` on a
 * date field or `now` on a datetime field, as the form opens in the App's time
 * zone; `me` on a text field, the reader's email; `{ record: 'on_hand' }`,
 * the target record's column as the reader sees it, or one its references
 * reach (`{ record: 'customer_id.default_rate' }`, at most two hops, each read
 * under the reader's grants: a hop they cannot read starts nothing); or
 * `{ tenant: 'country' }`, a column of the tenant's profile its members read
 * (`auth.tenancy.shared`). The constants are `@mistriwork/mistri/app`'s. `me`,
 * `{ record }` and `{ tenant }` are read when the form is prepared, so they
 * fill a field of the input itself; `{ record }` on a command that targets one
 * record.
 */
export type CommandFieldDefault =
  | string
  | number
  | boolean
  | { readonly auto: 'today' | 'now' | 'me' }
  | { readonly record: string }
  | { readonly tenant: string };

/** One option of a `choice` input. */
export interface AppCommandChoice {
  /** Nonempty text of at most 120 characters, or a finite number. */
  value: string | number;
  label: string;
  /** An App icon name, drawn on the option's card (`as: 'cards'`). */
  icon?: string;
  /** A line under the label, on a card. */
  help?: string;
  /** Set by the server on a table's row it served (`source.served`): the columns its `where` compares, so the page
      offers the rows the answers given match without a read of its own. Never written in an App. */
  row?: Readonly<Record<string, string | number | boolean | null>>;
}

/** A shape a text value must have; each refuses anything else. */
export type CommandTextFormat = 'email' | 'url' | 'phone';

/** Where an editor's @-mentions come from: a resource of people, its handle column, and the column a person is shown by
    or a template of their columns (`'{first_name} {last_name}'`);
    with `groups`, the teams an @ names as well (`{ from: 'team', by: 'id', labelColumn: 'name' }`), stored as a team's mention,
    which a `notify` rule over the column the command writes tells as the team's members (its display rule's `mentions.groups`).
    `through` names the resource of link rows that puts a person in a team (`through: 'team_member'`), as the display
    rule's does: the editor then offers only the teams that have a member. */
export interface CommandRichTextMentions {
  from: string;
  by: string;
  labelColumn?: string;
  groups?: { from: string; by: string; labelColumn?: string; through?: string };
}

/**
 * One field as the parser leaves it and the form and the server read it: in a
 * list, named, labelled, `required` set when it is.
 */
export interface CommandValueBase {
  name: string;
  label: string;
  help?: string;
  required?: boolean;
  default?: CommandFieldDefault;
  /** Asked only while this condition over the draft holds: a bare name is another input field, `record.<column>` the
      target's own. Judged in the browser as it is typed, and again where the command runs. */
  when?: string;
  /** How the field is drawn, over its kind's default (CommandFieldPresentation). */
  as?: CommandFieldPresentation;
  /** The App's own input component that draws this field in every form that asks it (`ui.inputs`, by name). What the
      value must be is still the field's kind's to judge. */
  input?: string;
}
/** How a field is drawn: a slider (a bounded number or amount), cards (one or several, with icons), two buttons (a
    yes or a no; a choice's few), a select, or radios; a number as stars (`'rating'`), a text as a code the camera
    reads (`'scan'`) or as a color with the system's picker (`'color'`). */
export type CommandFieldPresentation = 'slider' | 'cards' | 'buttons' | 'select' | 'radios' | 'rating' | 'scan' | 'color';
/** What a sensitive text keeps once its own rules have read the whole value: its last four characters, a keyed hash
    (HMAC under the form key), nothing at all, or — for the handler alone, once, in memory — the whole value
    (`'handler'`); whatever it keeps, the journal, the audit, events, flags, logs and the idempotency fingerprint
    never hold the whole value. */
export interface CommandSensitive { keep: 'last4' | 'hash' | 'none' | 'handler' }
/** Lines drawn under a number or an amount as it is typed, each a computed expression over the draft, in the
    field's format: `{ monthly: 'biweekly_gross * 26 / 12' }`. Display only, never sent. */
export type CommandLiveLines = Readonly<Record<string, string>>;
/** Choices read from a table rather than written out: its rows' key (`by`, its primary key) and the column each is
    shown by, read under the reader's grants and validated against the table where the command runs. */
/** One side of a choice's `where` comparison: a literal, or the answer to a field of the form (`{ answer: 'region' }`). */
export type CommandChoiceOperand = string | number | boolean | null | { readonly answer: string };
/** One comparison of a choice's `where`: a column of `from` against operands; several for `in`, `[null]` for `is empty`. */
export interface CommandChoiceTest {
  readonly column: string;
  readonly operator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
  readonly values: readonly CommandChoiceOperand[];
}
/** A choice's `where`, compiled: OR of ANDs of comparisons. */
export type CommandChoiceMatch = readonly (readonly CommandChoiceTest[])[];
export interface CommandChoiceSource {
  from: string;
  by: string;
  labelColumn: string;
  /** The column each row is shown by in a locale, keyed by the locale's tag as the App's catalogs name it
      (`{ es: 'name_es' }`); a row with nothing there is shown by `labelColumn`. */
  labelColumns?: Readonly<Record<string, string>>;
  /** The order the rows are offered in: a column of `from` and a direction. Absent, the rows are in the order of `labelColumn`
      (in a locale `labelColumns` names, of the words shown, in that locale's order). */
  sort?: { column: string; direction: 'asc' | 'desc' };
  /** The rows offered, narrowed by other answers of the form, as the App wrote it (`'region = region and active = true'`):
      a name on the right of a comparison that is a field of the form is that field's answer, any other name a column
      of `from`. Until every answer it reads is given, nothing is offered. */
  where?: string;
  /** `where`, compiled by the server: OR of ANDs of its comparisons. */
  match?: CommandChoiceMatch;
  /** Set by the server on a public form it served this field's rows with: `options` is the whole answer, an empty list
      meaning none to offer, and the page reads nothing of its own. Never written in an App. */
  served?: true;
}
export interface AppCommandLines {
  name: string;
  label: string;
  help?: string;
  type: 'lines';
  from: string;
  show: readonly string[];
  copy?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string>>;
  min?: number;
  max: number;
  required?: never;
  default?: never;
  when?: never;
}
export interface AppCommandGroup {
  name: string;
  label: string;
  help?: string;
  type: 'group';
  fields: readonly AppCommandField[];
  repeat?: { min?: number; max: number };
  required?: never;
}
export type AppCommandField = (CommandValueBase & (
  | { type: 'text' | 'textarea'; placeholder?: string; minLength?: number; maxLength?: number; format?: CommandTextFormat; pattern?: string; message?: string; case?: 'upper' | 'lower';
      /** A mask the value is typed through: `0` a digit, `a` a letter, `*` either, anything else drawn as written
          (`'000-00-0000'`). The value is what the mask's places hold (`123456789`), and the mask is its pattern. */
      mask?: string; sensitive?: CommandSensitive }
  | { type: 'richText'; minLength?: number; maxLength?: number; mentions?: CommandRichTextMentions; images?: string }
  /** `outOf`: with `as: 'rating'`, the stars of its scale; the field is then a whole number from 1 to it. */
  | { type: 'number'; placeholder?: string; min?: number; max?: number; integer?: boolean; step?: number; below?: string; above?: string; live?: CommandLiveLines; outOf?: number }
  /** An amount of money in the App's currency (`ui.currency`), from 0 unless `min` says less, on cents unless `step` says otherwise. */
  | { type: 'money'; placeholder?: string; min?: number; max?: number; step?: number; minor?: boolean; currency?: string; below?: string; above?: string; live?: CommandLiveLines }
  /** `statement`: the long words a consent box stands beside (at most 2,000 characters), drawn as one paragraph. */
  | { type: 'boolean'; accept?: true; statement?: string }
  | { type: 'date'; min?: string; max?: string; below?: string; above?: string }
  /** A month, `YYYY-MM`: `min` and `max` are months too. */
  | { type: 'month'; min?: string; max?: string; below?: string; above?: string }
  | { type: 'datetime'; min?: string; max?: string; below?: string; above?: string }
  /** A time of day, `HH:MM` on a 24-hour clock: `min` and `max` are times too. */
  | { type: 'time'; min?: string; max?: string; below?: string; above?: string }
  /** One of the options; or, with `source`, one of a table's rows by its key (the options then come from the table). */
  | { type: 'choice'; options: readonly AppCommandChoice[]; source?: CommandChoiceSource }
  /** Several of the options: from `min` to `max` of them, and an `exclusive` option (`'none'`) stands alone. */
  | { type: 'choices'; options: readonly AppCommandChoice[]; source?: CommandChoiceSource; min?: number; max?: number; exclusive?: readonly (string | number)[] }
  | { type: 'reference'; from: string; by: string; labelColumn: string; query?: string; tree?: string }
  | { type: 'defined'; from: string; whose?: string }
  /** Files of the file resource `from`, from `min` (1 unless said) to `max`; `accept` the media types taken
      (`image/*`). Each is sent as it is picked and held for the command; the value is the held files' ids. */
  | { type: 'files'; from: string; min?: number; max: number; accept?: readonly string[] }
  /** A signature drawn on a pad, held as a PNG of the file resource `from`; the value is the held file's id. */
  | { type: 'signature'; from: string }
)) | AppCommandGroup | AppCommandLines;

/**
 * A command as the App serves it to the browser, from its server
 * registration: the App names the command (`command: 'assignReviewer'`), and
 * the server fills in the rest. `version` is the contract's, derived from
 * authority.lock (1 until a breaking change is bumped); `targets` is how many
 * existing records one request names.
 */
/** A checked scalar flag equality; independent of permissions and row conditions. */
export interface AppFlagGate { readonly flag: string; readonly is: boolean | string | number }

export interface AppCommandReference<Target extends string = string> {
  readonly enabledBy?: AppFlagGate;
  id: string;
  version: number;
  /** Logical owning resource, source-qualified for a secondary source. */
  target: Target;
  /** `'one'` (absent) or `'many'`: a queue offers a `'many'` command in bulk. */
  targets?: 'one' | 'many';
  realm?: 'tenant' | 'platform';
  input: AppCommandField[];
  rules?: AppCommandRule[];
}
/** A rule over a command's whole draft (`rules`): the input must meet `must` wherever `when` holds; `message` is said
    at the first field `must` names. */
export interface AppCommandRule { must: string; when?: string; message: string }
/** A form's command as the App serves it: it creates records, so it names none. */
export interface AppFormCommandReference {
  readonly enabledBy?: AppFlagGate;
  id: string;
  version: number;
  input: AppCommandField[];
  rules?: AppCommandRule[];
  /** Its signed-in form prepares its starting values as it opens: the command declares `initial`, or an input starts
      as the reader (`default: me`). */
  prepares?: true;
  /** What its form and button are called (`defineCommand({ label })`); left out, the client says the command's name as words. */
  label?: string;
}

/** As served, where every `msg()` is said, a caption is text; as authored it may be a message. */
type SubmitLabel<Label> = [Label] extends [string] ? string : string | AppMessageRef;

export interface AppUpdateAction<Label extends string | AppMessageRef = string> {
  /** Its key in `resources.<table>.actions`: what a header, a queue and a role name it by. Served, never authored in the object. */
  id: string;
  label: Label;
  /** Column → value, as served: the stamps are the words `'now'` and `'me'` the server fills in; see ActionSetValue. */
  set: Record<string, string | number | boolean | null>;
  when?: string;
  confirm?: boolean;
  /**
   * A column this action asks a reason for and writes with its `set`. The
   * note is required, so a record never moves this way unexplained. Not with
   * `bulk`: a reason belongs to one record.
   */
  reason?: string;
  /**
   * Offered for a selection in a queue view. Each selected record is written
   * on its own through the ordinary update route and gate; the result is per
   * record, never one transaction over the selection. A property of the
   * action, so of the resource, App-wide.
   */
  bulk?: boolean;
  /** See `CommandActionBase.header`. */
  header?: boolean;
  /** The words on the button of the dialog this action opens (the confirmation, the reason), at most 60 characters; left
      out, the action's own label. A label that reads right as a button on the record (a noun) may read wrong as the
      dialog's submit, which is an instruction. */
  submitLabel?: SubmitLabel<Label>;
  command?: never;
}

export interface CommandActionBase<Label extends string | AppMessageRef> {
  label: Label;
  /** The words on the submit of the form (or the confirmation) this action opens, at most 60 characters; left out, the
      action's own label. A label that reads right as a button on the record (a noun) may read wrong as the dialog's
      submit, which is an instruction. */
  submitLabel?: SubmitLabel<Label>;
  /** A command collects what it needs through its own input. */
  reason?: never;
  set?: never;
  /**
   * A command that asks nothing runs on one click, and says so in a notice; `true` asks first, in its dialog. A
   * command with inputs asks them in its form, which is its confirmation, so it is refused there.
   */
  confirm?: boolean;
  /**
   * Offered for a queue selection only when the command declares
   * `targets: 'many'`: one request names every selected record, and the
   * handler applies all of them in one transaction or none.
   */
  bulk?: boolean;
  /**
   * `false` keeps the button out of the record's action bar and its menu, for
   * a verb the App runs from its own place — a custom component through
   * `useCommand`, a queue's selection, a board's lane. It is still the
   * resource's action: granted, judged and run as before; only that drawing
   * leaves it out.
   */
  header?: boolean;
  /** Command input → the App's own input component (`component(id, { module, kind: 'input' })`), drawn in its form in place of
      the platform's control. An input in a group is named by its path (`trade.vin`), and in a repeating group stands in
      every row; what the value must be is still the command's to judge. */
  inputs?: Readonly<Record<string, { readonly id: string; readonly module: string; readonly kind: string }>>;
  /** The command's own inputs this action's page supplies (`useCommand(name).open(record, { step })`): its form does not
      draw them, and sends what the page gave. A required one with no default is typed by no one, so the action says
      `header: false` and is not `bulk`: only a page opens it. The server judges the value as any other. */
  given?: readonly string[];
}

/** A command action as the App serves it. */
export interface AppCommandAction<Target extends string = string, Label extends string | AppMessageRef = string> extends CommandActionBase<Label> {
  /** Its key in `resources.<table>.actions`. */
  id: string;
  command: AppCommandReference<Target>;
  /** Where the button is offered: the command's own `when` and the action's together, or the states a machine's verb
      leaves. Visibility only; the server judges the command's. */
  when?: string;
  /** The action's own `when` alone, when it has one: what a record's bar asks, since the server's availability answer
      already holds the command's. */
  offered?: string;
  /** A machine's verb that says itself differently from different states (a per-edge `label`, or `{to}` in it):
      each label with the states it is said from, as a condition. `label` is the first state's. */
  labels?: Array<{ when: string; label: string }>;
  /** A machine's command verb's steps: the column, and each state it leaves with a state it leads to. A board by that
      column moves a card through the command, so a drop is the verb with its rules, its effects and its audit: onto
      the lane its step from the card's state leads to, or, where it leads to several and the command's input names
      the column (`moveDeal` with `{ stage }`), onto any of them, filled in as that input. */
  move?: { column: string; edges: Array<{ from: string; to: string }> };
  /** Set by the server when the command keeps no receipt for the browser's requests (its `track` is none): an
      answer lost on the way back is checked on the record, since there is nothing to look it up by. */
  untracked?: true;
}

/** A resource action as the App serves it. */
export type AppAction<Target extends string = string, Label extends string | AppMessageRef = string> = AppUpdateAction<Label> | AppCommandAction<Target, Label>;

/** The authored spelling of a page and its sections — the plain data a pages/ file and the config file (mistri.json) hold — as the
    page rules write it back (packages/engine/src/shared/page.ts `sectionConfig`, `pageConfig`). The App framework's types say what it
    is: packages/mistri/schema/app.d.ts fills these shapes in with `Plain<PageSection>` and `Plain<AppPage>`, so a rule that writes a
    section the authored types refuse does not compile, while the engine names none of the App's authoring types.
    Read without them, a section is plain data with a kind and a page plain data with a base. */
export interface AuthoredPageShapes {}
export type AuthoredSection = AuthoredPageShapes extends { section: infer Section } ? Section : { kind: string; [key: string]: unknown };
export type AuthoredPage = AuthoredPageShapes extends { page: infer Page } ? Page : { base: string; sections?: readonly AuthoredSection[]; [key: string]: unknown };
