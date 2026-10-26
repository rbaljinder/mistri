/**
 * A breakdown, written down.
 *
 * The same argument the view text form makes, and it applies harder here: a
 * breakdown is the shape most likely to be pasted into a conversation, saved
 * in a config file, or handed to an agent as a string. A grouping that can
 * only be expressed as JSON is one nobody writes by hand.
 *
 *     invoice  count  by status
 *     invoice  count, sum total as billed  by month invoice_date  sort billed desc  limit 12
 *     invoice  where total > 100  count  by customer_id.country_code.name as country
 *
 * The grammar is the query language plus two clauses. Measures come first —
 * `count`, `count distinct sold_by`, `sum total`, each optionally `as name` —
 * then `by`, then the things to group by, each optionally cut down to a period
 * (`by month invoice_date`) and optionally named. Everything else in the line
 * is the ordinary language: `where`, `sort`, `limit`, parsed by
 * `parseViewQuery` exactly as the composer's filter box parses it. Two parsers
 * for one language is how a language starts disagreeing with itself.
 *
 * One deliberate asymmetry with a view: **`sort` names an output column**, not
 * a path. Every column of a breakdown is a key or a measure and both are in
 * the answer under a name, so there is nothing else it could mean — and `sort
 * total desc` on a grouped statement, where `total` is no longer a column,
 * should not quietly compile into something else.
 */
import { parseViewQuery, tryResolvePath, type ViewFilter } from './view.js';
import { findTable, type DatabaseSchema } from './schema.js';
import type { QueryError, QueryPerson } from './query.js';
import {
  DATE_UNITS,
  MEASURE_FUNCTIONS,
  type BreakdownDef,
  type BreakdownKey,
  type BreakdownOrder,
  MEASURE_OPS,
  measureName,
  measurePaths,
  measureRefusal,
  measureToText,
  type Measure,
  type MeasureFn,
  type MeasureOp,
  type MeasureTerm,
} from './breakdown.js';

interface ParsedBreakdownText {
  breakdown?: BreakdownDef;
  /** The conditions half of the line, exactly as typed — everything
      before the measures. The section emitter's whole reason to exist
      here: only the parser knows where that boundary fell. */
  conditions?: string;
  errors: QueryError[];
}

/** Whether a line is asking for a breakdown at all. */
export function looksLikeBreakdown(text: string): boolean {
  /* The `by` keyword, standing alone and not the tail of `order by`. That is
     the whole tell: no other clause in the language uses it, which is why it
     was available to mean this. */
  return /(?<!\border\s)\bby\s+\S/i.test(String(text ?? ''));
}

const TERM_RE = new RegExp(
  String.raw`^(${MEASURE_FUNCTIONS.join('|')})` +
    String.raw`(\s+distinct)?` +
    /* `+` for a composite hop (`invoice_id+line_no.qty`); an operator stands apart, between spaces. */
    String.raw`(?:\s+([\w.$+]+))?` +
    /* `count when [status = open]`, its brackets already lifted out (liftWhens): the mark of the n-th. */
    String.raw`(?:\s+when\s+\uE000(\d+)\uE001)?$`,
  'i',
);
const NUMBER_RE = /^\d+(?:\.\d+)?$/;

/**
 * The conditions of every `when [...]` lifted out of the line and replaced by a mark with no spaces, commas or keywords
 * in it: a condition holds `in (a, b)`, `and`, even the word `by`, and the line is split on exactly those. Quotes are
 * respected, so a `]` in a value does not close it. Nested brackets are not a thing the language has.
 */
function liftWhens(text: string): { text: string; whens: string[]; error?: string } {
  const whens: string[] = [];
  let out = '';
  let from = 0;
  for (const found of text.matchAll(/\bwhen\s*\[/gi)) {
    const open = (found.index ?? 0) + found[0].length;
    if (open <= from) continue;
    let quote = '';
    let close = -1;
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ']') {
        close = i;
        break;
      }
    }
    if (close < 0) return { text, whens, error: '`when [` is not closed: end the conditions with `]`.' };
    out += `${text.slice(from, found.index)}when \uE000${whens.length}\uE001`;
    whens.push(text.slice(open, close).trim());
    from = close + 1;
  }
  return { text: out + text.slice(from), whens };
}

/**
 * One comma piece as a measure, or null when it is not one: an aggregate
 * (`sum total`), or aggregates and numbers joined by `+ - * /` — a
 * computed measure, `sum paid / sum total as rate`. The first term is an
 * aggregate, so a condition's trailing number is never read as one.
 */
function measureFrom(piece: string, whens: readonly string[]): Measure | null {
  const aliased = /^(.*?)\s+as\s+([\w$]+)$/i.exec(piece);
  const body = aliased ? aliased[1] : piece;
  const parts = body.trim().split(/\s+([+\-*/])\s+/);
  const term = (text: string): MeasureTerm | null => {
    const m = TERM_RE.exec(text.trim());
    return m
      ? {
          fn: m[1].toLowerCase() as MeasureFn,
          ...(m[3] ? { path: m[3] } : {}),
          ...(m[2] ? { distinct: true } : {}),
          ...(m[4] !== undefined && whens[Number(m[4])] !== undefined ? { when: whens[Number(m[4])] } : {}),
        }
      : null;
  };
  const head = term(parts[0]);
  if (!head) return null;
  const steps: NonNullable<Measure['steps']> = [];
  for (let i = 1; i < parts.length; i += 2) {
    const op = parts[i] as MeasureOp;
    const text = parts[i + 1]?.trim() ?? '';
    const next = NUMBER_RE.test(text) ? Number(text) : term(text);
    if (!MEASURE_OPS.includes(op) || next === null) return null;
    steps.push({ op, term: next });
  }
  return { ...head, ...(steps.length ? { steps } : {}), ...(aliased ? { alias: aliased[2] } : {}) };
}

const KEY_RE = new RegExp(String.raw`^(?:(${DATE_UNITS.join('|')})\s+)?([\w.$+]+)(?:\s+as\s+([\w$]+))?$`, 'i');

/** Where the clauses after the group keys begin. */
const TAIL_CLAUSE = /\b(sort|order\s+by|limit)\b/i;

/**
 * Split `a, b, c` on commas, dropping the empties a trailing comma leaves.
 */
const commas = (text: string): string[] =>
  text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * Find the `by` that pivots the line.
 *
 * The *first* standalone `by` not preceded by `order`, because a breakdown's
 * `sort` clause comes after the keys and may legitimately be written `order
 * by`. Searching from the front means `invoice count by status order by count`
 * splits where it should.
 */
function pivot(text: string): number {
  for (const match of text.matchAll(/\bby\b/gi)) {
    const at = match.index ?? 0;
    if (/\border\s+$/i.test(text.slice(0, at))) continue;
    return at;
  }
  return -1;
}

export function textToBreakdown(
  schema: DatabaseSchema,
  text: string,
  options: { now?: Date; me?: QueryPerson | null } = {},
): ParsedBreakdownText {
  const errors: QueryError[] = [];
  const written = String(text ?? '').trim();
  if (!written) return { errors: [{ message: 'Start with a table name.' }] };
  const lifted = liftWhens(written);
  if (lifted.error) return { errors: [{ message: lifted.error }] };
  /* What the line is split on has no `when [...]` in it; `text` below keeps it as it was written. */
  const body = lifted.text;

  const baseName = body.split(/\s+/)[0];
  const base = findTable(schema, baseName) ?? schema.tables.find((t) => t.name === baseName);
  if (!base) {
    return { errors: [{ message: `No table called "${baseName}" in this database.`, at: 0 }] };
  }

  const rest = body.slice(baseName.length);
  const at = pivot(rest);
  /* No `by` is one group: "invoice sum total" is the whole answer as one
     row. The head is then everything before the tail clauses, and the key
     list is empty — the compiler skips GROUP BY for exactly this shape.
     A line with no measures either still gets the needs-`by` guidance
     below, because that line was not a breakdown at all. */
  const head = at === -1 ? (rest.search(TAIL_CLAUSE) === -1 ? rest : rest.slice(0, rest.search(TAIL_CLAUSE))) : rest.slice(0, at);
  const afterBy = at === -1 ? (rest.search(TAIL_CLAUSE) === -1 ? '' : rest.slice(rest.search(TAIL_CLAUSE))) : rest.slice(at + 2);

  /* The keys run to the first clause that is not a key. Split here rather
     than by counting commas, because a key list and a sort clause are both
     comma-separated and only a keyword tells them apart. */
  const tailAt = afterBy.search(TAIL_CLAUSE);
  const keyText = tailAt === -1 ? afterBy : afterBy.slice(0, tailAt);
  const tail = tailAt === -1 ? '' : afterBy.slice(tailAt);

  /* The measures are the longest suffix of `head` that reads as a list of
     them; everything before that is the ordinary language, and is handed on
     untouched. Found by trying each word boundary from the left and keeping
     the first that works, which is what makes `invoice where total > 100
     count by status` split correctly without this module knowing what `where`
     means.

     Splitting on commas alone was the obvious version and it was wrong: `where
     total > 100 count` holds no comma at all, so the whole clause read as one
     piece, failed to match, and the line came back "nothing to measure" with
     a `count` plainly in it. */
  const words = [...head.matchAll(/\S+/g)].map((m) => ({ text: m[0], at: m.index ?? 0 }));
  const measures: Measure[] = [];
  let prefix = head;
  for (const word of words) {
    const candidate = head.slice(word.at);
    const pieces = commas(candidate);
    const read = pieces.map((piece) => measureFrom(piece, lifted.whens));
    if (!pieces.length || read.some((m) => m === null)) continue;
    measures.push(...(read as Measure[]));
    prefix = head.slice(0, word.at);
    break;
  }
  if (!measures.length) {
    errors.push({
      message:
        at === -1
          ? 'A breakdown needs `by` — try `count by status` — or a bare measure for the whole answer: `sum total`.'
          : 'Nothing to measure before `by`. Try `count by …`, or `sum total by …`.',
    });
  }
  for (const measure of measures) {
    if (measure.when !== undefined) {
      if (measure.fn !== 'count' || measure.path || measure.distinct) {
        errors.push({ message: '`when` goes with a bare `count`: `count when [status = open]`.' });
        continue;
      }
      if (!measure.when) {
        errors.push({ message: '`when [` needs conditions before `]`, like `count when [status = open]`.' });
        continue;
      }
      /* The same parser, the same segments and the same clock as the line's own conditions. */
      const held = parseViewQuery(schema, base.id, measure.when, options.now, options.me !== undefined ? { me: options.me } : {});
      errors.push(...held.errors);
      if (!held.errors.length && (held.columns.length || held.orderBy.length || held.limit !== undefined))
        errors.push({ message: `\`when [${measure.when}]\` takes conditions only, not show, sort or limit.` });
      if (!held.errors.length) measure.where = held.filter as ViewFilter;
    }
    for (const fn of new Set([measure.fn, ...(measure.steps ?? []).flatMap(({ term }) => (typeof term === 'number' ? [] : [term.fn]))])) {
      /* Judged against the source's dialect here, so `check` names it at startup rather than a query failing at read. */
      const refused = measureRefusal(fn, schema.dialect);
      if (refused) errors.push({ message: refused });
    }
    for (const path of measurePaths(measure)) {
      const { error } = tryResolvePath(schema, base.id, path);
      if (error) errors.push({ message: error.message });
    }
  }

  const keys: BreakdownKey[] = [];
  for (const piece of commas(keyText)) {
    const match = KEY_RE.exec(piece);
    if (!match) {
      errors.push({
        message:
          `"${piece}" is not something to group by. A column, a path like customer_id.name, ` +
          `or a period like \`month invoice_date\` (day, week, month, quarter, year, weekday or hour).`,
      });
      continue;
    }
    const [, unit, path, alias] = match;
    /* Resolved here rather than left to the compiler. This runs on a
       keystroke and the compiler runs on a request, so a path caught here is
       a message under the caret and a path caught there is a failed call. */
    const { resolved, error } = tryResolvePath(schema, base.id, path);
    if (error) {
      errors.push({ message: error.message });
      continue;
    }
    /* The compiler refuses a bucket of a non-date too, but it refuses at
       request time; here is a keystroke, and an app manifest's startup,
       where "errors name the fix" is the contract. Same rule as the
       compiler's: the declared type, not the values. */
    if (unit && resolved && !/date|time/i.test(resolved.column.type ?? '')) {
      errors.push({
        message: `"${path}" is ${resolved.column.type || 'untyped'}, so it cannot be grouped by ${unit.toLowerCase()}. Pick a date column.`,
      });
      continue;
    }
    keys.push({
      path,
      bucket: unit ? (unit.toLowerCase() as BreakdownKey['bucket']) : undefined,
      alias: alias || undefined,
    });
  }
  /* With a `by` written, an empty key list is a mistake to name; with no
     `by` at all it is the one-group whole answer. */
  if (at !== -1 && !keys.length && !errors.length) {
    errors.push({ message: '`by` needs something after it — a column, or `month <date column>`.' });
  }

  /* The names this breakdown will answer under, so `sort billed desc` parses.
     Derived the same way the compiler derives them, because a sort that
     validates against one spelling and compiles against another is a sort
     that works until somebody adds an alias. */
  const names = [
    ...keys.map((k) => k.alias?.trim() || (k.bucket ? `${k.bucket}(${k.path})` : k.path)),
    ...measures.map((m) => measureName(m)),
  ];

  const parsed = parseViewQuery(schema, base.id, `${prefix} ${tail}`.trim(), options.now, {
    /* Every output name joins the synthetic table for the sort clause. A
       breakdown has no `show`, so nothing else here can reach them.

       Except a plain key: unbucketed, unaliased, its output name IS the
       base column, and shadowing it refused `invoice status = paid count
       by status` — the filter runs before the grouping exists, on the
       column that very much does. Only names that exist solely as
       aggregate outputs join the shadow list. */
    aggregateAliases: names.filter((name) => !keys.some((k) => !k.alias && !k.bucket && k.path === name)),
    ...(options.me !== undefined ? { me: options.me } : {}),
  });
  errors.push(...parsed.errors);

  if (parsed.columns.length) {
    errors.push({
      message: '`show` does not apply to a breakdown — its columns are the things it groups by and measures.',
    });
  }

  const orderBy: BreakdownOrder[] = parsed.orderBy.map((o) => ({ name: o.path, direction: o.direction }));

  const breakdown: BreakdownDef = {
    base: base.id,
    by: keys,
    measures,
    filter: parsed.filter.groups.length ? (parsed.filter as ViewFilter) : undefined,
    orderBy: orderBy.length ? orderBy : undefined,
    limit: parsed.limit,
    text: written,
  };

  return {
    breakdown: errors.length ? undefined : breakdown,
    conditions: prefix.trim() || undefined,
    errors,
  };
}

/**
 * The line as an authored dashboard section, or null when it is not one:
 * the workbench-to-config bridge. Compose in the query bar, copy the
 * section, paste it into a dashboard — the kind is read off the shape
 * (two keys cross a matrix, a bucketed key draws a chart, one plain key
 * ranks a breakdown, none is a metric), and the conditions half survives
 * exactly as typed, because only this parser knows where it ended.
 */
export function sectionFromText(schema: DatabaseSchema, text: string) {
  const parsed = textToBreakdown(schema, text);
  const def = parsed.breakdown;
  if (!def || parsed.errors.length) return null;
  const by = def.by.map((k) => `${k.bucket ? `${k.bucket} ` : ''}${k.path}${k.alias ? ` as ${k.alias}` : ''}`).join(', ');
  const m = def.measures[0];
  const measure = m && !(m.fn === 'count' && !m.path && !m.alias && !m.steps) ? measureToText(m) : undefined;
  const kind: 'matrix' | 'chart' | 'breakdown' | 'metric' =
    def.by.length === 2 ? 'matrix' : def.by.length === 1 ? (def.by[0].bucket ? 'chart' : 'breakdown') : 'metric';
  return {
    kind,
    table: def.base,
    ...(parsed.conditions ? { query: parsed.conditions } : {}),
    ...(measure ? { measure } : {}),
    ...(by ? { by } : {}),
  };
}

/**
 * Render a breakdown as text — the inverse, and the round trip is tested.
 *
 * One line, unlike a view. A breakdown is a phrase: two measures and a key is
 * the normal size of one, and the whole point of the form is that it fits in
 * a query bar.
 */
export function breakdownToText(schema: DatabaseSchema, def: BreakdownDef): string {
  const base = findTable(schema, def.base);
  const parts: string[] = [base?.name ?? def.base];

  const conditions = (def.filter?.groups ?? []).filter((g) => g.length);
  if (conditions.length) {
    parts.push('where');
    parts.push(conditions.map((group) => group.map(conditionToText).join(' and ')).join(' or '));
  }

  parts.push(def.measures.map(measureToText).join(', '));
  // One group has no `by` to write back — the bare measure is the spelling.
  if (def.by?.length) {
    parts.push('by');
    parts.push(def.by.map(keyToText).join(', '));
  }

  if (def.orderBy?.length) {
    parts.push('sort');
    parts.push(def.orderBy.map((o) => `${o.name}${o.direction === 'desc' ? ' desc' : ''}`).join(', '));
  }
  if (def.limit !== undefined) parts.push(`limit ${def.limit}`);

  return parts.join(' ');
}

const keyToText = (k: BreakdownKey): string => {
  const words: string[] = [];
  if (k.bucket) words.push(k.bucket);
  words.push(k.path);
  if (k.alias) words.push('as', k.alias);
  return words.join(' ');
};

/**
 * One condition, back in words.
 *
 * Deliberately small: the operators a breakdown's filter uses are the ones the
 * query language spells the same way in both directions. Anything else is
 * rendered by its own name, which round-trips because that is how it parses.
 */
function conditionToText(c: { path: string; op: string; value?: unknown; other?: string; any?: unknown }): string {
  // The rows that point at the record keep the words they were asked in (`any opportunity where …`, `no task`).
  if (c.any !== undefined) return c.path;
  if (c.op === 'isNull') return `${c.path} is null`;
  if (c.op === 'isNotNull') return `${c.path} is not null`;
  if (c.other !== undefined) return `${c.path} ${c.op} ${c.other}`;
  const value = Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '');
  const spelled = c.op === '=' ? '=' : c.op;
  return `${c.path} ${spelled} ${value}`;
}
