/**
 * A SQLite FTS5 index, on Node's built-in `node:sqlite` — the same driver
 * the engine's SQLite adapter uses, so the pack adds no dependency and no
 * service: the index is a file beside the deployment, one FTS5 table per
 * collection, and it survives a restart, which the in-memory provider does
 * not. That is the pack for an App whose tables are the moderate ones
 * Mistri's home turf holds and whose deployment wants no external engine;
 * a large catalog still wants the Typesense pack.
 *
 * Search is an index, never a source of truth: it holds a copy of the
 * fields a resource declares searchable, keyed by the record's primary key,
 * and answers a phrase with keys — the rows themselves are re-read from
 * the database under the reader's own grants. It is core's `SearchIndex`
 * (packages/mistri/src/server/app/searchProvider.ts), and nothing of
 * SQLite's own shape leaves this file: a tenant's scope becomes an exact
 * match on a column here, not in core.
 *
 * Ranking is FTS5's bm25, with an earlier declared field weighing more
 * than a later one, and ties falling to the key, so two runs over the same
 * index answer in the same order. It is full-text ranking, not the memory
 * provider's strict field order: a rare word in a later field can outrank a
 * common word in an earlier one, because bm25 weighs a word by how few
 * documents hold it. A whole-phrase hit is asked beside each word hit
 * (`"stone countertop" OR stone OR countertop`, per field), so a record
 * holding the phrase ranks with the word hits rather than apart from them.
 *
 * FTS5 tables cannot be altered, so a field added to a declaration after
 * the collection exists rebuilds the table: the rows are copied into a new
 * table with the wider shape, the old table is dropped, and the new one is
 * renamed, inside one transaction. A field is never dropped — a declaration
 * that stops naming one leaves its column, unread, rather than rewriting
 * the index.
 *
 * Core already passes the tenant field in with the declared fields, and
 * the definition appends it once, so `ensureCollection` drops it from the
 * incoming list first — naming it twice refuses the create, on every
 * tenant App.
 *
 * FTS5's `id` is an ordinary unindexed column, so a delete by key scans
 * the whole table and a full reindex grows quadratically. A second table
 * maps each key to its FTS rowid, so an update deletes and re-inserts by
 * rowid — a lookup, not a scan — and a rebuild copies rowids with the
 * rows, so the map survives it.
 *
 * Identifiers are never interpolated unchecked: a collection name and every
 * field name must be word characters (the runtime already sanitises a
 * collection to `<prefix>_<app>_<resource>`), and anything else is refused
 * rather than quoted, because a quoted identifier in an FTS5 definition is
 * a shape the index cannot be trusted to hold.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  SearchUnavailable,
  type SearchDocument,
  type SearchIndex,
  type SearchScope,
} from '../../../packages/mistri/src/server/app/searchProvider.js';

/** The document field that holds a tenant-owned record's tenant (appSearchRuntime.ts); kept in every table, unindexed. */
const TENANT_FIELD = 'mistri_tenant';

/** A name this file interpolates into SQL: word characters only, so no quoting is ever needed. */
const isIdentifier = (name: string): boolean => /^[A-Za-z0-9_]+$/.test(name);

const identifier = (name: string, what: string): string => {
  if (!isIdentifier(name)) throw new Error(`${what} "${name}" is not a name of letters, digits and underscores.`);
  return name;
};

/** The FTS5 definition of a collection: the key unindexed, each declared field searchable, the tenant unindexed. */
const definition = (fields: readonly string[]): string =>
  ['id UNINDEXED', ...fields.map((field) => identifier(field, 'A searched field')), `${TENANT_FIELD} UNINDEXED`].join(', ');

/** The tokens FTS5's unicode61 tokenizer would read from a phrase: letters, digits and underscores, in order. */
const tokensOf = (phrase: string): string[] => phrase.match(/[\p{L}\p{N}_]+/gu) ?? [];

/** One token as an FTS5 phrase atom: quoted, so a hyphen or other syntax in it is a word, not an operator. */
const atom = (token: string): string => `"${token.replace(/"/g, '""')}"`;

/**
 * The MATCH expression for `phrase` across `fields`: for each field, the
 * whole phrase beside each word, so a phrase hit and a word hit are both
 * asked and bm25 orders them. Empty when the phrase holds no token.
 */
const matchOf = (phrase: string, fields: readonly string[]): string | undefined => {
  const tokens = tokensOf(phrase);
  if (!tokens.length) return undefined;
  const atoms = [...(tokens.length > 1 ? [tokens.map(atom).join(' ')] : []), ...tokens.map(atom)];
  const parts: string[] = [];
  for (const field of fields) for (const phraseAtom of atoms) parts.push(`{${field}} : ${phraseAtom}`);
  return parts.join(' OR ');
};

/** One collection's table, in one file. */
export class SqliteFtsIndex implements SearchIndex {
  readonly collectionPrefix: string;
  /** The fields each collection holds, as `ensureCollection` last left them. */
  private readonly fields = new Map<string, string[]>();

  constructor(
    private readonly db: DatabaseSync,
    collectionPrefix: string,
  ) {
    this.collectionPrefix = collectionPrefix;
  }

  /** The collection exists and holds every field named; a field added later rebuilds the table to hold it. */
  async ensureCollection(name: string, fields: readonly string[]): Promise<void> {
    const table = identifier(name, 'A search collection');
    /* Core already passes the tenant field in; the definition appends it
       once, so it is dropped here first — naming it twice refuses the
       create, on every tenant App. */
    const wanted = fields.filter((field) => field !== TENANT_FIELD).map((field) => identifier(field, 'A searched field'));
    const have = this.fields.get(table) ?? this.readFields(table);
    if (!have) {
      this.db.exec(`CREATE VIRTUAL TABLE "${table}" USING fts5(${definition(wanted)}, tokenize='unicode61')`);
      this.fields.set(table, [...wanted]);
      this.ensureKeys(table);
      return;
    }
    this.ensureKeys(table);
    const missing = wanted.filter((field) => !have.includes(field));
    if (!missing.length) return;
    const next = [...have, ...missing];
    this.db.exec('BEGIN');
    try {
      this.db.exec(`CREATE VIRTUAL TABLE "${table}__next" USING fts5(${definition(next)}, tokenize='unicode61')`);
      /* Rowids travel with the rows, so the key map still names the same
         rows after the rename — it is not rebuilt, only the table is. */
      const columns = ['rowid', 'id', ...have, TENANT_FIELD].join(', ');
      this.db.exec(`INSERT INTO "${table}__next"(${columns}) SELECT ${columns} FROM "${table}"`);
      this.db.exec(`DROP TABLE "${table}"`);
      this.db.exec(`ALTER TABLE "${table}__next" RENAME TO "${table}"`);
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* The rollback itself failed; the error below is the one that matters. */
      }
      throw error;
    }
    this.fields.set(table, next);
  }

  /** The key-to-rowid map for `table`, created when absent and backfilled once from the rows already there. */
  private ensureKeys(table: string): void {
    const keys = `${table}__keys`;
    const found = this.db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?`).get(keys) as
      | { count: number }
      | undefined;
    if (found && found.count > 0) return;
    this.db.exec(`CREATE TABLE "${keys}"(id TEXT PRIMARY KEY, rowid INTEGER NOT NULL)`);
    this.db.exec(`INSERT INTO "${keys}"(id, rowid) SELECT id, rowid FROM "${table}"`);
  }

  /** The rowid the key map holds for `id`, or undefined where the map holds none — or is not there at all. */
  private keyRowid(table: string, id: string): number | undefined {
    try {
      const row = this.db.prepare(`SELECT rowid FROM "${table}__keys" WHERE id = ?`).get(id) as { rowid: number } | undefined;
      return row?.rowid;
    } catch {
      return undefined;
    }
  }

  /** The record's document, replacing any document its key already had; a document whose collection was never ensured is ensured from its own fields. */
  async upsert(collection: string, document: SearchDocument): Promise<void> {
    const table = identifier(collection, 'A search collection');
    const fields = Object.keys(document).filter((key) => key !== 'id' && key !== TENANT_FIELD);
    await this.ensureCollection(table, fields);
    const held = this.fields.get(table)!;
    const keys = `${table}__keys`;
    const columns = ['id', ...held, TENANT_FIELD];
    const values: SQLInputValue[] = columns.map((column) =>
      column === 'id' ? document.id : ((document[column] ?? null) as SQLInputValue),
    );
    const insert = (extra: string[], extraValues: SQLInputValue[]) =>
      this.db
        .prepare(
          `INSERT INTO "${table}"(${[...extra, ...columns].map((column) => `"${column}"`).join(', ')}) VALUES (${[...extra, ...columns].map(() => '?').join(', ')})`,
        )
        .run(...extraValues, ...values);
    /* A known key reuses its rowid: the old row is deleted by rowid and
       the new one takes the same rowid, so the map never moves. A new key
       records the rowid its insert got. Only a row the map never saw —
       written before the map existed and missed by its backfill — falls
       back to a delete by key. */
    const known = this.keyRowid(table, document.id);
    if (known !== undefined) {
      this.db.prepare(`DELETE FROM "${table}" WHERE rowid = ?`).run(known);
      insert(['rowid'], [known]);
      return;
    }
    this.db.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(document.id);
    const result = insert([], []);
    this.db.prepare(`INSERT INTO "${keys}"(id, rowid) VALUES (?, ?)`).run(document.id, result.lastInsertRowid);
  }

  /** Gone from the index; a document that was never there is gone already, and a collection never ensured holds nothing — as does a name the index cannot hold. */
  async remove(collection: string, id: string): Promise<void> {
    if (!isIdentifier(collection)) return;
    const table = collection;
    if (!this.readFields(table)) return;
    const known = this.keyRowid(table, id);
    if (known !== undefined) this.db.prepare(`DELETE FROM "${table}" WHERE rowid = ?`).run(known);
    else this.db.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id);
    try {
      this.db.prepare(`DELETE FROM "${table}__keys" WHERE id = ?`).run(id);
    } catch {
      /* No key map yet: there is no row to drop from it. */
    }
  }

  /** The keys of the best matches for `phrase` across `fields`, best first, at most `limit`; a collection never indexed matches nothing, and neither does a name the index cannot hold. */
  async search(collection: string, phrase: string, fields: readonly string[], limit: number, scope?: SearchScope): Promise<string[]> {
    if (limit <= 0 || !isIdentifier(collection)) return [];
    const table = collection;
    const held = this.fields.get(table) ?? this.readFields(table);
    if (!held) return [];
    const asked = fields.filter((field) => isIdentifier(field) && held.includes(field));
    if (!asked.length) return [];
    const match = matchOf(phrase, asked);
    if (!match) return [];
    /* bm25 weights follow the table's columns in order, the key and the
       tenant included at zero: a searched field weighs by its place in the
       asked order (an earlier field more), and an unsearched column weighs
       nothing, so it cannot lift a match. */
    const weights = [
      '0.0',
      ...held.map((field) => {
        const at = asked.indexOf(field);
        return at < 0 ? '0.0' : String(asked.length - at);
      }),
      '0.0',
    ];
    const params: SQLInputValue[] = [match];
    let where = `"${table}" MATCH ?`;
    if (scope) {
      if (!isIdentifier(scope.field)) return [];
      if (scope.field !== TENANT_FIELD && !held.includes(scope.field)) return [];
      where += ` AND "${scope.field}" = ?`;
      params.push(scope.value);
    }
    params.push(Math.floor(limit));
    try {
      return (
        this.db
          .prepare(`SELECT id FROM "${table}" WHERE ${where} ORDER BY bm25("${table}", ${weights.join(', ')}), id LIMIT ?`)
          .all(...params) as Array<{ id: string }>
      ).map((row) => row.id);
    } catch (error) {
      throw new SearchUnavailable(`search "${table}" could not be asked: ${(error as Error).message}`);
    }
  }

  /** The fields a table on disk holds, remembered for the next call; undefined when the table is not there. */
  private readFields(table: string): string[] | undefined {
    try {
      const rows = this.db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>;
      if (!rows.length) return undefined;
      const held = rows.map((row) => row.name).filter((name) => name !== 'id' && name !== TENANT_FIELD);
      this.fields.set(table, held);
      return held;
    } catch {
      return undefined;
    }
  }
}
