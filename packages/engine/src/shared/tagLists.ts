/**
 * A record's tags read like a column: `tags` in a list's `show` draws its
 * chips, `filters: ['tags']` offers each tag as a choice, and the query
 * language asks `tags has bug` or `tags has (bug, docs)` — any of them.
 *
 * Like a rollup (rollups.ts), the tags are never a column of the table. The
 * App's catalog carries them beside the columns (`TableMeta.tags`, from the
 * resource's `tags: { through, to, tone }`, appResourceRules.appTagRules), so
 * an insert form, a plain read or an export of the table never names them,
 * and only the view compiler writes them: the list as one JSON array per row
 * through a correlated subquery, `has` as an EXISTS over the link rows. Both
 * read the link and tag tables through the statement's own relations
 * (rowScope.ts), so a row policy or a tenant scope on either narrows the tags
 * exactly as it narrows a related list of them, and a reader whose catalog
 * cannot see the link table or the tags is served none (the rule is resolved
 * against the reader's catalog).
 */
import type { ColumnMeta } from './schema.js';

/** The name a record's tags are read by, in a path, a `show` and a filter. */
export const TAGS_COLUMN = 'tags';
/** The type a record's tags carry where a column's would be: no column has it. */
export const TAGS_TYPE = 'tags';

/** A record's tags as the catalog serves them and a view carries them: no request ever supplies one. */
export interface TagSet {
  /** The link table's id. */
  through: string;
  /** The link column holding the record's key, and the record's column it points at. */
  from: string;
  key: string;
  /** The tag table's id. */
  to: string;
  /** The link column holding the tag's key, and the tag's column it points at. */
  via: string;
  tagKey: string;
  /** The tag's naming column: what a chip says and `has` compares. */
  label: string;
  /** The tag's tone column (good | warn | bad | info | neutral), where it has one. */
  tone?: string;
}

/** A view's tags, keyed by path ('tags', or 'project_id.tags'): the set and the prefix of the record it hangs off. */
export interface TagPath extends TagSet {
  on: string;
}

/** The tags read as a column: never written, never null (a record without tags has none). */
export function tagsColumnMeta(name = TAGS_COLUMN): ColumnMeta {
  return { name, type: TAGS_TYPE, nullable: false, primaryKey: false, writable: false };
}

/** One tag as a cell draws it. */
interface TagChip {
  label: string;
  tone?: string;
}

/**
 * A row's tags as the database answered them: a JSON array of [label, tone]
 * pairs, parsed already (PostgreSQL's json) or as text (SQLite).
 * Sorted by label, so every engine's answer reads the same; anything else is no tags.
 */
export function tagChips(value: unknown): TagChip[] {
  let list = value;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const chips: TagChip[] = [];
  for (const item of list) {
    const [label, tone] = Array.isArray(item) ? item : [item];
    if (label === null || label === undefined || label === '') continue;
    chips.push({ label: String(label), ...(typeof tone === 'string' && tone ? { tone } : {}) });
  }
  return chips.sort((a, b) => a.label.localeCompare(b.label));
}
