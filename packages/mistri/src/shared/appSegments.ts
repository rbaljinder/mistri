/**
 * Segments: the one way to name a reusable query.
 *
 *   work_order: { segments: { open: 'status is open', overdue: { query: 'due_on < today and open', label: 'Overdue' } } }
 *
 * A segment is conditions over its resource — its columns, computed columns,
 * rollups and reference paths, `today`, `now` and `me` read per request — and
 * a name. Wherever a query is accepted the name is a word of the language
 * (`overdue and mine`), written out inline before the conditions are read
 * (query.ts expandSegments), so a tab, a metric and a rollup over a segment
 * are the statement the conditions would be, by construction. A tab names one
 * (`tabs: ['open', { segment: 'overdue', sort: 'due_on' }]`) and takes its
 * label and its address word from it; a section names one as its source
 * (`metric('Overdue', 'work_order.overdue')`) or beside the resource it
 * already has (`related(…, { segment: 'open' })`, a rollup's `{ segment }`).
 *
 * A segment only ever narrows, under the reader's row policy and field grants:
 * the catalog carries the segments (appRollups.ts statedCatalog), and a reader
 * whose catalog cannot read what one names is served none of it
 * (servedSegments) — no tab, no metric, no word — as a rollup over a column
 * they cannot read is not served. At load the same rule against the whole
 * catalog is a problem naming the fix (segmentProblems).
 */
import { ANYONE, andQuery, expandSegments, saidAt } from '@mistriwork/engine/shared/query.js';
import { parseViewQuery } from '@mistriwork/engine/shared/view.js';
import { tryResolvePath } from '@mistriwork/engine/shared/viewPaths.js';
import { type AppDef, type ResourceDef } from './appModel.js';
import { humanName, isRecord } from '@mistriwork/engine/shared/model.js';
import { tableNamed, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { TAGS_COLUMN } from '@mistriwork/engine/shared/tagLists.js';
import { nearest } from '@mistriwork/engine/shared/suggest.js';

/** Words the language already reads where a condition stands, or a clause: never a segment's name. */
export const LANGUAGE_WORDS = new Set([
  'and',
  'or',
  'not',
  'filter',
  'where',
  'show',
  'select',
  'sort',
  'order',
  'limit',
  'between',
  'is',
  'in',
  'has',
  'any',
  'via',
  'contains',
  'startswith',
  'endswith',
  'like',
  'me',
  'today',
  'now',
  'true',
  'false',
  'yes',
  'no',
  'empty',
]);

/* ---------- served ---------- */

/**
 * The catalog with only the segments it can read: each one's conditions are
 * read in it, and one that names what this catalog does not have (a column
 * the reader is not granted, a rollup they are not served, another segment
 * left out) is dropped, until what is left all reads.
 */
const served = new WeakMap<DatabaseSchema, DatabaseSchema>();
export function servedSegments(schema: DatabaseSchema): DatabaseSchema {
  if (!schema.tables.some((table) => table.segments && Object.keys(table.segments).length)) return schema;
  const kept = served.get(schema);
  if (kept) return kept;
  let current = schema;
  for (let round = 0; round < 8; round++) {
    let changed = false;
    const tables = current.tables.map((table) => {
      if (!table.segments) return table;
      /* Read for anyone: a segment about the person (`team_id in (me.team_member.team_id)`) reads for whoever asks. */
      const readable = Object.entries(table.segments).filter(
        ([name]) => !parseViewQuery(current, table.id, name, undefined, { me: ANYONE }).errors.length,
      );
      if (readable.length === Object.keys(table.segments).length) return table;
      changed = true;
      const { segments: _all, ...rest } = table;
      return readable.length ? { ...rest, segments: Object.fromEntries(readable) } : rest;
    });
    if (!changed) break;
    current = { ...current, tables };
  }
  served.set(schema, current);
  return current;
}

/**
 * The catalog with each resource's segments as declared, and nothing else
 * the App adds: what the App API reads, whose catalog carries no rollups or
 * computed columns, so a segment naming one does not read there.
 */
const declared = new WeakMap<AppDef, WeakMap<DatabaseSchema, DatabaseSchema>>();
export function withDeclaredSegments(app: AppDef, schema: DatabaseSchema): DatabaseSchema {
  const named = Object.entries(app.resources ?? {}).filter(([, block]) => block.segments && Object.keys(block.segments).length);
  if (!named.length) return schema;
  let byApp = declared.get(app);
  if (!byApp) declared.set(app, (byApp = new WeakMap()));
  const kept = byApp.get(schema);
  if (kept) return kept;
  const ids = new Map(
    named.flatMap(([resource, block]) => {
      const table = tableOf(app, schema, resource);
      return table && !table.segments
        ? [[table.id, Object.fromEntries(Object.entries(block.segments!).map(([key, segment]) => [key, segment.query]))] as const]
        : [];
    }),
  );
  const made = ids.size
    ? servedSegments({
        ...schema,
        tables: schema.tables.map((table) => (ids.has(table.id) ? { ...table, segments: ids.get(table.id) } : table)),
      })
    : schema;
  byApp.set(schema, made);
  return made;
}

/* ---------- load ---------- */

function tableOf(app: AppDef, schema: DatabaseSchema, resource: string): TableMeta | undefined {
  const physical = app.resources?.[resource]?.physical ?? resource;
  return schema.tables.find((table) => table.id === resource) ?? tableNamed(schema, physical);
}

/**
 * Every segment's problem against the whole catalog (appRollups.ts
 * appCatalog, before any is left out): a name the language or the table
 * already reads, a cycle, and conditions that do not read — each naming the
 * declaration and the fix.
 */
export function segmentProblems(app: AppDef, whole: DatabaseSchema): string[] {
  const problems: string[] = [];
  for (const [resource, block] of Object.entries(app.resources ?? {})) {
    if (!block.segments) continue;
    const table = tableOf(app, whole, resource);
    if (!table) continue;
    const segments = table.segments ?? Object.fromEntries(Object.entries(block.segments).map(([name, s]) => [name, s.query]));
    for (const [name, segment] of Object.entries(block.segments)) {
      const here = `resources "${resource}", segments "${name}"`;
      const taken = takenBy(block, table, name);
      if (taken) {
        const safe = safeSegmentName(block, table, name, block.segments);
        problems.push(
          `${here}: the name is ${taken}, so the query language could not tell which is meant. Rename the segment, and keep the words people read in its label: ` +
            `${safe}: { query: ${JSON.stringify(segment.query)}, label: ${JSON.stringify(readable(name))} }` +
            /* The words themselves, so the rename is made once: a tab named `today` met this a tab at a time. */
            (LANGUAGE_WORDS.has(name.toLowerCase())
              ? `. Words the language reads, never a segment's name: ${[...LANGUAGE_WORDS].join(', ')}.`
              : '.'),
        );
        continue;
      }
      const cycle = expandSegments(name, segments).error;
      if (cycle) {
        problems.push(`${here}: ${cycle.message} A segment may name another, never itself.`);
        continue;
      }
      // Judged before any request, a segment about the person (`mine: 'owner = me'`) reads `me` as anyone's.
      const parsed = parseViewQuery(whole, table.id, segment.query, undefined, { me: ANYONE });
      if (parsed.errors.length) problems.push(`${here} query: ${saidAt(parsed.errors[0], segment.query)}`);
    }
  }
  return problems;
}

/** A segment's name as the label it would have said: `booked` → "Booked", `on_hold` → "On hold". */
const readable = (name: string): string => {
  const words = name.replace(/_+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A name near `name` that nothing on the resource answers to: `today` → `today_only`, `enabled` → `enabled_only`. */
function safeSegmentName(block: ResourceDef, table: TableMeta, name: string, declared?: Record<string, unknown>): string {
  const base = segmentName(name);
  for (const suffix of ['only', 'rows', 'list', 'set']) {
    const candidate = `${base}_${suffix}`;
    if (!takenBy(block, table, candidate) && !declared?.[candidate]) return candidate;
  }
  return `${base}_segment`;
}

/** What else answers to this name on the resource, in the words a problem says it with. */
function takenBy(block: ResourceDef, table: TableMeta, name: string): string | undefined {
  if (LANGUAGE_WORDS.has(name.toLowerCase())) return `a word of the query language ("${name}")`;
  if (table.columns.some((column) => column.name.toLowerCase() === name.toLowerCase())) return `the column "${name}" of ${table.name}`;
  if (block.computed && Object.hasOwn(block.computed, name)) return `also a computed column (computed "${name}")`;
  if (block.rollups && Object.hasOwn(block.rollups, name)) return `also a rollup (rollups "${name}")`;
  if (name === TAGS_COLUMN && block.tags) return 'the resource\'s "tags"';
  const machine = block.machine;
  if (machine?.groups && Object.hasOwn(machine.groups, name))
    return `a group of the machine over "${machine.column}" (machine groups "${name}")`;
  if (machine?.states.some((state) => state.name === name)) return `a state of the machine over "${machine.column}"`;
  return undefined;
}

/**
 * How much a segment costs where it is named, as `check --design` lists it:
 * `columns` reads the row's own columns; `joins` reads through a reference
 * (one join per hop, in every list, tab and metric that names it); a
 * `subquery` reads a rollup or the rows that point at it (`any …`), a
 * correlated subquery per row wherever it stands.
 */
export function segmentCost(schema: DatabaseSchema, tableId: string, name: string): 'columns' | 'joins' | 'subquery' | undefined {
  const table = schema.tables.find((candidate) => candidate.id === tableId);
  if (!table?.segments || !Object.hasOwn(table.segments, name)) return undefined;
  const parsed = parseViewQuery(schema, tableId, name, undefined, { me: ANYONE });
  if (parsed.errors.length) return undefined;
  let cost: 'columns' | 'joins' | 'subquery' = 'columns';
  for (const group of parsed.filter.groups)
    for (const condition of group) {
      // The rows that point at the record are a subquery per row, as a rollup is.
      if (condition.any) return 'subquery';
      for (const path of [condition.path, ...('other' in condition && condition.other !== undefined ? [condition.other] : [])]) {
        const { resolved } = tryResolvePath(schema, tableId, path);
        if (resolved?.rollup) return 'subquery';
        if (path.includes('.')) cost = 'joins';
      }
    }
  return cost;
}

/* ---------- the authored sugar ---------- */

/** Section kinds whose `from` may name a segment as its source (`'work_order.overdue'`). */
const SOURCED = new Set([
  'metric',
  'chart',
  'breakdown',
  'rows',
  'matrix',
  'funnel',
  'board',
  'related',
  'list',
  'one',
  'calendar',
  'timeline',
]);

/** Every resource by name, with its segments' labels by name: what the sugar below needs to know. */
export type SegmentBook = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** The book from parsed resources. */
export const segmentBookOf = (resources: Readonly<Record<string, ResourceDef>> | undefined): SegmentBook =>
  Object.fromEntries(
    Object.entries(resources ?? {}).map(([name, block]) => [
      name,
      Object.fromEntries(Object.entries(block.segments ?? {}).map(([key, segment]) => [key, segment.label])),
    ]),
  );

/** The book from an authored root, read leniently (a page is parsed apart from its App's resources). */
export function segmentBookFromRaw(raw: unknown): SegmentBook {
  const blocks = isRecord(raw) && isRecord(raw.resources) ? raw.resources : {};
  return Object.fromEntries(
    Object.entries(blocks).map(([name, block]) => {
      const segments = isRecord(block) && isRecord(block.segments) ? block.segments : {};
      return [
        name,
        Object.fromEntries(
          Object.entries(segments).map(([key, segment]) => [
            key,
            isRecord(segment) && typeof segment.label === 'string' && segment.label.trim() ? segment.label.trim() : humanName(key),
          ]),
        ),
      ];
    }),
  );
}

/** The resource and segment a dotted `from` names, where it is not a resource itself. */
function segmentSource(from: string, book: SegmentBook): { resource: string; segment: string } | undefined {
  if (Object.hasOwn(book, from)) return undefined;
  const dot = from.lastIndexOf('.');
  if (dot < 0) return undefined;
  const resource = from.slice(0, dot);
  return Object.hasOwn(book, resource) ? { resource, segment: from.slice(dot + 1) } : undefined;
}

function knownSegment(book: SegmentBook, resource: string, segment: string, at: string): void {
  const segments = book[resource] ?? {};
  if (Object.hasOwn(segments, segment)) return;
  const names = Object.keys(segments);
  const near = nearest(segment, names);
  throw new Error(
    `${at} names the segment "${segment}" of "${resource}", which it does not declare.` +
      (names.length
        ? ` Its segments: ${names.join(', ')}.${near ? ` Did you mean "${near}"?` : ''}`
        : ` Declare it: resources.${resource}.segments: { ${segment}: '…' }.`),
  );
}

/**
 * A section, a view or a rollup as authored, with what names a segment
 * written as the plain form every reader already reads: a source
 * (`from: 'work_order.overdue'`) is the resource and the segment's word in
 * its `query`, and `{ segment }` the word too. A tab is a segment's name and
 * label (`'open'`, `{ segment: 'open', sort }`), or every row (`{ label }`);
 * a tab that writes its own query is refused with the fix.
 */
export function unfoldSegments(raw: unknown, book: SegmentBook, at: string, table?: string): unknown {
  if (Array.isArray(raw)) {
    const out = raw.map((item, i) => unfoldSegments(item, book, `${at}, ${i + 1}`, table));
    return out.some((item, i) => item !== raw[i]) ? out : raw;
  }
  if (!isRecord(raw)) return raw;
  let node: Record<string, unknown> = raw;
  const set = (key: string, value: unknown) => {
    if (node === raw) node = { ...raw };
    node[key] = value;
  };
  let own = table;
  if (typeof raw.from === 'string' && (typeof raw.kind !== 'string' || SOURCED.has(raw.kind))) {
    const named = segmentSource(raw.from.trim(), book);
    if (named) {
      knownSegment(book, named.resource, named.segment, `${at}, "from"`);
      set('from', named.resource);
      set('query', andQuery(named.segment, typeof raw.query === 'string' ? raw.query : undefined));
      own = named.resource;
    } else own = raw.from.trim();
  }
  if (typeof raw.segment === 'string' && typeof raw.kind === 'string') {
    if (own !== undefined && Object.hasOwn(book, own)) knownSegment(book, own, raw.segment.trim(), `${at}, "segment"`);
    set('query', andQuery(raw.segment.trim(), typeof node.query === 'string' ? (node.query as string) : undefined));
    const { segment: _named, ...rest } = node;
    node = rest;
  }
  if (Array.isArray(raw.tabs) && own !== undefined) set('tabs', unfoldTabs(raw.tabs, book, own, `${at}, "tabs"`));
  for (const [key, value] of Object.entries(node)) {
    if (key === 'tabs' || !value || typeof value !== 'object') continue;
    const next = unfoldSegments(value, book, at, own);
    if (next !== value) set(key, next);
  }
  return node;
}

function unfoldTabs(tabs: readonly unknown[], book: SegmentBook, resource: string, at: string): unknown[] {
  /* Every tab that writes its own query, said at once: renaming them one load at a time is how a field report
     met `today` (a word of the language) after the others were done. */
  const own = tabs.flatMap((tab, i) => {
    if (!isRecord(tab) || tab.query === undefined) return [];
    const name = segmentName(typeof tab.label === 'string' ? tab.label : 'segment');
    const safe = LANGUAGE_WORDS.has(name) ? `${name}_only` : name;
    return [
      `${at}, tab ${i + 1} writes its own "query". A tab names a segment: declare it on the resource ` +
        `(resources.${resource}.segments: { ${safe}: { query: ${JSON.stringify(tab.query)}, label: ${JSON.stringify(typeof tab.label === 'string' ? tab.label : readable(name))} } }) and name it here ('${safe}')` +
        (safe === name ? '.' : `; "${name}" is a word of the query language, so it cannot be a segment's name.`),
    ];
  });
  if (own.length) throw new Error(own.join('\n'));
  return tabs.map((tab, i) => {
    const here = `${at}, tab ${i + 1}`;
    const named = typeof tab === 'string' ? tab.trim() : isRecord(tab) && typeof tab.segment === 'string' ? tab.segment.trim() : undefined;
    if (named === undefined) return tab;
    knownSegment(book, resource, named, here);
    if (isRecord(tab)) {
      const extra = Object.keys(tab).find((key) => key !== 'segment' && key !== 'sort');
      if (extra)
        throw new Error(`${here} names a segment and has "${extra}": its label is the segment's, and a "sort" is the one key of its own.`);
    }
    return {
      label: book[resource][named],
      query: named,
      segment: named,
      ...(isRecord(tab) && tab.sort !== undefined ? { sort: tab.sort } : {}),
    };
  });
}

/** A segment's name from words: "Waiting on parts" → `waiting_on_parts`. */
function segmentName(words: string): string {
  const name = words
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[a-z_]/.test(name) ? name : `segment_${name}`;
}

/* ---------- a query said twice ---------- */

/** A query written in more than one place over one resource, and the segment that would name it. */
interface RepeatedQuery {
  resource: string;
  query: string;
  /** Where it is written: `view "leads"`, `view "home", section "Open"`, `resources "account", rollup "open_tasks"`. */
  places: string[];
  /** The segment's name: one the resource already declares with these words, or one read off a plain condition (`status is open` → `open`). */
  name?: string;
  /** True when the resource already declares it under `name`. */
  declared?: boolean;
}

const said = (query: string) => query.trim().replace(/\s+/g, ' ');

/**
 * Each query written two or more times, word for word, over one resource:
 * the list views', the dashboard sections' and the rollups'. A segment is the
 * one way to name a query (`check --design` [repeated-query]); `--fix` lifts
 * one whose name reads off its condition (checkFix.ts).
 */
export function repeatedQueries(app: AppDef, schema: DatabaseSchema): RepeatedQuery[] {
  const resourceOf = new Map<string, string>();
  for (const name of Object.keys(app.resources ?? {})) {
    const table = tableNamed(schema, app.resources![name].physical ?? name);
    if (table && !resourceOf.has(table.id)) resourceOf.set(table.id, name);
  }
  const found = new Map<string, { resource: string; query: string; places: string[] }>();
  const add = (tableName: unknown, query: unknown, place: string) => {
    if (typeof tableName !== 'string' || typeof query !== 'string' || !query.trim()) return;
    const table = tableNamed(schema, tableName);
    const resource = table && resourceOf.get(table.id);
    if (!resource) return;
    const words = said(query);
    const key = `${resource}\u0000${words}`;
    const entry = found.get(key) ?? { resource, query: words, places: [] };
    entry.places.push(place);
    found.set(key, entry);
  };
  for (const [key, view] of Object.entries(app.views ?? {})) {
    if (!isRecord(view)) continue;
    add(view.table, view.query, `view "${key}"`);
    if (Array.isArray(view.sections))
      view.sections.forEach((section: unknown, i: number) => {
        if (isRecord(section))
          add(section.table, section.query, `view "${key}", section ${typeof section.title === 'string' ? `"${section.title}"` : i + 1}`);
      });
  }
  for (const [name, block] of Object.entries(app.resources ?? {}))
    for (const [rollup, declared] of Object.entries(block.rollups ?? {}))
      add(declared.from, declared.query, `resources "${name}", rollup "${rollup}"`);
  const repeated: RepeatedQuery[] = [];
  for (const entry of found.values()) {
    if (entry.places.length < 2) continue;
    const block = app.resources![entry.resource];
    const table = tableNamed(schema, block.physical ?? entry.resource)!;
    // A query that is already one segment's name is the segment, said.
    if (block.segments && Object.hasOwn(block.segments, entry.query)) continue;
    const existing = Object.entries(block.segments ?? {}).find(([, segment]) => said(segment.query) === entry.query)?.[0];
    if (existing) {
      repeated.push({ ...entry, name: existing, declared: true });
      continue;
    }
    const plain = /^[A-Za-z_]\w*\s+(?:is|=)\s+'?([A-Za-z][\w ]*?)'?$/.exec(entry.query)?.[1];
    const name = plain ? segmentName(plain) : undefined;
    repeated.push({ ...entry, ...(name && !takenBy(block, table, name) && !block.segments?.[name] ? { name } : {}) });
  }
  return repeated;
}
