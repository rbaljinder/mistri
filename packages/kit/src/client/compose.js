/**
 * Folding a filter into an existing query.
 *
 * Pure — no DOM, no state — so the rules can be tested directly rather than
 * through a browser. They are fiddly enough to deserve it: the naive version
 * of this produces queries that silently match nothing.
 */

/**
 * Fold a new condition into an existing query, following the grammar.
 *
 * The naive version — append " and <condition>" — produces
 * `status = scheduled and status = scheduled`, and picking a second value for
 * the same column gives `status = a and status = b`, which matches nothing.
 * Neither is what anyone means by clicking two values in a list.
 *
 * The rule that matches intent: conditions on *different* columns combine
 * with AND, conditions on the *same* column combine with OR — and the
 * language already has a word for OR within one column, so repeat equality
 * folds into `in (…)` rather than growing a chain of ors. That keeps the
 * query readable, which matters because the query is the thing you save,
 * share and edit by hand.
 */
import { splitConditions, splitQuery } from './clauses.js';

export function composeFilter(query, table, column, condition) {
  /* Clauses have to stay at the end for the parser to read them as clauses,
     so a new condition is inserted before them, never appended.
  
     Split by the shared splitter rather than by a regex of its own. The regex
     was blind to quotes, so `customer note = "sort me"` split at the `sort`
     inside the value: everything from that word became a clause, the
     condition was cut in half, and adding a filter destroyed the query it was
     added to. `splitQuery` masks quoted spans and sorts boundaries by
     position, which is the behaviour the query bar has always had — there was
     no reason for this file to have a second, worse one. */
  const parts = splitQuery(query);
  const head = `${parts.table}${parts.filter ? ` ${parts.filter}` : ''}`.trim();
  const tailPieces = [parts.show ? ` ${parts.show}` : '', parts.sort ? ` ${parts.sort}` : '', parts.limit ? ` ${parts.limit}` : ''];
  const tail = tailPieces.join('');

  const equality = condition.match(new RegExp(`^${escapeRe(column)}\\s*=\\s*(.+)$`));
  if (equality) {
    const value = equality[1].trim();
    /* Found by splitting the conditions rather than by matching a value with
       a regex. The regex read a value as `\\S+` — one token — which is most
       values and not all of them: `hired_on = this year` matched `this`, and
       folding it into a list replaced only that much, leaving

           employee hired_on in (this, last 7 days) year

       — text the parser cannot read, which came back as "0 rows" rather than
       as an error. A filter UI that silently empties the table is the thing
       this module exists to prevent, and it was doing it. */
    const existing = conditionOn(head, column, table);

    if (existing && existing.op === 'in') {
      if (existing.values.includes(value)) return `${head}${tail}`;
      /* A value that cannot sit in a list does not join one. */
      if (!listable(value)) return `${replaceCondition(head, table, existing, condition)}${tail}`;
      const merged = `${column} in (${[...existing.values, value].join(', ')})`;
      return `${replaceCondition(head, table, existing, merged)}${tail}`;
    }
    if (existing && existing.op === '=') {
      if (existing.value === value) return `${head}${tail}`;
      /* Two values fold into `in (…)` only when both are things a list can
         hold. A relative date phrase is not one: `last 7 days` is a *range*,
         and "hired in this year or in the last seven days" is not what
         picking a second period from a menu of periods means — picking one
         replaces the last. It is also not expressible, which is how the bug
         above announced itself. */
      if (!listable(value) || !listable(existing.value)) {
        return `${replaceCondition(head, table, existing, condition)}${tail}`;
      }
      const merged = `${column} in (${existing.value}, ${value})`;
      return `${replaceCondition(head, table, existing, merged)}${tail}`;
    }
  }

  /* A null check replaces any other condition on the same column: `x is
     empty and x = 3` is a contradiction, not a refinement. */
  const nullCheck = condition.match(new RegExp(`^${escapeRe(column)}\\s+is\\s+(not\\s+)?empty$`, 'i'));
  if (nullCheck) {
    const stripped = stripConditionsOn(head, column, table);
    return `${stripped}${stripped.trim() === table ? '' : ' and'} ${condition}${tail}`;
  }

  if (head === table) return `${head} ${condition}${tail}`;
  return `${head} and ${condition}${tail}`;
}

/**
 * Can this value sit inside `in (…)`?
 *
 * A bare token or a quoted string. Anything else — a relative date phrase, a
 * range, an unquoted value with a space in it — is not a list member, and the
 * list it would be written into is text no parser here accepts.
 */
function listable(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  /* Spelled out rather than as one regex: a quote character inside a regex
     literal is indistinguishable from the start of a string to anything
     reading this file with a tokenizer simpler than a parser, and
     `check-client-imports` is exactly that. */
  const quote = String.fromCharCode(34);
  if (text.startsWith(quote) && text.endsWith(quote) && text.length > 1) {
    return !text.slice(1, -1).includes(quote);
  }
  return !/[\s,()]/.test(text);
}

/**
 * The one top-level condition on `column`, split the way the parser splits.
 *
 * Returns its exact text, so it can be swapped out without a regex having to
 * work out where a value ends — which is the mistake this file has now made
 * twice, once on quotes and once on multi-word values.
 */
function conditionOn(head, column, table) {
  const body = head.slice(table.length).trim();
  const on = new RegExp(`^${escapeRe(column)}\\s*(=|\\bin\\b)`, 'i');
  for (const part of splitConditions(body)) {
    const text = part.trim();
    if (!on.test(text)) continue;
    const list = text.match(new RegExp(`^${escapeRe(column)}\\s+in\\s*\\(([^)]*)\\)$`, 'i'));
    if (list) {
      return {
        text,
        op: 'in',
        values: list[1]
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      };
    }
    const eq = text.match(new RegExp(`^${escapeRe(column)}\\s*=\\s*(.+)$`, 'i'));
    if (eq) return { text, op: '=', value: eq[1].trim() };
  }
  return null;
}

/** Swap one condition for another, leaving every other condition alone. */
function replaceCondition(head, table, existing, next) {
  const body = head.slice(table.length).trim();
  const parts = splitConditions(body).map((part) => (part.trim() === existing.text ? next : part.trim()));
  return `${table} ${parts.join(' and ')}`.trim();
}

/**
 * Remove every top-level condition mentioning `column`.
 *
 * Split by `splitConditions`, which tracks quotes and parentheses. Splitting
 * on `\s+and\s+` took `name = "a and b"` apart in the middle of a value, and
 * took `(a = 1 and b = 2)` apart inside a group it was supposed to leave
 * whole — turning one condition the reader wrote into two the parser could
 * not read.
 */
function stripConditionsOn(head, column, table) {
  const body = head.slice(table.length).trim();
  const kept = splitConditions(body).filter((part) => !new RegExp(`^${escapeRe(column)}\\b`, 'i').test(part.trim()));
  return kept.length ? `${table} ${kept.join(' and ')}` : table;
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
