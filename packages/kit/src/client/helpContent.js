/**
 * What the query-language panel says: the grammar, and examples built from the
 * connected schema. Loaded with the panel (components/HelpPanel.tsx), the first
 * time it opens; help.js, which binds `?` and the menu entries, is all the
 * first page carries.
 */
import { $, api, columnKind, labelColumn, looksLikeDateColumn, primaryKey, quote, state } from './core.js';
import { say } from './copy/help/helpContent.js';

/* Enough rows to see whether a column is categorical — two distinct values out
   of five says `status`, five out of five says `reference` — and few enough
   that the request costs nothing on a table with a million rows in it. */
const SAMPLE_ROWS = 5;

/* ---------- schema reading ----------

   Mirrors of shared/schema.ts, the way core.js already mirrors `labelColumn`.
   The client cannot import the TypeScript directly and there is no build step
   to compile it, so the rule is the one core.js follows: mirror the small
   derived helpers, and never let a mirror decide anything the server has
   already decided. */

/* Was a third copy of the date test, with the same name pattern and a
   narrower type test: `/char|text|varchar|string/` rather than the shared
   classifier, so a `uuid`, `json`, `enum` or `clob` column named `created_at`
   was a date to the server and to the query bar and not to the examples on
   this page. The classifier is one function; asking it is cheaper than
   keeping a copy honest. */
const isDate = (column) => looksLikeDateColumn(column);
const isNumber = (column) => columnKind(column.type) === 'number';
const isText = (column) => columnKind(column.type) === 'text';

/**
 * Forward hops worth putting in an example.
 *
 * Two exclusions:
 *
 *   - a composite key, whose hop name is its columns joined with `+`. The bar
 *     does take `invoice_id+line_no.sku`, but a two-column key is not what
 *     somebody meeting the dot for the first time should be reading — the
 *     point of the example is that a dot follows a reference, and a `+` in the
 *     middle of it is a second thing to explain before the first one lands.
 *   - two keys sharing a hop name, which `resolvePath` refuses as ambiguous
 *     rather than guessing. Emitting one would be emitting an error.
 */
function hops(schema, tableId) {
  const forward = schema.foreignKeys.filter((fk) => fk.from.table === tableId && fk.from.columns.length === 1);
  const counts = new Map();
  for (const fk of forward) counts.set(fk.from.columns[0], (counts.get(fk.from.columns[0]) ?? 0) + 1);
  const incoming = (id) => schema.foreignKeys.filter((fk) => fk.to.table === id).length;

  return (
    forward
      .filter((fk) => counts.get(fk.from.columns[0]) === 1)
      .map((fk) => ({ name: fk.from.columns[0], target: fk.to.table }))
      /* Ordered here rather than taken as introspection left it. SQLite's
       `PRAGMA foreign_key_list` hands back the *last* declared key first, so
       the unordered version picked `duplicate_of_id` out of a ticket table
       with nine references on it — a legal walk into "the ticket this one
       duplicates", which is nobody's first question.

       A self-reference goes last, and otherwise the most-pointed-at table
       wins: the table half the schema references is the one the schema is
       about, and a walk into it is a walk somebody recognises. */
      .sort(
        (a, b) =>
          (a.target === tableId ? 1 : 0) - (b.target === tableId ? 1 : 0) ||
          incoming(b.target) - incoming(a.target) ||
          a.name.localeCompare(b.name),
      )
  );
}

const tableById = (schema, id) => schema.tables.find((t) => t.id === id);

/* ---------- values ----------

   Real values, from a handful of real rows. `status = open` teaches more than
   `status = <value>`, and — the part that matters — it is a link that returns
   rows when clicked, because the value came out of the table it filters. */

/* Words the clause scanner will take as clauses wherever they appear.
   `CLAUSE_RE` runs over the raw text before anything knows about quotes, so a
   status of "order by" would be read as a sort clause and the example would
   fail. Such a value is skipped rather than emitted and hoped for. */
const RESERVED = /(^|\s)(filter|where|show|select|sort|order|by|limit|and|or|not|is|in|like|contains|startswith|endswith|asc|desc)(\s|$)/i;

/** Whether a sampled value can be written into a query as a literal. */
function usable(value) {
  if (value === null || value === undefined || typeof value === 'object') return false;
  const text = String(value);
  /* Long values make an unreadable example, and a quote inside one has no
     escape in this grammar — `unquoteValue` strips the outer pair and nothing
     else, so the value would end mid-word. */
  return text !== '' && text.length <= 24 && !/["'\n]/.test(text) && !RESERVED.test(text);
}

/* A comma inside a value breaks an `in` list and only an `in` list: the list
   is split on commas before anything looks at the quotes around them. */
const listSafe = (value) => !value.includes(',');

/**
 * A sampled value, written the way someone would type it.
 *
 * The one rewrite is a flag: SQLite has no boolean type, so `is_urgent` comes
 * back as 1 and 0, and `is_urgent = 0` is an example that needs the column's
 * storage explained before it teaches anything. The compiler coerces `false`
 * to whatever the column actually holds — that is the whole point of it
 * holding the schema — so the readable form is also the correct one.
 */
function literal(column, value) {
  const flag = /bool/i.test(column.type ?? '') || /^(is|has)_/i.test(column.name);
  if (flag && /^(0|1|true|false)$/i.test(value)) return /^(1|true)$/i.test(value) ? 'true' : 'false';
  return quote(value);
}

function valuesOf(rows, column) {
  const seen = [];
  for (const row of rows ?? []) {
    const value = row?.[column];
    if (!usable(value)) continue;
    if (!seen.includes(String(value))) seen.push(String(value));
  }
  return seen;
}

/** A round number below the smallest value seen, so `>=` cannot miss. */
function roundDown(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  const magnitude = 10 ** Math.floor(Math.log10(n));
  return Math.floor(n / magnitude) * magnitude;
}

/* ---------- choosing what to talk about ---------- */

/**
 * The table the examples are mostly about.
 *
 * A hub with outgoing references and a readable label column, because that is
 * the table where every part of the language has something to say: it has
 * columns worth filtering, a reference worth walking, and a name worth
 * showing. Picking the first table alphabetically gets you `address` on a
 * schema whose story is `sales_order`.
 *
 * Views rank below tables — a view is someone's saved answer, and the first
 * thing a newcomer should see is the shape of the data.
 */
function rank(schema, table) {
  const out = Math.min(hops(schema, table.id).length, 3);
  const incoming = Math.min(schema.foreignKeys.filter((fk) => fk.to.table === table.id).length, 6);
  const label = labelColumn(table);
  const named = label && !primaryKey(table).includes(label);
  /* Text that is neither a key nor a foreign key: the columns somebody would
     actually filter on. Without this the winner on the demo schema was
     `invoice_line`, a junction table whose every column is a key — a table
     with plenty of edges and nothing to say about any of them. */
  const readable = table.columns.some((c) => isText(c) && !c.primaryKey && !c.references && !isDate(c));
  return out * 3 + incoming + (named ? 4 : 0) + (readable ? 4 : 0) + (table.columns.some(isDate) ? 2 : 0) - (table.isView ? 8 : 0);
}

/**
 * The table an example should be about.
 *
 * @param {{ tables: import('@mistriwork/engine/shared/schema.js').TableMeta[] }} schema
 * @param {(table: import('@mistriwork/engine/shared/schema.js').TableMeta) => number} [extra]
 *   An extra score, so a caller can prefer tables that suit its own example —
 *   typed because the default takes no arguments and every caller passes one.
 */
function bestTable(schema, extra = () => 0) {
  let best = null;
  let bestScore = -Infinity;
  for (const table of schema.tables) {
    const score = rank(schema, table) + extra(table);
    // Ties break on the earlier table, so the same schema always produces the
    // same examples — an example that moves between reloads reads as a bug.
    if (score > bestScore) {
      best = table;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The deepest readable path out of a table, up to two hops.
 *
 * Two rather than one wherever the graph allows, because one hop is easy to
 * read as a join column and two is unmistakably a walk. The last segment has
 * to be a label — `customer_id.party_id.display_name` is a sentence,
 * `customer_id.party_id.id` is a number nobody asked for.
 */
function bestPath(schema, tableId) {
  let best = null;
  for (const first of hops(schema, tableId)) {
    const target = tableById(schema, first.target);
    if (!target) continue;
    const label = labelColumn(target);
    if (label) best = best ?? { path: `${first.name}.${label}`, hops: 1, table: target.id };

    for (const second of hops(schema, target.id)) {
      // A path that returns to where it started says nothing about the graph.
      if (second.target === tableId || second.target === target.id) continue;
      const further = tableById(schema, second.target);
      const deep = further && labelColumn(further);
      if (!deep) continue;
      const column = further.columns.find((c) => c.name === deep);
      if (column && !isText(column)) continue;
      return { path: `${first.name}.${second.name}.${deep}`, hops: 2, table: further.id };
    }
  }
  return best;
}

/**
 * The table the dot-walk example should start from.
 *
 * The hub if it has a path, because keeping every example on one table means
 * the reader learns one schema rather than five. But a two-hop path is worth
 * changing table for: one hop still reads as a join column, and two is
 * unmistakably a walk.
 */
function walkFrom(schema, hub) {
  const pathAt = (table) => (table ? bestPath(schema, table.id) : null);
  if (pathAt(hub)?.hops === 2) return hub;

  const deep = bestTable(schema, (t) => (bestPath(schema, t.id)?.hops === 2 ? 40 : 0));
  if (pathAt(deep)?.hops === 2) return deep;
  if (pathAt(hub)) return hub;

  const any = bestTable(schema, (t) => (bestPath(schema, t.id) ? 40 : 0));
  return pathAt(any) ? any : null;
}

/** The column a filter example should use: the most categorical one there is. */
function filterColumn(table, rows) {
  /* A numeric foreign key is excluded on purpose. `customer_id = 6` is a
     legal filter and a terrible example: reaching a row by the number in its
     key column is the thing dot-walking exists to replace. A *text* key —
     `currency_code = AUD` — is a code someone can read, and stays. */
  const candidates = table.columns.filter((c) => !c.primaryKey && !isDate(c) && (isText(c) || (isNumber(c) && !c.references)));
  if (!candidates.length) return null;

  if (rows?.length) {
    /* Fewest distinct values wins: over five sampled rows `status` shows two
       and `reference` shows five, which is the difference between a filter
       that reads like a question and one that reads like a key lookup.
       Text breaks the tie, because `status = open` says what it means and
       `active = 1` needs the schema open beside it.

       An unfilled column is charged for every row it has nothing in. A column
       that is null four times out of five has one distinct value and would
       otherwise win outright — which is how `external_ref = EXT-10913`, an
       external system's identifier for one row, came to be the first thing
       the landing page taught. */
    const cost = (c) => c.values.length + (rows.length - c.filled) + (isText(c.column) ? 0 : 2);
    const scored = candidates
      .map((column) => ({
        column,
        values: valuesOf(rows, column.name),
        filled: rows.filter((row) => usable(row?.[column.name])).length,
      }))
      .filter((c) => c.values.length)
      .sort((a, b) => cost(a) - cost(b) || a.values[0].length - b.values[0].length);
    if (scored.length) return scored[0];
  }

  const named = candidates.find((c) => /status|state|type|kind|category|code|active|priority/i.test(c.name));
  return { column: named ?? candidates[0], values: [] };
}

/** A column that is null somewhere in the sample, so `is empty` finds rows. */
function nullableColumn(table, rows) {
  const optional = table.columns.filter((c) => !c.primaryKey && c.nullable !== false);
  if (!optional.length) return null;
  const empty = optional.find((c) => (rows ?? []).some((row) => row?.[c.name] === null));
  return empty ?? optional[0];
}

/**
 * A column that is never null, for the second half of an `and`.
 *
 * The point of that example is the word `and`, so the condition beside it has
 * to be one that cannot change the answer: `is not empty` on a NOT NULL column
 * is true of every row, which leaves the example returning exactly what its
 * first condition returned. Pairing two selective conditions instead gave a
 * demonstration of `and` that came back with nothing in it.
 */
function requiredColumn(table, rows) {
  const declared = table.columns.filter((c) => c.nullable === false && !c.primaryKey);
  if (declared.length) return declared[0];
  return (
    table.columns.find(
      (c) => !c.primaryKey && (rows ?? []).length && (rows ?? []).every((row) => row?.[c.name] !== null && row?.[c.name] !== undefined),
    ) ?? null
  );
}

const dateColumn = (table) => table.columns.find(isDate);

/**
 * A date window wide enough to reach the newest row the sample saw.
 *
 * `last 30 days` on a database whose most recent row is a year old is a
 * correct query that returns nothing, and nothing is what a beginner reads as
 * "this feature does not work". The window is widened to the first phrase that
 * covers the data — still a phrase somebody would type, not a computed date.
 */
const WINDOWS = [
  { label: 'last 30 days', days: 30 },
  { label: 'last 90 days', days: 90 },
  { label: 'last 6 months', days: 183 },
  { label: 'last 12 months', days: 366 },
  { label: 'last 24 months', days: 731 },
  { label: 'last 60 months', days: 1827 },
];

function dateWindowFor(values, now) {
  const newest = (values ?? [])
    .map((value) => new Date(String(value)).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a)[0];
  if (newest === undefined) return WINDOWS[0].label;
  const age = (now.getTime() - newest) / 86_400_000;
  return (WINDOWS.find((w) => w.days >= age) ?? WINDOWS[WINDOWS.length - 1]).label;
}

/* ---------- the generator ---------- */

/**
 * Every example the panel and the empty state can offer, from a schema and
 * (optionally) a few sampled rows.
 *
 * A pure function of its arguments, which is what makes it testable without a
 * browser: the fixtures in test/help.test.ts include a schema with no foreign
 * keys, which is the shape that would otherwise emit a dot-walk example that
 * errors the moment someone clicked it.
 *
 * Keys are absent rather than empty when the schema cannot support them. A
 * caller that renders whatever it finds degrades on its own.
 *
 * @typedef {{query: string, caption: string}} Example
 * @typedef {{
 *   sampleTable: string | null,
 *   examples: Record<string, Example>,
 *   starters: Array<Example & {key: string}>,
 * }} Examples
 *
 * @param {any} schema
 * @param {Record<string, Array<Record<string, unknown>>>} [samples]
 * @param {Date} [now] injected, so a date window is testable to the day
 * @returns {Examples}
 */
export function buildExamples(schema, samples = {}, now = new Date()) {
  /** @type {Examples} */
  const out = { sampleTable: null, examples: {}, starters: [] };
  if (!schema?.tables?.length) return out;

  const hub = bestTable(schema);
  if (!hub) return out;
  out.sampleTable = hub.id;

  const rows = samples[hub.id] ?? [];
  const examples = out.examples;
  const add = (key, query, caption) => {
    examples[key] = { query, caption };
  };

  add('table', hub.id, `every row in ${hub.name}`);

  /* ---- filters ---- */

  const chosen = filterColumn(hub, rows);
  const column = chosen?.column;
  const values = chosen?.values ?? [];

  if (column && values.length) {
    add('filter', `${hub.id} ${column.name} = ${literal(column, values[0])}`, 'a column, an operator, a value');
    if (values.length > 1) {
      add('or', `${hub.id} ${column.name} = ${literal(column, values[0])} or ${column.name} = ${literal(column, values[1])}`, 'either one');
      const list = values.filter(listSafe).slice(0, 2);
      if (list.length > 1) {
        add('in', `${hub.id} ${column.name} in (${list.map((v) => literal(column, v)).join(', ')})`, 'the same thing, shorter');
      }
    }
  } else if (column) {
    add('filter', `${hub.id} ${column.name} is not empty`, 'rows where the column is set');
  }

  const label = labelColumn(hub);
  const labelValues = label ? valuesOf(rows, label) : [];
  if (label && labelValues.length) {
    /* Both of these are cut out of a value that is in the table, so both come
       back with rows. A guessed word would not, and a filter that silently
       matches nothing is the exact failure this language was built to avoid.

       `contains` prefers what the sampled values have in common — `TKT-90`
       out of TKT-9014 and TKT-9060 — because the shared part is the part
       worth searching for. Where they share nothing, the first word of the
       first value is a real word out of the column: `contains Harbour`. */
    const shared = labelValues.length > 1 ? commonPrefix(labelValues).trim() : '';
    const word = shared.length >= 3 ? shared : labelValues[0].split(/\s+/)[0];
    const front = labelValues[0].slice(0, 3).trim();
    if (word && !RESERVED.test(word)) add('contains', `${hub.id} ${label} contains ${quote(word)}`, 'anywhere in the text');
    if (front.length >= 2 && front !== word && !RESERVED.test(front)) {
      add('startswith', `${hub.id} ${label} startswith ${quote(front)}`, 'at the front of it — endswith too');
    }
  }

  /* A quantity, not a key: `total >= 10000` is a question somebody might ask
     and `customer_id >= 1` is arithmetic on an identifier. */
  const numbers = hub.columns.filter((c) => isNumber(c) && !c.primaryKey && !c.references);
  const number = numbers.find((c) => /total|amount|price|cost|qty|quantity|balance|limit|value/i.test(c.name)) ?? numbers[0];
  /* Rounded down from the smallest value in the sample, so the comparison
     cannot come back empty on the table it was built from. */
  const floor = number ? roundDown(Math.min(...valuesOf(rows, number.name).map(Number).filter(Number.isFinite))) : null;
  if (number && floor !== null) add('compare', `${hub.id} ${number.name} >= ${floor}`, 'the ordering operators, on numbers and on dates');

  const optional = nullableColumn(hub, rows);
  if (optional) add('empty', `${hub.id} ${optional.name} is empty`, 'nothing recorded — is not empty for the opposite');

  const required = requiredColumn(hub, rows);
  if (column && values.length && required && required.name !== column.name) {
    const first = `${column.name} = ${literal(column, values[0])}`;
    add('and', `${hub.id} ${first} and ${required.name} is not empty`, 'both conditions');
    if (values.length > 1) {
      add(
        'brackets',
        `${hub.id} (${column.name} = ${literal(column, values[0])} or ${column.name} = ${literal(column, values[1])}) and ${required.name} is not empty`,
        'or binds loosest, so brackets change the grouping',
      );
    }
  }

  /* ---- references ---- */

  const walk = walkFrom(schema, hub);
  const path = walk && bestPath(schema, walk.id);
  if (walk && path) {
    const shown = labelColumn(walk) ?? primaryKey(walk)[0] ?? walk.columns[0]?.name;
    const hopped = path.hops === 2 ? say('twoTablesAlong') : say('onTheTableItPoints');
    add('dotwalk', `${walk.id} show ${shown}, ${path.path}`, `a column ${hopped}`);
    add('dotfilter', `${walk.id} ${path.path} is not empty`, 'filtering across the reference');
  }

  /* ---- projection, order, limit, dates ---- */

  /* The columns a person would read a row by, not the first three declared:
     a projection example whose point is `show id, customer_id, quote_id` has
     demonstrated the keyword and taught nothing about the table. */
  const readable = hub.columns.filter((c) => !c.references && (c.name === label || !c.primaryKey));
  const shortlist = [...new Set([label, ...readable.map((c) => c.name)].filter(Boolean))].slice(0, 3);
  if (shortlist.length > 1) add('show', `${hub.id} show ${shortlist.join(', ')}`, 'only these columns, in this order');

  const dated = dateColumn(hub) ? hub : schema.tables.find((t) => !t.isView && dateColumn(t));
  const date = dated && dateColumn(dated);
  if (date) {
    add('sort', `${dated.id} sort ${date.name} desc limit 10`, 'the ten most recent');
    // Only the sampled table has values to measure; anywhere else the window
    // is the one people reach for first.
    const phrase =
      dated.id === hub.id
        ? dateWindowFor(
            rows.map((row) => row?.[date.name]),
            now,
          )
        : WINDOWS[0].label;
    add('dates', `${dated.id} ${date.name} = ${phrase}`, 'a window, resolved to two real timestamps');
  } else if (label) {
    add('sort', `${hub.id} sort ${label} limit 10`, 'ten rows, in order');
  }

  add('limit', `${hub.id} limit 5`, 'stop after five');

  /* ---- the three for the empty state ----

     A filter, a walk and an order: the three things the language does that a
     list of tables cannot, in the order someone meets them. Anything the
     schema cannot support is skipped rather than faked, and the bare table
     name backfills — on a database with no foreign keys the landing page
     offers three queries that work rather than two that do and one that
     would have errored on the first click. */
  for (const key of ['filter', 'dotwalk', 'sort', 'table']) {
    if (examples[key] && out.starters.length < 3) out.starters.push({ key, ...examples[key] });
  }

  return out;
}

function commonPrefix(values) {
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && prefix[i] === value[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

/* ---------- sampled rows ---------- */

/* Keyed by connection as well as table: the same table name means a different
   table on the next database, and examples built from the last one would be
   quietly wrong. Promises rather than rows, so the panel and the empty state
   opening together make one request. */
const sampled = new Map();

function sampleKey(tableId) {
  return `${state.activeConnection ?? state.schema?.label ?? ''} ${tableId}`;
}

export function sampleRows(tableId) {
  const key = sampleKey(tableId);
  if (!sampled.has(key)) {
    sampled.set(
      key,
      api('/api/run', { q: tableId, limit: SAMPLE_ROWS, count: 'none' })
        .then((data) => data.rows ?? [])
        /* An empty table, a permission error, a connection that dropped: the
           examples fall back to the value-free forms rather than the panel
           failing to open. */
        .catch(() => []),
    );
  }
  return sampled.get(key);
}

/* ---------- running an example ---------- */

/**
 * Put the example in the bar and run it.
 *
 * Through the form rather than by navigating directly, for the reason
 * history.js gives for the same move: the one submit handler in app.js decides
 * what a query means, and a second caller deciding it separately is how the
 * two start to disagree. Leaving the text in the bar is the point — the next
 * thing to do with an example is edit it.
 */
export function runExample(query) {
  const input = $('query');
  if (!input) return;
  input.value = query;
  $('querybar').requestSubmit();
  input.focus();
  input.setSelectionRange(query.length, query.length);
}

/* ---------- the empty state ---------- */

/**
 * Three runnable queries on the landing page.
 *
 * The empty state used to be a sentence and a diagram, which tells you the
 * tool is about relationships and leaves you to guess the grammar. A diagram
 * answers "what is in here"; these answer "what do I type".
 */
/* ---------- the panel ---------- */

/**
 * What each section says, and which generated examples belong under it.
 *
 * The grammar lines are fixed text and the examples are not: syntax is the
 * same on every database, and what is worth filtering is not. Anything named
 * here that the schema could not produce simply does not appear, which is why
 * the keys are a list rather than a template with holes in it.
 */
export const SECTIONS = [
  {
    title: say('startWithATable'),
    note: say('theTableComesFirst'),
    grammar: [['table', say('everyRowInASensible')]],
    keys: ['table'],
  },
  {
    title: say('common.filter'),
    note: say('aConditionStraightAfter'),
    grammar: [
      ['column = value', say('alsoOperators')],
      ['column contains text', say('anywhereInItWhatever')],
      ['column startswith text', say('endswithToo')],
      [say('columnLikeWh'), say('yourOwnWildcardsAny')],
      ['column in (a, b)', say('anyOfThemNotInForNone')],
      ['column between a and b', say('aRangeBothEnds')],
      ['column is empty', say('nullIsNotEmpty')],
      ['column = "two words"', say('quoteAValueWithSpaces')],
    ],
    keys: ['filter', 'contains', 'startswith', 'like', 'compare', 'empty', 'in', 'between'],
  },
  {
    title: say('combine'),
    note: say('andBindsTighterThan'),
    grammar: [
      [say('aAndB'), 'both'],
      [say('aOrB'), 'either'],
      ['(a or b) and c', 'grouped'],
    ],
    keys: ['and', 'or', 'brackets'],
  },
  {
    title: say('walkAReference'),
    note: say('aDotFollowsAForeign'),
    grammar: [
      ['reference.column', say('aColumnOnTheTable')],
      ['reference.reference.column', say('twoTablesAlong')],
    ],
    keys: ['dotwalk', 'dotfilter'],
    absent: say('thisDatabaseHasNoForeign'),
  },
  {
    title: say('showOnlySomeColumns'),
    note: say('showPicksTheColumns'),
    grammar: [[say('showABC'), say('theseColumnsInThisOrder')]],
    keys: ['show'],
  },
  {
    title: say('sortAndLimit'),
    note: say('orderByIsAccepted'),
    grammar: [
      ['sort column', 'ascending'],
      ['sort column desc', 'descending'],
      ['sort a, b desc', say('moreThanOne')],
      ['limit 20', say('atMostThisMany')],
    ],
    keys: ['sort', 'limit'],
  },
  {
    title: say('dates'),
    note: say('aDatePhraseIsAWindow'),
    grammar: [
      ['today', 'yesterday, tomorrow'],
      ['this week', say('lastWeekWeeksStart')],
      ['this month', 'last month, this year, last year'],
      ['this quarter', 'last quarter, next quarter'],
      ['last 30 days', 'last 12 hours, last 6 weeks, last 3 months'],
      ['next 7 days', say('theSameUnitsForwards')],
      ['previous 30 days', say('theWindowJustBefore')],
    ],
    keys: ['dates'],
    absent: say('noTableHereHasADate'),
  },
  {
    /* Not generated from the schema, so no `keys` and nothing to be absent:
       these work on every result in every database. They live here because
       the alternative was a hint line under every table, and a permanent
       instruction is a poor trade for the space it takes from the data. */
    title: say('movingAroundAResult'),
    note: say('tabIntoTheTable'),
    /* `rooms`: where a section's keys apply, so the panel puts it first
       there. `app`: shown in an App's keys-only panel as well. */
    rooms: ['table'],
    app: true,
    grammar: [
      ['↑ ↓ ← →', say('moveOneCell')],
      ['Enter', say('openTheRecordForThatRow')],
      ['Space', say('glanceAtThatRows')],
      ['⌘C', say('copyTheCellUnder')],
      [say('homeEnd'), say('firstAndLastColumn')],
      ['Esc', say('backToTheQuery')],
    ],
  },
  {
    /* A record opened from a list steps through that list: the move a mail
       reader's J and K make, and the arrows beside the record's name. */
    title: say('steppingThroughAList'),
    note: say('aRecordOpenedFromAList'),
    rooms: ['row', 'page'],
    app: true,
    grammar: [
      ['j', say('theNextRecordInTheList')],
      ['k', say('thePreviousRecord')],
      ['← →', say('theSameWithTheArrows')],
    ],
  },
  {
    /* Every shortcut the page itself binds, in the one place someone looks
       for one. They were discoverable only by reading the source or by
       pressing a key and seeing what happened — and `h` for home is the sort
       of thing nobody guesses. A hint line under the header would cost the
       space permanently; a section in the panel that answers "what can I
       press" costs nothing until asked. */
    title: say('keysThePageListens'),
    note: say('singleKeysWorkWhen'),
    grammar: [
      ['h', say('homeTheSchemaYourWork')],
      ['/', say('theQueryBar')],
      ['⌘/', say('theQueryBarAsAPanel')],
      ['t', say('theTableFilterInTheSidebar')],
      ['⌘K', say('theCommandPaletteTables')],
      ['⌘B', say('showOrHideTheTable')],
      ['Backspace', say('backOneStepAlong')],
      ['?', say('thisPanel')],
      ['Esc', say('leaveTheFieldOrClose')],
    ],
  },
  {
    /* The address bar has a grammar of its own, and nothing on screen taught
       it: `~30`, `!diagram` and `@page~root` were sigils you could only learn
       by watching the bar change as you clicked. They are worth writing by
       hand — a hash is a place you can send someone — so they are worth
       documenting where the rest of the language lives. */
    title: say('linksYouCanWrite'),
    note: say('theFirstSegmentIsTheConnection'),
    grammar: [
      ['/erp/customer', say('aTableAnyQuery')],
      ['/erp/customer/~42', say('aRowOfTheTable')],
      ['/erp/customer/~42/~invoice:9', say('anotherTablesRowNames')],
      ['/erp/customer!diagram', say('aTabRowsDdl')],
      ['/erp/@customer~42', say('aPageById')],
    ],
  },
];
