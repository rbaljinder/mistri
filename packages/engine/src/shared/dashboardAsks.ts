/**
 * What a dashboard's sections ask, in the words they ask it: a metric's
 * figure and its compare window's (its trend's are dashboardTrend.ts), a breakdown's groups, a chart's
 * and a matrix's crosses, a board's lanes, a list's first rows, a pick's
 * choices. The client's sections build their requests from these
 * (client/components/Dashboard.tsx, dashboardModel.ts), and the server
 * builds a first page's from them too (server/http/firstPaintRooms.ts), so
 * the answers it carries are for the requests the sections then make.
 */
import { andQuery } from './query.js';
import { labelColumn, primaryKey, type ForeignKey, type TableMeta } from './schema.js';
import { listPresentationColumns } from './appListColumns.js';
import type { AppListPresentation } from './listPresentations.js';

/**
 * How the asks read the schema: the client through the walk's own helpers
 * (core.js), the server over the schema it answered with (listQuestion.ts
 * `referenceNames` names the references either way).
 */
export interface AskLookups {
  table(id: string): TableMeta | undefined;
  references(id: string): readonly ForeignKey[];
  referenceNames(tableId: string, names: readonly string[]): Record<string, string>;
  /** Where a table's records are named, as a view path (schema.ts labelPath, by the App's record label). */
  naming(table: TableMeta): string | undefined;
}

/** What of a section its asks are made from. */
export interface AskedSection {
  kind: string;
  table?: string;
  query?: string;
  measure?: string;
  /** A scatter's second measure, which places its dots across. */
  x?: string;
  by?: string;
  lanes?: string[];
  limit?: number;
  over?: string;
  compare?: string;
  windowBase?: string;
  /** The reader's window, where one stands in the author's (`windowed`): the window a metric's trend is drawn over. */
  windowPhrase?: string;
  comparePeriod?: boolean;
  spark?: boolean;
  shape?: string;
  show?: string[];
  sort?: string;
  view?: string;
  windows?: string[];
  windowKey?: string;
  /** A goal: a number, or read from data — per group where it names a `by` (a breakdown's, G76). */
  target?: number | { table: string; query?: string; measure: string; by?: string; over?: string; windowBase?: string };
  /** The target is the whole this metric is a share of, not a goal (it follows the metric's window and picks). */
  targetWhole?: true;
  error?: string;
}

/** A breakdown's goals, a row per group: the target table's measure by its own `by`, within its query. */
export function targetText(section: Pick<AskedSection, 'target' | 'limit'>): string | null {
  const goal = section.target;
  if (typeof goal !== 'object' || !goal.by) return null;
  return [goal.table, goal.query, `${goal.measure} by ${goal.by}`, `limit ${groupsAskedFor(section)}`].filter(Boolean).join(' ');
}

/** The breakdown a section asks for: its measure by its key, within its query. */
export function breakdownText(section: Pick<AskedSection, 'table' | 'query' | 'measure' | 'by' | 'x'>, limit?: number | string): string {
  /* A scatter asks its two measures in one line: the answer is its key, then `x`, then the measure. */
  const measured = `${section.x ? `${section.x}, ` : ''}${section.measure ?? 'count'}`;
  return [section.table, section.query, `${measured} by ${section.by}`, limit ? `limit ${limit}` : ''].filter(Boolean).join(' ');
}

/**
 * A section with the reader's window in place of the author's. The server
 * hands sections whose query already windows the `over` column a
 * `windowBase` without that phrase, so the reader's phrase stands where
 * the author's did rather than intersecting it. A compare derived from
 * "previous period" is re-derived against the reader's window — `last 30
 * days` picked compares against `previous 30 days`; a hand-written compare,
 * or a window phrase with no "previous" (this month), hides the delta rather
 * than compare the reader's window to the author's.
 */
export function windowed<S extends AskedSection>(section: S, windowNow: string | null): S {
  if (!section.over || !windowNow) return section;
  const base = section.windowBase ?? section.query;
  const out: S = { ...section, query: andQuery(base, `${section.over} = ${windowNow}`), windowPhrase: windowNow };
  /* A goal per group follows the reader's window by its own clock: this quarter's quotas beside this quarter's wins. */
  const goal = section.target;
  if (typeof goal === 'object' && goal.over)
    out.target = {
      ...goal,
      query: andQuery(section.targetWhole ? (goal.windowBase ?? goal.query) : goal.query, `${goal.over} = ${windowNow}`),
    };
  /* A metric with no window of its own is served `comparePeriod` and no
     compare at all: it has a change only once a window is picked. */
  if (section.compare || section.comparePeriod) {
    const m = /^last\s+(\d+)\s+(minute|hour|day|week|month|year)s?$/i.exec(windowNow.trim());
    out.compare =
      section.comparePeriod && m ? andQuery(base, `${section.over} = previous ${m[1]} ${m[2]}${m[1] === '1' ? '' : 's'}`) : undefined;
  }
  return out;
}

/** The period a section with windows of its own is over: the reader's pick, else its first. */
export const sectionPeriod = (
  section: Pick<AskedSection, 'windows' | 'windowKey'>,
  periods: Readonly<Record<string, string>>,
): string | null => (section.windows?.length ? (section.windowKey && periods[section.windowKey]) || section.windows[0] : null);

/** A metric's figure over `query` — its own, or its compare window's. */
export const measureText = (section: Pick<AskedSection, 'table' | 'measure'>, query: string | undefined): string =>
  [section.table, query, section.measure ?? 'count'].filter(Boolean).join(' ');

/**
 * How many groups a breakdown asks for before it orders them itself. The
 * grammar answers groups in the engine's order — the alphabet, on SQLite —
 * so a section's `limit` asked of the server kept the first groups by name,
 * not the biggest. The groups are fetched, ordered on the client and then
 * cut to the section's limit.
 */
const GROUPS_ASKED = 200;
export const groupsAskedFor = (section: Pick<AskedSection, 'limit'>): number => Math.max(section.limit ?? 0, GROUPS_ASKED);

/** The groups a chart asks for: stacked bars cross two keys, and bars and a donut order their groups themselves. */
export function chartLimit(section: Pick<AskedSection, 'shape' | 'limit' | 'by'>): number | undefined {
  /* A heat map's grid is every cross of its keys: a week of hours is 168. */
  if (section.shape === 'stacked' || section.shape === 'heatmap') return 400;
  /* A waterfall's and a treemap's groups are all drawn, as a donut's slices: `limit` keeps the largest. */
  if (section.shape === 'waterfall' || section.shape === 'treemap' || section.shape === 'scatter') return groupsAskedFor(section);
  /* A line (or the default chart) over two keys draws one line per second key: every period crossed with every series is a
     row, and the server's twenty-row default dropped the later periods, so each line fell to zero where the rows ran out. */
  if (section.shape === 'line' && (section.by ?? '').includes(',')) return 400;
  return section.shape === 'donut' || section.shape === 'bar' ? groupsAskedFor(section) : section.limit;
}

/** A board's lane counts. */
export const boardCountText = (section: Pick<AskedSection, 'table' | 'query' | 'by'>): string =>
  [section.table, section.query, `count by ${section.by}`].filter(Boolean).join(' ');

/**
 * A dashboard list's question: its rows with the columns it draws, the names
 * its references are read by and the keys a row opens by, kept out of sight,
 * up to its limit. `presentation` is the embedded view's, whose dress reads
 * columns of its own.
 */
export function dashboardListQuery(
  lookups: AskLookups,
  section: Pick<AskedSection, 'table' | 'query' | 'sort' | 'show' | 'limit'>,
  presentation?: AppListPresentation,
): { query: string; keys: string[]; named: string[]; referenceLabels: Record<string, string> } {
  const table = section.table ? lookups.table(section.table) : undefined;
  const shown = [...new Set([...(section.show ?? []), ...(presentation ? listPresentationColumns(presentation) : [])])];
  const keys = shown.length ? (table ? primaryKey(table) : []).filter((key) => !shown.includes(key)) : [];
  const referenceLabels = shown.length ? lookups.referenceNames(section.table as string, shown) : {};
  /* The record's own name rides along unseen as its key does: on a phone a
     row is a card titled by it, and without it a lease was titled "21". */
  const naming = shown.length && table ? lookups.naming(table) : undefined;
  const titled = naming && !primaryKey(table as TableMeta).includes(naming) ? [naming] : [];
  const named = [...new Set([...Object.values(referenceLabels), ...titled])].filter((name) => !shown.includes(name));
  const query = [
    section.table,
    section.query,
    section.sort ? `sort ${section.sort}` : '',
    shown.length ? `show ${[...shown, ...named, ...keys].join(', ')}` : '',
    `limit ${section.limit ?? 5}`,
  ]
    .filter(Boolean)
    .join(' ');
  return { query, keys, named, referenceLabels };
}

/**
 * A pick's choices, where its column is a whole single-column reference: the
 * records it points at, by name, fifty at most. Null where the column is a
 * vocabulary (its values are the choices) or no section's table has it.
 */
export function pickQuery(lookups: AskLookups, sections: readonly Pick<AskedSection, 'table'>[], column: string): string | null {
  const home = sections.find((section) => section.table && lookups.table(section.table)?.columns.some((c) => c.name === column));
  const table: TableMeta | undefined = home?.table ? lookups.table(home.table) : undefined;
  const meta = table?.columns.find((c) => c.name === column) as { allowed?: string[] } | undefined;
  const fk =
    table && !meta?.allowed?.length
      ? lookups.references(table.id).find((f) => f.from.columns.length === 1 && f.from.columns[0] === column)
      : undefined;
  const target = fk ? lookups.table(fk.to.table) : undefined;
  const naming = target ? labelColumn(target) : undefined;
  const pk = target ? primaryKey(target)[0] : undefined;
  return target && naming ? `${target.id} show ${[...new Set([naming, pk])].join(', ')} sort ${naming}` : null;
}
