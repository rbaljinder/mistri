/*
 * A filter, and the one place it becomes SQL. The query language, views, row
 * scopes and breakdowns in shared/ build their WHERE clauses through it, so
 * it lives here rather than with the adapters that run the statements.
 */
import { LIKE_ESCAPE, likePattern } from './like.js';
import { Refusal } from './refusal.js';

/** One condition in a filter. Values are bound, never interpolated. */
export interface Condition {
  column: string;
  op: Op;
  /** Absent for `is null` / `is not null`; an array for `in`. */
  value?: string | number | boolean | Array<string | number>;
  /**
   * Compare text by its bytes rather than by the column's collation; `binary`
   * is the only value, and only a comparison takes it. An API cursor resumes
   * where the last page stopped, which is sound only when the ORDER BY and the
   * boundary comparison agree exactly on every engine — a locale collation
   * can order `a`, `B` and `b` differently from one database to the next.
   */
  collation?: 'binary';
  /**
   * Compare with another column rather than a value: `on_hand <
   * product_id.reorder_level`. A column name or, in a view, a reference path;
   * only the six comparisons take it, and `value` is then absent. It becomes
   * an identifier in the statement, so only a builder that resolves it (a
   * view's, which checks every path against the catalog it was given) may
   * compile it; `buildWhere` refuses it otherwise, and a structured request
   * cannot use it to name a column its reader was never granted.
   */
  other?: string;
  /**
   * Rows of another table that point at this one: `any opportunity where
   * stage = negotiation` holds where at least one such row matches. Written
   * as `EXISTS (…)` over the child's relation, so a row scope on the child
   * narrows it as it narrows a list of those rows. Only a builder that knows
   * the row it is asked of (a view's, a breakdown's: `buildWhere`'s
   * `exists`) compiles it; everywhere else it is refused, never dropped.
   * `op` is `isNotNull` for `any`, `isNull` for `no`.
   */
  any?: AnyRows;
}

/**
 * The child rows an `any` condition asks about: the reference they point
 * at the record through, as `child.column` (`+`-joined for a composite key)
 * — endpoints, as a rollup's `via`, so a layer that renames tables rewrites
 * it without resolving anything — and which of them count: conditions over
 * the child's own columns and paths up from it.
 */
export interface AnyRows {
  via: string;
  filter?: Filter;
}

export type Op =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  /**
   * A LIKE pattern written by hand, wildcards and all.
   *
   * The deliberate opposite of `contains`, which escapes `%` and `_` so that
   * searching for `50%` finds a percent sign. Here they are the point: `like
   * Wh%` is a prefix, `like _a%` is "second letter a". The escape character
   * is still declared, so `like 50#%` finds the literal — the one thing a
   * pass-through pattern would otherwise make impossible to ask for.
   */
  | 'like'
  | 'in'
  /**
   * A record's tags hold any of the labels: `tags has (bug, docs)` (tagLists.ts).
   * Only a builder that knows the record's tags compiles it (`buildWhere`'s
   * `membership`); everywhere else it is refused.
   */
  | 'has'
  | 'isNull'
  | 'isNotNull';

/**
 * The operators, as a value rather than only as a type.
 *
 * `Op` is checked by the compiler, and the compiler is not present when a
 * request arrives: `/api/query`, `/api/count`, `/api/view/run` and
 * `/api/references` all cast a request body straight to `Filter`, so the type
 * was a comment as far as those paths were concerned. This is the list
 * `buildWhere` actually checks against.
 */
export const OPS: ReadonlySet<string> = new Set<Op>([
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'contains',
  'startsWith',
  'endsWith',
  'like',
  'in',
  'has',
  'isNull',
  'isNotNull',
]);

/**
 * A filter is OR-of-ANDs, which is the shape every UI condition builder
 * produces and the shape that compiles to SQL without parentheses gymnastics.
 * An empty `groups` means no filter.
 */
export interface Filter {
  groups: Condition[][];
}

/* ---------- shared SQL building ----------

   Kept here rather than duplicated per adapter, because the WHERE builder is
   the one place a mistake becomes an injection. Identifiers are quoted by the
   dialect; values are always parameters. */

export interface SqlFragment {
  text: string;
  params: unknown[];
}

/** How each dialect quotes an identifier and writes a placeholder. */
export interface SqlStyle {
  quote(identifier: string): string;
  /** Postgres wants $1, $2…; sqlite and mysql want ?. */
  placeholder(index: number): string;
  /**
   * The operator that matches text without regard to case.
   *
   * `contains` is a browsing operator: someone typing `contains nakamura`
   * means the name however it is capitalised, and the same query returning a
   * row on SQLite and nothing on Postgres is the tool disagreeing with
   * itself about what it was asked. SQLite's LIKE folds ASCII case already
   * and MySQL's default collations are case-insensitive; Postgres needs to
   * be asked.
   */
  likeOp: string;
  /**
   * A date or timestamp cut down to a period: day, week, month, quarter or year, or the weekday or hour it recurs on.
   * A week is said by its first day (`2026-10-05`), the ISO weekday `weekStart` names (1 Monday … 7 Sunday; Monday
   * when unsaid), so a week label is a day label and sorts, survives JSON and reads alike on every engine.
   *
   * Every engine here has this and every engine spells it differently, which
   * is exactly what a style is for. The result is *text* on purpose —
   * `2026-08`, `2026-Q3` — rather than a truncated timestamp: a breakdown's
   * group key is a label, it has to survive JSON, sort correctly as a string,
   * and mean the same thing on all three engines. A `date_trunc` returning a
   * timestamp does none of those.
   *
   * SQLite has no date type, only text in a format `strftime` understands.
   * That is a real limit rather than an oversight here: a column holding
   * `14/03/2025` is not a date to SQLite either, and a bucket over it is
   * null — which the breakdown shows as a group rather than hiding.
   */
  dateBucket(expression: string, unit: DateUnit, weekStart?: number): string;
  /**
   * The clause that orders and compares text by its bytes. Absent where no
   * one clause does that for every text column, and then a binary collation
   * is refused rather than approximated.
   */
  binaryText?: string;
  /** An expression as text, for a record label that joins values into words. */
  text(expression: string): string;
  /** Text pieces joined into one: the dialect's concatenation. */
  concat(parts: readonly string[]): string;
  /**
   * How many rows meet a predicate, as one aggregate among others in a
   * SELECT. Absent, `COUNT(CASE WHEN … THEN 1 END)`, which every engine here
   * reads and which is 0, not NULL, over no rows.
   */
  countWhere?(predicate: string): string;
  /**
   * Said between a common table expression's name and its body. Postgres 12
   * and later inline a CTE referenced once and materialize one referenced
   * twice; a row scope's CTE is referenced as often as the read joins its
   * table, and materializing it copies the whole scoped slice before the
   * outer filter, sort and limit can use an index (rowScope.ts).
   */
  cteHint?: string;
  /**
   * The engine, for what a style's hooks cannot say one at a time: a computed
   * column's date arithmetic and its yes-or-no (computed.ts). Absent is SQLite's.
   */
  dialect?: 'sqlite' | 'postgres' | 'mysql';
  /**
   * One key of a JSON column (`specs.capacity`, definedFields.ts): as its JSON
   * value (a select or a sort), as text (an equality, a pattern, emptiness;
   * a yes-or-no as `true`/`false`), or as a number where it holds one (a
   * range against a number). The key is an identifier, checked where the
   * path resolves, so it is written as a literal. Absent: no JSON keys here.
   */
  jsonKey?(expression: string, key: string, as: 'value' | 'text' | 'number'): string;
  /** Whether a JSON key's list (or its one value) holds any of the bound values: `has` on a many-of-a-list field. */
  jsonHas?(expression: string, key: string, holes: readonly string[]): string;
}

/** The periods a breakdown can group dates by: a calendar's (day to year), and the two that recur — the ISO
    weekday, "1" (Monday) to "7", and the hour of the day, "00" to "23" — which a heat map crosses. */
export type DateUnit = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'weekday' | 'hour';

/** How many days a date is past its week's first day, `start` the ISO weekday it starts on, from the ISO weekday
    expression `isoDay`: `(isoDay + 7 - start) % 7`, so Monday is 0 in a Monday week and Sunday 0 in a Sunday one. */
const intoWeek = (isoDay: string, start: number) => `(${isoDay} + ${7 - start}) % 7`;

/** A week start as the SQL may say it: an ISO weekday, 1 to 7, Monday when unsaid. Never a request's text. */
export function weekStartDay(weekStart: number | undefined): number {
  if (weekStart === undefined) return 1;
  if (!Number.isInteger(weekStart) || weekStart < 1 || weekStart > 7)
    throw new Error(`A week starts on an ISO weekday, 1 (Monday) to 7 (Sunday), not ${String(weekStart).slice(0, 20)}.`);
  return weekStart;
}

export const ANSI_STYLE: SqlStyle = {
  dialect: 'sqlite',
  // Doubling an embedded quote is the standard escape and is what makes a
  // table called `weird"name` safe rather than a syntax error.
  quote: (id) => `"${id.replace(/"/g, '""')}"`,
  placeholder: () => '?',
  likeOp: 'LIKE',
  /* `strftime` has no quarter, so it is arithmetic on the month: 1–3 → 1.
     Written with the engine's own integer division rather than a CASE, which
     would be four branches to say one sum. */
  /* A week: `weekday N` moves forward to the week's last day (N counts from Sunday at 0) or stays on it, and six
     days back is its first, the date alone. */
  dateBucket: (e, unit, weekStart) =>
    unit === 'week'
      ? `strftime('%Y-%m-%d', ${e}, 'weekday ${(weekStartDay(weekStart) + 6) % 7}', '-6 days')`
      : unit === 'quarter'
        ? `strftime('%Y', ${e}) || '-Q' || CAST((CAST(strftime('%m', ${e}) AS INTEGER) + 2) / 3 AS TEXT)`
        : unit === 'weekday'
          ? /* `%w` counts from Sunday at 0; the ISO week starts on Monday at 1, as the other two engines say it. */
            `CAST((CAST(strftime('%w', ${e}) AS INTEGER) + 6) % 7 + 1 AS TEXT)`
          : `strftime('${{ day: '%Y-%m-%d', month: '%Y-%m', year: '%Y', hour: '%H' }[unit]}', ${e})`,
  // SQLite's default, said aloud so a column declared NOCASE cannot change it.
  binaryText: ' COLLATE BINARY',
  text: (e) => `CAST(${e} AS TEXT)`,
  concat: (parts) => `(${parts.join(' || ')})`,
  /* json1: json_extract reads a true as 1, so text says a yes-or-no by its JSON type. */
  jsonKey: (e, key, as) =>
    as === 'value'
      ? `json_extract(${e}, '$.${key}')`
      : as === 'number'
        ? `CASE WHEN json_type(${e}, '$.${key}') IN ('integer', 'real') THEN json_extract(${e}, '$.${key}') END`
        : `CASE json_type(${e}, '$.${key}') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE CAST(json_extract(${e}, '$.${key}') AS TEXT) END`,
  jsonHas: (e, key, holes) => `EXISTS (SELECT 1 FROM json_each(${e}, '$.${key}') WHERE value IN (${holes.join(', ')}))`,
};

export const POSTGRES_STYLE: SqlStyle = {
  dialect: 'postgres',
  quote: ANSI_STYLE.quote,
  placeholder: (i) => `$${i}`,
  likeOp: 'ILIKE',
  /* `to_char` rather than `date_trunc`, for the text the interface says it
     returns. `Q` is a to_char field, so the quarter needs no arithmetic. */
  /* A week: the date less the days it is past its week's first (`date - integer` is a date). */
  dateBucket: (e, unit, weekStart) =>
    unit === 'week'
      ? `to_char(CAST(${e} AS date) - CAST(${intoWeek(`CAST(EXTRACT(ISODOW FROM ${e}) AS integer)`, weekStartDay(weekStart))} AS integer), 'YYYY-MM-DD')`
      : `to_char(${e}, '${{ day: 'YYYY-MM-DD', month: 'YYYY-MM', quarter: 'YYYY-"Q"Q', year: 'YYYY', weekday: 'ID', hour: 'HH24' }[unit]}')`,
  /* "C" is byte order in every encoding and every database, whatever the
     cluster's or the column's own collation says. */
  binaryText: ' COLLATE "C"',
  text: (e) => `CAST(${e} AS TEXT)`,
  concat: (parts) => `(${parts.join(' || ')})`,
  countWhere: (predicate) => `COUNT(*) FILTER (WHERE ${predicate})`,
  /* Through jsonb whatever the column is (json or jsonb): `->` orders numbers as numbers, `->>` is the text,
     `?|` asks a list's elements (and a lone string) for any of the values. */
  jsonKey: (e, key, as) =>
    as === 'value'
      ? `((${e})::jsonb -> '${key}')`
      : as === 'number'
        ? `CASE WHEN jsonb_typeof((${e})::jsonb -> '${key}') = 'number' THEN ((${e})::jsonb ->> '${key}')::numeric END`
        : `((${e})::jsonb ->> '${key}')`,
  jsonHas: (e, key, holes) => `(((${e})::jsonb -> '${key}') ?| ARRAY[${holes.join(', ')}]::text[])`,
};

/**
 * Postgres 12 and later: row-scope CTEs stay inlined however often a read
 * joins their table. The adapter picks it once it knows the server's version
 * (PostgresAdapter.scopeStyle); an older server keeps POSTGRES_STYLE, where every CTE
 * is materialized anyway and the hint would be a syntax error.
 */
export const POSTGRES_INLINE_STYLE: SqlStyle = { ...POSTGRES_STYLE, cteHint: ' NOT MATERIALIZED' };

export const MYSQL_STYLE: SqlStyle = {
  dialect: 'mysql',
  quote: (id) => `\`${id.replace(/`/g, '``')}\``,
  placeholder: () => '?',
  /* A column declared with a `_bin` or `_cs` collation compares case
     sensitively even here. Forcing a collation in the predicate would fix
     that and break every latin1 column, so this follows the column. */
  likeOp: 'LIKE',
  /* `DATE_FORMAT` has no quarter specifier either, and MySQL's `QUARTER()`
     returns a number — concatenated rather than formatted, to land on the
     same `2026-Q3` the other two produce. */
  dateBucket: (e, unit, weekStart) =>
    unit === 'week'
      ? `DATE_FORMAT(DATE_SUB(DATE(${e}), INTERVAL ${intoWeek(`(WEEKDAY(${e}) + 1)`, weekStartDay(weekStart))} DAY), '%Y-%m-%d')`
      : unit === 'quarter'
        ? `CONCAT(DATE_FORMAT(${e}, '%Y'), '-Q', QUARTER(${e}))`
        : unit === 'weekday'
          ? /* WEEKDAY() counts from Monday at 0. */
            `CAST(WEEKDAY(${e}) + 1 AS CHAR)`
          : `DATE_FORMAT(${e}, '${{ day: '%Y-%m-%d', month: '%Y-%m', year: '%Y', hour: '%H' }[unit]}')`,
  /* No binaryText: a binary collation is named per character set here
     (utf8mb4_bin, latin1_bin), and naming the wrong one is an error. */
  /* `||` is OR here unless the server mode says otherwise, so the function. */
  text: (e) => `CAST(${e} AS CHAR)`,
  concat: (parts) => `CONCAT(${parts.join(', ')})`,
};

/** One ORDER BY term: an expression and its direction, and the vocabulary it sorts by where it has one. */
interface OrderTerm {
  expression: string;
  direction: 'asc' | 'desc';
  /** The values in their declared order (schema.ts `declaredOrder`). */
  declared?: readonly string[];
}

/**
 * An ORDER BY clause, or nothing. A term with a declared vocabulary sorts its
 * values in the order they were written, through a CASE every engine reads,
 * anything outside it (NULL, where the column may hold one) after the last
 * and the value itself as the tiebreak there. The values are bound
 * parameters like any other, numbered from `startIndex`: the clause sits
 * after the WHERE, so its parameters follow the WHERE's. A term already
 * written as text (an alias, a distance) is passed through.
 */
export function orderClauseSql(terms: readonly (OrderTerm | string)[], style: SqlStyle, startIndex = 1): SqlFragment {
  if (!terms.length) return { text: '', params: [] };
  const params: unknown[] = [];
  const text = terms
    .map((term) => {
      if (typeof term === 'string') return term;
      const dir = term.direction === 'desc' ? 'DESC' : 'ASC';
      if (!term.declared?.length) return `${term.expression} ${dir}`;
      const rank = term.declared
        .map((value, at) => {
          params.push(value);
          return `WHEN ${style.placeholder(startIndex + params.length - 1)} THEN ${at}`;
        })
        .join(' ');
      return `CASE ${term.expression} ${rank} ELSE ${term.declared.length} END ${dir}, ${term.expression} ${dir}`;
    })
    .join(', ');
  return { text: ` ORDER BY ${text}`, params };
}

/**
 * An expression under a requested collation. Unrequested, it is unchanged; a
 * collation the style cannot say is refused, never dropped: silently falling
 * back to the column's collation is the disagreement this exists to prevent.
 */
export function collate(expression: string, collation: unknown, style: SqlStyle): string {
  if (collation === undefined) return expression;
  if (collation !== 'binary' || !style.binaryText) throw new Refusal('This comparison cannot be made by bytes on this database.');
  return `${expression}${style.binaryText}`;
}

const COMPARISONS: ReadonlySet<string> = new Set(['=', '!=', '>', '>=', '<', '<=']);

/**
 * Compile a filter to a WHERE clause plus bound parameters.
 *
 * `startIndex` exists for Postgres, where placeholders are numbered across the
 * whole statement rather than positional.
 *
 * `column` exists for views. A multi-table statement needs
 * `"customer_1"."name"` where a single-table one needs `"name"`, and the
 * difference is *only* how an identifier is written — the operators, the
 * empty-IN case, the LIKE wrapping and the invariant that every value is a
 * bound parameter are the same either way. Passing the resolver in keeps one
 * predicate builder rather than two that can drift; a second copy of this
 * function is a second chance to interpolate a value by accident.
 */
export function buildWhere(
  filter: Filter | undefined,
  style: SqlStyle,
  startIndex = 1,
  /* Told the condition too, so a JSON key can be read as the comparison needs it (SqlStyle.jsonKey). */
  column: (name: string, condition?: Condition) => string = (name) => style.quote(name),
  /** How a column-to-column comparison's other side is written; absent, one is refused. */
  other?: (name: string) => string,
  /** How `has` is written for a column naming a record's tags, given the bound labels' placeholders; absent, `has` is refused. */
  membership?: (name: string, holes: readonly string[]) => string,
  /** How an `any` condition is written: an EXISTS over the child's rows, binding nothing of its own; absent, one is refused. */
  exists?: (rows: AnyRows) => string,
): SqlFragment {
  if (!filter?.groups.length) return { text: '', params: [] };
  const params: unknown[] = [];
  let index = startIndex;
  const next = () => style.placeholder(index++);

  /* A condition every group holds is said once, before the OR: the same
     rows (AND distributes over OR in SQL's three-valued logic too), and the
     shape an engine can read a range from. A keyset page's bound is in every
     branch of its continuation (keysetPage.ts); SQLite read the OR-of-ANDs
     as one index search per branch and a sort of everything they found —
     page two of a million rows was 150 ms — and the factored form as one
     range, 0.1 ms. */
  const nonempty = filter.groups.filter((g) => g.length);
  const common =
    nonempty.length > 1
      ? nonempty[0].filter(
          (c, at) => nonempty[0].findIndex((d) => sameCondition(c, d)) === at && nonempty.every((g) => g.some((d) => sameCondition(c, d))),
        )
      : [];
  const rest = common.length ? nonempty.map((g) => g.filter((c) => !common.some((d) => sameCondition(c, d)))) : nonempty;
  const compile = (group: Condition[]) =>
    group
      .map((c) => {
        if (c.collation !== undefined && !COMPARISONS.has(c.op)) {
          throw new Refusal('Only a comparison can compare text by bytes.');
        }
        /* Before the column is written: child rows are no column of this row. Their
           values are bound where their relation is planned (rowScope.ts `filtered`),
           so the EXISTS carries no parameter here and the numbering is untouched. */
        if (c.any !== undefined) {
          if (!exists || typeof c.any !== 'object' || c.any === null)
            throw new Refusal('This read cannot ask about the rows that point at it.');
          /* `no task …` is the same rows asked the other way: none of them matches. */
          return c.op === 'isNull' ? `NOT ${exists(c.any)}` : exists(c.any);
        }
        /* Before the column is written: a record's tags are no column. */
        if (c.op === 'has') {
          if (!membership || c.other !== undefined) throw new Refusal("This read cannot ask a record's tags.");
          const labels = (Array.isArray(c.value) ? c.value : [c.value]).filter((v) => typeof v === 'string' || typeof v === 'number');
          if (!labels.length) return '1 = 0';
          const holes = labels.map((v) => {
            params.push(String(v));
            return next();
          });
          return membership(c.column, holes);
        }
        const col = collate(column(c.column, c), c.collation, style);
        if (c.other !== undefined) {
          if (!other || typeof c.other !== 'string' || !COMPARISONS.has(c.op)) {
            throw new Refusal('This read cannot compare two columns.');
          }
          return `${col} ${c.op} ${collate(other(c.other), c.collation, style)}`;
        }
        switch (c.op) {
          case 'isNull':
            return `${col} IS NULL`;
          case 'isNotNull':
            return `${col} IS NOT NULL`;
          case 'in': {
            const list = Array.isArray(c.value) ? c.value : [c.value];
            if (!list.length) return '1 = 0'; // an empty IN matches nothing
            const holes = list.map((v) => {
              params.push(v ?? null);
              return next();
            });
            return `${col} IN (${holes.join(', ')})`;
          }
          /* All three go through one pattern builder, which escapes the
               wildcards in the value: `contains 50%` is a search for a
               percent sign, not a search for everything. */
          case 'contains':
          case 'startsWith':
          case 'endsWith':
            params.push(likePattern(c.value, c.op));
            return `${col} ${style.likeOp} ${next()} ESCAPE '${LIKE_ESCAPE}'`;
          /* Bound, not escaped: the wildcards belong to whoever typed them.
               Still a parameter — the value never becomes SQL text — so the
               safety argument is unchanged, and still `ESCAPE '#'`, so the
               way to ask for a literal `%` is the same one `contains` uses
               internally. */
          case 'like':
            params.push(String(c.value ?? ''));
            return `${col} ${style.likeOp} ${next()} ESCAPE '${LIKE_ESCAPE}'`;
          default: {
            /* The one field in a structured request that becomes SQL text
                 rather than a bound parameter — and until now it was checked
                 only by the config-file parser, so every endpoint that casts
                 a body to `Filter` accepted whatever it was sent. The column
                 is quoted and the value is bound; this was the gap between
                 those two, and the whole safety argument is that a structured
                 request cannot express injection.

                 Checked here rather than at each caller: one choke point
                 covers the four endpoints and anything added later. */
            if (!OPS.has(c.op)) {
              throw new Refusal(`"${String(c.op)}" is not an operator this tool knows.`);
            }
            params.push(c.value ?? null);
            return `${col} ${c.op} ${next()}`;
          }
        }
      })
      .join(' AND ');

  const shared = common.length ? compile(common) : '';
  /* A group that held only the shared conditions is true once they are:
     the OR after them is then true, and not said. */
  const groupSql = rest.some((g) => !g.length) ? [] : rest.map(compile);
  if (!shared && !groupSql.length) return { text: '', params: [] };
  const alternatives = groupSql.length === 1 ? groupSql[0] : groupSql.map((g) => `(${g})`).join(' OR ');
  const text = !shared
    ? alternatives
    : !groupSql.length
      ? shared
      : `${shared} AND ${groupSql.length === 1 ? alternatives : `(${alternatives})`}`;
  return { text: ` WHERE ${text}`, params };
}

/** The same condition, field for field: what may be said once for every group. */
function sameCondition(a: Condition, b: Condition): boolean {
  if (a === b) return true;
  if (a.column !== b.column || a.op !== b.op || a.collation !== b.collation || a.other !== b.other || a.any !== b.any) return false;
  if (Array.isArray(a.value) || Array.isArray(b.value)) {
    return (
      Array.isArray(a.value) &&
      Array.isArray(b.value) &&
      a.value.length === b.value.length &&
      a.value.every((v, i) => v === (b.value as unknown[])[i])
    );
  }
  return a.value === b.value;
}
