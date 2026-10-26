/** Section planning only: callers own page validation, root lookup and access. */
import {
  breakdownPlan,
  chartPlan,
  customReadView,
  customTotalPlan,
  listView,
  metricView,
  sectionQuery,
  timelineMarkColumns,
  timelineSides,
  type OfKeys,
  type PageDef,
  type PageList,
  type TimelineStream,
} from './page.js';
import { groupsView, totalsView } from './pagePaths.js';
import { sectionReading, type KindsReading } from './pageModel.js';
import type { RootValues } from './pagePaths.js';
import { findTable, primaryKey, type DatabaseSchema } from './schema.js';
import { andQuery } from './query.js';
import { viewToTextWithSchema } from './viewtext.js';

type HttpPagePlan =
  | { index: number; kind: KindsReading<'none' | 'record'> }
  | ({ index: number; kind: 'breakdown'; breakdown?: ReturnType<typeof breakdownPlan>['def'] } & Pick<
      ReturnType<typeof breakdownPlan>,
      'empty' | 'error'
    >)
  | ({ index: number; kind: 'chart'; breakdown?: ReturnType<typeof chartPlan>['def'] } & Pick<
      ReturnType<typeof chartPlan>,
      'empty' | 'error'
    >)
  | {
      index: number;
      kind: 'timeline';
      streams: Array<
        {
          from: string;
          at: string;
          show: string;
          detail?: string;
          by?: string;
          /** With a `side`: the stream's key columns, and the same read narrowed to the other party's rows. */
          key?: string[];
          side?: ReturnType<typeof listView>;
        } & ReturnType<typeof listView>
      >;
    }
  | {
      index: number;
      kind: 'custom';
      reads: Record<string, ReturnType<typeof customReadView>>;
      /** Its aggregate reads, each a breakdown (page.ts, customTotalPlan). */
      aggregates: Record<
        string,
        Pick<ReturnType<typeof customTotalPlan>, 'empty' | 'error'> & { breakdown?: ReturnType<typeof customTotalPlan>['def'] }
      >;
    }
  | ({
      index: number;
      kind: 'list' | 'metric';
      query?: string;
      viewText?: string;
      totals?: ReturnType<typeof totalsView>['breakdown'];
      /** A grouped list's groups: one row for each record its rows share, read before the rows of each (pagePaths.ts, groupsView). */
      groups?: ReturnType<typeof groupsView>['breakdown'];
    } & ReturnType<typeof metricView>);

/** One supplied date keeps relative filters consistent across all sections.
 * No reads or authorization occur here; `ofKeys` and `rootValues` (the
 * record's own values, for a similar list) are already read by the caller. */
export function planPageSections(
  schema: DatabaseSchema,
  page: PageDef,
  key: Record<string, string | number>,
  ofKeys: OfKeys,
  now: Date = new Date(),
  rootValues?: RootValues,
): HttpPagePlan[] {
  return page.sections.map((section, index): HttpPagePlan => {
    // A note reads nothing, the fields read the record the caller already has, and a
    // history is the record's own, read through its own route (server/recordHistory.ts), and so are its flow runs (server/recordFlows.ts).
    if (!sectionReading(section, 'rows')) return { index, kind: section.kind };
    // Breakdown root filters can walk paths the text grammar cannot express.
    if (section.kind === 'breakdown') {
      const built = breakdownPlan(schema, page, section, key, index, now, ofKeys);
      return { index, kind: section.kind, breakdown: built.def, empty: built.empty, error: built.error };
    }
    // A chart is the same related rows as a breakdown, measured and keyed its own way.
    if (section.kind === 'chart') {
      const built = chartPlan(schema, page, section, key, index, now, ofKeys);
      return { index, kind: section.kind, breakdown: built.def, empty: built.empty, error: built.error };
    }
    // Streams remain independent list views; the client merges their rows.
    if (section.kind === 'timeline') {
      /* Each stream's far side, if it has one: its own, or the section's where its table can read it. */
      const { sides } = timelineSides(schema, section);
      const streamMarks = (stream: TimelineStream) => timelineMarkColumns(section, stream, findTable(schema, stream.from));
      return {
        index,
        kind: section.kind,
        streams: section.streams.map((stream, s) => {
          /* A side is the same read narrowed by its condition, its rows told apart by their keys: the condition is
             asked where the rows are read, through the reader's grants, rather than by the client. */
          const side = sides[s];
          const table = side === undefined ? undefined : findTable(schema, stream.from);
          const keyColumns = table ? primaryKey(table) : [];
          const asList: PageList = {
            kind: 'list',
            from: stream.from,
            path: stream.path,
            columns: [
              ...new Set(
                [stream.at, stream.show, stream.detail, stream.by, ...streamMarks(stream), ...keyColumns].filter((c): c is string =>
                  Boolean(c),
                ),
              ),
            ],
            filter: stream.filter,
            orderBy: [{ column: stream.at, direction: 'desc' }],
            limit: section.limit ?? 20,
            ...(stream.of ? { of: stream.of } : {}),
          };
          const built = listView(schema, page, asList, key, index, now, ofKeys);
          const others =
            side !== undefined && keyColumns.length && built.view
              ? listView(schema, page, { ...asList, columns: keyColumns, filter: andQuery(stream.filter, side) }, key, index, now, ofKeys)
              : undefined;
          return {
            from: stream.from,
            at: stream.at,
            show: stream.show,
            detail: stream.detail,
            by: stream.by,
            view: built.view,
            empty: built.empty,
            error: built.error,
            ...(others ? { key: keyColumns, side: others } : {}),
          };
        }),
      };
    }
    // Each declared read is its own view; the client runs them beside each other.
    if (section.kind === 'custom') {
      return {
        index,
        kind: section.kind,
        reads: Object.fromEntries(
          Object.entries(section.reads ?? {}).map(([name, read]) => [name, customReadView(schema, page, name, read, key, index, now)]),
        ),
        aggregates: Object.fromEntries(
          Object.entries(section.aggregates ?? {}).map(([name, total]) => {
            const built = customTotalPlan(schema, page, name, total, key, index, now);
            return [name, { breakdown: built.def, empty: built.empty, error: built.error }];
          }),
        ),
      };
    }
    const built: ReturnType<typeof metricView> =
      section.kind === 'metric'
        ? metricView(schema, page, section, key, index, now, ofKeys)
        : listView(schema, page, section, key, index, now, ofKeys, rootValues);
    // A related list's footer: its sums over every row it matches, planned beside it.
    const totals =
      section.kind === 'list' && section.totals?.length && built.view
        ? totalsView(schema, page, section, key, ofKeys, rootValues)
        : undefined;
    const groups = section.kind === 'list' && section.group && built.view ? groupsView(schema, page, section, key, ofKeys, now) : undefined;
    return {
      index,
      kind: section.kind,
      view: built.view,
      ...(totals?.breakdown ? { totals: totals.breakdown } : {}),
      ...(groups?.breakdown ? { groups: groups.breakdown } : {}),
      empty: built.empty,
      // Count metrics consume the total, not a value from the loaded rows.
      counts: built.counts,
      // A narrowed or distant measure reads its one figure from a breakdown.
      ...(built.breakdown ? { breakdown: built.breakdown } : {}),
      // A simple filter can open the grid; more distant paths need a view.
      query: built.view ? sectionQuery(built.view) : undefined,
      viewText: built.view ? viewToTextWithSchema(schema, built.view) : undefined,
      error: built.error ?? totals?.error ?? groups?.error,
    };
  });
}
