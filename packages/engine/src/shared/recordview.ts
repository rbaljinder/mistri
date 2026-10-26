/**
 * A record template: one row, with its references pulled in around it.
 *
 * The view composer as built answers "give me a table of X with columns from
 * the things X points at" — one row per base record, joins flattened into
 * columns. That is a useful shape and the wrong one for the question tablewalk
 * actually exists to answer, which is "show me *this* work order, properly".
 *
 * That question wants a page: the work order's own fields, the customer's
 * details inline because a work order without its customer's name is a
 * riddle, and its parts and notes as tables underneath because there are
 * several of each and a count is not enough.
 *
 * The difference from a list view is not cosmetic — it is what the thing is
 * bound to. A list view is a *query*: it produces rows and you read them. A
 * record template is bound to a **table**, not to a row, and applies to every
 * row of it. Configure `work_order` once and every work order you ever walk
 * to is laid out that way. That is what makes it worth configuring at all.
 *
 * Two consequences fall out, and both are why this shape earns its place:
 *
 *   - A has-many relationship is finally answerable. In a list view it either
 *     multiplies rows or collapses to a count; here it is simply a table on
 *     the page, which is what anyone asking for "the order and its lines"
 *     meant in the first place.
 *   - Views stop being a dead end. A list view is somewhere you look; a
 *     record template is where a walk *arrives*, so views become part of the
 *     navigation rather than a parallel product beside it.
 */
import {
  findTable,
  labelColumn,
  looksLikeDate,
  primaryKey,
  referencesFrom,
  referencesTo,
  type ColumnMeta,
  type DatabaseSchema,
  type ForeignKey,
  type TableMeta,
} from './schema.js';
import { parseSortText } from './sortText.js';

/** A block of the base record's own fields, or of a to-one reference's. */
interface FieldSection {
  kind: 'fields';
  /** Shown above the block. Absent means no heading. */
  title?: string;
  /**
   * Paths, relative to the base. `reference` is the base's own column;
   * `customer_id.name` is the customer's, pulled inline.
   */
  paths: string[];
}

/**
 * A table of the rows that point at this record.
 *
 * Keyed by constraint name for the same reason aggregates are: a child can
 * point at the same parent twice, and `work_order.parent_id` and
 * `work_order.supersedes_id` are two different sections that would otherwise
 * be indistinguishable.
 */
export interface ListSection {
  kind: 'list';
  title?: string;
  /** Constraint name of the foreign key pointing back at this record. */
  via: string;
  /** Columns of the child table to show. Empty means a sensible default. */
  columns: string[];
  /** Rows to fetch per section. Bounded because a page is not a report. */
  limit?: number;
  orderBy?: { column: string; direction: 'asc' | 'desc' }[];
}

type RecordSection = FieldSection | ListSection;

interface RecordTemplate {
  id: string;
  name: string;
  /** The table this template lays out. Not a row — every row of it. */
  base: string;
  sections: RecordSection[];
  /** Used for every record of this table unless another is chosen. */
  isDefault?: boolean;
  connection?: string;
  source?: 'config' | 'saved';
}

/** Rows to show in an embedded list before it needs its own page. */
export const DEFAULT_LIST_LIMIT = 10;

/**
 * Below this many columns, grouping costs more than it saves.
 *
 * A four-column table split into "Identity" and "Details" is two headings and
 * a divider to organise four fields — more ceremony than content, and slower
 * to read than the flat list it replaced.
 */
const GROUP_THRESHOLD = 12;

const AUDIT_NAME = /^(sys_|created|updated|modified|deleted|inserted)|_(at|by)$|^(version|etag|revision)$/i;

/**
 * How a table's own columns divide into blocks.
 *
 * Derived from what the schema already says rather than from a stored layout:
 * keys and the label column identify, foreign keys link, dates measure, and
 * anything named like an audit column is bookkeeping. Ordering is by what
 * gets looked at first, not by declaration order.
 *
 * Lives here rather than in the renderer because it *is* the default
 * template. Having the derivation in one place and the stored layout in
 * another is how the two start disagreeing about what a record looks like.
 */
export function groupOwnColumns(table: TableMeta): Array<[string | null, ColumnMeta[]]> {
  const columns = table.columns;
  if (columns.length < GROUP_THRESHOLD) return [[null, columns]];

  const label = labelColumn(table);
  const groups = new Map<string, ColumnMeta[]>([
    ['Identity', []],
    ['Bookkeeping', []],
    ['References', []],
    ['Details', []],
    ['Dates', []],
  ]);

  for (const col of columns) {
    if (col.primaryKey || col.name === label) groups.get('Identity')!.push(col);
    else if (col.references) groups.get('References')!.push(col);
    else if (AUDIT_NAME.test(col.name)) groups.get('Bookkeeping')!.push(col);
    else if (looksLikeDate(col)) groups.get('Dates')!.push(col);
    else groups.get('Details')!.push(col);
  }

  // A section with nothing in it is a heading that means nothing.
  return [...groups].filter(([, cols]) => cols.length) as Array<[string | null, ColumnMeta[]]>;
}

/* ---------- deriving a starting template ---------- */

/**
 * The template a table gets before anyone configures one.
 *
 * Derived rather than blank, because a blank record page is a worse starting
 * point than the default layout the record view already produces, and because
 * the fastest way to explain what a template *is* is to show someone one made
 * of their own data.
 *
 * The rules are the ones the record view already uses, made explicit: the
 * record's own fields first, then each to-one reference as its own labelled
 * block, then each incoming relationship as a table.
 */
export function deriveTemplate(schema: DatabaseSchema, tableId: string): RecordTemplate | undefined {
  const table = findTable(schema, tableId);
  if (!table) return undefined;

  const sections: RecordSection[] = groupOwnColumns(table).map(([title, columns]) => ({
    kind: 'fields' as const,
    title: title ?? undefined,
    paths: columns.map((c) => c.name),
  }));

  /* One block per outgoing reference, holding a few readable columns of the
     row it points at. Not every column: pulling a customer's forty fields
     into a work order buries the work order. */
  for (const fk of referencesFrom(schema, tableId)) {
    if (fk.to.table === tableId) continue; // a self-reference adds no context
    const target = findTable(schema, fk.to.table);
    if (!target) continue;
    const via = fk.from.columns.join('+');
    sections.push({
      kind: 'fields',
      title: `${target.name} · via ${fk.from.columns.join(', ')}`,
      paths: summaryColumns(target).map((c) => `${via}.${c}`),
    });
  }

  for (const fk of referencesTo(schema, tableId)) {
    const child = findTable(schema, fk.from.table);
    if (!child) continue;
    sections.push({
      kind: 'list',
      title: `${child.name} · via ${fk.from.columns.join(', ')}`,
      via: fk.name,
      columns: listColumns(child, fk.from.columns),
      limit: DEFAULT_LIST_LIMIT,
    });
  }

  return { id: `derived:${tableId}`, name: table.name, base: tableId, sections };
}

/**
 * Every column of a child table worth showing, in declaration order.
 *
 * All of them, not a summary. A summary is the right shape for a reference
 * pulled *into* a record — a customer's forty fields would bury the work order
 * they are attached to — and the wrong shape for a table of children, which is
 * the thing you opened the record to read. `work_order_part` summarised down
 * to one column of quantities is a list of numbers with nothing to attach them
 * to.
 *
 * The join columns are still dropped: every row here carries the same value
 * for them, so a column of one repeated value is width spent on nothing. The
 * key stays, because it is what distinguishes the rows.
 *
 * Anyone who wants fewer can say so in the layout builder, which is the right
 * order for a default — start from everything and subtract, rather than start
 * from a guess and hunt for what is missing.
 */
export function listColumns(table: TableMeta, exclude: string[] = []): string[] {
  const skip = new Set(exclude);
  const chosen = table.columns.filter((c) => !skip.has(c.name)).map((c) => c.name);
  // Everything was part of the join: the key is better than an empty table.
  return chosen.length ? chosen : primaryKey(table).slice(0, 1);
}

/**
 * A few columns that say what a row *is*.
 *
 * Keys and the columns forming the join are dropped: in a table of a work
 * order's parts, every row has the same `work_order_id`, so a column of it is
 * a column of one repeated value. What is left is what distinguishes the rows
 * from each other, which is the only thing the section is there to show.
 */
export function summaryColumns(table: TableMeta, exclude: string[] = [], max = 5): string[] {
  const skip = new Set(exclude);
  const chosen: string[] = [];

  for (const column of table.columns) {
    if (skip.has(column.name)) continue;
    if (column.primaryKey && table.columns.some((c) => !c.primaryKey && !skip.has(c.name))) continue;
    chosen.push(column.name);
    if (chosen.length >= max) break;
  }
  // Everything was a key or excluded: the key is better than nothing.
  return chosen.length ? chosen : primaryKey(table).slice(0, 1);
}

/* ---------- resolving what to fetch ---------- */

interface ResolvedList {
  section: ListSection;
  fk: ForeignKey;
  child: TableMeta;
  /** Column on the child that carries the parent's key, per key column. */
  join: Array<{ childColumn: string; parentColumn: string }>;
}

/**
 * Match each list section to the foreign key it names.
 *
 * A section whose constraint has since been dropped is returned as an error
 * rather than skipped: a template that quietly stops showing a table looks
 * exactly like a record that has no rows in it.
 */
export function resolveLists(schema: DatabaseSchema, template: RecordTemplate): { lists: ResolvedList[]; errors: string[] } {
  const lists: ResolvedList[] = [];
  const errors: string[] = [];

  for (const section of template.sections) {
    if (section.kind !== 'list') continue;
    const fk = referencesTo(schema, template.base).find((f) => f.name === section.via);
    if (!fk) {
      errors.push(
        `${template.name}: nothing called "${section.via}" points at ${template.base} any more. ` +
          `The section was left in place so it can be removed or repointed.`,
      );
      continue;
    }
    const child = findTable(schema, fk.from.table);
    if (!child) {
      errors.push(`${template.name}: ${fk.from.table} is not in this schema.`);
      continue;
    }
    lists.push({
      section,
      fk,
      child,
      join: fk.to.columns.map((parentColumn, i) => ({
        parentColumn,
        childColumn: fk.from.columns[i] ?? fk.from.columns[0],
      })),
    });
  }

  return { lists, errors };
}

/**
 * Every path the base row itself has to supply.
 *
 * Collected across field sections so the record can be fetched in one query
 * rather than one per section — a page with six reference blocks should not
 * be six round trips.
 */
export function fieldPaths(template: RecordTemplate): string[] {
  const seen = new Set<string>();
  for (const section of template.sections) {
    if (section.kind !== 'fields') continue;
    for (const path of section.paths) seen.add(path);
  }
  return [...seen];
}

/** Whether a template still says anything, after resolution. */
export function isEmpty(template: RecordTemplate): boolean {
  return !template.sections.some((s) => (s.kind === 'list' ? true : s.paths.length > 0));
}

/* ---------- config ----------

   Record layouts were the one composed surface that could only be built by
   clicking. Views, saved SQL and pages all read from `tablewalk.json`, so a
   team could commit them and review them like anything else; a record layout
   lived in `layouts.json`, written by the builder, and the only way to share
   one was to copy the file. `RecordTemplate` has carried `source: 'config'`
   since it was written — this is the half that was missing. */

/**
 * One layout as a config file writes it.
 *
 * `sections` is deliberately not `RecordSection[]`: a list section is keyed
 * internally by constraint name (`via`), which is the right key — a child can
 * point at a parent twice and the column alone would not say which — and the
 * wrong thing to ask a person to type. So a config may say `via`, or say
 * `from` and `whose` the way a page section does, and the naming is resolved
 * against the schema when the layout is served.
 *
 * The authored words are the page section's — `whose`, `show`, `sort` — so
 * one file speaks one language (docs/apps.md, "The respelling"). The parsed
 * sections keep the internal field names (`path`, `paths`, `columns`,
 * `orderBy`): the client and the server's resolver read those, and the
 * respelling is of the surface a person types, not of the model.
 */
export interface ConfigLayout {
  table: string;
  connection?: string;
  name?: string;
  sections: Array<Record<string, unknown>>;
}

/* The spellings a layout section may not use any more, each mapped to the
   word that replaced it. Refused by name, in the parser's usual voice, the
   same way parseSection in page.ts refuses them — a local copy rather than a
   shared helper, because the two parsers name different examples and the
   client mirror rules keep this file importing nothing it does not need.
   `via` is NOT here: it names the foreign key's constraint, which is a
   different fact from the direction `whose` writes down, and it keeps its
   name. */
const RENAMED: Record<string, string> = {
  path: '"whose" — the column of the child table that names this record, e.g. "customer_id"',
  paths: '"show" — the fields to show, e.g. ["name", "customer_id.name"]',
  columns: '"show" — the columns the list shows, e.g. ["invoice_date", "total"]',
  orderBy: '"sort" — written like the query bar, e.g. "invoice_date desc, id"',
};

function refuseRenamed(s: Record<string, unknown>, at: string, keys: string[]): void {
  for (const key of keys) {
    if (s[key] !== undefined) throw new Error(`${at} has "${key}", which is now ${RENAMED[key]}.`);
  }
}

function parseSort(raw: unknown, at: string): ListSection['orderBy'] {
  return parseSortText(raw, at, 'invoice_date desc, id');
}

/**
 * Read the `layouts` section of a tablewalk.json.
 *
 * Throws on anything malformed rather than skipping it, naming the entry and
 * the fix — the same rule `parsePagesConfig` follows, for the same reason: a
 * layout that silently did not appear is a bug report that starts "I
 * definitely wrote it".
 *
 * Structure only. Whether `customer_id` is a real column, or `invoice` a real
 * table, needs a schema this runs long before — those are answered when the
 * layout is served, and reported on the layout itself.
 */
export function parseLayoutsConfig(raw: unknown, where: string): ConfigLayout[] {
  const layouts = (raw as { layouts?: unknown })?.layouts;
  if (layouts === undefined) return [];
  if (!Array.isArray(layouts)) throw new Error(`${where}: "layouts" must be an array.`);

  const seen = new Set<string>();
  return layouts.map((entry, i) => {
    const at = `${where}: layout ${i + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${at} is not an object.`);
    }
    const l = entry as Record<string, unknown>;
    if (typeof l.table !== 'string' || !l.table.trim()) {
      throw new Error(`${at} has no "table" — a layout lays out one table's records.`);
    }
    const table = l.table.trim();
    if (l.connection !== undefined && typeof l.connection !== 'string') {
      throw new Error(`${at} ("${table}") has a "connection" that is not a string.`);
    }
    if (l.name !== undefined && typeof l.name !== 'string') {
      throw new Error(`${at} ("${table}") has a "name" that is not a string.`);
    }
    /* One per table per connection: the store this fills is keyed that way,
       so a second would silently win over the first. */
    const key = `${l.connection ?? ''}::${table}`;
    if (seen.has(key)) throw new Error(`${at} repeats a layout for "${table}".`);
    seen.add(key);

    if (!Array.isArray(l.sections) || !l.sections.length) {
      throw new Error(`${at} ("${table}") has no "sections".`);
    }

    const sections = l.sections.map((raw2, j) => {
      const sat = `${at} ("${table}"), section ${j + 1}`;
      if (!raw2 || typeof raw2 !== 'object' || Array.isArray(raw2)) {
        throw new Error(`${sat} is not an object.`);
      }
      const s = raw2 as Record<string, unknown>;
      if (s.kind !== 'fields' && s.kind !== 'list') {
        throw new Error(`${sat} has "kind": ${JSON.stringify(s.kind)} — it must be "fields" or "list".`);
      }
      if (s.title !== undefined && typeof s.title !== 'string') {
        throw new Error(`${sat} has a "title" that is not a string.`);
      }

      if (s.kind === 'fields') {
        refuseRenamed(s, sat, ['paths']);
        if (!Array.isArray(s.show) || !s.show.every((p) => typeof p === 'string' && p.trim())) {
          throw new Error(`${sat} needs "show": a list of column names or paths like customer_id.name.`);
        }
        return { kind: 'fields', ...(s.title ? { title: s.title } : {}), paths: s.show.map((p) => String(p).trim()) };
      }

      /* A list says which relationship it shows, one way or the other. */
      refuseRenamed(s, sat, ['path', 'columns', 'orderBy']);
      const hasVia = typeof s.via === 'string' && s.via.trim();
      const hasPair = typeof s.from === 'string' && s.from.trim() && typeof s.whose === 'string' && s.whose.trim();
      if (!hasVia && !hasPair) {
        throw new Error(
          `${sat} needs either "via" (a foreign key constraint name) or "from" and "whose" ` +
            `— the child table and the column of it that points back here.`,
        );
      }
      if (s.show !== undefined && (!Array.isArray(s.show) || !s.show.every((c) => typeof c === 'string'))) {
        throw new Error(`${sat} has a "show" that is not a list of column names.`);
      }
      if (s.limit !== undefined && (typeof s.limit !== 'number' || !Number.isInteger(s.limit) || s.limit < 1)) {
        throw new Error(`${sat} has a "limit" that is not a whole number of rows.`);
      }
      const orderBy = parseSort(s.sort, sat);
      return {
        kind: 'list',
        ...(s.title ? { title: s.title } : {}),
        ...(hasVia ? { via: String(s.via).trim() } : {}),
        ...(hasPair ? { from: String(s.from).trim(), path: String(s.whose).trim() } : {}),
        columns: Array.isArray(s.show) ? s.show.map((c) => String(c)) : [],
        ...(s.limit !== undefined ? { limit: s.limit } : {}),
        ...(orderBy !== undefined ? { orderBy } : {}),
      };
    });

    return {
      table,
      ...(l.connection ? { connection: String(l.connection) } : {}),
      ...(l.name ? { name: String(l.name) } : {}),
      sections,
    };
  });
}
