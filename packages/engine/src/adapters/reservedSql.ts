/**
 * The guard a caller can put in front of raw SQL: a statement that touches
 * tablewalk's own runtime tables (the `__mistri_` prefix on every engine, and
 * PostgreSQL's runtime schema, shared/runtimeTables.ts) is refused before it
 * runs. The MCP `sql` and `explain` tools ask for it.
 *
 * This file is the lexical half, and it is conservative on purpose. It reads
 * every identifier, quoted or not, every string and every comment, and
 * refuses when one of them spells a reserved name — a string can become a
 * relation through a cast. It refuses the constructs that reach a relation whose name is
 * only computed when the statement runs (regclass casts, the functions that
 * run SQL text they are handed), and escapes it will not decode, because a
 * guard that cannot read a statement should not wave it through. The engine
 * half lives in the adapters: SQLite's authorizer and Postgres's plan both
 * name the relations a statement actually reads, views and search_path
 * included, which no reading of the text can.
 *
 * Not a sandbox. A function the database's own users wrote reads what its
 * owner may; the database role is the boundary for that.
 */
import { isRuntimeTable, RUNTIME_SCHEMA, RUNTIME_TABLE_PREFIXES } from '../shared/runtimeTables.js';
import type { DatabaseSchema } from '../shared/schema.js';
import { looksWrappable, Refusal, trimStatement } from './adapter.js';
import type { PgQuery } from './postgresPool.js';

type Dialect = DatabaseSchema['dialect'];

/* PostgreSQL keeps every runtime table, sign-in's included, in one schema
   (shared/runtimeTables.ts): never listed, not even when `--schema` names it,
   and refused as a generic write target. The prefix rule cannot say this,
   because the tables inside are named plainly (`command`, `auth_user`); the
   schema does. The name is the engine's, not an import of a store: the engine
   hides it in a database the browser opens with no App framework installed. */
export const RESERVED_SCHEMAS: readonly string[] = [RUNTIME_SCHEMA];

/** Whether a relation, as the engine names it, is tablewalk's own. */
export function isReservedRelation(schema: string | undefined, name: string): boolean {
  return isRuntimeTable(name) || (schema !== undefined && RESERVED_SCHEMAS.includes(schema.toLowerCase()));
}

/** The refusal for a statement found to touch `name`, by whichever half found it. */
export function reservedRefusal(name: string): Refusal {
  return new Refusal(
    `This statement touches "${name}", one of the runtime or sign-in tables ` +
      `(the reserved ${RUNTIME_TABLE_PREFIXES.join(' and ')} prefix and the ${RESERVED_SCHEMAS.join(', ')} schema), which raw SQL here does not read.`,
  );
}

/* Postgres names that reach a relation only when the statement runs: a
   regclass cast turns any text or number into a table, and these functions
   run the SQL text, or read the relation, they are handed. `table_to_xml`
   takes a bare oid, so there is not even a name to read. */
const COMPUTED_RELATION = /^(?:regclass|to_regclass|\w*_to_xml\w*|ts_stat|dblink\w*|crosstab\d*|connectby|get_raw_page)$/i;

interface Token {
  kind: 'word' | 'quoted' | 'text';
  value: string;
}

/**
 * The statement's words, quoted identifiers and texts (strings, dollar
 * bodies, comments), in order — or the reason it cannot be read.
 */
function tokenize(sql: string, dialect: Dialect): Token[] | string {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;
  /* A quoted run with its closing character doubled as the escape. A
     backslash escape (Postgres's E'…') can only make the run longer when read
     as one, which the text check still reads. */
  const quoted = (close: string, backslash: boolean): string => {
    let value = '';
    i += 1;
    while (i < n) {
      const ch = sql[i];
      if (backslash && ch === '\\' && i + 1 < n) {
        value += sql[i + 1];
        i += 2;
        continue;
      }
      if (ch === close && sql[i + 1] === close) {
        value += close;
        i += 2;
        continue;
      }
      if (ch === close) {
        i += 1;
        break;
      }
      value += ch;
      i += 1;
    }
    return value;
  };
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      tokens.push({ kind: 'text', value: sql.slice(i, end < 0 ? n : end) });
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      /* Postgres nests block comments; the others end at the first close. */
      let depth = 0;
      const start = i;
      while (i < n) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
          continue;
        }
        if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
          if (depth === 0 || dialect !== 'postgres') break;
          continue;
        }
        i += 1;
      }
      tokens.push({ kind: 'text', value: sql.slice(start, i) });
      continue;
    }
    if (ch === '$' && dialect === 'postgres') {
      const tag = /^\$[A-Za-z_]\w*\$|^\$\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        tokens.push({ kind: 'text', value: sql.slice(i + tag.length, end < 0 ? n : end) });
        i = end < 0 ? n : end + tag.length;
        continue;
      }
    }
    if (dialect === 'postgres' && /^u&["']/i.test(sql.slice(i, i + 3))) {
      /* A Unicode-escaped identifier or string spells a name in code points
         this check does not decode; one without escapes reads as it is. */
      i += 2;
      const close = sql[i];
      const value = quoted(close, false);
      if (value.includes('\\') || /^\s*uescape\b/i.test(sql.slice(i))) {
        return (
          'This statement spells a name with Unicode escapes (U&"…"), which the reserved-table check does not decode, ' +
          'so it is refused rather than run. Spell the name plainly.'
        );
      }
      tokens.push({ kind: close === '"' ? 'quoted' : 'text', value });
      continue;
    }
    if (ch === "'") {
      /* E'…' is Postgres's backslash-escaped string. */
      const escaped = dialect === 'postgres' && /[eE]$/.test(sql.slice(Math.max(0, i - 1), i));
      tokens.push({ kind: 'text', value: quoted("'", escaped) });
      continue;
    }
    if (ch === '"') {
      tokens.push({ kind: 'quoted', value: quoted('"', false) });
      continue;
    }
    if (ch === '`' && dialect !== 'postgres') {
      tokens.push({ kind: 'quoted', value: quoted('`', false) });
      continue;
    }
    if (ch === '[' && dialect === 'sqlite') {
      tokens.push({ kind: 'quoted', value: quoted(']', false) });
      continue;
    }
    const word = /^[A-Za-z_-￿][\w$-￿]*/.exec(sql.slice(i))?.[0];
    if (word) {
      tokens.push({ kind: 'word', value: word });
      i += word.length;
      continue;
    }
    i += 1;
  }
  return tokens;
}

// A match in text (a comment, a string)
// takes the rest of the name, so the refusal names the table, not the prefix.
const RESERVED_TEXT = new RegExp(`(?:${RUNTIME_TABLE_PREFIXES.join('|')})[\\w$]*|\\b(?:${RESERVED_SCHEMAS.join('|')})\\b`, 'i');

/**
 * Why this statement must not run under the guard, or null when nothing in
 * its text reaches a reserved relation.
 */
export function reservedInText(sql: string, dialect: Dialect): string | null {
  const tokens = tokenize(sql, dialect);
  if (typeof tokens === 'string') return tokens;
  for (const token of tokens) {
    if (token.kind === 'text') {
      const found = RESERVED_TEXT.exec(token.value);
      if (found) return reservedRefusal(found[0]).message;
      continue;
    }
    const name = token.value;
    if (isRuntimeTable(name) || (dialect === 'postgres' && RESERVED_SCHEMAS.includes(name.toLowerCase()))) {
      return reservedRefusal(name).message;
    }
    if (dialect === 'postgres' && COMPUTED_RELATION.test(name)) {
      return (
        `This statement uses ${name}, which reaches a relation by a name computed when it runs, so it is refused ` +
        `rather than run: raw SQL here does not read the runtime or sign-in tables, and a name ` +
        'that is not written down cannot be checked.'
      );
    }
  }
  return null;
}

/** @throws Refusal when the statement's text reaches a reserved relation. */
export function refuseReservedText(sql: string, dialect: Dialect): void {
  const reason = reservedInText(sql, dialect);
  if (reason) throw new Refusal(reason);
}

/**
 * The Postgres check before a statement is given a connection: its text,
 * and for a read, whether the planner can list what it reads — the engine
 * half below needs a plan, so a statement the planner cannot explain is
 * refused rather than run unchecked.
 */
export function refusePostgresReserved(sql: string, write = false): void {
  refuseReservedText(sql, 'postgres');
  if (!write && !looksWrappable(sql)) {
    throw new Refusal(
      "The reserved-table check reads the planner's list of what a statement scans, so it " +
        'runs the statements the planner can explain: SELECT, WITH, TABLE and VALUES.',
    );
  }
}

/**
 * The Postgres engine half: the planner's own list of what a statement
 * scans, read inside the transaction it will run in, so views, search_path
 * and CTEs resolve as they will there.
 */
export async function refuseReservedPlan(db: PgQuery, sql: string, params: unknown[]): Promise<void> {
  /* On the extended protocol even with no parameters: on the simple one,
     Postgres would run a statement stacked behind the EXPLAIN before any
     plan came back to read. */
  const planned = await db.query({
    text: `EXPLAIN (VERBOSE, FORMAT JSON) ${trimStatement(sql)}`,
    values: params,
    rowMode: 'array',
    queryMode: 'extended',
  });
  const found = reservedInPlan(planned.rows[0]?.[0]);
  if (found) throw reservedRefusal(found);
}

/**
 * The first reserved relation a Postgres `EXPLAIN (VERBOSE, FORMAT JSON)`
 * plan reads. The plan is the planner's list of what the statement will
 * actually scan — views expanded, search_path resolved, CTEs and subqueries
 * included. What a function reads by a computed name is not in it; the
 * lexical half refuses those functions by name.
 */
export function reservedInPlan(plan: unknown): string | null {
  if (Array.isArray(plan)) {
    for (const item of plan) {
      const found = reservedInPlan(item);
      if (found) return found;
    }
    return null;
  }
  if (!plan || typeof plan !== 'object') return null;
  const node = plan as Record<string, unknown>;
  const relation = node['Relation Name'];
  const schema = typeof node.Schema === 'string' ? node.Schema : undefined;
  if (typeof relation === 'string' && isReservedRelation(schema, relation)) {
    return schema ? `${schema}.${relation}` : relation;
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const found = reservedInPlan(value);
      if (found) return found;
    }
  }
  return null;
}
