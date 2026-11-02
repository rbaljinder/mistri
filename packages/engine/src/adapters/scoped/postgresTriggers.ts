/**
 * A PostgreSQL trigger read from the catalog: the writes that fire it, and
 * whether it is validation-only (scopeTriggers.ts).
 *
 * Which writes fire it is the catalog's own answer: `tgtype` says INSERT,
 * UPDATE and DELETE, `tgattr` the `UPDATE OF` columns. A WHEN clause narrows
 * when it fires, never which writes may; a trigger with one still counts.
 *
 * Validation-only has to be proven of the function the trigger runs, and
 * PostgreSQL keeps a PL/pgSQL body only as text (`prosrc`). The proof has two
 * halves, and only the first is read here:
 *
 * - the statements, by a grammar, which is narrow: the trigger FOR EACH ROW,
 *   not a constraint trigger (a deferred one runs at COMMIT, past every
 *   check), no transition tables; the function LANGUAGE plpgsql, no SECURITY
 *   DEFINER, no SET clause, no arguments, and a body that is exactly
 *
 *       BEGIN
 *         IF <condition> THEN RAISE EXCEPTION '<literal>' [USING …]; END IF; …
 *         RETURN NEW;
 *       END
 *
 *   with IF/ELSIF/ELSE nesting, `RAISE [EXCEPTION] '<literal>' [USING <option>
 *   = '<literal>', …]`, `NULL;` and one RETURN (NEW for a BEFORE INSERT or
 *   UPDATE, OLD for a BEFORE DELETE, any of NEW, OLD or NULL after). No
 *   DECLARE, no assignment (writing NEW is writing the row, past the checks
 *   on what the write set), no PERFORM, EXECUTE, SELECT, INSERT, UPDATE or
 *   DELETE.
 * - the conditions, by PostgreSQL. Which function an operator, a call or an
 *   implicit cast runs is chosen by argument types, against every function,
 *   operator and cast the database holds, under the session's search_path:
 *   re-implementing that in JavaScript is how a review found `NEW.n <U+00A0>
 *   lower(…)`, an implicit cast of a literal through someone's function, and
 *   citext's `<` refusing a trigger on an integer. So each condition is
 *   handed, exactly as PL/pgSQL would cut it from the body, to PostgreSQL
 *   itself — in a temporary view selecting it over the trigger's table as
 *   `"new"` and `"old"`, made and dropped inside a savepoint on the very
 *   session that will write — and the expression tree it stores is judged as
 *   a WHEN clause's stored tree (`tgqual`) is: node kinds that cannot read a
 *   table, coerce through a type's own code or run a domain's checks; every
 *   function and operator immutable and either the database's own (an oid
 *   below FirstNormalObjectId) or C a superuser installed (an extension's,
 *   such as citext's); a boolean result.
 *
 *   What the view sees differs from what PL/pgSQL runs in two ways, both
 *   chosen: a string literal becomes NULL and TG_OP `(NULL::text)`. Both
 *   resolve as the literal does — an untyped constant, chosen by the type of
 *   what it meets — but NULL runs no type input function while the view is
 *   made, so nothing in a domain's CHECK runs on the writer to prove it. The
 *   lexer that cuts the conditions is PostgreSQL's to the character (its six
 *   whitespace characters, its comments, its quoting), and anything it does
 *   not read the same way — a character past ASCII outside a literal, a `$`, a
 *   backslash string, a cast, a subscript — is not proven: those are the
 *   places where a different reading would hide a call (`::` is refused
 *   because a cast of a literal names a type whose input runs at parse time,
 *   where NULL would run none).
 *
 * The keyed-effect grammar (docs/trigger-effects.md) adds these statements,
 * each with a schema-qualified table — an unqualified one resolves through the
 * search_path the function runs with, where a schema the caller controls (or
 * pg_temp, searched first for tables) could put a table of the same name:
 *
 *     UPDATE <schema>.<table> SET <column> = <expression>, … WHERE <key> = NEW.<column> [AND …];
 *     INSERT INTO <schema>.<table> (<column>, …) VALUES (<expression>, …);
 *     DELETE FROM <schema>.<table> WHERE <key> = OLD.<column> [AND …];
 *
 * and, in an IF's condition, a keyed read `(SELECT <column> FROM
 * <schema>.<table> WHERE <key> = NEW.<column> …)`. Their shape — which table,
 * which key, which columns — is read here; every expression in them is
 * PostgreSQL's to judge, in the same view as the conditions and by the same
 * rules. A keyed read goes in as itself; an update's key and each of its
 * values as a scalar subquery over the table it names, so that a bare name is
 * that table's column, as it is in the statement. One rule is added: a value
 * that is not a bare literal has the column's type, or reaches it by a cast
 * of the database's own or a binary one, since an assignment cast runs the
 * cast's function. CURRENT_DATE, CURRENT_TIMESTAMP and LOCALTIMESTAMP are
 * keywords, not functions a search_path could shadow, and go in as a NULL of
 * their type.
 *
 * The verdict is only as old as what it was made from. A function can be
 * replaced without a lock on the table (CREATE OR REPLACE FUNCTION), and a new
 * function, operator or cast can change what a condition resolves to. So the
 * proof keeps the versions it was made from — the trigger function's row
 * version, and those of every function, operator and cast a user made — and a
 * transaction that relied on it reads them again before COMMIT
 * (attestPostgresTriggers): anything changed while the write ran refuses it.
 */
import { createHash } from 'node:crypto';
import type { PgQuery } from '../postgresPool.js';
import {
  PLAIN,
  plainDefinition,
  type EffectRef,
  type EffectTerm,
  type ScopeTrigger,
  type TriggerEffect,
  type TriggerEvent,
} from './scopeTriggers.js';

/** Oids below this are the database's own (FirstNormalObjectId): made by initdb, never by a user. */
const FIRST_NORMAL_OID = 16384;

/*
 * The operators the proof's own catalog reads compare by, named in pg_catalog. An operator is found through the
 * search_path like a table is, and one of the same argument types in a schema ahead of pg_catalog wins: with
 * `public, pg_catalog`, `CREATE OPERATOR public.= (leftarg = oid, rightarg = oid, function = oidne)` would turn
 * every `=` here into its opposite. The key operators the proof accepts are judged by what they are, not their
 * name (keyOperators below); these are the proof's own. Functions and types here are named in pg_catalog too.
 */
const EQ = 'OPERATOR(pg_catalog.=)';
const NE = 'OPERATOR(pg_catalog.<>)';
const LT = 'OPERATOR(pg_catalog.<)';
const GT = 'OPERATOR(pg_catalog.>)';
const PLUS = 'OPERATOR(pg_catalog.+)';
export const CATALOG_OPERATORS = { EQ, NE, LT, GT, PLUS } as const;
/** B-tree's access method (pg_am.dat): fixed by the server's source, the same in every database. */
const BTREE = '403::pg_catalog.oid';

/**
 * A type with its domains unwrapped, and the type modifier of the last one that has one (a domain over varchar(3)
 * compares as varchar(3)), as a subquery of `(type, typmod)` over the type and modifier expressions given.
 */
export const baseType = (type: string, typmod: string) => `(WITH RECURSIVE d(type, typmod, depth) AS (
         SELECT ${type}, ${typmod}, 0
         UNION ALL
         SELECT t.typbasetype, CASE WHEN t.typtypmod ${NE} -1 THEN t.typtypmod ELSE d.typmod END, d.depth ${PLUS} 1
           FROM d JOIN pg_catalog.pg_type t ON t.oid ${EQ} d.type WHERE t.typtype ${EQ} 'd' AND d.depth ${LT} 32)
       SELECT d.type, d.typmod FROM d ORDER BY depth DESC LIMIT 1)`;

/**
 * The default B-tree operator class of a (base) type, as a scalar subquery: its own, or the one class a binary cast
 * from it (varchar to text), an enum or an array reaches; NULL where there is none or more than one. What an index
 * of the type is built with unless it says otherwise, and so what its equality means.
 */
export const defaultBtreeClass = (type: string) => `(SELECT coalesce(
         (SELECT oc.oid FROM pg_catalog.pg_opclass oc
           WHERE oc.opcmethod ${EQ} ${BTREE} AND oc.opcdefault AND oc.opcintype ${EQ} ${type}),
         (SELECT pg_catalog.min(oc.oid) FROM pg_catalog.pg_opclass oc JOIN pg_catalog.pg_type bt ON bt.oid ${EQ} ${type}
           WHERE oc.opcmethod ${EQ} ${BTREE} AND oc.opcdefault
             AND (EXISTS (SELECT 1 FROM pg_catalog.pg_cast c
                           WHERE c.castsource ${EQ} ${type} AND c.casttarget ${EQ} oc.opcintype AND c.castmethod ${EQ} 'b')
                  OR (oc.opcintype ${EQ} 'pg_catalog.anyenum'::pg_catalog.regtype AND bt.typtype ${EQ} 'e')
                  OR (oc.opcintype ${EQ} 'pg_catalog.anyarray'::pg_catalog.regtype AND bt.typcategory ${EQ} 'A'))
          HAVING pg_catalog.count(*) ${EQ} 1)))`;

/** One row of {@link postgresTriggerStatement}. */
export interface PostgresTriggerRow {
  schema: string;
  table: string;
  /** The trigger's own relation, quoted for SQL: where its conditions are parsed. */
  relation: string;
  name: string;
  type: number;
  columns: string[];
  listed: number;
  generated: boolean;
  constraint: boolean;
  transition: boolean;
  qual: string;
  language: string;
  kind: string;
  definer: boolean;
  configured: boolean;
  arguments: number;
  source: string;
  version: string;
  around: string;
}

/*
 * Every function, operator and type the catalog reads below name is named in pg_catalog, as the proof's own reads
 * are (EQ above): one of those the search_path finds first can be anyone's. An exact signature in pg_catalog wins
 * over the search_path only where pg_catalog is searched first, and a polymorphic one (cardinality(anyarray),
 * array_agg(anynonarray), to_jsonb(anyelement), format(text, VARIADIC "any"), anyarray || anyarray) loses to an
 * exact one anywhere on the path: `CREATE FUNCTION public.cardinality(text[])` by a role with nothing but CREATE on
 * public made every table's triggers read as none, and a scoped write fire them unproven.
 */
const CAT = 'OPERATOR(pg_catalog.||)';
const NOT_LIKE = 'OPERATOR(pg_catalog.!~)';
const GE = 'OPERATOR(pg_catalog.>=)';
const JSON_TEXT = 'OPERATOR(pg_catalog.->>)';

/** The versions of everything a user made that decides what a condition resolves to: functions, operators, casts. */
const AROUND = `(SELECT pg_catalog.md5(coalesce(pg_catalog.string_agg(f.oid::pg_catalog.text ${CAT} ':' ${CAT} f.xmin::pg_catalog.text, ',' ORDER BY f.oid), ''))
          FROM pg_catalog.pg_proc f WHERE f.oid ${GE} ${FIRST_NORMAL_OID}::pg_catalog.oid)
       ${CAT} (SELECT pg_catalog.md5(coalesce(pg_catalog.string_agg(o.oid::pg_catalog.text ${CAT} ':' ${CAT} o.xmin::pg_catalog.text, ',' ORDER BY o.oid), ''))
          FROM pg_catalog.pg_operator o WHERE o.oid ${GE} ${FIRST_NORMAL_OID}::pg_catalog.oid)
       ${CAT} (SELECT pg_catalog.md5(coalesce(pg_catalog.string_agg(k.oid::pg_catalog.text ${CAT} ':' ${CAT} k.xmin::pg_catalog.text, ',' ORDER BY k.oid), ''))
          FROM pg_catalog.pg_cast k WHERE k.oid ${GE} ${FIRST_NORMAL_OID}::pg_catalog.oid)`;

/**
 * The relations a write to `root` (an oid expression) may reach, itself first: its partitions and inheritance
 * children, to any depth. A write through a partitioned table lands in a leaf, and an update or delete through an
 * inheritance parent reaches its children's rows; each fires its own triggers.
 */
const tree = (root: string) => `WITH RECURSIVE tree(relid) AS (
         SELECT ${root} UNION SELECT i.inhrelid FROM tree JOIN pg_catalog.pg_inherits i ON i.inhparent ${EQ} tree.relid)`;

/**
 * Whether trigger `t` is one of a write to `root`'s own, rather than a clone a partition keeps of a trigger on a
 * relation in the same tree (`tgparentid`, PostgreSQL 13 and later; earlier, clones are internal), which is
 * judged once, where it was made. Read through to_jsonb so a server without the column reads none.
 */
const own = (t: string) =>
  `NOT ${t}.tgisinternal AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger parent
     WHERE parent.oid ${EQ} coalesce((pg_catalog.to_jsonb(${t}) ${JSON_TEXT} 'tgparentid')::pg_catalog.oid, 0::pg_catalog.oid)
       AND parent.tgrelid ${EQ} ANY (SELECT relid FROM tree))`;

/** A trigger's name as a refusal says it: its own, or `relation.name` when it is on a partition or child. */
const named = (t: string, root: string, relation: string) =>
  `CASE WHEN ${t}.tgrelid ${EQ} ${root} THEN ${t}.tgname::pg_catalog.text ELSE ${relation}.relname::pg_catalog.text ${CAT} '.' ${CAT} ${t}.tgname::pg_catalog.text END`;

/** The names of the triggers a write to `root` (an oid expression) may fire, sorted: what the scope catalog's facts count. */
export const postgresTreeTriggerNames = (root: string): string => `(${tree(root)}
  SELECT coalesce(pg_catalog.array_agg(fired.name ORDER BY fired.name), '{}'::pg_catalog.text[]) FROM (
    SELECT ${named('t', root, 'k')} AS name FROM tree
      JOIN pg_catalog.pg_trigger t ON t.tgrelid ${EQ} tree.relid JOIN pg_catalog.pg_class k ON k.oid ${EQ} t.tgrelid
     WHERE ${own('t')}) AS fired)`;

/**
 * Every user trigger a write to a table may fire, with what the proof reads: the table's own and each of its
 * partitions' and children's, keyed by the table written. `wanted` reads those of the tables named by `$1`
 * (schemas) and `$2` (names); otherwise every ordinary or partitioned table outside the system's schemas, with no
 * parameters (for `mistri check`).
 */
export function postgresTriggerStatement(wanted: boolean): string {
  const filter = wanted
    ? `EXISTS (SELECT 1 FROM ROWS FROM (pg_catalog.unnest($1::pg_catalog.text[]), pg_catalog.unnest($2::pg_catalog.text[])) AS w(schema, name)
                WHERE n.nspname ${EQ} w.schema AND r.relname ${EQ} w.name)`
    : `r.relkind ${EQ} ANY (ARRAY['r', 'p']::pg_catalog."char"[])
       AND n.nspname::pg_catalog.text ${NE} ALL (ARRAY['pg_catalog', 'information_schema']::pg_catalog.text[])
       AND n.nspname::pg_catalog.text ${NOT_LIKE} '^pg_(toast_)?temp_'`;
  return `WITH around AS MATERIALIZED (SELECT ${AROUND} AS around)
SELECT n.nspname::pg_catalog.text AS schema, r.relname::pg_catalog.text AS "table",
       pg_catalog.format('%I.%I', cn.nspname, c.relname) AS relation,
       fired.name, t.tgtype::pg_catalog.int4 AS type,
       ARRAY(SELECT a.attname::pg_catalog.text FROM pg_catalog.unnest(t.tgattr::pg_catalog.int2[]) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_catalog.pg_attribute a ON a.attrelid ${EQ} c.oid AND a.attnum ${EQ} k.attnum ORDER BY k.ord) AS columns,
       pg_catalog.cardinality(t.tgattr::pg_catalog.int2[]) AS listed,
       EXISTS (SELECT 1 FROM pg_catalog.unnest(t.tgattr::pg_catalog.int2[]) AS k(attnum)
                 JOIN pg_catalog.pg_attribute a ON a.attrelid ${EQ} c.oid AND a.attnum ${EQ} k.attnum WHERE a.attgenerated ${NE} '') AS generated,
       t.tgconstraint ${NE} 0::pg_catalog.oid AS "constraint",
       (t.tgoldtable IS NOT NULL OR t.tgnewtable IS NOT NULL) AS transition,
       coalesce(t.tgqual::pg_catalog.text, '') AS qual,
       l.lanname::pg_catalog.text AS language, p.prokind::pg_catalog.text AS kind, p.prosecdef AS definer,
       p.proconfig IS NOT NULL AS configured, p.pronargs::pg_catalog.int4 AS arguments, p.prosrc AS source,
       p.oid::pg_catalog.text ${CAT} ':' ${CAT} p.xmin::pg_catalog.text AS version,
       around.around
  FROM pg_catalog.pg_class r
  JOIN pg_catalog.pg_namespace n ON n.oid ${EQ} r.relnamespace
  CROSS JOIN LATERAL (${tree('r.oid')}
    SELECT t.oid, ${named('t', 'r.oid', 'k')} AS name FROM tree
      JOIN pg_catalog.pg_trigger t ON t.tgrelid ${EQ} tree.relid JOIN pg_catalog.pg_class k ON k.oid ${EQ} t.tgrelid
     WHERE ${own('t')}) AS fired
  JOIN pg_catalog.pg_trigger t ON t.oid ${EQ} fired.oid
  JOIN pg_catalog.pg_class c ON c.oid ${EQ} t.tgrelid
  JOIN pg_catalog.pg_namespace cn ON cn.oid ${EQ} c.relnamespace
  JOIN pg_catalog.pg_proc p ON p.oid ${EQ} t.tgfoid
  JOIN pg_catalog.pg_language l ON l.oid ${EQ} p.prolang
  CROSS JOIN around
 WHERE ${filter}
 ORDER BY 1, 2, 4`;
}

/** Whether a row has the shape the statement answers; anything else is a catalog this code does not know. */
function isPostgresTriggerRow(row: unknown): row is PostgresTriggerRow {
  if (!row || typeof row !== 'object') return false;
  const r = row as Record<string, unknown>;
  const strings = ['schema', 'table', 'relation', 'name', 'qual', 'language', 'kind', 'source', 'version', 'around'];
  const booleans = ['generated', 'constraint', 'transition', 'definer', 'configured'];
  const numbers = ['type', 'listed', 'arguments'];
  return (
    strings.every((key) => typeof r[key] === 'string') &&
    booleans.every((key) => typeof r[key] === 'boolean') &&
    numbers.every((key) => Number.isInteger(r[key])) &&
    Array.isArray(r.columns) &&
    r.columns.every((column) => typeof column === 'string')
  );
}

/** What a trigger's proof was made from: changes to any of it change this. */
const triggerVersion = (row: PostgresTriggerRow): string => `${row.name}=${row.version}/${row.around}`;

// pg_trigger.tgtype bits (catalog/pg_trigger.h).
const ROW = 1 << 0;
const BEFORE = 1 << 1;
const INSERT = 1 << 2;
const DELETE = 1 << 3;
const UPDATE = 1 << 4;
const INSTEAD = 1 << 6;

/** The expression nodes a condition may hold: nothing that reads a table, coerces through a type's own code or runs a domain's checks. */
const EXPRESSION_NODES = new Set([
  'OPEXPR',
  'VAR',
  'CONST',
  'BOOLEXPR',
  'NULLTEST',
  'BOOLEANTEST',
  'RELABELTYPE',
  'SCALARARRAYOPEXPR',
  'DISTINCTEXPR',
  'NULLIFEXPR',
  'CASEEXPR',
  'CASEWHEN',
  'CASETESTEXPR',
  'COALESCEEXPR',
  'FUNCEXPR',
  'ARRAYEXPR',
]);
/** What the view selecting the conditions adds around them: one query over the trigger's table twice. */
const VIEW_NODES = new Set([
  ...EXPRESSION_NODES,
  'QUERY',
  'RANGETBLENTRY',
  'ALIAS',
  'RTEPERMISSIONINFO',
  'FROMEXPR',
  'RANGETBLREF',
  'TARGETENTRY',
]);
/**
 * What one key equality, alone in a scalar subquery over its table, may parse to: the view and the subquery around
 * it, the operator, the two columns, the subquery's `true`, and a relabel (a domain to its base type, varchar to
 * text), which changes no value. A cast or a conversion of either side (`char(3)` to text drops trailing spaces,
 * int8 to float8 rounds) would compare a value other than the one the proof reads the row by.
 */
const KEY_NODES = new Set([
  'QUERY',
  'RANGETBLENTRY',
  'ALIAS',
  'RTEPERMISSIONINFO',
  'FROMEXPR',
  'RANGETBLREF',
  'TARGETENTRY',
  'SUBLINK',
  'OPEXPR',
  'VAR',
  'CONST',
  'RELABELTYPE',
]);
const KEY_CAST = "a key of it compares through a cast or a conversion of one side: a key's two sides must be columns of the same type";
const KEY_OPERATOR =
  "a key of it compares by an operator that is not its column's own equality (the equality of the type's default B-tree operator class): an `=` found first on the search_path can be any function";
/** The fields of a stored tree that name code it runs: a function, or an operator (whose function runs). */
const FUNCTION_FIELDS = new Set([':funcid', ':opfuncid', ':hashfuncid', ':negfuncid', ':aggfnoid', ':winfnoid']);

/** What a stored tree (`pg_node_tree` as text) holds, read as PostgreSQL's own reader reads it (nodes/read.c). */
interface PostgresTree {
  nodes: ReadonlyMap<string, number>;
  functions: ReadonlySet<number>;
  operators: ReadonlySet<number>;
  /** Each OPEXPR's operator, in the order the tree holds them: a key's equalities, one each, in the order parsed. */
  opexprs: readonly number[];
  /** The domains it coerces to (CoerceToDomain), whose constraints run when it does. */
  domains: ReadonlySet<number>;
  /** The types of its constants: what a literal in its place is read as. */
  constants: ReadonlySet<number>;
}

/**
 * The tokens of a stored tree, as pg_strtok cuts them: `(`, `)`, `{` and `}`
 * alone, anything else up to whitespace or one of those, a backslash taking
 * the character after it. A name inside the tree (an alias, a column) is
 * written with every such character escaped, so it can neither open a node
 * nor end one.
 */
function treeTokens(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === ' ' || char === '\n' || char === '\t') i += 1;
    else if ('(){}'.includes(char)) {
      tokens.push(char);
      i += 1;
    } else {
      let end = i;
      while (end < text.length && !' \n\t(){}'.includes(text[end])) end += text[end] === '\\' && end + 1 < text.length ? 2 : 1;
      tokens.push(text.slice(i, end));
      i = end;
    }
  }
  return tokens;
}

/** A stored tree, read structurally: every node, and the functions and operators it names. Undefined when it is not one this reader knows. */
export function readPostgresTree(text: string): PostgresTree | undefined {
  const tokens = treeTokens(text);
  let at = 0;
  const nodes = new Map<string, number>();
  const functions = new Set<number>();
  const operators = new Set<number>();
  const opexprs: number[] = [];
  const domains = new Set<number>();
  const constants = new Set<number>();
  const oid = (token: string | undefined): number => {
    if (!token || !/^[0-9]+$/.test(token)) throw new Unproven();
    return Number(token);
  };
  const value = (): void => {
    const token = tokens[at++];
    if (token === undefined || token === ')' || token === '}') throw new Unproven();
    if (token === '{') node();
    else if (token === '(') {
      while (tokens[at] !== ')') {
        if (at >= tokens.length) throw new Unproven();
        value();
      }
      at += 1;
    }
  };
  const node = (): void => {
    const name = tokens[at++];
    if (!name || !/^[A-Z_]+$/.test(name)) throw new Unproven();
    nodes.set(name, (nodes.get(name) ?? 0) + 1);
    for (;;) {
      const label = tokens[at++];
      if (label === '}') return;
      if (!label?.startsWith(':')) throw new Unproven();
      if (label === ':constvalue' && tokens[at] !== '<>') {
        // A datum: its length, then its bytes in brackets (readDatum).
        oid(tokens[at++]);
        if (tokens[at++] !== '[') throw new Unproven();
        while (tokens[at] !== ']') {
          if (at >= tokens.length || !/^-?[0-9]+$/.test(tokens[at])) throw new Unproven();
          at += 1;
        }
        at += 1;
      } else if (FUNCTION_FIELDS.has(label)) {
        const id = oid(tokens[at++]);
        if (id) functions.add(id);
      } else if (label === ':opno') {
        const id = oid(tokens[at++]);
        operators.add(id);
        if (name === 'OPEXPR') opexprs.push(id);
      } else if (label === ':opnos' && tokens[at] === '(') {
        // A row comparison's operators, an oid list: `(o 96 97)`.
        at += 1;
        if (tokens[at++] !== 'o') throw new Unproven();
        while (tokens[at] !== ')') operators.add(oid(tokens[at++]));
        at += 1;
      } else if (label === ':resulttype' && name === 'COERCETODOMAIN') domains.add(oid(tokens[at++]));
      else if (label === ':consttype' && name === 'CONST') constants.add(oid(tokens[at++]));
      else value();
    }
  };
  try {
    if (!text) return { nodes, functions, operators, opexprs, domains, constants };
    value();
    if (at !== tokens.length) return undefined;
    return { nodes, functions, operators, opexprs, domains, constants };
  } catch (error) {
    if (error instanceof Unproven) return undefined;
    throw error;
  }
}

type Token = { start: number; end: number } & (
  | { kind: 'word'; upper: string }
  | { kind: 'id' }
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'op'; text: string }
);

class Unproven extends Error {}
const fail = (): never => {
  throw new Unproven();
};

/** The operator spellings a condition may use: each one PostgreSQL's lexer also reads as one operator. */
const OPERATORS = new Set(['=', '<>', '!=', '<', '<=', '>', '>=', '+', '-', '*', '/', '%', '||']);
const OPERATOR_CHARS = '+-*/<>=~!@#%^&|`?';
/** PostgreSQL's whitespace (scan.l `space`), exactly: not Unicode's, which takes U+00A0 for a space PostgreSQL reads as a letter. */
const whitespace = (char: string) => char === ' ' || (char >= '\t' && char <= '\r');
const wide = (char: string) => char > '\x7f';

/**
 * PL/pgSQL's tokens, as PostgreSQL's lexer cuts them, as far as the grammar
 * reads them. Anything it would read differently refuses: a dollar quote or
 * any `$`, `:=` or `::`, a backslash string or one with a prefix (E'', U&'',
 * B'', X'', N''), a number running into a letter or a dot, a subscript, and
 * a character past ASCII outside a literal or quoted name — each a place
 * where a different reading would hide a token.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const start = i;
    if (whitespace(char)) {
      i += 1;
    } else if (source.startsWith('--', i)) {
      // A line comment ends at either newline character (scan.l `non_newline`).
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i += 1;
    } else if (source.startsWith('/*', i)) {
      // PostgreSQL nests block comments; one that holds another is refused rather than matched.
      const end = source.indexOf('*/', i + 2);
      if (end === -1 || source.slice(i + 2, end).includes('/*')) return fail();
      i = end + 2;
    } else if (char === "'") {
      let end = i + 1;
      for (;;) {
        if (end >= source.length) return fail();
        if (source[end] === "'") {
          if (source[end + 1] === "'") {
            end += 2;
            continue;
          }
          break;
        }
        // Where a backslash string ends depends on standard_conforming_strings: refused, not guessed.
        if (source[end] === '\\') return fail();
        end += 1;
      }
      i = end + 1;
      tokens.push({ kind: 'string', start, end: i });
    } else if (char === '"') {
      let end = i + 1;
      for (;;) {
        if (end >= source.length) return fail();
        if (source[end] === '"') {
          if (source[end + 1] === '"') {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      i = end + 1;
      tokens.push({ kind: 'id', start, end: i });
    } else if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const match = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(source.slice(i))!;
      i += match[0].length;
      // `0x1F`, `1_000`, `1..2`: PostgreSQL's readings of these vary by version.
      if (i < source.length && /[A-Za-z_0-9.]/.test(source[i])) return fail();
      tokens.push({ kind: 'number', start, end: i });
    } else if (/[A-Za-z_]/.test(char)) {
      let end = i + 1;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end])) end += 1;
      // A letter past ASCII or a `$` continues the name for PostgreSQL; `E'…'`, `U&'…'`, `B'…'` are strings with their own rules.
      if (end < source.length && (wide(source[end]) || "$'&".includes(source[end]))) return fail();
      tokens.push({ kind: 'word', upper: source.slice(i, end).toUpperCase(), start, end });
      i = end;
    } else if (OPERATOR_CHARS.includes(char)) {
      // The whole run of operator characters, as PostgreSQL's lexer takes it, must be one operator spelled here.
      let end = i;
      while (end < source.length && OPERATOR_CHARS.includes(source[end]) && !source.startsWith('--', end) && !source.startsWith('/*', end))
        end += 1;
      const text = source.slice(i, end);
      if (!OPERATORS.has(text)) return fail();
      tokens.push({ kind: 'op', text, start, end });
      i = end;
    } else if ('(),;.'.includes(char)) {
      tokens.push({ kind: 'op', text: char, start, end: i + 1 });
      i += 1;
    } else {
      // `$`, `:`, `[`, a character past ASCII, and anything else.
      return fail();
    }
  }
  return tokens;
}

class Cursor {
  at = 0;
  /** Each condition, as the SQL handed to PostgreSQL to parse; a keyed write's key is one too. */
  readonly conditions: string[] = [];
  readonly effects: TriggerEffect[] = [];
  /** Each value a keyed write gives that is not a bare literal, as SQL to parse, with the column it is assigned to. */
  readonly values: Array<{ sql: string; relation: string; column: string }> = [];
  /** How many scalar subqueries the conditions and values hold: each a keyed read's or a keyed write's own. */
  sublinks = 0;
  /** Each equality of each key, alone, as a scalar subquery over its table: parsed apart, so its tree is its own. */
  readonly keys: string[] = [];
  /** For each of `keys`, the table and the key column it compares. */
  readonly keyColumns: Array<{ relation: string; column: string }> = [];
  constructor(
    readonly tokens: readonly Token[],
    readonly source: string,
  ) {}
  word(offset = 0): string | undefined {
    const token = this.tokens[this.at + offset];
    return token?.kind === 'word' ? token.upper : undefined;
  }
  op(offset = 0): string | undefined {
    const token = this.tokens[this.at + offset];
    return token?.kind === 'op' ? token.text : undefined;
  }
  take(): Token {
    return this.tokens[this.at++] ?? fail();
  }
  expectWord(word: string): void {
    if (this.word() !== word) fail();
    this.at += 1;
  }
  expectOp(op: string): void {
    if (this.op() !== op) fail();
    this.at += 1;
  }
  text(token: Token): string {
    return this.source.slice(token.start, token.end);
  }
  /** An identifier as PostgreSQL names it: a bare word folded to lower case, a quoted one exactly. */
  name(): string {
    const token = this.take();
    if (token.kind === 'word') return this.text(token).toLowerCase();
    if (token.kind === 'id') return this.text(token).slice(1, -1).replace(/""/g, '"');
    return fail();
  }
}

/**
 * One condition, cut where PL/pgSQL cuts it (pl_gram.y read_sql_construct):
 * at the first THEN outside every parenthesis — a CASE's THEN included, which
 * PL/pgSQL reads as the IF's, so a CASE in a condition has to be in
 * parentheses — and noted on the cursor as the SQL PostgreSQL will parse.
 * Only what the parse cannot be trusted with is refused here: the row whole
 * (`NEW`) rather than a column of it, a column's own field (`NEW.c.f`), a
 * cast, a qualified name. Everything else — which operator, which function,
 * whether it reads a table — is PostgreSQL's to say.
 */
function condition(cursor: Cursor): void {
  cursor.conditions.push(cut(cursor, (at) => at.word() === 'THEN', 'condition'));
}

/**
 * One expression as the SQL PostgreSQL is to parse in its place, up to the
 * first token `stop` accepts outside every parenthesis. In a condition, a
 * keyed read goes in as itself; in a write's value, the clock keywords go in
 * as a NULL of their type, and a function variable of PL/pgSQL's other than
 * NEW, OLD and TG_OP, or a subquery, is refused.
 */
function cut(cursor: Cursor, stop: (cursor: Cursor) => boolean, as: 'condition' | 'value'): string {
  let depth = 0;
  const parts: string[] = [];
  for (;;) {
    if (cursor.at >= cursor.tokens.length) fail();
    if (!depth && parts.length && stop(cursor)) break;
    const token = cursor.take();
    const text = cursor.source.slice(token.start, token.end);
    if (token.kind === 'string') {
      parts.push('NULL');
    } else if (token.kind === 'number' || token.kind === 'id') {
      parts.push(text);
    } else if (token.kind === 'op') {
      if (token.text === '(' && as === 'condition' && cursor.word() === 'SELECT') {
        parts.push(keyedRead(cursor));
        continue;
      }
      if (token.text === '(') depth += 1;
      else if (token.text === ')' && --depth < 0) fail();
      else if (token.text === '.' || token.text === ';') fail();
      parts.push(text);
    } else if (token.upper === 'NEW' || token.upper === 'OLD') {
      cursor.expectOp('.');
      const column = cursor.take();
      // `NEW.then` is a column to SQL and the end of the condition to PL/pgSQL's lexer: not guessed.
      if (column.kind === 'word' && column.upper === 'THEN') fail();
      if (column.kind !== 'word' && column.kind !== 'id') fail();
      // `NEW.col.field` reads into a composite through its type's own code.
      if (cursor.op() === '.') fail();
      parts.push(`"${token.upper.toLowerCase()}".${cursor.source.slice(column.start, column.end)}`);
    } else if (token.upper === 'TG_OP') {
      parts.push('(NULL::pg_catalog.text)');
    } else if (token.upper === 'CAST') {
      // A literal cast to a type runs that type's input function when the condition is parsed: refused, as `::` is.
      fail();
    } else if (as === 'value' && CLOCK.has(token.upper) && cursor.op() !== '(') {
      parts.push(CLOCK.get(token.upper)!);
    } else if (as === 'value' && (token.upper === 'SELECT' || token.upper === 'FOUND' || token.upper.startsWith('TG_'))) {
      fail();
    } else {
      parts.push(text);
    }
  }
  if (depth) fail();
  return parts.join(' ');
}

/** The clock keywords a write's value may give, each as the NULL of its type PostgreSQL parses in its place. */
const CLOCK = new Map([
  ['CURRENT_DATE', '(NULL::pg_catalog.date)'],
  ['CURRENT_TIMESTAMP', '(NULL::pg_catalog.timestamptz)'],
  ['LOCALTIMESTAMP', '(NULL::pg_catalog."timestamp")'],
]);
/** Words a bare key column can never be: SQL's own, and the names PL/pgSQL gives a trigger function's variables. */
const NOT_COLUMNS = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'NULL',
  'TRUE',
  'FALSE',
  'NEW',
  'OLD',
  'FOUND',
  'SET',
  'VALUES',
]);

/** A keyed effect's table, `<schema>.<table>` (an unqualified name would resolve through the function's search_path): its name and its SQL. */
function effectTable(cursor: Cursor): { name: string; sql: string } {
  const start = cursor.tokens[cursor.at] ?? fail();
  const schema = cursor.name();
  cursor.expectOp('.');
  const table = cursor.name();
  if (cursor.op() === '.') fail();
  return { name: `${schema}.${table}`, sql: `ONLY ${cursor.source.slice(start.start, cursor.tokens[cursor.at - 1].end)}` };
}

/** `<column> = NEW.<column>` (either way round), joined by AND, up to a token `end` accepts: the key, and its SQL. */
function keyEqualities(
  cursor: Cursor,
  { name: table, sql: relation }: { name: string; sql: string },
  end: (cursor: Cursor) => boolean,
): { key: Record<string, EffectRef>; sql: string } {
  const key: Record<string, EffectRef> = {};
  const parts: string[] = [];
  const bare = table.slice(table.indexOf('.') + 1);
  const side = (): { value: string | EffectRef; sql: string } => {
    const word = cursor.word();
    if ((word === 'NEW' || word === 'OLD') && cursor.op(1) === '.') {
      cursor.at += 2;
      const column = cursor.take();
      if (column.kind !== 'word' && column.kind !== 'id') fail();
      if (cursor.op() === '.') fail();
      const text = cursor.text(column);
      // NEW's columns as PL/pgSQL names them: a bare word folded, a quoted one exact.
      const name = column.kind === 'word' ? text.toLowerCase() : text.slice(1, -1).replace(/""/g, '"');
      return { value: { row: word === 'NEW' ? 'new' : 'old', column: name }, sql: `"${word.toLowerCase()}".${text}` };
    }
    const start = cursor.tokens[cursor.at] ?? fail();
    const first = cursor.name();
    if (cursor.op() !== '.') {
      // A bare key column is never one of PL/pgSQL's own variables, which would shadow it.
      if (first.toUpperCase().startsWith('TG_') || NOT_COLUMNS.has(first.toUpperCase())) fail();
      return { value: first, sql: cursor.text(start) };
    }
    // `account.id`: the target itself, never another table.
    if (first !== bare) fail();
    cursor.at += 1;
    const name = cursor.name();
    return { value: name, sql: cursor.source.slice(start.start, cursor.tokens[cursor.at - 1].end) };
  };
  for (;;) {
    const left = side();
    cursor.expectOp('=');
    const right = side();
    const column = typeof left.value === 'string' ? left.value : typeof right.value === 'string' ? right.value : fail();
    const ref = typeof left.value === 'string' ? right.value : left.value;
    if (typeof ref === 'string' || Object.hasOwn(key, column)) fail();
    key[column] = ref as EffectRef;
    parts.push(`${left.sql} = ${right.sql}`);
    cursor.keys.push(`(SELECT true FROM ${relation} WHERE ${left.sql} = ${right.sql})`);
    cursor.keyColumns.push({ relation: relation.slice('ONLY '.length), column });
    if (end(cursor)) return { key, sql: parts.join(' AND ') };
    cursor.expectWord('AND');
  }
}

/** `SELECT <column> FROM <schema>.<table> WHERE <key> …)`, its opening parenthesis taken: noted, and the SQL that parses in its place. */
function keyedRead(cursor: Cursor): string {
  cursor.expectWord('SELECT');
  const start = cursor.tokens[cursor.at] ?? fail();
  const read = cursor.name();
  if (cursor.op() === '.' || cursor.op() === '(') fail();
  cursor.expectWord('FROM');
  const table = effectTable(cursor);
  cursor.expectWord('WHERE');
  const { key, sql } = keyEqualities(cursor, table, (at) => at.op() === ')');
  cursor.expectOp(')');
  cursor.effects.push({ kind: 'read', table: table.name, key, values: { [read]: { literal: null } } });
  cursor.sublinks += 1;
  return `(SELECT ${cursor.text(start)} FROM ${table.sql} WHERE ${sql})`;
}

/** What a value's tokens are known to be before the trigger runs. */
function term(cursor: Cursor, tokens: readonly Token[]): EffectTerm {
  const [first, second, third] = tokens;
  const text = (token: Token) => cursor.text(token);
  if (tokens.length === 3 && first.kind === 'word' && (first.upper === 'NEW' || first.upper === 'OLD') && second.kind === 'op') {
    const column = third.kind === 'word' ? text(third).toLowerCase() : text(third).slice(1, -1).replace(/""/g, '"');
    return { row: first.upper === 'NEW' ? 'new' : 'old', column };
  }
  if (tokens.length === 1 && first.kind === 'string') return { literal: text(first).slice(1, -1).replace(/''/g, "'") };
  if (tokens.length === 1 && first.kind === 'word' && first.upper === 'NULL') return { literal: null };
  if (tokens.length === 1 && first.kind === 'number' && /^[0-9]+$/.test(text(first)) && Number.isSafeInteger(Number(text(first))))
    return { literal: Number(text(first)) };
  return { expression: true };
}

/**
 * One value a keyed write gives, cut and noted: what it is known to be. `over` is the target's SQL where a bare name
 * in the value is that table's column (an update's SET).
 */
function value(
  cursor: Cursor,
  stop: (cursor: Cursor) => boolean,
  table: { name: string; sql: string },
  column: string,
  over?: string,
): EffectTerm {
  const start = cursor.at;
  const sql = cut(cursor, stop, 'value');
  const known = term(cursor, cursor.tokens.slice(start, cursor.at));
  // A bare literal is read by the column's own type; anything else is a value of a type of its own, assigned.
  if (!('literal' in known)) {
    cursor.values.push({ sql: over ? `(SELECT (${sql}) FROM ${over})` : sql, relation: table.sql.slice('ONLY '.length), column });
    if (over) cursor.sublinks += 1;
  }
  return known;
}

/** One keyed write statement, from its first word to (not past) its semicolon. */
function keyedWrite(cursor: Cursor): TriggerEffect {
  const word = cursor.word();
  cursor.at += 1;
  if (word === 'UPDATE') {
    const table = effectTable(cursor);
    cursor.expectWord('SET');
    const values: Record<string, EffectTerm> = {};
    for (;;) {
      const column = cursor.name();
      if (Object.hasOwn(values, column) || cursor.op() === '.') fail();
      cursor.expectOp('=');
      values[column] = value(cursor, (at) => at.op() === ',' || at.word() === 'WHERE', table, column, table.sql);
      if (cursor.op() !== ',') break;
      cursor.at += 1;
    }
    cursor.expectWord('WHERE');
    const { key, sql } = keyEqualities(cursor, table, (at) => at.op() === ';');
    cursor.conditions.push(`(SELECT true FROM ${table.sql} WHERE ${sql})`);
    cursor.sublinks += 1;
    return { kind: 'update', table: table.name, key, values };
  }
  if (word === 'INSERT') {
    cursor.expectWord('INTO');
    const table = effectTable(cursor);
    cursor.expectOp('(');
    const columns = [cursor.name()];
    while (cursor.op() === ',') {
      cursor.at += 1;
      columns.push(cursor.name());
    }
    cursor.expectOp(')');
    if (new Set(columns).size !== columns.length) fail();
    cursor.expectWord('VALUES');
    cursor.expectOp('(');
    const values: Record<string, EffectTerm> = {};
    for (const [index, column] of columns.entries()) {
      if (index) cursor.expectOp(',');
      values[column] = value(cursor, (at) => at.op() === ',' || at.op() === ')', table, column);
    }
    cursor.expectOp(')');
    // One row, nothing after it: no second row, ON CONFLICT or RETURNING.
    if (cursor.op() !== ';') fail();
    return { kind: 'insert', table: table.name, values };
  }
  cursor.expectWord('FROM');
  const table = effectTable(cursor);
  cursor.expectWord('WHERE');
  const { key, sql } = keyEqualities(cursor, table, (at) => at.op() === ';');
  cursor.conditions.push(`(SELECT true FROM ${table.sql} WHERE ${sql})`);
  cursor.sublinks += 1;
  return { kind: 'delete', table: table.name, key };
}

/** The statements of a block, up to (not past) END, ELSIF, ELSEIF or ELSE. */
function statements(cursor: Cursor, returns: ReadonlySet<string>): void {
  for (;;) {
    const word = cursor.word();
    if (word === 'END' || word === 'ELSIF' || word === 'ELSEIF' || word === 'ELSE') return;
    if (word === 'IF') {
      cursor.at += 1;
      condition(cursor);
      cursor.expectWord('THEN');
      statements(cursor, returns);
      while (cursor.word() === 'ELSIF' || cursor.word() === 'ELSEIF') {
        cursor.at += 1;
        condition(cursor);
        cursor.expectWord('THEN');
        statements(cursor, returns);
      }
      if (cursor.word() === 'ELSE') {
        cursor.at += 1;
        statements(cursor, returns);
      }
      cursor.expectWord('END');
      cursor.expectWord('IF');
      cursor.expectOp(';');
    } else if (word === 'RAISE') {
      cursor.at += 1;
      if (cursor.word() === 'EXCEPTION') cursor.at += 1;
      if (cursor.take().kind !== 'string') fail();
      if (cursor.word() === 'USING') {
        cursor.at += 1;
        for (;;) {
          if (
            !['ERRCODE', 'MESSAGE', 'DETAIL', 'HINT', 'COLUMN', 'CONSTRAINT', 'DATATYPE', 'TABLE', 'SCHEMA'].includes(cursor.word() ?? '')
          )
            fail();
          cursor.at += 1;
          cursor.expectOp('=');
          if (cursor.take().kind !== 'string') fail();
          if (cursor.op() !== ',') break;
          cursor.at += 1;
        }
      }
      cursor.expectOp(';');
    } else if (word === 'RETURN') {
      cursor.at += 1;
      const value = cursor.word();
      if (!value || !returns.has(value)) fail();
      cursor.at += 1;
      cursor.expectOp(';');
    } else if (word === 'NULL') {
      cursor.at += 1;
      cursor.expectOp(';');
    } else if (word === 'UPDATE' || word === 'INSERT' || word === 'DELETE') {
      cursor.effects.push(keyedWrite(cursor));
      cursor.expectOp(';');
    } else {
      fail();
    }
  }
}

/**
 * Whether a trigger function's body is in the grammar, and if it is, its
 * conditions, each as the SQL PostgreSQL is to parse in its place (a literal
 * as NULL, TG_OP as a NULL text, NEW and OLD as the view's `"new"` and
 * `"old"`). `returns` is what its RETURN may give back.
 */
export function plpgsqlConditions(source: string, returns: ReadonlySet<string>): readonly string[] | undefined {
  const body = plpgsqlBody(source, returns);
  return body && !body.effects.length ? body.conditions : undefined;
}

/** What a trigger function's body is, read by the grammar: its conditions, and its keyed effects with what they hand PostgreSQL. */
interface PlpgsqlBody {
  conditions: readonly string[];
  effects: readonly TriggerEffect[];
  values: ReadonlyArray<{ sql: string; relation: string; column: string }>;
  sublinks: number;
  keys: readonly string[];
  keyColumns: ReadonlyArray<{ relation: string; column: string }>;
}

/** The body in the grammar, keyed effects included; undefined where it is not. */
function plpgsqlBody(source: string, returns: ReadonlySet<string>): PlpgsqlBody | undefined {
  try {
    const cursor = new Cursor(tokenize(source), source);
    cursor.expectWord('BEGIN');
    statements(cursor, returns);
    cursor.expectWord('END');
    if (cursor.op() === ';') cursor.at += 1;
    if (cursor.at !== cursor.tokens.length) fail();
    return {
      conditions: cursor.conditions,
      effects: cursor.effects,
      values: cursor.values,
      sublinks: cursor.sublinks,
      keys: cursor.keys,
      keyColumns: cursor.keyColumns,
    };
  } catch (error) {
    if (error instanceof Unproven) return undefined;
    throw error;
  }
}

/** The body as tokens, one space apart, where it tokenizes; its text where it does not. */
function normalized(source: string): string {
  try {
    return tokenize(source)
      .map((token) => (token.kind === 'word' ? token.upper : source.slice(token.start, token.end)))
      .join(' ');
  } catch {
    return source;
  }
}

/**
 * `sha256:<hex>` of what decides what the trigger does: its timing and events, its column list and WHEN, and its
 * function's language, attributes and body. Comments, spacing and keyword case never move it.
 */
function digestOf(row: PostgresTriggerRow): string {
  const definition = JSON.stringify([
    row.type,
    row.columns,
    row.constraint,
    row.transition,
    row.qual.replace(/:location -?\d+/g, ''),
    row.language,
    row.kind,
    row.definer,
    row.configured,
    row.arguments,
    normalized(row.source),
  ]);
  return `sha256:${createHash('sha256').update(`postgres\n${definition}`).digest('hex')}`;
}

/** Why a body that is not validation-only is not, from its words. */
function why(source: string): string {
  if (/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|EXECUTE|PERFORM|COPY|CALL|NOTIFY)\b/i.test(source) || /:=/.test(source))
    return 'it writes rows';
  if (/\b(SELECT|FROM|EXISTS)\b/i.test(source)) return 'it reads another table';
  return 'it runs a function mistri cannot prove writes nothing';
}

/** What PostgreSQL said of one trigger's conditions (postgresTriggerAnalyzer). */
export interface PostgresConditions {
  /** The stored tree of a view selecting them, every one in its place. */
  tree: string;
  /** Whether every one is a boolean, as PL/pgSQL's IF takes it without a cast. */
  boolean: boolean;
  /** The type of each value selected after them, when there are any (a keyed write's). */
  types?: readonly number[];
}

/** A value a keyed write assigns, by its type, to `column` of `relation` (SQL, schema-qualified). */
export interface PostgresAssignment {
  from: number;
  relation: string;
  column: string;
}

/** PostgreSQL, asked about triggers on the session that will fire them. */
export interface PostgresTriggerAnalyzer {
  /** `conditions`, then `values`, parsed over `relation` as NEW and OLD; undefined when PostgreSQL would not parse them. */
  conditions(relation: string, conditions: readonly string[], values?: readonly string[]): Promise<PostgresConditions | undefined>;
  /**
   * Of these functions and operators, each one not proven pure (`f<oid>` or `o<oid>`); of these types, each a literal
   * of which is read through a domain's input, which runs the domain's checks (`t<oid>`); of these assignments, each
   * one that would run a cast's function not proven pure, or reaches no column (`c<index>`); of these key
   * equalities, each whose operator is not its column's own equality, or whose column is not there (`k<index>`).
   */
  impure(
    functions: readonly number[],
    operators: readonly number[],
    types: readonly number[],
    assignments?: readonly PostgresAssignment[],
    keys?: readonly PostgresKeyOperator[],
  ): Promise<ReadonlySet<string>>;
}

/**
 * One equality of a trigger's key as PostgreSQL resolved it: its operator, and the key column it compares. It
 * must be the equality (strategy 3) of the default B-tree operator class of the column's type, unwrapped of its
 * domains: the equality a unique index of the column is unique by, and the one the proof reads the row with.
 */
interface PostgresKeyOperator {
  readonly operator: number;
  readonly relation: string;
  readonly column: string;
}

const SAVEPOINT = 'mistri_trigger_proof';

/**
 * Whether a value of type `w.source` is assigned to column `a` without running a function of the database's: the
 * same type, or a cast from it that is binary or runs a pure function (`pure`, over `p`), each side taken through
 * its domains to their base type. Coercing to a domain runs the domain's checks, which are the column's own code
 * (readPostgresTableCode) and judged there.
 */
const ASSIGNABLE = (pure: string) => `WITH RECURSIVE
  target(type) AS (SELECT a.atttypid UNION SELECT t.typbasetype FROM target JOIN pg_catalog.pg_type t ON t.oid ${EQ} target.type WHERE t.typtype ${EQ} 'd'),
  source(type) AS (SELECT w.source UNION SELECT t.typbasetype FROM source JOIN pg_catalog.pg_type t ON t.oid ${EQ} source.type WHERE t.typtype ${EQ} 'd')
  SELECT 1 FROM source JOIN target ON target.type ${EQ} source.type
  UNION ALL
  SELECT 1 FROM source JOIN pg_catalog.pg_cast c ON c.castsource ${EQ} source.type JOIN target ON target.type ${EQ} c.casttarget
    LEFT JOIN pg_catalog.pg_proc p ON p.oid ${EQ} c.castfunc
   WHERE c.castcontext ${EQ} ANY (ARRAY['a', 'i']::pg_catalog."char"[])
     AND (c.castmethod ${EQ} 'b' OR (c.castmethod ${EQ} 'f' AND ${pure}))`;

/**
 * The analyzer on `client`, which must be inside a transaction that may write
 * (a read-only one cannot make even a temporary view). Each parse is made and
 * undone inside a savepoint, so the transaction is left as it was, and a
 * condition PostgreSQL rejects only fails its own proof.
 */
export function postgresTriggerAnalyzer(client: PgQuery): PostgresTriggerAnalyzer {
  return {
    async conditions(relation, conditions, values = []) {
      if (!conditions.length && !values.length) return { tree: '', boolean: true };
      // Each condition on lines of its own: a comment in one could not run past it (it has none; they are cut out).
      const selected = [...conditions, ...values].map((condition, index) => `(\n${condition}\n) AS c${index}`).join(', ');
      await client.query(`SAVEPOINT ${SAVEPOINT}`);
      try {
        // Extended protocol: exactly one statement, whatever the text holds.
        await client.query({
          text: `CREATE TEMPORARY VIEW ${SAVEPOINT} AS SELECT ${selected} FROM ONLY ${relation} AS "new", ONLY ${relation} AS "old"`,
          values: [],
          queryMode: 'extended',
        });
        const read = await client.query(
          `SELECT r.ev_action::pg_catalog.text AS tree,
                  ARRAY(SELECT a.atttypid::pg_catalog.int4 FROM pg_catalog.pg_attribute a
                         WHERE a.attrelid ${EQ} r.ev_class AND a.attnum ${GT} 0 ORDER BY a.attnum) AS types
             FROM pg_catalog.pg_rewrite r WHERE r.ev_class ${EQ} 'pg_temp.${SAVEPOINT}'::pg_catalog.regclass`,
        );
        const row = read.rows[0] as { tree?: unknown; types?: unknown } | undefined;
        if (read.rows.length !== 1 || typeof row?.tree !== 'string' || !Array.isArray(row.types)) return undefined;
        if (row.types.length !== conditions.length + values.length) return undefined;
        // 16 is boolean: a condition of another type is cast to it by PL/pgSQL at run time, through a cast of anyone's.
        return {
          tree: row.tree,
          boolean: row.types.slice(0, conditions.length).every((type) => type === 16),
          ...(values.length ? { types: row.types.slice(conditions.length).map(Number) } : {}),
        };
      } catch {
        return undefined;
      } finally {
        await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
        await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      }
    },
    async impure(functions, operators, types, assignments = [], keys = []) {
      if (!functions.length && !operators.length && !types.length && !assignments.length && !keys.length) return new Set();
      // Immutable, and the database's own or C a superuser installed: an extension's (citext), never a user's PL.
      const pure = `p.provolatile ${EQ} 'i' AND p.prokind ${EQ} 'f'
        AND (p.oid ${LT} ${FIRST_NORMAL_OID}::pg_catalog.oid OR EXISTS (SELECT 1 FROM pg_catalog.pg_language g
              WHERE g.oid ${EQ} p.prolang AND g.lanname ${EQ} ANY (ARRAY['c', 'internal']::pg_catalog.name[])))`;
      /* A key column's own equality: strategy 3 of the default B-tree class of its type, between two of that type. */
      const equality = `SELECT 1 FROM ${baseType('a.atttypid', 'a.atttypmod')} AS b(type, typmod)
           JOIN pg_catalog.pg_opclass oc ON oc.oid ${EQ} ${defaultBtreeClass('b.type')}
           JOIN pg_catalog.pg_amop m ON m.amopfamily ${EQ} oc.opcfamily AND m.amopmethod ${EQ} ${BTREE}
          WHERE m.amopstrategy ${EQ} 3 AND m.amoplefttype ${EQ} oc.opcintype AND m.amoprighttype ${EQ} oc.opcintype
            AND m.amopopr ${EQ} w.operator`;
      const read = await client.query(
        `SELECT 'f' AS kind, w.oid::pg_catalog.text AS id FROM pg_catalog.unnest($1::pg_catalog.oid[]) AS w(oid)
           LEFT JOIN pg_catalog.pg_proc p ON p.oid ${EQ} w.oid WHERE p.oid IS NULL OR NOT (${pure})
         UNION ALL
         SELECT 'o', w.oid::pg_catalog.text FROM pg_catalog.unnest($2::pg_catalog.oid[]) AS w(oid)
           LEFT JOIN pg_catalog.pg_operator o ON o.oid ${EQ} w.oid
           LEFT JOIN pg_catalog.pg_proc p ON p.oid ${EQ} o.oprcode WHERE p.oid IS NULL OR NOT (${pure})
         UNION ALL
         SELECT DISTINCT 't', w.oid::pg_catalog.text FROM pg_catalog.unnest($3::pg_catalog.oid[]) AS w(oid)
          WHERE EXISTS (WITH RECURSIVE under(type) AS (SELECT w.oid UNION SELECT inner_type.oid FROM under ${TYPE_STEP('under')})
                        SELECT 1 FROM under JOIN pg_catalog.pg_type t ON t.oid ${EQ} under.type WHERE t.typtype ${EQ} 'd')
         UNION ALL
         SELECT 'c', w.i::pg_catalog.text
           FROM ROWS FROM (pg_catalog.unnest($4::pg_catalog.int4[]), pg_catalog.unnest($5::pg_catalog.oid[]), pg_catalog.unnest($6::pg_catalog.text[]), pg_catalog.unnest($7::pg_catalog.text[]))
                AS w(i, source, relation, attname)
           LEFT JOIN pg_catalog.pg_attribute a
             ON a.attrelid ${EQ} pg_catalog.to_regclass(w.relation) AND a.attname ${EQ} w.attname AND a.attnum ${GT} 0 AND NOT a.attisdropped
          WHERE a.attrelid IS NULL OR NOT EXISTS (${ASSIGNABLE(pure)})
         UNION ALL
         SELECT 'k', w.i::pg_catalog.text
           FROM ROWS FROM (pg_catalog.unnest($8::pg_catalog.int4[]), pg_catalog.unnest($9::pg_catalog.oid[]), pg_catalog.unnest($10::pg_catalog.text[]), pg_catalog.unnest($11::pg_catalog.text[]))
                AS w(i, operator, relation, attname)
           LEFT JOIN pg_catalog.pg_attribute a
             ON a.attrelid ${EQ} pg_catalog.to_regclass(w.relation) AND a.attname ${EQ} w.attname AND a.attnum ${GT} 0 AND NOT a.attisdropped
          WHERE a.attrelid IS NULL OR NOT EXISTS (${equality})`,
        [
          functions.map(String),
          operators.map(String),
          types.map(String),
          assignments.map((_, index) => index),
          assignments.map((assignment) => String(assignment.from)),
          assignments.map((assignment) => assignment.relation),
          assignments.map((assignment) => assignment.column),
          keys.map((_, index) => index),
          keys.map((key) => String(key.operator)),
          keys.map((key) => key.relation),
          keys.map((key) => key.column),
        ],
      );
      return new Set(read.rows.map((row) => `${String((row as { kind: unknown }).kind)}${String((row as { id: unknown }).id)}`));
    },
  };
}

/** A trigger as far as its row alone says: fired by what, and either decided or waiting on its conditions. */
type Planned =
  | { decided: ScopeTrigger }
  | {
      fired: Omit<ScopeTrigger, 'validates' | 'why'>;
      qual?: PostgresTree;
      conditions: readonly string[];
      relation: string;
      /** Where the body has keyed effects: them, what they hand PostgreSQL, and why it does more than validate. */
      keyed?: Omit<PlpgsqlBody, 'conditions'> & { why: string; plain: boolean };
    };

const RUNS = 'it runs a function mistri cannot prove writes nothing';

function plan(row: PostgresTriggerRow): Planned {
  const events: TriggerEvent[] = [];
  if (row.type & INSERT) events.push('insert');
  if (row.type & UPDATE) events.push('update');
  if (row.type & DELETE) events.push('delete');
  // A column list the catalog could not name in full, or one with a generated column, is taken as every update.
  const columns = row.listed > 0 && row.columns.length === row.listed && !row.generated ? row.columns : undefined;
  const fired = { name: row.name, events, ...(columns ? { columns } : {}), digest: digestOf(row) };
  const not = (reason: string): Planned => ({ decided: { ...fired, validates: false, why: reason } });
  if (!(row.type & ROW)) return not('it runs once per statement');
  if (row.type & INSTEAD || row.constraint || row.transition) return not('it is a kind of trigger mistri does not prove');
  const qual = row.qual ? readPostgresTree(row.qual) : undefined;
  if (row.qual && (!qual || ![...qual.nodes.keys()].every((node) => EXPRESSION_NODES.has(node))))
    return not('its WHEN runs a function mistri cannot prove writes nothing');
  if (row.language !== 'plpgsql' || row.kind !== 'f' || row.definer || row.configured || row.arguments !== 0) return not(RUNS);
  const before = Boolean(row.type & BEFORE);
  const returns = new Set(before ? (row.type & DELETE ? ['OLD'] : ['NEW']) : ['NEW', 'OLD', 'NULL']);
  // A BEFORE trigger on both deletes and inserts or updates returns OLD for one and NEW for the other: not proven.
  if (before && row.type & DELETE && row.type & (INSERT | UPDATE)) return not(RUNS);
  const body = plpgsqlBody(row.source, returns);
  if (!body) return not(why(row.source));
  const { conditions, ...keyed } = body;
  return {
    fired,
    ...(qual ? { qual } : {}),
    conditions,
    relation: row.relation,
    ...(keyed.effects.length
      ? { keyed: { ...keyed, why: why(row.source), plain: plainDefinition(row.source, tokenize(row.source), 'postgres') } }
      : {}),
  };
}

/**
 * Each trigger the rows describe, its conditions judged by PostgreSQL through
 * `analyzer`; without one (a reader that cannot make a view), a trigger with
 * conditions is not proven.
 */
async function readPostgresTriggers(
  rows: readonly PostgresTriggerRow[],
  analyzer: PostgresTriggerAnalyzer | undefined,
): Promise<ScopeTrigger[]> {
  const planned = rows.map(plan);
  // Each trigger's conditions as PostgreSQL parsed them, or why they could not be judged.
  const trees = new Map<number, PostgresTree | string>();
  // Each keyed write's value as an assignment to judge, by its index in `assignments`.
  const assignments: PostgresAssignment[] = [];
  const assigned = new Map<number, number[]>();
  for (const [index, entry] of planned.entries()) {
    if ('decided' in entry) continue;
    const values = entry.keyed?.values ?? [];
    if (!entry.conditions.length && !values.length) continue;
    const said = analyzer
      ? values.length
        ? await analyzer.conditions(
            entry.relation,
            entry.conditions,
            values.map((value) => value.sql),
          )
        : await analyzer.conditions(entry.relation, entry.conditions)
      : undefined;
    const tree = said && readPostgresTree(said.tree);
    // The scalar subqueries the grammar wrote, one for each keyed read and each keyed write's key and values: no more.
    const sublinks = entry.keyed?.sublinks ?? 0;
    trees.set(
      index,
      !analyzer
        ? 'mistri could not have PostgreSQL read its conditions'
        : !said || !tree || (values.length > 0 && said.types?.length !== values.length)
          ? 'PostgreSQL does not read a condition of it as a check of NEW and OLD alone'
          : !said.boolean
            ? 'a condition of it is not a boolean'
            : (tree.nodes.get('SUBLINK') ?? 0) !== sublinks ||
                tree.nodes.get('QUERY') !== 1 + sublinks ||
                tree.nodes.get('RANGETBLENTRY') !== 2 + sublinks
              ? 'it reads another table'
              : ![...tree.nodes.keys()].every((node) => VIEW_NODES.has(node) || (sublinks > 0 && node === 'SUBLINK'))
                ? 'a condition of it does more than compare the row'
                : tree,
    );
    const types = said?.types;
    if (types && values.length)
      assigned.set(
        index,
        values.map((value, at) => assignments.push({ from: types[at], relation: value.relation, column: value.column }) - 1),
      );
  }
  /* Each key's equalities, parsed apart from everything else, so the tree is theirs alone: one operator each between
     two columns, and nothing that converts either. The type and collation of the two columns are the catalog's to
     compare (triggerEffects.ts); this is what PostgreSQL resolved the equality to. */
  const castKeys = new Set<number>();
  const keyOperators: PostgresKeyOperator[] = [];
  const keyOwners: number[] = [];
  for (const [index, entry] of planned.entries()) {
    if ('decided' in entry || !entry.keyed?.keys.length || !analyzer) continue;
    const keys = entry.keyed.keys;
    const said = await analyzer.conditions(entry.relation, keys);
    const tree = said && readPostgresTree(said.tree);
    if (
      !said?.boolean ||
      !tree ||
      tree.nodes.get('SUBLINK') !== keys.length ||
      tree.nodes.get('QUERY') !== 1 + keys.length ||
      tree.nodes.get('RANGETBLENTRY') !== 2 + keys.length ||
      tree.nodes.get('OPEXPR') !== keys.length ||
      ![...tree.nodes.keys()].every((node) => KEY_NODES.has(node))
    ) {
      castKeys.add(index);
      continue;
    }
    /* And each equality is its column's own: `=` is whichever operator the search_path finds first, and one a
       person created in a schema ahead of pg_catalog can match any row, or none. */
    tree.opexprs.forEach((operator, at) => {
      const column = entry.keyed?.keyColumns[at];
      keyOperators.push({ operator, relation: column?.relation ?? '', column: column?.column ?? '' });
      keyOwners.push(index);
    });
  }
  const functions = new Set<number>();
  const operators = new Set<number>();
  const types = new Set<number>();
  for (const [index, entry] of planned.entries()) {
    if ('decided' in entry) continue;
    for (const tree of [entry.qual, trees.get(index)]) {
      if (!tree || typeof tree === 'string') continue;
      for (const oid of tree.functions) functions.add(oid);
      for (const oid of tree.operators) operators.add(oid);
    }
    // A WHEN's constants were read when it was made; a condition's literals are read each time PL/pgSQL parses it.
    const tree = trees.get(index);
    if (tree && typeof tree !== 'string') for (const oid of tree.constants) types.add(oid);
  }
  const impure = analyzer
    ? assignments.length || keyOperators.length
      ? await analyzer.impure([...functions], [...operators], [...types], assignments, keyOperators)
      : await analyzer.impure([...functions], [...operators], [...types])
    : undefined;
  const offKeys = new Set(keyOwners.filter((_, at) => impure?.has(`k${at}`)));
  return planned.map((entry, index) => {
    if ('decided' in entry) return entry.decided;
    // A keyed trigger's expressions are its writes' values and keys as well as its conditions.
    const not = (reason: string): ScopeTrigger => ({
      ...entry.fired,
      validates: false,
      why: entry.keyed ? reason.replace('a condition of it', 'an expression of it') : reason,
    });
    const pure = (tree: PostgresTree) =>
      impure !== undefined &&
      [...tree.functions].every((oid) => !impure.has(`f${oid}`)) &&
      [...tree.operators].every((oid) => !impure.has(`o${oid}`));
    if (entry.qual && !pure(entry.qual)) return not('its WHEN runs a function mistri cannot prove writes nothing');
    const tree = trees.get(index);
    if (typeof tree === 'string') return not(tree);
    if (tree && !pure(tree)) return not('a condition of it runs a function mistri cannot prove writes nothing');
    /* `NEW.codes = '{zz}'` on an array of a domain reads the literal through the domain's input, which runs its
       checks, every time PL/pgSQL parses the condition — though the view, given NULL, ran none. */
    if (tree && [...tree.constants].some((oid) => impure?.has(`t${oid}`)))
      return not("a literal in a condition of it is read as a domain's value, which runs the domain's checks");
    if (!entry.keyed) return { ...entry.fired, validates: true };
    if ((assigned.get(index) ?? []).some((at) => impure?.has(`c${at}`)))
      return not("a value it writes is not of its column's type, and no cast mistri can prove writes nothing makes it one");
    return {
      ...entry.fired,
      validates: false,
      why: entry.keyed.why,
      effects: entry.keyed.effects,
      ...(castKeys.has(index)
        ? { unaccepted: KEY_CAST }
        : offKeys.has(index)
          ? { unaccepted: KEY_OPERATOR }
          : entry.keyed.plain
            ? {}
            : { unaccepted: PLAIN }),
    };
  });
}

/**
 * Each table's triggers, keyed `schema.name`, from the statement's rows, and
 * what each table's proof was read from. Throws on a row of an unknown shape.
 */
export async function postgresTriggersByTable(
  rows: readonly unknown[],
  analyzer: PostgresTriggerAnalyzer | undefined,
): Promise<Map<string, { triggers: ScopeTrigger[]; version: string }>> {
  if (!rows.every(isPostgresTriggerRow)) throw new Error('A trigger row of an unknown shape.');
  const triggers = await readPostgresTriggers(rows, analyzer);
  const result = new Map<string, { triggers: ScopeTrigger[]; version: string }>();
  for (const [index, row] of rows.entries()) {
    const key = `${row.schema}.${row.table}`;
    const entry = result.get(key) ?? { triggers: [], version: '' };
    entry.triggers.push(triggers[index]);
    entry.version += `${entry.version ? ';' : ''}${triggerVersion(row)}`;
    result.set(key, entry);
  }
  return result;
}

/** What each table's proof was read from, keyed `schema.name`, without proving anything again: what an attestation compares. */
export function postgresTriggerVersions(rows: readonly unknown[]): Map<string, string> {
  if (!rows.every(isPostgresTriggerRow)) throw new Error('A trigger row of an unknown shape.');
  const result = new Map<string, string>();
  for (const row of rows) {
    const key = `${row.schema}.${row.table}`;
    const version = result.get(key);
    result.set(key, `${version ? `${version};` : ''}${triggerVersion(row)}`);
  }
  return result;
}

/* ---------- Code a write runs without a trigger ---------- */

/*
 * A write runs a table's code that is not a trigger: a column's default on an
 * insert, a CHECK constraint, a generated column, an expression index or
 * partial index, an exclusion constraint's operators, a partition key's
 * expressions, and the constraints and default of every domain a value is
 * coerced to — a column's type, through arrays, composites, ranges and
 * domains over domains, or a domain an expression casts to. Any of it may
 * call a function, and a function of the database's (PL/pgSQL, SQL) reads and
 * writes whatever its body says, under the writer's privileges, past every
 * row policy: a CHECK that returns whether a hidden row exists says so by
 * refusing. So a scoped write that runs a function the database's own code
 * did not ship, or a C function a superuser installed, is refused as a
 * trigger that is not validation-only is, naming the constraint, default or
 * domain and the function. A few functions of PostgreSQL's own run a query
 * given as text (query_to_xml, table_to_xml, ts_stat …): those count as the
 * database's too.
 *
 * Nothing here changes under the pin but a domain: ALTER DOMAIN ... ADD
 * CONSTRAINT NOT VALID and SET DEFAULT take no lock on the tables using it, so
 * one committed while a transaction runs is seen by the next.
 */

/** One row of {@link postgresTableCodeStatement}: an expression a write to `schema.table` may run. */
interface PostgresCodeRow {
  schema: string;
  table: string;
  /** As a refusal names it: `CHECK constraint`, `default of column`, `domain` … */
  kind: string;
  name: string;
  /** The column whose writes run it (a domain's); null when every write of `events` does. */
  column: string | null;
  /** `i` insert, `u` update. */
  events: string;
  trees: string[];
  operators: string[];
}

/**
 * One step into a type (`from`.type) toward the types its values hold: a domain's base type, an array's element, a
 * composite's fields, a range's subtype, a multirange's range. A value is read through each one's input in turn.
 */
const TYPE_STEP = (from: string) => `JOIN pg_catalog.pg_type t ON t.oid ${EQ} ${from}.type
    CROSS JOIN LATERAL (
      SELECT t.typbasetype WHERE t.typtype ${EQ} 'd'
      UNION ALL SELECT t.typelem WHERE t.typcategory ${EQ} 'A' AND t.typelem ${NE} 0
      UNION ALL SELECT a.atttypid FROM pg_catalog.pg_attribute a
                 WHERE t.typtype ${EQ} 'c' AND a.attrelid ${EQ} t.typrelid AND a.attnum ${GT} 0 AND NOT a.attisdropped
      UNION ALL SELECT g.rngsubtype FROM pg_catalog.pg_range g WHERE g.rngtypid ${EQ} t.oid
      UNION ALL SELECT g.rngtypid FROM pg_catalog.pg_range g WHERE g.rngmultitypid ${EQ} t.oid) AS inner_type(oid)`;

/** The relations a write to each wanted table reaches, and the types every column of them holds, to any depth. */
const CODE_TYPES = `wanted AS (
  SELECT r.oid AS root, n.nspname::pg_catalog.text AS schema, r.relname::pg_catalog.text AS "table"
    FROM pg_catalog.pg_class r JOIN pg_catalog.pg_namespace n ON n.oid ${EQ} r.relnamespace
   WHERE EXISTS (SELECT 1 FROM ROWS FROM (pg_catalog.unnest($1::pg_catalog.text[]), pg_catalog.unnest($2::pg_catalog.text[])) AS w(schema, name)
                  WHERE n.nspname ${EQ} w.schema AND r.relname ${EQ} w.name)),
tree(root, relid) AS (
  SELECT root, root FROM wanted
  UNION SELECT tree.root, i.inhrelid FROM tree JOIN pg_catalog.pg_inherits i ON i.inhparent ${EQ} tree.relid),
typed(root, name, type) AS (
  SELECT tree.root, a.attname::pg_catalog.text, a.atttypid FROM tree
    JOIN pg_catalog.pg_attribute a ON a.attrelid ${EQ} tree.relid AND a.attnum ${GT} 0 AND NOT a.attisdropped
  UNION
  SELECT typed.root, typed.name, inner_type.oid FROM typed ${TYPE_STEP('typed')})`;

const NO_TEXTS = `'{}'::pg_catalog.text[]`;

/** A domain's constraints and default, the expressions coercing to it runs. */
const domainCode = (from: string, column: string) => `
  SELECT ${from}, 'domain' AS kind, pg_catalog.format('%I.%I', tn.nspname, t.typname) AS name, ${column} AS "column", 'iu' AS events,
         ARRAY(SELECT c.conbin::pg_catalog.text FROM pg_catalog.pg_constraint c WHERE c.contypid ${EQ} t.oid AND c.conbin IS NOT NULL)
           ${CAT} CASE WHEN t.typdefaultbin IS NULL THEN ${NO_TEXTS} ELSE ARRAY[t.typdefaultbin::pg_catalog.text] END AS trees,
         ${NO_TEXTS} AS operators`;

/**
 * Every expression a write to the tables named by `$1` (schemas) and `$2`
 * (names) may run, with the table it is reached through: theirs, their
 * partitions' and children's, and their columns' domains'.
 */
function postgresTableCodeStatement(): string {
  const generated = `a.attgenerated ${NE} ''`;
  return `WITH RECURSIVE ${CODE_TYPES}
SELECT wanted.schema, wanted."table", code.kind, code.name, code.column_name AS "column", code.events, code.trees, code.operators
  FROM (
  SELECT tree.root, CASE WHEN ${generated} THEN 'generated column' ELSE 'default of column' END AS kind,
         a.attname::pg_catalog.text AS name, CASE WHEN ${generated} THEN NULL ELSE a.attname::pg_catalog.text END AS column_name,
         CASE WHEN ${generated} THEN 'iu' ELSE 'i' END AS events, ARRAY[d.adbin::pg_catalog.text] AS trees, ${NO_TEXTS} AS operators
    FROM tree JOIN pg_catalog.pg_attrdef d ON d.adrelid ${EQ} tree.relid
    JOIN pg_catalog.pg_attribute a ON a.attrelid ${EQ} d.adrelid AND a.attnum ${EQ} d.adnum AND NOT a.attisdropped
  UNION ALL
  SELECT tree.root, CASE WHEN c.contype ${EQ} 'c' THEN 'CHECK constraint' ELSE 'exclusion constraint' END, c.conname::pg_catalog.text, NULL, 'iu',
         CASE WHEN c.conbin IS NULL THEN ${NO_TEXTS} ELSE ARRAY[c.conbin::pg_catalog.text] END, coalesce(c.conexclop::pg_catalog.text[], ${NO_TEXTS})
    FROM tree JOIN pg_catalog.pg_constraint c ON c.conrelid ${EQ} tree.relid AND c.contype ${EQ} ANY (ARRAY['c', 'x']::pg_catalog."char"[])
  UNION ALL
  SELECT tree.root, 'index', k.relname::pg_catalog.text, NULL, 'iu',
         ARRAY(SELECT e FROM pg_catalog.unnest(ARRAY[i.indexprs::pg_catalog.text, i.indpred::pg_catalog.text]) AS e WHERE e IS NOT NULL), ${NO_TEXTS}
    FROM tree JOIN pg_catalog.pg_index i ON i.indrelid ${EQ} tree.relid JOIN pg_catalog.pg_class k ON k.oid ${EQ} i.indexrelid
   WHERE i.indexprs IS NOT NULL OR i.indpred IS NOT NULL
  UNION ALL
  SELECT tree.root, 'partition key of', k.relname::pg_catalog.text, NULL, 'iu', ARRAY[p.partexprs::pg_catalog.text], ${NO_TEXTS}
    FROM tree JOIN pg_catalog.pg_partitioned_table p ON p.partrelid ${EQ} tree.relid JOIN pg_catalog.pg_class k ON k.oid ${EQ} p.partrelid
   WHERE p.partexprs IS NOT NULL
  UNION ALL ${domainCode('typed.root', 'typed.name')}
    FROM typed JOIN pg_catalog.pg_type t ON t.oid ${EQ} typed.type AND t.typtype ${EQ} 'd'
    JOIN pg_catalog.pg_namespace tn ON tn.oid ${EQ} t.typnamespace
  ) AS code(root, kind, name, column_name, events, trees, operators)
  JOIN wanted ON wanted.root ${EQ} code.root
 ORDER BY 1, 2, 3, 4, 5`;
}

/** The domains `$1` (oids) and every domain under each, as {@link postgresTableCodeStatement}'s rows (no table). */
const POSTGRES_DOMAIN_CODE = `WITH RECURSIVE under(type) AS (
    SELECT pg_catalog.unnest($1::pg_catalog.oid[])
    UNION SELECT t.typbasetype FROM under JOIN pg_catalog.pg_type t ON t.oid ${EQ} under.type WHERE t.typtype ${EQ} 'd')
  ${domainCode(`'' AS schema, '' AS "table"`, 'NULL::pg_catalog.text')}
    FROM under JOIN pg_catalog.pg_type t ON t.oid ${EQ} under.type AND t.typtype ${EQ} 'd'
    JOIN pg_catalog.pg_namespace tn ON tn.oid ${EQ} t.typnamespace`;

/** PostgreSQL's own functions that run a query given to them as text or a cursor, or read a table whole. */
const RUNS_SQL = [
  'query_to_xml',
  'query_to_xmlschema',
  'query_to_xml_and_xmlschema',
  'cursor_to_xml',
  'cursor_to_xmlschema',
  'table_to_xml',
  'table_to_xmlschema',
  'table_to_xml_and_xmlschema',
  'schema_to_xml',
  'schema_to_xmlschema',
  'schema_to_xml_and_xmlschema',
  'database_to_xml',
  'database_to_xmlschema',
  'database_to_xml_and_xmlschema',
  'ts_stat',
  'ts_rewrite',
];

/** Whether a function (`f`, a pg_proc row or none) is code the database did not make. */
const untrusted = (f: string) => `(${f}.oid IS NULL
    OR NOT ((${f}.oid ${LT} ${FIRST_NORMAL_OID}::pg_catalog.oid
             AND ${f}.proname::pg_catalog.text ${NE} ALL (ARRAY[${RUNS_SQL.map((name) => `'${name}'`).join(', ')}]::pg_catalog.text[]))
            OR ${f}.prolang ${EQ} ANY (SELECT g.oid FROM pg_catalog.pg_language g
                                        WHERE g.lanname ${EQ} ANY (ARRAY['c', 'internal']::pg_catalog.name[]))))`;

/**
 * Of the functions `$1` and operators `$2` (oids), those whose code is the
 * database's own making, keyed `f<oid>` or `o<oid>`, with the function each
 * runs as `name(argument types)`: neither PostgreSQL's own (bar those that run
 * a query) nor C a superuser installed.
 */
const POSTGRES_UNTRUSTED_CODE = `SELECT 'f' ${CAT} w.oid::pg_catalog.text AS key,
       coalesce(f.oid::pg_catalog.regprocedure::pg_catalog.text, w.oid::pg_catalog.text) AS name
  FROM pg_catalog.unnest($1::pg_catalog.oid[]) AS w(oid) LEFT JOIN pg_catalog.pg_proc f ON f.oid ${EQ} w.oid
 WHERE ${untrusted('f')}
UNION ALL
SELECT 'o' ${CAT} w.oid::pg_catalog.text, coalesce(f.oid::pg_catalog.regprocedure::pg_catalog.text, 'operator ' ${CAT} w.oid::pg_catalog.text)
  FROM pg_catalog.unnest($2::pg_catalog.oid[]) AS w(oid) LEFT JOIN pg_catalog.pg_operator o ON o.oid ${EQ} w.oid
  LEFT JOIN pg_catalog.pg_proc f ON f.oid ${EQ} o.oprcode
 WHERE ${untrusted('f')}`;

function isCodeRow(row: unknown): row is PostgresCodeRow {
  if (!row || typeof row !== 'object') return false;
  const r = row as Record<string, unknown>;
  return (
    ['schema', 'table', 'kind', 'name', 'events'].every((key) => typeof r[key] === 'string') &&
    (r.column === null || typeof r.column === 'string') &&
    [r.trees, r.operators].every((list) => Array.isArray(list) && list.every((item) => typeof item === 'string'))
  );
}

/** What an expression and the domains it casts to name: functions, operators, and whether any of it could not be read. */
interface Named {
  functions: Set<number>;
  operators: Set<number>;
  domains: Set<number>;
  unread: boolean;
}

/**
 * The code each wanted table's writes may run that calls a function the
 * database made, as the triggers a write is judged by (never validation-only),
 * keyed `schema.name`. `client` answers on the writer.
 */
export async function readPostgresTableCode(
  client: PgQuery,
  tables: ReadonlyArray<{ schema: string; name: string }>,
): Promise<Map<string, ScopeTrigger[]>> {
  const result = new Map<string, ScopeTrigger[]>();
  if (!tables.length) return result;
  const read = await client.query(postgresTableCodeStatement(), [tables.map((table) => table.schema), tables.map((table) => table.name)]);
  if (!read.rows.every(isCodeRow)) throw new Error('A row of table code of an unknown shape.');
  const rows = read.rows as unknown as PostgresCodeRow[];
  // A domain an expression casts to brings its own constraints, read once each.
  const domains = new Map<number, Promise<PostgresCodeRow[]>>();
  const domainCodeOf = (oid: number) => {
    if (!domains.has(oid))
      domains.set(
        oid,
        client.query(POSTGRES_DOMAIN_CODE, [[String(oid)]]).then((domain) => {
          if (!domain.rows.every(isCodeRow)) throw new Error('A row of domain code of an unknown shape.');
          return domain.rows as unknown as PostgresCodeRow[];
        }),
      );
    return domains.get(oid)!;
  };
  const collect = async (row: PostgresCodeRow, into: Named): Promise<void> => {
    for (const oid of row.operators) into.operators.add(Number(oid));
    for (const text of row.trees) {
      const tree = readPostgresTree(text);
      if (!tree) {
        into.unread = true;
        continue;
      }
      for (const oid of tree.functions) into.functions.add(oid);
      for (const oid of tree.operators) into.operators.add(oid);
      for (const oid of tree.domains) {
        if (into.domains.has(oid)) continue;
        into.domains.add(oid);
        for (const domain of await domainCodeOf(oid)) await collect(domain, into);
      }
    }
  };
  const named = new Map<PostgresCodeRow, Named>();
  for (const row of rows) {
    const into: Named = { functions: new Set(), operators: new Set(), domains: new Set(), unread: false };
    await collect(row, into);
    named.set(row, into);
  }
  // One question for every function and operator any of it names.
  const functions = new Set([...named.values()].flatMap((entry) => [...entry.functions]));
  const operators = new Set([...named.values()].flatMap((entry) => [...entry.operators]));
  const calls = new Map<string, string>();
  if (functions.size || operators.size) {
    const asked = await client.query(POSTGRES_UNTRUSTED_CODE, [[...functions].map(String), [...operators].map(String)]);
    for (const row of asked.rows as Array<{ key: unknown; name: unknown }>) calls.set(String(row.key), String(row.name));
  }
  const said = new Set<string>();
  for (const [row, entry] of named) {
    const called = [
      ...new Set([...[...entry.functions].map((oid) => calls.get(`f${oid}`)), ...[...entry.operators].map((oid) => calls.get(`o${oid}`))]),
    ].filter((name): name is string => name !== undefined);
    if (!called.length && !entry.unread) continue;
    const key = `${row.schema}.${row.table}`;
    // An inherited CHECK, or two columns of one domain under the same name, is said once.
    const once = `${key}\u0000${row.kind}\u0000${row.name}\u0000${row.column ?? ''}`;
    if (said.has(once)) continue;
    said.add(once);
    const events: TriggerEvent[] = [];
    if (row.events.includes('i')) events.push('insert');
    if (row.events.includes('u')) events.push('update');
    result.set(key, [
      ...(result.get(key) ?? []),
      {
        name: row.name,
        kind: row.kind,
        events,
        ...(row.kind === 'domain' && row.column !== null ? { columns: [row.column] } : {}),
        validates: false,
        why: called.length ? `it calls ${called.sort().join(', ')}` : 'it holds an expression mistri cannot read',
      },
    ]);
  }
  return result;
}
