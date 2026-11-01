/**
 * A Postgres tsvector index, on the `pg` package — already an optional
 * dependency of the engine, loaded the way the engine loads it (a dynamic
 * import, so a deployment without `pg` is told to install it rather than
 * crashing on a missing import), so the pack adds no dependency and no
 * service: the index is tables in the database the connection names, one
 * table per collection, and it survives a restart, which the in-memory
 * provider does not. That is the pack for an App whose deployment already
 * runs Postgres and wants its search beside its tables; a large catalog
 * still wants the Typesense pack.
 *
 * Search is an index, never a source of truth: it holds a copy of the
 * fields a resource declares searchable, keyed by the record's primary key,
 * and answers a phrase with keys — the rows themselves are re-read from
 * the database under the reader's own grants. It is core's `SearchIndex`
 * (packages/mistri/src/server/app/searchProvider.ts), and nothing of
 * Postgres's own shape leaves this file: a tenant's scope becomes an exact
 * match on a column here, not in core.
 *
 * One table per collection, in the connection's search path (no schema
 * option: a dedicated database, or a role whose search path names one, is
 * the isolation, as it is for the connection's own database):
 *
 *   id text, each declared field text, mistri_tenant text, one
 *   generated tsvector column per field, one GIN index per vector column,
 *   and one unique index on (id, mistri_tenant) — a record is keyed by its
 *   tenant and its id, so two tenants whose records share a primary key
 *   hold two documents rather than overwriting one. The vector is `to_tsvector('simple', coalesce(field, ''))`:
 *   the `simple` configuration on both the vector and the query, so no
 *   stemming and no stop words — the closest Postgres analogue to the
 *   SQLite pack's unicode61 tokens — and the server's
 *   `default_text_search_config` never changes what an index holds.
 *
 * A phrase is asked the way the SQLite pack asks it: the whole phrase
 * beside each word, so a record holding the phrase ranks with the word
 * hits rather than apart from them. The query is a tsquery built from the
 * phrase's tokens (letters, digits and underscores, lowercased, each
 * quoted, so a word like `or` is a word, not an operator) and passed as a
 * parameter to `to_tsquery('simple', $1)`; every other value is a
 * parameter too. The filter is an OR over the asked fields' vector
 * columns, so each column's GIN index can serve its own column and the
 * planner bitmap-ORs them; the rank is the asked fields' `ts_rank` values
 * weighted by asked order (an earlier asked field more), ties falling to
 * the key, so two runs over the same index answer in the same order. The
 * weights live in the query, not in the vectors: a search that asks a
 * subset of the declared fields ranks by that subset, and a hit in a field
 * the search did not ask cannot lift a record — a combined vector over all
 * declared fields would let it, which is why there is one vector column
 * per field rather than one per table.
 *
 * Generated columns cannot change their expression by ALTER, so a field
 * added to a declaration after the collection exists rebuilds the table
 * the way the SQLite pack rebuilds an FTS5 table: the rows are copied
 * into a new table with the wider shape, the old table is dropped, and
 * the new one is renamed, inside one transaction. A field is never
 * dropped — a declaration that stops naming one leaves its column, unread,
 * rather than rewriting the index.
 *
 * The runtime passes a tenant App's tenant field inside
 * `ensureCollection`'s field list (appSearchRuntime.ts), so both packs drop
 * it from the incoming list, or it would be held twice, once as a searched
 * field and once as the tenant column. Here `mistri_tenant` — and `id`, the
 * document key — are stripped from the searchable set and always present as
 * plain columns, never as vector columns. One divergence from the SQLite
 * pack: a Postgres deployment is multi-process, so another process may have
 * rebuilt the table since this one last looked. The field list is cached per
 * process and per table, and re-read from the catalog once when a statement
 * meets an undefined column or a search asks a field the cache lacks; a
 * rebuild re-reads it under an advisory lock, so two processes growing the
 * same table cannot both rebuild it.
 *
 * There is no migration history and no store layout for search indexes:
 * provisioning is lazy, on `ensureCollection`, exactly as the SQLite
 * pack's is. The runtime stores' layouts (storeLayouts.ts) are for
 * runtime stores, not for a pack's index tables.
 *
 * Identifiers are never interpolated unchecked: a collection name and
 * every field name must be word characters, and anything else is refused
 * rather than quoted. Postgres's 63-byte identifier limit applies to the
 * table and index names this file derives; a collection whose name, with
 * the rebuild table's `__next`, would pass it is refused with that reason —
 * on the first statement for it, in `collectionTable` — not truncated into a
 * name that collides with another table or that nothing finds again.
 */
import { createHash } from 'node:crypto';
import {
  SearchUnavailable,
  type SearchDocument,
  type SearchIndex,
  type SearchScope,
} from '../../../packages/mistri/src/server/app/searchProvider.js';

/** The document field that holds a tenant-owned record's tenant (appSearchRuntime.ts); kept in every table, unindexed. */
const TENANT_FIELD = 'mistri_tenant';

/** The text-search configuration on every vector and every query: no stemming, no stop words. */
const TEXT_CONFIG = 'simple';

/** A name this file interpolates into SQL: word characters only, so no quoting is ever needed beyond the quotes themselves. */
const isIdentifier = (name: string): boolean => /^[A-Za-z0-9_]+$/.test(name);

const identifier = (name: string, what: string): string => {
  if (!isIdentifier(name)) throw new Error(`${what} "${name}" is not a name of letters, digits and underscores.`);
  return name;
};

/** Postgres truncates an identifier past 63 bytes, with only a NOTICE: the table would exist under a name no later statement uses. The rebuild table adds `__next`, so a collection that may ever grow is held to what leaves room for it. */
const MAX_COLLECTION_BYTES = 63 - '__next'.length;

/** A collection's table name, or a refusal that names the collection and says what to shorten: truncating it would index into a table nothing can find. */
const collectionTable = (name: string, prefix: string): string => {
  identifier(name, 'A search collection');
  if (Buffer.byteLength(name) > MAX_COLLECTION_BYTES) {
    throw new Error(
      `A search collection "${name}" is ${Buffer.byteLength(name)} bytes; Postgres allows 63 and the rebuild table needs 6 of them, so at most ${MAX_COLLECTION_BYTES}. ` +
        `Shorten the App id or the resource name, or the collection prefix ("${prefix}").`,
    );
  }
  return name;
};

/** A name inside Postgres's 63-byte identifier limit, with a hash of the full name when it would not fit. */
const bounded = (base: string): string =>
  base.length <= 63 ? base : `${base.slice(0, 54)}_${createHash('sha1').update(base).digest('hex').slice(0, 8)}`;

/** The vector column for a field: the field's name, so a search can ask one field without reading the others. */
const vectorColumn = (field: string): string => `${field}__tsv`;

/** A GIN index's name, kept inside Postgres's 63-byte identifier limit with a hash of the full name when it would not fit. */
const indexName = (table: string, field: string): string => bounded(`${table}_${field}__tsv_idx`);

/** The unique index that keys a document by its tenant and its id; an untenanted record keys on the empty tenant. */
const keyIndexSql = (table: string): string =>
  `CREATE UNIQUE INDEX IF NOT EXISTS "${bounded(`${table}__key_idx`)}" ON "${table}" ("id", (coalesce("${TENANT_FIELD}", '')))`;

/** The searchable fields of a declaration: word characters, without the reserved names, without repeats. */
const searchableFields = (fields: readonly string[]): string[] => {
  const wanted: string[] = [];
  for (const field of fields) {
    const name = identifier(field, 'A searched field');
    if (name === 'id' || name === TENANT_FIELD) continue;
    if (!wanted.includes(name)) wanted.push(name);
  }
  for (const field of wanted) {
    if (wanted.includes(vectorColumn(field))) {
      throw new Error(`A searched field "${field}" collides with the index's vector column for another field; rename the field.`);
    }
  }
  return wanted;
};

/** The tokens `to_tsquery` would read from a phrase: letters, digits and underscores, in order, lowercased. */
const tokensOf = (phrase: string): string[] => (phrase.match(/[\p{L}\p{N}_]+/gu) ?? []).map((token) => token.toLowerCase());

/** One token as a tsquery lexeme: quoted, so a word like `or` is a word, not an operator. Tokens hold no quotes by construction. */
const lexeme = (token: string): string => `'${token}'`;

/**
 * The tsquery for `phrase` across the asked fields: for a multi-word
 * phrase, the whole phrase beside each word, so a phrase hit and a word
 * hit are both asked. Empty when the phrase holds no token.
 */
const tsqueryOf = (phrase: string): string | undefined => {
  const tokens = tokensOf(phrase);
  if (!tokens.length) return undefined;
  const parts = tokens.map(lexeme);
  if (tokens.length > 1) parts.unshift(tokens.map(lexeme).join(' <-> '));
  return parts.join(' | ');
};

/** The `CREATE TABLE` for a collection: the key, each field as text, the tenant as text, one generated vector per field. */
const createTableSql = (table: string, fields: readonly string[], ifNotExists: boolean): string => {
  const parts = [
    '"id" text NOT NULL',
    ...fields.map((field) => `"${field}" text`),
    `"${TENANT_FIELD}" text`,
    ...fields.map(
      (field) => `"${vectorColumn(field)}" tsvector GENERATED ALWAYS AS (to_tsvector('${TEXT_CONFIG}', coalesce("${field}", ''))) STORED`,
    ),
  ];
  return `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}"${table}" (${parts.join(', ')})`;
};

const quoted = (columns: readonly string[]): string => columns.map((column) => `"${column}"`).join(', ');

/** Something that answers a query: the pool, or one client of it. */
interface PgQueryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** One connection checked out of the pool; a transaction must run on one, or its statements land on different connections. */
interface PgClient extends PgQueryable {
  release(destroy?: boolean): void;
}

/** The least `pg` this file needs: a pool that answers queries, lends a client, reports a dropped idle one, and ends. */
interface PgPool extends PgQueryable {
  connect(): Promise<PgClient>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  end(): Promise<void>;
}

type PgPoolConstructor = new (options: { connectionString: string }) => PgPool;

/** The `pg` pool, loaded the way the engine loads it: a missing package is a sentence, not a crash on import. */
async function openPool(connectionString: string): Promise<PgPool> {
  const specifier = 'pg';
  const pg = (await import(specifier).catch(() => {
    throw new Error('Postgres search needs the "pg" package. Install it with: npm install pg');
  })) as unknown as { Pool?: PgPoolConstructor; default?: { Pool?: PgPoolConstructor } };
  const Pool = pg.Pool ?? pg.default?.Pool;
  if (!Pool) throw new Error('Could not find a Pool export in the "pg" package.');
  const pool = new Pool({ connectionString });
  /* pg removes a failed idle client itself; an unhandled pool error would crash Node, as the engine's pool
     (adapters/postgresPool.ts) is told. This pool sits outside the engine's admission — its own connections,
     not the connection's capped writer pool — so a search is neither queued nor counted there. */
  pool.on('error', () => {});
  return pool;
}

/** One collection's table, in one database. */
export class PostgresTsvectorIndex implements SearchIndex {
  readonly collectionPrefix: string;
  private pool: PgPool | undefined;
  /** The searchable fields each table held when last read; see `readFields` for when it is read again. */
  private readonly fields = new Map<string, string[]>();

  constructor(
    private readonly connectionString: string,
    collectionPrefix: string,
  ) {
    this.collectionPrefix = collectionPrefix;
  }

  /** The pool, opened on first use, never at plug-in, so a deployment that declares the connection but serves no searched App never connects. */
  private async db(): Promise<PgPool> {
    if (!this.pool) this.pool = await openPool(this.connectionString);
    return this.pool;
  }

  /** Ends the pool; the next call reopens it. For tests and shutdown — the index itself is tables in Postgres and survives. */
  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    this.fields.clear();
    if (pool) await pool.end();
  }

  /** The collection exists and holds every field named; a field added later rebuilds the table to hold it. */
  async ensureCollection(name: string, fields: readonly string[]): Promise<void> {
    const table = collectionTable(name, this.collectionPrefix);
    const wanted = searchableFields(fields);
    const pool = await this.db();
    let held = await this.readFields(table);
    if (!held) {
      await pool.query(createTableSql(table, wanted, true));
      await pool.query(keyIndexSql(table));
      for (const field of wanted) {
        await pool.query(`CREATE INDEX IF NOT EXISTS "${indexName(table, field)}" ON "${table}" USING gin ("${vectorColumn(field)}")`);
      }
      held = await this.readFields(table, true);
      if (!held) throw new Error(`A search collection "${table}" could not be created.`);
    }
    if (wanted.every((field) => held!.includes(field))) return;
    const temp = `${table}__next`;
    /* The whole rebuild on one client: BEGIN, the DDL and COMMIT through the pool would land on different
       connections. The advisory lock, keyed by the table, makes a second process wait here and then find the
       table already wide enough, so two processes never rebuild it at once. */
    const client = await pool.connect();
    let failed = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [table]);
      const current = (await this.catalogFields(client, table)) ?? held;
      const missing = wanted.filter((field) => !current.includes(field));
      const next = [...current, ...missing];
      if (missing.length) {
        await client.query(`DROP TABLE IF EXISTS "${temp}"`);
        await client.query(createTableSql(temp, next, false));
        const columns = ['id', ...current, TENANT_FIELD];
        await client.query(`INSERT INTO "${temp}"(${quoted(columns)}) SELECT ${quoted(columns)} FROM "${table}"`);
        await client.query(`DROP TABLE "${table}"`);
        await client.query(`ALTER TABLE "${temp}" RENAME TO "${table}"`);
        await client.query(keyIndexSql(table));
        for (const field of next) {
          await client.query(`CREATE INDEX IF NOT EXISTS "${indexName(table, field)}" ON "${table}" USING gin ("${vectorColumn(field)}")`);
        }
      }
      await client.query('COMMIT');
      this.fields.set(table, next);
    } catch (error) {
      failed = true;
      try {
        await client.query('ROLLBACK');
      } catch {
        /* The rollback itself failed; the error below is the one that matters. */
      }
      throw error;
    } finally {
      // A client that failed mid-transaction is destroyed, not returned to the pool in an unknown state.
      client.release(failed);
    }
  }

  /** The record's document, replacing the document its tenant and key already had; a document whose collection was never ensured is ensured from its own fields. */
  async upsert(collection: string, document: SearchDocument): Promise<void> {
    const table = collectionTable(collection, this.collectionPrefix);
    const fields = Object.keys(document).filter((key) => key !== 'id' && key !== TENANT_FIELD);
    await this.ensureCollection(table, fields);
    const pool = await this.db();
    await this.afresh(async (fresh) => {
      const held = (await this.readFields(table, fresh)) ?? [];
      const columns = ['id', ...held, TENANT_FIELD];
      const values = columns.map((column) => (column === 'id' ? document.id : (document[column] ?? null)));
      const placeholders = values.map((_, at) => `$${at + 1}`);
      const sets = columns
        .filter((column) => column !== 'id')
        .map((column) => `"${column}" = EXCLUDED."${column}"`)
        .join(', ');
      await pool.query(
        `INSERT INTO "${table}"(${quoted(columns)}) VALUES (${placeholders.join(', ')}) ON CONFLICT ("id", (coalesce("${TENANT_FIELD}", ''))) DO UPDATE SET ${sets}`,
        values,
      );
    });
  }

  /**
   * Gone from the index; a document that was never there is gone already, and a collection never ensured holds
   * nothing — as does a name the index cannot hold. With a tenant scope only that tenant's document goes; without
   * one, every tenant's document under that key does; core names the tenant of a tenant-owned row's removal (appSearchRuntime.ts).
   */
  async remove(collection: string, id: string, scope?: SearchScope): Promise<void> {
    if (!isIdentifier(collection) || Buffer.byteLength(collection) > MAX_COLLECTION_BYTES) return;
    if (!(await this.readFields(collection))) return;
    const pool = await this.db();
    if (scope?.field === TENANT_FIELD)
      await pool.query(`DELETE FROM "${collection}" WHERE "id" = $1 AND "${TENANT_FIELD}" = $2`, [id, scope.value]);
    else await pool.query(`DELETE FROM "${collection}" WHERE "id" = $1`, [id]);
  }

  /** The keys of the best matches for `phrase` across `fields`, best first, at most `limit`; a collection never indexed matches nothing, and neither does a name the index cannot hold. */
  async search(collection: string, phrase: string, fields: readonly string[], limit: number, scope?: SearchScope): Promise<string[]> {
    if (limit <= 0 || !isIdentifier(collection)) return [];
    try {
      const table = collectionTable(collection, this.collectionPrefix);
      return await this.afresh((fresh) => this.ask(table, phrase, fields, limit, scope, fresh));
    } catch (error) {
      throw new SearchUnavailable(`search "${collection}" could not be asked: ${(error as Error).message}`);
    }
  }

  private async ask(
    table: string,
    phrase: string,
    fields: readonly string[],
    limit: number,
    scope: SearchScope | undefined,
    fresh: boolean,
  ): Promise<string[]> {
    let held = await this.readFields(table, fresh);
    if (!held) return [];
    /* Another process may have widened the table since this one read it: a field asked and not held is
       looked for in the catalog once before it is left out. */
    if (!fresh && fields.some((field) => isIdentifier(field) && !held!.includes(field)))
      held = (await this.readFields(table, true)) ?? held;
    const asked = fields.filter((field) => isIdentifier(field) && held.includes(field));
    if (!asked.length) return [];
    const query = tsqueryOf(phrase);
    if (!query) return [];
    const params: unknown[] = [query];
    let where = `(${asked.map((field) => `"${vectorColumn(field)}" @@ to_tsquery('${TEXT_CONFIG}', $1)`).join(' OR ')})`;
    if (scope) {
      if (!isIdentifier(scope.field)) return [];
      if (scope.field !== TENANT_FIELD && !held.includes(scope.field)) return [];
      params.push(scope.value);
      where += ` AND "${scope.field}" = $${params.length}`;
    }
    /* Asked-order weights, as the SQLite pack's are: an earlier asked
       field weighs more, and a field the search did not ask weighs
       nothing, so it cannot lift a match. */
    const rank = asked
      .map((field, at) => `${asked.length - at} * ts_rank("${vectorColumn(field)}", to_tsquery('${TEXT_CONFIG}', $1))`)
      .join(' + ');
    params.push(Math.floor(limit));
    const pool = await this.db();
    const { rows } = await pool.query(
      `SELECT "id" FROM "${table}" WHERE ${where} ORDER BY (${rank}) DESC, "id" ASC LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => String(row.id));
  }

  /** Runs `run`; a statement that meets an undefined column ran against a stale field list, so it runs once more on a fresh one. */
  private async afresh<T>(run: (fresh: boolean) => Promise<T>): Promise<T> {
    try {
      return await run(false);
    } catch (error) {
      if ((error as { code?: string }).code !== '42703') throw error;
      return run(true);
    }
  }

  /** The searchable fields a table holds: the process's cache, or the catalog when `fresh` or not yet read; undefined when the table is not there (never cached, so a table another process creates is seen). */
  private async readFields(table: string, fresh = false): Promise<string[] | undefined> {
    const cached = this.fields.get(table);
    if (cached && !fresh) return cached;
    const found = await this.catalogFields(await this.db(), table);
    if (found) this.fields.set(table, found);
    else this.fields.delete(table);
    return found;
  }

  /** The searchable fields a table holds, from the catalog. Text columns only, so a vector column never reads as a field. */
  private async catalogFields(db: PgQueryable, table: string): Promise<string[] | undefined> {
    const { rows } = await db.query(
      `SELECT a.attname AS name, format_type(a.atttypid, NULL) AS type FROM pg_attribute a ` +
        `JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace ` +
        `WHERE c.relname = $1 AND n.nspname = current_schema() AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [table],
    );
    if (!rows.length) return undefined;
    return rows.filter((row) => row.type === 'text' && row.name !== 'id' && row.name !== TENANT_FIELD).map((row) => String(row.name));
  }
}
