/**
 * The values a column is allowed to hold, when the database says so.
 *
 * A column called `status` typed `text` tells you nothing. A `CHECK (status
 * IN ('draft','open','paid'))` tells you everything — the states the system
 * has, which is often the single most useful fact about a table and the one
 * an agent is most likely to guess wrong. Guessing produces `status =
 * 'OPEN'`, which returns no rows and looks like an empty table rather than a
 * spelling mistake.
 *
 * Every dialect writes the same constraint differently, so the parsing lives
 * here and the adapters bring their own constraint text. This is deliberately
 * a *recogniser*, not a SQL expression parser: it understands the handful of
 * shapes that mean "one of these" and returns nothing for anything else. A
 * partial understanding of `CHECK (total > 0 AND status IN (...))` would be
 * worse than none, because the vocabulary it reported would be presented as
 * the whole rule.
 */

/** A quoted or bare identifier, as any dialect might write the column. */
function sameColumn(written: string, column: string): boolean {
  const bare = written.trim().replace(/^["`[]|["`\]]$/g, '');
  return bare.toLowerCase() === column.toLowerCase();
}

/** `'a'`, `'it''s'`, `'a'::text` — the string literals inside a list. */
function literals(list: string): string[] | undefined {
  const values: string[] = [];
  const pattern = /'((?:[^']|'')*)'(?:::[A-Za-z_" ]+(?:\[\])?)?\s*(,|$)/gy;
  pattern.lastIndex = 0;
  let rest = list.trim();
  let at = 0;
  while (at < rest.length) {
    pattern.lastIndex = at;
    const m = pattern.exec(rest);
    if (!m) return undefined;
    values.push(m[1].replace(/''/g, "'"));
    at = pattern.lastIndex;
    while (rest[at] === ' ') at += 1;
  }
  return values.length ? values : undefined;
}

/**
 * Remove `::type` casts, which Postgres sprays through every stored
 * expression — `(status)::text = ANY ((ARRAY['a'::character varying])::text[])`
 * is `status = ANY (ARRAY['a'])` with six casts in it. Quoted strings are
 * stepped over, so a value that happens to contain `::` survives.
 */
function stripCasts(text: string): string {
  let out = '';
  let quoted: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      out += ch;
      if (ch === quoted) quoted = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quoted = ch;
      out += ch;
      continue;
    }
    if (ch === ':' && text[i + 1] === ':') {
      i += 2;
      while (i < text.length && /[A-Za-z0-9_ "]/.test(text[i])) i += 1;
      if (text[i] === '[' && text[i + 1] === ']') i += 1;
      else i -= 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * The vocabulary a single CHECK expression pins for one column.
 *
 * Handles the two shapes that mean the same thing:
 *   `status IN ('a','b')`                                      — every dialect
 *   `((status)::text = ANY ((ARRAY['a'::text, 'b'::text])))`   — what Postgres
 *                                                                stores instead
 */
export function checkVocabulary(expression: string, column: string): string[] | undefined {
  const text = stripCasts(expression).trim();

  /* Postgres rewrites `IN` to `= ANY (ARRAY[...])` before storing it, so the
     constraint you wrote is never the constraint you read back. */
  const any = /^[(\s]*([^\s()]+)[)\s]*=\s*ANY\s*[(\s]*ARRAY\s*\[(.*)\][\s)]*$/is.exec(text);
  if (any && sameColumn(any[1], column)) return literals(any[2]);

  const list = /^[(\s]*([^\s()]+)\s+IN\s*\((.*)\)[\s)]*$/is.exec(text);
  if (list && sameColumn(list[1], column)) return literals(list[2]);

  return undefined;
}

/**
 * Whether a single CHECK expression pins a column to 0 and 1 — the flag a
 * dialect without a boolean type spells as an integer. The shapes that say
 * exactly that and nothing more:
 *   `flag IN (0, 1)`, `flag = 0 OR flag = 1`, `flag BETWEEN 0 AND 1`, and
 *   Postgres's stored `(flag = ANY (ARRAY[0, 1]))`
 * (either order, either parenthesising). A check that says more than that
 * (`flag IN (0, 1, 2)`, `flag >= 0`) is no flag.
 */
export function checkFlag(expression: string, column: string): boolean {
  const text = unwrap(stripCasts(expression));
  const bits = (list: string) => {
    const values = list.split(',').map((value) =>
      value
        .trim()
        .replace(/^\(|\)$/g, '')
        .trim(),
    );
    return values.length === 2 && new Set(values).size === 2 && values.every((value) => value === '0' || value === '1');
  };
  const list = /^\(?\s*([^\s()]+)\s*\)?\s+IN\s*\(([^()]*)\)$/is.exec(text);
  if (list) return sameColumn(list[1], column) && bits(list[2]);
  /* What Postgres stores for the IN list. */
  const any = /^\(?\s*([^\s()]+)\s*\)?\s*=\s*ANY\s*\(\s*ARRAY\s*\[([^\]]*)\]\s*\)$/is.exec(text);
  if (any) return sameColumn(any[1], column) && bits(any[2]);
  const between = /^([^\s()]+)\s+BETWEEN\s+0\s+AND\s+1$/is.exec(text);
  if (between) return sameColumn(between[1], column);
  const either = /^\(?\s*([^\s()=]+)\s*=\s*([01])\s*\)?\s+OR\s+\(?\s*([^\s()=]+)\s*=\s*([01])\s*\)?$/is.exec(text);
  if (either) return sameColumn(either[1], column) && sameColumn(either[3], column) && either[2] !== either[4];
  return false;
}

/**
 * What a single CHECK expression says of a text column's length or form, in
 * the two simple shapes a form can check as someone types (textRules.ts):
 *   `char_length(name) >= 2` (or `length`, `character_length`, `>`) — the fewest characters;
 *   `code ~ '^[A-Z]{3}$'` — a regular expression the value matches somewhere,
 *   returned as a whole-value JavaScript pattern, and only where JavaScript reads it.
 * Postgres's stored spelling (`char_length((name)::text) >= 2`) is the same
 * shape once its casts are off. Anything more (an AND, `~*`, a bound above)
 * is no rule: a partial reading would be presented as the whole of it.
 */
export function checkTextRule(expression: string, column: string): { min?: number; pattern?: string } | undefined {
  const text = unwrap(stripCasts(expression));
  const length = /^(?:char_length|character_length|length)\s*\(\s*\(?\s*([^\s()]+?)\s*\)?\s*\)\s*(>=|>)\s*(\d{1,5})$/i.exec(text);
  if (length) {
    if (!sameColumn(length[1], column)) return undefined;
    const min = Number(length[3]) + (length[2] === '>' ? 1 : 0);
    return min > 0 ? { min } : undefined;
  }
  const match = /^\(?\s*([^\s()]+)\s*\)?\s*~\s*'((?:[^']|'')*)'$/.exec(text);
  if (!match || !sameColumn(match[1], column)) return undefined;
  const source = match[2].replace(/''/g, "'");
  /* `~` finds the pattern anywhere; a form's pattern is the whole value. One
     anchored at both ends already is; any other matches with anything around it. */
  const anchored = source.startsWith('^') && source.endsWith('$') && !source.endsWith('\\$');
  const pattern = anchored ? source : `[\\s\\S]*(?:${source})[\\s\\S]*`;
  try {
    new RegExp(`^(?:${pattern})$`, 'u');
  } catch {
    return undefined;
  }
  return { pattern };
}

/** An expression without the parentheses that wrap the whole of it: `((a IN (0, 1)))` is `a IN (0, 1)`. */
function unwrap(expression: string): string {
  let text = expression.trim();
  while (text.startsWith('(')) {
    let depth = 0;
    let closes = -1;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')' && --depth === 0) {
        closes = i;
        break;
      }
    }
    if (closes !== text.length - 1) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** The columns of a `CREATE TABLE` statement a CHECK pins to 0 and 1 (checkFlag). */
export function flagsFromDDL(ddl: string, columns: string[]): Set<string> {
  const checks = checksIn(ddl);
  return new Set(columns.filter((column) => checks.some((check) => checkFlag(check, column))));
}

/**
 * Every CHECK clause in a `CREATE TABLE` statement, for dialects that keep
 * the statement rather than the constraints — SQLite.
 *
 * Scanned with a depth counter rather than a regex because a check body
 * contains parentheses of its own, and matching to the first `)` truncates
 * `CHECK (status IN ('a','b'))` to `status IN ('a'`.
 */
export function checksIn(ddl: string): string[] {
  const found: string[] = [];
  const pattern = /\bCHECK\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(ddl))) {
    let depth = 1;
    let i = match.index + match[0].length;
    let quoted: string | null = null;
    const start = i;
    for (; i < ddl.length && depth > 0; i += 1) {
      const ch = ddl[i];
      if (quoted) {
        if (ch === quoted) quoted = null;
        continue;
      }
      if (ch === "'" || ch === '"') quoted = ch;
      else if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    if (depth === 0) found.push(ddl.slice(start, i - 1));
    pattern.lastIndex = i;
  }
  return found;
}

/**
 * The allowed values for each column of a table, read out of its DDL.
 *
 * Column-level (`status TEXT CHECK (status IN (...))`) and table-level
 * (`CHECK (status IN (...))`) checks are the same text by the time they get
 * here, which is why this asks each check about each column rather than
 * trying to work out which column a check was attached to.
 */
export function vocabularyFromDDL(ddl: string, columns: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const check of checksIn(ddl)) {
    for (const column of columns) {
      if (found.has(column)) continue;
      const values = checkVocabulary(check, column);
      if (values) found.set(column, values);
    }
  }
  return found;
}
