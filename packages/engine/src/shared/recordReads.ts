/**
 * What a record page reads, as the requests its sections send.
 *
 * A record page used to reach its reader in three waves of requests — the
 * root and the plan, then a request or two per section, then the history —
 * and at 20 ms to the database each wave was a round of admissions and
 * statements: a lender's loan finished at 0.9 s. The server now answers the
 * whole page in one request (server/http/recordCompose.ts, and the tenant
 * host's own): it plans the page, then asks each section's read on the
 * section's behalf, through the same route and the same grants as the
 * section's own request, and hands every answer back beside the plan. The
 * client keeps them for the requests they answer (client/composedReads.ts),
 * and a section that asks finds its answer waiting.
 *
 * So the one rule is that server and client build each request alike, and
 * the builders live here, used by both: the sections' own modules call them
 * for the request they send, and the server calls them to know what the
 * sections will ask. A request built differently is only asked again — the
 * section sends it, as it always did — so a drift costs a request, never a
 * wrong answer.
 *
 * The record's own row is the one read that is not asked alike: every fields
 * section, the header, the root probe and a custom section's record fields
 * read the one row, each for its columns, and which of them ask together
 * depends on what is drawn (a tab not yet opened asks nothing). The server
 * reads every column any of them names, once, and each is answered with
 * exactly its part (`rowPart`), as the client's own shared read already was
 * (pageFieldsRead.ts).
 */
import { subtitlePath } from './subtitlePath.js';
import { listSecondLineColumns } from './appListColumns.js';
import type { AppCardsList } from './appCards.js';
import { findTable, labelPath, primaryKey, type DatabaseSchema, type TableMeta } from './schema.js';
import { DEFAULT_HISTORY_LIMIT, HISTORY_TAB, isInferredPage, kindReading, type PageSection } from './pageModel.js';
import { resolvePath } from './pagePaths.js';
import { COUNT_EACH_MAX } from './reads.js';
import { assertNever } from './model.js';
import { andQuery, quoteValue } from './query.js';
import { tabMatches } from './addressParams.js';
import { recordView, referenceProjection } from './referenceModel.js';
import { tableAtPrefix } from './viewPaths.js';
import type { HttpBreakdownDefinition, HttpFilter } from './resourceHttp.js';
import { appTargetFields, type AppTarget } from './appLinks.js';

/** The route a record page is composed on. */
export const RECORD_COMPOSE_PATH = '/api/pages/compose';

/** Where a table's rows are named, as the reader's App says it (`recordLabel`, false where it is withheld). */
export interface RecordReadNames {
  readonly schema: DatabaseSchema;
  /** Reads in an App's words: references carry their record's name, lists their keys. */
  readonly app: boolean;
  readonly recordLabel: (tableId: string) => string | false | undefined;
  /** Where a table's rows are named, where the reader already knows (the client's labelPath, which is this rule over the same three). */
  readonly namePath?: (table: TableMeta) => string | undefined;
  /** A table by id, where the reader already holds it (the client's findTable, over the same schema). */
  readonly table?: (id: string) => TableMeta | undefined;
  /** A table's row-defined JSON columns (`resources.<r>.defined`): a section showing one also reads its `per`. */
  readonly defined?: (tableId: string) => Readonly<Record<string, { per?: string }>> | undefined;
  /** A column's display rule (`resources.<r>.display`), where a shown column's `subtitle` is read with the record. */
  readonly display?: (tableId: string, column: string) => { subtitle?: string } | null | undefined;
}

/** The parts of a section its reads are built from (client pageModel.ts PageSection, shared page.ts). */
export interface ReadSection {
  readonly kind: PageSection['kind'];
  readonly hidden?: boolean;
  readonly emptyMode?: 'hide' | 'collapse' | 'show';
  /** A grouped related list reads its groups, then each group's rows (the rows wait on the groups). */
  readonly group?: unknown;
  readonly presentation?: unknown;
  readonly paths?: readonly string[];
  readonly status?: string;
  readonly subfigure?: string;
  readonly subtitle?: string;
  readonly spans?: Readonly<Record<string, string>>;
  readonly was?: string;
  readonly actions?: ReadonlyArray<{ readonly prefill?: Readonly<Record<string, string>>; readonly to?: AppTarget }>;
  readonly names?: boolean;
  readonly workflow?: { readonly field: string };
  readonly from?: string;
  /** A related list's way back to the record, and its own narrowing: what its tab's count asks. */
  readonly path?: string;
  readonly filter?: string;
  readonly of?: string;
  readonly similar?: unknown;
  readonly limit?: number;
  readonly record?: readonly string[];
  readonly when?: string;
  readonly region?: string;
  readonly tab?: string;
  readonly title?: string;
  readonly width?: unknown;
}

/** A planned view, as the server builds it (ViewDef) or the client reads it off the wire (HttpViewDefinition). */
interface ReadView {
  readonly base: string;
  readonly columns?: ReadonlyArray<{ readonly path: string; readonly alias?: string }>;
  readonly filter?: unknown;
  readonly limit?: number;
}

/** The parts of a section's plan its reads are built from (pagePlans.ts). */
export interface ReadPlan<V extends ReadView = ReadView> {
  readonly index: number;
  readonly error?: string;
  readonly empty?: boolean;
  readonly view?: V;
  readonly counts?: boolean;
  readonly totals?: HttpBreakdownDefinition;
  readonly groups?: HttpBreakdownDefinition;
  readonly breakdown?: HttpBreakdownDefinition;
  readonly streams?: ReadonlyArray<TimelineReadStream<V>>;
  readonly reads?: Readonly<Record<string, { readonly error?: string; readonly empty?: boolean; readonly view?: V }>>;
  /** A custom section's aggregate reads, each a breakdown. */
  readonly aggregates?: Readonly<
    Record<string, { readonly error?: string; readonly empty?: boolean; readonly breakdown?: HttpBreakdownDefinition }>
  >;
}

/** A timeline stream's plan, as far as its reads go (pagePlans.ts): its table, its author, its rows and its far side. */
interface TimelineReadStream<V extends ReadView = ReadView> {
  readonly error?: string;
  readonly empty?: boolean;
  readonly from?: string;
  readonly by?: string;
  readonly view?: V;
  readonly key?: readonly string[];
  readonly side?: { readonly error?: string; readonly view?: V };
}

/**
 * A timeline stream's reads, as its section asks them (kit PageTimeline.tsx): its rows, where its author is a
 * reference with the person's name beside it, read through the reference as a list column of it is; and where the
 * stream has a far side, that side's rows. One rule for the section and the page's planned reads (`recordReads`),
 * so a composed page's answer is the very read the section asks: a record page whose timeline was planned without
 * the author's name asked it again, alone, once the page had drawn (a field report: a fifth round on a record).
 */
export function timelineReads<V extends ReadView>(
  names: { readonly table: (id: string) => TableMeta | undefined; readonly namePath: (table: TableMeta) => string | undefined },
  stream: TimelineReadStream<V>,
): { view: V; side?: V } | undefined {
  if (stream.error || stream.empty || !stream.view) return undefined;
  const table = stream.from === undefined ? undefined : names.table(stream.from);
  const reference = stream.by ? table?.columns.find((column) => column.name === stream.by)?.references : undefined;
  const target = reference ? names.table(reference.table) : undefined;
  const named = target && names.namePath(target);
  const view =
    target && named && !primaryKey(target).includes(named)
      ? ({ ...stream.view, columns: [...(stream.view.columns ?? []), { path: `${stream.by}.${named}` }] } as V)
      : stream.view;
  const side = stream.side?.view && !stream.side.error && stream.key?.length ? stream.side.view : undefined;
  return side ? { view, side } : { view };
}

/** One request, as a section sends it: its route and its body, without the owner the transport adds. */
export interface ReadAsk {
  readonly path: string;
  readonly body: Record<string, unknown>;
  /** What the read is where it is not a page's own: a related list's (the `x-mistri-read` a list asking alone would carry), so a read audit says so. */
  readonly kind?: 'related';
}

/** Where a table's rows are named, as a view path. */
const namePathOf = (names: RecordReadNames, table: TableMeta): string | undefined =>
  names.namePath ? names.namePath(table) : labelPath(names.schema, table, names.recordLabel(table.id));

/**
 * The fields a section shows when it names none. In the Workbench, every
 * column: it is the database as it is. In an App, every column a reader
 * reads — not a key the database handed out (a lone numeric or uuid primary
 * key, which opened a lead on "ID 2") and not a row version, the same two
 * the scaffold leaves out of the fields it writes (server/scaffold.ts).
 */
export function defaultFieldPaths(base: TableMeta, app: boolean): string[] {
  const keys = base.columns.filter((c) => c.primaryKey);
  const surrogate = (c: TableMeta['columns'][number]) =>
    c.primaryKey && keys.length === 1 && (/^(id|uuid|guid)$/i.test(c.name) || /int|serial|number|numeric|uuid/i.test(c.type ?? ''));
  const version = (c: TableMeta['columns'][number]) => /^(version|lock_version|row_version|rowversion|revision)$/i.test(c.name);
  const read = base.columns.filter((c) => !app || !(surrogate(c) || version(c))).map((c) => c.name);
  return read.length ? read : base.columns.map((c) => c.name);
}

/**
 * The second lines of the columns at `paths`: a column whose rule has a `subtitle` is drawn with it wherever it is a
 * field, a header's fact or a card's title, so the record reads it too (the same rule a list's cell reads,
 * listQuestion.ts subtitleColumns). A path through a reference reads it from the table it reaches.
 */
function secondLines(names: RecordReadNames, base: TableMeta, paths: readonly string[]): string[] {
  if (!names.display) return [];
  return paths.flatMap((path) => {
    const hop = path.lastIndexOf('.');
    const owner = hop < 0 ? base.id : tableAtPrefix(names.schema, base.id, path.slice(0, hop))?.id;
    const second = owner ? subtitlePath(names.display!(owner, path.slice(hop + 1)), path) : undefined;
    return second ? [second] : [];
  });
}

/** A fields section's columns: what it shows, the names of what it references, the record's name, and its workflow's field. */
export function fieldsColumns(
  names: RecordReadNames,
  base: TableMeta,
  section: ReadSection,
): { fetched: string[]; labels: Map<string, string> } {
  const paths = section.paths?.length ? [...section.paths] : defaultFieldPaths(base, names.app);
  const namePath = namePathOf(names, base);
  /* A headline also reads its second figure and every field its actions
     fill a form from; they are fetched, not shown as facts. */
  const extra =
    section.presentation === 'headline'
      ? [
          ...(section.subfigure ? [section.subfigure] : []),
          ...(section.subtitle ? [section.subtitle] : []),
          ...(section.was ? [section.was] : []),
          ...(section.actions ?? []).flatMap((action) => [
            ...Object.values(action.prefill ?? {}),
            ...(action.to ? appTargetFields(action.to) : []),
          ]),
        ].filter((path) => !paths.includes(path))
      : [];
  const seconds = secondLines(names, base, [...new Set([...paths, ...(section.presentation === 'headline' ? extra : [])])]);
  const projection = referenceProjection(
    names.schema,
    base,
    [...new Set([...paths, ...extra, ...seconds])],
    section.names !== false && names.app,
    (table) => namePathOf(names, table),
  );
  const fetched = projection.fetched;
  if (namePath && !fetched.includes(namePath)) fetched.push(namePath);
  if (section.workflow && !fetched.includes(section.workflow.field)) fetched.push(section.workflow.field);
  // A row-defined column's fields are the ones its record's `per` picks (definedFields.ts),
  // through a reference too: `requested_item_id.answers` reads `requested_item_id.<per>`.
  for (const path of paths) {
    const through = names.defined ? definedThrough(names.schema, base.id, path, names.defined) : undefined;
    const per = through?.binding.per;
    const perPath = per === undefined ? undefined : through!.prefix ? `${through!.prefix}.${per}` : per;
    if (perPath && !fetched.includes(perPath)) fetched.push(perPath);
  }
  return { fetched, labels: projection.labels };
}

/**
 * The row-defined column a fields path ends on (`resources.<r>.defined`):
 * the record's own (`specs`) or one through references
 * (`requested_item_id.answers`), with the table it lives on, the hops before
 * it, and its binding. Undefined for any other path. A record shows the
 * column's fields wherever its path is shown, not only on its own page.
 */
export function definedThrough<B extends { per?: string }>(
  schema: DatabaseSchema,
  baseId: string,
  path: string,
  defined: (tableId: string) => Readonly<Record<string, B>> | undefined,
): { table: TableMeta; column: string; prefix: string; binding: B } | undefined {
  const cut = path.lastIndexOf('.');
  const prefix = cut === -1 ? '' : path.slice(0, cut),
    column = path.slice(cut + 1);
  const table = tableAtPrefix(schema, baseId, prefix);
  const bound = table ? defined(table.id) : undefined;
  if (!table || !bound || !Object.hasOwn(bound, column)) return undefined;
  return { table, column, prefix, binding: bound[column] };
}

/** A record header's columns: its status, its facts, the names of what they reference, and the record's name. */
export function headerColumns(
  names: RecordReadNames,
  base: TableMeta,
  section: ReadSection,
): { fetched: string[]; labels: Map<string, string> } {
  const projection = referenceProjection(
    names.schema,
    base,
    [...(section.status ? [section.status] : []), ...(section.paths ?? [])],
    names.app,
    (table) => namePathOf(names, table),
  );
  const fetched = projection.fetched;
  const namePath = namePathOf(names, base);
  if (namePath && !fetched.includes(namePath)) fetched.push(namePath);
  /* An inferred page's line under the record's name (pageAnatomy.ts). */
  if (section.subtitle && !fetched.includes(section.subtitle)) fetched.push(section.subtitle);
  /* And where a fact runs until: a visit's end, said with its start as one range. */
  for (const end of Object.values(section.spans ?? {})) if (!fetched.includes(end)) fetched.push(end);
  /* A fact's second line is drawn under its value, as a field's is. */
  for (const second of secondLines(names, base, section.paths ?? [])) if (!fetched.includes(second)) fetched.push(second);
  return { fetched, labels: projection.labels };
}

/** The key as a filter on the record's own row, one equality per key column. */
function keyFilter(base: TableMeta, key: Readonly<Record<string, unknown>>): HttpFilter<'path'> {
  return { groups: [primaryKey(base).map((column) => ({ path: column, op: '=' as const, value: key[column] as string | number }))] };
}

/** A read of the record's own row, for columns: the probe (`root`), a fields section (`fields`), the header (`header`), a custom section's record (`<index>:record`). */
export function rowBody(pageId: string, base: TableMeta, key: Readonly<Record<string, unknown>>, columns: readonly string[], part: string) {
  return {
    count: 'none' as const,
    view: {
      id: `page:${pageId}:${part}`,
      name: base.name,
      base: base.id,
      columns: columns.map((path) => ({ path })),
      filter: keyFilter(base, key),
      limit: 1 as const,
    },
  };
}

/** The probe's columns: the key, and the record's name. */
function probeColumns(names: RecordReadNames, base: TableMeta): string[] {
  const namePath = namePathOf(names, base);
  return [...primaryKey(base), ...(namePath ? [namePath] : [])];
}

const isCards = (presentation: unknown): presentation is AppCardsList =>
  typeof presentation === 'object' && presentation !== null && (presentation as { kind?: unknown }).kind === 'cards';

/** A related list's first request: its planned view at the reader's page size, with the names and keys a row needs. */
export function listView<V extends ReadView>(names: RecordReadNames, section: ReadSection, plan: ReadPlan<V>, rows: number) {
  const table = names.table ? names.table(section.from ?? '') : findTable(names.schema, section.from ?? '');
  const limit = section.limit ?? rows;
  const sized: V | undefined = plan.view && !section.limit ? { ...plan.view, limit } : plan.view;
  /* Cards read the second lines of the columns they draw with one (appListColumns.ts listSecondLineColumns). */
  const drawn = (sized as { columns?: ReadonlyArray<{ path: string }> } | undefined)?.columns;
  const seconds =
    table && drawn && isCards(section.presentation)
      ? secondLines(names, table, listSecondLineColumns(section.presentation)).filter((path) => !drawn.some((c) => c.path === path))
      : [];
  const view: V | undefined = seconds.length ? { ...sized!, columns: [...drawn!, ...seconds.map((path) => ({ path }))] } : sized;
  const explicit = (target: TableMeta) => (names.recordLabel(target.id) === undefined ? undefined : namePathOf(names, target));
  type Columns = Array<{ path: string; alias?: string }>;
  return view && table
    ? recordView(names.schema, table, view as V & { columns?: Columns }, names.app, (target) => namePathOf(names, target), explicit)
    : {
        view: view as (V & { columns: Columns }) | undefined,
        labelColumns: {} as Record<string, string>,
        hidden: [] as string[],
        keyColumns: [] as Array<{ column: string; index: number }>,
        labelColumn: undefined as { path: string; index: number } | undefined,
      };
}

/** A grouped list's page of groups, as `/api/breakdown` takes it: the request the page's compose asks and the list asks again. */
export function groupsBody(groups: HttpBreakdownDefinition, offset: number) {
  return { def: groups, limit: groups.limit, offset };
}

/** A metric's measure: a count asked as a breakdown with no key, or the plan's own breakdown; none for a plain aggregate. */
export function metricMeasure(plan: ReadPlan<ReadView>): HttpBreakdownDefinition | undefined {
  const counted: HttpBreakdownDefinition | undefined =
    plan.counts && plan.view && !plan.breakdown
      ? {
          base: plan.view.base,
          by: [],
          measures: [{ fn: 'count', alias: 'value' }],
          ...(plan.view.filter ? { filter: plan.view.filter as HttpBreakdownDefinition['filter'] } : {}),
          limit: 1,
        }
      : undefined;
  return plan.breakdown ?? counted;
}

/** Whether the record satisfies a `when`: one bounded query, key and condition composed the way every fold is. */
export function whenBody(base: TableMeta, key: Readonly<Record<string, unknown>>, when: string) {
  const keyText = primaryKey(base)
    .map((c) => `${c} = ${quoteValue(String(key[c]))}`)
    .join(' and ');
  return { q: `${base.id} ${andQuery(keyText, when)}`, limit: 1, offset: 0, count: 'none' as const };
}

/** The first page of a record's history. */
export function historyBody(base: TableMeta, key: Readonly<Record<string, unknown>>, limit: number) {
  return { table: base.id, key, limit };
}

/**
 * The sections a page draws when it opens on `tab`, as PageSections.tsx lays
 * them out: a strip of named tabs draws the one asked for (the first, when
 * none is) and every panel holding the record's own fields; a run of lists
 * made into tabs draws the one asked for; everything else is drawn. The
 * header is drawn in the head. What a closed tab would read is read when it
 * is opened, as ever, and asked for nothing here.
 */
export function drawnSections(
  schema: DatabaseSchema,
  page: { id?: string; sections: readonly ReadSection[]; listTabs?: boolean },
  tab: string | undefined,
  appPage: boolean,
): Set<number> {
  return laidSections(schema, page, tab, appPage).drawn;
}

/** The address word a tab of a run of lists answers to: its list's title or table, an inferred page's history's own. */
function listTabToken(schema: DatabaseSchema, section: ReadSection): string {
  return section.kind === 'history' ? HISTORY_TAB : (section.title ?? findTable(schema, section.from ?? '')?.name ?? section.from ?? '');
}

/**
 * A section a run of lists draws as one of its tabs: a list that is no picture and has no width an author gave it,
 * and on an inferred page its history, which ends the strip (pageAnatomy.ts) — read when its tab is opened, never
 * with the page.
 */
export function tabbedSection(section: ReadSection, appPage: boolean, inferred: boolean): boolean {
  return (
    (section.kind === 'list' && section.presentation !== 'gallery' && (section.width === undefined || !appPage)) ||
    (inferred && section.kind === 'history')
  );
}

/** What drawnSections says, and each run of related lists by its sections' indexes: a strip of tabs, or a list alone. */
function laidSections(
  schema: DatabaseSchema,
  page: { id?: string; sections: readonly ReadSection[]; listTabs?: boolean },
  tab: string | undefined,
  appPage: boolean,
): { drawn: Set<number>; runs: number[][] } {
  const drawn = new Set<number>();
  const runs: number[][] = [];
  const inferred = isInferredPage(page, appPage);
  const shownAll = page.sections.map((section, index) => ({ section, index })).filter(({ section }) => !section.hidden);
  const header = shownAll.find(({ section }) => section.kind === 'fields' && section.presentation === 'header');
  if (header) drawn.add(header.index);
  const hasAside = page.sections.some((section) => section.region === 'aside' && !section.hidden);
  const autoTabs = appPage ? page.listTabs === true : page.listTabs !== false;
  const tabbed = (section: ReadSection) => tabbedSection(section, appPage, inferred);
  type Shown = { section: ReadSection; index: number };
  const lay = (items: readonly Shown[], listTabs: boolean, scoped: boolean) => {
    for (let i = 0; i < items.length; i += 1) {
      if (!(listTabs && autoTabs && tabbed(items[i].section))) {
        drawn.add(items[i].index);
        continue;
      }
      let end = i;
      while (end + 1 < items.length && tabbed(items[end + 1].section)) end += 1;
      const run = items.slice(i, end + 1);
      if (run.length === 1) {
        drawn.add(run[0].index);
        runs.push([run[0].index]);
      } else {
        const token = (item: Shown) => (scoped ? `section:${item.index}` : listTabToken(schema, item.section));
        const asked = run.findIndex((item) => tabMatches(token(item), tab));
        drawn.add(run[asked === -1 ? 0 : asked].index);
        runs.push(run.map((item) => item.index));
      }
      i = end;
    }
  };
  for (const region of hasAside ? ['main', 'aside'] : [undefined]) {
    const shown = shownAll.filter(
      ({ section }) =>
        !(section.kind === 'fields' && section.presentation === 'header') && (!region || (section.region ?? 'main') === region),
    );
    const scoped = region === 'aside';
    const groups: Array<{ name: string; items: Shown[] }> = [];
    for (const item of shown) {
      if (!item.section.tab) continue;
      const group = groups.find((g) => g.name === item.section.tab);
      if (group) group.items.push(item);
      else groups.push({ name: item.section.tab, items: [item] });
    }
    if (groups.length < 2) {
      lay(shown, true, scoped);
      continue;
    }
    const first = shown.findIndex((item) => item.section.tab);
    lay(shown.slice(0, first), true, scoped);
    const asked = groups.findIndex((group) => tabMatches(`tab:${group.name}`, tab));
    groups.forEach((group, i) => {
      if (i === (asked === -1 ? 0 : asked) || group.items.some(({ section }) => section.kind === 'fields')) lay(group.items, false, scoped);
    });
    lay(
      shown.slice(first).filter((item) => !item.section.tab),
      true,
      scoped,
    );
  }
  return { drawn, runs };
}

/** A related tab's count's ceiling, as a list's total has one: past it the tab says "10,000+". */
export const RELATED_COUNT_LIMIT = 10_000;

/**
 * The question a related tab's count asks, in the words `/api/counts` reads: the rows of its list that point at the
 * record (`booking class_session_id = 5`), under the list's own narrowing. One hop to the record by its whole key,
 * which is what an inferred page lists; any other list has no question, and its tab keeps the count's room empty.
 */
export function relatedCountQuestion(
  schema: DatabaseSchema,
  section: ReadSection,
  base: TableMeta,
  key: Readonly<Record<string, unknown>>,
): string | undefined {
  if (section.kind !== 'list' || !section.from || !section.path || section.of || section.similar || section.group) return undefined;
  const hop = resolvePath(schema, section.from, section.path).path;
  if (hop?.hops.length !== 1 || hop.endsAt !== base.id) return undefined;
  const { from, to } = hop.hops[0];
  if (to.columns.some((column) => key[column] === undefined || key[column] === null)) return undefined;
  const meets = from.columns.map((column, i) => `${column} = ${quoteValue(String(key[to.columns[i]]))}`).join(' and ');
  return `${section.from} ${andQuery(meets, section.filter)}`;
}

/**
 * Every count a strip of related tabs shows, in one request: one statement for them all where each is a plain
 * condition (countEach), never a list's read per tab. The client's strip asks this very body (PageSections.tsx),
 * so on a composed page it is answered from the compose.
 */
export function relatedCountsBody(
  schema: DatabaseSchema,
  sections: readonly ReadSection[],
  base: TableMeta,
  key: Readonly<Record<string, unknown>>,
): { items: string[]; countLimit: number } | undefined {
  const items = [...new Set(sections.flatMap((section) => relatedCountQuestion(schema, section, base, key) ?? []))].slice(
    0,
    COUNT_EACH_MAX,
  );
  return items.length ? { items, countLimit: RELATED_COUNT_LIMIT } : undefined;
}

/**
 * Every read a record page's sections will ask for when it opens on `tab`,
 * given its plan: the record's row (every column any section drawn reads),
 * and each other request as the section builds it. A hidden section, and
 * one in a closed tab, reads nothing; a section behind a `when` is read
 * too, and its condition asked, since the answer is only kept until it is
 * asked for.
 */
export function recordPageReads(
  names: RecordReadNames,
  page: { id: string; sections: readonly ReadSection[]; listTabs?: boolean },
  base: TableMeta,
  plans: readonly ReadPlan[],
  key: Readonly<Record<string, unknown>>,
  options: { rows: number; history: boolean; tab?: string },
): { row: string[]; parts: Array<{ part: string; columns: string[] }>; reads: ReadAsk[] } {
  const { drawn, runs } = laidSections(names.schema, page, options.tab, names.app);
  /* Each reader of the row with its own columns, too: the one read of all of
     them is refused whole where any column is, and then each is asked alone,
     as the sections would have been. */
  const parts = [{ part: 'root', columns: probeColumns(names, base) }];
  const reads: ReadAsk[] = [];
  const planOf = (index: number) => plans.find((plan) => plan.index === index);
  /* A list section is a related list: what it asks, it asks as one (a read audit names the door `related`). */
  let kind: ReadAsk['kind'];
  const view = (body: Record<string, unknown>) => reads.push({ path: '/api/view/run', body, ...(kind && { kind }) });
  const breakdown = (def: HttpBreakdownDefinition) => reads.push({ path: '/api/breakdown', body: { def }, ...(kind && { kind }) });
  page.sections.forEach((section, index) => {
    if (section.hidden || !drawn.has(index)) return;
    kind = section.kind === 'list' ? 'related' : undefined;
    if (section.when) reads.push({ path: '/api/run', body: whenBody(base, key, section.when) });
    const plan = planOf(index);
    if (section.kind === 'fields') {
      const header = section.presentation === 'header';
      parts.push({
        part: header ? 'header' : 'fields',
        columns: (header ? headerColumns(names, base, section) : fieldsColumns(names, base, section)).fetched,
      });
      return;
    }
    if (section.kind === 'history') {
      if (options.history)
        reads.push({ path: '/api/record-history', body: historyBody(base, key, section.limit ?? DEFAULT_HISTORY_LIMIT) });
      return;
    }
    /* A note reads nothing. Flow runs are fetched lazily by their section, behind the reader's own check
       (server/recordFlows.ts), and a flow's diagram reads its steps when it is drawn, as the reader's rows
       (PageFlowDiagram.tsx). */
    if (kindReading(section.kind, 'none')) return;
    if (section.kind === 'custom' && section.record?.length) parts.push({ part: `${index}:record`, columns: [...section.record] });
    if (!plan || plan.error || plan.empty) return;
    switch (section.kind) {
      case 'metric': {
        const measure = metricMeasure(plan);
        if (measure) breakdown(measure);
        else if (plan.view) view({ view: plan.view });
        return;
      }
      case 'breakdown':
      case 'chart':
        if (plan.breakdown) breakdown(plan.breakdown);
        return;
      case 'timeline':
        for (const stream of plan.streams ?? []) {
          const asked = timelineReads(
            {
              table: (id) => (names.table ? names.table(id) : findTable(names.schema, id)),
              namePath: (table) => namePathOf(names, table),
            },
            stream,
          );
          if (asked) view({ view: asked.view, offset: 0 });
          if (asked?.side) view({ view: asked.side, offset: 0 });
        }
        return;
      case 'custom':
        for (const read of Object.values(plan.reads ?? {}))
          if (!read.error && !read.empty && read.view) view({ view: read.view, offset: 0, count: 'none' });
        for (const total of Object.values(plan.aggregates ?? {}))
          if (!total.error && !total.empty && total.breakdown) breakdown(total.breakdown);
        return;
      case 'list': {
        /* A grouped list asks its groups first; each group's rows are asked of the keys that come back. */
        if (section.group && plan.groups) {
          reads.push({ path: '/api/breakdown', body: groupsBody(plan.groups, 0), kind: 'related' });
          if (plan.totals) breakdown(plan.totals);
          return;
        }
        const listed = listView(names, section, plan, options.rows).view;
        if (listed) view({ view: listed, offset: 0 });
        if (plan.totals) breakdown(plan.totals);
        return;
      }
      default:
        assertNever(section.kind, 'page section kind');
    }
  });
  /* A strip of related tabs decides which tabs it has before one is opened (kit ListTabs, useStandings): the condition of a
     list that has one, and the first page of a list that hides while empty, which is the answer to "has it rows?". They
     are the reads the list asks itself when its tab is opened, so they are asked here too, once, and the strip finds
     them waiting (as for a list alone). A closed tab is asked what it must decide on and no more. */
  for (const run of runs) {
    if (run.length < 2) continue;
    for (const index of run) {
      const section = page.sections[index];
      if (section.hidden || drawn.has(index) || section.kind !== 'list') continue;
      kind = 'related';
      if (section.when) reads.push({ path: '/api/run', body: whenBody(base, key, section.when) });
      const plan = planOf(index);
      if (section.emptyMode !== 'hide' || !plan || plan.error || plan.empty) continue;
      if (section.group && plan.groups) {
        reads.push({ path: '/api/breakdown', body: groupsBody(plan.groups, 0), kind });
        continue;
      }
      const listed = listView(names, section, plan, options.rows).view;
      if (listed) view({ view: listed, offset: 0 });
    }
  }
  /* An inferred page's tabs say how many rows each holds, all of them in one read; a list alone says it in its head. */
  if (isInferredPage(page, names.app))
    for (const run of runs) {
      const body = relatedCountsBody(
        names.schema,
        run.map((index) => page.sections[index]),
        base,
        key,
      );
      if (body) reads.push({ path: '/api/counts', body, kind: 'related' });
    }
  return { row: [...new Set(parts.flatMap((part) => part.columns))], parts, reads };
}
