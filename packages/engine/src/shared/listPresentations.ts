/**
 * How a list draws its rows, beside the plain grid: the presentations
 * (`presentation: { kind: … }` — a board, a calendar, cards, a split, …), a
 * list's tabs and its empty state. The rules both a page's related list and
 * an App's list view read (listQuestion.ts, dashboardAsks.ts, appListColumns.ts);
 * the list view that holds them is the App's (appModel.ts AppListView).
 */
import type { AppCardsList } from './appCards.js';
import type { AppIconName } from './appIcons.js';
import type { CustomListPresentation } from './appComponents.js';
import { DISPLAY_TONES } from './model.js';

/**
 * One filter tab on a list page. The query is written in the ordinary
 * query-bar language, without the leading table name — the list supplies
 * it. No query means every row.
 */
export interface AppListTab {
  label: string;
  query?: string;
  /** Internal: the tab's word in an address, from the App's own language, where a reader's label says
      another (server/app/apps.ts `localizedApp`). Addresses stay one per thing in every locale. A segment's
      tab is its segment's name. */
  slug?: string;
  /** The resource's segment the tab names (appSegments.ts): its `query` is that word, written out where it is read. */
  segment?: string;
}

/**
 * Data only: the renderer supplies the list and detail nodes. One of the
 * list presentations, so a view says how its rows are drawn in exactly
 * one place — `presentation: { kind: 'split', … }` beside the checklist, the
 * queue and the board — rather than through a second key that had to be read
 * before the first. The list is the view's own — its show, query, tabs and
 * filter bar — so the split says only what is its: the detail's fields and
 * the list's page size. The detail is headed by the resource's noun.
 */
export interface AppSplitListDetail {
  kind: 'split';
  /** The picked record's fields, in order: columns or label paths. Absent, its fields as the schema has them. */
  detail?: string[];
  /** The list's page size, 1 to 200: the view's, written into its question. */
  limit?: number;
  /** How a row reads in the pane beside the record: the queue's vocabulary, with an avatar. Absent, the plain grid. */
  row?: { primary: string; lines?: string[]; facts?: string[]; badge?: string; avatar?: string };
}

/*
 * The card presentations speak one vocabulary: a `primary` column, then up
 * to the presentation's number of `lines` beneath it — local readable
 * columns only, never paths.
 */

/** Local readable columns; presentation never grants permission to toggle. */
export interface AppChecklist {
  kind: 'checklist';
  primary: string;
  checked: string;
  /** At most one line beneath the primary. */
  lines?: string[];
}

/**
 * A keyboard-first selection queue: the rows as a listbox, and the view's
 * `bulk` actions offered for exactly the selected keys. Its title and lines may
 * be local columns or one-hop reference label paths. Selection is a set of
 * loaded records, never "everything matching". A fixed update writes each
 * record on its own through the ordinary update route, so its result is per
 * record; a `targets: 'many'` command sends one request, all or nothing.
 */
export interface AppQueueList {
  kind: 'queue';
  /** A local text column or one-hop reference label path. */
  primary: string;
  /** At most two local columns or one-hop label paths beneath the primary. */
  lines?: string[];
  /** Up to six values with captions, each a local column or one-hop label path. */
  facts?: string[];
  /** An optional status or other compact value shown as a reusable badge above the title. */
  badge?: string;
  /** The row-opening call to action; omitted uses "Open". */
  openLabel?: string;
}

/**
 * Lanes of cards by one local column's values. A card moves only through an
 * action of the view whose `set` is exactly that column, judged by its own
 * `when`; the board never writes a lane the app did not spell out. Where `by`
 * references another table (a cycle, a sprint), the lanes are that table's
 * rows, led by one for none, and a card moves by an ordinary update of the
 * reference — unless the resource's transitions give it to its actions.
 */
export interface AppBoardList {
  kind: 'board';
  by: string;
  /** Ordered subset of exact lane values (a reference's keys); omit to use the column's vocabulary, the
      referenced rows, or the values seen. */
  lanes?: readonly string[];
  /** A numeric local column holding each card's place in its lane: the lanes read in its order, and a reader
      who may edit it moves a card into place. Never a column the resource's transitions give to its actions. */
  order?: string;
  /** A local column whose values are rows across the lanes, one per value plus one for none; a card changes
      row by an ordinary update of it where the reader may edit it, and keeps its row, told why, where not. */
  swimlanes?: string;
  /** A lane's work-in-progress limit, by lane value: its head says "count / limit" and warns past it. Shown,
      never enforced. */
  limits?: Readonly<Record<string, number>>;
  primary: string;
  /** At most one line beneath the primary. */
  lines?: string[];
  /** A local column whose value is the card's kind: a chip over the title in the color its display rule's `colors`
      gives the value (else one fixed by its text), and the card's stripe where the look draws one. */
  category?: string;
  /** Up to four facts along the card's foot, each a local column with an optional App icon before it; a person
      (an `avatar` or `avatars` column) stands at the right end. */
  footer?: readonly AppBoardFact[];
  /** A local numeric column summed in each lane's head beside its count. Absent, the first money column the card
      shows (a line, a fact) is summed; a card and a lane say money short ($240K), whole in the title. */
  sum?: string;
  /** Lane values drawn folded until a reader opens one — a closed stage, won or lost: a narrow strip with its name,
      count and sum. The reader's choice is remembered in their browser, per board. */
  folded?: readonly string[];
}

/** One fact on a board card's foot. */
export interface AppBoardFact {
  column: string;
  icon?: AppIconName;
}

/** A month of records by one date column, each on its day — or, with `end`, across the days from one date
    column to another; a phone reads it as an agenda. */
export interface AppCalendarList {
  kind: 'calendar';
  /** The date (or timestamp) column a record sits on, or starts on when it has an `end`. */
  date: string;
  /** A local date column holding a record's last day: the record is drawn across every day between. */
  end?: string;
  /** A local text column or one-hop reference label path. */
  primary: string;
  /** At most one local column or one-hop label path beneath the primary. */
  lines?: string[];
  /** A status said as its tone (a dot and its word), from the column's display map. */
  badge?: string;
  /** Shaded spans behind the days, read from other resources (a blackout window), each labeled. */
  backdrop?: AppCalendarBackdrop[];
}

/** One kind of shaded span on a calendar: another resource's rows, from one date column to another, each labeled. */
export interface AppCalendarBackdrop {
  /** The resource the spans are rows of: by the App's name as authored, its table's id once resolved. */
  from: string;
  /** Its date (or timestamp) column where a span starts. */
  start: string;
  /** Its date (or timestamp) column holding a span's last day. */
  end: string;
  /** Its column whose value names a span. */
  labelColumn: string;
  /** The span's shade, in a display tone; absent, the quiet neutral. */
  tone?: (typeof DISPLAY_TONES)[number];
}

/** How many kinds of span one calendar shades. */
export const CALENDAR_BACKDROPS_MAX = 4;

/** Records as the tree their parent column makes: a root per record with no parent, its children folded under it. */
export interface AppTreeList {
  kind: 'tree';
  /** A local column that references this table: the record above, empty at a root. */
  parent: string;
  /** A local text column or one-hop reference label path. */
  primary: string;
  /** At most one local column or one-hop label path beside the primary. */
  lines?: string[];
}

/** Records as bars along time, from one date column to another, in a row per group: a Gantt chart. */
export interface AppGanttList {
  kind: 'gantt';
  /** The date (or timestamp) column a bar starts on. */
  start: string;
  /** The date column it ends on; a record with none is a mark on its start. */
  end: string;
  /** A local text column or one-hop reference label path. */
  primary: string;
  /** A local column or one-hop label path whose value names a bar's row ("owner_id.name"); absent, a row per record. */
  by?: string;
  /** A percent column (0–100) drawn as the bar's filled share. */
  progress?: string;
}

export type AppListPresentation =
  | AppTreeList
  | AppGanttList
  | AppChecklist
  | AppQueueList
  | AppBoardList
  | AppCalendarList
  | AppCardsList
  | AppSplitListDetail
  | CustomListPresentation;

/** An optional empty-list action opens another App list or dashboard, or a signed-in form (the one that makes the first row). */
export interface AppListEmpty {
  title: string;
  description?: string;
  action?: { label: string; view: string };
}

/** Whether the Export menu is offered for a table, here and not beside the payload that sets `exportableTables`, since a list's first paint asks it and appPayload.ts imports the manifest parser: `ui.export` is the App's switch, and `exportableTables` (present in an App that grants by role) the person's. */
export const exportOffered = (
  app: { ui: { export?: boolean }; exportableTables?: string[] } | null | undefined,
  table: string | undefined,
): boolean => app?.ui.export !== false && (!app?.exportableTables || (table !== undefined && app.exportableTables.includes(table)));

/** Where a list's filters sit: a bar above the rows, a rail of facets beside them, or none. */
export const FILTER_BARS = ['bar', 'rail', 'none'] as const;
export type FilterBar = (typeof FILTER_BARS)[number];
