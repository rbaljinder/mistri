/**
 * The record page's anatomy, chosen from the catalog: the page an App draws
 * for a resource it gave none, and the page the scaffold writes.
 *
 * The good record pages in the samples (Depot's order, Forecourt's vehicle,
 * Commons' thread) share one skeleton, and a page built any other way read
 * as a database dump: a header with the record's status and a line of facts
 * under its name, a summary of its figures, its children as tabs, and beside
 * them a rail of the rest of its properties over its history. This says, for
 * one table, which columns go where — name-like, status, money, date and
 * count columns, and the rollups the catalog serves — so the default page and
 * the scaffold's are one rule.
 *
 * Pure: the caller says what only it knows (which columns are money in the
 * App's words, whether the resource keeps a history, what a list is called).
 */
import {
  columnKind,
  findTable,
  labelColumn,
  primaryKey,
  referencesFrom,
  referencesTo,
  type ColumnMeta,
  type DatabaseSchema,
  type ForeignKey,
  type TableMeta,
} from './schema.js';
import { pageHop } from './pagePaths.js';
import { humanName } from './model.js';
import { headingOf, recordNoun } from './appNoun.js';
import { DEFAULT_PAGE_LIST_LIMIT, type PageDef, type PageSection } from './pageModel.js';

/** What the caller knows that the catalog does not. */
export interface AnatomyHints {
  /** Whether a number column is money, where the caller knows (a display rule); undefined leaves it to the name. */
  money?: (table: TableMeta, column: ColumnMeta) => boolean | undefined;
  /** The column naming a table's rows, where the App says (recordLabel); the catalog's guess otherwise. */
  label?: (table: TableMeta) => string | undefined;
  /** Whether a column is the record's status where the caller knows (the App dresses it in tones); undefined leaves it
      to the name — status, state, stage, phase. */
  status?: (table: TableMeta, column: ColumnMeta) => boolean | undefined;
  /** Whether the record keeps a history, so the aside may end with it. */
  history?: boolean;
  /** Whether a table that points here is one the App reads, so its list may stand on the page; absent is every one. */
  includes?: (child: TableMeta) => boolean;
  /** A related list's title, where the caller has the words; absent is the table's name as the page says it. */
  title?: (fk: ForeignKey, child: TableMeta, ambiguous: boolean) => string | undefined;
  /** What one record of a table is called, mid-sentence ("work order"), where the caller has the word (its `noun`). */
  noun?: (table: TableMeta) => string | undefined;
}

interface RelatedPick {
  title?: string;
  from: string;
  whose: string;
  show: string[];
  sort?: string;
}
/** The one child row that matters now — the next visit, the current lease — as a card. */
interface CurrentPick {
  title: string;
  from: string;
  whose: string;
  show: string[];
  query?: string;
  sort?: string;
}

/** Which columns go where on one record's page. */
interface Anatomy {
  /** The header's status chip: a vocabulary column named like a state. */
  status?: string;
  /** The header's facts line: the parent, a figure, a date — at most four. */
  facts: string[];
  /** A summary of the record's figures: its rollups, then money the facts did not say — at most four. */
  summary: string[];
  /** The children, drawn as tabs: at most four lists of at most four columns. */
  related: RelatedPick[];
  /** The record it belongs to, as a card in the aside: the reference and two of the parent's own fields. */
  parent?: { title: string; paths: string[] };
  /** The child that is current, as a card in the aside. */
  current?: CurrentPick;
  /** The rest of the record's own fields, as a property rail in the aside, titled by the record's noun. */
  properties: string[];
  /** The record's noun as a heading: what the rail of its own fields is called ("Patient"), never "Details". */
  noun: string;
  history: boolean;
}

const MONEY =
  /(^|_)(amount|total|subtotal|price|cost|revenue|budget|quota|fee|fees|salary|balance|value|pay|paid|wage|rent|charge|charges|billed|deposit|pipeline)$/i;
const STATE = /^(status|state|stage|phase)$|_(status|state|stage)$/i;
const COUNTED =
  /^(qty|quantity|units|seats|beds|baths|bedrooms|bathrooms|count|headcount|employees|capacity|size|sq_ft|sqft|area|mileage|minutes|hours)$|_(count|qty)$/i;
/* Dates a person reads a record by, most telling first; housekeeping stamps are the aside's. */
const DATE_PICK = [
  /^(due|due_on|due_at|due_date|deadline)$/i,
  /close/i,
  /(ends?|expires?)_/i,
  /(starts?|begins?)_/i,
  /date/i,
  /_on$/i,
  /_at$/i,
];
const HOUSEKEEPING = /^(created|updated|modified|deleted|sys_)/i;
const OPAQUE = /blob|bytea|binary|json|xml|tsvector|vector/i;
const SECRET = /(password|passwd|secret|token|hash|salt)/i;
const VERSION = /^(version|lock_version|row_version|rowversion|revision)$/i;
const LONG_TEXT = /(description|body|notes?|summary|content|details|comments?|bio|message|text|html|markdown)$/i;
/** A column named for words a reader reads rather than scans (a description, a body, notes): the rail puts it last,
    and a page of little else is an article (pageLayouts.ts, chooseLayout). */
export const isLongText = (column: string): boolean => LONG_TEXT.test(column);
const MAX_FACTS = 4;
const MAX_SUMMARY = 4;
const MAX_RELATED = 4;
const MAX_LIST_COLUMNS = 4;
/** A rail's worth of fields. */
export const MAX_PROPERTIES = 12;
/* A child state that is still in play: the one a parent's page wants beside it. */
const OPEN =
  /^(open|new|active|pending|scheduled|planned|upcoming|booked|confirmed|due|ready|in[ _-]?progress|working|in[ _-]?review|on[ _-]?hold|awaiting\b.*|requested|submitted|current|live)$/i;
/* Of those, the ones still ahead: their card is the next, soonest first. */
const AHEAD = /^(scheduled|planned|upcoming|booked|confirmed|due|requested)$/i;
const LONG_OR_KEY = (column: ColumnMeta) => LONG_TEXT.test(column.name) || column.primaryKey || Boolean(column.references);

const moneyBy = (hints: AnatomyHints) => (table: TableMeta, column: ColumnMeta) => hints.money?.(table, column) ?? MONEY.test(column.name);

/** A key the database handed out: one integer or uuid primary key, which no reader quotes. */
function surrogate(table: TableMeta, column: ColumnMeta): boolean {
  return (
    column.primaryKey &&
    primaryKey(table).length === 1 &&
    (/^(id|uuid|guid)$/i.test(column.name) || /int|serial|uuid/i.test(column.type ?? ''))
  );
}

/** A column a person reads on a record: not a handed-out key, a version, a secret or bytes. */
function readable(table: TableMeta, column: ColumnMeta): boolean {
  return !surrogate(table, column) && !VERSION.test(column.name) && !SECRET.test(column.name) && !OPAQUE.test(column.type ?? '');
}

/** The status column: one the caller says carries meaning (its tones), else one named like a state. A
    vocabulary alone is not a status: a region or a kind would stand beside the name saying nothing. */
function statusColumn(table: TableMeta, hints: AnatomyHints = {}): ColumnMeta | undefined {
  const texts = table.columns.filter((column) => columnKind(column.type ?? '') === 'text' || /enum/i.test(column.type ?? ''));
  return (
    texts.find((column) => STATE.test(column.name) && hints.status?.(table, column) !== false) ??
    texts.find((column) => hints.status?.(table, column) === true)
  );
}

/** The date a record is read by: due, closing, ending, starting — the stamps last. */
function dateColumns(table: TableMeta, taken: Set<string>): ColumnMeta[] {
  const dated = table.columns.filter((column) => columnKind(column.type ?? '') === 'date' && !taken.has(column.name));
  const ranked = [
    ...DATE_PICK.flatMap((pick) => dated.filter((column) => pick.test(column.name) && !HOUSEKEEPING.test(column.name))),
    ...dated.filter((column) => !HOUSEKEEPING.test(column.name)),
    ...dated,
  ];
  return [...new Set(ranked)];
}

/** A related list's columns: the row's name, its state, then what it says, never the reference it is found by. */
function listColumns(child: TableMeta, fk: ForeignKey, hints: AnatomyHints): string[] {
  const name = hints.label?.(child) ?? labelColumn(child);
  const state = statusColumn(child, hints)?.name;
  const skip = new Set(fk.from.columns);
  const plain = child.columns.filter(
    (column) =>
      readable(child, column) &&
      !skip.has(column.name) &&
      !HOUSEKEEPING.test(column.name) &&
      !(LONG_TEXT.test(column.name) && column.name !== name) &&
      !(column.primaryKey && primaryKey(child).length === 1),
  );
  const money = moneyBy(hints);
  const ordered = [
    ...(name && plain.some((column) => column.name === name) ? [name] : []),
    ...plain.filter((column) => columnKind(column.type ?? '') === 'number' && money(child, column)).map((column) => column.name),
    ...dateColumns(child, skip)
      .filter((column) => plain.includes(column))
      .slice(0, 1)
      .map((column) => column.name),
    ...plain.map((column) => column.name),
  ].filter((column) => column !== state);
  /* State last: where the list is cut, the chip still stands at its end. */
  const picked = [...new Set(ordered)].slice(0, state ? MAX_LIST_COLUMNS - 1 : MAX_LIST_COLUMNS);
  return state ? [...picked, state] : picked;
}

/** The rail's fields in reading order: long text last, at most a rail's worth. */
function railOf(rest: ColumnMeta[]): string[] {
  return [...rest.filter((column) => !LONG_TEXT.test(column.name)), ...rest.filter((column) => LONG_TEXT.test(column.name))]
    .map((column) => column.name)
    .slice(0, MAX_PROPERTIES);
}

/** Which of a table's columns go where on its record's page, or nothing where a record has no key to open it by. */
export function recordAnatomy(schema: DatabaseSchema, baseId: string, hints: AnatomyHints = {}): Anatomy | null {
  const base = findTable(schema, baseId);
  if (!base || !primaryKey(base).length) return null;
  const money = moneyBy(hints);
  const name = hints.label?.(base) ?? labelColumn(base);
  const own = base.columns.filter((column) => readable(base, column) && column.name !== name);
  const refs = referencesFrom(schema, base.id).filter((fk) => fk.from.columns.length === 1 && !fk.stitched);
  const refColumns = refs.map((fk) => fk.from.columns[0]).filter((column) => own.some((c) => c.name === column));
  const status = statusColumn(base, hints)?.name;
  const taken = new Set<string>(status ? [status] : []);
  const take = (column: string | undefined) => {
    if (column && !taken.has(column)) {
      taken.add(column);
      return [column];
    }
    return [];
  };

  const figures = own.filter(
    (column) => columnKind(column.type ?? '') === 'number' && !column.primaryKey && !refColumns.includes(column.name),
  );
  const moneyColumns = figures.filter((column) => money(base, column)).map((column) => column.name);
  const counted = figures.filter((column) => COUNTED.test(column.name)).map((column) => column.name);
  /* The header says what the record belongs to, what it is worth and when. */
  const facts = [
    ...take(refColumns[0]),
    ...take(moneyColumns[0]),
    ...take(dateColumns(base, taken).map((column) => column.name)[0]),
    ...take(counted[0]),
    ...take(refColumns[1]),
  ].slice(0, MAX_FACTS);
  /* A record that belongs to nothing and holds no figure or date (a provider:
     a specialty, a phone, an email) still opens on a line of what it is,
     never on its title alone: its first short words. */
  if (!facts.length) {
    for (const column of own) {
      if (facts.length >= 3) break;
      if (columnKind(column.type ?? '') !== 'text' || LONG_OR_KEY(column) || HOUSEKEEPING.test(column.name) || column.flag) continue;
      facts.push(...take(column.name));
    }
  }
  /* The summary is the record's figures: what the catalog counts about it, then its money. */
  const rollups = Object.keys(base.rollups ?? {});
  const summary = [
    ...rollups,
    ...moneyColumns.filter((column) => !taken.has(column)),
    ...counted.filter((column) => !taken.has(column)),
  ].slice(0, MAX_SUMMARY);
  for (const column of summary) taken.add(column);

  const incoming = referencesTo(schema, base.id).filter(
    (fk) =>
      !fk.stitched &&
      pageHop(schema, fk) !== undefined &&
      findTable(schema, fk.from.table) &&
      (hints.includes?.(findTable(schema, fk.from.table)!) ?? true),
  );
  const related = incoming.slice(0, MAX_RELATED).map((fk): RelatedPick => {
    const child = findTable(schema, fk.from.table)!;
    const ambiguous = incoming.filter((other) => other.from.table === fk.from.table).length > 1 || child.id === base.id;
    const title = hints.title?.(fk, child, ambiguous) ?? (ambiguous ? `${child.name} via ${fk.from.columns.join(', ')}` : undefined);
    const date = dateColumns(child, new Set(fk.from.columns))[0];
    return {
      ...(title ? { title } : {}),
      from: child.id,
      whose: pageHop(schema, fk)!,
      show: listColumns(child, fk, hints),
      ...(date ? { sort: `${date.name} desc` } : {}),
    };
  });
  const noun = (table: TableMeta) => hints.noun?.(table) ?? recordNoun(undefined, table.name);
  /* The parent, as a card of its name and two of its own fields: the first
     reference, required ones first, whose record has two to say (a patient's
     insurer is a name alone; their provider has a specialty and a phone). */
  let parent: Anatomy['parent'];
  const required = (column: string) => base.columns.find((c) => c.name === column)?.nullable === false;
  for (const column of related.length ? [...refColumns].sort((a, b) => Number(required(b)) - Number(required(a))) : []) {
    const up = refs.find((fk) => fk.from.columns[0] === column)!;
    const upTable = findTable(schema, up.to.table);
    if (!upTable) continue;
    const upName = hints.label?.(upTable) ?? labelColumn(upTable);
    const upState = statusColumn(upTable, hints);
    const glance = [
      ...(upState ? [upState] : []),
      ...upTable.columns.filter(
        (c) => c !== upState && readable(upTable, c) && c.name !== upName && !LONG_OR_KEY(c) && !HOUSEKEEPING.test(c.name) && !c.flag,
      ),
    ].slice(0, 2);
    if (glance.length < 2) continue;
    parent = {
      title: headingOf(humanName(column.replace(/_id$/i, '')) || noun(upTable)),
      paths: [column, ...glance.map((c) => `${column}.${c.name}`)],
    };
    // Said on its card, the reference is not said again in the rail.
    taken.add(column);
    break;
  }
  /* The child that is current: one whose state is still in play — the next
     visit first, one booked ahead, then the open claim — else the latest by
     its date. */
  let current: CurrentPick | undefined;
  const ahead = (pick: RelatedPick) =>
    (statusColumn(findTable(schema, pick.from)!, hints)?.allowed ?? []).some((value) => AHEAD.test(value));
  for (const pick of [...related.filter(ahead), ...related.filter((pick) => !ahead(pick))]) {
    const child = findTable(schema, pick.from)!;
    const state = statusColumn(child, hints);
    const open = (state?.allowed ?? []).filter((value) => OPEN.test(value));
    if (!state || !open.length || open.length === state.allowed!.length) continue;
    const next = open.every((value) => AHEAD.test(value));
    const date = dateColumns(child, new Set(pick.whose.split('.').slice(0, 1)))[0];
    const said = (value: string) => (/^\w+$/.test(value) ? value : `"${value}"`);
    current = {
      title: `${next ? 'Next' : 'Current'} ${noun(child)}`,
      from: pick.from,
      whose: pick.whose,
      show: pick.show.filter((column) => column !== state.name && column !== (hints.label?.(child) ?? labelColumn(child))).slice(0, 3),
      query: open.length === 1 ? `${state.name} = ${said(open[0])}` : `${state.name} in (${open.map(said).join(', ')})`,
      ...(date ? { sort: `${date.name} ${next ? 'asc' : 'desc'}` } : {}),
    };
    break;
  }
  if (!current) {
    const dated = related.find((pick) => pick.sort && !HOUSEKEEPING.test(pick.sort));
    if (dated) {
      const child = findTable(schema, dated.from)!;
      current = {
        title: `Latest ${noun(child)}`,
        from: dated.from,
        whose: dated.whose,
        show: dated.show.filter((column) => column !== (hints.label?.(child) ?? labelColumn(child))).slice(0, 3),
        sort: dated.sort,
      };
    }
  }
  /* Everything else the record says, long text last; the name is the head's. */
  const properties = railOf(own.filter((column) => !taken.has(column.name)));
  return {
    ...(status ? { status } : {}),
    facts,
    summary,
    related,
    ...(parent ? { parent } : {}),
    ...(current ? { current } : {}),
    properties,
    noun: headingOf(noun(base)),
    history: Boolean(hints.history),
  };
}

/** The anatomy as a page: header, summary, the lists as tabs, and the aside's parent, current child and rail over the history. */
export function anatomySections(anatomy: Anatomy): PageSection[] {
  const sections: PageSection[] = [];
  if (anatomy.status || anatomy.facts.length) {
    sections.push({ kind: 'fields', presentation: 'header', paths: anatomy.facts, ...(anatomy.status ? { status: anatomy.status } : {}) });
  }
  if (anatomy.summary.length) sections.push({ kind: 'fields', presentation: 'summary', paths: anatomy.summary });
  for (const list of anatomy.related) {
    sections.push({
      kind: 'list',
      ...(list.title ? { title: list.title } : {}),
      from: list.from,
      path: list.whose,
      columns: list.show,
      limit: DEFAULT_PAGE_LIST_LIMIT,
      ...(list.sort ? { orderBy: [{ column: list.sort.split(' ')[0], direction: 'desc' as const }] } : {}),
    });
  }
  /* With no children to list, the fields are the page, not a rail beside nothing. */
  const aside = anatomy.related.length > 0;
  if (anatomy.parent)
    sections.push({ kind: 'fields', title: anatomy.parent.title, presentation: 'card', region: 'aside', paths: anatomy.parent.paths });
  const now = anatomy.current;
  if (now) {
    sections.push({
      kind: 'list',
      title: now.title,
      from: now.from,
      path: now.whose,
      columns: now.show,
      limit: 1,
      presentation: 'card',
      region: 'aside',
      ...(now.query ? { filter: now.query } : {}),
      ...(now.sort
        ? { orderBy: [{ column: now.sort.split(' ')[0], direction: now.sort.endsWith(' asc') ? ('asc' as const) : ('desc' as const) }] }
        : {}),
    });
  }
  /* Titled by what the rail holds, the record's own fields: "Patient", never "Details". */
  if (anatomy.properties.length) {
    sections.push(
      aside
        ? { kind: 'fields', title: anatomy.noun, presentation: 'properties', region: 'aside', paths: anatomy.properties }
        : { kind: 'fields', title: anatomy.noun, columns: 2, paths: anatomy.properties },
    );
  }
  if (anatomy.history) sections.push({ kind: 'history', ...(aside ? { region: 'aside' as const } : {}) });
  /* The head says the name, and offers its editor, only for a fields section
     that owns it (Page.tsx, titleOwner). A record that is nothing but its
     name (a tag, a note) has no other field, so a header of no facts holds
     it: it draws nothing of its own, and the name stays editable in the head. */
  if (!sections.some((section) => section.kind === 'fields')) sections.unshift({ kind: 'fields', presentation: 'header', paths: [] });
  return sections;
}

/** The page an App draws for a resource it declared none for (appProjection.ts, /api/pages/suggested). */
export function anatomyPage(schema: DatabaseSchema, baseId: string, hints: AnatomyHints = {}): PageDef | null {
  const anatomy = recordAnatomy(schema, baseId, hints);
  const base = findTable(schema, baseId);
  if (!anatomy || !base) return null;
  return {
    id: `suggested:${base.id}`,
    name: base.name,
    base: base.id,
    sections: anatomySections(anatomy),
    listTabs: true,
    source: 'suggested',
  };
}

/**
 * An App's record page that declares no aside gets the generated page's: the
 * record's remaining fields as a property rail, titled by its noun ("Bike").
 * Five pages of one App wrote `fields([...the rest], { title: 'Bike', region:
 * 'aside' })` by hand; the rule is the anatomy's, so the two cannot drift.
 * Remaining is judged against the reader's own catalog (so a column they cannot
 * read is not offered) and against what the page already says: any fields
 * section's path, a header's status, a card's reference. A fields section with
 * no paths is the whole record, so nothing remains. An empty remainder draws
 * no aside.
 */
export function withDefaultAside(schema: DatabaseSchema, page: PageDef): PageDef {
  if (!page.defaultAside || page.aside === false || page.error || page.document) return page;
  if (page.sections.some((section) => section.region === 'aside')) return page;
  const base = findTable(schema, page.base);
  if (!base) return page;
  const shown = new Set<string>();
  for (const section of page.sections) {
    if (section.kind === 'custom') section.record?.forEach((path) => shown.add(path.split('.')[0]));
    if (section.kind !== 'fields') continue;
    if (!section.paths?.length && section.presentation !== 'header') return page;
    section.paths?.forEach((path) => shown.add(path.split('.')[0]));
    if (section.status) shown.add(section.status);
    if (section.was) shown.add(section.was.split('.')[0]);
  }
  const name = labelColumn(base);
  const paths = railOf(base.columns.filter((column) => readable(base, column) && column.name !== name && !shown.has(column.name)));
  if (!paths.length) return page;
  return {
    ...page,
    sections: [...page.sections, { kind: 'fields', title: page.name, presentation: 'properties', region: 'aside', paths }],
  };
}
