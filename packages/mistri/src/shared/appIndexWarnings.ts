/**
 * The indexes an App's reads lean on, where the catalog says one is missing.
 *
 * Every warning here is a read that works and is correct, and becomes a
 * sequential scan the day the table is large: a related list finds a record's
 * children by the reference column, a tenant's every read by its ownership
 * column, a big list's first page by its default sort. Compass on PostgreSQL
 * had nineteen of twenty-one references unindexed and nothing said so.
 *
 * Advice only, printed by `mistri check` (and so by `mistri build`) beside
 * its verdict and never changing it. A catalog that does not report indexes
 * (`indexed` absent) is "we did not look", never "there are none", so it is
 * never a finding (lint.ts reads it the same way). `indexed` holds each
 * index's leading column only, which is exactly the question: an index on
 * (tenant_id, created_at) serves `tenant_id = ?` and not `created_at = ?`.
 *
 * A chart fixed to `day` over a window longer than a quarter is the one piece of advice that is not an index: its
 * bars are too thin to read, and most are empty where the data is sparse. `auto` is the answer (autoBucket.ts).
 *
 * A `contains` search (ILIKE '%x%') is the one read a B-tree cannot serve at
 * all, wherever the column sits in it: only a trigram index can. PostgreSQL's
 * catalog records which columns a pg_trgm index covers (`trigram`); the other
 * engines have no index for it and are not asked.
 */
import { columnKind, labelColumn, tableNamed, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { AppDef } from './appModel.js';
import type { PageDef } from '@mistriwork/engine/shared/pageModel.js';
import { DAY_BARS_ADVISED, cutsDays, windowDays } from '@mistriwork/engine/shared/autoBucket.js';
import { DEFAULT_WINDOWS } from './appModel.js';

/** Past this many approximate rows, sorting a list's first page without an index is worth a word. */
export const LARGE_TABLE_ROWS = 50_000;

interface AppIndexOptions {
  /** A tenant App's ownership column per table id (the tenant policy's `ownership`). */
  readonly owners?: Readonly<Record<string, string>>;
}

function tableOf(schema: DatabaseSchema, name: string | undefined): TableMeta | undefined {
  if (!name) return undefined;
  return schema.tables.find((table) => table.id === name) ?? tableNamed(schema, name);
}

/** Known and not leading any index: the one case that is a finding. */
const unindexed = (table: TableMeta, column: string): boolean => Boolean(table.indexed) && !table.indexed!.includes(column);

/** The column a sort written like the query bar reads in first: "price desc, mileage" is price; a label path is not a column. */
function leadingSortColumn(sort: string): string | undefined {
  const first = sort.split(',')[0]?.trim().replace(/^-/, '').split(/\s+/)[0];
  return first && /^[A-Za-z_][\w$]*$/.test(first) ? first : undefined;
}

export function appIndexWarnings(app: AppDef, pages: readonly PageDef[], schema: DatabaseSchema, options: AppIndexOptions = {}): string[] {
  const warnings: string[] = [];
  const said = new Set<string>();
  const say = (key: string, line: string) => {
    if (!said.has(key)) {
      said.add(key);
      warnings.push(line);
    }
  };

  for (const [id, column] of Object.entries(options.owners ?? {})) {
    const table = tableOf(schema, id);
    if (!table || !unindexed(table, column)) continue;
    say(
      `owner:${table.id}.${column}`,
      `${table.name}.${column} is the tenant ownership column and leads no index: every tenant read of ` +
        `${table.name} scans the whole table. Add an index that starts with ${column}.`,
    );
  }

  /* A related list walks its path from the listed table toward the page's
     record, one reference per hop; each hop is a lookup by that column. */
  for (const page of pages) {
    for (const section of page.sections) {
      const { from, path } = section as { from?: unknown; path?: unknown };
      if (typeof from !== 'string' || typeof path !== 'string' || !path) continue;
      let table = tableOf(schema, from);
      for (const column of path.split('.')) {
        if (!table) break;
        const edge = schema.foreignKeys.find((fk) => fk.from.table === table!.id && fk.from.columns[0] === column);
        if (!edge) break;
        if (unindexed(table, column)) {
          say(
            `fk:${table.id}.${column}`,
            `page "${page.name}": its list of ${table.name} finds a record's rows by ${table.name}.${column}, ` +
              `which leads no index. Add an index on ${column}.`,
          );
        }
        table = tableOf(schema, edge.to.table);
      }
    }
  }

  for (const [key, view] of Object.entries(app.views)) {
    const { table: id, sort } = view as { table?: unknown; sort?: unknown };
    if (typeof id !== 'string' || typeof sort !== 'string') continue;
    const table = tableOf(schema, id),
      column = leadingSortColumn(sort);
    if (!table || !column || (table.approxRows ?? 0) <= LARGE_TABLE_ROWS || !unindexed(table, column)) continue;
    say(
      `sort:${key}`,
      `view "${key}": sorts ${table.name} (about ${table.approxRows!.toLocaleString('en-US')} rows) by ${column}, ` +
        `which leads no index, so its first page sorts the whole table. Add an index on ${column}.`,
    );
  }

  /* A list's search box reads its name column with `contains`, and each
     text filter box does too unless the table filters only by exact values
     (`filterable`, an API's). Past the large-table line that is a scan of
     every row per keystroke's answer. */
  for (const [key, view] of Object.entries(app.views)) {
    const { table: id, filters, filterBar } = view as { table?: unknown; filters?: unknown; filterBar?: unknown };
    const table = typeof id === 'string' ? tableOf(schema, id) : undefined;
    if (!table?.trigram || table.filterable || filterBar === 'none' || (table.approxRows ?? 0) <= LARGE_TABLE_ROWS) continue;
    const name = table.labelTemplate ? undefined : labelColumn(table);
    const searched = [
      ...new Set([...(name ? [name] : []), ...(Array.isArray(filters) ? filters.filter((f): f is string => typeof f === 'string') : [])]),
    ];
    for (const column of searched) {
      const meta = table.columns.find((c) => c.name === column);
      if (!meta || columnKind(meta.type) !== 'text' || table.trigram.includes(column)) continue;
      say(
        `contains:${table.id}.${column}`,
        `view "${key}": searches ${table.name}.${column} for text anywhere in it (contains), and ` +
          `${column} has no trigram index, so every search reads all of about ${table.approxRows!.toLocaleString('en-US')} rows. ` +
          `Add one: CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE INDEX ON ${table.schema && table.schema !== 'public' ? `${table.schema}.` : ''}${table.name} USING gin (${column} gin_trgm_ops).`,
      );
    }
  }

  /* A chart fixed to `day` draws a bar a day of whatever window the reader picks: past a quarter that is a bar too
     thin to read, most of them empty where the data is sparse. `auto` picks the unit from the window. */
  const now = new Date();
  for (const [key, view] of Object.entries(app.views)) {
    const dash = view as { sections?: ReadonlyArray<DashLike>; aside?: ReadonlyArray<DashLike>; windows?: string[] };
    for (const section of [...(dash.sections ?? []), ...(dash.aside ?? [])]) {
      if (section.kind !== 'chart' || !section.over || !cutsDays(section.by)) continue;
      const phrases = section.windows ?? dash.windows ?? DEFAULT_WINDOWS;
      const widest = phrases
        .map((phrase) => ({ phrase, days: windowDays(phrase, now) ?? 0 }))
        .reduce((a, b) => (b.days > a.days ? b : a), { phrase: '', days: 0 });
      if (widest.days <= DAY_BARS_ADVISED) continue;
      say(
        `day-bars:${key}:${section.title ?? section.by}`,
        `view "${key}": chart "${section.title ?? section.by}": \`day\` over \`${widest.phrase}\` draws ${widest.days} bars, use \`auto\` ` +
          `(the unit then follows the window).`,
      );
    }
  }
  return warnings;
}

interface DashLike {
  kind?: string;
  by?: string;
  title?: string;
  over?: string;
  windows?: string[];
}
