/**
 * The schema as a flat list of what is in it — each table, column,
 * constraint, index, view, trigger and enum, keyed by name, with its
 * definition as the engine prints it — so two readings compare as maps.
 *
 * That is what drift is: the live schema against the one migrations left.
 * The one they left is recorded in the database after every run (a row per
 * history table in `__mistri_schema_snapshot`), because a migration's
 * effect cannot be known from its text and a file beside the migrations
 * would be one environment's truth checked into every environment's
 * repository. `baseline` writes the first reading beside the migrations as
 * well, read-only, as the record of what the database was when tablewalk
 * started owning its changes.
 *
 * Scoped to the schemas the run is given (the App's sources, the
 * connection's "schemas", --schema), never tablewalk's own reserved tables
 * or sign-in schema, which tablewalk upgrades whatever a baseline says, and
 * never the history table itself.
 */
import { isRuntimeTable } from '../../shared/runtimeTables.js';
import { RESERVED_SCHEMAS } from '../../adapters/reservedSql.js';
import type { MigrationDb } from './database.js';
import { qualified } from './history.js';

export type Objects = Record<string, string>;

const SNAPSHOT_TABLE = '__mistri_schema_snapshot';

/* A plain name stays plain; one with a dot, a space, a capital or a quote is
   quoted, so a key never reads as a different path. */
const q = (name: string) => (/^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);
const squash = (sql: string | null | undefined) => (sql ?? '').replace(/\s+/g, ' ').trim();

export async function readSchema(db: MigrationDb, scope: readonly string[], history: string): Promise<Objects> {
  const skip = (table: string) => isRuntimeTable(table) || table === history;
  if (db.dialect === 'sqlite') return readSqlite(db, skip);
  const schemas = [...new Set(scope.length ? scope : [db.home!])].filter((schema) => !RESERVED_SCHEMAS.includes(schema.toLowerCase()));
  return readPostgres(db, schemas, skip);
}

async function readSqlite(db: MigrationDb, skip: (table: string) => boolean): Promise<Objects> {
  const out: Objects = {};
  const master = await db.all<{ type: string; name: string; tbl_name: string; sql: string | null }>(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  for (const object of master) {
    if (skip(object.tbl_name)) continue;
    if (object.type === 'view') out[`view ${q(object.name)}`] = squash(object.sql);
    if (object.type === 'trigger') out[`trigger ${q(object.tbl_name)}.${q(object.name)}`] = squash(object.sql);
    if (object.type === 'index' && object.sql) out[`index ${q(object.tbl_name)}.${q(object.name)}`] = squash(object.sql);
    if (object.type !== 'table') continue;
    const table = q(object.name);
    out[`table ${table}`] = /\bWITHOUT\s+ROWID\s*$/i.test(squash(object.sql)) ? 'table without rowid' : 'table';
    for (const column of await db.all<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
      hidden: number;
    }>('SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?)', [object.name])) {
      out[`column ${table}.${q(column.name)}`] = [
        column.type || 'any',
        column.notnull ? 'not null' : '',
        column.dflt_value !== null ? `default ${column.dflt_value}` : '',
        column.pk ? 'primary key' : '',
        column.hidden >= 2 ? 'generated' : '',
      ]
        .filter(Boolean)
        .join(' ');
    }
    const keys = new Map<number, { parent: string; from: string[]; to: string[]; rule: string }>();
    for (const fk of await db.all<{ id: number; table: string; from: string; to: string | null; on_update: string; on_delete: string }>(
      'SELECT id, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq',
      [object.name],
    )) {
      const key = keys.get(fk.id) ?? {
        parent: fk.table,
        from: [],
        to: [],
        rule: `on update ${fk.on_update.toLowerCase()} on delete ${fk.on_delete.toLowerCase()}`,
      };
      key.from.push(fk.from);
      if (fk.to) key.to.push(fk.to);
      keys.set(fk.id, key);
    }
    for (const key of keys.values()) {
      out[`foreign key ${table}(${key.from.map(q).join(', ')})`] =
        `references ${q(key.parent)}${key.to.length ? `(${key.to.map(q).join(', ')})` : ''} ${key.rule}`;
    }
    for (const index of await db.all<{ name: string; origin: string }>('SELECT name, origin FROM pragma_index_list(?)', [object.name])) {
      if (index.origin !== 'u') continue;
      const columns = await db.all<{ name: string | null }>('SELECT name FROM pragma_index_info(?) ORDER BY seqno', [index.name]);
      out[`unique ${table}(${columns.map((column) => q(column.name ?? '<expression>')).join(', ')})`] = 'unique';
    }
  }
  return out;
}

async function readPostgres(db: MigrationDb, schemas: string[], skip: (table: string) => boolean): Promise<Objects> {
  const out: Objects = {};
  /* The definitions as pg_get_*def prints them, with every name qualified:
     read with an empty search path, so a reading never depends on the path
     the session happened to have. */
  const [{ path }] = await db.all<{ path: string }>("SELECT current_setting('search_path') AS path");
  await db.run("SELECT set_config('search_path', 'pg_catalog', false)");
  try {
    const where = 'n.nspname = ANY(?::text[])';
    const name = (schema: string, relation: string) => `${q(schema)}.${q(relation)}`;
    for (const row of await db.all<{ s: string; t: string; k: string }>(
      `SELECT n.nspname AS s, c.relname AS t, c.relkind AS k FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${where} AND c.relkind IN ('r', 'p', 'f')`,
      [schemas],
    )) {
      if (!skip(row.t))
        out[`table ${name(row.s, row.t)}`] = row.k === 'p' ? 'partitioned table' : row.k === 'f' ? 'foreign table' : 'table';
    }
    for (const row of await db.all<{
      s: string;
      t: string;
      c: string;
      ty: string;
      nn: boolean;
      df: string | null;
      id: string;
      gen: string;
    }>(
      `SELECT n.nspname AS s, c.relname AS t, a.attname AS c, format_type(a.atttypid, a.atttypmod) AS ty, a.attnotnull AS nn,
              pg_get_expr(d.adbin, d.adrelid) AS df, a.attidentity AS id, a.attgenerated AS gen
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE ${where} AND c.relkind IN ('r', 'p', 'f') AND a.attnum > 0 AND NOT a.attisdropped`,
      [schemas],
    )) {
      if (skip(row.t)) continue;
      out[`column ${name(row.s, row.t)}.${q(row.c)}`] = [
        row.ty,
        row.nn ? 'not null' : '',
        row.gen === 's' ? `generated always as ${row.df}` : row.df !== null ? `default ${row.df}` : '',
        row.id === 'a' ? 'generated always as identity' : row.id === 'd' ? 'generated by default as identity' : '',
      ]
        .filter(Boolean)
        .join(' ');
    }
    for (const row of await db.all<{ s: string; t: string; name: string; def: string }>(
      `SELECT n.nspname AS s, c.relname AS t, co.conname AS name, pg_get_constraintdef(co.oid, true) AS def
       FROM pg_constraint co JOIN pg_class c ON c.oid = co.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${where} AND co.contype IN ('p', 'u', 'f', 'c', 'x')`,
      [schemas],
    )) {
      if (!skip(row.t)) out[`constraint ${name(row.s, row.t)}.${q(row.name)}`] = row.def;
    }
    // An index a constraint owns is said by the constraint.
    for (const row of await db.all<{ s: string; t: string; name: string; def: string }>(
      `SELECT n.nspname AS s, t.relname AS t, i.relname AS name, pg_get_indexdef(i.oid) AS def
       FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace n ON n.oid = i.relnamespace
       WHERE ${where} AND NOT EXISTS (SELECT 1 FROM pg_constraint co WHERE co.conindid = x.indexrelid AND co.contype IN ('p', 'u', 'x'))`,
      [schemas],
    )) {
      if (!skip(row.t)) out[`index ${name(row.s, row.t)}.${q(row.name)}`] = row.def;
    }
    for (const row of await db.all<{ s: string; v: string; k: string; def: string }>(
      `SELECT n.nspname AS s, c.relname AS v, c.relkind AS k, pg_get_viewdef(c.oid, true) AS def
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${where} AND c.relkind IN ('v', 'm')`,
      [schemas],
    )) {
      if (!skip(row.v)) out[`${row.k === 'm' ? 'materialized view' : 'view'} ${name(row.s, row.v)}`] = squash(row.def);
    }
    for (const row of await db.all<{ s: string; t: string; name: string; def: string }>(
      `SELECT n.nspname AS s, c.relname AS t, tg.tgname AS name, pg_get_triggerdef(tg.oid, true) AS def
       FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${where} AND NOT tg.tgisinternal`,
      [schemas],
    )) {
      if (!skip(row.t)) out[`trigger ${name(row.s, row.t)}.${q(row.name)}`] = row.def;
    }
    for (const row of await db.all<{ s: string; t: string; labels: string }>(
      `SELECT n.nspname AS s, t.typname AS t, string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) AS labels
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE ${where} GROUP BY n.nspname, t.typname`,
      [schemas],
    )) {
      out[`enum ${name(row.s, row.t)}`] = `(${row.labels})`;
    }
  } finally {
    await db.run("SELECT set_config('search_path', ?, false)", [path]);
  }
  return out;
}

export interface Change {
  readonly key: string;
  readonly was?: string;
  readonly now?: string;
}

/** What differs between the schema migrations left and the one there now. A new or dropped table is one line, not one per column. */
export function drift(expected: Objects, live: Objects): Change[] {
  const changes: Change[] = [];
  for (const key of [...new Set([...Object.keys(expected), ...Object.keys(live)])].sort()) {
    if (expected[key] !== live[key])
      changes.push({
        key,
        ...(expected[key] !== undefined ? { was: expected[key] } : {}),
        ...(live[key] !== undefined ? { now: live[key] } : {}),
      });
  }
  const whole = new Set(
    changes
      .filter((change) => change.key.startsWith('table ') && (change.was === undefined || change.now === undefined))
      .map((change) => change.key.slice(6)),
  );
  return changes.filter((change) => {
    const owner =
      /^(?:column|constraint|index|trigger) (.+)\.[^.]+$/.exec(change.key)?.[1] ??
      /^(?:foreign key|unique) ([^(]+)\(/.exec(change.key)?.[1];
    return !(owner !== undefined && whole.has(owner) && !change.key.startsWith('table '));
  });
}

export function sayChange(change: Change): string {
  if (change.was === undefined) return `+ ${change.key}  ${change.now}  (added outside migrations)`;
  if (change.now === undefined) return `- ${change.key}  (dropped outside migrations)`;
  return `~ ${change.key}  ${change.was} → ${change.now}  (changed outside migrations)`;
}

/**
 * The schema to record after a run: what the database is now, except where
 * it had drifted before the run and the run left that alone — that stays
 * drift, so a run never quietly blesses a column someone added by hand. A
 * migration that changed the drifted object (putting it back, or altering
 * it) settles it, and so does one that names it: adopting a hand-made column
 * is `ADD COLUMN IF NOT EXISTS note`, which changes nothing here and makes
 * the column everywhere else. `applied` is the text of the files the run
 * applied.
 */
export function carryForward(expected: Objects, before: Objects, after: Objects, applied: readonly string[] = []): Objects {
  const next: Objects = { ...after };
  const texts = applied.map((text) => text.toLowerCase());
  for (const key of new Set([...Object.keys(expected), ...Object.keys(before)])) {
    if (expected[key] === before[key] || after[key] !== before[key]) continue;
    if (named(key, texts)) continue;
    if (expected[key] === undefined) delete next[key];
    else next[key] = expected[key];
  }
  return next;
}

/* Whether a migration's text names the object a key is about: its own name,
   and for a column or a key its table's too. Words, not SQL: a name inside a
   comment counts, which errs toward settling what a person wrote about. */
function named(key: string, texts: readonly string[]): boolean {
  const kind = /^(foreign key|unique|materialized view|[a-z]+) /.exec(key)?.[1] ?? '';
  const idents = [...key.slice(kind.length + 1).matchAll(/"((?:[^"]|"")*)"|([^."(),\s]+)/g)].map((match) =>
    (match[1] ?? match[2]).replace(/""/g, '"').toLowerCase(),
  );
  const wanted = kind === 'column' ? idents.slice(-2) : kind === 'foreign key' || kind === 'unique' ? idents : idents.slice(-1);
  const word = (name: string) => new RegExp(`(^|[^a-z0-9_$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_$])`);
  return texts.some((text) => wanted.every((name) => word(name).test(text)));
}

export interface StoredSnapshot {
  readonly rank: number;
  readonly takenOn: string;
  readonly objects: Objects;
}

export async function readSnapshot(db: MigrationDb, history: string): Promise<StoredSnapshot | undefined> {
  const exists =
    db.dialect === 'sqlite'
      ? await db.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [SNAPSHOT_TABLE])
      : db.dialect === 'postgres'
        ? await db.all('SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = ? AND tablename = ?', [db.home, SNAPSHOT_TABLE])
        : [];
  if (!exists.length) return undefined;
  const [row] = await db.all<{ installed_rank: number; taken_on: string; objects: string }>(
    `SELECT installed_rank, taken_on, objects FROM ${qualified(db, SNAPSHOT_TABLE)} WHERE history_table = ?`,
    [history],
  );
  return row ? { rank: Number(row.installed_rank), takenOn: row.taken_on, objects: JSON.parse(row.objects) as Objects } : undefined;
}

export async function writeSnapshot(db: MigrationDb, history: string, rank: number, objects: Objects): Promise<void> {
  const table = qualified(db, SNAPSHOT_TABLE);
  await db.run(
    `CREATE TABLE IF NOT EXISTS ${table} (history_table TEXT NOT NULL PRIMARY KEY, installed_rank INT NOT NULL, taken_on VARCHAR(32) NOT NULL, objects TEXT NOT NULL)`,
  );
  // One statement, so two runs finishing together cannot both find the row gone and both insert it.
  const upsert =
    'ON CONFLICT (history_table) DO UPDATE SET installed_rank = excluded.installed_rank, taken_on = excluded.taken_on, objects = excluded.objects';
  await db.run(`INSERT INTO ${table} (history_table, installed_rank, taken_on, objects) VALUES (?, ?, ?, ?) ${upsert}`, [
    history,
    rank,
    new Date().toISOString().replace('T', ' ').slice(0, 19),
    JSON.stringify(sorted(objects)),
  ]);
}

export const sorted = (objects: Objects): Objects =>
  Object.fromEntries(Object.entries(objects).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
