/**
 * Pages: a record layout with a front door.
 *
 * A record template lays out a row you have already found. A page starts one
 * step earlier — it asks *which* customer, and then shows everything that
 * customer is: their own fields, how many orders they have placed, what those
 * orders were, and the lines inside those orders. One screen assembled from
 * one root, instead of a walk you have to remember the way back through.
 *
 * The content model is deliberately the record template's, extended rather
 * than replaced. Two systems that both lay out sections keyed by foreign
 * key would drift within a month, and the second one would be the one that
 * forgot composite keys. What pages add is:
 *
 *   - **metric** sections — one number, from an aggregate over a relationship
 *   - **lists that reach further than one hop**, via a path rather than a
 *     single constraint, so "the lines of this customer's orders" is a
 *     section rather than two clicks
 *   - **a filter on a list**, so "recent open orders" is a section and not
 *     the whole of them
 *   - **a width**, so three counts sit in a row instead of stacked
 *
 * Everything here is pure: parsing, validating, and turning a page plus a
 * root key into the requests its sections need. Nothing fetches. That is what
 * lets the hard part — path resolution against a real schema, which is where
 * the mistakes live — be tested without a browser or a database.
 */
import { ANYONE, saidAt } from './query.js';
import { listEmptyConfig } from './listEmpty.js';
import { withDefaultAside } from './pageAnatomy.js';
import {
  columnKind,
  columnOrRollup,
  findTable,
  primaryKey,
  looksLikeDate,
  rowName,
  referencesTo,
  type DatabaseSchema,
  type ForeignKey,
  tableNamed,
} from './schema.js';
import { tryResolvePath } from './viewPaths.js';
import { hopName, parseViewQuery, validateView, type ViewFilter } from './view.js';
import { DATE_UNITS, type BreakdownDef, type BreakdownKey, type BreakdownOrder, type Measure } from './breakdown.js';
import type { DateUnit } from './filter.js';
/* A page as data, the way a pages/ file and tablewalk.json hold it: the App framework's authored types say what that
   is (model.d.ts `AuthoredPageShapes`), so what these rules write back is checked against them. */
import type { AuthoredPage, AuthoredSection, CustomMeasure, RelatedCreate } from '../../schema/model.js';
import { authoredSpelling } from './autoValues.js';
import { createSaysMore, relatedCreatePlan } from './relatedCreate.js';
import { groupsAsked, type PageCustomTotal } from './appComponents.js';
import {
  type PageCustom,
  type PageList,
  type PageBreakdown,
  type PageChart,
  type PageSection,
  type PageTimeline,
  type TimelineStream,
  type PageDef,
  DEFAULT_PAGE_LIST_LIMIT,
  timelineMarkColumns,
  timelineSide,
  sectionReading,
} from './pageModel.js';
import {
  resolvePath,
  pageHop,
  resolveOf,
  type OfKeys,
  listView,
  defaultColumns,
  similarProblem,
  groupProblem,
  groupFactPaths,
  relatedMatchProblem,
  customProblem,
} from './pagePaths.js';
export {
  type SectionWidth,
  WIDTHS,
  type SectionOffset,
  OFFSETS,
  type SectionRegion,
  SECTION_REGIONS,
  FIELD_COLUMNS,
  type ResolvedWorkflowStatus,
  type PageFields,
  type PageMetric,
  type PageList,
  type PageBreakdown,
  type PageChart,
  type TimelineStream,
  type PageTimeline,
  type PageSection,
  type PageDef,
  timelineMarkColumns,
  DEFAULT_PAGE_LIST_LIMIT,
  MAX_PAGE_SECTIONS,
} from './pageModel.js';
export {
  resolvePath,
  rootFilter,
  resolveOf,
  type OfKeys,
  listView,
  sectionQuery,
  metricView,
  defaultColumns,
  customReadView,
} from './pagePaths.js';
export { parsePagesConfig, PAGE_KEYS, PAGE_SECTION_KEYS, STREAM_KEYS, parsePageBody } from './pageConfig.js';

/* How a suggested page divides the relationships pointing at its root: the
   first few as lists, the next few as counts, the rest not shown. A page that
   listed all twelve things pointing at `customer` would be a report. */
const LISTED = 2;
const COUNTED = 3;

/**
 * Check a page against a real schema, and say what is wrong with it.
 *
 * Returns the page with an `error` rather than throwing, because a page that
 * names a table this connection does not have is still a page — it belongs
 * in the list, greyed, with its reason. A config file shared by a team will
 * always describe some connection someone is not on.
 */
export function validatePage(schema: DatabaseSchema, page: PageDef): PageDef {
  return withDefaultAside(schema, validated(schema, page));
}

function validated(schema: DatabaseSchema, page: PageDef): PageDef {
  /* Names resolve the nav's way first: a manifest writes "account" and
     Postgres calls it "public.account", and matching ids alone made every
     app page "missing" on the product's primary target — found the first
     time the app layer ever ran against live Postgres. The resolved copy
     is what this returns, so everything downstream — the planner, the
     client, the caller's own reads — keys on real ids. */
  const resolvedBase = tableNamed(schema, page.base);
  page = {
    ...page,
    base: resolvedBase?.id ?? page.base,
    sections: page.sections.map((s) => {
      /* Only a section that reads rows names a table to resolve. */
      if (!sectionReading(s, 'rows')) return s;
      if (s.kind === 'custom') {
        const named = <T extends { from: string }>(each: Record<string, T> | undefined) =>
          each &&
          Object.fromEntries(
            Object.entries(each).map(([name, read]) => {
              const from = tableNamed(schema, read.from);
              return [name, from && from.id !== read.from ? { ...read, from: from.id } : read];
            }),
          );
        return s.reads || s.aggregates
          ? {
              ...s,
              ...(s.reads ? { reads: named(s.reads) } : {}),
              ...(s.aggregates ? { aggregates: named(s.aggregates) } : {}),
            }
          : s;
      }
      if (s.kind === 'timeline') {
        return {
          ...s,
          streams: s.streams.map((stream) => {
            const from = tableNamed(schema, stream.from);
            return from && from.id !== stream.from ? { ...stream, from: from.id } : stream;
          }),
        };
      }
      const from = tableNamed(schema, s.from);
      return from && from.id !== s.from ? { ...s, from: from.id } : s;
    }),
  };
  const base = findTable(schema, page.base);
  if (!base) return { ...page, error: `"${page.base}" is not a table on this connection.` };
  /* A section's `when` is a condition on the root, judged now rather than as a dead section later, by the parser
     that judges it at run time (/api/run reads it as a view): a reference path and a computed column read there as
     they do in a list's filter. */
  for (const [i, section] of page.sections.entries()) {
    if (!section.when) continue;
    // Judged before any request: `me` reads as anyone's, and /api/run reads it as the reader.
    const parsed = parseViewQuery(schema, base.id, section.when, undefined, { me: ANYONE });
    const problem = parsed.errors.length
      ? saidAt(parsed.errors[0], section.when)
      : parsed.columns.length || parsed.orderBy.length
        ? 'is a condition, with no "show" or "sort".'
        : undefined;
    if (problem) return { ...page, error: `section ${i + 1}: "when": ${problem}` };
  }
  if (!primaryKey(base).length) {
    return {
      ...page,
      error: `"${base.name}" has no primary key, so a single record cannot be identified.`,
    };
  }

  /* A document's number is a field of its record, read as a fields section reads one. */
  if (page.document?.number !== undefined) {
    const error = validateView(schema, {
      id: `page:${page.id}:document`,
      name: 'document',
      base: page.base,
      columns: [{ path: page.document.number }],
    });
    if (error) return { ...page, error: `document: "number": ${error}` };
  }

  for (const [i, section] of page.sections.entries()) {
    const at = section.title ? `"${section.title}"` : `section ${i + 1}`;
    /* A note reads nothing. Nor does a history (the record's own writes), a flows section (the runs are the record's
       own, and the base resource declaring them is judged with the App) or a diagram (its steps are read as the
       reader's rows, and the base being a flows table is judged with the App): nothing to resolve. */
    if (sectionReading(section, 'none')) continue;
    /* An embed's table is its view's, copied in when the App loads; one that
       arrives without it was never resolved against the App's views. */
    if (section.kind === 'list' && section.view !== undefined && !section.from) {
      return { ...page, error: `${at}: embeds the view "${section.view}", which is not one of this App's list views.` };
    }
    if (section.kind === 'list' && section.create) {
      const creation = relatedCreatePlan(schema, page.base, section.from, section.path, section.create, {
        filter: section.filter,
      });
      if (creation.error) return { ...page, error: `${at}: ${creation.error}` };
    }
    /* A composer adds to the first stream the way a related list adds to
       itself, so it is judged the same way; a stream narrowed by a query
       could hide the row it just added. */
    if (section.kind === 'timeline' && section.create) {
      const first = section.streams[0];
      if (first.filter) return { ...page, error: `${at}: a timeline composer cannot add to a stream narrowed by a query.` };
      if (section.create.prefill)
        return { ...page, error: `${at}: a timeline composer takes no "prefill"; a related list's create fills from the record.` };
      const creation = relatedCreatePlan(schema, page.base, first.from, first.path, section.create);
      if (creation.error) return { ...page, error: `${at}: ${creation.error}` };
    }
    if (section.kind === 'fields') {
      const error = validateView(schema, {
        id: `page:${page.id}:${i}`,
        name: at,
        base: page.base,
        columns: (section.paths ?? []).map((path) => ({ path })),
      });
      if (error) return { ...page, error: `${at}: ${error}` };
      /* A was-price is a figure beside the figure: a number the reader can compare, or it says nothing. */
      if (section.was !== undefined) {
        const was = tryResolvePath(schema, page.base, section.was);
        if (!was.resolved)
          return { ...page, error: `${at}: "was" names "${section.was}", ${was.error?.message ?? 'which does not resolve'}` };
        if (columnKind(was.resolved.column.type) !== 'number')
          return {
            ...page,
            error: `${at}: "was" is a number or money column beside the figure; "${section.was}" is ${was.resolved.column.type || 'untyped'}.`,
          };
      }
      if (section.status !== undefined && !columnOrRollup(base, section.status)) {
        return { ...page, error: `${at}: the header's status "${section.status}" is not a column on ${base.name}.` };
      }
      if (section.workflow) {
        const column = base.columns.find((c) => c.name === section.workflow!.field);
        if (!column || !/text|char|enum/i.test(column.type)) {
          return { ...page, error: `${at}: workflow field must name a text or enum column on ${base.name}.` };
        }
      }
      continue;
    }
    if (section.kind === 'timeline') {
      /* Each stream judged the way a list is: the path leads home, the
         date column is a date, the shown paths resolve. */
      for (const stream of section.streams) {
        const here = `${at}, stream "${stream.from}"`;
        let home = page.base;
        if (stream.of) {
          const of = resolveOf(schema, page.base, stream.of);
          if (of.error) return { ...page, error: `${here}: ${of.error}` };
          home = of.table!.id;
        }
        const resolved = resolvePath(schema, stream.from, stream.path);
        if (resolved.error) return { ...page, error: `${here}: ${resolved.error}` };
        if (resolved.path!.endsAt !== home) {
          return {
            ...page,
            error: `${here}: "${stream.path}" leads from ${stream.from} to ` + `${resolved.path!.endsAt}, not to ${home}.`,
          };
        }
        const from = findTable(schema, stream.from);
        const atCol = from?.columns.find((c) => c.name === stream.at);
        if (!atCol) return { ...page, error: `${here}: "${stream.at}" is not a column on ${stream.from}.` };
        if (!/date|time/i.test(atCol.type ?? '')) {
          return {
            ...page,
            error: `${here}: "${stream.at}" is ${atCol.type || 'untyped'} — a timeline orders by a date column. See \`mistri docs dates-and-types\`.`,
          };
        }
        for (const path of [stream.show, stream.detail, stream.by].filter((p): p is string => Boolean(p))) {
          /* A bare name is a column of `from`; a dotted path walks references
             to a column of the table it reaches, and is judged the way a
             list column is — `author_id.name`, not a chain of references. */
          if (path.includes('.')) {
            const error = validateView(schema, { id: `page:${page.id}:${i}:stream`, name: here, base: stream.from, columns: [{ path }] });
            if (error) return { ...page, error: `${here}: ${error}` };
          } else if (!from?.columns.some((c) => c.name === path)) {
            return { ...page, error: `${here}: "${path}" is not a column on ${stream.from}.` };
          }
        }
      }
      /* A tone and a compact rule read their column on each stream that has it and says none of its own, as a side
         does; a rule no stream reads is a slip, named with the streams it missed. */
      for (const column of timelineMarkColumns(section)) {
        const reads = section.streams.some((stream) =>
          timelineMarkColumns(section, stream, findTable(schema, stream.from)).includes(column),
        );
        if (!reads)
          return {
            ...page,
            error: `${at}: the "tone" or "compact" column "${column}" is read by no stream: it is not a column on ${section.streams.map((stream) => stream.from).join(' or ')}, or each says its own.`,
          };
      }
      /* The other party's rows: the condition each stream's rows are asked, the record reached by the stream's way
         back to it, judged by the real parser now rather than as a read that fails on the page. */
      const sides = timelineSides(schema, section);
      if (sides.error) return { ...page, error: `${at}${sides.error}` };
      continue;
    }
    /* A custom section's reads are judged as the lists they are planned
       as, and the record's fields as a fields section's (customProblem). */
    if (section.kind === 'custom') {
      const problem = customProblem(schema, page, section, i) ?? customTotalsProblem(schema, page, section, i);
      if (problem) return { ...page, error: `${at}: ${problem}` };
      continue;
    }
    /* A similar list walks no path, so it is judged on its match and on the
       columns it shows — in the words the planner would use for them. */
    if (section.kind === 'list' && section.similar) {
      const problem = similarProblem(schema, page, section);
      if (problem) return { ...page, error: `${at}: ${problem}` };
      const table = findTable(schema, section.from)!;
      const error = validateView(schema, {
        id: `page:${page.id}:${i}`,
        name: at,
        base: table.id,
        columns: (section.columns?.length ? section.columns : defaultColumns(table, '')).map((path) => ({ path })),
        orderBy: section.orderBy?.map((order) => ({ path: order.column, direction: order.direction })),
      });
      if (error) return { ...page, error: `${at}: ${error}` };
      continue;
    }
    let rootTable = page.base;
    if (section.of) {
      const of = resolveOf(schema, page.base, section.of);
      if (of.error) return { ...page, error: `${at}: ${of.error}` };
      rootTable = of.table!.id;
    }
    const resolved = resolvePath(schema, section.from, section.path);
    if (resolved.error) return { ...page, error: `${at}: ${resolved.error}` };
    if (resolved.path!.endsAt !== rootTable) {
      return {
        ...page,
        error: `${at}: "${section.path}" leads from ${section.from} to ` + `${resolved.path!.endsAt}, not to ${rootTable}.`,
      };
    }
    if (section.kind === 'list') {
      /* Validate shown and ordered paths with the same compiler that will
         execute the list. In particular, projected/private columns must not
         survive startup just because the relationship itself is valid. */
      const table = findTable(schema, section.from)!;
      const columns = [
        ...(section.columns?.length ? section.columns : defaultColumns(table, section.path, resolved.path!)),
        ...groupFactPaths(section),
      ];
      const grouped = groupProblem(schema, page, section);
      if (grouped) return { ...page, error: `${at}: ${grouped}` };
      const error = validateView(schema, {
        id: `page:${page.id}:${i}`,
        name: at,
        base: table.id,
        columns: columns.map((path) => ({ path })),
        orderBy: section.orderBy?.map((order) => ({ path: order.column, direction: order.direction })),
      });
      if (error) return { ...page, error: `${at}: ${error}` };
      const problem = relatedMatchProblem(schema, page, section);
      if (problem) return { ...page, error: `${at}: ${problem}` };
    }
    if (section.kind === 'metric' && section.fn !== 'count' && !section.column) {
      return { ...page, error: `${at}: "${section.fn}" needs a column to ${section.fn}.` };
    }
    /* A dotted `by` is the view compiler's to judge at run time; a plain one
       is checkable right here, and "the column does not exist" is a better
       sentence before the page is opened than after. */
    if (section.kind === 'chart') {
      const keys = chartKeys(section.by);
      if ('error' in keys) return { ...page, error: `${at}: ${keys.error}` };
      const from = findTable(schema, section.from)!;
      const error = validateView(schema, {
        id: `page:${page.id}:${i}:chart`,
        name: at,
        base: from.id,
        columns: keys.keys.map((key) => ({ path: key.path })),
      });
      if (error) return { ...page, error: `${at}: ${error}` };
      for (const key of keys.keys) {
        if (!key.bucket || key.path.includes('.')) continue;
        const column = from.columns.find((c) => c.name === key.path);
        if (column && !/date|time/i.test(column.type ?? '')) {
          return {
            ...page,
            error: `${at}: "${key.bucket} ${key.path}" cuts ${key.path} into ${key.bucket}s, and it is ${column.type || 'untyped'} — a date column is.`,
          };
        }
      }
      if (section.column && !columnOrRollup(from, section.column)) {
        return { ...page, error: `${at}: "${section.column}" is not a column on ${section.from}.` };
      }
      const ordering = chartSortColumn(section);
      if (ordering && !from.columns.some((c) => c.name === ordering.column)) {
        return { ...page, error: `${at}: "sort" names "${ordering.column}", which is not a column on ${section.from}.` };
      }
    }
    if (section.kind === 'breakdown') {
      const from = findTable(schema, section.from);
      if (from && !section.by.includes('.') && !columnOrRollup(from, section.by)) {
        return { ...page, error: `${at}: "${section.by}" is not a column on ${section.from}.` };
      }
      if (from && section.fn !== undefined && section.fn !== 'count' && !section.column) {
        return { ...page, error: `${at}: "${section.fn}" needs a column to ${section.fn}.` };
      }
      if (from && section.column && !columnOrRollup(from, section.column)) {
        return { ...page, error: `${at}: "${section.column}" is not a column on ${section.from}.` };
      }
    }
  }
  return { ...page, error: undefined };
}

/**
 * Which rows of each timeline stream are the other party's: the condition each stream is asked, with `record.` reached
 * by the stream's way back to the record, or undefined for a stream that has no far side. A stream's own `side` is its
 * condition and must read over its table. The section's `side` is every other stream's, where it reads there: a stream
 * whose table lacks a column it names (a time entry beside the replies, with no author) is never on the far side. A
 * section's `side` no stream can read is refused, so a misspelt column is still named. `error` follows the section's
 * own place, as `, stream "reply": "side": …`.
 */
export function timelineSides(
  schema: DatabaseSchema,
  section: Pick<PageTimeline, 'streams' | 'side'>,
): { sides: (string | undefined)[]; error?: string } {
  const read = (condition: string, stream: TimelineStream): { side?: string; problem?: string } => {
    const side = timelineSide(condition, stream);
    if (side === undefined)
      return {
        problem: `"side" names the record (record.…), and this stream is about "${stream.of}": its rows lead to that row, not back to the record.`,
      };
    const parsed = parseViewQuery(schema, stream.from, side);
    const problem =
      parsed.errors[0]?.message.split(`${stream.path}.`).join('record.') ??
      (parsed.columns.length || parsed.orderBy.length ? 'it is a condition, with no "show" or "sort".' : undefined);
    return problem ? { problem: `"side": ${problem}` } : { side };
  };
  const sides: (string | undefined)[] = [];
  let unread: string | undefined;
  let shared = false;
  for (const stream of section.streams) {
    if (stream.side) {
      const own = read(stream.side, stream);
      if (own.problem) return { sides, error: `, stream "${stream.from}": ${own.problem}` };
      sides.push(own.side);
      continue;
    }
    if (!section.side) {
      sides.push(undefined);
      continue;
    }
    const each = read(section.side, stream);
    if (each.side !== undefined) shared = true;
    else unread ??= `, stream "${stream.from}": ${each.problem}`;
    sides.push(each.side);
  }
  if (section.side && !shared)
    return { sides, error: unread ?? ': "side" is read by no stream: each stream says its own. Leave the section\'s out.' };
  return { sides };
}

/**
 * What a breakdown section needs to run, as a structured BreakdownDef.
 *
 * It borrows the list machinery for everything except the grouping: the
 * `of` resolution, the join back to the record's key, the extra filter
 * text — a breakdown asks the same question a list does, about the same
 * rows, and answers with groups instead of rows. Building the filter twice
 * would be two implementations of "these rows belong to that record" to
 * keep honest.
 */
export function breakdownPlan(
  schema: DatabaseSchema,
  page: PageDef,
  section: PageBreakdown,
  key: Record<string, string | number>,
  index: number,
  now: Date = new Date(),
  ofKeys?: OfKeys,
): { def?: BreakdownDef; empty?: boolean; error?: string } {
  const asList: PageList = {
    kind: 'list',
    from: section.from,
    path: section.path,
    of: section.of,
    filter: section.filter,
    title: section.title,
  };
  const built = listView(schema, page, asList, key, index, now, ofKeys);
  if (built.error) return { error: built.error };
  if (!built.view) return { empty: built.empty };
  const measured = section.fn !== undefined && !(section.fn === 'count' && section.column === undefined);
  return {
    empty: built.empty,
    def: {
      base: built.view.base,
      by: [{ path: section.by }],
      // A count, or the measure it names ("sum open_value"), called `value` as a chart's is.
      measures: [
        measured ? { fn: section.fn!, ...(section.column === undefined ? {} : { path: section.column }), alias: 'value' } : { fn: 'count' },
      ],
      filter: built.view.filter,
      // Biggest first: a breakdown on a page answers "mostly what?".
      orderBy: [{ name: measured ? 'value' : 'count', direction: 'desc' }],
      limit: section.limit ?? 8,
    },
  };
}

/**
 * A chart's `by`, in the breakdown grammar's words: one or two keys, each a
 * path and optionally a period to cut a date into — "month issued_on",
 * "status", "month issued_on, status".
 */
export function chartKeys(by: string): { keys: BreakdownKey[] } | { error: string } {
  const parts = by.split(',').map((part) => part.trim());
  if (!parts.length || parts.length > 2 || parts.some((part) => !part)) {
    return { error: `"${by}" is not one or two keys, like "status" or "month issued_on, status".` };
  }
  const keys: BreakdownKey[] = [];
  for (const part of parts) {
    const m = /^(?:([a-z]+)\s+)?([A-Za-z_$][\w$+]*(?:\.[A-Za-z_$][\w$+]*)*)$/i.exec(part);
    const unit = m?.[1]?.toLowerCase();
    if (unit === 'auto') {
      return {
        error: `"${part}" cuts the date by the window, which only a dashboard chart has: a record page's chart names its unit, like "month issued_on".`,
      };
    }
    if (!m || (unit !== undefined && !(DATE_UNITS as readonly string[]).includes(unit))) {
      return {
        error: `"${part}" is not a key: write a column, a path, or a period and a date column — ${DATE_UNITS.map((u) => `"${u} …"`).join(', ')}.`,
      };
    }
    keys.push({ path: m[2], ...(unit ? { bucket: unit as DateUnit } : {}) });
  }
  return { keys };
}

/** A chart's `sort` when it names a column of the rows ("starts_on", "ended_on desc"), not 'value' or 'category'. */
function chartSortColumn(section: PageChart): { column: string; direction: 'asc' | 'desc' } | undefined {
  if (!section.sort || section.sort === 'value' || section.sort === 'category') return undefined;
  const [column, direction] = section.sort.split(/\s+/);
  return { column, direction: direction === 'desc' ? 'desc' : 'asc' };
}

/**
 * The order a bar chart's or donut's categories are asked in, where the category has one of its own; undefined leaves
 * them biggest first, which the client then arranges by the key's vocabulary or scale (ChartFigure, orderDeclared).
 *
 *   - `sort: 'value'` is biggest first, whatever the key is; `'category'` is the key itself, ascending (a column with a
 *     vocabulary keeps the client's, which knows its order); a column of the rows orders by that column's extreme in
 *     each category.
 *   - Unsaid: a date column, or a number that is a step, runs from the first; and a chart whose category is the rows' own label, a bar for each row of
 *     the table (a sprint's name), runs in the order the rows were made, the primary key ascending. The engine's schema
 *     carries no resource sort, so the key stands for it.
 *
 * Asked of the query and not left to the client: a chart's categories are cut at its limit, and the cut must keep
 * the first ones in this order, not the largest.
 */
function chartOrder(
  schema: DatabaseSchema,
  section: PageChart,
  keys: readonly BreakdownKey[],
  keyAlias: string | undefined,
): { order: BreakdownOrder; measure?: Measure } | undefined {
  const first = keys[0];
  if (!first || !keyAlias || section.sort === 'value') return undefined;
  const table = findTable(schema, section.from);
  const asked = chartSortColumn(section);
  if (asked) {
    const fn = asked.direction === 'desc' ? ('max' as const) : ('min' as const);
    return { order: { name: 'order_1', direction: asked.direction }, measure: { fn, path: asked.column, alias: 'order_1' } };
  }
  if (first.bucket || !table || first.path.includes('.'))
    return section.sort === 'category' ? { order: { name: keyAlias, direction: 'asc' } } : undefined;
  const column = table.columns.find((c) => c.name === first.path);
  if (!column || column.allowed?.length) return undefined;
  /* A number that is a step (a priority, an age in days) runs in its own order; an id, or a reference to a record, is no step. */
  const reference = schema.foreignKeys.some((fk) => fk.from.table === table.id && fk.from.columns.includes(column.name));
  const step = columnKind(column.type) === 'number' && !column.primaryKey && !reference;
  if (section.sort === 'category' || looksLikeDate(column) || step) return { order: { name: keyAlias, direction: 'asc' } };
  const key = primaryKey(table);
  if (key.length && rowName(table) === column.name) {
    return { order: { name: 'order_1', direction: 'asc' }, measure: { fn: 'min', path: key[0], alias: 'order_1' } };
  }
  return undefined;
}

/**
 * What a chart section needs to run: the breakdown section's plan — the same
 * rows, anchored on the record the same way — with the chart's keys, its
 * measure, and the order its shape reads in. A line reads along time, so it
 * is ordered by its key; a donut and stacked bars are ordered on the client
 * (dashboardModel.ts, orderGroups), as a dashboard's are.
 */
export function chartPlan(
  schema: DatabaseSchema,
  page: PageDef,
  section: PageChart,
  key: Record<string, string | number>,
  index: number,
  now: Date = new Date(),
  ofKeys?: OfKeys,
): { def?: BreakdownDef; empty?: boolean; error?: string } {
  const keys = chartKeys(section.by);
  if ('error' in keys) return { error: keys.error };
  const asList: PageList = {
    kind: 'list',
    from: section.from,
    path: section.path,
    of: section.of,
    filter: section.filter,
    title: section.title,
  };
  const built = listView(schema, page, asList, key, index, now, ofKeys);
  if (built.error) return { error: built.error };
  if (!built.view) return { empty: built.empty };
  const measure =
    section.fn === 'count' ? { fn: 'count' as const, alias: 'value' } : { fn: section.fn, path: section.column, alias: 'value' };
  const line = (section.shape ?? 'line') === 'line';
  /* Named here, so the order below and the reader's columns do not depend on how the compiler would name them. */
  const by = keys.keys.map((k, i) => ({ ...k, alias: `key_${i + 1}` }));
  const ordered = line ? undefined : chartOrder(schema, section, keys.keys, by[0]?.alias);
  return {
    empty: built.empty,
    def: {
      base: built.view.base,
      by,
      /* The column a category order reads rides after the value, and is dropped by the drawing (ChartSection). */
      measures: ordered?.measure ? [measure, ordered.measure] : [measure],
      filter: built.view.filter,
      orderBy: line
        ? by.map((k) => ({ name: k.alias, direction: 'asc' as const }))
        : ordered
          ? [ordered.order]
          : [{ name: 'value', direction: 'desc' }],
      // A line keeps every period; the others are cut to their limit on the client, after ordering.
      limit: line ? 500 : 400,
    },
  };
}

/**
 * What one aggregate read of a custom section needs to run: a breakdown, built from the same pieces a metric and a
 * chart on a page are — `whose` anchors it on the record as a related list is, a query narrows it as a list's does —
 * so the figure counts every row the reader may see, not the page of rows a component happened to load, and the
 * reader's grants, row policy and tenant scope narrow it as they narrow every breakdown. With a `by`, one row for
 * each group (`key_1`, `value`); without, one row (`value`).
 */
export function customTotalPlan(
  schema: DatabaseSchema,
  page: PageDef,
  name: string,
  total: PageCustomTotal,
  key: Record<string, string | number>,
  index: number,
  now: Date = new Date(),
): { def?: BreakdownDef; empty?: boolean; error?: string } {
  const keys = total.by === undefined ? { keys: [] as BreakdownKey[] } : chartKeys(total.by);
  if ('error' in keys) return { error: keys.error };
  if (keys.keys.length > 1) return { error: `"by" is one key here: "${total.by}" names ${keys.keys.length}.` };
  let filter: ViewFilter | undefined;
  let base: string;
  if (total.path) {
    const built = listView(
      schema,
      page,
      { kind: 'list', from: total.from, path: total.path, filter: total.filter, title: name },
      key,
      index,
      now,
    );
    if (built.error) return { error: built.error };
    if (!built.view) return { empty: built.empty };
    ({ base, filter } = built.view);
  } else {
    const table = findTable(schema, total.from);
    if (!table) return { error: `"${total.from}" is not a table on this connection.` };
    base = table.id;
    if (total.filter) {
      const parsed = parseViewQuery(schema, table.id, total.filter, now);
      if (parsed.errors.length) return { error: parsed.errors[0].message };
      if (parsed.filter.groups.length) filter = parsed.filter;
    }
  }
  const by = keys.keys.map((k) => ({ ...k, alias: 'key_1' }));
  return {
    def: {
      base,
      by,
      measures: [total.fn === 'count' ? { fn: 'count', alias: 'value' } : { fn: total.fn, path: total.column, alias: 'value' }],
      ...(filter ? { filter } : {}),
      // Biggest first, like a breakdown on a page: "mostly what?".
      ...(by.length ? { orderBy: [{ name: 'value', direction: 'desc' as const }] } : {}),
      limit: by.length ? groupsAsked(total.limit) : 1,
    },
  };
}

/**
 * What is wrong with a custom section's aggregate reads against this schema, or undefined: the resource, the column
 * measured, the key it groups by and the `whose` path leading home, judged before a reader sees the section.
 */
function customTotalsProblem(schema: DatabaseSchema, page: PageDef, section: PageCustom, index: number): string | undefined {
  for (const [name, total] of Object.entries(section.aggregates ?? {})) {
    const here = `figures "${name}"`;
    const table = findTable(schema, total.from);
    if (!table) return `${here}: "${total.from}" is not a table on this connection.`;
    if (total.column && !columnOrRollup(table, total.column)) return `${here}: "${total.column}" is not a column on ${total.from}.`;
    const built = customTotalPlan(schema, page, name, total, {}, index);
    if (built.error) return `${here}: ${built.error}`;
    for (const key of total.by === undefined ? [] : (chartKeys(total.by) as { keys: BreakdownKey[] }).keys) {
      const error = validateView(schema, { id: `page:${page.id}:${index}:${name}`, name, base: table.id, columns: [{ path: key.path }] });
      if (error) return `${here}: ${error}`;
    }
    if (total.path) {
      const resolved = resolvePath(schema, total.from, total.path);
      if (resolved.error) return `${here}: ${resolved.error}`;
      if (resolved.path!.endsAt !== page.base)
        return `${here}: "${total.path}" leads from ${total.from} to ${resolved.path!.endsAt}, not to ${page.base}.`;
    }
  }
  return undefined;
}

/**
 * A compiled section, spelled back in the authored words — whose/about/
 * show/sort — because an emitter speaking the internal field names writes
 * exactly the config parseSection refuses. Both the scaffold and browser
 * editor use this conversion; new section kinds must be handled here.
 */
/* A New form's defaults as they are written: a filled-in word as its constant, `{ auto: 'today' }`. */
function createConfig(create: RelatedCreate<string>): RelatedCreate<string> {
  return create.defaults
    ? {
        ...create,
        defaults: Object.fromEntries(
          Object.entries(create.defaults).map(([column, value]) => [column, authoredSpelling(value)]),
        ) as RelatedCreate['defaults'],
      }
    : create;
}

export function sectionConfig(s: PageSection): AuthoredSection {
  const common = {
    ...(s.title !== undefined ? { title: s.title } : {}),
    ...(s.region !== undefined ? { region: s.region } : {}),
    ...(s.tab !== undefined ? { tab: s.tab } : {}),
    ...(s.width && s.width !== 'full' ? { width: s.width } : {}),
    ...(s.offsetLeft ? { offsetLeft: s.offsetLeft } : {}),
    ...(s.offsetRight ? { offsetRight: s.offsetRight } : {}),
    ...(s.hidden ? { hidden: true } : {}),
    ...(s.when !== undefined ? { when: s.when } : {}),
  };
  switch (s.kind) {
    case 'fields':
      if (s.presentation === 'header')
        return {
          kind: 'header',
          ...(s.hidden ? { hidden: true } : {}),
          ...(s.status !== undefined ? { status: s.status } : {}),
          ...(s.paths?.length
            ? {
                facts: s.paths.map((path) => {
                  const said = s.factLabels?.[path];
                  return said
                    ? {
                        column: path,
                        ...(said.position === 'before'
                          ? { before: said.one }
                          : { after: said.many === undefined ? said.one : { one: said.one, many: said.many } }),
                      }
                    : path;
                }),
              }
            : {}),
          ...(s.primary !== undefined ? { primary: s.primary } : {}),
          ...(s.destructive?.length ? { destructive: s.destructive } : {}),
          ...(s.headerActions?.length ? { actions: s.headerActions } : {}),
        };
      /* A card and a headline are written as the sections they are. */
      if (s.presentation === 'card') return { ...common, kind: 'card', show: s.paths ?? [] };
      if (s.presentation === 'headline')
        return {
          ...common,
          kind: 'headline',
          show: s.paths ?? [],
          ...(s.actions ? { links: s.actions.map((a) => ('view' in a ? (({ view, ...rest }) => ({ ...rest, to: view }))(a) : a)) } : {}),
          ...(s.subfigure !== undefined ? { subfigure: s.subfigure } : {}),
          ...(s.was !== undefined ? { was: s.was } : {}),
          ...(s.note !== undefined ? { note: s.note } : {}),
        } as AuthoredSection;
      return {
        ...common,
        kind: s.kind,
        show: s.paths,
        columns: s.columns,
        ...(s.names === false ? { names: false as const } : {}),
        ...(s.presentation ? { presentation: s.presentation } : {}),
        ...(s.edit ? { editable: true } : {}),
      };
    case 'timeline':
      return {
        ...common,
        kind: s.kind,
        limit: s.limit,
        streams: s.streams.map((stream) => ({
          from: stream.from,
          whose: stream.path,
          at: stream.at,
          show: stream.show,
          detail: stream.detail,
          author: stream.by,
          query: stream.filter,
          ...(stream.of ? { about: stream.of } : {}),
          ...(stream.side ? { side: stream.side } : {}),
          ...(stream.tone ? { tone: stream.tone } : {}),
          ...(stream.compact ? { compact: stream.compact } : {}),
        })),
        ...(s.create ? { create: createSaysMore(s.create) ? createConfig(s.create) : s.create.label } : {}),
        ...(s.newest ? { newest: s.newest } : {}),
        ...(s.composer ? { composer: s.composer as Extract<AuthoredSection, { kind: 'timeline' }>['composer'] } : {}),
        ...(s.tone ? { tone: s.tone } : {}),
        ...(s.compact ? { compact: s.compact } : {}),
        ...(s.side ? { side: s.side } : {}),
      };
    case 'metric':
      return {
        ...common,
        kind: s.kind,
        from: s.from,
        whose: s.path,
        about: s.of,
        // A count is what a metric says when it says nothing.
        ...(s.fn === 'count' && s.column === undefined ? {} : { measure: [s.fn, s.column].filter(Boolean).join(' ') }),
        query: s.filter,
        ...(s.format !== undefined ? { format: s.format } : {}),
        ...(s.unit !== undefined ? { unit: s.unit } : {}),
      };
    /* An embed is said the way it was written: the view, and whose rows. */
    case 'list':
      if (s.view !== undefined)
        return {
          ...common,
          kind: 'view',
          view: s.view,
          whose: s.path,
          ...(s.of !== undefined ? { about: s.of } : {}),
          ...(s.limit !== undefined ? { limit: s.limit } : {}),
        };
      if (s.presentation === 'card')
        return {
          /* The current card takes no offset and no hiding: its placement is the rest of `common`. */
          ...(({ offsetLeft: _left, offsetRight: _right, hidden: _hidden, ...placed }) => placed)(
            common as typeof common & { offsetLeft?: unknown; offsetRight?: unknown; hidden?: unknown },
          ),
          kind: 'current',
          from: s.from,
          whose: s.path,
          show: s.labels ? s.columns?.map((column) => (s.labels![column] ? { column, label: s.labels![column] } : column)) : s.columns,
          query: s.filter,
          ...(s.empty ? { empty: listEmptyConfig(s.empty) } : {}),
          sort: s.orderBy?.map((o) => (o.direction === 'desc' ? `${o.column} desc` : o.column)).join(', '),
        };
      return {
        ...common,
        kind: s.kind,
        from: s.from,
        // A matched list is found by the record's own values: it has no path to say.
        ...(s.similar ? { same: s.similar.same, ...(s.similar.near ? { near: s.similar.near } : {}) } : { whose: s.path }),
        ...(s.sizing !== undefined ? { sizing: s.sizing } : {}),
        ...(s.presentation === 'gallery' ? { presentation: s.presentation } : {}),
        show: s.labels ? s.columns?.map((column) => (s.labels![column] ? { column, label: s.labels![column] } : column)) : s.columns,
        query: s.filter,
        limit: s.limit,
        ...(s.create
          ? { create: createSaysMore(s.create) ? createConfig(s.create) : s.create.label }
          : s.noCreate
            ? { create: false as const }
            : {}),
        ...(s.emptyMode ? { empty: s.emptyMode } : s.empty ? { empty: listEmptyConfig(s.empty) } : {}),
        ...(s.group
          ? {
              group: {
                by: s.group.by,
                ...(s.group.show ? { show: s.group.show } : {}),
                ...(s.group.sort ? { sort: s.group.sort.direction === 'desc' ? `${s.group.sort.column} desc` : s.group.sort.column } : {}),
                ...(s.group.limit === undefined ? {} : { limit: s.group.limit }),
                ...(s.group.empty === undefined ? {} : { empty: s.group.empty }),
                ...(s.group.sum ? { sum: s.group.sum } : {}),
              },
            }
          : {}),
        ...(s.totals ? { totals: s.totals } : {}),
        ...(s.rowActions ? { rowActions: true as const } : {}),
        ...(s.listActions ? { actions: s.listActions } : {}),
        sort: s.orderBy?.map((o) => (o.direction === 'desc' ? `${o.column} desc` : o.column)).join(', '),
      };
    case 'breakdown':
      return {
        ...common,
        kind: s.kind,
        from: s.from,
        whose: s.path,
        about: s.of,
        by: s.by,
        ...(s.fn === undefined || (s.fn === 'count' && s.column === undefined)
          ? {}
          : { measure: [s.fn, s.column].filter(Boolean).join(' ') }),
        query: s.filter,
        limit: s.limit,
        ...(s.format !== undefined ? { format: s.format } : {}),
        ...(s.unit !== undefined ? { unit: s.unit } : {}),
      };
    case 'history':
      return { ...common, kind: s.kind, ...(s.limit !== undefined ? { limit: s.limit } : {}) };
    case 'flows':
    case 'diagram':
      return { ...common, kind: s.kind };
    case 'chart':
      return {
        ...common,
        kind: s.kind,
        from: s.from,
        whose: s.path,
        about: s.of,
        by: s.by,
        ...(s.fn === 'count' && s.column === undefined ? {} : { measure: [s.fn, s.column].filter(Boolean).join(' ') }),
        ...(s.shape ? { shape: s.shape } : {}),
        ...(s.sort ? { sort: s.sort } : {}),
        query: s.filter,
        limit: s.limit,
        ...(s.height !== undefined ? { height: s.height } : {}),
        ...(s.target !== undefined ? { target: s.target } : {}),
        ...(s.format !== undefined ? { format: s.format } : {}),
        ...(s.unit !== undefined ? { unit: s.unit } : {}),
      };
    case 'note':
      return {
        ...common,
        kind: s.kind,
        text: s.text,
        ...(s.variant ? { variant: s.variant } : {}),
        ...(s.icon ? { icon: s.icon } : {}),
        ...(s.action ? { action: 'view' in s.action ? { label: s.action.label, to: s.action.view } : s.action } : {}),
      };
    case 'custom':
      return {
        ...common,
        kind: s.kind,
        component: s.component as Extract<AuthoredSection, { kind: 'custom' }>['component'],
        ...(s.record ? { record: s.record } : {}),
        ...(s.reads
          ? {
              rows: Object.fromEntries(
                Object.entries(s.reads).map(([name, read]) => [
                  name,
                  {
                    from: read.from,
                    ...(read.path ? { whose: read.path } : {}),
                    ...(read.filter ? { query: read.filter } : {}),
                    show: read.columns,
                    ...(read.sort ? { sort: read.sort } : {}),
                    ...(read.limit ? { limit: read.limit } : {}),
                  },
                ]),
              ),
            }
          : {}),
        ...(s.aggregates
          ? {
              figures: Object.fromEntries(
                Object.entries(s.aggregates).map(([name, total]) => [
                  name,
                  {
                    from: total.from,
                    measure: (total.column === undefined ? total.fn : `${total.fn} ${total.column}`) as CustomMeasure,
                    ...(total.by ? { by: total.by } : {}),
                    ...(total.path ? { whose: total.path } : {}),
                    ...(total.filter ? { query: total.filter } : {}),
                    ...(total.limit ? { limit: total.limit } : {}),
                  },
                ]),
              ),
            }
          : {}),
        ...(s.props && Object.keys(s.props).length ? { props: s.props as Record<string, string | number | boolean> } : {}),
      };
    default: {
      const unsupported: never = s;
      throw new Error(`Cannot export an unsupported page section: ${JSON.stringify(unsupported)}`);
    }
  }
}

/** A Workbench page (tablewalk.json) also names the one connection it is for; an App's page has its App's. */
type WorkbenchPage = Omit<AuthoredPage, 'sections'> & {
  label?: string;
  sections?: readonly AuthoredSection[];
  connection?: string;
};

/** A whole page in the authored spelling, ready to write to a pages/ file. */
export function pageConfig(p: PageDef): WorkbenchPage {
  return {
    label: p.name,
    base: p.base,
    sections: p.sections.map(sectionConfig),
    ...(p.connection !== undefined ? { connection: p.connection } : {}),
    ...(typeof p.listTabs === 'boolean' ? { listTabs: p.listTabs } : {}),
    ...(p.empty ? { empty: p.empty } : {}),
  };
}

/**
 * A page for a table nobody has written one for: the record, a count of each
 * thing that points at it, and the two biggest of those as lists.
 */
export function suggestPage(schema: DatabaseSchema, baseId: string): PageDef | null {
  const base = findTable(schema, baseId);
  if (!base || !primaryKey(base).length) return null;

  const incoming = referencesTo(schema, base.id).filter((fk) => pageHop(schema, fk) !== undefined);
  const sections: PageSection[] = [{ kind: 'fields', width: 'full' }];

  /* Lists for the first few, counts for the rest — never both for the same
     relationship.
  
     A count above a list of the rows it counted says nothing the list does
     not: `ROOM 2` over a table of two rooms is a number and its own proof,
     taking a card to do it. The count belongs *on* the list, where it says
     how many there are beyond the ones shown; a card earns its place only for
     a relationship you cannot see, which is what the ones past the listed
     few are. Show the big ones, count the rest. */
  const listed = incoming.slice(0, LISTED);
  const counted = incoming.slice(LISTED, LISTED + COUNTED);

  for (const fk of counted) {
    const child = findTable(schema, fk.from.table);
    const path = pageHop(schema, fk);
    if (!child || path === undefined) continue;
    sections.push({
      kind: 'metric',
      fn: 'count',
      from: child.id,
      path,
      title: metricTitle(counted, fk, child.name, base.id),
      width: 'third',
    });
  }

  for (const fk of listed) {
    const child = findTable(schema, fk.from.table);
    const path = pageHop(schema, fk);
    if (!child || path === undefined) continue;
    sections.push({
      kind: 'list',
      from: child.id,
      path,
      title: metricTitle(listed, fk, child.name, base.id),
      limit: DEFAULT_PAGE_LIST_LIMIT,
      width: listed.length > 1 ? 'half' : 'full',
    });
  }

  return {
    id: `suggested:${base.id}`,
    name: base.name,
    base: base.id,
    sections,
    source: 'suggested',
  };
}

/**
 * What to call a count.
 *
 * The child's name, which is what someone reading a summary expects — until
 * that is not enough to tell two counts apart. A table pointing at the same
 * parent twice gives two counts both labelled `work_order`, and a
 * self-reference gives a count labelled with the table you are already on:
 * `employee` on an employee page, which is the count of their reports and
 * says nothing of the sort. Both cases are named by their foreign key
 * instead, which is the thing that actually differs.
 */
function metricTitle(chosen: readonly ForeignKey[], fk: ForeignKey, childName: string, baseId: string): string {
  const ambiguous = chosen.filter((other) => other.from.table === fk.from.table).length > 1;
  const selfReference = fk.from.table === baseId;
  return ambiguous || selfReference ? `${childName} via ${fk.from.columns.join(', ')}` : childName;
}

/* ---------- what a page could show ---------- */

/** One thing a section could be built from, ready to put in a menu. */
export interface Relation {
  /** The table a section would list or count. */
  from: string;
  /** How a row of it names the root. */
  path: string;
  /** What to call it, already disambiguated. */
  label: string;
  /** How many references away, for grouping "direct" from "further out". */
  hops: number;
  /** The foreign keys followed, so a builder can explain the route. */
  via: string[];
  /**
   * Every spelling of this path that resolves to it.
   *
   * A hop can be named by its constraint or by its column, and both are
   * legal — `resolvePath` accepts either. So the path in a hand-written
   * config (`customer_id`) and the path this function generates
   * (`invoice_fk_2`) are different strings for the same relationship, and
   * anything matching on the string alone decides they are different
   * relationships. The builder does exactly that when it looks up the
   * relation a section came from.
   */
  aliases: string[];
}

/**
 * Every way a table could reach this root, within a couple of hops.
 *
 * The one field nobody guesses when writing a page by hand is the path —
 * `invoice_id.customer_id` is obvious only once you already know it. So it is
 * not typed: the schema is asked what actually points here, directly and one
 * table further out, and each answer comes back with the path already
 * written.
 *
 * Two hops rather than the full depth limit. Three is a real relationship and
 * a list nobody can read: on a schema of this size it runs to hundreds of
 * entries, most of them routes no one would choose, and a menu that long is a
 * menu people close.
 */
export function relationsTo(schema: DatabaseSchema, baseId: string, maxHops = 2): Relation[] {
  const base = findTable(schema, baseId);
  if (!base) return [];

  const found: Relation[] = [];
  const seen = new Set<string>();
  /** Every spelling of each path already built, so deeper hops can extend them. */
  const aliasesOf = new Map<string, string[]>([['', ['']]]);

  const walk = (targetId: string, path: string[], via: string[], hops: number) => {
    if (hops > maxHops) return;
    for (const fk of schema.foreignKeys) {
      if (fk.to.table !== targetId) continue;
      const child = findTable(schema, fk.from.table);
      if (!child) continue;

      // Public logical constraint names may contain dots. Forward paths use
      // column-based hops, including all columns of a composite reference.
      const preferred = pageHop(schema, fk);
      if (preferred === undefined) continue;
      const next = [preferred, ...path];
      const route = next.join('.');
      const id = `${child.id}|${route}`;
      if (seen.has(id)) continue;
      seen.add(id);

      const target = findTable(schema, targetId);
      // Advertise only aliases that actually resolve to this exact hop.
      const hopNames = [...new Set([hopName(fk), fk.name])].filter((name) => {
        const resolved = resolvePath(schema, child.id, name).path;
        return resolved?.hops.length === 1 && resolved.hops[0] === fk;
      });
      const tailAliases = aliasesOf.get(path.join('.')) ?? [path.join('.')];
      const aliases = hopNames.flatMap((name) => tailAliases.map((tail) => (tail ? `${name}.${tail}` : name)));
      aliasesOf.set(route, aliases);

      found.push({
        from: child.id,
        path: route,
        aliases,
        label: child.name,
        hops: hops + 1,
        /* Table names and joining columns, innermost first so the description
           reads outward from the root. */
        via: [`${child.name}.${fk.from.columns.join(', ')} \u2192 ${target?.name ?? targetId}`, ...via],
      });

      /* Not through the root, and not through itself. A self-referencing key
         is a real relationship at one hop and an infinite regress past it. */
      if (child.id !== baseId && child.id !== targetId) {
        walk(
          child.id,
          next,
          [`${child.name}.${fk.from.columns.join(', ')} \u2192 ${findTable(schema, targetId)?.name ?? targetId}`, ...via],
          hops + 1,
        );
      }
    }
  };
  walk(base.id, [], [], 0);

  /* Disambiguated after the fact rather than while walking, because whether
     `invoice` needs qualifying depends on whether a *second* invoice route
     turned up later.
  
     Qualified by the columns, not by the path: `invoice via sold_by` is a
     sentence someone can check against the schema in their head, where
     `invoice via invoice_fk_2` is a string only the database has ever seen. */
  /* Qualified only as far as it takes, and as far as it takes.
  
     One pass was not enough. `work_log through ticket` was three entries on
     the employee page — work_log reaches employee through ticket by
     `assigned_to`, by `raised_by` and by `closed_by` — and all three were
     rendered with the same words and the same detail line underneath. Three
     identical rows in a menu is a menu you cannot use: whichever is picked,
     nobody can tell which was picked.
  
     So each name is refined until it is unique, one step at a time, and only
     the ones that collide take the next step. `invoice` stays `invoice` where
     nothing else is called that. */
  const steps = new Map<Relation, number>(found.map((r) => [r, 0]));
  for (let pass = 0; pass < 4; pass += 1) {
    const groups = new Map<string, Relation[]>();
    for (const r of found) {
      const label = qualify(r, steps.get(r) ?? 0);
      const group = groups.get(label);
      if (group) group.push(r);
      else groups.set(label, [r]);
    }
    let refined = false;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const r of group) {
        steps.set(r, (steps.get(r) ?? 0) + 1);
        refined = true;
      }
    }
    if (!refined) break;
  }
  for (const r of found) r.label = qualify(r, steps.get(r) ?? 0);

  return found.sort((a, b) => a.hops - b.hops || a.label.localeCompare(b.label));
}

/**
 * The columns of one hop, out of the sentence it is written as.
 *
 * A `via` entry reads `work_log.ticket_id \u2192 ticket`, which is the form the
 * screen wants; this is the one place that takes it apart again.
 */
const hopColumns = (via: string | undefined) => via?.split(' \u2192 ')[0]?.split('.').slice(1).join('.') ?? '';

const hopTarget = (via: string | undefined) => via?.split('\u2192 ')[1] ?? '\u2026';

/**
 * A relationship's name at a given degree of qualification.
 *
 * Step 0 is the child table's name, which is right whenever nothing else on
 * the page is called that. Each step after it adds the next thing that could
 * tell two of them apart, in the order a reader would ask: which column, then
 * which table in the middle, then which column *that* one reaches the root
 * by. The last step falls back to the path — unreadable, and unique by
 * construction, which is what a last step is for.
 */
function qualify(r: Relation, step: number): string {
  const name = r.label.split(' via ')[0].split(' through ')[0];
  if (step <= 0) return name;
  if (r.hops === 1) {
    return step === 1 ? `${name} via ${hopColumns(r.via[0])}` : `${name} (${r.path})`;
  }
  /* Two hops are told apart by the table in the middle — `contract_line
     through contract` and `contract_line through asset` are two genuinely
     different lists. Naming the root instead would label both of them
     "through customer", which is the thing they have in common. */
  if (step === 1) return `${name} through ${hopTarget(r.via[0])}`;
  /* And where the middle table is the same, by how *it* reaches the root:
     `work_log through ticket.assigned_to` against `\u2026 through
     ticket.raised_by`. `via` runs innermost first, so the hop that lands on
     the root is the last one. */
  if (step === 2 && r.hops === 2) {
    /* Only at exactly two hops, where the table in the middle is also the one
       holding the column that reaches the root. Three hops out they are
       different tables, and `work_log through ticket.lead_employee_id` would
       name a column that is on `team` — a sentence that reads as fact and is
       not one. Those go straight to the full spelling below. */
    return `${name} through ${hopTarget(r.via[0])}.${hopColumns(r.via[r.via.length - 1])}`;
  }
  if (step === 2 || step === 3) {
    return `${name} through ${r.via.map((v) => hopColumns(v)).join(' \u2192 ')}`;
  }
  return `${name} (${r.path})`;
}

/** Columns of a table that a metric could summarise. `count` needs none. */
export function metricColumns(schema: DatabaseSchema, tableId: string): string[] {
  const table = findTable(schema, tableId);
  if (!table) return [];
  /* Only the numeric ones. `sum` of a name is not a question, and offering it
     produces a page that fails at run time for a reason the builder knew at
     build time. */
  return table.columns.filter((c) => /int|numeric|decimal|real|double|float|money|serial/i.test(c.type)).map((c) => c.name);
}
