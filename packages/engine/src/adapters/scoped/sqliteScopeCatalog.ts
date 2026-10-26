import type { DatabaseSync } from 'node:sqlite';
import { ANSI_STYLE, Refusal } from '../adapter.js';
import {
  chooseColumnReference,
  deleteRuleOf,
  type ColumnReferenceCandidate,
  type ColumnReferenceChoice,
  type DatabaseSchema,
  type TableMeta,
} from '../../shared/schema.js';
import { mapScopeCatalog } from '../../shared/scopeCatalog.js';
import { triggerNames, type ScopeCatalog } from './scopedTransaction.js';

export type SqliteScopeCatalog = ScopeCatalog;

interface ListedTable {
  schema: string;
  name: string;
  type: string;
  ncol: number;
  wr: number;
  strict: number;
}
interface Column {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}
interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_delete: string;
  on_update: string;
}

/* `table_xinfo`'s hidden: 0 a plain column, 1 a virtual table's own (its module's plumbing), 2 and 3 generated
   (virtual, stored). A generated column keeps its table in scope: it is computed from the row the policy or the
   tenant predicate already bounds, so a scoped read reads it and a scoped write leaves it to the database (sqlite.ts
   refuses writing one). */
const generated = (column: Column) => column.hidden === 2 || column.hidden === 3;

// SQLite's built-in identifier matching folds ASCII, not arbitrary Unicode.
const folded = (name: string) => name.replace(/[A-Z]/g, (char) => char.toLowerCase());
const refuse = (cause?: unknown): never => {
  throw new Refusal(
    'SQLite scoped transactions require a complete, unambiguous catalog and enabled foreign keys.',
    cause === undefined ? {} : { cause },
  );
};
// SQLite's primary result codes for an engine that could not answer, rather
// than a catalog that is wrong: BUSY, LOCKED, NOMEM, INTERRUPT, IOERR, FULL,
// CANTOPEN, PROTOCOL. Extended codes keep the primary code in the low byte.
const UNAVAILABLE = new Set([5, 6, 7, 9, 10, 13, 14, 15]);
function identities<T extends { name: string }>(items: T[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    if (typeof item.name !== 'string' || !item.name || result.has(folded(item.name))) return refuse();
    result.set(folded(item.name), item);
  }
  return result;
}

/** Call only on the writer inside BEGIN IMMEDIATE. No cached/public catalog,
 * estimates or data scans: the lease's physical metadata is the authority.
 * A non-writable table remains in the graph so hidden dependents cannot vanish.
 */
export function readSqliteScopeCatalog(db: DatabaseSync): SqliteScopeCatalog {
  const { schema, writable, blockedBy } = scanSqliteScopeCatalog(db);
  return { schema, writable, ...(blockedBy.size ? { blockedBy } : {}) };
}

/** Metadata-only read attestation inside the caller's owned snapshot. Exposes
 * no writer eligibility. Keep every non-engine table and dependency, including
 * private/unmapped objects, so an unknown business edge cannot disappear. */
export function readSqliteReadCatalog(db: DatabaseSync): { schema: DatabaseSchema; readable: ReadonlySet<string> } {
  if (!db.isTransaction) return refuse();
  const { schema, readable } = scanSqliteScopeCatalog(db);
  const ids = new Map(schema.tables.filter((table) => !folded(table.id).startsWith('sqlite_')).map((table) => [table.id, table.id]));
  return { schema: mapScopeCatalog(schema, ids), readable };
}

function scanSqliteScopeCatalog(
  db: DatabaseSync,
): SqliteScopeCatalog & { readable: ReadonlySet<string>; blockedBy: ReadonlyMap<string, string> } {
  try {
    if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) return refuse();
    const entries = db
      .prepare("SELECT name, type FROM main.sqlite_schema WHERE type IN ('table', 'view') ORDER BY name")
      .all() as unknown as Array<{ name: string; type: string }>;
    const listed = db.prepare('PRAGMA main.table_list').all() as unknown as ListedTable[];
    // Unknown PRAGMAs can return nothing without throwing. Never interpret
    // unavailable table-kind metadata as proof that a table is ordinary.
    if (!listed.some((table) => table.schema === 'main' && table.name === 'sqlite_schema' && table.type === 'table')) return refuse();
    const kinds = identities(listed.filter((table) => table.schema === 'main'));
    const blocked = new Set<string>();
    const triggered = new Map<string, string[]>();
    for (const namespace of ['main', 'temp']) {
      const triggers = db
        .prepare(`SELECT tbl_name AS name, name AS trigger FROM ${namespace}.sqlite_schema WHERE type = 'trigger' ORDER BY name`)
        .all();
      for (const trigger of triggers) {
        if (typeof trigger.name !== 'string' || typeof trigger.trigger !== 'string') return refuse();
        blocked.add(folded(trigger.name));
        triggered.set(folded(trigger.name), [...(triggered.get(folded(trigger.name)) ?? []), trigger.trigger]);
      }
    }
    const blockedBy = new Map<string, string>();
    const shadowed = new Set<string>();
    for (const table of db.prepare("SELECT name FROM temp.sqlite_schema WHERE type IN ('table', 'view')").all()) {
      if (typeof table.name !== 'string') return refuse();
      blocked.add(folded(table.name));
      shadowed.add(folded(table.name));
    }

    const tables: TableMeta[] = [];
    const columnsByTable = new Map<string, Column[]>();
    const writable = new Set<string>();
    const readable = new Set<string>();
    identities(entries);
    for (const entry of entries) {
      const kind = kinds.get(folded(entry.name));
      if (
        !kind ||
        kind.name !== entry.name ||
        !['table', 'view', 'virtual', 'shadow'].includes(kind.type) ||
        (entry.type === 'view') !== (kind.type === 'view')
      )
        return refuse();
      const columns = db.prepare(`PRAGMA main.table_xinfo(${ANSI_STYLE.quote(entry.name)})`).all() as unknown as Column[];
      identities(columns);
      if (!columns.length || columns.length !== kind.ncol) return refuse();
      for (const [i, column] of columns.entries()) {
        if (
          column.cid !== i ||
          typeof column.type !== 'string' ||
          !Number.isInteger(column.pk) ||
          column.pk < 0 ||
          ![0, 1].includes(column.notnull) ||
          ![0, 1, 2, 3].includes(column.hidden) ||
          (column.dflt_value !== null && typeof column.dflt_value !== 'string')
        )
          return refuse();
      }
      const primary = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
      if (primary.some((column, i) => column.pk !== i + 1)) return refuse();
      const indexes = db.prepare(`PRAGMA main.index_list(${ANSI_STYLE.quote(entry.name)})`).all();
      // INTEGER PRIMARY KEY DESC has a PK index and is not a rowid alias.
      const identity =
        kind.type === 'table' &&
        kind.wr === 0 &&
        primary.length === 1 &&
        /^INTEGER$/i.test(primary[0].type.trim()) &&
        !indexes.some((index) => index.origin === 'pk')
          ? primary[0].name
          : undefined;
      tables.push({
        id: entry.name,
        name: entry.name,
        schema: 'main',
        isView: kind.type === 'view',
        columns: columns.map((column) => ({
          name: column.name,
          type: column.type || (kind.type === 'view' ? '' : 'BLOB'),
          primaryKey: column.pk > 0,
          nullable: column.notnull === 0 && column.name !== identity && !(column.pk > 0 && (kind.wr === 1 || kind.strict === 1)),
          ...(column.dflt_value !== null ? { default: column.dflt_value } : {}),
          ...(column.name === identity ? { identity: 'by-default' as const } : {}),
          // The database computes a generated column from its row: read like any other, never written.
          ...(generated(column) ? { writable: false } : {}),
        })),
      });
      columnsByTable.set(entry.name, columns);
      if (
        kind.type === 'table' &&
        !folded(entry.name).startsWith('sqlite_') &&
        !blocked.has(folded(entry.name)) &&
        columns.every((column) => column.hidden !== 1)
      )
        writable.add(entry.name);
      const triggers = kind.type === 'table' ? triggered.get(folded(entry.name)) : undefined;
      if (triggers) blockedBy.set(entry.name, triggerNames(triggers));
      if (
        kind.type === 'table' &&
        !folded(entry.name).startsWith('sqlite_') &&
        !shadowed.has(folded(entry.name)) &&
        // A generated column is read like any other; a virtual table's own columns (hidden 1) are its module's.
        columns.every((column) => column.hidden !== 1)
      )
        readable.add(entry.name);
    }

    const byName = identities(tables);
    const foreignKeys: DatabaseSchema['foreignKeys'] = [];
    for (const table of tables) {
      const rows = db.prepare(`PRAGMA main.foreign_key_list(${ANSI_STYLE.quote(table.name)})`).all() as unknown as ForeignKeyRow[];
      const groups = new Map<number, ForeignKeyRow[]>();
      for (const row of rows) {
        if (
          !Number.isInteger(row.id) ||
          row.id < 0 ||
          !Number.isInteger(row.seq) ||
          row.seq < 0 ||
          typeof row.table !== 'string' ||
          typeof row.from !== 'string' ||
          (row.to !== null && typeof row.to !== 'string')
        )
          return refuse();
        const group = groups.get(row.id) ?? [];
        group.push(row);
        groups.set(row.id, group);
      }
      const localColumns = identities(table.columns);
      /* Every key a column sits in, judged together after the groups: one
         column legitimately carries its own reference and its part in a
         composite key (chooseColumnReference says which link a reader
         follows, and which case is a contradiction). */
      const candidates = new Map<string, ColumnReferenceCandidate[]>();
      for (const [id, unordered] of groups) {
        const group = unordered.sort((a, b) => a.seq - b.seq);
        const first = group[0];
        const parent = byName.get(folded(first.table));
        const onDelete = deleteRuleOf(first.on_delete);
        if (
          !parent ||
          kinds.get(folded(parent.name))?.type !== 'table' ||
          !onDelete ||
          !deleteRuleOf(first.on_update) ||
          group.some(
            (row, i) =>
              row.seq !== i ||
              folded(row.table) !== folded(first.table) ||
              row.on_delete !== first.on_delete ||
              row.on_update !== first.on_update,
          )
        )
          return refuse();
        const parentColumns = identities(parent.columns);
        const primary = columnsByTable
          .get(parent.id)!
          .filter((column) => column.pk > 0)
          .sort((a, b) => a.pk - b.pk);
        const implicit = first.to === null;
        if (group.some((row) => (row.to === null) !== implicit) || (implicit && primary.length !== group.length)) return refuse();
        const from = group.map((row) => localColumns.get(folded(row.from))?.name ?? refuse());
        const to = group.map((row, i) => (implicit ? primary[i].name : (parentColumns.get(folded(row.to!))?.name ?? refuse())));
        if (new Set(from).size !== from.length || new Set(to).size !== to.length) return refuse();
        foreignKeys.push({
          name: `${table.name}_fk_${id}`,
          from: { table: table.id, columns: from },
          to: { table: parent.id, columns: to },
          onDelete,
        });
        for (const [i, name] of from.entries()) {
          const column = localColumns.get(folded(name))!;
          const listed = candidates.get(column.name) ?? [];
          listed.push({ reference: { table: parent.id, column: to[i] }, composite: group.length > 1 });
          candidates.set(column.name, listed);
        }
      }
      for (const [name, listed] of candidates) {
        const chosen: ColumnReferenceChoice = chooseColumnReference(listed);
        // This is the attesting path, so a contradiction refuses the catalog.
        // The adapter's own describe keeps the same verdict and shows no link
        // instead: see chooseColumnReference for why the two differ.
        if (chosen.kind === 'conflict') return refuse();
        if (chosen.kind === 'one') localColumns.get(folded(name))!.references = chosen.reference;
      }
    }
    return {
      schema: { dialect: 'sqlite', label: 'SQLite scoped transaction', readAt: new Date().toISOString(), tables, foreignKeys },
      writable,
      readable,
      blockedBy,
    };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    // Missing/broken objects and unknown metadata cannot weaken the boundary.
    // Refused either way; a busy or failing engine is kept as the cause.
    const { code, errcode } = (error ?? {}) as { code?: unknown; errcode?: unknown };
    if (code === 'ERR_SQLITE_ERROR' && typeof errcode === 'number' && UNAVAILABLE.has(errcode & 0xff)) return refuse(error);
    return refuse();
  }
}
