/**
 * The App as the browser is served it, in the shapes the shared client draws: a resource's New form, its display
 * rules, its files, tags and machine, the landing and a dashboard's first run, a nav node and a document. They
 * are the engine's so the kit can draw a served App without reading the App framework's model; the App's
 * authoring and resolving modules (appModel.ts, app.ts, formRules.ts, appResourceRules.ts, appPayload.ts,
 * appUnions.ts) re-export each one where it was named before.
 */
import type { AppAction, AppCommandReference, AppFormCommandReference, StaticAppTarget } from '../../schema/model.js';
import type { ComponentDecl } from './appComponents.js';
import type { DefinedBinding } from './definedFields.js';
import type { TextRule } from './textRules.js';
import type { AppIconName } from './appIcons.js';
import type { FormCondition, FormScalar, FormStep, FormStyle } from './formValues.js';
import type { AppNoun, DisplayTone } from './model.js';

/** What a diagram needs of a flows binding: where the steps are, whether a step of an App kind waits for a word or only runs. */
export interface ServedFlowDiagram {
  steps: string;
  kinds?: Record<string, 'asks' | 'runs'>;
  run?: true;
}

/** A machine as the browser reads it (appMachine.ts): the stepper, a board's lanes and a history line's words. */
export interface ServedMachine {
  column: string;
  states: { value: string; label: string; final?: true }[];
  path: string[];
  /** Its named groups of states (`status is onBench`), which a menu count reads as it reads `is open`. */
  groups?: Record<string, string[]>;
}

export interface AppForm<Field extends string = string> {
  /** Every field the form asks, in order, rows read through. */
  show?: Field[];
  /** The fields as rows, where any row holds more than one (at most three side by side, one column on a narrow form);
      authored as inner lists of `show` or of the groups' fields: `[['email', 'phone'], 'company']`. */
  showRows?: Field[][];
  /** Literals, or the words `today`, `now` and `me`, which the form fills in as it opens (formDefaults.ts). */
  defaults?: string extends Field ? Record<string, FormScalar> : Partial<Record<Field, FormScalar>>;
  /** The values taken from a referenced record, authored in `defaults` as `{ from: 'service_id.price' }`: column →
      `reference.column`. The form refreshes each as its reference is chosen, until the person edits it; the
      server fills one a new record leaves out (appValidation.ts). */
  derived?: string extends Field ? Record<string, string> : Partial<Record<Field, string>>;
  /** Presentation only; members must be unique, shown and readable. */
  groups?: { label: string; description?: string; fields: Field[]; rows?: Field[][] }[];
  description?: string;
  /** The frame: a drawer over the list, or a page of its own (formFrame in form.ts decides when absent). */
  open?: 'drawer' | 'page';
  /** Each field's caption, help, placeholder, lines and — for a reference — the choices it narrows to. */
  fields?: Partial<Record<Field, AppFormField<Field>>>;
  /** Each field shown only while the draft matches its condition. Visibility
      never changes field access or resource validation. */
  when?: Partial<Record<Field, FormCondition>>;
  /** Finite presentation steps; each field is owned by exactly one step. */
  steps?: FormStep<Field>[];
  /** How the steps are drawn: the stepper (default) or the intake style. */
  style?: FormStyle;
  /** Bounded one-hop child collections; persistence is owned by a later write contract. */
  children?: FormChildGroup<Field>[];
  /** Child rows asked as a grid under the fields and inserted with the record, in its transaction. */
  lines?: FormLines[];
  /** The resource's computed columns and rollups said under the fields as they are typed (formLines.ts). */
  live?: string[];
}

/** One collection of a New form's child rows: a related list's words, its rows typed rather than read. */
export interface FormLines {
  /** The collection's caption over its grid. */
  label: string;
  /** The resource of the rows. */
  from: string;
  /** The column of those rows that points at the new record; the server fills it. */
  whose: string;
  /** The row's columns asked, in order. */
  show: string[];
  /** The column each row's place is kept in, numbered 1, 2, 3 as the rows stand. */
  order?: string;
  min?: number;
  max?: number;
}

/**
 * A public landing page: the signed-out front door of an App that signs
 * people in, at `/{app}` (and `/{app}/welcome` for anyone). Content only —
 * a headline, calls to action, a few sections of plain text — so serving it
 * reads no database and shows nothing of the App's schema, roles or
 * navigation. Every string is plain text and is drawn as text; every link is
 * `https:`, `mailto:` or `tel:`, checked at load.
 */
export interface AppLanding {
  /** The browser title; the App's name when absent. */
  label?: string;
  hero: LandingHero;
  sections?: LandingSection[];
  /** The App's `ui.footer`, put here by the server as the landing is served. */
  footer?: LandingFooter;
}

export interface LandingHero {
  /** The page's one heading. */
  heading: string;
  description?: string;
  /** One to three calls to action; the first is primary unless it says otherwise. */
  actions: LandingAction[];
  /** A wide lead photo: one row of a file resource the public reads. */
  image?: LandingImage;
  /** Where the photo sits: beside the words (`split`, the default with an image) or behind them (`overlay`). */
  layout?: LandingHeroLayout;
  /** The search panel, inside the hero: the search section's keys without its title. */
  search?: LandingSearch;
  /** Up to four short items, said as one quiet line under the actions. */
  highlights?: string[];
  /** A short pill over the heading, with an App icon where it names one. */
  badge?: LandingBadge;
  /** Two to four photos as tiles beside the words, in place of `image`: rows of a file resource the public reads. */
  tiles?: LandingImage[];
  /** Up to four icon rows under the actions, each an App icon and a short line; not with `highlights`. */
  points?: LandingPoint[];
}

export interface LandingBadge {
  text: string;
  icon?: AppIconName;
}

export interface LandingPoint {
  icon: AppIconName;
  text: string;
}

/** One row of a resource whose rows are files, by its key, and what it shows for a reader who cannot see it. */
export interface LandingImage {
  from: string;
  key: string | number;
  alt: string;
}

/** A search over a list view: some of its own filters, submitted as that list's conditions. */
export interface LandingSearch {
  view: string;
  filters: string[];
  submitLabel?: string;
}

export type LandingHeroLayout = 'split' | 'overlay';

export type LandingActionIntent = 'primary' | 'secondary';

/** A call to action: a public form the App declares (`/{app}/form/{id}`), a view a signed-out visitor may open, or staff sign-in. */
export type LandingAction =
  | { label: string; view: string; intent?: LandingActionIntent }
  | { label: string; signIn: true; intent?: LandingActionIntent };

export interface LandingItem {
  title: string;
  description: string;
}

export interface LandingQuestion {
  question: string;
  answer: string;
}

/** `href` is `https://…`, `mailto:…` or `tel:…`; nothing relative, nothing else. */
export interface LandingLink {
  label: string;
  href: string;
}

export interface LandingFooter {
  text?: string;
  links?: LandingLink[];
}

export type LandingSection =
  | { kind: 'features'; title?: string; items: LandingItem[] }
  | { kind: 'steps'; title?: string; items: LandingItem[] }
  | { kind: 'faq'; title?: string; items: LandingQuestion[] }
  | { kind: 'text'; title?: string; text: string }
  | { kind: 'callToAction'; title: string; description?: string; actions: LandingAction[] }
  | { kind: 'contact'; title?: string; items: LandingLink[] }
  /** A list view's rows as its cards, read through `auth.public`: the few `sort` puts first. */
  | { kind: 'view'; title?: string; view: string; limit?: number; sort?: string }
  /** A search over a list view: its own filters, submitted as that list's conditions. */
  | ({ kind: 'search'; title?: string } & LandingSearch);

/** One step of a dashboard's first run: a list view to start, said as the reader's next action. */
export interface AppFirstRunStep {
  label: string;
  view: string;
  /** A line under the label: what the records are for. */
  detail?: string;
  /** Served, never authored: the view's table, whose first row marks the step done. */
  table?: string;
}

/** Who an @ in a rich text value names. */
interface AppMentions {
  from: string;
  by: string;
  labelColumn?: string;
  groups?: { from: string; by: string; labelColumn?: string; through?: string };
}

/**
 * How one column's values dress, everywhere they appear: grids, record
 * fields, dashboard metrics. Declared on the column inside its resource's
 * block and resolved against the schema at startup like everything else.
 */
export interface AppDisplayRule {
  /** money: currency formatting. percent: the value is 0–100, shown with %.
      number: separators forced on a numeric-looking text column. relative:
      a date said from today — "in 3 days", "64 days ago" — with the date
      itself in the tooltip. email, phone, url: the value is a link — to write
      to, to call, to open beside the App — where it has that shape. An App
      links a column named like one (`email`, `phone`, `website`) without a rule. richText: the value is
      sanitized HTML (shared/richText.ts), drawn formatted on a record, as an excerpt in a list, edited in the
      rich text editor; every write of the column is sanitized on the server, and Markdown is read into it. */
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
      monospace), `sans` (the interface's reading face) or `code` (always monospace, for a VIN or a hash):
      `display: { vin: { face: 'code' } }`. Left out, an App sets a key, a reference, a code or a QR value in the
      data face and any other text in the reading face, because a name is not compared character by character.
      A rule with a `component` takes no face, the component sets its own; `masked: true` takes none either. */
  face?: 'data' | 'ui' | 'code';
  /** With format "rating": how many stars the scale has, 3 to 10 (5 when unsaid). */
  outOf?: number;
  /** With format "percent": the value as a small ring, filled against 100, beside the figure. */
  ring?: true;
  /** A number edited by dragging along its range, the figure said beside it; drawn as the number elsewhere. */
  slider?: { min: number; max: number; step?: number };
  /** A text entered by the camera where the browser reads codes (BarcodeDetector), typed otherwise. */
  scan?: true;
  /** A signature drawn (or a name typed) and kept as a PNG row of the file resource the column points at. As
      authored, `true`; resolved against a catalog, the file resource's table id (absent where it does not resolve). */
  signature?: true | { table: string; key: string };
  /** Value → one of the theme's chart colors, 1 to 8: a category's own color — a board card's chip and stripe, a
      chip in a cell — kept apart from `tone`, which says meaning. A value it does not name takes a color of its
      own, fixed by its words. */
  colors?: Record<string, SeriesColor>;
  /** A mark in a tinted square before the value: a list's first column led by what each row is. `{ mark, tone }`
      tints the square by the tone another column's rule gives the row — a failed run's square in the bad tone. */
  icon?: { mark: AppIconName; toneOf?: string };
  /** With format "richText": who an @ names — the resource of people, the column stored as the handle, the column shown —
      and, with `groups`, the teams an @ may name as well: their resource, handle and shown column, and `through`, the
      resource of link rows that puts a person in a team (absent: the people resource's own reference to the team). */
  mentions?: AppMentions;
  /** With format "richText": the file resource a picture pasted or dropped in is kept in, as an attachment of the record. */
  images?: string;
  /** true: a short placeholder is drawn instead of every value, everywhere, the record's name included.
      `{ prefix }`: only the values that start with it (`ENC:` ciphertext, a `tok_` token), said as the prefix and a
      placeholder; any other value is drawn by the rest of the rule. Presentation, not protection: the value still
      reaches the browser, and `hidden` is what keeps it there. */
  masked?: true | { prefix: string };
  /** ISO 4217, for "money". Defaults to the App's `ui.currency`, else USD. */
  currency?: string;
  /** For "money": the column of the same record each row's currency code is read from (the authored
      `currency: { column }`); `currency` stays the fallback where a row holds none. */
  currencyColumn?: string;
  /** For "money": the column holds whole minor units (money.ts), drawn and edited as the major figure. */
  minor?: true;
  /** With "number", "money" or no format on a numeric column: the unit said after the figure — "mi", "kg", "/mo" (a leading slash
      joins without a space: "$242/mo"). At most 12 characters. */
  unit?: string;
  /** Value → tone: the value renders as a coloured pill. Keys are values,
      thresholds (">= 5") or "*" for every value no other key names. */
  tone?: Record<string, DisplayTone>;
  /** Draw the value as a small bar beside it: against 100 for format "percent", against `max` for any other
      number. A tone rule colours the bar. Authored as `bar: true` (a percent) or `bar: <max>`. */
  bar?: boolean;
  /** With `bar` on a number: the value that fills the bar (the authored `bar: 5`). */
  max?: number;
  /** An initials disc before the value: a person's or a company's name. Given a file resource
      (`{ from: 'member_avatar', whose: 'member_id' }`), the disc is the record's photo — its first file,
      drawn through the file route under the reader's grants — and the initials where there is none. */
  avatar?: true | AppAvatarPhoto;
  /** Value → one of the App icons, drawn before the word: priority as signal bars, a status's mark. It stands
      where a tone's dot would, in the tone's colour; the word stays, so the value is still said. */
  icons?: Record<string, AppIconName>;
  /** Value → the word it is said as: `{ PUB: 'Published' }`. The stored value stays what sorts, filters and is
      written; `tone` and `icons` are still keyed by it. */
  values?: Record<string, string>;
  /** Every value no `values` key names said as words (`IN_REVIEW` → "In review"): the authored `values: true`,
      and implied by `values: { … }`, so a vocabulary never reads half in words and half in codes. */
  humanize?: true;
  /** Another column of the same record, said as a muted second line under the value in lists. */
  subtitle?: string;
  /** A value renderer: the author's component draws the value in an App (appComponents.ts); sort, filter,
      totals and export keep the raw value, and the rest of the rule dresses it until the renderer arrives. */
  component?: ComponentDecl;
}

/** A person's photo for an avatar: the first file of a file resource whose `whose` column names the record. */
export interface AppAvatarPhoto {
  /** A resource whose rows are files (`file` on the resource). */
  from: string;
  /** Its column that points at the record the avatar is of. */
  whose: string;
  /** Which file leads where a record has several, written like the query bar: "position", "added_at desc". */
  sort?: string;
}

/** One of a theme's eight chart colors, by place: a category's color, a menu item's dot. */
export type SeriesColor = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** A resource whose rows are files: the column holding the bytes, the one naming them, and where an upload's type and size go. */
export interface AppFileDef {
  content: string;
  name: string;
  type?: string;
  size?: string;
  /** A binary column holding a smaller copy of the picture, sent for `?variant=thumb` (a card, a gallery strip). */
  thumbnail?: string;
  maxBytes?: number;
  /** A text column holding the key of the file's object when its bytes are in `bucket` (null while they are in `content`). */
  object?: string;
  /** A text column given the SHA-256 of the bytes (hex) on every upload: the file's tag wherever its bytes are. */
  hash?: string;
  /** Where a new upload's bytes go: `content` ('database', the default) or `bucket`. A row is read from wherever it says. */
  storage?: 'database' | 'bucket';
  /** The S3-compatible bucket the bytes are kept in; its credentials are the server's (MISTRI_S3_*), never the App's. */
  bucket?: AppFileBucket;
}

/** An S3-compatible bucket: AWS S3, Cloudflare R2, MinIO, Backblaze B2, Tigris. */
export interface AppFileBucket {
  name: string;
  /** The provider's region (R2: 'auto'); us-east-1 when unsaid. */
  region?: string;
  /** The provider's S3 endpoint; AWS S3 when unsaid. */
  endpoint?: string;
  /** The bucket in the path rather than the host name (MinIO). */
  pathStyle?: boolean;
  /** Put before every key, to share a bucket: `files/`. */
  prefix?: string;
  /** A download redirects to a URL signed for a minute instead of passing through the server. */
  presign?: boolean;
}

/** A resource's tags: the link table, the table of tags, and the column of it that holds a tag's tone. */
export interface AppTagsDef {
  through: string;
  to: string;
  toneOf?: string;
  /**
   * The commands that put a tag on a record and take it off, each on the
   * record with the tag's key as its `tag` input; named, the picker runs
   * them instead of writing link rows, so a role that runs them needs no
   * write on the link table.
   */
  add?: AppCommandReference;
  remove?: AppCommandReference;
}

/** A bounded, one-hop child collection used by a form authoring contract.
 * It is deliberately not a persistence instruction: the parent transaction
 * still owns how records are created and linked. */
export interface FormChildGroup<Field extends string = string> {
  id: string;
  label: string;
  table: string;
  relation: { from: Field; to: Field };
  min?: number;
  max: number;
  form?: Omit<AppForm<Field>, 'children'>;
}

/** One field's dress on a resource's New form. Presentation, except `where`,
 * which the server enforces on every write (server appValidation.ts). */
export interface AppFormField<Field extends string = string> {
  label?: string;
  help?: string;
  placeholder?: string;
  multiline?: boolean;
  /** How a vocabulary or a flag is drawn when the record is filled in: cards, buttons, radios or a listbox. */
  as?: 'cards' | 'buttons' | 'radios' | 'select';
  /** The referenced table's column → this form's field whose value it must equal. */
  where?: Record<string, Field>;
}

/** A resource's tags resolved against the catalog: the link table, its reference back to the record and out to the tag, and how a tag is named. */
export interface AppTagRule extends Omit<AppTagsDef, 'toneOf'> {
  /** The tag's column whose value is its chip's tone: the authored `toneOf`, read off each tag row. */
  tone?: string;
  /** The link column holding the record's key, and the record's column it points at. */
  from: string;
  key: string;
  /** The link column holding the tag's key, and the tag's column it points at. */
  via: string;
  tagKey: string;
  /** The tag's naming column. */
  label: string;
}

/** What a served union table carries: each branch the reader can read, its record key column beside its columns. */
export interface UnionTable {
  branches: ReadonlyArray<{ from: string; key: string; as: Readonly<Record<string, string>> }>;
}

/** A nav node as served: a reference carries the menu's word, its view's label when nav gave none. */
export type AppPayloadNavNode =
  | { view: string; label: string; color?: SeriesColor }
  | { label: string; to: StaticAppTarget; color?: SeriesColor }
  | {
      group: string;
      label: string;
      icon?: import('./appIcons.js').AppIconName;
      placement?: 'footer';
      inline?: true;
      folded?: true;
      children: AppPayloadNavNode[];
    };

/** A record on paper, as its verb and its address need it (appDocuments.ts). */
export interface AppPayloadDocument {
  id: string;
  /** Its record's table id. */
  base: string;
  label: string;
  size?: import('./appDocuments.js').DocumentSize;
}

/** The views a New menu entry may name, by key. */
type Views = Readonly<Record<string, object>>;

/** Optional App presentation overrides. Omitted settings keep the existing UI. */
export interface AppShell {
  /** Where the nav lives: the sidebar (default), or a top bar under the
      header, the web-app shell; or `{ top: roles }`, the top bar for a
      principal whose every role is listed (appViewRoles.ts topBarFor),
      said as one of the two when the App is served. */
  placement?: (typeof PLACEMENTS)[number] | { top: string[] };
  /** With the side placement: folding the sidebar leaves a rail of the
      entries' icons by default. Set false to hide it completely. */
  rail?: boolean;
  /** Show the sidebar menu filter. Defaults to false in Apps. */
  menuSearch?: boolean;
  /** Show live row counts beside the App menu's lists of work: a list whose condition picks its machine's unfinished states, a date at or before today (said in the danger's ink), or the reader (me). A list's own count: true or false says otherwise. Defaults to false; Workbench estimates remain. */
  counts?: boolean;
  /** false hides the header's search (the box and its button) from everyone. By default a member sees it and a
      signed-out visitor does not, having nothing of their own to search; `{ signedOut: true }` offers it to a
      visitor too, for an App whose public pages are worth searching. */
  search?: 'members' | 'everyone' | false;
  /** false hides the crumb bar above a room. Default true. */
  breadcrumbs?: boolean;
  /** false keeps a room's heading for a screen reader only. Default true. */
  heading?: boolean;
  width?: 'full' | 'wide' | 'narrow';
  /** Align header contents to width/gutter; its background and border remain full width. */
  headerWidth?: 'full' | 'content';
  gutter?: 'none' | 'compact' | 'normal' | 'comfortable';
  /** Sidebar-specific presentation. This is static App chrome, never a tenant
      or account switcher. */
  sidebar?: AppSidebar;
  /** The header's New menu: each way to make something, by the list
      whose New form it opens or the signed-in form (or the command such a form
      runs) it opens. Each reader sees the entries they may use (appNewMenu.ts). */
  new?: AppShellNew[];
}

/** One entry of the header's New menu: a view, or the command a signed-in form runs, and the heading of the group it
    was written under (`{ label, children }`), which parsing flattens onto each of its entries. */
export type AppShellNew = ({ view: string } | { command: string }) & { label?: string; icon?: AppIconName; group?: string };

/** Optional presentation for a roomier side menu and its fixed workspace identity. */
export interface AppSidebar {
  /** Compact keeps the ordinary menu rhythm; comfortable gives rows more room. */
  density?: 'compact' | 'comfortable';
  /** Static identity at the bottom of the sidebar. It has no switching behaviour. */
  footer?: { title: string; description?: string };
}

export const PLACEMENTS = ['side', 'top'] as const;

/** An entry as served: the view it opens, the command that view runs when it is a form, and its words. */
export interface ServedShellNew {
  view: string;
  command?: string;
  label?: string;
  icon?: AppIconName;
  /** The heading of the group it was written under. */
  group?: string;
}

/** What the browser needs to judge one entry. */
interface NewMenuReader {
  /** The commands this reader may run, where the server said; absent, none. */
  grantedCommands?: readonly string[];
  /** Whether this reader may add a row to a table. */
  canAdd(table: string): boolean;
}

/** One line of the menu: what it says, its mark, and what it opens. */
export interface NewMenuEntry {
  view: string;
  label: string;
  icon?: AppIconName;
  /** The list whose New form it opens; absent, the view is a form. */
  table?: string;
  /** The heading it is drawn under; absent, none. */
  group?: string;
}

/**
 * The entries this reader may use, in the App's order. Its words are the
 * entry's own, else a list's noun ("Ticket", its resource's singular) or the
 * form's heading.
 */
export function newMenuEntries(
  served: readonly ServedShellNew[] | undefined,
  views: Views,
  reader: NewMenuReader,
  noun: (view: string, table: string) => string,
): NewMenuEntry[] {
  return (served ?? []).flatMap((entry): NewMenuEntry[] => {
    const view = views[entry.view] as (object & { label?: string; table?: string; error?: string }) | undefined;
    if (!view || view.error) return [];
    /* Its mark and its group's heading, where it has them. */
    const dress = {
      ...(entry.icon === undefined ? {} : { icon: entry.icon }),
      ...(entry.group === undefined ? {} : { group: entry.group }),
    };
    if (isServedForm(view)) {
      if (!reader.grantedCommands?.includes(view.command.id)) return [];
      return [{ view: entry.view, label: entry.label ?? view.label, ...dress }];
    }
    if (typeof view.table !== 'string' || !reader.canAdd(view.table)) return [];
    return [{ view: entry.view, label: entry.label ?? noun(entry.view, view.table), table: view.table, ...dress }];
  });
}

/* ---------- the served App, as the shared client reads it ---------- */

/** What a resource says about its rows, as one connection serves it, in what the shared client draws. The App's
    resolved resource (app.ts ResolvedResource) is this and its CSV import. */
export interface ServedResource {
  /** Column or label path → the App's caption, for the paths this catalog resolves. */
  labels?: Record<string, string>;
  /** The author-selected record name. `false` means a restricted catalog cannot show it; use primary keys only. */
  recordLabel?: string | false;
  /** Column → how its values dress, for the columns this catalog has. */
  display?: Record<string, AppDisplayRule>;
  /** Column → the App's own input component, for the columns this catalog has. */
  inputs?: Record<string, ComponentDecl>;
  actions?: AppAction[];
  form?: AppForm;
  /** The page its records open through. */
  page?: string;
  /** The list view its records are addressed through, the natural key column and the public slug (appAddress.ts). */
  view?: string;
  address?: string;
  slug?: true;
  /** Its records carry a Favorites star. */
  favorite?: true;
  /** Its one row is a settings record, opened from the reader's settings under these words. */
  settings?: string;
  /** What one record is called and several: New, a split's detail heading. */
  noun?: AppNoun;
  /** Its rows are files, as appFileRules resolved them: a list over it draws as attachments. */
  /* No upload flag rides with it: whether this reader may add a file is whether
     the catalog lets them insert a row, which a row policy decides like any write. */
  file?: AppFileDef;
  /** Its records carry tags, as appTagRules resolved them: chips under the record's title. */
  tags?: AppTagRule;
  /** Column → its text rule (textRules.ts), for the columns this catalog has: said under the field as it is typed. */
  text?: Record<string, TextRule>;
  /** JSON column → the resolved table whose rows define its fields, and the column that picks them (definedFields.ts). */
  defined?: Record<string, DefinedBinding>;
  /** Its machine, as the page draws it: the column, its states in order with their words, and the forward path the stepper walks. */
  machine?: ServedMachine;
  /** A `diagram` section on its page (PageFlowDiagram.tsx): the steps table it draws, and its kinds by what they do.
   * On a flows table its rows are flows; on a resource that runs them (`run`), the diagram is of its record's run. */
  flowDiagram?: ServedFlowDiagram;
}

/** A dashboard as the shared client reads it: its words and the screen it rides. Its sections, windows and reads
    are the App's (appModel.ts AppDashboardView), which only the App's dashboard draws. */
export interface ServedDashboardView {
  label: string;
  path?: string;
  heading?: string;
  description?: string;
  icon?: AppIconName;
  sections: readonly object[];
  favorite?: true;
  error?: string;
}

/** A signed-in form as the shared client reads it: its words and the command it runs (appModel.ts AppFormView). */
export interface ServedFormView {
  label: string;
  path?: string;
  icon?: AppIconName;
  description?: string;
  command: AppFormCommandReference;
  public?: true;
  error?: string;
}

/** Whether a view is a command form: the one kind of view that runs a command. */
export const isServedForm = (view: object): view is ServedFormView => Object.hasOwn(view, 'command');

/** The chrome as the shared client reads it: the shell's settings, the footer, export and the language row. The
    App serves more (appPayload.ts ServedUi). */
interface ServedAppUi {
  shell?: Omit<AppShell, 'new'> & { new?: ServedShellNew[] };
  footer?: LandingFooter;
  export?: boolean;
  localeRow?: { table: string; key: Record<string, string | number>; column: string };
}

/**
 * The App on screen as the shared client reads it (shellMode.ts `app()`): its views by key, its menu, the
 * resources' words, the documents a reader may open and the runtime answers the kit gates on. `View` is what a
 * view is to the reader: the App's payload (appPayload.ts AppPayloadApp) serves each in full.
 */
export interface ServedApp<View extends object = ServedDashboardView | ServedFormView | ({ table: string; label: string } & object)> {
  id: string;
  name: string;
  views: Record<string, View>;
  nav: AppPayloadNavNode[];
  home?: string;
  resources: Record<string, ServedResource>;
  documents?: AppPayloadDocument[];
  ui: ServedAppUi;
  writableTables?: string[] | false;
  exportableTables?: string[];
  grantedCommands?: string[];
  grantedActions?: Record<string, string[]>;
  assistant?: { page?: true; record?: true };
}

/** A menu node as the view order reads it: a view's reference, a group of nodes, or a link elsewhere. */
export type ServedNavNode = { view: string } | { group: string; children: readonly ServedNavNode[] } | { to: unknown };

/** The view keys nav references, depth first: the menu's order. */
export function navViewKeys(nav: readonly ServedNavNode[]): string[] {
  return nav.flatMap((node) => ('group' in node ? navViewKeys(node.children) : 'view' in node ? [node.view] : []));
}

/**
 * Every view key in the order rooms are listed: the menu's, then the views
 * nav does not reference (a home nav does not list, and a list view only a
 * dashboard embeds). Never the keys'
 * own order — an object puts a key like "2024" before every other.
 */
export function viewOrder(app: { views: Readonly<Record<string, unknown>>; nav: readonly ServedNavNode[] }): string[] {
  const keys = navViewKeys(app.nav).filter((key) => Object.hasOwn(app.views, key));
  return [...keys, ...Object.keys(app.views).filter((key) => !keys.includes(key))];
}

/** The assistant's own room, where its App gives it a page (`placement: 'page'`, appAssistant.ts): its word in
 * nav, and its address, `/{app}/assistant` and `/{app}/assistant/{conversation}` for one conversation. */
export const ASSISTANT_ROOM = 'assistant';
