import type { DatabaseSync } from 'node:sqlite';
import { ANSI_STYLE, Refusal } from '../adapter.js';
import { cachedStatement as prepared } from '../sqliteHandles.js';
import {
  chooseColumnReference,
  deleteRuleOf,
  type ColumnReferenceCandidate,
  type ColumnReferenceChoice,
  type DatabaseSchema,
  type TableMeta,
} from '../../shared/schema.js';
import { mapScopeCatalog } from '../../shared/scopeCatalog.js';
import { referenceKey, type ReferenceComparison, type ScopeCatalog } from './scopedTransaction.js';
import { keyTypeRefusal, sqliteAffinity, sqliteKeyType, sqliteTypeSaid } from './keyTypes.js';
import { readSqliteTrigger, sqliteColumnCollations, sqliteConflictClauses } from './sqliteTriggers.js';
import type { ScopeTrigger } from './scopeTriggers.js';
import type { EffectCatalog, KeyComparison, resolveTriggerEffects } from './triggerEffects.js';

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
export function readSqliteScopeCatalog(db: DatabaseSync, resolve?: typeof resolveTriggerEffects): SqliteScopeCatalog {
  const scanned = scanSqliteScopeCatalog(db);
  const { schema, writable } = scanned;
  /* Keyed effects are judged against the catalog they run in (triggerEffects.ts, which the caller loads); a database
     without them asks nothing more. Unjudged, none is accepted. */
  const keyed = [...scanned.triggered.values()].some((triggers) => triggers.some((trigger) => trigger.effects));
  const triggered = !keyed
    ? scanned.triggered
    : resolve
      ? resolve({ schema, writable, triggered: scanned.triggered, foldCase: true, ...sqliteKeyFacts(db) })
      : new Map(
          [...scanned.triggered].map(([id, triggers]) => [
            id,
            triggers.map((trigger) =>
              trigger.effects ? { ...trigger, unaccepted: 'its effects were not judged against the catalog' } : trigger,
            ),
          ]),
        );
  const unkeyed = sqliteUnkeyed(schema);
  return {
    schema,
    writable,
    ...(triggered.size ? { triggered } : {}),
    references: sqliteReferences(schema),
    ...(unkeyed.size ? { unkeyed } : {}),
  };
}

/** The tables whose primary key has a column of a type a scoped write does not take as a row's identity (keyTypes.ts), with why. */
function sqliteUnkeyed(schema: DatabaseSchema): ReadonlyMap<string, string> {
  const unkeyed = new Map<string, string>();
  for (const table of schema.tables) {
    const column = table.columns.find((candidate) => candidate.primaryKey && !sqliteKeyType(candidate.type));
    if (column) unkeyed.set(table.id, keyTypeRefusal('sqlite', table.id, column.name, sqliteTypeSaid(column.type)));
  }
  return unkeyed;
}

/**
 * Whether SQLite's foreign key can find another parent than a check before the write, for a child column of affinity
 * `child` and a parent key of `parent`, each of a type a key may be (keyTypes.ts: INTEGER or TEXT, and a typeless
 * child). The foreign key applies the parent's affinity to what the child column stored (its own affinity applied to
 * the value written, datatype3.html 3.0); the check applies the parent's affinity to the value written. The two part
 * only where the child's affinity changes a value in a way the parent's does not undo:
 *
 * - BLOB (a typeless column) converts nothing: what it stores is what was written. Never.
 * - The same affinity twice: applying one affinity again changes nothing. Never.
 * - TEXT against an INTEGER key: a number stored as its text reads back as that number under the key's affinity, and
 *   a text stays the text it was. Never.
 * - INTEGER against a TEXT key: "7.0" is stored as 7 and the key reads "7". The check, given "7.0", reads otherwise,
 *   and a number read back is the number given, so nothing after the statement tells them apart. Refused.
 */
const affinitiesPart = (child: string, parent: string): boolean => {
  const [c, p] = [sqliteAffinity(child), sqliteAffinity(parent)];
  return c !== 'BLOB' && c !== p && p === 'TEXT';
};

/**
 * How each foreign key compares a reference (ScopeCatalog.references). SQLite's applies the parent column's affinity
 * to the value the child column stored, which that column's own affinity made of what was written; a parent check
 * binds what was written and the parent column applies its affinity to that. The two agree unless the child's
 * affinity changes the value first in a way the parent's does not undo (affinitiesPart): an INTEGER column stores
 * "7.0" as 7, which a TEXT key reads as '7', where the check's '7.0' found '7.0'. A write through such a foreign key
 * cannot be checked, and is refused, as is one where either side is of a type a key may not be (keyTypes.ts); one
 * through a typeless reference, or a TEXT one to an INTEGER key, is checked.
 */
function sqliteReferences(schema: DatabaseSchema): ReadonlyMap<string, ReferenceComparison> {
  const typeOf = (table: string, name: string) =>
    schema.tables.find((candidate) => candidate.id === table)?.columns.find((column) => column.name === name)?.type;
  const references = new Map<string, ReferenceComparison>();
  for (const fk of schema.foreignKeys) {
    const types = fk.from.columns.map((column) => typeOf(fk.from.table, column));
    const parents = fk.to.columns.map((column) => typeOf(fk.to.table, column));
    /* Each side of a reference is a row's identity (keyTypes.ts): the key it points at of a type on the list, and the
       reference too, or typeless (BLOB affinity), which stores what was written and so compares as the check does. */
    const unkeyed = parents.findIndex((type) => type !== undefined && !sqliteKeyType(type));
    const unkeyedChild = types.findIndex((type) => type !== undefined && !sqliteKeyType(type) && sqliteAffinity(type) !== 'BLOB');
    const differ = types.findIndex(
      (type, index) => type === undefined || parents[index] === undefined || affinitiesPart(type, parents[index]!),
    );
    references.set(
      referenceKey(fk),
      unkeyed !== -1
        ? { refused: `${keyTypeRefusal('sqlite', fk.to.table, fk.to.columns[unkeyed], sqliteTypeSaid(parents[unkeyed]!))}.` }
        : unkeyedChild !== -1
          ? { refused: `${keyTypeRefusal('sqlite', fk.from.table, fk.from.columns[unkeyedChild], sqliteTypeSaid(types[unkeyedChild]!))}.` }
          : differ === -1 && types.length === parents.length
            ? { columns: types.map((type) => ({ type: type! })) }
            : {
                refused:
                  `"${fk.from.table}".${fk.from.columns[differ] ?? fk.from.columns.join('+')} references "${fk.to.table}".${fk.to.columns[differ] ?? fk.to.columns.join('+')}, ` +
                  "a column of another affinity that changes the value before the foreign key compares it: SQLite's foreign key compares it as no check before the write can, so a scoped write that sets it is refused.",
              },
    );
  }
  return references;
}

/**
 * How a key equality in a trigger compares on SQLite (triggerEffects.ts): each column's affinity, which decides what
 * a value is converted to before it is compared, and its collation, which `NEW.code = code` takes from the column on
 * its left; and the primary key as a key only where its index compares each column under that column's own
 * collation (`PRIMARY KEY (code COLLATE NOCASE)` on a BINARY column is unique under one and found under the other).
 * And the conflict clause a table declares other than ABORT, which a trigger's write runs under when the statement
 * that fired it is a delete (triggerEffects.ts). Read where effects are judged, inside the writer's BEGIN IMMEDIATE.
 */
export function sqliteKeyFacts(db: DatabaseSync): Pick<EffectCatalog, 'keys' | 'comparison' | 'conflicts'> {
  const definitions = new Map<string, string | undefined>();
  const definitionOf = (table: TableMeta) => {
    if (!definitions.has(table.id)) {
      const row = prepared(db, "SELECT sql FROM main.sqlite_schema WHERE type = 'table' AND name = ?").get(table.name);
      definitions.set(table.id, typeof row?.sql === 'string' ? row.sql : undefined);
    }
    return definitions.get(table.id);
  };
  const collations = new Map<string, Map<string, string> | undefined>();
  const collationsOf = (table: TableMeta) => {
    if (!collations.has(table.id)) {
      const sql = definitionOf(table);
      collations.set(table.id, sql === undefined ? undefined : sqliteColumnCollations(sql));
    }
    return collations.get(table.id);
  };
  const conflicts = (table: TableMeta): string | undefined => {
    const sql = definitionOf(table);
    const clauses = sql === undefined ? undefined : sqliteConflictClauses(sql);
    if (!clauses) return 'a conflict clause mistri cannot read';
    // ABORT is what the statement's own OR ABORT would say; any other changes what a conflicting write does.
    return clauses.find((clause) => clause !== 'ON CONFLICT ABORT');
  };
  const comparison = (table: TableMeta, name: string): KeyComparison | undefined => {
    const column = table.columns.find((candidate) => folded(candidate.name) === folded(name));
    const collation = column && collationsOf(table)?.get(folded(column.name));
    if (!column || !collation) return undefined;
    const type = sqliteAffinity(column.type);
    return {
      type,
      collation,
      exact: true,
      said: `${type} affinity, COLLATE ${collation}`,
      keyable: sqliteKeyType(column.type),
      declared: sqliteTypeSaid(column.type),
    };
  };
  const keys = (table: TableMeta): string[][] => {
    const primary = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
    if (!primary.length) return [];
    // A rowid alias holds integers alone, compared by no collation; it has no index of its own.
    if (primary.length === 1 && table.columns.find((column) => column.name === primary[0])?.identity) return [primary];
    const index = prepared(db, `PRAGMA main.index_list(${ANSI_STYLE.quote(table.name)})`)
      .all()
      .find((row) => row.origin === 'pk');
    if (typeof index?.name !== 'string') return [];
    const indexed = prepared(db, `PRAGMA main.index_xinfo(${ANSI_STYLE.quote(index.name)})`)
      .all()
      .filter((row) => row.key === 1);
    const same = primary.every((name) => {
      const at = indexed.find((row) => typeof row.name === 'string' && folded(row.name) === folded(name));
      const own = comparison(table, name);
      return typeof at?.coll === 'string' && own !== undefined && at.coll.toUpperCase() === own.collation;
    });
    return same && indexed.length === primary.length ? [primary] : [];
  };
  return { keys, comparison, conflicts };
}

/**
 * For `mistri check`: the tables a scoped write cannot target for what they are rather than their triggers — a
 * virtual table and its shadow tables, whose module writes them (scanSqliteScopeCatalog keeps them out of
 * `writable`) — read on the reader, so check refuses an effect on one as the write does.
 */
export function sqliteBlockedTables(db: DatabaseSync): ReadonlyMap<string, string> {
  const blocked = new Map<string, string>();
  for (const table of prepared(db, 'PRAGMA main.table_list').all() as unknown as ListedTable[]) {
    if (table.schema !== 'main' || typeof table.name !== 'string') continue;
    if (table.type === 'virtual' || table.type === 'shadow')
      blocked.set(table.name, "a virtual table's module, whose writes the policy cannot bound");
  }
  return blocked;
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
): SqliteScopeCatalog & { readable: ReadonlySet<string>; triggered: ReadonlyMap<string, readonly ScopeTrigger[]> } {
  try {
    if (prepared(db, 'PRAGMA foreign_keys').get()?.foreign_keys !== 1) return refuse();
    const entries = prepared(
      db,
      "SELECT name, type FROM main.sqlite_schema WHERE type IN ('table', 'view') ORDER BY name",
    ).all() as unknown as Array<{ name: string; type: string }>;
    const listed = prepared(db, 'PRAGMA main.table_list').all() as unknown as ListedTable[];
    // Unknown PRAGMAs can return nothing without throwing. Never interpret
    // unavailable table-kind metadata as proof that a table is ordinary.
    if (!listed.some((table) => table.schema === 'main' && table.name === 'sqlite_schema' && table.type === 'table')) return refuse();
    const kinds = identities(listed.filter((table) => table.schema === 'main'));
    /* Each table's triggers, main and TEMP, with the statement that made them: which writes fire each, and whether
       it only validates its row, is read from that text per table below (sqliteTriggers.ts, scopeTriggers.ts). */
    const definitions = new Map<string, Array<{ name: string; sql: unknown }>>();
    for (const namespace of ['main', 'temp']) {
      const triggers = prepared(
        db,
        `SELECT tbl_name AS name, name AS trigger, sql FROM ${namespace}.sqlite_schema WHERE type = 'trigger' ORDER BY name`,
      ).all();
      for (const trigger of triggers) {
        if (typeof trigger.name !== 'string' || typeof trigger.trigger !== 'string') return refuse();
        definitions.set(folded(trigger.name), [
          ...(definitions.get(folded(trigger.name)) ?? []),
          { name: trigger.trigger, sql: trigger.sql },
        ]);
      }
    }
    const triggered = new Map<string, readonly ScopeTrigger[]>();
    const shadowed = new Set<string>();
    for (const table of prepared(db, "SELECT name FROM temp.sqlite_schema WHERE type IN ('table', 'view')").all()) {
      if (typeof table.name !== 'string') return refuse();
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
      const columns = prepared(db, `PRAGMA main.table_xinfo(${ANSI_STYLE.quote(entry.name)})`).all() as unknown as Column[];
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
      const indexes = prepared(db, `PRAGMA main.index_list(${ANSI_STYLE.quote(entry.name)})`).all();
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
        !shadowed.has(folded(entry.name)) &&
        columns.every((column) => column.hidden !== 1)
      ) {
        /* A table with triggers is written only by the writes that fire none of them but validation-only ones
           (scopedTransaction.ts target): it stays out of `writable`, which says every write may run. */
        const triggers = definitions.get(folded(entry.name));
        if (!triggers) writable.add(entry.name);
        else {
          const computed = new Set(columns.filter(generated).map((column) => folded(column.name)));
          triggered.set(
            entry.name,
            triggers.map((trigger) => readSqliteTrigger(trigger.name, trigger.sql, computed)),
          );
        }
      }
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
      const rows = prepared(db, `PRAGMA main.foreign_key_list(${ANSI_STYLE.quote(table.name)})`).all() as unknown as ForeignKeyRow[];
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
      triggered,
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
