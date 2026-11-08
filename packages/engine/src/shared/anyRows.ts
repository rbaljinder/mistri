/*
 * An `any`/`no` condition read where no view is: a table read by a handler's `db`, a loader's, a policy's. The
 * child is found the way a view finds it (the reference they point at the row through, `child.column`), and the
 * test is written as an EXISTS whose join is built here once, for the two readers that need it — a raw adapter,
 * which reads the child as it reads the parent (unscoped), and a scoped read, which reads it through the reader's
 * row scope (scopedReads.ts) — so the two cannot drift on the join, its operators or what they refuse.
 */
import { RequestFault } from './refusal.js';
import { backrefsTo } from './viewPaths.js';
import type { AnyRows, InlineRows, SqlStyle } from './filter.js';
import { findTable, type DatabaseSchema, type TableMeta } from './schema.js';

/** The alias the child rows stand under inside their EXISTS: the parent is named by its own relation. */
const CHILD = '_tw_any';

interface ChildRows {
  readonly child: TableMeta;
  /** The EXISTS' join, the child under `alias` and the parent under `parent`: each key compared as the catalog's types allow. */
  join(alias: string, parent: string): string;
}

const refused = () => new RequestFault('This read cannot ask about the rows that point at it.');

/**
 * The child an `any` names, from the table it points at. Refused, never guessed, when the reference is not one the
 * catalog holds, is stitched to another connection, or the child's conditions say more than a child's own columns
 * compared with values (no second `any`, no column on the right, no resolved test, no path).
 */
export function childRows(schema: DatabaseSchema, parentId: string, rows: AnyRows, style: SqlStyle): ChildRows {
  if (!rows || typeof rows !== 'object' || typeof rows.via !== 'string') throw refused();
  const parent = findTable(schema, parentId);
  const match = backrefsTo(schema, parentId).find((b) => `${b.child}.${b.fk.from.columns.join('+')}` === rows.via);
  const child = match && findTable(schema, match.child);
  if (!parent || !match || !child || match.fk.stitched) throw refused();
  for (const group of rows.filter?.groups ?? []) {
    for (const c of group) {
      if (c.any !== undefined || c.other !== undefined || c.via !== undefined || c.equality !== undefined) throw refused();
      if (typeof c.column !== 'string' || !child.columns.some((column) => column.name === c.column))
        throw new RequestFault('Unknown column in a related-rows test.');
    }
  }
  const { fk } = match;
  if (fk.from.columns.length !== fk.to.columns.length) throw refused();
  const typeOf = (table: TableMeta, name: string) => table.columns.find((column) => column.name === name)?.type ?? '';
  return {
    child,
    join: (alias, ref) =>
      fk.to.columns
        .map((to, at) => {
          const from = fk.from.columns[at]!;
          /* The database's own operator where both sides are built-in types, as a column compared with a column is
             (filter.ts): a bare `=` resolves through the search_path. */
          const op = style.builtin?.(typeOf(child, from)) && style.builtin?.(typeOf(parent, to)) ? 'OPERATOR(pg_catalog.=)' : '=';
          return `${alias}.${style.quote(from)} ${op} ${ref}.${style.quote(to)}`;
        })
        .join(' AND '),
  };
}

/**
 * `buildWhere`'s `inline` for a raw read of `parentId`, whose FROM names the row as `parent` (already quoted): the
 * child is read from its own relation, as the parent is, with no scope between.
 */
export function inlineRows(
  schema: DatabaseSchema,
  parentId: string,
  parent: string,
  style: SqlStyle,
  relation: (table: TableMeta) => string,
): (rows: AnyRows) => InlineRows {
  return (rows) => {
    const { child, join } = childRows(schema, parentId, rows, style);
    const alias = style.quote(CHILD);
    return {
      relation: relation(child),
      alias,
      on: join(alias, parent),
      column: (name) => `${alias}.${style.quote(name)}`,
      /* Typed as the scoped read types them, so a child's comparison names the built-in operator there too. */
      types: (name) => child.columns.find((column) => column.name === name)?.type,
    };
  };
}
