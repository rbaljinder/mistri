/**
 * Completion for the SQL editor.
 *
 * The query language's completer knows the grammar it is completing, because
 * tablewalk wrote that grammar. SQL is somebody else's language and this is not
 * a parser for it — writing one to power a dropdown would be a large amount of
 * code that is wrong in a different way for each dialect.
 *
 * What it does instead is answer two questions from the text to the left of the
 * caret: **what is in scope**, and **what kind of thing goes here**. Both are
 * answerable with a scan, and both degrade in a way that costs the reader
 * nothing — a wrong guess offers a list they ignore, where a parser that
 * refused to guess would offer nothing at all.
 *
 * The scope question is answered by finding `FROM x`, `JOIN y AS b` and their
 * aliases anywhere in the statement, not only before the caret: people write
 * `SELECT ` and then the columns they want, and at that moment the tables are
 * all to the *right* of where they are typing. A completer that only looked
 * backwards would be silent at exactly the moment it is most wanted.
 */
import { findTable, state } from '@mistriwork/kit/client/core.js';
import { plural } from '@mistriwork/kit/client/locale.js';
import { say } from './copy/workbench/sqlcomplete.js';

/* Keywords offered as a last resort, in the order they occur in a statement
   rather than alphabetically — the point of the list is to suggest what comes
   next, and `WHERE` is a likelier next word than `ALL`. */
const KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP BY',
  'HAVING',
  'ORDER BY',
  'LIMIT',
  'OFFSET',
  'JOIN',
  'LEFT JOIN',
  'INNER JOIN',
  'ON',
  'AS',
  'AND',
  'OR',
  'NOT',
  'IN',
  'LIKE',
  'IS NULL',
  'IS NOT NULL',
  'BETWEEN',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'DISTINCT',
  'COUNT(',
  'SUM(',
  'AVG(',
  'MIN(',
  'MAX(',
  'COALESCE(',
  'WITH',
  'UNION',
  'ASC',
  'DESC',
  'EXISTS',
];

/** Words after which a table name is what comes next. */
const EXPECTS_TABLE = /\b(from|join|update|into|table)\s+(\w*)$/i;

/** Words after which a column name is what comes next. */
const EXPECTS_COLUMN = /\b(select|where|on|and|or|by|having|set|distinct|,|\(|=|<|>|<=|>=|!=|<>|\+|-)\s*(\w*)$/i;

/**
 * Tables named in the statement, by the name they are referred to.
 *
 * Both directions: the alias if there is one, and the table's own name, since
 * `FROM customer` makes `customer.id` valid too. Matching is deliberately loose
 * about the shape of what follows — `AS` optional, a comma or newline ending
 * it — because the alternative is a parser.
 */
export function scopeOf(text) {
  const scope = new Map();
  const pattern = /\b(?:from|join|update|into)\s+([A-Za-z_][\w.$]*)(?:\s+(?:as\s+)?([A-Za-z_]\w*))?/gi;

  for (const match of text.matchAll(pattern)) {
    const [, name, alias] = match;
    // `FROM customer WHERE` — `WHERE` is not an alias, and neither is any other
    // word that can legally follow a table name.
    const isKeyword =
      alias && /^(where|join|left|right|inner|outer|cross|on|group|order|limit|having|union|set|values|using|and|or)$/i.test(alias);
    const table = findTable(name) ?? state.schema?.tables.find((t) => t.name === name);
    if (!table) continue;
    scope.set(table.name, table);
    scope.set(table.id, table);
    if (alias && !isKeyword) scope.set(alias, table);
  }
  return scope;
}

/** The word being typed, and where it starts. Splits on SQL's punctuation. */
export function tokenAt(text, caret) {
  const before = text.slice(0, caret);
  const start = Math.max(
    0,
    ...[' ', '\n', '\t', ',', '(', ')', '=', '<', '>', '+', '-', '*', '/', ';'].map((c) => before.lastIndexOf(c) + 1),
  );
  return { word: before.slice(start), start };
}

const columnItem = (table, column, detail) => ({
  kind: column.primaryKey ? 'key' : column.references ? 'ref' : 'column',
  label: column.name,
  value: column.name,
  detail: detail ?? `${table.name} · ${column.type}`,
});

/**
 * What could come next, given where the caret is.
 *
 * Ordering within the list matters more than the list itself: the first entry
 * is what Tab accepts, so it has to be the likeliest thing rather than the
 * alphabetically first. Columns of tables actually in the statement come before
 * every other table's columns, and keywords come last — a keyword is always
 * *possible*, which is exactly why it is never the best guess.
 */
export function sqlSuggestions(text, caret) {
  if (!state.schema) return [];
  const { word } = tokenAt(text, caret);
  const before = text.slice(0, caret);
  const scope = scopeOf(text);
  const matches = (name) => name.toLowerCase().startsWith(word.toLowerCase());

  /* `alias.` — the one case with a definite answer. Nothing else can follow a
     qualified name, so nothing else is offered. */
  const qualified = /([A-Za-z_]\w*)\.(\w*)$/.exec(before);
  if (qualified) {
    const [, prefix, partial] = qualified;
    const table = scope.get(prefix) ?? findTable(prefix) ?? state.schema.tables.find((t) => t.name === prefix);
    if (!table) return [];
    return table.columns
      .filter((c) => c.name.toLowerCase().startsWith(partial.toLowerCase()))
      .map((c) => ({ ...columnItem(table, c), value: c.name }));
  }

  const out = [];
  const tableItem = (t) => ({
    kind: t.isView ? 'view' : 'table',
    label: t.name,
    value: t.id,
    detail: say('columns', { count: t.columns.length }),
  });

  if (EXPECTS_TABLE.test(before)) {
    // After FROM, a table is the only sensible suggestion, so nothing dilutes it.
    return state.schema.tables.filter((t) => matches(t.name) || matches(t.id)).map(tableItem);
  }

  if (EXPECTS_COLUMN.test(before) || word) {
    for (const table of new Set(scope.values())) {
      for (const column of table.columns) {
        if (matches(column.name)) out.push(columnItem(table, column));
      }
    }
    /* Aliases and table names themselves, so `c.` is reachable by typing `c`
       and accepting rather than by remembering it. */
    for (const [name, table] of scope) {
      if (matches(name) && name !== table.name) {
        out.push({ kind: 'alias', label: name, value: name, detail: say('alias', { name: table.name }) });
      }
    }
    /* Every other table's columns, once the statement's own are exhausted. A
       column typed before its FROM clause exists is a real way people write
       SQL, and offering nothing there is worse than offering a long list. */
    if (!out.length) {
      for (const table of state.schema.tables) {
        if (scope.has(table.name)) continue;
        for (const column of table.columns) {
          if (matches(column.name)) out.push(columnItem(table, column, say('notInThisStatement', { name: table.name })));
        }
      }
    }
  }

  if (!word || EXPECTS_TABLE.test(before) === false) {
    for (const keyword of KEYWORDS) {
      if (matches(keyword)) {
        out.push({ kind: 'keyword', label: keyword, value: keyword, detail: '' });
      }
    }
  }

  // Tables last among the non-keywords: a bare word is more often a column.
  for (const table of state.schema.tables) {
    if (matches(table.name) && !scope.has(table.name)) out.push(tableItem(table));
  }

  return out;
}
