/**
 * The schema as a coding agent reads it: one line per table, no prose.
 *
 *   task(id* int, title text, status text {open|done}, owner_id int? → person)
 *
 * `*` marks a primary-key column, `?` a nullable one, `{a|b}` the values the
 * database declares (an enum, a CHECK … IN), `→ table` a foreign key. Types
 * are the family an author writes against (int, num, text, bool, date, ts),
 * not the database's own spelling. `mistri schema --brief` prints it; the
 * markdown export stays for people, this is for a context window.
 */
import type { ColumnMeta, DatabaseSchema, TableMeta } from '@mistriwork/engine/shared/schema.js';
import { isRuntimeTable, RUNTIME_SCHEMA } from '@mistriwork/engine/shared/runtimeTables.js';

const isStoreTable = (table: TableMeta): boolean => isRuntimeTable(table.name) || table.schema === RUNTIME_SCHEMA;

/** The short family of a database type; an unfamiliar one is kept as written, lowercased. */
export function briefType(type: string): string {
  const t = type.toLowerCase().trim();
  if (/^bool|^tinyint\(1\)/.test(t)) return 'bool';
  if (/^((tiny|small|medium|big)?int(eger)?|(small|big)?serial)\b/.test(t)) return 'int';
  if (/^(numeric|decimal|real|double|float|money|number)/.test(t)) return 'num';
  if (/^(timestamp|datetime)/.test(t)) return 'ts';
  if (/^date$/.test(t)) return 'date';
  if (t.startsWith('time')) return 'time';
  if (/^(char|varchar|character|text|tinytext|mediumtext|longtext|citext|string|nvarchar|nchar|clob)/.test(t)) return 'text';
  if (/^(json|jsonb)/.test(t)) return 'json';
  if (/^(blob|bytea|binary|varbinary)/.test(t)) return 'bytes';
  if (t.startsWith('enum')) return 'text';
  return t.replace(/\s+/g, ' ');
}

const column = (c: ColumnMeta, name: (table: string) => string): string => {
  const parts = [`${c.name}${c.primaryKey ? '*' : ''}`, c.flag ? 'bool' : briefType(c.type)];
  let text = `${parts[0]} ${parts[1]}${c.nullable && !c.primaryKey ? '?' : ''}`;
  if (c.allowed?.length && !c.flag) text += ` {${c.allowed.join('|')}}`;
  if (c.references) text += ` → ${name(c.references.table)}`;
  return text;
};

/** The table's name as the brief says it: bare, unless two tables share it across schemas. */
function namer(tables: readonly TableMeta[]): (id: string) => string {
  const byId = new Map(tables.map((table) => [table.id, table]));
  const counts = new Map<string, number>();
  for (const table of tables) counts.set(table.name, (counts.get(table.name) ?? 0) + 1);
  return (id) => {
    const table = byId.get(id);
    return !table || (counts.get(table.name) ?? 0) > 1 ? id : table.name;
  };
}

/**
 * The mistri store tables (`__mistri_*`: journals, outboxes, the sign-in store) a database that has served an
 * App holds are the platform's, not the App's: ~40% of a brief on one, and nothing an author writes against. They are
 * left out and counted; `all` brings them back.
 */
export function toBrief(schema: DatabaseSchema, opts: { all?: boolean } = {}): string {
  const name = namer(schema.tables);
  const shown = opts.all ? schema.tables : schema.tables.filter((table) => !isStoreTable(table));
  const hidden = schema.tables.length - shown.length;
  const lines = [
    `${schema.label} (${schema.dialect}): ${shown.length} tables${hidden ? ` (${hidden} platform store tables hidden)` : ''}. * pk, ? nullable, {…} allowed values, → foreign key`,
  ];
  for (const table of [...shown].sort((a, b) => name(a.id).localeCompare(name(b.id)))) {
    /* A foreign key the column list does not carry (a composite one) still gets said. */
    const carried = new Set(table.columns.filter((c) => c.references).map((c) => c.name));
    const extra = schema.foreignKeys
      .filter((fk) => fk.from.table === table.id && !fk.from.columns.every((c) => carried.has(c)))
      .map((fk) => `${fk.from.columns.join('+')} → ${name(fk.to.table)}`);
    lines.push(`${name(table.id)}${table.isView ? ' (view)' : ''}(${[...table.columns.map((c) => column(c, name)), ...extra].join(', ')})`);
  }
  return lines.join('\n');
}
