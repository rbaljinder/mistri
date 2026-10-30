/**
 * `index-missing`: where an App asks the database to filter or sort and no
 * index leads with the columns it asks by.
 *
 * A static match of the App's declared access paths to the database's own
 * index list (`pg_index`), not an EXPLAIN of every query: cheap, deterministic
 * and the same on every run. The paths read are the ones the declarations
 * make certain: a foreign key a related list or tab finds its rows by, a
 * list's default sort and the columns its fixed `query` filters, the
 * ownership column every read of a tenant table filters by, and the columns a
 * list's search box matches with `contains`.
 *
 * PostgreSQL only. SQLite's round trip is a call, not a flight, and its
 * catalog is the one `appIndexWarnings.ts` already reads.
 *
 * Not read: a row policy's columns. A policy resolves its rows when a person
 * asks (`resolveRows`), so the columns it filters by exist only in a request.
 *
 * The table's size says how loud: under 10,000 estimated rows (`reltuples`) a
 * missing index is information, since a scan of that is quick; above it, a
 * warning.
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import type { PageDef } from '@mistriwork/engine/shared/pageModel.js';
import { ANYONE, parseQuery } from '@mistriwork/engine/shared/query.js';
import { columnKind, labelColumn, tableNamed, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { AppDef } from '../../shared/appModel.js';

/** Under this many estimated rows a missing index is information, not a warning. */
export const SMALL_TABLE_ROWS = 10_000;

/** One index of the database, as `pg_index` says it. */
export interface PgIndex {
  /** `schema.table`, as the catalog names it. */
  table: string;
  /** Key columns in order; null where the key is an expression. */
  columns: Array<string | null>;
  /** A B-tree: the only kind that serves an equality or an order. */
  btree: boolean;
  /** The columns a pg_trgm operator class covers, at any position. */
  trigram: string[];
}

interface IndexFinding {
  severity: 'info' | 'warning';
  /** Where the App's definition asks: `views.leads.sort`, `resources.opportunity`. */
  declaration: string;
  table: string;
  columns: string[];
  message: string;
  /** The migration line that adds the index. */
  fix: string;
  rows: number | undefined;
}

const INDEXES = `
SELECT n.nspname::text, c.relname::text, am.amname::text,
       (SELECT array_agg(a.attname::text ORDER BY k.ord)
          FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
          LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum) AS columns,
       (SELECT coalesce(array_agg(ta.attname::text), '{}')
          FROM unnest(i.indkey::int2[], i.indclass::oid[]) AS k(attnum, opclass)
          JOIN pg_opclass oc ON oc.oid = k.opclass
          JOIN pg_attribute ta ON ta.attrelid = c.oid AND ta.attnum = k.attnum
         WHERE oc.opcname IN ('gin_trgm_ops', 'gist_trgm_ops')) AS trigram
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_am am ON am.oid = ic.relam
 WHERE i.indisvalid AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`;

const LIMIT = 50_000;

/** The database's indexes, or undefined where it cannot say (not PostgreSQL, or a role that may not read the catalog). */
export async function readPgIndexes(adapter: Adapter): Promise<PgIndex[] | undefined> {
  if (adapter.dialect !== 'postgres' || !adapter.runSql) return undefined;
  try {
    const result = await adapter.runSql({ text: INDEXES, limit: LIMIT });
    if (result.truncated) return undefined;
    return result.rows.map((row) => ({
      table: `${row[0]}.${row[1]}`,
      columns: (row[3] as Array<string | null> | null) ?? [],
      btree: row[2] === 'btree',
      trigram: (row[4] as string[] | null) ?? [],
    }));
  } catch {
    return undefined;
  }
}

/** The key a table is known by in `pg_index`. */
const keyOf = (table: TableMeta): string => `${table.schema || 'public'}.${table.name}`;

/** The column a sort written like the query bar reads in first: "price desc, mileage" is [price, mileage]; a label path ends the list. */
function sortColumns(sort: string): string[] {
  const out: string[] = [];
  for (const part of sort.split(',')) {
    const word = part.trim().replace(/^-/, '').split(/\s+/)[0];
    if (!word || !/^[A-Za-z_][\w$]*$/.test(word)) break;
    out.push(word);
  }
  return out;
}

const FILTERING = new Set(['=', 'in', 'isNull', '<', '<=', '>', '>=']);

/** The plain columns a view's fixed `query` filters on, when it is one AND of conditions. */
function filteredColumns(table: TableMeta, query: string, schema: DatabaseSchema): string[] {
  const parsed = parseQuery(`${table.id} ${query}`, {
    schema,
    me: ANYONE,
  }).query;
  if (!parsed || parsed.filter.groups.length !== 1) return [];
  return [
    ...new Set(
      parsed.filter.groups[0]!.flatMap((condition) =>
        FILTERING.has(condition.op) && /^[A-Za-z_][\w$]*$/.test(condition.column) ? [condition.column] : [],
      ),
    ),
  ];
}

interface IndexCheckInput {
  app: AppDef;
  pages: readonly PageDef[];
  schema: DatabaseSchema;
  indexes: readonly PgIndex[];
  /** A tenant App's ownership column per table id (the tenant policy's `ownership`). */
  owners?: Readonly<Record<string, string>>;
}

export function indexFindings({ app, pages, schema, indexes, owners = {} }: IndexCheckInput): IndexFinding[] {
  const found: IndexFinding[] = [];
  const said = new Set<string>();
  const byTable = new Map<string, PgIndex[]>();
  for (const index of indexes) byTable.set(index.table, [...(byTable.get(index.table) ?? []), index]);
  const tableOf = (name: string | undefined): TableMeta | undefined =>
    name ? (schema.tables.find((table) => table.id === name) ?? tableNamed(schema, name)) : undefined;

  /* An index serves the columns when they are its leading ones: in order for a sort, in any order for filters
     that all must hold. A partial index counts: its predicate may be the very filter. */
  const led = (table: TableMeta, columns: readonly string[], ordered: boolean): boolean =>
    (byTable.get(keyOf(table)) ?? []).some((index) => {
      if (!index.btree) return false;
      const lead = index.columns.slice(0, columns.length);
      return ordered ? columns.every((column, i) => lead[i] === column) : columns.every((column) => lead.includes(column));
    });

  const say = (
    declaration: string,
    table: TableMeta,
    columns: string[],
    why: string,
    options: { trigram?: boolean; ordered?: boolean } = {},
  ) => {
    const key = `${keyOf(table)}|${columns.join(',')}|${options.trigram ? 'trgm' : ''}`;
    if (said.has(key)) return;
    said.add(key);
    const rows = table.approxRows;
    const name = `idx_${table.name}_${columns.join('_')}${options.trigram ? '_trgm' : ''}`.slice(0, 63);
    const on = `${table.schema && table.schema !== 'public' ? `${table.schema}.` : ''}${table.name}`;
    const fix = options.trigram
      ? `CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE INDEX IF NOT EXISTS ${name} ON ${on} USING gin (${columns[0]} gin_trgm_ops);`
      : `CREATE INDEX IF NOT EXISTS ${name} ON ${on} (${columns.join(', ')});`;
    found.push({
      severity: (rows ?? 0) < SMALL_TABLE_ROWS ? 'info' : 'warning',
      declaration,
      table: table.name,
      columns,
      message:
        `${declaration}: ${why} (${table.name}${rows !== undefined ? `, about ${Math.round(rows).toLocaleString('en-US')} rows` : ''}) ` +
        `and no index leads with ${columns.join(', ')}.`,
      fix,
      rows,
    });
  };

  for (const [id, column] of Object.entries(owners)) {
    const table = tableOf(id);
    if (table && !led(table, [column], true))
      say(`resources.${id}`, table, [column], `every tenant read filters by its ownership column ${column}`);
  }

  /* A related list or tab finds a record's children by the reference column: every foreign key between two
     tables the App declares. */
  const resources = Object.entries(app.resources ?? {}).flatMap(([name, block]) => {
    const table = tableNamed(schema, block.physical ?? name);
    return table ? [{ name, table }] : [];
  });
  const declared = new Map(resources.map((resource) => [resource.table.id, resource.name]));
  for (const { name, table } of resources) {
    for (const edge of schema.foreignKeys) {
      if (edge.from.table !== table.id || !declared.has(edge.to.table)) continue;
      if (!led(table, edge.from.columns, false))
        say(
          `resources.${name}`,
          table,
          edge.from.columns,
          `a record of ${declared.get(edge.to.table)} lists its ${name} by ${edge.from.columns.join(', ')}`,
        );
    }
  }

  /* A page's list walks its path one reference a hop, each hop a lookup by that column. */
  for (const page of pages) {
    page.sections.forEach((section, at) => {
      const { from, path } = section as { from?: unknown; path?: unknown };
      if (typeof from !== 'string' || typeof path !== 'string' || !path) return;
      let table = tableOf(from);
      for (const column of path.split('.')) {
        if (!table) break;
        const edge = schema.foreignKeys.find((fk) => fk.from.table === table!.id && fk.from.columns[0] === column);
        if (!edge) break;
        if (!led(table, edge.from.columns, false))
          say(
            `pages.${page.id}.sections[${at}]`,
            table,
            edge.from.columns,
            `its list finds a record's rows by ${edge.from.columns.join(', ')}`,
          );
        table = tableOf(edge.to.table);
      }
    });
  }

  const searched = new Set(resources.filter((resource) => app.resources?.[resource.name]?.search).map((resource) => resource.table.id));
  for (const [key, view] of Object.entries(app.views)) {
    const list = view as {
      table?: unknown;
      sort?: unknown;
      order?: unknown;
      query?: unknown;
      filters?: unknown;
      filterBar?: unknown;
    };
    const table = typeof list.table === 'string' ? tableOf(list.table) : undefined;
    if (!table) continue;
    const filtered = typeof list.query === 'string' ? filteredColumns(table, list.query, schema) : [];
    const sorted = typeof list.sort === 'string' ? sortColumns(list.sort) : typeof list.order === 'string' ? [list.order] : [];
    /* The fixed filter narrows the scan, so it is what an index is wanted for; with none, the sort is. The
       combined index (the filter's columns, then the sort's) is the one suggested. */
    if (filtered.length) {
      if (!led(table, filtered, false) && !(sorted.length && led(table, sorted, true)))
        say(
          `views.${key}.query`,
          table,
          [...filtered, ...sorted.filter((column) => !filtered.includes(column))],
          `its fixed filter reads by ${filtered.join(', ')}`,
        );
    } else if (sorted.length && !led(table, sorted, true)) {
      say(`views.${key}.sort`, table, sorted, `its first page sorts by ${sorted.join(', ')}`);
    }

    /* The search box matches the record's name with `contains` (ILIKE '%x%'), and each text filter box does
       too: a B-tree never serves that, only a trigram index. A search provider answers instead where the
       resource declares `search`. */
    if (searched.has(table.id) || list.filterBar === 'none') continue;
    const name = table.labelTemplate ? undefined : labelColumn(table);
    const boxes = [
      ...new Set([
        ...(name ? [name] : []),
        ...(Array.isArray(list.filters) ? list.filters.filter((f): f is string => typeof f === 'string') : []),
      ]),
    ];
    for (const column of boxes) {
      const meta = table.columns.find((c) => c.name === column);
      if (!meta || columnKind(meta.type) !== 'text') continue;
      if ((byTable.get(keyOf(table)) ?? []).some((index) => index.trigram.includes(column))) continue;
      say(`views.${key}.search`, table, [column], `its search box matches ${column} with contains`, { trigram: true });
    }
  }
  return found;
}
