/*
 * The page model: what a page and each kind of section hold, and the bounds
 * the parser, the planner and the JSON schema share. Types and constants,
 * and the one word rule a workflow step's label defaults to, which the
 * record page reads on first paint without the parser; page.ts says how a page resolves and validates, pageConfig.ts how
 * one is read.
 */
import type { RelatedCreate } from '../../schema/model.js';
import type { AppListEmpty } from './listPresentations.js';
import type { FigureFormat } from './model.js';
import { type TableSizing } from './tableSizing.js';
import { maskQuoted } from './maskQuoted.js';

/**
 * How much of a row a section takes.
 *
 * Three widths, not a number of grid columns. A section is a piece of
 * content, and "half" survives a narrow window and a wide one where "columns
 * 4 through 9" needs a breakpoint table to mean anything. It is also the
 * whole of the layout language, which keeps a page reviewable as text.
 */
export type SectionWidth = 'full' | 'half' | 'third' | 'two-thirds';

export const WIDTHS: readonly SectionWidth[] = ['full', 'half', 'third', 'two-thirds'];

/**
 * Empty space beside a section, in the same fractions widths come in.
 *
 * An offset is how a page says *where* a section sits, not just how wide it
 * is: a half-width list pushed to the right half, a metric centred by a
 * quarter on each side, a third-width card in the middle column. `quarter`
 * exists only here — it is not a useful width, but it is exactly half of
 * what centres a half. */
export type SectionOffset = 'quarter' | 'third' | 'half' | 'two-thirds';

export const OFFSETS: readonly SectionOffset[] = ['quarter', 'third', 'half', 'two-thirds'];

/**
 * How many columns a group of fields is laid out in.
 *
 * Absent means fit: as many columns as the section is wide enough for, which
 * is the right answer for a page nobody has arranged. A number is somebody
 * saying otherwise — and once they have, the layout must not reflow behind
 * them, because the point of arranging fields is that they stay arranged.
 */
export type FieldColumns = 1 | 2 | 3;
export type SectionRegion = 'main' | 'aside';
export const SECTION_REGIONS: readonly SectionRegion[] = ['main', 'aside'];

export const FIELD_COLUMNS: readonly FieldColumns[] = [1, 2, 3];

/**
 * The base record's own fields, or a to-one reference's, pulled inline.
 *
 * More than one of these is a page with its fields *grouped*: a record with
 * forty columns is not one list, it is "the identity", "the money" and "the
 * dates", and a form that says so is readable where a forty-row grid is not.
 * `paths` is ordered, and the order is the layout — fields fill the columns
 * left to right, so moving a field between columns is moving it in the list.
 */
export interface ResolvedWorkflowStatus {
  field: string;
  steps: Array<{ value: string; label: string }>;
  /** The steps are an order: those before the current one draw as passed. The author's statement, not a history. */
  ordered?: true;
}

export interface PageFields {
  kind: 'fields';
  region?: SectionRegion;
  /** The tab of the record's section strip this section is drawn in; sections sharing a name share a panel. */
  tab?: string;
  title?: string;
  /** Paths relative to the root. Empty means "whatever the schema suggests". */
  paths?: string[];
  width?: SectionWidth;
  /** Empty space to the left / right of this section. */
  offsetLeft?: SectionOffset;
  offsetRight?: SectionOffset;
  hidden?: boolean;
  /** Shown only when the root record matches this condition, in the query
      language: "status = converted". Judged against the base table. */
  when?: string;
  /** Fixed number of columns. Absent fits the section's width. */
  columns?: FieldColumns;
  /**
   * Show each reference as the record it names — "Waikato Freight", not
   * `110` — fetched as one more joined column per reference. Honoured only
   * in app mode: the workbench reads ids, because ids are the truth and
   * this is a reading of them. On by default in app mode; false opts out.
   */
  names?: boolean;
  /** `summary`: compact properties.
      `headline`: the first field as a large figure, the rest a row of facts, with `actions` beside.
      `facts`: the values alone in one line, each after a dot — "2019 · 85,780 mi · Electric" — their
      captions kept for assistive technology. `table`: a sheet of caption and value rows, empty values left out.
      `properties`: the record form's property rail — caption beside value, a hairline between rows, every
      field kept (an empty one is where a value is set) and editable in place where the record may change. */
  presentation?: 'summary' | 'headline' | 'facts' | 'table' | 'properties' | 'card' | 'header';
  /** `fields`: each property is picked or typed in place; where the reader may not write the column, an action of theirs that sets it is offered as the picker. */
  edit?: true;
  /** `header`: the record's head as the author says it (a `header` section, DSL `header({ … })`), drawn in the head wherever it is
      written — `paths` are its facts line, `status` the column whose tone is the chip beside the name. */
  status?: string;
  /** `header`: the fact path → the word said after its value ("3 beds") or before it ("Born …"), a card fact's `{ column, after }` or `{ column, before }`.
      The page's reading of the header's facts, not authored: an App writes the word in `facts` itself,
      `header({ facts: [{ column: 'steps', after: 'step' }] })`, and `header` refuses `factLabels`. */
  factLabels?: Record<string, import('./appCards.js').FactLabel>;
  /** `header`: the id of the one action drawn filled; else the first that is not destructive. */
  primary?: string;
  /** `header`: action ids drawn last and quiet, never as the filled button. Update actions that ask for a
      confirmation, or set a value the display tones call bad, are destructive without being named. */
  destructive?: string[];
  /** `header`: the action ids the head draws, in order; the rest of the record's verbs are in More. */
  headerActions?: string[];
  workflow?: ResolvedWorkflowStatus;
  /** A headline's calls to action, each opening one of the App's views. */
  actions?: PageHeadlineAction[];
  /** A headline's second figure, under the first and smaller: an estimate, a unit price. */
  subfigure?: string;
  /** A headline's earlier value of its figure — a was-price — struck through beside it when it has one above the figure. */
  was?: string;
  /** A headline's line of small print under its actions: what the figures assume. */
  note?: string;
}

/**
 * A call to action on a headline: the landing's shape, a label and the key of
 * one of the App's views. A form's inputs may start filled: `prefill` from
 * this record's fields (input → field path), `defaults` with the author's text.
 * They are where the form starts, never what it sends: the reader sees and may
 * change them, and the command checks them as it checks anything typed.
 */
export type PageHeadlineAction =
  | {
      label: string;
      to: import('./appLinks.js').AppTarget;
      intent?: 'primary' | 'secondary';
      open?: never;
      prefill?: never;
      defaults?: never;
    }
  | {
      label: string;
      view: string;
      intent?: 'primary' | 'secondary';
      prefill?: Record<string, string>;
      defaults?: Record<string, string>;
      /** `'modal'` opens a form (public, or a signed-in form view) over the record instead of navigating to
      it. The record is the reason the form is being filled in — a price, a
      photograph, a mileage — and sending someone to a page of their own to
      ask about it takes the thing they were looking at away. The address
      still works: the link is a link, and a new tab or a middle click opens
      the form's own page. Absent means the page. */
      open?: 'modal';
    };

/**
 * One number about a relationship.
 *
 * `count` needs no column; everything else does — "sum of work_order" is not
 * a question, and the failure to say which column is the mistake worth
 * catching at parse time rather than at query time.
 */
export interface PageMetric {
  kind: 'metric';
  region?: SectionRegion;
  /** The tab of the record's section strip this section is drawn in; sections sharing a name share a panel. */
  tab?: string;
  title?: string;
  fn: 'count' | 'sum' | 'min' | 'max' | 'avg';
  /**
   * The table being summarised and how it reaches the root, exactly as a list
   * says it. A metric is a list you did not want the rows of.
   *
   * Config spells these `from`/`whose`/`about`; the compiled PageDef keeps
   * the field names the planner and the builder always used. parseSection is
   * the one place the two meet.
   */
  from: string;
  path: string;
  /**
   * A section about a record the root points at, rather than about the root.
   *
   * One forward reference from the base — `site_id` on a work order — and
   * `whose` then leads back to *that* table: "tickets at this order's site"
   * is `{ "from": "ticket", "whose": "site_id", "about": "site_id" }`.
   * Absent means the root itself.
   */
  of?: string;
  column?: string;
  /** Narrows what is counted: "open orders", not "orders". */
  filter?: string;
  /** How the figure is said, as a dashboard metric's: `percent` (the figure is 0–100, said with %), `number`, or
      `money` in the App's currency. Absent, a measure of one column takes that column's display rule. */
  format?: FigureFormat;
  /** A word said after the figure: `'of 5'`, `'days'`. */
  unit?: string;
  width?: SectionWidth;
  offsetLeft?: SectionOffset;
  offsetRight?: SectionOffset;
  hidden?: boolean;
  /** Shown only when the root record matches this condition, in the query
      language: "status = converted". Judged against the base table. */
  when?: string;
}

/**
 * Rows related to the root.
 *
 * `from` is the table listed and `path` (config: `whose`) is how a row of
 * it names the root — `customer_id` for the customer's own orders,
 * `invoice_id.customer_id` for the lines of those orders. One hop or four,
 * it is the same field: the walk this tool is built on, written down.
 */
/** A matched list's match: `related('Similar vehicles', 'vehicle', { same: ['body_type'], near: { price: 0.25 } })`. */
export interface PageSimilar {
  /** One to four columns, each on `from` and on the page's own table, whose value a listed row shares with the record. */
  same: string[];
  /** Up to two numeric columns, each within ± this fraction of the record's value: 0.25 is ±25%.
      The first is also the order: closest first. */
  near?: Record<string, number>;
}

/* A group opens to at most GROUP_ROWS_MOST rows ("Show all"), and a page of groups holds at most GROUPS_MOST: a header's
   facts ride on its rows, so the bound is also the bound on the reads. */
/**
 * A related list read as groups: one header for each record (or value) its rows point at through `by`, and that group's
 * rows under it, a page of groups at a time. One level only — the second level of a chain is a fact on the header.
 */
export const GROUP_ROWS_MOST = 50;
export const GROUP_ROWS_DEFAULT = 5;
export const GROUPS_MOST = 10;
export const GROUPS_DEFAULT = 5;
export interface PageGroup {
  /** A path from the listed rows to the record (or column) they are grouped under: `estimate_id`. */
  by: string;
  /** Columns of the grouped record, said in the header as facts. Only where `by` ends at a reference. */
  show?: string[];
  /** The groups' order, on the grouped record's own columns: `created_on desc`. Absent, the largest group first. */
  sort?: { column: string; direction: 'asc' | 'desc' };
  /** Groups to a page; `PageList.limit` is the rows to a group. */
  limit?: number;
  /** What the group of rows with no value is called, where "No <the column>" would not do ('Backlog'). */
  empty?: string;
  /** One or two numeric columns, rollups or computed numbers of the listed rows, summed over every row of each group
      and said in its header after the count. Unlike `PageList.totals` it works beside a `query`. */
  sum?: string[];
}

export interface PageList {
  kind: 'list';
  sizing?: TableSizing;
  /** `gallery`: a related list of image files drawn as a lead photo and thumbnails.
      `card`: the one current row (limit 1, chosen by the filter and sort) as a card.
      A cards object: the rows as cards, in the list view's own cards grammar. */
  presentation?: 'gallery' | 'card' | import('./appCards.js').AppCardsList | import('./appComponents.js').CustomListPresentation;
  /** An embedded list view's board or calendar (`embed(view)`, appPages.ts): the page draws it as the view does,
      narrowed to the record. Never authored on a related list, so it is no `presentation` (which the parser governs). */
  lanes?: import('./listPresentations.js').AppBoardList | import('./listPresentations.js').AppCalendarList;
  /** Rows matched on the record's own values rather than through a reference: `related(title, from, { same, near })`.
      The record itself is left out when `from` is the page's own table. Such a list has no `path` (it is ''):
      its rows are not the record's children. */
  similar?: PageSimilar;
  /**
   * Written as `embed(view, { whose })`: the key of the App list view this
   * section draws, its rows narrowed to those pointing at the record. The
   * App's loader copies the view's table, show, query, sort and cards into
   * this list (appPages.ts, resolvePageEmbeds) — the related list is the one
   * drawing, so an embed and a related list cannot come to disagree — and
   * keeps the key, so the section says where it came from and its heading
   * opens the view's room. `from` stays empty until then.
   */
  view?: string;
  region?: SectionRegion;
  /** The tab of the record's section strip this section is drawn in; sections sharing a name share a panel. */
  tab?: string;
  title?: string;
  from: string;
  path: string;
  create?: RelatedCreate<string>;
  empty?: AppListEmpty;
  /** Authored `empty: 'hide' | 'collapse'` (or the page's): the section is left out while it has no rows, or said in one
      line with the other empty lists, rather than drawn empty. Where the reader may add a row, 'hide' collapses. */
  emptyMode?: 'hide' | 'collapse';
  /** Authored `group`: the rows under a header for each record they share, `limit` becoming the rows to a group. */
  group?: PageGroup;
  /** Numeric columns, rollups or computed numbers of `from` summed in one ruled footer row, over every row that points at the record. */
  totals?: string[];
  /** A ⋯ menu at the end of each row with the row's own actions and verbs, as its page offers them. */
  rowActions?: true;
  /** Authored `create: false`: no Add, where the reader could otherwise add a row from the list. */
  noCreate?: true;
  /** Authored `actions`: the page record's own verbs, by id, drawn in this list's head and not in the record's. */
  listActions?: string[];
  /** As on a metric: this list is about the record `of` reaches, not the root. */
  of?: string;
  /** Columns of `from` to show. Empty means a sensible default. */
  columns?: string[];
  /** Column path → the app's word for it, for the show entries that
      carried a label ({ column, label }); `columns` stays the bare paths
      the planner reads. */
  labels?: Record<string, string>;
  /** Extra narrowing, in the query language, resolved against `from`. */
  filter?: string;
  limit?: number;
  orderBy?: Array<{ column: string; direction: 'asc' | 'desc' }>;
  width?: SectionWidth;
  offsetLeft?: SectionOffset;
  offsetRight?: SectionOffset;
  /**
   * Kept in the page and not drawn.
   *
   * Removing a section throws away the columns, the order and the filter that
   * were chosen for it; hiding it keeps all of that and stops showing it,
   * which is what someone means by "not on this page for now". It is also how
   * a page arrives at a short form without anyone having to rebuild the long
   * one to get it back.
   */
  hidden?: boolean;
  /** Shown only when the root record matches this condition, in the query
      language: "status = converted". Judged against the base table. */
  when?: string;
}

/**
 * Grouped counts from a related table: the page's "N by status" answer.
 *
 * The question is the same one a list section asks — these rows, about this
 * record — grouped instead of listed. It compiles through the breakdown
 * machinery, which is why the page adds no query machinery of its own here
 * either.
 */
export interface PageBreakdown {
  kind: 'breakdown';
  region?: SectionRegion;
  /** The tab of the record's section strip this section is drawn in; sections sharing a name share a panel. */
  tab?: string;
  title?: string;
  from: string;
  path: string;
  /** As on a metric: this breakdown is about the record `of` reaches. */
  of?: string;
  /** What to group by: a column of `from`, or a dotted path ending in one. */
  by: string;
  /** What each bar measures, the dashboard's words read into fn and column: absent is a count.
      A sum may read a rollup of `from` (rollups.ts): a supplier's open value by warehouse. */
  fn?: 'count' | 'sum' | 'min' | 'max' | 'avg';
  column?: string;
  /** Extra narrowing, in the query language, resolved against `from`. */
  filter?: string;
  /** Groups shown, biggest first. */
  limit?: number;
  /** How each figure is said, as a metric's: `percent` (0–100), `number` or `money`; and a word after it. */
  format?: FigureFormat;
  unit?: string;
  width?: SectionWidth;
  offsetLeft?: SectionOffset;
  offsetRight?: SectionOffset;
  hidden?: boolean;
  /** Shown only when the root record matches this condition, in the query
      language: "status = converted". Judged against the base table. */
  when?: string;
}

/**
 * The same related rows, measured and drawn: a line over a bucketed key
 * ("month issued_on"), a donut over categories, or stacked bars over two
 * keys. It is the dashboard's chart about one record — the question a
 * breakdown section asks, with a measure and a shape — and it compiles
 * through the same breakdown plan, so it adds no query machinery.
 */
export interface PageChart {
  kind: 'chart';
  region?: SectionRegion;
  /** The tab of the record's section strip this section is drawn in; sections sharing a name share a panel. */
  tab?: string;
  title?: string;
  from: string;
  path: string;
  /** As on a metric: this chart is about the record `of` reaches. */
  of?: string;
  /** What to group by, in the breakdown grammar: "status", "month issued_on", or two keys for stacked bars. */
  by: string;
  /** The dashboard's words, read into fn and column: absent is a count. */
  fn: 'count' | 'sum' | 'min' | 'max' | 'avg';
  column?: string;
  /** "line" (the default), "bar", "donut" or "stacked", as on a dashboard chart. */
  shape?: 'line' | 'bar' | 'donut' | 'stacked';
  /** The order of a bar chart's or donut's categories: 'value' (largest first), 'category' (the key's own order), or a
      column of `from` with a direction, as a list's sort ("starts_on", "ended_on desc"). Absent, a category with an
      order of its own keeps it (see chartOrder, page.ts) and any other goes by value. */
  sort?: string;
  /** Extra narrowing, in the query language, resolved against `from`. */
  filter?: string;
  /** Groups drawn: a donut's slices, a stacked chart's bars. */
  limit?: number;
  /** The drawing's height in CSS pixels (120 or more). */
  height?: number;
  /** A goal ruled across a line or stacked bars. */
  target?: number;
  /** How each figure is said, as a metric's: `percent` (0–100), `number` or `money`; and a word after it. */
  format?: FigureFormat;
  unit?: string;
  width?: SectionWidth;
  offsetLeft?: SectionOffset;
  offsetRight?: SectionOffset;
  hidden?: boolean;
  /** Shown only when the root record matches this condition, in the query
      language: "status = converted". Judged against the base table. */
  when?: string;
}

/**
 * The author speaking on a record's page: guidance, a policy, what to do
 * next. It reads nothing, so it is the one section with no table — the
 * dashboard's note, drawn by the same component.
 */
interface PageNote {
  kind: 'note';
  region?: SectionRegion;
  /** The tab of the record's section strip this section is drawn in; sections sharing a name share a panel. */
  tab?: string;
  title?: string;
  /** Plain text; blank lines separate paragraphs. */
  text: string;
  /** `quiet`: small print, no mark. `callout`: a ground of its own. Absent: the plain note. */
  variant?: 'quiet' | 'callout';
  icon?: import('./appIcons.js').AppIconName;
  /** One of the App's list or dashboard views to open. An App page only. */
  action?: import('./appLinks.js').AppLinkAction;
  width?: SectionWidth;
  offsetLeft?: SectionOffset;
  offsetRight?: SectionOffset;
  hidden?: boolean;
  /** Shown only when the root record matches this condition, in the query
      language: "status = converted". Judged against the base table. */
  when?: string;
}

/**
 * One stream of a timeline: dated child rows of the root, one line each.
 * The activity-feed shape — notes, calls, status changes — merged with
 * its sibling streams by date.
 */
export interface TimelineStream {
  from: string;
  /** As on a list: the path from `from` back to the record. Config: `whose`. */
  path: string;
  /** The date column the stream is ordered and merged by. */
  at: string;
  /** The line itself: a column of `from`, or a dotted path. */
  show: string;
  /** A quieter second word — a kind, an author. */
  detail?: string;
  /** Who wrote it: a column of `from`, or a dotted path — said beside its date. */
  by?: string;
  /** Extra narrowing, in the query language, resolved against `from`. */
  filter?: string;
  /** The record's reference this stream is about, as a list's `about`: `path` then leads to the row it names (a
      deal's company), so a timeline reaches that row's other children (the company's tickets). Config: `about`. */
  of?: string;
  /** This stream's own far side, in place of the section's: a condition over its rows (timelineSides, page.ts). */
  side?: string;
  /** Every row of this stream in this tone, in place of the section's `tone` rules. */
  tone?: TimelineTone;
  /** Every row of this stream drawn as one line, in place of the section's `compact` rules. */
  compact?: true;
}

/** Every `about` a page's sections and streams name, once each: the referenced rows the planner reads first. */
export function pageAbouts(page: { sections: readonly PageSection[] }): string[] {
  return [
    ...new Set(
      page.sections.flatMap((section) =>
        section.kind === 'timeline'
          ? section.streams.flatMap((stream) => (stream.of ? [stream.of] : []))
          : section.kind !== 'fields' &&
              section.kind !== 'note' &&
              section.kind !== 'history' &&
              section.kind !== 'flows' &&
              section.kind !== 'diagram' &&
              section.kind !== 'custom' &&
              section.of
            ? [section.of]
            : [],
      ),
    ),
  ];
}

/** Dated child rows from several tables, merged into one stream. */
export interface PageTimeline {
  kind: 'timeline';
  region?: SectionRegion;
  /** The tab of the record's section strip this section is drawn in; sections sharing a name share a panel. */
  tab?: string;
  title?: string;
  streams: TimelineStream[];
  /** Per stream, before the merge. */
  limit?: number;
  /** A composer: adds a row of the first stream, bound to this record. */
  create?: RelatedCreate<string>;
  /** `'last'`: oldest first, the newest at the foot, the section scrolled to it. Absent: newest first. */
  newest?: 'last';
  /** A conversation's pinned composer at the foot: the commands a Reply and an Internal note run, by name. */
  composer?: TimelineComposer;
  /** A row's tone by one of its columns' values: `{ kind: { internal: 'warn' } }`, a display tone. Read on each stream
      whose table has the column and that says no `tone` of its own (timelineMarkColumns). */
  tone?: Record<string, Record<string, TimelineTone>>;
  /** Rows drawn as one line, by one of their columns' values: `{ kind: ['system'] }`. Read as `tone` is. */
  compact?: Record<string, string[]>;
  /** The other party's rows, drawn at the far edge: a condition over each stream's rows in the query language, where
      `record.<column>` is the page's record — `author_id = record.caller_id`. A stream whose table lacks a column it
      names is never on the far side; a stream's own `side` replaces it (timelineSides, page.ts). */
  side?: string;
  width?: SectionWidth;
  offsetLeft?: SectionOffset;
  offsetRight?: SectionOffset;
  hidden?: boolean;
  /** Shown only when the root record matches this condition, in the query
      language: "status = converted". Judged against the base table. */
  when?: string;
}

/** The tones a timeline row may be tinted: the display tones' words. */
export type TimelineTone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';
/** The commands a conversation's composer runs: a Reply and, beside it, an Internal note. Each is offered to the reader by an action of the page's resource. */
export interface TimelineComposer {
  reply: string;
  note?: string;
  /** Canned replies: a resource's rows, picked by one column, the other filling the box. */
  /** `query` narrows the rows offered (a retired response is readable, and not offered). */
  templates?: { from: string; labelColumn: string; text: string; query?: string };
}

/**
 * The columns a timeline's tone and compact rules read. Given a stream and its table, those its rows carry: a rule is
 * read on each stream whose table has its column, as `side` is, and not on one that says its own `tone` or `compact`
 *, so time logged need not carry a `kind` only so a rule can name it. Without a stream, every rule's column.
 */
export function timelineMarkColumns(
  section: { tone?: Record<string, unknown>; compact?: Record<string, unknown> },
  stream?: { tone?: unknown; compact?: unknown },
  table?: { columns: ReadonlyArray<{ name: string }> },
): string[] {
  const named = [
    ...new Set([
      ...(stream?.tone === undefined ? Object.keys(section.tone ?? {}) : []),
      ...(stream?.compact === undefined ? Object.keys(section.compact ?? {}) : []),
    ]),
  ];
  return stream ? named.filter((column) => Boolean(table?.columns.some((c) => c.name === column))) : named;
}

/**
 * A timeline's `side` as one stream asks it: `record.<column>` is the page's record, reached by the stream's own way
 * back to it, so `author_id = record.caller_id` over a stream `whose: 'ticket_id'` is `author_id =
 * ticket_id.caller_id` — one condition the query language already reads, run where the stream's rows are read.
 * Undefined where the stream's rows lead to another row (`about`), which has no way back to the record.
 */
export function timelineSide(side: string, stream: { path: string; of?: string }): string | undefined {
  const masked = maskQuoted(side);
  const at = [...masked.matchAll(/(?<![\w$.])record\.(?=[A-Za-z_])/g)].map((match) => match.index);
  if (at.length && stream.of) return undefined;
  let out = side;
  for (const i of at.reverse()) out = `${out.slice(0, i)}${stream.path}.${out.slice(i + 'record.'.length)}`;
  return out;
}

/** How many streams one timeline is allowed to merge. */
export const MAX_STREAMS = 4;

/**
 * The record's own change history: each write that changed it, newest first,
 * with who made it, when, the action or command it came from, and each field
 * from what to what. Declaring one is what makes its resource keep a history
 * (server/recordHistory.ts); nothing is read from `from` because the record's
 * history is its own.
 */
interface PageHistory {
  kind: 'history';
  region?: SectionRegion;
  /** The tab of the record's section strip this section is drawn in; sections sharing a name share a panel. */
  tab?: string;
  title?: string;
  /** Writes shown before "Show earlier changes", 1 to 100. Default 8. */
  limit?: number;
  width?: SectionWidth;
  offsetLeft?: SectionOffset;
  offsetRight?: SectionOffset;
  hidden?: boolean;
  /** Shown only when the root record matches this condition, in the query
      language: "status = converted". Judged against the base table. */
  when?: string;
}

/**
 * The record's row-driven flow runs: each run's state, its steps and
 * what it waits for. Read through its own route (server/recordFlows.ts); the
 * base resource must declare `flows`, and nothing here makes it keep a history.
 */
interface PageFlows {
  kind: 'flows';
  region?: SectionRegion;
  /** The tab of the record's section strip this section is drawn in; sections sharing a name share a panel. */
  tab?: string;
  title?: string;
  width?: SectionWidth;
  offsetLeft?: SectionOffset;
  offsetRight?: SectionOffset;
  hidden?: boolean;
  /** Shown only when the root record matches this condition, in the query
      language: "status = converted". Judged against the base table. */
  when?: string;
}

/**
 * A flow drawn from its step rows: each position a column, the steps that
 * share one its lanes, a branch's other way to its `goto`. On a flow's own
 * page (its base the `from` table of a resource's `flows`) it draws the flow;
 * on the page of a resource with `flows`, the record's run over its flow's
 * steps. The steps are read like any of the reader's rows, when it is drawn.
 */
interface PageDiagram {
  kind: 'diagram';
  region?: SectionRegion;
  /** The tab of the record's section strip this section is drawn in; sections sharing a name share a panel. */
  tab?: string;
  title?: string;
  width?: SectionWidth;
  offsetLeft?: SectionOffset;
  offsetRight?: SectionOffset;
  hidden?: boolean;
  /** Shown only when the root record matches this condition, in the query
      language: "status = converted". Judged against the base table. */
  when?: string;
}

/** The most writes one history section shows before asking for more. */
export const MAX_HISTORY_LIMIT = 100;
/** Writes a history section shows before "Show earlier changes" when its `limit` says none. */
export const DEFAULT_HISTORY_LIMIT = 8;

/**
 * An author's own component, drawn where a section stands: the record's
 * declared fields and its declared reads of rows are planned here like any
 * list, and the module only draws what it is handed (appComponents.ts).
 */
export interface PageCustom {
  kind: 'custom';
  region?: SectionRegion;
  tab?: string;
  title?: string;
  component: import('./appComponents.js').ComponentDecl;
  /** The record's own fields the component reads, label paths welcome. */
  record?: string[];
  /** Named reads of rows, each planned as a list (config `rows`). */
  reads?: Record<string, import('./appComponents.js').PageCustomRead>;
  /** Named aggregate reads, each planned as a breakdown (config `totals`, kept apart from a list's `totals` columns): exact figures, not counts of loaded rows. */
  aggregates?: Record<string, import('./appComponents.js').PageCustomTotal>;
  /** The component's props, checked against its declaration, defaults filled. */
  props?: Record<string, unknown>;
  width?: SectionWidth;
  offsetLeft?: SectionOffset;
  offsetRight?: SectionOffset;
  hidden?: boolean;
  when?: string;
}

export type PageSection =
  | PageFields
  | PageMetric
  | PageList
  | PageBreakdown
  | PageChart
  | PageNote
  | PageTimeline
  | PageHistory
  | PageFlows
  | PageDiagram
  | PageCustom;

/** What a section kind is, wherever a rule differs by kind: one row per kind, so a new kind is a compile error here and nowhere else forgets it. */
export interface SectionTraits {
  /** What a page's plan reads for it: `none`, nothing (a note, or what its own route answers — a history, flow runs, a
      diagram's steps); `record`, the root record's own fields, read with the root; `rows`, related rows, planned as
      views or breakdowns (pagePlans.ts). */
  reads: 'none' | 'record' | 'rows';
  /** Whether it walks a path from the root to a related table — its own `from` and `path`, or each stream's — so the
      root row carries the keys the path starts from. A custom section's reads are declared, not walked. */
  relation: boolean;
}

/** Every section kind's traits (SectionTraits). The union is closed: a kind is added here, with its row. */
export const SECTION_TRAITS = {
  fields: { reads: 'record', relation: false },
  metric: { reads: 'rows', relation: true },
  list: { reads: 'rows', relation: true },
  breakdown: { reads: 'rows', relation: true },
  chart: { reads: 'rows', relation: true },
  note: { reads: 'none', relation: false },
  timeline: { reads: 'rows', relation: true },
  history: { reads: 'none', relation: false },
  flows: { reads: 'none', relation: false },
  diagram: { reads: 'none', relation: false },
  custom: { reads: 'rows', relation: false },
} as const satisfies Record<PageSection['kind'], SectionTraits>;

type Traits = typeof SECTION_TRAITS;
type KindsWhose<Trait> = { [Kind in PageSection['kind']]: Traits[Kind] extends Trait ? Kind : never }[PageSection['kind']];

/** The section kinds that read one of these ways (SectionTraits.reads). */
export type KindsReading<Reads extends SectionTraits['reads']> = KindsWhose<{ reads: Reads }>;

/** Whether a section reads one of these ways (SectionTraits.reads), narrowed to the kinds that do. */
export function sectionReading<Reads extends SectionTraits['reads']>(
  section: PageSection,
  ...reads: Reads[]
): section is Extract<PageSection, { kind: KindsReading<Reads> }> {
  return (reads as string[]).includes(SECTION_TRAITS[section.kind].reads);
}

/** Whether a section kind reads one of these ways, for a shape that is not the section union (recordReads.ts ReadSection). */
export function kindReading<Reads extends SectionTraits['reads']>(
  kind: PageSection['kind'],
  ...reads: Reads[]
): kind is KindsReading<Reads> {
  return (reads as string[]).includes(SECTION_TRAITS[kind].reads);
}

/** Whether a section walks a path from the root (SectionTraits.relation), narrowed to the kinds that do. */
export const walksRelation = (section: PageSection): section is Extract<PageSection, { kind: KindsWhose<{ relation: true }> }> =>
  SECTION_TRAITS[section.kind].relation;

export interface PageDef {
  id: string;
  name: string;
  /** The table a root is chosen from. Every path starts here. */
  base: string;
  /** An App page's address after the App's, when not its id (appAddress.ts). */
  path?: string;
  sections: PageSection[];
  /** The one connection this page is for, by id or name. Absent means every connection. */
  connection?: string;
  /** With the platform realm, whose context the page serves. Required when
      its base is platform-owned; absent is the App's own realm, `tenant`. */
  realm?: 'tenant' | 'platform';
  /** An App page's: the roles that may open it, beside its table grant (appViewRoles.ts). Absent is everyone's. */
  roles?: string[];
  /** An App page's: the record on paper — an invoice, a packing slip — reached from its record, never opened as its page (appDocuments.ts). */
  document?: import('./appDocuments.js').PageDocument;
  /**
   * Draw consecutive runs of list sections as one tab strip. On an App's
   * page it is off unless the page says `true`: a page written in the DSL is
   * laid out as written, and a strip made on its own swallowed the widths
   * its author gave (`width: 'half'`). A list with a width never joins a
   * strip. The Workbench's pages keep it on unless they say `false`,
   * because the stack is worse at the size records actually
   * are: six things pointing at a record is six tables down a page, the
   * sixth a scroll away from the record it is about, and all six fetched
   * whether or not anyone looks. As tabs it is one table deep with five
   * names above it, and only the tab you open costs a query. This is the
   * arrangement every record-based system converges on, and they are not
   * wrong about it.
   *
   * A page-level switch rather than a flag per section: "these are tabs of
   * each other" is a statement about a group, and a per-section flag would
   * let someone build a page with three tab strips of one tab each. The
   * grouping is the section order — a run of lists is a strip, and anything
   * else between two lists splits them — which makes the builder's drag the
   * way to decide what is a tab of what.
   */
  listTabs?: boolean;
  /** What a related list that says nothing of its own does while it has no rows (pageConfig.ts bakes it into each list's `emptyMode`). */
  empty?: 'hide' | 'collapse';
  /** An App's page: `false` opts out of the default aside (`defaultAside`). */
  aside?: false;
  /** An App's page: its archetype, the arrangement of its regions (pageLayouts.ts), as written or as its sections
      make it (chooseLayout). Absent, or `'record'`, is the record's own. */
  layout?: import('./pageLayouts.js').PageLayoutWord;
  /** Why the App's page parser chose `layout` for a page that names none; absent where the author wrote it. */
  layoutWhy?: string;
  /** An App's record page that declares no aside: validatePage draws the record's remaining fields there
      (pageAnatomy.ts, withDefaultAside). Set by the App's page parser, never by the Workbench's. */
  defaultAside?: true;
  /**
   * Where the page came from, which is the same question as who may change
   * it. `config` belongs to the file, `suggested` to the schema, and only
   * `saved` is the browser's own — so only `saved` can be edited in place or
   * deleted. The three were two for a while, with a suggested page calling
   * itself `saved`: the builder still refused to delete it (it checked the
   * id prefix instead), but the button that opens the builder said "Edit"
   * when what it would do is start a copy.
   */
  source?: 'config' | 'saved' | 'suggested';
  /**
   * Why this page cannot be used, if it cannot.
   *
   * Carried rather than thrown, for the same reason a view carries its error:
   * a page naming a table this connection does not have should appear in the
   * list *with its reason*, not vanish and leave someone hunting through a
   * config file for the entry they are sure they wrote.
   */
  error?: string;
}

/** Rows a list section shows before it needs a page of its own. */
export const DEFAULT_PAGE_LIST_LIMIT = 10;

/** Sections one screen of a page may draw: in each region, those in no tab and the largest tab's. A page is a
    screen, not a report; a record's tabs are more screens of it, so they are counted one at a time. */
export const MAX_SECTIONS = 24;
/** Sections a page may hold in all, every tab's included. */
export const MAX_PAGE_SECTIONS = 96;

/** How many sections a page draws on its fullest screen: per region, those in no tab and its largest tab's. */
export function screenSections(sections: readonly { region?: SectionRegion; tab?: string }[]): number {
  const regions = new Map<string, { untabbed: number; tabs: Map<string, number> }>();
  for (const section of sections) {
    const region = section.region ?? 'main';
    const counted = regions.get(region) ?? { untabbed: 0, tabs: new Map<string, number>() };
    regions.set(region, counted);
    if (section.tab === undefined) counted.untabbed += 1;
    else counted.tabs.set(section.tab, (counted.tabs.get(section.tab) ?? 0) + 1);
  }
  let most = 0;
  for (const { untabbed, tabs } of regions.values()) most += untabbed + Math.max(0, ...tabs.values());
  return most;
}

/** A workflow step's label when it names none: `in_review` reads "In review". */
export function workflowLabel(value: string): string {
  const words = value.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
